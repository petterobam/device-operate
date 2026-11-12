import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import {
  buildApplicationAnalysis,
  collectCrashMetrics,
  collectSpotlightMetrics,
  collectUsageMetrics
} from "./application-analysis.js";

const execFileAsync = promisify(execFile);
const CACHE_TTL_MS = 15_000;
const ANALYSIS_CACHE_TTL_MS = 5 * 60_000;
const ICON_COMMAND_TIMEOUT_MS = 3_000;

const PERMISSION_USAGE_KEYS = {
  NSAppleEventsUsageDescription: "kTCCServiceAppleEvents",
  NSBluetoothAlwaysUsageDescription: "kTCCServiceBluetoothAlways",
  NSBluetoothPeripheralUsageDescription: "kTCCServiceBluetoothAlways",
  NSCalendarsUsageDescription: "kTCCServiceCalendar",
  NSCalendarsFullAccessUsageDescription: "kTCCServiceCalendar",
  NSCalendarsWriteOnlyAccessUsageDescription: "kTCCServiceCalendar",
  NSCameraUsageDescription: "kTCCServiceCamera",
  NSContactsUsageDescription: "kTCCServiceAddressBook",
  NSLocalNetworkUsageDescription: "kTCCServiceLocalNetwork",
  NSLocationUsageDescription: "kTCCServiceLocation",
  NSLocationAlwaysAndWhenInUseUsageDescription: "kTCCServiceLocation",
  NSLocationWhenInUseUsageDescription: "kTCCServiceLocation",
  NSMicrophoneUsageDescription: "kTCCServiceMicrophone",
  NSMotionUsageDescription: "kTCCServiceMotion",
  NSPhotoLibraryUsageDescription: "kTCCServicePhotos",
  NSPhotoLibraryAddUsageDescription: "kTCCServicePhotosAdd",
  NSRemindersUsageDescription: "kTCCServiceReminders",
  NSRemindersFullAccessUsageDescription: "kTCCServiceReminders",
  NSSensitiveContentAnalysisUsageDescription: "kTCCServiceSensitiveContentAnalysis",
  NSSpeechRecognitionUsageDescription: "kTCCServiceSpeechRecognition"
};

export function inferDeclaredPermissions(plist = {}) {
  return [...new Set(
    Object.entries(PERMISSION_USAGE_KEYS)
      .filter(([key]) => typeof plist[key] === "string" && plist[key].trim())
      .map(([, service]) => service)
  )].sort();
}

export function runIconCommand(command, args, { timeoutMs = ICON_COMMAND_TIMEOUT_MS } = {}) {
  return execFileAsync(command, args, {
    timeout: timeoutMs,
    killSignal: "SIGKILL",
    maxBuffer: 2 * 1024 * 1024
  });
}

export function encodeApplicationId(appPath) {
  return Buffer.from(appPath).toString("base64url");
}

export function decodeApplicationId(id) {
  return Buffer.from(id, "base64url").toString("utf8");
}

