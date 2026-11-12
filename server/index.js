import express from "express";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFile, exec, spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { createApplicationService } from "./applications.js";
import { createApplicationPermissionService } from "./application-permissions.js";
import { createFileAssociationService } from "./file-associations.js";
import { createLoginItemService } from "./login-items.js";
import { createStorageService } from "./storage.js";
import { createSystemSettingsService } from "./system-settings.js";
import { createSystemMonitorService } from "./system-monitor.js";
import { createSshService } from "./ssh.js";
import { createSystemInfoService } from "./system-info.js";
import { createNetworkToolService } from "./network-tools.js";
import { createNetworkMonitorService } from "./network-monitor.js";
import { createBackupService } from "./backup-service.js";
import { createUninstallCleanupService } from "./uninstall-cleanup.js";
import { createNotificationService } from "./notification-service.js";
import { createMonitorHistoryService } from "./monitor-history.js";
import { DEFAULT_ALERT_RULES, describeAlert } from "./alert-rules.js";
import { createAgentTools } from "./agent/tools.js";
import { createAiConfigStore } from "./agent/ai-config.js";
import { createAiUsageLedger } from "./agent/ai-usage.js";
import { createSystemTools } from "./agent/system-tools.js";
import { createPiRuntime, RUNTIME_VERSION } from "./agent/pi-runtime.js";
import { createSseStream } from "./sse.js";
import { createAgentConversationService } from "./agent/service.js";
import {
  findCronTaskProcesses,
  getLaunchdStatus,
  parseLaunchctlList,
  parseLaunchctlServices,
  parseProcessList
} from "./task-runtime.js";

const execFileAsync = promisify(execFile);
const execAsync = promisify(exec);

const app = express();
const PORT = Number(process.env.PORT || 4177);
const currentFile = fileURLToPath(import.meta.url);
const projectRoot = path.resolve(path.dirname(currentFile), "..");
const unpackedPath = (filePath) => (filePath.includes("app.asar") ? filePath.replace("app.asar", "app.asar.unpacked") : filePath);
const userLaunchAgentsDir = path.join(os.homedir(), "Library", "LaunchAgents");
const userLaunchDomain = `gui/${process.getuid?.() ?? os.userInfo().uid}`;
const configDir = path.join(os.homedir(), ".config", "device-operate");
const metadataPath = path.join(configDir, "task-metadata.json");
const agentPythonPath = path.join(configDir, "agent-venv", "bin", "python");
const agentDir = unpackedPath(path.join(projectRoot, "server", "agent"));
const agentSkillsDir = path.join(agentDir, "skills");
const harnessPath = path.join(agentDir, "harness.py");
const launchdReadDirs = [
  { dir: userLaunchAgentsDir, scope: "User LaunchAgents" },
  { dir: "/Library/LaunchAgents", scope: "System LaunchAgents" },
  { dir: "/Library/LaunchDaemons", scope: "System LaunchDaemons" }
];
const maxLogBytes = 80_000;
const disabledCronPrefix = "# device-operate-disabled: ";
const referenceAgentProject = "/Users/oyjie/.openclaw/workspace/github/aigc-fanqie-publisher";
let metadataUpdateQueue = Promise.resolve();
const cronRunStates = new Map();
const applicationService = createApplicationService();
const loginItemService = createLoginItemService({ applicationService });
const applicationPermissionService = createApplicationPermissionService({ applicationService });
const fileAssociationService = createFileAssociationService({ applicationService });
const storageService = createStorageService();
const systemSettingsService = createSystemSettingsService();
const systemMonitorService = createSystemMonitorService();
const systemInfoService = createSystemInfoService();
const networkToolService = createNetworkToolService();
const networkMonitorService = createNetworkMonitorService();
const backupService = createBackupService({ configDir });
const uninstallCleanupService = createUninstallCleanupService({ applicationService, storageService });
const sshService = createSshService();

app.use(express.json({ limit: "1mb" }));

function encodeId(value) {
  return Buffer.from(value).toString("base64url");
}

function decodeId(value) {
  return Buffer.from(value, "base64url").toString("utf8");
}

function ok(res, data) {
  res.json({ ok: true, data });
}

function bad(res, status, message) {
  res.status(status).json({ ok: false, error: message });
}

async function pathExists(filePath) {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function readTail(filePath, byteLimit = maxLogBytes) {
  if (!filePath || !(await pathExists(filePath))) {
    return "";
  }
  const stat = await fs.stat(filePath);
  const start = Math.max(0, stat.size - byteLimit);
  const handle = await fs.open(filePath, "r");
  try {
    const buffer = Buffer.alloc(stat.size - start);
    await handle.read(buffer, 0, buffer.length, start);
    return buffer.toString("utf8");
  } finally {
    await handle.close();
  }
}

function taskKey(type, stableId) {
  return `${type}:${stableId}`;
}

async function readMetadata() {
  try {
    return JSON.parse(await fs.readFile(metadataPath, "utf8"));
  } catch {
    return {};
  }
}

async function writeMetadata(metadata) {
  await fs.mkdir(configDir, { recursive: true });
  await fs.writeFile(metadataPath, JSON.stringify(metadata, null, 2), "utf8");
}

function normalizeMetadataPayload(payload = {}) {
  return {
    alias: String(payload.alias || "").trim(),
    note: String(payload.note || "").trim(),
    tags: Array.isArray(payload.tags)
      ? payload.tags.map((tag) => String(tag).trim()).filter(Boolean)
      : String(payload.tags || "")
          .split(",")
          .map((tag) => tag.trim())
          .filter(Boolean)
  };
}

async function updateTaskMetadata(task, payload, { preserveExisting = false } = {}) {
  const update = async () => {
    const metadata = await readMetadata();
    const key = taskKey(task.type, task.stableId);
    const generated = normalizeMetadataPayload(payload);
    const existing = normalizeMetadataPayload(metadata[key]);
    const metadataPayload = preserveExisting
      ? {
          alias: existing.alias || generated.alias,
          note: existing.note || generated.note,
          tags: existing.tags.length ? existing.tags : generated.tags
        }
      : generated;
    metadata[key] = metadataPayload;
    await writeMetadata(metadata);
    return metadataPayload;
  };
  const result = metadataUpdateQueue.then(update, update);
  metadataUpdateQueue = result.then(
    () => undefined,
    () => undefined
  );
  return result;
}

async function applyMetadata(tasks) {
  const metadata = await readMetadata();
  return tasks.map((task) => {
    const meta = metadata[taskKey(task.type, task.stableId)] || {};
    return {
      ...task,
      alias: meta.alias || "",
      note: meta.note || "",
      tags: Array.isArray(meta.tags) ? meta.tags : []
    };
  });
}

async function plistToJson(plistPath) {
  const { stdout } = await execFileAsync("plutil", ["-convert", "json", "-o", "-", plistPath]);
  return JSON.parse(stdout);
}

function normalizeCalendar(value) {
  if (!value) return [];
  return Array.isArray(value) ? value : [value];
}

function describeLaunchSchedule(plist) {
  const calendar = normalizeCalendar(plist.StartCalendarInterval);
  if (calendar.length) {
    return calendar
      .map((item) => `${String(item.Hour ?? "*").padStart(2, "0")}:${String(item.Minute ?? "00").padStart(2, "0")}`)
      .join(", ");
  }
  if (plist.StartInterval) return `每 ${plist.StartInterval}s`;
  return "手动/其他";
}

function parseLaunchctlDisabled(stdout) {
  const disabled = new Set();
  for (const match of stdout.matchAll(/"([^"]+)"\s*=>\s*(enabled|disabled)/g)) {
    if (match[2] === "disabled") disabled.add(match[1]);
  }
  return disabled;
}

async function launchctlOutput(args) {
  return execFileAsync("launchctl", args).then(
    ({ stdout }) => stdout,
    () => ""
  );
}

async function getSystemProcesses() {
  const { stdout } = await execFileAsync("ps", ["-axo", "pid=,ppid=,etime=,command="]);
  return parseProcessList(stdout);
}

async function getLaunchdStates(processes) {
  const [userList, systemDomain, userDisabled, systemDisabled] = await Promise.all([
    launchctlOutput(["list"]),
    launchctlOutput(["print", "system"]),
    launchctlOutput(["print-disabled", userLaunchDomain]),
    launchctlOutput(["print-disabled", "system"])
  ]);
  return {
    userLoaded: parseLaunchctlList(userList),
    systemLoaded: parseLaunchctlServices(systemDomain),
    userDisabled: parseLaunchctlDisabled(userDisabled),
    systemDisabled: parseLaunchctlDisabled(systemDisabled),
    processesByPid: new Map(processes.map((processInfo) => [processInfo.pid, processInfo]))
  };
}

