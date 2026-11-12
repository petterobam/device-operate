// Read-only system information: battery health, power settings, sleep/wake
// history and macOS software update availability.

import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const DEFAULT_TIMEOUT_MS = 15_000;
const UPDATE_TIMEOUT_MS = 180_000;

function number(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function booleanOf(value) {
  const text = String(value ?? "").trim().toLowerCase();
  if (["yes", "true", "1"].includes(text)) return true;
  if (["no", "false", "0"].includes(text)) return false;
  return null;
}

// ---------------------------------------------------------------------------
// Parsers (exported for tests)
// ---------------------------------------------------------------------------

export function parseSystemProfilerPower(output = "") {
  const lines = String(output).split("\n");
  const read = (label) => {
    const line = lines.find((entry) => entry.trim().startsWith(`${label}:`));
    return line ? line.split(":").slice(1).join(":").trim() : "";
  };

  const maximumCapacity = read("Maximum Capacity");
  const healthPercent = maximumCapacity.endsWith("%") ? number(maximumCapacity.slice(0, -1)) : null;
  const condition = read("Condition");
  const cycleCount = number(read("Cycle Count"));
  const stateOfCharge = number(read("State of Charge (%)"));
  const charging = booleanOf(read("Charging"));
  const fullyCharged = booleanOf(read("Fully Charged"));
  const currentPowerSource = booleanOf(read("Current Power Source"));

  return {
    battery: {
      present: Boolean(cycleCount || maximumCapacity || condition),
      healthPercent,
      condition: condition || "",
      cycleCount,
      stateOfChargePercent: stateOfCharge,
      charging,
      fullyCharged,
      currentPowerSource,
      serialNumber: read("Serial Number"),
      firmwareVersion: read("Firmware Version")
    },
    settings: parsePowerSettings(lines)
  };
}

// Only these keys belong to the "System Power Settings" section of
// system_profiler SPPowerDataType; battery-information keys are handled by the
// battery parser above.
const POWER_SETTING_KEYS = new Set([
  "System Sleep Timer (Minutes)",
  "Disk Sleep Timer (Minutes)",
  "Display Sleep Timer (Minutes)",
  "Sleep on Power Button",
  "Wake on LAN",
  "Hibernate Mode",
  "Low Power Mode",
  "Current Power Source",
  "Prioritize Network Reachability Over Sleep",
  "Reduce Brightness"
]);

function parsePowerSettings(lines) {
  const settings = { battery: {}, ac: {} };
  let section = "";
  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line) continue;
    if (line === "Battery Information:" || line === "System Power Settings:") continue;
    if (line === "AC Power:") {
      section = "ac";
      continue;
    }
    if (line === "Battery Power:") {
      section = "battery";
      continue;
    }
    if (!section || !line.includes(":")) continue;
    const label = line.slice(0, line.indexOf(":")).trim();
    if (!POWER_SETTING_KEYS.has(label)) continue;
    const value = line.slice(line.indexOf(":") + 1).trim();
    settings[section][label] = value;
  }
  return settings;
}

const SLEEP_EVENT_PATTERN = /^(\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2} [+-]\d{4})\s+(Sleep|Wake|DarkWake|Hibernate|Boot|Shutdown)\s+(.*)$/;

export function parseSleepLog(output = "", { limit = 40 } = {}) {
  const events = [];
  for (const line of String(output).split("\n")) {
    const match = line.trim().match(SLEEP_EVENT_PATTERN);
    if (!match) continue;
    const [, at, kind, detailText] = match;
    const detail = detailText
      .replace(/\s+/g, " ")
      .replace(/Using (AC|Batt|BATT|Battery).*$/i, "")
      .trim();
    const reasonMatch = detailText.match(/due to\s*'?([^':]+?)'?(?::|\s+Using|\s+\d+ secs|$)/i);
    const reason = reasonMatch?.[1]?.trim() || "";
    const charge = detailText.match(/Charge:(\d+)%/)?.[1];
    const duration = detailText.match(/(\d+) secs/)?.[1];
    events.push({
      at,
      kind,
      reason: reason || detail,
      chargePercent: charge ? Number(charge) : null,
      durationSeconds: duration ? Number(duration) : null,
      detail
    });
  }
  return events.slice(-limit).reverse();
}

export function parseSoftwareUpdateList(output = "") {
  const blocked = /No new software available/i.test(output);
  const entries = [];
  let current = null;
  for (const line of String(output).split("\n")) {
    const labelMatch = line.match(/^\s*\*\s*Label:\s*(.+?)\s*$/);
    if (labelMatch) {
      if (current) entries.push(current);
      current = { label: labelMatch[1], title: "", version: "", sizeBytes: null, recommended: false, action: "" };
      continue;
    }
    if (!current) continue;
    const value = (key) => {
      const match = line.match(new RegExp(`${key}:\\s*(.+?)(?:,\\s*[A-Za-z]+:|$)`));
      return match ? match[1].trim().replace(/,$/, "") : "";
    };
    if (/Title:/.test(line)) current.title = value("Title");
    if (/Version:/.test(line)) current.version = value("Version");
    if (/Size:/.test(line)) {
      const sizeMatch = line.match(/Size:\s*([\d.]+)\s*(KiB|MiB|GiB|KB|MB|GB)/i);
      const unitIndex = { kib: 1, mib: 2, gib: 3, kb: 1, mb: 2, gb: 3 }[sizeMatch?.[2]?.toLowerCase()] || 1;
      if (sizeMatch) current.sizeBytes = Math.round(Number(sizeMatch[1]) * 1024 ** unitIndex);
    }
    if (/Recommended:/.test(line)) current.recommended = /YES/i.test(line);
    if (/Action:/.test(line)) current.action = value("Action");
  }
  if (current) entries.push(current);
  return { updates: entries, blocked, upToDate: blocked || entries.length === 0 };
}

