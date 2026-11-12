import assert from "node:assert/strict";
import test from "node:test";
import { createSseStream, formatSseFrame, parseSseFrame, parseSseStream } from "../server/sse.js";

function fakeResponse() {
  const written = [];
  const listeners = {};
  return {
    written,
    headers: null,
    ended: false,
    writeHead(status, headers) {
      this.status = status;
      this.headers = headers;
    },
    write(chunk) {
      written.push(chunk);
      return true;
    },
    end() {
      this.ended = true;
    },
    on(event, handler) {
      listeners[event] = handler;
    },
    emit(event) {
      listeners[event]?.();
    }
  };
}

test("formatSseFrame writes a named event with JSON data on one line", () => {
  assert.equal(formatSseFrame("delta", { text: "hi" }), 'event: delta\ndata: {"text":"hi"}\n\n');
  assert.equal(formatSseFrame("final", null), "event: final\ndata: null\n\n");
  // A newline in the event name would break the framing.
  assert.match(formatSseFrame("bad\nname", {}), /^event: badname\n/);
});

test("createSseStream sets headers, sends frames and closes once", () => {
  const res = fakeResponse();
  const stream = createSseStream(res, { heartbeatMs: 0 });

  assert.equal(res.headers["Content-Type"], "text/event-stream; charset=utf-8");
  assert.equal(res.headers["Cache-Control"], "no-cache, no-transform");
  assert.equal(res.written[0], "retry: 3000\n\n");

  assert.equal(stream.send("open", { runtime: "pi" }), true);
  assert.equal(res.written[1], 'event: open\ndata: {"runtime":"pi"}\n\n');
  assert.equal(stream.comment("hi there"), true);
  assert.equal(res.written[2], ": hi there\n\n");

  stream.close();
  assert.equal(res.ended, true);
  assert.equal(stream.closed, true);
  assert.equal(stream.send("delta", { text: "late" }), false, "no frames after close");
  assert.equal(res.written.length, 3);
});

test("createSseStream stops writing when the client disconnects", () => {
  const res = fakeResponse();
  let closed = 0;
  const stream = createSseStream(res, { heartbeatMs: 0, onClose: () => { closed += 1; } });
  res.emit("close");
  assert.equal(stream.closed, true);
  assert.equal(closed, 1, "onClose fires once");
  assert.equal(stream.send("delta", { text: "x" }), false);
  stream.close();
  assert.equal(closed, 1, "closing again does not fire onClose twice");
});

test("heartbeat keeps the connection warm and stops after close", async () => {
  const res = fakeResponse();
  const stream = createSseStream(res, { heartbeatMs: 5 });
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.ok(res.written.filter((chunk) => chunk === ": keep-alive\n\n").length >= 1);
  stream.close();
  const count = res.written.length;
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(res.written.length, count, "no heartbeats after close");
});

test("parseSseFrame ignores comments and tolerates plain-text data", () => {
  assert.equal(parseSseFrame(": keep-alive"), null);
  assert.equal(parseSseFrame(""), null);
  assert.deepEqual(parseSseFrame('event: final\ndata: {"ok":true}'), { event: "final", data: { ok: true } });
  assert.deepEqual(parseSseFrame("data: not json"), { event: "message", data: "not json" });
});

test("parseSseStream round-trips frames the writer produced, across chunk boundaries", async () => {
  const frames = [
    formatSseFrame("open", { permissionLevel: "read" }),
    formatSseFrame("delta", { text: "第一" }),
    formatSseFrame("delta", { text: "第二" }),
    ": keep-alive\n\n",
    formatSseFrame("final", { reply: "第一第二" }),
    formatSseFrame("done", { ok: true })
  ].join("");

  // Split mid-frame to prove the parser buffers partial events.
  const bytes = new TextEncoder().encode(frames);
  const splitAt = Math.floor(bytes.length / 3);
  const body = new ReadableStream({
    start(controller) {
      controller.enqueue(bytes.slice(0, splitAt));
      controller.enqueue(bytes.slice(splitAt));
      controller.close();
    }
  });

  const seen = [];
  for await (const frame of parseSseStream(body)) seen.push(frame);

  assert.deepEqual(seen.map((frame) => frame.event), ["open", "delta", "delta", "final", "done"]);
  assert.equal(seen[1].data.text + seen[2].data.text, "第一第二");
  assert.equal(seen[3].data.reply, "第一第二");
});
