#!/usr/bin/env python3
"""Claude Agent SDK harness.

One process, two protocols, both fed as JSON on stdin:

* remark mode (single JSON object, single JSON result on stdout) — generates
  alias/note/tags metadata for a system task; kept for backwards compatibility
  with the existing task-remark flow.
* chat mode (JSONL) — runs a conversational turn. Node declares the available
  tools; the agent asks Node to execute them with ``tool-call`` JSONL events
  and consumes the ``tool-result`` replies. All tool execution stays in Node so
  the agent and the UI share exactly one implementation.

Chat mode stdout carries exactly one JSON object per line.
"""

from __future__ import annotations

import asyncio
import inspect
import json
import os
import re
import sys
from typing import Any

STDIN_CHUNK_LIMIT = 20 * 1024 * 1024
MCP_SERVER_NAME = "device_operate"


def emit(payload: dict[str, Any]) -> None:
    sys.stdout.write(json.dumps(payload, ensure_ascii=False) + "\n")
    sys.stdout.flush()


def _extract_json(text: str) -> dict[str, Any]:
    fenced = re.search(r"```(?:json)?\s*(\{.*?\})\s*```", text, re.S)
    raw = fenced.group(1) if fenced else text
    start = raw.find("{")
    end = raw.rfind("}")
    if start == -1 or end == -1 or end <= start:
        raise ValueError("Claude response did not contain JSON")
    return json.loads(raw[start : end + 1])


def _import_sdk():
    from claude_agent_sdk import (  # type: ignore[import-not-found]
        AssistantMessage,
        ClaudeAgentOptions,
        ClaudeSDKClient,
        ResultMessage,
        TextBlock,
        ToolUseBlock,
        create_sdk_mcp_server,
        tool,
    )
    from claude_agent_sdk.types import PermissionResultAllow, PermissionResultDeny  # type: ignore[import-not-found]

    return {
        "AssistantMessage": AssistantMessage,
        "ClaudeAgentOptions": ClaudeAgentOptions,
        "ClaudeSDKClient": ClaudeSDKClient,
        "ResultMessage": ResultMessage,
        "TextBlock": TextBlock,
        "ToolUseBlock": ToolUseBlock,
        "create_sdk_mcp_server": create_sdk_mcp_server,
        "tool": tool,
        "PermissionResultAllow": PermissionResultAllow,
        "PermissionResultDeny": PermissionResultDeny,
    }


def _call_accepts_mapping(handler) -> bool:
    try:
        parameters = list(inspect.signature(handler).parameters.values())
    except (TypeError, ValueError):
        return True
    positional = [p for p in parameters if p.kind in (p.POSITIONAL_ONLY, p.POSITIONAL_OR_KEYWORD)]
    return bool(positional) and len(positional) == 1


def _text_content(result: Any) -> str:
    if isinstance(result, str):
        return result
    if isinstance(result, dict):
        for key in ("summary", "text", "result", "error"):
            value = result.get(key)
            if isinstance(value, str) and value.strip():
                return value
        data = result.get("data")
        if isinstance(data, str):
            return data
        return json.dumps(result, ensure_ascii=False)
    return str(result)


async def _stdin_reader(queue: "asyncio.Queue[dict[str, Any]]") -> None:
    loop = asyncio.get_running_loop()
    while True:
        line = await loop.run_in_executor(None, sys.stdin.readline)
        if not line:
            await queue.put({"type": "__eof__"})
            return
        line = line.strip()
        if not line:
            continue
        try:
            await queue.put(json.loads(line))
        except json.JSONDecodeError:
            continue


async def _next_message(queue: "asyncio.Queue[dict[str, Any]]", timeout: float = 180.0) -> dict[str, Any] | None:
    try:
        return await asyncio.wait_for(queue.get(), timeout=timeout)
    except asyncio.TimeoutError:
        return None


def _make_bridge(sdk: dict[str, Any], spec: dict[str, Any], queue: "asyncio.Queue[dict[str, Any]]"):
    counter = {"value": 0}

    async def execute(**kwargs: Any) -> dict[str, Any]:
        counter["value"] += 1
        request_id = f"{spec['name']}-{counter['value']}"
        emit({"type": "tool-call", "requestId": request_id, "tool": spec["name"], "input": kwargs})
        reply = await _next_message(queue)
        if reply is None:
            return {"content": [{"type": "text", "text": "工具调用超时，未收到执行结果。"}], "is_error": True}
        if reply.get("type") == "__eof__":
            return {"content": [{"type": "text", "text": "上层进程已关闭，工具未执行。"}], "is_error": True}
        if not reply.get("ok"):
            return {"content": [{"type": "text", "text": str(reply.get("error") or "工具执行失败")}], "is_error": True}
        result = reply.get("result") or {}
        return {"content": [{"type": "text", "text": _text_content(result)}]}

    return execute


