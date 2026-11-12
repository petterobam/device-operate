// Time Machine status, APFS local snapshots and configuration export/import.
//
// Reads are always available. Starting a backup or deleting a local snapshot is
// a write operation and is therefore exposed as a separate, clearly labelled
// action.

import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

// Files that represent this app's own configuration and are safe to export.
export const EXPORTABLE_FILES = [
  { id: "task-metadata", path: ".config/device-operate/task-metadata.json", label: "系统任务备注" },
  { id: "agent-config", path: ".config/device-operate/agent.json", label: "Agent 权限配置" },
  { id: "open-feishu", path: ".config/device-operate/open-feishu.env", label: "飞书自动化配置" },
  { id: "ssh-config", path: ".ssh/config", label: "SSH 主机配置" }
];

const SECRET_LINE_PATTERN = /(^|\s)(IdentityFile|Password|Passphrase|Token|Secret|API_KEY)\b/i;

function serviceError(message, status = 400) {
  return Object.assign(new Error(message), { status });
}

function runQuiet(run, command, args, options = {}) {
  return run(command, args, { timeout: 20_000, maxBuffer: 4 * 1024 * 1024, ...options })
    .then(({ stdout }) => ({ ok: true, stdout }))
    .catch((error) => ({ ok: false, stdout: error.stdout || "", stderr: error.stderr || error.message }));
}

export function parseDestinations(output = "") {
  const destinations = [];
  let current = null;
  for (const line of String(output).split("\n")) {
    const nameMatch = line.match(/^Name\s*:\s*(.+)$/);
    if (nameMatch) {
      if (current) destinations.push(current);
      current = { name: nameMatch[1].trim(), kind: "", id: "", mountPoint: "", lastDestination: "" };
      continue;
    }
    if (!current) continue;
    const field = (key) => new RegExp(`${key}\\s*:\\s*(.+)$`).exec(line)?.[1]?.trim() || "";
    if (/Kind\s*:/.test(line)) current.kind = field("Kind");
    if (/ID\s*:/.test(line)) current.id = field("ID");
    if (/Mount Point\s*:/.test(line)) current.mountPoint = field("Mount Point");
    if (/Last Destination\s*:/.test(line)) current.lastDestination = field("Last Destination");
  }
  if (current) destinations.push(current);
  const noDestinations = /No destinations configured/i.test(output);
  return { destinations, configured: destinations.length > 0 && !noDestinations };
}

export function parseLocalSnapshots(output = "") {
  return String(output)
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.startsWith("com.apple.TimeMachine."))
    .map((line) => {
      const date = line.match(/(\d{4})-(\d{2})-(\d{2})-(\d{2})(\d{2})(\d{2})/);
      const formatted = date
        ? `${date[1]}-${date[2]}-${date[3]} ${date[4]}:${date[5]}:${date[6]}`
        : "";
      return { name: line, createdAt: formatted };
    })
    .sort((first, second) => second.name.localeCompare(first.name));
}

export function parseBackupStatus(output = "") {
  const read = (key) => {
    const match = new RegExp(`${key}\\s*=\\s*"?([^";\\n]+)"?;`).exec(output);
    return match ? match[1].trim().replace(/^"|"$/g, "") : "";
  };
  const percent = Number(read("Percent"));
  return {
    running: read("Running") === "1",
    percent: Number.isFinite(percent) && percent >= 0 ? percent : null,
    clientId: read("ClientID"),
    destinationId: read("DestinationID"),
    backupPhase: read("BackupPhase")
  };
}

export function parseBackupDates(output = "") {
  return String(output)
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => /^\d{4}-\d{2}-\d{2}-/.test(line))
    .map((line) => line)
    .sort()
    .reverse();
}

/**
 * Redacts credential-looking lines so an exported snapshot never contains
 * secrets such as a private key path or a stored token.
 */
export function redactConfig(content) {
  return String(content)
    .split("\n")
    .map((line) => {
      if (!SECRET_LINE_PATTERN.test(line)) return line;
      const separator = line.includes(":") && !line.includes("=") ? ":" : "=";
      const indent = line.match(/^\s*/)?.[0] || "";
      const key = line.trim().split(/[:=\s]/)[0];
      return `${indent}${key} ${separator} "<redacted>"`;
    })
    .join("\n");
}