async function listLaunchdTasks(processes) {
  processes ||= await getSystemProcesses();
  await fs.mkdir(userLaunchAgentsDir, { recursive: true });
  const states = await getLaunchdStates(processes);
  const tasks = [];

  for (const { dir, scope } of launchdReadDirs) {
    if (!(await pathExists(dir))) continue;
    const names = (await fs.readdir(dir)).filter((name) => name.endsWith(".plist"));

    for (const name of names) {
      const plistPath = path.join(dir, name);
      try {
        const plist = await plistToJson(plistPath);
        const label = plist.Label || name.replace(/\.plist$/, "");
        const systemDomain = scope === "System LaunchDaemons";
        const service = (systemDomain ? states.systemLoaded : states.userLoaded).get(label);
        const loaded = Boolean(service?.loaded);
        const running = Boolean(service?.running);
        const disabled = (systemDomain ? states.systemDisabled : states.userDisabled).has(label);
        const elapsed = service?.pid ? states.processesByPid.get(service.pid)?.elapsed || "" : "";
        tasks.push({
          id: encodeId(plistPath),
          stableId: plistPath,
          type: "launchd",
          name: label,
          label,
          scope,
          source: plistPath,
          command: (plist.ProgramArguments || [plist.Program || ""]).join(" "),
          schedule: describeLaunchSchedule(plist),
          enabled: !disabled,
          loaded,
          running,
          pid: service?.pid || null,
          pids: service?.pid ? [service.pid] : [],
          elapsed,
          lastExitStatus: service?.lastExitStatus ?? null,
          disabled,
          status: getLaunchdStatus({ disabled, loaded, running, lastExitStatus: service?.lastExitStatus ?? null }),
          stdoutPath: plist.StandardOutPath || "",
          stderrPath: plist.StandardErrorPath || "",
          raw: plist
        });
      } catch (error) {
        const label = name.replace(/\.plist$/, "");
        const systemDomain = scope === "System LaunchDaemons";
        const service = (systemDomain ? states.systemLoaded : states.userLoaded).get(label);
        const loaded = Boolean(service?.loaded);
        const running = Boolean(service?.running);
        const disabled = (systemDomain ? states.systemDisabled : states.userDisabled).has(label);
        const elapsed = service?.pid ? states.processesByPid.get(service.pid)?.elapsed || "" : "";
        tasks.push({
          id: encodeId(plistPath),
          stableId: plistPath,
          type: "launchd",
          name: label,
          label,
          scope,
          source: plistPath,
          command: "",
          schedule: "详情不可读",
          enabled: !disabled,
          loaded,
          running,
          pid: service?.pid || null,
          pids: service?.pid ? [service.pid] : [],
          elapsed,
          lastExitStatus: service?.lastExitStatus ?? null,
          disabled,
          status: getLaunchdStatus({ disabled, loaded, running, lastExitStatus: service?.lastExitStatus ?? null }),
          error: error.message
        });
      }
    }
  }

  return applyMetadata(tasks.sort((a, b) => a.name.localeCompare(b.name)));
}

async function getCrontabText() {
  try {
    const { stdout } = await execFileAsync("crontab", ["-l"]);
    return stdout;
  } catch (error) {
    if (String(error.stderr || error.message).includes("no crontab")) return "";
    throw error;
  }
}

async function execFileWithTimeout(command, args, timeoutMs = 8000) {
  const child = execFile(command, args, { timeout: timeoutMs });
  return new Promise((resolve, reject) => {
    let stderr = "";
    child.stderr?.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    child.on("error", reject);
    child.on("exit", (code, signal) => {
      if (code === 0) resolve();
      else if (signal === "SIGTERM") reject(new Error(`${command} timed out after ${timeoutMs}ms`));
      else reject(new Error(stderr || `${command} exited with code ${code ?? signal}`));
    });
  });
}

async function execFileWithInput(command, args, input, options = {}) {
  const child = execFile(command, args, options);
  return new Promise((resolve, reject) => {
    let stdout = "";
    let stderr = "";
    child.stdout?.on("data", (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr?.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    child.on("error", reject);
    child.on("exit", (code, signal) => {
      if (code === 0) resolve({ stdout, stderr });
      else reject(new Error(stderr || `${command} exited with code ${code ?? signal}`));
    });
    child.stdin?.end(input);
  });
}

async function setCrontabText(text) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "device-operate-cron-"));
  const filePath = path.join(dir, "crontab.txt");
  try {
    await fs.writeFile(filePath, text, "utf8");
    await execFileWithTimeout("crontab", [filePath]);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}

function parseCronTasks(text) {
  const tasks = [];
  text.split("\n").forEach((line, index) => {
    const leadingTrimmed = line.trimStart();
    const disabled = leadingTrimmed.startsWith(disabledCronPrefix);
    const rawLine = disabled ? leadingTrimmed.slice(disabledCronPrefix.length) : line;
    const trimmed = rawLine.trim();
    if (!trimmed || (!disabled && trimmed.startsWith("#"))) return;
    const match = trimmed.match(/^(\S+)\s+(\S+)\s+(\S+)\s+(\S+)\s+(\S+)\s+(.+)$/);
    if (!match) return;
    const [, minute, hour, dayOfMonth, month, dayOfWeek, command] = match;
    tasks.push({
      id: encodeId(String(index)),
      stableId: rawLine,
      type: "cron",
      name: `Cron line ${index + 1}`,
      label: `line-${index + 1}`,
      source: "crontab",
      lineNumber: index + 1,
      command,
      schedule: `${minute} ${hour} ${dayOfMonth} ${month} ${dayOfWeek}`,
      enabled: !disabled,
      loaded: !disabled,
      disabled,
      status: disabled ? "disabled" : "enabled",
      rawLine,
      logPaths: extractLogPaths(command)
    });
  });
  return tasks;
}

function extractLogPaths(command) {
  const paths = new Set();
  for (const match of command.matchAll(/(?:>>?|2>)\s*("?)([^"\s]+)\1/g)) {
    paths.add(match[2]);
  }
  return [...paths];
}

function getCronRuntime(task, processes) {
  const tracked = cronRunStates.get(taskKey(task.type, task.stableId));
  const trackedProcess = tracked?.running ? processes.find(({ pid }) => pid === tracked.pid) : null;
  const scheduledProcesses = findCronTaskProcesses(task.command, processes);
  const activeProcesses = [trackedProcess, ...scheduledProcesses].filter(Boolean);
  const uniqueProcesses = [...new Map(activeProcesses.map((processInfo) => [processInfo.pid, processInfo])).values()];
  const running = uniqueProcesses.length > 0 || Boolean(tracked?.running);
  const pids = uniqueProcesses.map(({ pid }) => pid);
  if (tracked?.running && !pids.includes(tracked.pid)) pids.unshift(tracked.pid);
  const failed =
    !running &&
    (Boolean(tracked?.error) || Boolean(tracked?.signal) || (tracked?.exitCode !== null && tracked?.exitCode !== undefined && tracked.exitCode !== 0));

  return {
    running,
    pid: pids[0] || null,
    pids,
    elapsed: uniqueProcesses[0]?.elapsed || (tracked?.running ? formatElapsed(Date.now() - tracked.startedAt) : ""),
    runSource: tracked?.running ? "manual" : scheduledProcesses.length ? "scheduler" : "",
    lastExitStatus: tracked?.exitCode ?? null,
    lastSignal: tracked?.signal || "",
    lastRunAt: tracked?.startedAt ? new Date(tracked.startedAt).toISOString() : "",
    status: running ? "running" : task.disabled ? "disabled" : failed ? "failed" : "waiting"
  };
}

function formatElapsed(milliseconds) {
  const totalSeconds = Math.max(0, Math.floor(milliseconds / 1000));
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  return [hours, minutes, seconds].map((value) => String(value).padStart(2, "0")).join(":");
}

function startCronTask(task) {
  const key = taskKey(task.type, task.stableId);
  const child = exec(task.command, { shell: "/bin/zsh" }, () => {});
  const state = {
    running: true,
    pid: child.pid || null,
    startedAt: Date.now(),
    exitCode: null,
    signal: "",
    error: ""
  };
  cronRunStates.set(key, state);

  child.once("error", (error) => {
    if (cronRunStates.get(key) === state) state.error = error.message;
  });
  child.once("exit", (code, signal) => {
    if (cronRunStates.get(key) !== state) return;
    state.running = false;
    state.exitCode = code;
    state.signal = signal || "";
    state.finishedAt = Date.now();
  });
  return { started: task.command, pid: state.pid };
}

async function listCronTasks(processes) {
  processes ||= await getSystemProcesses();
  const tasks = parseCronTasks(await getCrontabText()).map((task) => ({ ...task, ...getCronRuntime(task, processes) }));
  return applyMetadata(tasks);
}

async function getLaunchTask(id) {
  const plistPath = decodeId(id);
  const tasks = await listLaunchdTasks();
  const task = tasks.find((item) => item.source === plistPath);
  if (!task) return null;
  return {
    ...task,
    stdout: await readTail(task.stdoutPath),
    stderr: await readTail(task.stderrPath)
  };
}

async function getCronTask(id) {
  const lineIndex = Number(decodeId(id));
  const text = await getCrontabText();
  const processes = await getSystemProcesses();
  const tasks = parseCronTasks(text).map((task) => ({ ...task, ...getCronRuntime(task, processes) }));
  const task = tasks.find((item) => item.lineNumber === lineIndex + 1);
  if (!task) return null;
  const logs = {};
  for (const logPath of task.logPaths) {
    logs[logPath] = await readTail(logPath);
  }
  const [withMeta] = await applyMetadata([task]);
  return { ...withMeta, logs, crontab: text };
}

function compactTaskForAgent(task) {
  const compact = {
    id: task.id,
    type: task.type,
    name: task.name,
    label: task.label,
    scope: task.scope || (task.type === "cron" ? "User Crontab" : ""),
    source: task.source,
    schedule: task.schedule,
    command: task.command,
    enabled: task.enabled,
    alias: task.alias || "",
    note: task.note || "",
    tags: task.tags || [],
    stdoutPath: task.stdoutPath || "",
    stderrPath: task.stderrPath || "",
    logPaths: task.logPaths || []
  };
  if (task.rawLine) compact.rawLine = task.rawLine;
  if (task.stdout) compact.stdoutTail = task.stdout.slice(-2000);
  if (task.stderr) compact.stderrTail = task.stderr.slice(-2000);
  if (task.logs) {
    compact.logs = Object.fromEntries(Object.entries(task.logs).map(([key, value]) => [key, String(value).slice(-2000)]));
  }
  return compact;
}