async def run_chat(payload: dict[str, Any]) -> int:
    try:
        sdk = _import_sdk()
    except Exception as exc:  # pragma: no cover - environment dependent
        emit({"type": "error", "error": f"claude_agent_sdk unavailable: {exc}"})
        return 0

    specs = payload.get("tools") or []
    if not isinstance(specs, list):
        specs = []

    queue: "asyncio.Queue[dict[str, Any]]" = asyncio.Queue()
    reader = asyncio.create_task(_stdin_reader(queue))

    tool_decorator = sdk["tool"]
    create_server = sdk["create_sdk_mcp_server"]
    mcp_tools = []
    allowed_names = []
    for spec in specs:
        name = str(spec.get("name") or "").strip()
        if not name:
            continue
        handler = _make_bridge(sdk, spec, queue)
        schema = spec.get("inputSchema") or {"type": "object", "properties": {}}
        decorated = tool_decorator(
            name,
            str(spec.get("description") or spec.get("title") or name),
            schema,
        )(handler)
        mcp_tools.append(decorated)
        allowed_names.append(f"mcp__{MCP_SERVER_NAME}__{name}")

    server = create_server(MCP_SERVER_NAME, "1.0.0", mcp_tools) if mcp_tools else None
    mcp_servers = {MCP_SERVER_NAME: server} if server else {}
    permission_allow = sdk["PermissionResultAllow"]
    permission_deny = sdk["PermissionResultDeny"]

    async def can_use_tool(tool_name: str, tool_input: dict[str, Any], _context: Any):
        if tool_name in allowed_names:
            return permission_allow()
        return permission_deny(
            message="该工具本次未授权。请改用已授权工具，或告知用户先开启写操作/破坏性操作权限。",
            interrupt=False,
        )

    options = sdk["ClaudeAgentOptions"](
        cwd=os.getcwd(),
        system_prompt=str(payload.get("system") or ""),
        permission_mode="default",
        mcp_servers=mcp_servers,
        allowed_tools=allowed_names,
        strict_mcp_config=True,
        disallowed_tools=["Bash", "Read", "Write", "Edit", "Glob", "Grep", "Agent", "WebFetch", "WebSearch"],
        can_use_tool=can_use_tool,
        max_turns=16,
    )

    history = payload.get("history") or []
    message = str(payload.get("message") or "")
    prompt_parts = []
    for entry in history[-12:]:
        role = "用户" if entry.get("role") == "user" else "助手"
        prompt_parts.append(f"{role}：{entry.get('content', '')}")
    prompt_parts.append(f"用户：{message}")
    prompt = "\n\n".join(prompt_parts)

    chunks: list[str] = []
    try:
        async with sdk["ClaudeSDKClient"](options=options) as client:
            await client.query(prompt)
            async for msg in client.receive_response():
                if isinstance(msg, sdk["AssistantMessage"]):
                    for block in msg.content:
                        if isinstance(block, sdk["TextBlock"]):
                            chunks.append(block.text)
                        elif isinstance(block, sdk["ToolUseBlock"]):
                            emit({"type": "log", "message": f"调用工具 {block.name}"})
                elif isinstance(msg, sdk["ResultMessage"]) and getattr(msg, "result", None):
                    chunks.append(str(msg.result))
    except Exception as exc:
        emit({"type": "error", "error": f"{type(exc).__name__}: {exc}"})
        reader.cancel()
        return 0

    reply = "\n".join(part for part in chunks if part).strip()
    emit({"type": "final", "reply": reply})
    reader.cancel()
    return 0


async def run_remark(payload: dict[str, Any]) -> int:
    try:
        sdk = _import_sdk()
    except Exception as exc:  # pragma: no cover - runtime environment dependent
        print(json.dumps({"ok": False, "error": f"claude_agent_sdk unavailable: {exc}"}, ensure_ascii=False))
        return 0

    task = payload.get("task") or {}
    skill = payload.get("skill") or ""

    system_prompt = (
        "你是 macOS 系统任务识别助手。你会阅读 launchd plist 和 crontab 任务，"
        "为任务生成短别名、备注和标签。只输出 JSON，不要输出解释文字。\n\n"
        "输出格式必须是："
        '{"alias":"不超过14个汉字","note":"一句中文说明任务用途、触发时间和风险","tags":["标签1","标签2"]}'
        "\n\n内置 skill：\n"
        f"{skill[:6000]}"
    )
    message = (
        "请根据下面这个系统任务生成备注元数据。标签 2-5 个，短小中文为主；"
        "如果无法确认用途，要如实写“疑似/可能”。\n\n"
        + json.dumps(task, ensure_ascii=False, indent=2)[:9000]
    )

    options = sdk["ClaudeAgentOptions"](
        cwd=os.getcwd(),
        system_prompt=system_prompt,
        permission_mode="bypassPermissions",
        disallowed_tools=["Bash", "Read", "Write", "Edit", "Glob", "Grep", "Agent"],
    )

    chunks: list[str] = []
    async with sdk["ClaudeSDKClient"](options=options) as client:
        await client.query(message)
        async for msg in client.receive_response():
            if isinstance(msg, sdk["AssistantMessage"]):
                for block in msg.content:
                    if isinstance(block, sdk["TextBlock"]):
                        chunks.append(block.text)
            elif isinstance(msg, sdk["ResultMessage"]) and getattr(msg, "result", None):
                chunks.append(str(msg.result))

    data = _extract_json("\n".join(chunks))
    print(json.dumps({"ok": True, "data": data}, ensure_ascii=False))
    return 0


async def main() -> int:
    first = sys.stdin.readline()
    if not first.strip():
        emit({"ok": False, "error": "empty stdin payload"})
        return 0
    try:
        payload = json.loads(first)
    except json.JSONDecodeError as exc:
        emit({"ok": False, "error": f"invalid JSON payload: {exc}"})
        return 0

    mode = payload.get("mode") or "remark"
    if mode == "chat":
        return await run_chat(payload)
    return await run_remark(payload)


if __name__ == "__main__":
    raise SystemExit(asyncio.run(main()))