export function createBackupService({
  run = execFileAsync,
  homeDir = os.homedir(),
  configDir = path.join(os.homedir(), ".config", "device-operate"),
  now = () => Date.now()
} = {}) {
  async function status() {
    const [destinations, snapshots, backupStatus, backupDates] = await Promise.all([
      runQuiet(run, "tmutil", ["destinationinfo"]),
      runQuiet(run, "tmutil", ["listlocalsnapshots", "/"]),
      runQuiet(run, "tmutil", ["status"]),
      runQuiet(run, "tmutil", ["listbackups"])
    ]);
    const parsedDestinations = parseDestinations(destinations.stdout || destinations.stderr);
    return {
      destinations: parsedDestinations.destinations,
      configured: parsedDestinations.configured,
      localSnapshots: parseLocalSnapshots(snapshots.stdout),
      session: parseBackupStatus(backupStatus.stdout),
      backups: parseBackupDates(backupDates.stdout).slice(0, 10),
      available: destinations.ok || snapshots.ok || backupStatus.ok,
      note: parsedDestinations.configured ? "" : "当前没有配置 Time Machine 备份目的地。",
      measuredAt: new Date(now()).toISOString()
    };
  }

  async function startBackup() {
    const result = await runQuiet(run, "tmutil", ["startbackup", "--auto"]);
    if (!result.ok) throw serviceError(`启动备份失败：${(result.stderr || "").trim()}`, 502);
    return { started: true, output: result.stdout.trim() };
  }

  async function deleteSnapshot({ name } = {}) {
    const snapshot = String(name || "").trim();
    if (!/^com\.apple\.TimeMachine\.[A-Za-z0-9.-]+$/.test(snapshot)) {
      throw serviceError("本地快照名称不合法");
    }
    const result = await runQuiet(run, "tmutil", ["deletelocalsnapshots", snapshot]);
    if (!result.ok) throw serviceError(`删除快照失败：${(result.stderr || "").trim()}`, 502);
    return { deleted: snapshot, output: result.stdout.trim() };
  }

  async function exportConfig() {
    const files = [];
    for (const entry of EXPORTABLE_FILES) {
      const absolute = path.join(homeDir, entry.path);
      try {
        const content = await fs.readFile(absolute, "utf8");
        const redacted = redactConfig(content, entry.id);
        files.push({
          id: entry.id,
          label: entry.label,
          path: absolute,
          bytes: Buffer.byteLength(redacted),
          redacted: redacted !== content,
          content: redacted
        });
      } catch {
        // Missing configuration files are expected on a fresh machine.
      }
    }
    const bundle = {
      format: "device-operate-config",
      version: 1,
      exportedAt: new Date(now()).toISOString(),
      hostname: os.hostname(),
      fileCount: files.length,
      files
    };
    return { bundle, files: files.map(({ content, ...rest }) => rest) };
  }

  async function importConfig({ bundle } = {}) {
    if (!bundle || bundle.format !== "device-operate-config" || !Array.isArray(bundle.files)) {
      throw serviceError("配置文件格式不正确");
    }
    const applied = [];
    const skipped = [];
    for (const file of bundle.files) {
      const entry = EXPORTABLE_FILES.find((candidate) => candidate.id === file.id);
      if (!entry) {
        skipped.push({ id: file.id, reason: "不支持的文件" });
        continue;
      }
      if (typeof file.content !== "string") {
        skipped.push({ id: file.id, reason: "缺少内容" });
        continue;
      }
      const target = path.join(homeDir, entry.path);
      await fs.mkdir(path.dirname(target), { recursive: true });
      await fs.writeFile(target, file.content, "utf8");
      applied.push({ id: file.id, path: target, bytes: Buffer.byteLength(file.content) });
    }
    return { applied, skipped, importedAt: new Date(now()).toISOString() };
  }

  return { status, startBackup, deleteSnapshot, exportConfig, importConfig, configDir };
}
