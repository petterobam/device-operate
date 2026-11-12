// Native macOS notifications for fired alerts. The Electron main process can
// inject its own sender; the headless server falls back to osascript so alerts
// still reach Notification Center when the API runs under launchd.

import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

function escapeAppleScript(value) {
  return String(value ?? "").replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\r?\n/g, " ");
}

async function osascriptNotifier({ title, subtitle, message }) {
  const script = `display notification "${escapeAppleScript(message)}" with title "${escapeAppleScript(title)}"${subtitle ? ` subtitle "${escapeAppleScript(subtitle)}"` : ""}`;
  await execFileAsync("osascript", ["-e", script], { timeout: 8000 });
  return { delivered: true, channel: "osascript" };
}

function createDefaultSender() {
  if (process.platform !== "darwin") {
    return async () => ({ delivered: false, channel: "unsupported", reason: "当前平台不支持 macOS 通知" });
  }
  return osascriptNotifier;
}

export function createNotificationService({ sender, now = () => Date.now() } = {}) {
  let deliver = sender || createDefaultSender();
  const history = [];
  let lastError = "";

  function setSender(nextSender) {
    deliver = nextSender || createDefaultSender();
  }

  async function notify({ title = "我的 macOS", subtitle = "", message = "", severity = "info", ruleId = "", dedupeKey = "" } = {}) {
    const text = String(message).trim();
    if (!text) return { delivered: false, reason: "空通知" };
    const entry = {
      title,
      subtitle,
      message: text,
      severity,
      ruleId,
      dedupeKey,
      at: new Date(now()).toISOString()
    };
    try {
      const result = await deliver(entry);
      history.unshift({ ...entry, ...result });
      if (history.length > 100) history.length = 100;
      return { ...entry, ...result };
    } catch (error) {
      lastError = error.message;
      const failed = { ...entry, delivered: false, channel: "error", reason: error.message };
      history.unshift(failed);
      if (history.length > 100) history.length = 100;
      return failed;
    }
  }

  return {
    notify,
    setSender,
    list() {
      return history.slice(0, 50);
    },
    status() {
      return { history: history.length, lastError };
    }
  };
}

export const notificationInternals = { osascriptNotifier, escapeAppleScript };
