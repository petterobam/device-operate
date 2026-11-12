#!/usr/bin/env node
// End-to-end check of the Pi conversation path without external credentials.
//
// Starts a local OpenAI-compatible streaming endpoint, points a provider at it
// through the manual AI configuration API, then runs one chat turn that must
// call a tool and answer from the stub. Restores the configuration afterwards.
//
//   PORT=4178 node server/index.js            # in one shell
//   node scripts/verify_pi_runtime.mjs        # in another

import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { parseSseStream } from "../server/sse.js";
import { startStub } from "./pi_stub.mjs";

const APP = process.env.APP_BASE || "http://127.0.0.1:4178";
const PROVIDER = process.env.VERIFY_PROVIDER || "groq";
const MODEL = process.env.VERIFY_MODEL || "llama-3.1-8b-instant";

async function api(method, route, body) {
  const response = await fetch(`${APP}${route}`, {
    method,
    headers: body ? { "Content-Type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined
  });
  const payload = await response.json();
  if (!payload.ok) throw new Error(`${method} ${route} -> ${payload.error}`);
  return payload.data;
}

const dir = await fs.mkdtemp(path.join(os.tmpdir(), "pi-verify-"));
const target = path.join(dir, "notes.txt");
await fs.writeFile(target, "alpha\nbeta\ngamma\n", "utf8");

const stub = await startStub({ toolName: "read_file", toolArgs: { path: target }, answer: "文件里一共有三行内容：alpha、beta、gamma。" });
const undo = [];
let failed = false;

try {
  await api("PUT", `/api/ai/config/provider/${PROVIDER}`, {
    apiKey: "stub-key",
    baseUrl: `http://127.0.0.1:${stub.port}/v1`,
    label: "本地验证网关"
  });
  undo.push(() => api("DELETE", `/api/ai/config/provider/${PROVIDER}`));
  await api("PUT", "/api/ai/config/default", { provider: PROVIDER, model: MODEL, thinkingLevel: "low" });
  undo.push(() => api("PUT", "/api/ai/config/default", { provider: "", model: "" }));

  const status = await api("GET", "/api/ai/status");
  const test = await api("POST", "/api/ai/test", { provider: PROVIDER, model: MODEL, live: true });
  const result = await api("POST", "/api/agent/chat", { sessionId: "verify", message: "读一下 notes.txt 并总结", permissionLevel: "read" });
  const usage = await api("GET", "/api/ai/usage");
  await api("DELETE", "/api/agent/chat/verify");

  // Streaming turn: the same parser the desktop UI uses must see incremental frames.
  const streamResponse = await fetch(`${APP}/api/agent/chat/stream`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ sessionId: "verify-stream", message: "再读一次 notes.txt", permissionLevel: "read" })
  });
  const streamEvents = [];
  const deltaText = [];
  let finalPayload = null;
  let deltaBeforeFinal = false;
  for await (const frame of parseSseStream(streamResponse.body)) {
    streamEvents.push(frame.event);
    if (frame.event === "delta") {
      deltaText.push(frame.data.text || "");
      if (!finalPayload) deltaBeforeFinal = true;
    }
    if (frame.event === "final") finalPayload = frame.data;
  }
  await api("DELETE", "/api/agent/chat/verify-stream");

  // Task metadata must use the same Pi runtime, without tools.
  const tasks = await api("GET", "/api/tasks");
  const sampleTask = (tasks.launchd || [])[0] || (tasks.cron || [])[0];
  const remark = sampleTask
    ? await api("POST", "/api/agent/generate-task-remark", { type: sampleTask.type, id: sampleTask.id, save: false })
    : null;

  console.log("remark:", remark ? `${remark.source} | ${remark.alias}` : "no task available");

  const checks = [
    ["status configured", status.configured === true],
    ["live provider test", test.ok === true && test.live === true],
    ["pi runtime used", result.source === "pi" && result.runtime === "pi"],
    ["tool executed", Array.isArray(result.toolLog) && result.toolLog.some((entry) => entry.tool === "read_file" && !entry.isError)],
    ["reply from model", typeof result.reply === "string" && result.reply.length > 0],
    ["tokens recorded", result.usage?.input > 0 && result.usage?.output > 0],
    ["cost recorded", result.usage?.costUsd > 0],
    ["ledger aggregated", usage.turns > 0 && usage.costUsd > 0],
    // 1 request for the live credential test + 2 for the chat turn (tool call, then answer).
    ["sse frames delivered", streamEvents.includes("open") && streamEvents.includes("delta") && streamEvents.includes("final") && streamEvents.includes("done")],
    ["sse tool frames", streamEvents.includes("tool-start") && streamEvents.includes("tool-result")],
    ["deltas arrive before final", deltaBeforeFinal === true],
    ["deltas reassemble the reply", deltaText.join("") === finalPayload?.reply],
    ["task remark via pi", remark ? remark.source === "pi" && Boolean(remark.alias) : true],
    ["stub saw 6 requests", stub.state.calls === 6]
  ];

  for (const [label, ok] of checks) {
    console.log(`${ok ? "PASS" : "FAIL"} ${label}`);
    if (!ok) failed = true;
  }
  console.log(`\nmodel: ${PROVIDER}/${MODEL}`);
  console.log(`reply: ${result.reply}`);
  console.log(`usage: ${JSON.stringify(result.usage)}`);
} finally {
  for (const step of undo.reverse()) await step().catch(() => {});
  await stub.close();
  await fs.rm(dir, { recursive: true, force: true });
}

process.exit(failed ? 1 : 0);