export function isPathWithinRoot(candidate, root) {
  const relative = path.relative(path.resolve(root), path.resolve(candidate));
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

export function extractApplicationPath(command) {
  const match = String(command || "").match(/^(.+?\.app)\/Contents\//);
  return match ? path.normalize(match[1]) : "";
}

export function parseProcessList(output) {
  return String(output || "")
    .split("\n")
    .map((line) => {
      const match = line.match(/^\s*(\d+)\s+(\d+)\s+([\d.]+)\s+([\d.]+)\s+(\S+)\s+(.+?)\s*$/);
      if (!match) return null;
      const appPath = extractApplicationPath(match[6]);
      if (!appPath) return null;
      return {
        pid: Number(match[1]),
        parentPid: Number(match[2]),
        cpu: Number(match[3]),
        memory: Number(match[4]),
        elapsed: match[5],
        command: match[6],
        appPath
      };
    })
    .filter(Boolean);
}

export function parseSystemProcessList(output) {
  return String(output || "")
    .split("\n")
    .map((line) => {
      const match = line.match(/^\s*(\d+)\s+(\d+)\s+([\d.]+)\s+([\d.]+)\s+(\d+)\s+(\S+)\s+(.+?)\s*$/);
      if (!match) return null;
      const command = match[7];
      const appPath = extractApplicationPath(command);
      return {
        pid: Number(match[1]),
        parentPid: Number(match[2]),
        cpu: Number(match[3]),
        memory: Number(match[4]),
        rssKb: Number(match[5]),
        elapsed: match[6],
        command,
        processName: path.basename(command),
        appPath
      };
    })
    .filter(Boolean);
}

export function normalizeProcessPids(pids, { max = 256 } = {}) {
  if (!Array.isArray(pids) || pids.length === 0) {
    throw Object.assign(new Error("至少选择一个进程"), { status: 400 });
  }
  if (pids.length > max) {
    throw Object.assign(new Error(`一次最多选择 ${max} 个进程`), { status: 400 });
  }
  const normalized = [...new Set(pids.map((pid) => Number(pid)))];
  if (normalized.some((pid) => !Number.isInteger(pid) || pid <= 0)) {
    throw Object.assign(new Error("包含无效的进程 PID"), { status: 400 });
  }
  return normalized;
}

async function exists(filePath) {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function mapWithConcurrency(items, concurrency, mapper) {
  const results = new Array(items.length);
  let cursor = 0;
  async function worker() {
    while (cursor < items.length) {
      const index = cursor;
      cursor += 1;
      results[index] = await mapper(items[index], index);
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, () => worker()));
  return results;
}

async function scanApplicationBundles(root, maxDepth = 5) {
  const found = [];
  async function visit(directory, depth) {
    let entries;
    try {
      entries = await fs.readdir(directory, { withFileTypes: true });
    } catch {
      return;
    }
    await Promise.all(
      entries.map(async (entry) => {
        if (!entry.isDirectory() || entry.name.startsWith(".")) return;
        const entryPath = path.join(directory, entry.name);
        if (entry.name.toLowerCase().endsWith(".app")) {
          found.push(entryPath);
          return;
        }
        if (depth < maxDepth) await visit(entryPath, depth + 1);
      })
    );
  }
  if (await exists(root)) await visit(root, 0);
  return found;
}

async function readPlist(appPath) {
  const plistPath = path.join(appPath, "Contents", "Info.plist");
  try {
    const { stdout } = await execFileAsync("plutil", ["-convert", "json", "-o", "-", plistPath], {
      maxBuffer: 2 * 1024 * 1024
    });
    return JSON.parse(stdout);
  } catch {
    return {};
  }
}

function appLocation(appPath, roots) {
  const matched = roots.find(({ root }) => isPathWithinRoot(appPath, root));
  return matched || { root: path.dirname(appPath), label: "其他位置", removable: false, system: false };
}

async function appMetadata(appPath, roots) {
  const [plist, stat] = await Promise.all([readPlist(appPath), fs.stat(appPath).catch(() => null)]);
  const fallbackName = path.basename(appPath, ".app");
  const location = appLocation(appPath, roots);
  const name = fallbackName || plist.CFBundleDisplayName || plist.CFBundleName;
  return {
    id: encodeApplicationId(appPath),
    name,
    bundleId: plist.CFBundleIdentifier || "",
    version: plist.CFBundleShortVersionString || plist.CFBundleVersion || "",
    categoryType: plist.LSApplicationCategoryType || "",
    path: appPath,
    location: location.label,
    removable: Boolean(location.removable),
    system: Boolean(location.system),
    declaredPermissions: inferDeclaredPermissions(plist),
    modifiedAt: stat?.mtime?.toISOString() || "",
    iconUrl: `/api/apps/${encodeApplicationId(appPath)}/icon`
  };
}

async function getProcesses() {
  const { stdout } = await execFileAsync("ps", ["-axo", "pid=,ppid=,%cpu=,%mem=,etime=,comm="], {
    maxBuffer: 4 * 1024 * 1024
  });
  return parseProcessList(stdout);
}

async function getSystemProcesses() {
  const { stdout } = await execFileAsync("ps", ["-axo", "pid=,ppid=,%cpu=,%mem=,rss=,etime=,comm="], {
    maxBuffer: 8 * 1024 * 1024
  });
  return parseSystemProcessList(stdout);
}

function aggregateProcesses(processes) {
  const byPath = new Map();
  for (const processInfo of processes) {
    const current = byPath.get(processInfo.appPath) || {
      pids: [],
      processCount: 0,
      cpu: 0,
      memory: 0,
      elapsed: processInfo.elapsed
    };
    current.pids.push(processInfo.pid);
    current.processCount += 1;
    current.cpu += processInfo.cpu;
    current.memory += processInfo.memory;
    if (processInfo.parentPid === 1 || processInfo.appPath === processInfo.command.replace(/\/Contents\/MacOS\/.*$/, "")) {
      current.elapsed = processInfo.elapsed;
    }
    byPath.set(processInfo.appPath, current);
  }
  return byPath;
}

function withRunningState(application, running) {
  const current = extractApplicationPath(process.execPath) === application.path;
  if (!running) return { ...application, current, running: false, processes: null };
  return {
    ...application,
    current,
    running: true,
    processes: {
      ...running,
      cpu: Number(running.cpu.toFixed(1)),
      memory: Number(running.memory.toFixed(1)),
      pids: running.pids.sort((a, b) => a - b)
    }
  };
}

export function createApplicationService({ cacheDir = path.join(os.tmpdir(), "device-operate-app-icons") } = {}) {
  const roots = [
    { root: path.join(os.homedir(), "Applications"), label: "个人应用", removable: true, system: false },
    { root: "/Applications", label: "应用程序", removable: true, system: false },
    { root: "/System/Applications", label: "系统应用", removable: false, system: true },
    { root: "/System/Library/CoreServices/Applications", label: "系统工具", removable: false, system: true }
  ];
  let cache = { expiresAt: 0, applications: [] };
  let analysisCache = { expiresAt: 0, applicationIds: "", metrics: null };

  async function discoverApplications({ fresh = false } = {}) {
    if (!fresh && cache.expiresAt > Date.now()) return cache.applications;
    const discovered = (await Promise.all(roots.map(({ root }) => scanApplicationBundles(root)))).flat();
    const uniquePaths = [...new Set(discovered.map((appPath) => path.normalize(appPath)))];
    const applications = (await mapWithConcurrency(uniquePaths, 8, (appPath) => appMetadata(appPath, roots)))
      .filter(Boolean)
      .sort((a, b) => a.name.localeCompare(b.name, "zh-CN"));
    cache = { expiresAt: Date.now() + CACHE_TTL_MS, applications };
    return applications;
  }

  async function listApplications({ fresh = false } = {}) {
    const [installed, processes] = await Promise.all([discoverApplications({ fresh }), getProcesses()]);
    const runningByPath = aggregateProcesses(processes);
    const applications = installed
      .map((application) => withRunningState(application, runningByPath.get(application.path)))
      .sort((a, b) => Number(b.running) - Number(a.running) || a.name.localeCompare(b.name, "zh-CN"));
    return {
      applications,
      summary: {
        total: applications.length,
        running: applications.filter(({ running }) => running).length,
        removable: applications.filter(({ removable }) => removable).length
      }
    };
  }

  async function listInstalledApplications({ fresh = false } = {}) {
    return discoverApplications({ fresh });
  }

  async function listProcesses() {
    const [processes, applications] = await Promise.all([getSystemProcesses(), discoverApplications()]);
    const applicationByPath = new Map(applications.map((application) => [application.path, application]));
    const cpuTotal = processes.reduce((total, processInfo) => total + processInfo.cpu, 0);
    const memoryTotal = os.totalmem();
    const memoryFree = os.freemem();
    const cpuCount = Math.max(1, os.cpus().length);
    const rows = processes
      .map((processInfo) => {
        const application = processInfo.appPath ? applicationByPath.get(processInfo.appPath) : null;
        return {
          pid: processInfo.pid,
          parentPid: processInfo.parentPid,
          processName: processInfo.processName,
          command: processInfo.command,
          elapsed: processInfo.elapsed,
          cpu: Number(processInfo.cpu.toFixed(1)),
          memoryPercent: Number(processInfo.memory.toFixed(1)),
          memoryMb: Number((processInfo.rssKb / 1024).toFixed(1)),
          applicationName: application?.name || (processInfo.appPath ? path.basename(processInfo.appPath, ".app") : "系统进程"),
          applicationPath: processInfo.appPath,
          applicationId: application?.id || "",
          applicationIconUrl: application?.iconUrl || ""
        };
      })
      .sort((a, b) => b.memoryMb - a.memoryMb || b.cpu - a.cpu || a.processName.localeCompare(b.processName, "zh-CN"));

    return {
      processes: rows,
      metrics: {
        cpuPercent: Number(Math.min(100, cpuTotal / cpuCount).toFixed(1)),
        memoryPercent: Number(((1 - memoryFree / memoryTotal) * 100).toFixed(1)),
        memoryUsedMb: Number(((memoryTotal - memoryFree) / 1024 / 1024).toFixed(0)),
        memoryTotalMb: Number((memoryTotal / 1024 / 1024).toFixed(0)),
        processCount: rows.length,
        generatedAt: new Date().toISOString()
      }
    };
  }

  async function terminateProcess(pid) {
    const numericPid = Number(pid);
    if (!Number.isInteger(numericPid) || numericPid <= 0) {
      throw Object.assign(new Error("无效的进程 PID"), { status: 400 });
    }
    if (numericPid === process.pid) {
      throw Object.assign(new Error("不能从当前应用中强行终止自身"), { status: 409 });
    }
    const processes = await getSystemProcesses();
    if (!processes.some((processInfo) => processInfo.pid === numericPid)) {
      throw Object.assign(new Error("进程已结束或不存在"), { status: 404 });
    }
    try {
      process.kill(numericPid, "SIGKILL");
    } catch (error) {
      if (error.code === "ESRCH") return { terminated: false, pid: numericPid };
      throw error;
    }
    return { terminated: true, pid: numericPid };
  }

  async function terminateProcesses(pids) {
    const requested = normalizeProcessPids(pids);
    const processes = await getSystemProcesses();
    const available = new Set(processes.map((processInfo) => processInfo.pid));
    const terminated = [];
    const skipped = [];
    const failed = [];

    for (const pid of requested) {
      if (pid === process.pid) {
        skipped.push({ pid, reason: "不能从当前应用中强行终止自身" });
        continue;
      }
      if (!available.has(pid)) {
        failed.push({ pid, reason: "进程已结束或不存在" });
        continue;
      }
      try {
        process.kill(pid, "SIGKILL");
        terminated.push(pid);
      } catch (error) {
        if (error.code === "ESRCH") failed.push({ pid, reason: "进程已结束或不存在" });
        else failed.push({ pid, reason: error.message || "终止进程失败" });
      }
    }

    return {
      requested,
      terminated,
      skipped,
      failed,
      summary: {
        requested: requested.length,
        terminated: terminated.length,
        skipped: skipped.length,
        failed: failed.length
      }
    };
  }

  async function analyzeApplications({ fresh = false } = {}) {
    const { applications } = await listApplications({ fresh });
    const applicationIds = applications.map(({ id }) => id).sort().join("|");
    const cacheValid = !fresh
      && analysisCache.expiresAt > Date.now()
      && analysisCache.applicationIds === applicationIds
      && analysisCache.metrics;
    if (!cacheValid) {
      const [spotlight, crashes, usage] = await Promise.all([
        collectSpotlightMetrics(applications),
        collectCrashMetrics(applications),
        collectUsageMetrics(applications)
      ]);
      analysisCache = {
        expiresAt: Date.now() + ANALYSIS_CACHE_TTL_MS,
        applicationIds,
        metrics: { spotlight, crashes, usage }
      };
    }
    return buildApplicationAnalysis(applications, analysisCache.metrics);
  }

  async function openFullDiskAccessSettings() {
    await execFileAsync("open", ["x-apple.systempreferences:com.apple.preference.security?Privacy_AllFiles"]);
    return { opened: true };
  }

  async function getApplication(id) {
    let requestedPath;
    try {
      requestedPath = path.normalize(decodeApplicationId(id));
    } catch {
      return null;
    }
    if (!path.isAbsolute(requestedPath) || !requestedPath.toLowerCase().endsWith(".app")) return null;
    const applications = await discoverApplications();
    return applications.find(({ path: appPath }) => appPath === requestedPath) || null;
  }

  async function openApplication(id) {
    const application = await getApplication(id);
    if (!application) throw Object.assign(new Error("应用不存在"), { status: 404 });
    await execFileAsync("open", [application.path]);
    return { opened: application.path };
  }

  async function stopApplication(id) {
    const application = await getApplication(id);
    if (!application) throw Object.assign(new Error("应用不存在"), { status: 404 });
    const currentProcesses = (await getProcesses()).filter(({ appPath }) => appPath === application.path);
    if (!currentProcesses.length) return { stopped: false, pids: [] };
    if (currentProcesses.some(({ pid }) => pid === process.pid)) {
      throw Object.assign(new Error("不能从当前应用中强制停止自身"), { status: 409 });
    }
    const pids = [...new Set(currentProcesses.map(({ pid }) => pid))].sort((a, b) => b - a);
    for (const pid of pids) {
      try {
        process.kill(pid, "SIGKILL");
      } catch (error) {
        if (error.code !== "ESRCH") throw error;
      }
    }
    return { stopped: true, pids };
  }

  async function restartApplication(id) {
    const application = await getApplication(id);
    if (!application) throw Object.assign(new Error("应用不存在"), { status: 404 });
    await stopApplication(id);
    await new Promise((resolve) => setTimeout(resolve, 350));
    await execFileAsync("open", [application.path]);
    return { restarted: application.path };
  }

  async function uninstallApplication(id) {
    const application = await getApplication(id);
    if (!application) throw Object.assign(new Error("应用不存在"), { status: 404 });
    if (!application.removable || application.system) {
      throw Object.assign(new Error("系统应用不能在这里卸载"), { status: 403 });
    }
    await stopApplication(id);
    const script = [
      "on run argv",
      'tell application "Finder" to delete POSIX file (item 1 of argv)',
      "end run"
    ];
    const args = script.flatMap((line) => ["-e", line]);
    await execFileAsync("osascript", [...args, application.path]);
    cache.expiresAt = 0;
    analysisCache.expiresAt = 0;
    return { trashed: application.path };
  }

  async function getApplicationIcon(id) {
    const application = await getApplication(id);
    if (!application) return null;
    await fs.mkdir(cacheDir, { recursive: true });
    const outputPath = path.join(cacheDir, `${id}.png`);
    if (await exists(outputPath)) return outputPath;

    const plist = await readPlist(application.path);
    const resourceDir = path.join(application.path, "Contents", "Resources");
    const iconName = plist.CFBundleIconFile || "";
    const candidates = [iconName, iconName && !iconName.endsWith(".icns") ? `${iconName}.icns` : ""].filter(Boolean);
    let iconPath = "";
    for (const candidate of candidates) {
      const candidatePath = path.join(resourceDir, candidate);
      if (await exists(candidatePath)) {
        iconPath = candidatePath;
        break;
      }
    }
    if (!iconPath) {
      const entries = await fs.readdir(resourceDir).catch(() => []);
      const fallback = entries.find((name) => name.toLowerCase().endsWith(".icns"));
      if (fallback) iconPath = path.join(resourceDir, fallback);
    }

    if (iconPath) {
      await runIconCommand("sips", ["-s", "format", "png", iconPath, "--out", outputPath]).catch(() => {});
    } else {
      const thumbnailDir = await fs.mkdtemp(path.join(cacheDir, "quicklook-"));
      try {
        await runIconCommand("qlmanage", ["-t", "-s", "128", "-o", thumbnailDir, application.path]).catch(() => {});
        const thumbnails = await fs.readdir(thumbnailDir).catch(() => []);
        const thumbnail = thumbnails.find((name) => name.endsWith(".png"));
        if (thumbnail) await fs.rename(path.join(thumbnailDir, thumbnail), outputPath);
      } finally {
        await fs.rm(thumbnailDir, { recursive: true, force: true });
      }
    }
    return (await exists(outputPath)) ? outputPath : null;
  }

  return {
    listApplications,
    listProcesses,
    terminateProcess,
    terminateProcesses,
    analyzeApplications,
    listInstalledApplications,
    openFullDiskAccessSettings,
    openApplication,
    stopApplication,
    restartApplication,
    uninstallApplication,
    getApplicationIcon
  };
}