export function parseSoftwareUpdateSettings(output = "") {
  const text = String(output);
  return {
    automaticDownload: /AutomaticDownload\s*=\s*1/.test(text),
    automaticInstallMacOS: /AutomaticallyInstallMacOSUpdates\s*=\s*1/.test(text),
    criticalUpdateInstall: /CriticalUpdateInstall\s*=\s*1/.test(text),
    configDataInstall: /ConfigDataInstall\s*=\s*1/.test(text)
  };
}

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------

function serviceError(message, status = 500) {
  return Object.assign(new Error(message), { status });
}

export function createSystemInfoService({
  run = execFileAsync,
  platform = process.platform,
  now = () => Date.now()
} = {}) {
  let updateCache = { at: 0, data: null };
  const UPDATE_CACHE_MS = 30 * 60_000;

  function ensureDarwin() {
    if (platform !== "darwin") throw serviceError("系统信息采集仅支持 macOS", 400);
  }

  async function getPower() {
    ensureDarwin();
    const { stdout } = await run("system_profiler", ["SPPowerDataType"], { timeout: DEFAULT_TIMEOUT_MS, maxBuffer: 4 * 1024 * 1024 });
    return parseSystemProfilerPower(stdout);
  }

  async function getSleepEvents({ limit = 40 } = {}) {
    ensureDarwin();
    const { stdout } = await run("/bin/zsh", ["-lc", "pmset -g log 2>/dev/null | /usr/bin/grep -E 'Entering Sleep|Wake from|DarkWake|Hibernate|Boot|Shutdown' | tail -200"], {
      timeout: DEFAULT_TIMEOUT_MS,
      maxBuffer: 8 * 1024 * 1024
    });
    return { events: parseSleepLog(stdout, { limit }) };
  }

  async function getAssertions() {
    ensureDarwin();
    const { stdout } = await run("pmset", ["-g", "assertions"], { timeout: DEFAULT_TIMEOUT_MS, maxBuffer: 2 * 1024 * 1024 });
    const prevented = {};
    for (const line of stdout.split("\n")) {
      const match = line.trim().match(/^([A-Za-z]+)\s+(\d+)$/);
      if (match) prevented[match[1]] = Number(match[2]);
    }
    const holders = [];
    for (const line of stdout.split("\n")) {
      const match = line.match(/^\s*pid (\d+)\(([^)]+)\):\s*\[[^\]]+\]\s*([\d:]+)\s*([A-Za-z]+)/);
      if (match) holders.push({ pid: Number(match[1]), process: match[2], elapsed: match[3], assertion: match[4] });
    }
    return { prevented, holders: holders.slice(0, 20) };
  }

  async function getUpdates({ fresh = false } = {}) {
    ensureDarwin();
    const nowMs = now();
    if (!fresh && updateCache.data && nowMs - updateCache.at < UPDATE_CACHE_MS) {
      return { ...updateCache.data, cached: true };
    }
    const [listResult, versionResult, settingsResult] = await Promise.all([
      run("softwareupdate", ["-l"], { timeout: UPDATE_TIMEOUT_MS, maxBuffer: 8 * 1024 * 1024 }).catch((error) => ({ stdout: "", stderr: error.message })),
      run("sw_vers", [], { timeout: 10_000 }).catch(() => ({ stdout: "" })),
      run("defaults", ["read", "/Library/Preferences/com.apple.SoftwareUpdate.plist"], { timeout: 10_000 }).catch(() => ({ stdout: "" }))
    ]);
    const parsed = parseSoftwareUpdateList(listResult.stdout);
    const versionLines = versionResult.stdout.split("\n");
    const versionValue = (key) => versionLines.find((line) => line.startsWith(`${key}:`))?.split(":").slice(1).join(":").trim() || "";
    const data = {
      ...parsed,
      cached: false,
      checkedAt: new Date(nowMs).toISOString(),
      current: {
        productName: versionValue("ProductName"),
        productVersion: versionValue("ProductVersion"),
        buildVersion: versionValue("BuildVersion")
      },
      settings: parseSoftwareUpdateSettings(settingsResult.stdout),
      output: listResult.stderr ? String(listResult.stderr).trim() : ""
    };
    updateCache = { at: nowMs, data };
    return data;
  }

  return { getPower, getSleepEvents, getAssertions, getUpdates };
}
