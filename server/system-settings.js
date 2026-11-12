import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

// Keep the setting IDs stable in the UI and never accept an arbitrary URL from the renderer.
export const SYSTEM_SETTINGS = Object.freeze({
  battery: "x-apple.systempreferences:com.apple.Battery-Settings.extension",
  displays: "x-apple.systempreferences:com.apple.Displays-Settings.extension",
  sound: "x-apple.systempreferences:com.apple.Sound-Settings.extension",
  network: "x-apple.systempreferences:com.apple.Network-Settings.extension",
  keyboard: "x-apple.systempreferences:com.apple.Keyboard-Settings.extension",
  general: "x-apple.systempreferences:com.apple.settings.General"
});

export function createSystemSettingsService({ run = execFileAsync } = {}) {
  async function open(id) {
    const target = SYSTEM_SETTINGS[id];
    if (!target) throw Object.assign(new Error("不支持的系统设置入口"), { status: 400 });
    await run("open", [target], { timeout: 10_000 });
    return { opened: true, id };
  }

  return { open };
}
