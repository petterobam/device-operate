// Server-Sent Events helpers.
//
// The chat stream is the "RPC/HTTP → 流式事件推给 UI" leg of the Pi runtime: the
// agent loop emits events, the transport turns them into SSE frames and the UI
// renders them as they arrive.

const DEFAULT_HEARTBEAT_MS = 15_000;

/** One SSE frame: `event: <name>\ndata: <json>\n\n` (data is always one line). */
export function formatSseFrame(event, data) {
  const name = String(event || "message").replace(/[\r\n]/g, "");
  const payload = JSON.stringify(data ?? null);
  return `event: ${name}\ndata: ${payload}\n\n`;
}

/**
 * Wraps an Express response in an SSE writer.
 *
 * Returns an object with `send`, `comment`, `close` and a `closed` flag; the
 * heartbeat keeps intermediaries from timing the connection out during long
 * tool calls.
 */
export function createSseStream(res, { heartbeatMs = DEFAULT_HEARTBEAT_MS, onClose } = {}) {
  let closed = false;
  let heartbeat = null;

  function cleanup() {
    if (heartbeat) clearInterval(heartbeat);
    heartbeat = null;
  }

  function markClosed() {
    if (closed) return;
    closed = true;
    cleanup();
    onClose?.();
  }

  res.writeHead?.(200, {
    "Content-Type": "text/event-stream; charset=utf-8",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no"
  });
  res.write?.("retry: 3000\n\n");

  if (heartbeatMs > 0) {
    heartbeat = setInterval(() => {
      if (closed) return;
      try {
        res.write?.(": keep-alive\n\n");
      } catch {
        markClosed();
      }
    }, heartbeatMs);
    heartbeat.unref?.();
  }

  res.on?.("close", markClosed);
  res.on?.("error", markClosed);

  return {
    get closed() {
      return closed;
    },
    send(event, data) {
      if (closed) return false;
      try {
        res.write?.(formatSseFrame(event, data));
        return true;
      } catch {
        markClosed();
        return false;
      }
    },
    comment(text) {
      if (closed) return false;
      try {
        res.write?.(`: ${String(text || "").replace(/[\r\n]+/g, " ")}\n\n`);
        return true;
      } catch {
        markClosed();
        return false;
      }
    },
    close() {
      if (closed) return;
      try {
        res.end?.();
      } finally {
        markClosed();
      }
    }
  };
}

/**
 * Parses an SSE byte stream into events. Used by the desktop UI and by the
 * verification script so both exercise the same framing.
 */
export async function* parseSseStream(body) {
  const decoder = new TextDecoder();
  let buffer = "";
  const reader = body.getReader();
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let index = buffer.indexOf("\n\n");
      while (index !== -1) {
        const raw = buffer.slice(0, index);
        buffer = buffer.slice(index + 2);
        const parsed = parseSseFrame(raw);
        if (parsed) yield parsed;
        index = buffer.indexOf("\n\n");
      }
    }
    const tail = parseSseFrame(buffer);
    if (tail) yield tail;
  } finally {
    reader.releaseLock?.();
  }
}

export function parseSseFrame(raw) {
  const text = String(raw || "").trim();
  if (!text || text.startsWith(":")) return null;
  let event = "message";
  const dataLines = [];
  for (const line of text.split("\n")) {
    if (line.startsWith("event:")) event = line.slice(6).trim();
    else if (line.startsWith("data:")) dataLines.push(line.slice(5).trim());
  }
  if (!dataLines.length) return null;
  const payload = dataLines.join("\n");
  let data = payload;
  try {
    data = JSON.parse(payload);
  } catch {
    // Keep the raw string when the payload is not JSON.
  }
  return { event, data };
}
