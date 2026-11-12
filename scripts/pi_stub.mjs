// Local OpenAI-compatible streaming endpoint used by the verification scripts.
import http from "node:http";

export function startStub({ toolName, toolArgs, answer, chunkDelayMs = 0 }) {
  const state = { calls: 0 };
  const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => { body += chunk; });
    req.on("end", () => {
      let parsed = {};
      try { parsed = JSON.parse(body || "{}"); } catch { /* ignore */ }
      state.calls += 1;
      const hasToolResult = (parsed.messages || []).some((message) => message.role === "tool");
      const wantsTools = Array.isArray(parsed.tools) && parsed.tools.length > 0;
      // Task-metadata completion: answer with the JSON the caller expects.
      const metadataPrompt = JSON.stringify(parsed.messages || []).includes("系统任务识别助手");
      const replyText = metadataPrompt
        ? JSON.stringify({ alias: "验证任务", note: "由 Pi 运行时生成的备注", tags: ["Pi", "验证"] })
        : answer;
      res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive" });
      const base = { id: "chatcmpl-stub", object: "chat.completion.chunk", created: (Date.now() / 1000) | 0, model: parsed.model || "stub" };
      const send = (payload) => res.write(`data: ${JSON.stringify(payload)}\n\n`);
      // Tool-free completions (task metadata) must not be answered with a tool call.
      if (!hasToolResult && wantsTools) {
        send({ ...base, choices: [{ index: 0, delta: { role: "assistant", tool_calls: [{ index: 0, id: "call_stub_1", type: "function", function: { name: toolName, arguments: JSON.stringify(toolArgs) } }] }, finish_reason: null }] });
        send({ ...base, choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }], usage: { prompt_tokens: 120, completion_tokens: 18, total_tokens: 138 } });
      } else if (chunkDelayMs > 0) {
        // Paced streaming: lets a test observe the UI updating between chunks.
        (async () => {
          for (const piece of answer.match(/.{1,6}/g) || [answer]) {
            send({ ...base, choices: [{ index: 0, delta: { content: piece }, finish_reason: null }] });
            await wait(chunkDelayMs);
          }
          send({ ...base, choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 210, completion_tokens: 24, total_tokens: 234 } });
          res.write("data: [DONE]\n\n");
          res.end();
        })();
        return;
      } else if (!wantsTools) {
        // Tool-free completion: stream the configured JSON/text answer.
        for (const piece of replyText.match(/.{1,6}/g) || [replyText]) {
          send({ ...base, choices: [{ index: 0, delta: { content: piece }, finish_reason: null }] });
        }
        send({ ...base, choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 210, completion_tokens: 24, total_tokens: 234 } });
      } else {
        for (const piece of answer.match(/.{1,6}/g) || [answer]) {
          send({ ...base, choices: [{ index: 0, delta: { content: piece }, finish_reason: null }] });
        }
        send({ ...base, choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 210, completion_tokens: 24, total_tokens: 234 } });
      }
      res.write("data: [DONE]\n\n");
      res.end();
    });
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve({ server, port: server.address().port, state, close: () => new Promise((done) => server.close(done)) }));
  });
}