function uniqueTags(tags) {
  return [...new Set(tags.map((tag) => String(tag).trim()).filter(Boolean))].slice(0, 5);
}

function inferTaskRemark(task) {
  const haystack = [task.name, task.label, task.command, task.source, task.schedule, task.scope].filter(Boolean).join(" ").toLowerCase();
  const scriptName = task.command?.match(/(?:^|\s)([~/"'\w./-]+\.sh)\b/)?.[1]?.split("/").pop()?.replace(/\.sh$/, "");
  let alias = scriptName ? scriptName.replace(/[_-]+/g, " ") : task.name || task.label || "系统任务";
  const tags = [task.type === "launchd" ? "LaunchAgent" : "Cron", task.scope?.startsWith("System") ? "系统" : "用户任务"];

  if (/feishu|lark|飞书|com\.ss\.android\.lark|open_feishu/.test(haystack)) {
    alias = "飞书自动打开";
    tags.push("飞书", "自动化");
  } else if (/adb|android|input keyevent|am start|monkey/.test(haystack)) {
    alias = "Android 自动化";
    tags.push("Android", "ADB");
  } else if (/backup|备份/.test(haystack)) {
    alias = "自动备份";
    tags.push("备份", "维护");
  } else if (/sync|同步/.test(haystack)) {
    alias = "自动同步";
    tags.push("同步", "维护");
  } else if (/clean|cleanup|清理|cache|log/.test(haystack)) {
    alias = "清理维护";
    tags.push("清理", "维护");
  }

  const scheduleText = task.schedule && task.schedule !== "手动/其他" ? `按 ${task.schedule} 触发` : "按系统配置触发";
  const commandText = task.command ? `执行 ${task.command.slice(0, 90)}${task.command.length > 90 ? "..." : ""}` : "命令信息不完整";
  const uncertainty = /系统任务|Cron line|line-\d+/.test(alias) ? "疑似" : "";
  return {
    alias: alias.slice(0, 14),
    note: `${uncertainty}${scheduleText}，${commandText}。`,
    tags: uniqueTags(tags)
  };
}

function parseSkillFrontmatter(content) {
  const match = content.match(/^---\n([\s\S]*?)\n---\n?/);
  const data = {};
  if (!match) return data;
  match[1].split("\n").forEach((line) => {
    const parts = line.split(":");
    if (parts.length < 2) return;
    data[parts.shift().trim()] = parts.join(":").trim();
  });
  return data;
}

async function listAgentSkills() {
  if (!(await pathExists(agentSkillsDir))) return [];
  const names = await fs.readdir(agentSkillsDir);
  const skills = [];
  for (const name of names) {
    const skillPath = path.join(agentSkillsDir, name, "SKILL.md");
    if (!(await pathExists(skillPath))) continue;
    const content = await fs.readFile(skillPath, "utf8");
    const frontmatter = parseSkillFrontmatter(content);
    skills.push({
      name: frontmatter.name || name,
      description: frontmatter.description || "",
      category: frontmatter.category || "system",
      source: "builtin",
      path: skillPath,
      content
    });
  }
  return skills.sort((a, b) => a.name.localeCompare(b.name));
}

async function getSystemTaskUnderstandingSkill() {
  const skillPath = path.join(agentSkillsDir, "system-task-understanding", "SKILL.md");
  return (await pathExists(skillPath)) ? fs.readFile(skillPath, "utf8") : "";
}

async function getTaskByTypeAndId(type, id) {
  return type === "launchd" ? getLaunchTask(id) : getCronTask(id);
}

async function runClaudeRemarkAgent(task) {
  const skill = await getSystemTaskUnderstandingSkill();
  const payload = JSON.stringify({ task: compactTaskForAgent(task), skill });
  const python = (await pathExists(agentPythonPath)) ? agentPythonPath : "python3";
  const { stdout } = await execFileWithInput(python, [harnessPath], payload, {
    timeout: 45_000,
    maxBuffer: 1024 * 1024
  });
  const result = JSON.parse(stdout);
  if (!result.ok) throw new Error(result.error || "Claude Agent SDK harness failed");
  const metadata = normalizeMetadataPayload(result.data);
  if (!metadata.alias && !metadata.note && !metadata.tags.length) {
    throw new Error("Claude Agent SDK returned empty metadata");
  }
  return metadata;
}

async function generateTaskRemark(task) {
  // Preferred: the configured Pi model. Keeps every AI feature on one runtime.
  try {
    const skill = await getSystemTaskUnderstandingSkill();
    const result = await piRuntime.complete({
      system: "你是 macOS 系统任务识别助手。只输出 JSON，不要解释。",
      prompt: [
        "请阅读下面这个系统任务，生成短别名、备注与标签。",
        '输出格式：{"alias":"不超过14个汉字","note":"一句中文说明用途、触发时间与风险","tags":["标签1","标签2"]}',
        "无法确认用途时如实写“疑似/可能”。",
        "",
        `内置 skill：\n${skill.slice(0, 6000)}`,
        "",
        `任务：\n${JSON.stringify(compactTaskForAgent(task), null, 2).slice(0, 9000)}`
      ].join("\n")
    });
    const fenced = result.text.match(/```(?:json)?\s*(\{[\s\S]*?\})\s*```/);
    const raw = fenced ? fenced[1] : result.text.slice(result.text.indexOf("{"), result.text.lastIndexOf("}") + 1);
    const metadata = normalizeMetadataPayload(JSON.parse(raw));
    if (!metadata.alias && !metadata.note && !metadata.tags.length) throw new Error("Pi 返回了空备注");
    return { ...metadata, source: "pi", model: `${result.provider}/${result.model}` };
  } catch (piError) {
    if (piError.code !== "ai-config-required") {
      // A configured-but-failing model still falls back rather than blocking the
      // task list, but the warning records which runtime failed.
      try {
        const metadata = await runClaudeRemarkAgent(task);
        return { ...metadata, source: "claude-agent-sdk", warning: `Pi 失败：${piError.message}` };
      } catch {
        // fall through to local rules
      }
    }
    return { ...inferTaskRemark(task), source: "local-fallback", warning: piError.message };
  }
}

function getLaunchdDomain(task) {
  return task.scope === "System LaunchDaemons" ? "system" : userLaunchDomain;
}

async function runPrivilegedLaunchctlToggle(task, enabled) {
  const domain = getLaunchdDomain(task);
  const target = `${domain}/${task.label}`;
  const action = enabled ? "enable" : "disable";
  const script = `on run argv
  set actionName to item 1 of argv
  set domainName to item 2 of argv
  set serviceTarget to item 3 of argv
  set plistPath to item 4 of argv
  if actionName is "enable" then
    set commandText to "/bin/launchctl enable " & quoted form of serviceTarget & " && (/bin/launchctl bootstrap " & quoted form of domainName & " " & quoted form of plistPath & " 2>/dev/null || /usr/bin/true)"
  else
    set commandText to "/bin/launchctl disable " & quoted form of serviceTarget & " && (/bin/launchctl bootout " & quoted form of domainName & " " & quoted form of plistPath & " 2>/dev/null || /usr/bin/true)"
  end if
  do shell script commandText with administrator privileges
end run`;
  await execFileWithInput("osascript", ["-", action, domain, target, task.source], script);
}

async function setLaunchdTaskEnabled(task, enabled) {
  const domain = getLaunchdDomain(task);
  const target = `${domain}/${task.label}`;
  if (task.scope === "System LaunchDaemons") {
    await runPrivilegedLaunchctlToggle(task, enabled);
  } else {
    await execFileAsync("launchctl", [enabled ? "enable" : "disable", target]);
    const lifecycleArgs = enabled ? ["bootstrap", domain, task.source] : ["bootout", domain, task.source];
    await execFileAsync("launchctl", lifecycleArgs).catch(() => {});
  }

  const refreshed = await getLaunchTask(task.id);
  if (!refreshed) throw new Error("Task not found after changing its status");
  if (enabled && refreshed.disabled) throw new Error("任务仍处于禁用状态");
  if (!enabled && !refreshed.disabled) throw new Error("任务未能禁用");
  return refreshed;
}

async function setCronTaskEnabled(task, enabled) {
  const current = await getCrontabText();
  const lines = current.split("\n");
  const lineIndex = task.lineNumber - 1;
  if (lines[lineIndex] === undefined) throw new Error("Task not found");
  lines[lineIndex] = enabled ? task.rawLine : `${disabledCronPrefix}${task.rawLine}`;
  await setCrontabText(lines.join("\n").replace(/\s*$/, "\n"));
  const refreshed = await getCronTask(task.id);
  if (!refreshed || refreshed.enabled !== enabled) throw new Error("Cron 状态更新失败");
  return refreshed;
}

async function setTaskEnabled(type, id, enabled) {
  const task = await getTaskByTypeAndId(type, id);
  if (!task) {
    const error = new Error("Task not found");
    error.status = 404;
    throw error;
  }
  return type === "launchd" ? setLaunchdTaskEnabled(task, enabled) : setCronTaskEnabled(task, enabled);
}

async function deleteTaskByTypeAndId(type, id) {
  if (type === "launchd") {
    const task = await getLaunchTask(id);
    if (!task) {
      const error = new Error("Task not found");
      error.status = 404;
      throw error;
    }
    if (task.scope !== "User LaunchAgents") {
      const error = new Error("Only user LaunchAgents can be deleted from this app");
      error.status = 403;
      throw error;
    }
    await execFileAsync("launchctl", ["unload", task.source]).catch(() => {});
    await fs.rm(task.source, { force: true });
    const metadata = await readMetadata();
    delete metadata[taskKey(task.type, task.stableId)];
    await writeMetadata(metadata);
    return { deleted: task.source };
  }

  const lineIndex = Number(decodeId(id));
  const current = await getCrontabText();
  const lines = current.split("\n");
  const line = lines[lineIndex];
  if (!line) {
    const error = new Error("Task not found");
    error.status = 404;
    throw error;
  }
  const task = parseCronTasks(current).find((item) => item.lineNumber === lineIndex + 1);
  lines.splice(lineIndex, 1);
  await setCrontabText(lines.join("\n").replace(/\s*$/, "\n"));
  const metadata = await readMetadata();
  delete metadata[taskKey("cron", task?.stableId || line)];
  await writeMetadata(metadata);
  return { deleted: line };
}

const listSystemTasks = async () => {
  const processes = await getSystemProcesses();
  const [launchd, cron] = await Promise.all([listLaunchdTasks(processes), listCronTasks(processes)]);
  return { launchd, cron };
};

const agentTools = createAgentTools({
  snapshotSystem: () => systemMonitorService.snapshot({ includeProcesses: true }),
  storageService,
  applicationService,
  applicationPermissionService,
  fileAssociationService,
  loginItemService,
  sshService,
  systemSettingsService,
  systemMonitorService,
  listTasks: listSystemTasks,
  getTaskDetail: async (type, id) => {
    const task = await getTaskByTypeAndId(type, id);
    if (!task) throw Object.assign(new Error("Task not found"), { status: 404 });
    return task;
  },
  taskActions: {
    run: async (type, id) => {
      const task = await getTaskByTypeAndId(type, id);
      if (!task) throw Object.assign(new Error("Task not found"), { status: 404 });
      if (type === "launchd") {
        await execFileAsync("launchctl", ["start", task.label]);
        return { started: task.label };
      }
      return startCronTask(task);
    },
    setEnabled: (type, id, enabled) => setTaskEnabled(type, id, enabled),
    updateMetadata: async (type, id, payload) => {
      const task = await getTaskByTypeAndId(type, id);
      if (!task) throw Object.assign(new Error("Task not found"), { status: 404 });
      return updateTaskMetadata(task, payload);
    },
    generateRemark: async (type, id, save) => {
      const task = await getTaskByTypeAndId(type, id);
      if (!task) throw Object.assign(new Error("Task not found"), { status: 404 });
      const remark = await generateTaskRemark(task);
      if (!save) return remark;
      const saved = await updateTaskMetadata(task, remark);
      return { ...saved, source: remark.source, warning: remark.warning || "" };
    }
  }
});

const aiConfig = createAiConfigStore();
const aiUsage = createAiUsageLedger();
const systemTools = createSystemTools();
const piRuntime = createPiRuntime({ aiConfig, tools: agentTools, usageLedger: aiUsage });

agentTools.register(systemTools.tools);

agentTools.register([
  {
    name: "battery_power_status",
    title: "电池与电源",
    description: "读取电池健康度、循环次数、当前电量、充电状态与电源管理策略。",
    risk: "read",
    summarize: (data = {}) => {
      const battery = data.battery || {};
      if (!battery.present) return "本机没有可读取的内置电池（可能是台式机）。";
      return [
        `当前电量 ${battery.stateOfChargePercent ?? "-"}%`,
        battery.charging ? "正在充电" : battery.fullyCharged ? "已充满" : "使用电池供电",
        `健康度 ${battery.healthPercent ?? "-"}%（${battery.condition || "未知"}）`,
        `循环 ${battery.cycleCount ?? "-"} 次`
      ].join("；");
    },
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    execute: () => systemInfoService.getPower()
  },
  {
    name: "sleep_wake_history",
    title: "睡眠与唤醒记录",
    description: "读取最近的睡眠、唤醒与暗唤醒事件及其原因。",
    risk: "read",
    summarize: (data = {}) => {
      const events = data.events || [];
      return events.length
        ? `最近 ${events.length} 条事件：${events.slice(0, 6).map((event) => `${event.at.slice(5, 16)} ${event.kind}${event.reason ? `（${event.reason}）` : ""}`).join("；")}`
        : "没有读取到睡眠/唤醒记录";
    },
    inputSchema: {
      type: "object",
      properties: { limit: { type: "number", description: "返回的事件条数，默认 40" } },
      additionalProperties: false
    },
    execute: (input) => systemInfoService.getSleepEvents({ limit: Number(input?.limit) || 40 })
  },
  {
    name: "software_update_status",
    title: "系统更新检查",
    description: "检查 macOS 与 Apple 软件的可安装更新，返回当前系统版本与自动更新策略。",
    risk: "read",
    summarize: (data = {}) => {
      const current = data.current || {};
      const updates = data.updates || [];
      if (data.upToDate) return `系统 ${current.productName || "macOS"} ${current.productVersion || ""} 已是最新，没有可用更新。`;
      return `当前 ${current.productName || "macOS"} ${current.productVersion || ""}，有 ${updates.length} 项更新：${updates.slice(0, 6).map((item) => `${item.title} ${item.version}`).join("；")}`;
    },
    inputSchema: {
      type: "object",
      properties: { fresh: { type: "boolean", description: "是否强制重新检查" } },
      additionalProperties: false
    },
    execute: (input) => systemInfoService.getUpdates({ fresh: Boolean(input?.fresh) })
  }
]);

agentTools.register([
  {
    name: "network_ping",
    title: "网络连通性检测",
    description: "对主机执行 ping 检测，返回丢包率与往返延迟。",
    risk: "read",
    summarize: (data = {}) => data.reachable
      ? `${data.host} 可达：平均 ${data.avgMs ?? "-"} ms，丢包 ${data.packetLossPercent}%`
      : `${data.host} 不可达：丢包 ${data.packetLossPercent}%`,
    inputSchema: {
      type: "object",
      required: ["host"],
      properties: {
        host: { type: "string", description: "主机名或 IP" },
        count: { type: "number", description: "探测次数，默认 4" }
      }
    },
    execute: (input) => networkToolService.ping({ host: input?.host, count: input?.count })
  },
  {
    name: "network_dns_lookup",
    title: "DNS 解析查询",
    description: "查询域名的 A/AAAA/CNAME/MX/TXT/NS 记录与反向解析。",
    risk: "read",
    summarize: (data = {}) => `${data.host} 的 ${data.record} 记录：${(data.answers || []).join("、") || "无结果"}`,
    inputSchema: {
      type: "object",
      required: ["host"],
      properties: {
        host: { type: "string" },
        record: { type: "string", enum: ["A", "AAAA", "CNAME", "MX", "TXT", "NS"] }
      }
    },
    execute: (input) => networkToolService.dnsLookup({ host: input?.host, record: input?.record })
  },
  {
    name: "network_check_port",
    title: "端口连通检测",
    description: "检测目标主机的 TCP 端口是否可连接。",
    risk: "read",
    summarize: (data = {}) => `${data.host}:${data.port} ${data.reachable ? "可连接" : "不可连接"}（${data.elapsedMs} ms）`,
    inputSchema: {
      type: "object",
      required: ["host", "port"],
      properties: { host: { type: "string" }, port: { type: "number" } }
    },
    execute: (input) => networkToolService.checkPort({ host: input?.host, port: input?.port })
  },
  {
    name: "network_listening_ports",
    title: "本机监听端口",
    description: "列出本机正在监听的 TCP 端口、对应进程与是否只绑定回环地址。",
    risk: "read",
    summarize: (data = {}) => `监听 ${data.summary?.total ?? 0} 个端口，其中 ${data.summary?.exposed ?? 0} 个对外可访问：${(data.entries || []).slice(0, 8).map((entry) => `${entry.port}/${entry.command}`).join("、")}`,
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    execute: () => networkToolService.listListeningPorts()
  },
  {
    name: "network_speed_test",
    title: "网络测速",
    description: "通过下载测试文件测量当前下行带宽，会消耗约 25MB 流量。",
    risk: "read",
    summarize: (data = {}) => `下行 ${data.megabitsPerSecond} Mbps（${data.megabytesPerSecond} MB/s），耗时 ${data.elapsedMs} ms`,
    inputSchema: {
      type: "object",
      properties: { bytes: { type: "number", description: "测试下载体积（字节），默认 25000000" } }
    },
    execute: (input) => networkToolService.speedTest({ bytes: input?.bytes })
  }
]);

agentTools.register([
  {
    name: "backup_status",
    title: "备份状态",
    description: "读取 Time Machine 目的地、最近备份、本地 APFS 快照与当前备份进度。",
    risk: "read",
    summarize: (data = {}) => [
      data.configured ? `已配置 ${data.destinations.length} 个备份目的地` : "未配置 Time Machine 目的地",
      data.backups?.length ? `最近备份 ${data.backups[0]}` : "没有可用的备份记录",
      `本地快照 ${data.localSnapshots?.length || 0} 个`,
      data.session?.running ? `正在备份 ${data.session.percent ?? "?"}%` : "当前没有正在进行的备份"
    ].join("；"),
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    execute: () => backupService.status()
  },
  {
    name: "uninstall_leftovers",
    title: "应用卸载残留",
    description: "扫描用户资源库中与已安装应用不匹配的残留目录，并给出体积。",
    risk: "read",
    summarize: (data = {}) => data.orphans?.length
      ? `发现 ${data.candidateCount} 组疑似残留，合计 ${Math.round((data.totalBytes || 0) / 1024 / 1024)} MB：${data.orphans.slice(0, 6).map((item) => `${item.label}（${item.categoryLabel}）`).join("；")}`
      : "没有发现明显的卸载残留",
    inputSchema: {
      type: "object",
      properties: { limit: { type: "number", description: "返回组数，默认 25" } },
      additionalProperties: false
    },
    execute: (input) => uninstallCleanupService.listUninstalledLeftovers({ limit: input?.limit })
  }
]);

const builtInTools = agentTools.list({ destructive: true });

const notificationService = createNotificationService();
const monitorHistoryPath = path.join(configDir, "metrics-history.jsonl");
const monitorHistoryService = createMonitorHistoryService({
  filePath: monitorHistoryPath,
  snapshot: () => systemMonitorService.snapshot({ includeProcesses: false }),
  volume: () => storageService.getVolume(),
  notifications: notificationService
});

const agentConversationService = createAgentConversationService({
  tools: agentTools,
  harness: {
    python: (await pathExists(agentPythonPath)) ? agentPythonPath : "python3",
    script: harnessPath,
    available: async () => {
      const python = (await pathExists(agentPythonPath)) ? agentPythonPath : "python3";
      const sdk = await execFileAsync(python, ["-c", "import claude_agent_sdk"]).then(() => true, () => false);
      if (!sdk) return false;
      return probeClaudeCli();
    }
  },
  runProcess: ({ command, args }) => spawn(command, args, { stdio: ["pipe", "pipe", "pipe"] })
});

const CLAUDE_AUTH_TTL_MS = 30_000;
const claudeAuthCache = { at: 0, ready: null, detail: "未检测" };

async function readClaudeCredentialExpiry() {
  const credentialPath = path.join(os.homedir(), ".claude", ".credentials.json");
  if (await pathExists(credentialPath)) {
    try {
      const parsed = JSON.parse(await fs.readFile(credentialPath, "utf8"));
      return findOauthExpiry(parsed);
    } catch {
      return null;
    }
  }
  try {
    const { stdout } = await execFileAsync("security", ["find-generic-password", "-s", "Claude Code-credentials", "-w"], { timeout: 4000 });
    return findOauthExpiry(JSON.parse(stdout));
  } catch {
    return null;
  }
}

function findOauthExpiry(value, depth = 0) {
  if (!value || depth > 6) return null;
  if (Array.isArray(value)) {
    for (const entry of value) {
      const found = findOauthExpiry(entry, depth + 1);
      if (found) return found;
    }
    return null;
  }
  if (typeof value !== "object") return null;
  for (const [key, entry] of Object.entries(value)) {
    if (/expires?at$/i.test(key) && typeof entry === "number") return entry;
    const found = findOauthExpiry(entry, depth + 1);
    if (found) return found;
  }
  return null;
}

// The Claude CLI can hang for minutes when its OAuth token is expired, so check
// the known credential expiry first. A failed check opens a short circuit
// breaker and the local engine answers instead of stalling the user.
async function claudeCredentialsUsable() {
  const now = Date.now();
  if (claudeAuthCache.ready !== null && now - claudeAuthCache.at < CLAUDE_AUTH_TTL_MS) {
    return claudeAuthCache;
  }
  const cliStatus = await execFileAsync("claude", ["auth", "status"], { timeout: 4000 })
    .then(({ stdout }) => {
      try {
        return JSON.parse(stdout);
      } catch {
        return null;
      }
    })
    .catch(() => null);
  if (!cliStatus?.loggedIn) {
    claudeAuthCache.ready = false;
    claudeAuthCache.at = now;
    claudeAuthCache.detail = "Claude CLI 未登录";
    return claudeAuthCache;
  }
  const expiry = await readClaudeCredentialExpiry();
  if (expiry && expiry < now) {
    claudeAuthCache.ready = false;
    claudeAuthCache.at = now;
    claudeAuthCache.detail = "Claude 登录已过期，请重新登录 Claude Code";
    return claudeAuthCache;
  }
  claudeAuthCache.ready = true;
  claudeAuthCache.at = now;
  claudeAuthCache.detail = "Claude CLI 已登录";
  return claudeAuthCache;
}

async function probeClaudeCli({ fresh = false } = {}) {
  if (fresh) {
    claudeAuthCache.ready = null;
    claudeAuthCache.at = 0;
  }
  const state = await claudeCredentialsUsable();
  return state.ready === true;
}

const agentConfigPath = path.join(configDir, "agent.json");
const AGENT_PERMISSION_LEVELS = ["read", "write", "destructive"];

async function readAgentConfig() {
  try {
    const parsed = JSON.parse(await fs.readFile(agentConfigPath, "utf8"));
    return {
      permissionLevel: AGENT_PERMISSION_LEVELS.includes(parsed?.permissionLevel) ? parsed.permissionLevel : "read"
    };
  } catch {
    return { permissionLevel: "read" };
  }
}

async function writeAgentConfig(update = {}) {
  const current = await readAgentConfig();
  const next = { ...current };
  if (AGENT_PERMISSION_LEVELS.includes(update.permissionLevel)) next.permissionLevel = update.permissionLevel;
  await fs.mkdir(configDir, { recursive: true });
  await fs.writeFile(agentConfigPath, JSON.stringify(next, null, 2), "utf8");
  return next;
}

function permissionLevel(input = {}) {
  const requested = input.permissionLevel || input.permissions?.level;
  return AGENT_PERMISSION_LEVELS.includes(requested) ? requested : "";
}

// The MCP surface used by the Tools page and by external MCP clients keeps the
// same 1:1 mapping onto local services; destructive tools stay gated by the
// caller's declared permission level.
async function executeBuiltInTool(name, input = {}, permissions = { destructive: true }) {
  const tool = agentTools.get(name);
  if (!tool) throw Object.assign(new Error(`Unknown tool: ${name}`), { status: 404 });
  const result = await agentTools.execute(name, input, { permissions: permissions || {} });
  return result.data ?? null;
}

async function getAgentStatus() {
  const python = (await pathExists(agentPythonPath)) ? agentPythonPath : "python3";
  const sdk = await execFileAsync(python, ["-c", "import claude_agent_sdk; print('available')"]).then(
    () => ({ available: true, detail: "claude_agent_sdk available" }),
    (error) => ({ available: false, detail: String(error.stderr || error.message).trim() })
  );
  const claudeCli = await execFileAsync("zsh", ["-lc", "command -v claude"]).then(
    ({ stdout }) => stdout.trim(),
    () => ""
  );
  const auth = sdk.available ? await claudeCredentialsUsable() : { ready: false, detail: "Claude Agent SDK 不可用" };
  return {
    sdk,
    claudeReady: auth.ready === true,
    claudeProbe: auth.detail,
    claudeCli,
    python,
    agentPythonPath,
    harnessPath,
    referenceAgentProject,
    tools: builtInTools.length,
    skills: (await listAgentSkills()).length
  };
}

function validateLabel(label) {
  return /^[A-Za-z0-9][A-Za-z0-9_.-]+$/.test(label);
}

function buildLaunchPlist({ label, command, hour, minute, stdoutPath, stderrPath }) {
  const args = ["/bin/zsh", "-lc", command];
  const escaped = (value) =>
    String(value)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;");
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN"
  "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${escaped(label)}</string>
  <key>ProgramArguments</key>
  <array>
${args.map((arg) => `    <string>${escaped(arg)}</string>`).join("\n")}
  </array>
  <key>StartCalendarInterval</key>
  <dict>
    <key>Hour</key>
    <integer>${Number(hour)}</integer>
    <key>Minute</key>
    <integer>${Number(minute)}</integer>
  </dict>
  <key>StandardOutPath</key>
  <string>${escaped(stdoutPath || `/tmp/${label}.out`)}</string>
  <key>StandardErrorPath</key>
  <string>${escaped(stderrPath || `/tmp/${label}.err`)}</string>
  <key>RunAtLoad</key>
  <false/>
</dict>
</plist>
`;
}

app.get("/api/health", (_req, res) => ok(res, { status: "ok" }));

app.get("/api/storage/overview", async (req, res) => {
  try {
    ok(res, await storageService.getOverview({ fresh: req.query.fresh === "1" }));
  } catch (error) {
    bad(res, error.status || 500, error.message);
  }
});

app.get("/api/storage/volume", async (_req, res) => {
  try {
    ok(res, await storageService.getVolume());
  } catch (error) {
    bad(res, error.status || 500, error.message);
  }
});

app.post("/api/storage/refresh", (req, res) => {
  try {
    ok(res, storageService.startRefresh({
      includeAnalysis: req.body?.includeAnalysis === true,
      includeBase: req.body?.includeBase !== false
    }));
  } catch (error) {
    bad(res, error.status || 500, error.message);
  }
});

app.get("/api/storage/refresh/:id", (req, res) => {
  try {
    ok(res, storageService.getRefreshStatus(req.params.id));
  } catch (error) {
    bad(res, error.status || 500, error.message);
  }
});

app.get("/api/storage/cleanup", async (req, res) => {
  try {
    ok(res, await storageService.getCleanupSuggestions({ fresh: req.query.fresh === "1" }));
  } catch (error) {
    bad(res, error.status || 500, error.message);
  }
});

app.get("/api/storage/analysis", async (req, res) => {
  try {
    ok(res, await storageService.getAnalysis({ fresh: req.query.fresh === "1" }));
  } catch (error) {
    bad(res, error.status || 500, error.message);
  }
});

app.get("/api/storage/analysis/files", async (req, res) => {
  try {
    ok(res, await storageService.getLargeFilePreview({ fresh: req.query.fresh === "1" }));
  } catch (error) {
    bad(res, error.status || 500, error.message);
  }
});

app.post("/api/storage/inspect", async (req, res) => {
  try {
    ok(res, await storageService.inspectItem(req.body.path));
  } catch (error) {
    bad(res, error.status || 500, error.message);
  }
});

app.post("/api/storage/reveal", async (req, res) => {
  try {
    ok(res, await storageService.revealItem(req.body.path));
  } catch (error) {
    bad(res, error.status || 500, error.message);
  }
});

app.post("/api/storage/open", async (req, res) => {
  try {
    ok(res, await storageService.openItem(req.body.path));
  } catch (error) {
    bad(res, error.status || 500, error.message);
  }
});

app.post("/api/storage/items/trash", async (req, res) => {
  try {
    ok(res, await storageService.trashItem(req.body.path));
  } catch (error) {
    bad(res, error.status || 500, error.message);
  }
});

app.post("/api/storage/items/trash-batch", async (req, res) => {
  try {
    ok(res, await storageService.trashItems(req.body.paths));
  } catch (error) {
    bad(res, error.status || 500, error.message);
  }
});

app.post("/api/storage/cleanup/:id", async (req, res) => {
  try {
    ok(res, await storageService.cleanCategory(req.params.id));
  } catch (error) {
    bad(res, error.status || 500, error.message);
  }
});

app.post("/api/storage/cleanup/:id/items", async (req, res) => {
  try {
    ok(res, await storageService.cleanCategoryItems(req.params.id, req.body.paths));
  } catch (error) {
    bad(res, error.status || 500, error.message);
  }
});

app.post("/api/storage/paths/exists", async (req, res) => {
  try {
    ok(res, await storageService.checkPathsExist(req.body.paths));
  } catch (error) {
    bad(res, error.status || 500, error.message);
  }
});

app.post("/api/storage/settings/open", async (_req, res) => {
  try {
    ok(res, await storageService.openStorageSettings());
  } catch (error) {
    bad(res, error.status || 500, error.message);
  }
});

app.post("/api/system-settings/open", async (req, res) => {
  try {
    ok(res, await systemSettingsService.open(req.body?.id));
  } catch (error) {
    bad(res, error.status || 500, error.message);
  }
});

app.get("/api/tools/ssh", async (_req, res) => {
  try {
    ok(res, await sshService.getState());
  } catch (error) {
    bad(res, error.status || 500, error.message);
  }
});

app.post("/api/tools/ssh/initialize", async (_req, res) => {
  try {
    ok(res, await sshService.initialize());
  } catch (error) {
    bad(res, error.status || 500, error.message);
  }
});

app.post("/api/tools/ssh/keys/generate", async (req, res) => {
  try {
    ok(res, await sshService.generateKey(req.body || {}));
  } catch (error) {
    bad(res, error.status || 500, error.message);
  }
});

app.get("/api/tools/ssh/keys/:name/content", async (req, res) => {
  try {
    ok(res, await sshService.readKeyContent(req.params.name, req.query.kind || "public"));
  } catch (error) {
    bad(res, error.status || 500, error.message);
  }
});

app.post("/api/tools/ssh/config", async (req, res) => {
  try {
    ok(res, await sshService.createHost(req.body || {}));
  } catch (error) {
    bad(res, error.status || 500, error.message);
  }
});

app.patch("/api/tools/ssh/config", async (req, res) => {
  try {
    ok(res, await sshService.updateHost(req.body || {}));
  } catch (error) {
    bad(res, error.status || 500, error.message);
  }
});

app.delete("/api/tools/ssh/config", async (req, res) => {
  try {
    ok(res, await sshService.deleteHost(req.body || {}));
  } catch (error) {
    bad(res, error.status || 500, error.message);
  }
});

app.get("/api/apps", async (req, res) => {
  try {
    ok(res, await applicationService.listApplications({ fresh: req.query.fresh === "1" }));
  } catch (error) {
    bad(res, 500, error.message);
  }
});

app.get("/api/processes", async (_req, res) => {
  try {
    ok(res, await systemMonitorService.snapshot());
  } catch (error) {
    bad(res, error.status || 500, error.message);
  }
});

app.get("/api/processes/metrics", async (_req, res) => {
  try {
    ok(res, await systemMonitorService.snapshot({ includeProcesses: false }));
  } catch (error) {
    bad(res, error.status || 500, error.message);
  }
});

app.post("/api/processes/terminate", async (req, res) => {
  try {
    ok(res, await applicationService.terminateProcesses(req.body?.pids));
  } catch (error) {
    bad(res, error.status || 500, error.message);
  }
});

app.post("/api/processes/:pid/terminate", async (req, res) => {
  try {
    ok(res, await applicationService.terminateProcess(req.params.pid));
  } catch (error) {
    bad(res, error.status || 500, error.message);
  }
});

app.get("/api/apps-analysis", async (req, res) => {
  try {
    ok(res, await applicationService.analyzeApplications({ fresh: req.query.fresh === "1" }));
  } catch (error) {
    bad(res, 500, error.message);
  }
});

app.post("/api/apps-analysis/open-full-disk-access", async (_req, res) => {
  try {
    ok(res, await applicationService.openFullDiskAccessSettings());
  } catch (error) {
    bad(res, error.status || 500, error.message);
  }
});

app.get("/api/login-items", async (req, res) => {
  try {
    ok(res, await loginItemService.listLoginItems({ fresh: req.query.fresh === "1" }));
  } catch (error) {
    bad(res, error.status || 500, error.message);
  }
});

app.post("/api/login-items", async (req, res) => {
  try {
    if (!req.body.applicationId) return bad(res, 400, "applicationId is required");
    ok(res, await loginItemService.addLoginItem(req.body.applicationId));
  } catch (error) {
    bad(res, error.status || 500, error.message);
  }
});

app.delete("/api/login-items/:id", async (req, res) => {
  try {
    ok(res, await loginItemService.removeLoginItem(req.params.id));
  } catch (error) {
    bad(res, error.status || 500, error.message);
  }
});

app.post("/api/login-items/settings/open", async (_req, res) => {
  try {
    ok(res, await loginItemService.openLoginItemSettings());
  } catch (error) {
    bad(res, error.status || 500, error.message);
  }
});

app.post("/api/login-items/automation/open", async (_req, res) => {
  try {
    ok(res, await loginItemService.openAutomationSettings());
  } catch (error) {
    bad(res, error.status || 500, error.message);
  }
});

app.get("/api/application-permissions", async (req, res) => {
  try {
    ok(res, await applicationPermissionService.listPermissions({ fresh: req.query.fresh === "1" }));
  } catch (error) {
    bad(res, error.status || 500, error.message);
  }
});

app.post("/api/application-permissions/settings/open", async (req, res) => {
  try {
    ok(res, await applicationPermissionService.openPermissionSettings(req.body.categoryId));
  } catch (error) {
    bad(res, error.status || 500, error.message);
  }
});

app.post("/api/application-permissions/:applicationId/:service/reset", async (req, res) => {
  try {
    ok(res, await applicationPermissionService.resetPermission(req.params.applicationId, req.params.service));
  } catch (error) {
    bad(res, error.status || 500, error.message);
  }
});

app.get("/api/file-associations", async (req, res) => {
  try {
    ok(res, await fileAssociationService.listFileAssociations({ fresh: req.query.fresh === "1" }));
  } catch (error) {
    bad(res, error.status || 500, error.message);
  }
});

app.post("/api/file-associations/:typeId/default", async (req, res) => {
  try {
    if (!req.body.bundleId) return bad(res, 400, "bundleId is required");
    ok(res, await fileAssociationService.setDefaultApplication(req.params.typeId, req.body.bundleId));
  } catch (error) {
    bad(res, error.status || 500, error.message);
  }
});

app.get("/api/apps/:id/icon", async (req, res) => {
  try {
    const iconPath = await applicationService.getApplicationIcon(req.params.id);
    if (!iconPath) return res.status(204).end();
    res.set("Cache-Control", "private, max-age=86400");
    res.sendFile(iconPath);
  } catch (error) {
    bad(res, error.status || 500, error.message);
  }
});

app.post("/api/apps/:id/open", async (req, res) => {
  try {
    ok(res, await applicationService.openApplication(req.params.id));
  } catch (error) {
    bad(res, error.status || 500, error.message);
  }
});

app.post("/api/apps/:id/stop", async (req, res) => {
  try {
    ok(res, await applicationService.stopApplication(req.params.id));
  } catch (error) {
    bad(res, error.status || 500, error.message);
  }
});

app.post("/api/apps/:id/restart", async (req, res) => {
  try {
    ok(res, await applicationService.restartApplication(req.params.id));
  } catch (error) {
    bad(res, error.status || 500, error.message);
  }
});

app.delete("/api/apps/:id", async (req, res) => {
  try {
    ok(res, await applicationService.uninstallApplication(req.params.id));
  } catch (error) {
    bad(res, error.status || 500, error.message);
  }
});

app.get("/api/monitor/history", async (req, res) => {
  try {
    const limit = Number(req.query.limit) || 240;
    ok(res, await monitorHistoryService.history({ limit }));
  } catch (error) {
    bad(res, 500, error.message);
  }
});

app.get("/api/monitor/summary", async (req, res) => {
  try {
    const limit = Number(req.query.limit) || 240;
    ok(res, await monitorHistoryService.summary({ limit }));
  } catch (error) {
    bad(res, 500, error.message);
  }
});

app.get("/api/monitor/status", (_req, res) => {
  ok(res, {
    ...monitorHistoryService.status(),
    rules: DEFAULT_ALERT_RULES,
    notifications: notificationService.status()
  });
});

app.post("/api/monitor/sample", async (_req, res) => {
  try {
    const result = await monitorHistoryService.sampleOnce();
    ok(res, {
      sample: result.sample,
      fired: result.fired,
      active: result.active
    });
  } catch (error) {
    bad(res, 500, error.message);
  }
});

app.get("/api/notifications", (_req, res) => ok(res, notificationService.list()));

app.post("/api/notifications/test", async (req, res) => {
  try {
    const alert = {
      label: String(req.body?.label || "测试通知"),
      value: Number(req.body?.value ?? 0),
      threshold: Number(req.body?.threshold ?? 0),
      metric: String(req.body?.metric || "cpuPercent"),
      advice: "这是一条测试通知，用于确认 macOS 通知中心可以收到本应用的告警。"
    };
    const result = await notificationService.notify({
      title: "我的 macOS · 告警测试",
      subtitle: alert.label,
      message: describeAlert(alert),
      severity: "warning",
      ruleId: "test"
    });
    ok(res, result);
  } catch (error) {
    bad(res, 500, error.message);
  }
});

const networkRoutes = {
  "/api/network/ping": (body) => networkToolService.ping(body),
  "/api/network/traceroute": (body) => networkToolService.traceroute(body),
  "/api/network/dns": (body) => networkToolService.dnsLookup(body),
  "/api/network/port": (body) => networkToolService.checkPort(body)
};

for (const [route, handler] of Object.entries(networkRoutes)) {
  app.post(route, async (req, res) => {
    try {
      ok(res, await handler(req.body || {}));
    } catch (error) {
      bad(res, error.status || 500, error.message);
    }
  });
}

app.get("/api/network/listening-ports", async (_req, res) => {
  try {
    ok(res, await networkToolService.listListeningPorts());
  } catch (error) {
    bad(res, error.status || 500, error.message);
  }
});

app.get("/api/network/proxy", async (_req, res) => {
  try {
    ok(res, await networkToolService.proxyState());
  } catch (error) {
    bad(res, error.status || 500, error.message);
  }
});

app.post("/api/network/speed-test", async (req, res) => {
  try {
    ok(res, await networkToolService.speedTest(req.body || {}));
  } catch (error) {
    bad(res, error.status || 500, error.message);
  }
});

app.get("/api/network-monitor/snapshot", async (_req, res) => {
  try {
    ok(res, await networkMonitorService.snapshot());
  } catch (error) {
    bad(res, error.status || 500, error.message);
  }
});

app.post("/api/network-monitor/refresh", async (_req, res) => {
  try {
    ok(res, await networkMonitorService.refresh());
  } catch (error) {
    bad(res, error.status || 500, error.message);
  }
});

app.get("/api/network-monitor/config", async (_req, res) => {
  try {
    ok(res, await networkMonitorService.config());
  } catch (error) {
    bad(res, error.status || 500, error.message);
  }
});

app.patch("/api/network-monitor/config", async (req, res) => {
  try {
    ok(res, await networkMonitorService.updateConfig(req.body || {}));
  } catch (error) {
    bad(res, error.status || 500, error.message);
  }
});

app.get("/api/backup/status", async (_req, res) => {
  try {
    ok(res, await backupService.status());
  } catch (error) {
    bad(res, error.status || 500, error.message);
  }
});

app.post("/api/backup/start", async (_req, res) => {
  try {
    ok(res, await backupService.startBackup());
  } catch (error) {
    bad(res, error.status || 500, error.message);
  }
});

app.post("/api/backup/snapshots/delete", async (req, res) => {
  try {
    ok(res, await backupService.deleteSnapshot(req.body || {}));
  } catch (error) {
    bad(res, error.status || 500, error.message);
  }
});

app.get("/api/backup/config/export", async (_req, res) => {
  try {
    ok(res, await backupService.exportConfig());
  } catch (error) {
    bad(res, error.status || 500, error.message);
  }
});

app.post("/api/backup/config/import", async (req, res) => {
  try {
    ok(res, await backupService.importConfig(req.body || {}));
  } catch (error) {
    bad(res, error.status || 500, error.message);
  }
});

app.get("/api/cleanup/leftovers", async (req, res) => {
  try {
    ok(res, await uninstallCleanupService.listUninstalledLeftovers({ limit: Number(req.query.limit) || 25 }));
  } catch (error) {
    bad(res, error.status || 500, error.message);
  }
});

app.post("/api/cleanup/leftovers/scan", async (req, res) => {
  try {
    ok(res, await uninstallCleanupService.scanApplication(req.body || {}));
  } catch (error) {
    bad(res, error.status || 500, error.message);
  }
});

app.post("/api/cleanup/leftovers/trash", async (req, res) => {
  try {
    ok(res, await uninstallCleanupService.trashLeftovers(req.body || {}));
  } catch (error) {
    bad(res, error.status || 500, error.message);
  }
});

app.get("/api/ai/status", async (_req, res) => {
  try {
    const [status, usage] = await Promise.all([piRuntime.status(), aiUsage.summary()]);
    ok(res, { ...status, usage, runtimeVersion: RUNTIME_VERSION, harness: { python: agentPythonPath } });
  } catch (error) {
    bad(res, error.status || 500, error.message);
  }
});

app.get("/api/ai/config", async (_req, res) => {
  try {
    ok(res, await aiConfig.snapshot());
  } catch (error) {
    bad(res, 500, error.message);
  }
});

app.put("/api/ai/config/provider/:provider", async (req, res) => {
  try {
    const provider = String(req.params.provider || "").trim();
    if (!provider) return bad(res, 400, "缺少 provider");
    if (typeof req.body?.apiKey === "string" && req.body.apiKey.trim()) {
      await aiConfig.setProvider(provider, { apiKey: req.body.apiKey.trim() });
    }
    if (typeof req.body?.baseUrl === "string" || typeof req.body?.label === "string") {
      await aiConfig.setProvider(provider, { baseUrl: req.body.baseUrl, label: req.body.label });
    }
    await piRuntime.invalidate();
    ok(res, await aiConfig.snapshot());
  } catch (error) {
    bad(res, error.status || 500, error.message);
  }
});

app.delete("/api/ai/config/provider/:provider", async (req, res) => {
  try {
    await aiConfig.clearProvider(String(req.params.provider || "").trim());
    await piRuntime.invalidate();
    ok(res, await aiConfig.snapshot());
  } catch (error) {
    bad(res, error.status || 500, error.message);
  }
});

app.put("/api/ai/config/custom", async (req, res) => {
  try {
    await aiConfig.setCustomProviders(req.body?.providers);
    await piRuntime.invalidate();
    ok(res, await aiConfig.snapshot());
  } catch (error) {
    bad(res, error.status || 500, error.message);
  }
});

app.put("/api/ai/config/default", async (req, res) => {
  try {
    await aiConfig.setDefault({
      provider: typeof req.body?.provider === "string" ? req.body.provider : undefined,
      model: typeof req.body?.model === "string" ? req.body.model : undefined,
      thinkingLevel: typeof req.body?.thinkingLevel === "string" ? req.body.thinkingLevel : undefined,
      systemPrompt: typeof req.body?.systemPrompt === "string" ? req.body.systemPrompt : undefined
    });
    await piRuntime.invalidate();
    ok(res, await aiConfig.snapshot());
  } catch (error) {
    bad(res, error.status || 500, error.message);
  }
});

app.get("/api/ai/providers", async (_req, res) => {
  try {
    const providers = await piRuntime.listProviders();
    // The UI only needs identity + credential state here; model lists are
    // fetched per provider so a single response stays small.
    ok(res, {
      providers: providers.map(({ models, ...rest }) => rest),
      runtimeVersion: RUNTIME_VERSION
    });
  } catch (error) {
    bad(res, error.status || 500, error.message);
  }
});

app.get("/api/ai/models", async (req, res) => {
  try {
    const providers = await piRuntime.listProviders();
    const filter = String(req.query.provider || "").trim();
    ok(res, { providers: filter ? providers.filter((entry) => entry.id === filter) : providers, runtimeVersion: RUNTIME_VERSION });
  } catch (error) {
    bad(res, error.status || 500, error.message);
  }
});

app.post("/api/ai/test", async (req, res) => {
  try {
    ok(res, await piRuntime.testProvider({
      provider: String(req.body?.provider || "").trim(),
      model: typeof req.body?.model === "string" ? req.body.model : "",
      live: req.body?.live === true
    }));
  } catch (error) {
    bad(res, error.status || 500, error.message);
  }
});

app.get("/api/ai/usage", async (_req, res) => {
  try {
    ok(res, await aiUsage.summary());
  } catch (error) {
    bad(res, 500, error.message);
  }
});

app.get("/api/system-info/power", async (_req, res) => {
  try {
    ok(res, await systemInfoService.getPower());
  } catch (error) {
    bad(res, error.status || 500, error.message);
  }
});

app.get("/api/system-info/sleep", async (req, res) => {
  try {
    ok(res, await systemInfoService.getSleepEvents({ limit: Number(req.query.limit) || 40 }));
  } catch (error) {
    bad(res, error.status || 500, error.message);
  }
});

app.get("/api/system-info/assertions", async (_req, res) => {
  try {
    ok(res, await systemInfoService.getAssertions());
  } catch (error) {
    bad(res, error.status || 500, error.message);
  }
});

app.get("/api/system-info/updates", async (req, res) => {
  try {
    ok(res, await systemInfoService.getUpdates({ fresh: req.query.fresh === "1" }));
  } catch (error) {
    bad(res, error.status || 500, error.message);
  }
});

app.get("/api/agent/status", async (_req, res) => {
  try {
    ok(res, await getAgentStatus());
  } catch (error) {
    bad(res, 500, error.message);
  }
});

app.get("/api/agent/tools", async (req, res) => {
  try {
    const level = permissionLevel({ permissionLevel: req.query.level }) || (await readAgentConfig()).permissionLevel;
    ok(res, agentTools.list({
      write: level === "write" || level === "destructive",
      destructive: level === "destructive"
    }));
  } catch (error) {
    bad(res, 500, error.message);
  }
});

app.get("/api/agent/config", async (_req, res) => {
  try {
    ok(res, await readAgentConfig());
  } catch (error) {
    bad(res, 500, error.message);
  }
});

app.post("/api/agent/config", async (req, res) => {
  try {
    ok(res, await writeAgentConfig({ permissionLevel: permissionLevel(req.body) }));
  } catch (error) {
    bad(res, 500, error.message);
  }
});

app.post("/api/agent/chat", async (req, res) => {
  const level = permissionLevel(req.body) || (await readAgentConfig()).permissionLevel;
  try {
    const result = await piRuntime.run({
      sessionId: req.body?.sessionId,
      message: req.body?.message,
      permissionLevel: level
    });
    await writeAgentConfig({ permissionLevel: level });
    ok(res, { ...result, permissionLevel: level, needsConfiguration: false });
  } catch (error) {
    if (error.code === "ai-config-required") {
      // No provider configured yet: keep the page useful with the deterministic
      // local engine, and point the user at the manual AI configuration.
      const local = await agentConversationService.chat(
        {
          message: req.body?.message,
          history: req.body?.history,
          permissionLevel: level
        },
        { localOnly: true }
      );
      return ok(res, {
        ...local,
        permissionLevel: level,
        needsConfiguration: true,
        configReason: error.message
      });
    }
    bad(res, error.status || 500, error.message);
  }
});

// Streaming chat: the Pi loop emits events (deltas, tool calls, usage) and this
// route turns them into SSE frames so the UI can render them as they happen.
app.post("/api/agent/chat/stream", async (req, res) => {
  const level = permissionLevel(req.body) || (await readAgentConfig()).permissionLevel;
  const abort = new AbortController();
  const stream = createSseStream(res, { onClose: () => abort.abort() });
  stream.send("open", { permissionLevel: level, runtime: RUNTIME_VERSION });
  try {
    const result = await piRuntime.run({
      sessionId: req.body?.sessionId,
      message: req.body?.message,
      permissionLevel: level,
      signal: abort.signal,
      onEvent: (event) => stream.send(event.type, event)
    });
    await writeAgentConfig({ permissionLevel: level });
    stream.send("final", { ...result, permissionLevel: level, needsConfiguration: false });
  } catch (error) {
    if (error.code === "ai-config-required") {
      stream.send("config-required", { reason: error.message });
      try {
        const local = await agentConversationService.chat(
          { message: req.body?.message, history: req.body?.history, permissionLevel: level },
          { localOnly: true, onEvent: (event) => stream.send(event.type, event) }
        );
        stream.send("final", {
          ...local,
          permissionLevel: level,
          needsConfiguration: true,
          configReason: error.message
        });
      } catch (localError) {
        stream.send("error", { message: localError.message, status: localError.status || 500 });
      }
    } else {
      stream.send("error", { message: error.message, status: error.status || 500 });
    }
  } finally {
    stream.send("done", { ok: true });
    stream.close();
  }
});

app.delete("/api/agent/chat/:sessionId", (req, res) => {
  try {
    ok(res, piRuntime.resetSession(req.params.sessionId));
  } catch (error) {
    bad(res, 500, error.message);
  }
});

app.post("/api/agent/tools/:name/run", async (req, res) => {
  try {
    ok(res, await executeBuiltInTool(req.params.name, req.body || {}));
  } catch (error) {
    bad(res, 500, error.message);
  }
});

app.get("/api/agent/skills", async (_req, res) => {
  try {
    ok(res, await listAgentSkills());
  } catch (error) {
    bad(res, 500, error.message);
  }
});

app.post("/api/agent/generate-task-remark", async (req, res) => {
  try {
    const task = await getTaskByTypeAndId(req.body.type, req.body.id);
    if (!task) return bad(res, 404, "Task not found");
    const remark = await generateTaskRemark(task);
    if (!req.body.save) return ok(res, remark);

    const saved = await updateTaskMetadata(task, remark, { preserveExisting: Boolean(req.body.preserveExisting) });
    ok(res, { ...saved, source: remark.source, warning: remark.warning || "" });
  } catch (error) {
    bad(res, 500, error.message);
  }
});

app.get("/api/tasks", async (_req, res) => {
  try {
    const processes = await getSystemProcesses();
    const [launchd, cron] = await Promise.all([listLaunchdTasks(processes), listCronTasks(processes)]);
    ok(res, { launchd, cron });
  } catch (error) {
    bad(res, 500, error.message);
  }
});

app.get("/api/tasks/:type/:id", async (req, res) => {
  try {
    const task = req.params.type === "launchd" ? await getLaunchTask(req.params.id) : await getCronTask(req.params.id);
    if (!task) return bad(res, 404, "Task not found");
    ok(res, task);
  } catch (error) {
    bad(res, 500, error.message);
  }
});

app.post("/api/tasks/launchd", async (req, res) => {
  try {
    const { label, command, hour, minute, stdoutPath, stderrPath } = req.body;
    if (!validateLabel(label || "")) return bad(res, 400, "Invalid label");
    if (!command) return bad(res, 400, "Command is required");
    if (hour < 0 || hour > 23 || minute < 0 || minute > 59) return bad(res, 400, "Invalid time");

    const plistPath = path.join(userLaunchAgentsDir, `${label}.plist`);
    const plist = buildLaunchPlist({ label, command, hour, minute, stdoutPath, stderrPath });
    await fs.mkdir(userLaunchAgentsDir, { recursive: true });
    await fs.writeFile(plistPath, plist, "utf8");
    await execFileAsync("launchctl", ["unload", plistPath]).catch(() => {});
    await execFileAsync("launchctl", ["load", plistPath]);
    ok(res, { source: plistPath });
  } catch (error) {
    bad(res, 500, error.message);
  }
});

app.post("/api/tasks/cron", async (req, res) => {
  try {
    const { schedule, command } = req.body;
    if (!schedule || schedule.trim().split(/\s+/).length !== 5) return bad(res, 400, "Schedule must have 5 cron fields");
    if (!command) return bad(res, 400, "Command is required");
    const current = await getCrontabText();
    const next = `${current.replace(/\s*$/, "")}\n${schedule.trim()} ${command.trim()}\n`;
    await setCrontabText(next);
    ok(res, { schedule, command });
  } catch (error) {
    bad(res, 500, error.message);
  }
});

app.post("/api/tasks/:type/:id/run", async (req, res) => {
  try {
    if (req.params.type === "launchd") {
      const task = await getLaunchTask(req.params.id);
      if (!task) return bad(res, 404, "Task not found");
      await execFileAsync("launchctl", ["start", task.label]);
      return ok(res, { started: task.label });
    }
    const task = await getCronTask(req.params.id);
    if (!task) return bad(res, 404, "Task not found");
    ok(res, startCronTask(task));
  } catch (error) {
    bad(res, 500, error.message);
  }
});

app.post("/api/tasks/:type/:id/enabled", async (req, res) => {
  try {
    if (typeof req.body.enabled !== "boolean") return bad(res, 400, "enabled must be a boolean");
    ok(res, await setTaskEnabled(req.params.type, req.params.id, req.body.enabled));
  } catch (error) {
    bad(res, error.status || 500, error.message);
  }
});

app.patch("/api/tasks/:type/:id/metadata", async (req, res) => {
  try {
    const task = req.params.type === "launchd" ? await getLaunchTask(req.params.id) : await getCronTask(req.params.id);
    if (!task) return bad(res, 404, "Task not found");
    ok(res, await updateTaskMetadata(task, req.body));
  } catch (error) {
    bad(res, 500, error.message);
  }
});

app.delete("/api/tasks/:type/:id", async (req, res) => {
  try {
    ok(res, await deleteTaskByTypeAndId(req.params.type, req.params.id));
  } catch (error) {
    bad(res, error.status || 500, error.message);
  }
});

app.use(express.static(path.join(projectRoot, "dist")));
app.get("*", async (_req, res) => {
  const indexPath = path.join(projectRoot, "dist", "index.html");
  if (await pathExists(indexPath)) return res.sendFile(indexPath);
  res.status(404).send("Run npm run dev for the React app, or npm run build before npm start.");
});

let monitorStarted = false;

export function exposeServerServices() {
  return {
    monitorHistoryService,
    notificationService,
    agentConversationService,
    systemMonitorService,
    systemInfoService,
    networkToolService,
    networkMonitorService,
    aiConfig,
    aiUsage,
    systemTools,
    piRuntime,
    backupService,
    uninstallCleanupService
  };
}

export async function startServer({ port = PORT, host = "127.0.0.1" } = {}) {
  await systemMonitorService.ready();
  return new Promise((resolve, reject) => {
    const server = app.listen(port, host, () => {
      const address = server.address();
      const actualPort = typeof address === "object" && address ? address.port : port;
      const url = `http://${host}:${actualPort}`;
      if (!monitorStarted) {
        monitorStarted = true;
        monitorHistoryService.start();
        networkMonitorService.start();
      }
      console.log(`System task monitor API listening on ${url}`);
      resolve({ server, url });
    });
    server.on("error", reject);
    server.on("close", () => {
      monitorHistoryService.stop();
      networkMonitorService.stop();
    });
  });
}

if (path.resolve(process.argv[1] || "") === currentFile) {
  startServer().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}
