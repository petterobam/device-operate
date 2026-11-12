import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { performance } from "node:perf_hooks";
import { promisify } from "node:util";
import { extractApplicationPath } from "./applications.js";

const execFileAsync = promisify(execFile);
const currentDir = path.dirname(fileURLToPath(import.meta.url));
const unpackedPath = (filePath) => filePath.includes("app.asar")
  ? filePath.replace("app.asar", "app.asar.unpacked")
  : filePath;
const processMonitorPath = unpackedPath(path.join(currentDir, "bin", "process-monitor"));
const temperatureMonitorPath = unpackedPath(path.join(currentDir, "bin", "system-temperature"));
const commandOptions = { timeout: 2_000, maxBuffer: 8 * 1024 * 1024 };

function megabytes(bytes) {
  return Number((Math.max(0, bytes) / 1024 / 1024).toFixed(1));
}

function clampPercent(value) {
  return Number(Math.min(100, Math.max(0, Number(value) || 0)).toFixed(1));
}

async function outputOf(command, args = []) {
  try {
    const { stdout } = await execFileAsync(command, args, commandOptions);
    return stdout;
  } catch {
    return "";
  }
}

export function parseNativeProcessList(output) {
  return String(output || "")
    .split("\n")
    .map((line) => {
      const fields = line.split("\t");
      if (fields.length < 11) return null;
      const [pid, parentPid, uid, threads, rssBytes, userTime, systemTime, startedAt, status, processName, ...commandParts] = fields;
      if (!/^\d+$/.test(pid)) return null;
      return {
        pid: Number(pid),
        parentPid: Number(parentPid),
        uid: Number(uid),
        threads: Number(threads),
        rssBytes: Number(rssBytes),
        cpuTimeNs: BigInt(userTime || 0) + BigInt(systemTime || 0),
        startedAtSeconds: Number(startedAt),
        status: Number(status),
        processName: processName || path.basename(commandParts.join("\t")),
        command: commandParts.join("\t")
      };
    })
    .filter(Boolean);
}

export function parseVmStat(output) {
  const text = String(output || "");
  const pageSize = Number(text.match(/page size of\s+(\d+)\s+bytes/i)?.[1] || 4096);
  const pages = {};
  for (const line of text.split("\n")) {
    const match = line.match(/^([^:]+):\s+(\d+)\.?/);
    if (match) pages[match[1].trim()] = Number(match[2]);
  }
  return { pageSize, pages };
}

export function parseMemoryPressure(output) {
  const match = String(output || "").match(/memory free percentage:\s*(\d+)%/i);
  return match ? Number(match[1]) : null;
}

function sizeToBytes(value, unit) {
  const multipliers = { K: 1024, M: 1024 ** 2, G: 1024 ** 3, T: 1024 ** 4 };
  return Number(value) * (multipliers[String(unit || "M").toUpperCase()] || 1);
}

export function parseSwapUsage(output) {
  const text = String(output || "");
  const total = text.match(/total\s*=\s*([\d.]+)([KMGT])/i);
  const used = text.match(/used\s*=\s*([\d.]+)([KMGT])/i);
  const free = text.match(/free\s*=\s*([\d.]+)([KMGT])/i);
  return {
    totalBytes: total ? sizeToBytes(total[1], total[2]) : 0,
    usedBytes: used ? sizeToBytes(used[1], used[2]) : 0,
    freeBytes: free ? sizeToBytes(free[1], free[2]) : 0,
    encrypted: /\(encrypted\)/i.test(text)
  };
}

export function buildMemoryMetrics({ totalBytes, vmStat, freePercent, swap }) {
  const bytesFor = (key) => (vmStat.pages[key] || 0) * vmStat.pageSize;
  const freeBytes = bytesFor("Pages free");
  const reclaimableBytes = bytesFor("Pages inactive") + bytesFor("Pages speculative") + bytesFor("Pages purgeable");
  const fallbackAvailable = Math.min(totalBytes, freeBytes + reclaimableBytes);
  const availableBytes = freePercent === null
    ? fallbackAvailable
    : Math.min(totalBytes, Math.max(0, totalBytes * freePercent / 100));
  const usedBytes = Math.max(0, totalBytes - availableBytes);
  const availablePercent = totalBytes ? availableBytes / totalBytes * 100 : 0;
  return {
    memoryPercent: clampPercent(100 - availablePercent),
    memoryUsedMb: megabytes(usedBytes),
    memoryAvailableMb: megabytes(availableBytes),
    memoryTotalMb: megabytes(totalBytes),
    memoryFreeMb: megabytes(freeBytes),
    memoryCachedMb: megabytes(reclaimableBytes),
    memoryWiredMb: megabytes(bytesFor("Pages wired down")),
    memoryCompressedMb: megabytes(bytesFor("Pages occupied by compressor")),
    memoryPressure: availablePercent < 10 ? "critical" : availablePercent < 20 ? "warning" : "normal",
    swapUsedMb: megabytes(swap.usedBytes),
    swapTotalMb: megabytes(swap.totalBytes),
    swapEncrypted: swap.encrypted
  };
}

export function parseDf(output) {
  return String(output || "")
    .split("\n")
    .slice(1)
    .map((line) => line.match(/^(\S+)\s+(\d+)\s+(\d+)\s+(\d+)\s+(\d+)%\s+(.+)$/))
    .filter(Boolean)
    .map((match) => ({
      filesystem: match[1],
      totalBytes: Number(match[2]) * 1024,
      usedBytes: Number(match[3]) * 1024,
      availableBytes: Number(match[4]) * 1024,
      usedPercent: Number(match[5]),
      mount: match[6]
    }))
    .filter(({ filesystem, totalBytes }) => filesystem !== "devfs" && totalBytes > 0)
    .sort((first, second) => {
      const rank = (item) => item.mount === "/" ? 0 : item.mount.endsWith("/Data") ? 1 : 2;
      return rank(first) - rank(second) || second.usedBytes - first.usedBytes;
    });
}

export function parseIostatTotalMb(output) {
  const lines = String(output || "").trim().split("\n").filter(Boolean);
  const disks = lines[0]?.match(/disk\d+/g) || [];
  const values = (lines.at(-1)?.trim().split(/\s+/) || []).map(Number);
  if (!disks.length || values.length < disks.length * 3) return 0;
  return disks.reduce((total, _disk, index) => total + (Number(values[index * 3 + 2]) || 0), 0);
}

export function parseNetworkCounters(output) {
  const interfaces = [];
  for (const line of String(output || "").split("\n")) {
    if (!line.includes("<Link#")) continue;
    const fields = line.trim().split(/\s+/);
    if (fields.length < 9) continue;
    const offset = /^\d+$/.test(fields[3]) ? 3 : 4;
    if (fields.length < offset + 6) continue;
    interfaces.push({
      name: fields[0],
      receivedBytes: Number(fields[offset + 2]) || 0,
      sentBytes: Number(fields[offset + 5]) || 0
    });
  }
  return interfaces;
}

export function parseUserDirectory(output) {
  const users = new Map([[0, "root"]]);
  for (const line of String(output || "").split("\n")) {
    const match = line.match(/^(.+?)\s+(\d+)$/);
    if (match) users.set(Number(match[2]), match[1].trim());
  }
  return users;
}

function elapsedLabel(startedAtSeconds, nowSeconds) {
  const seconds = Math.max(0, Math.floor(nowSeconds - startedAtSeconds));
  const days = Math.floor(seconds / 86400);
  const hours = Math.floor((seconds % 86400) / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const remainder = seconds % 60;
  if (days) return `${days}-${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}:${String(remainder).padStart(2, "0")}`;
  if (hours) return `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}:${String(remainder).padStart(2, "0")}`;
  return `${String(minutes).padStart(2, "0")}:${String(remainder).padStart(2, "0")}`;
}

function processState(status) {
  return ({ 1: "idle", 2: "running", 3: "sleeping", 4: "stopped", 5: "zombie" })[status] || "unknown";
}

function applicationForCommand(command) {
  const applicationPath = extractApplicationPath(command);
  return {
    applicationPath,
    applicationName: applicationPath ? path.basename(applicationPath, ".app") : "系统进程"
  };
}

function cpuTimesSnapshot() {
  return os.cpus().map(({ model, speed, times }) => ({ model, speed, times: { ...times } }));
}

function cpuUsage(previous, current) {
  const perCore = current.map((core, index) => {
    const before = previous[index]?.times || core.times;
    const totalBefore = Object.values(before).reduce((sum, value) => sum + value, 0);
    const totalNow = Object.values(core.times).reduce((sum, value) => sum + value, 0);
    const totalDelta = Math.max(1, totalNow - totalBefore);
    const idleDelta = Math.max(0, core.times.idle - before.idle);
    return {
      id: index,
      percent: clampPercent((totalDelta - idleDelta) / totalDelta * 100),
      speedMhz: core.speed
    };
  });
  return {
    total: perCore.length ? Number((perCore.reduce((sum, core) => sum + core.percent, 0) / perCore.length).toFixed(1)) : 0,
    perCore
  };
}

export function createSystemMonitorService() {
  let previousCpu = cpuTimesSnapshot();
  let previousDisk = { at: Date.now(), totalMb: 0 };
  let previousNetwork = { at: Date.now(), counters: new Map() };
  let previousProcesses = { at: Date.now(), items: new Map() };
  let lastProcessSummary = { processCount: 0, threadCount: 0 };
  let processQueue = Promise.resolve();
  const usersPromise = outputOf("dscl", [".", "-list", "/Users", "UniqueID"])
    .then(parseUserDirectory)
    .then((users) => {
      if (process.getuid && !users.has(process.getuid())) users.set(process.getuid(), os.userInfo().username);
      return users;
    });
  const primeProcesses = outputOf(processMonitorPath).then((output) => {
    const items = parseNativeProcessList(output);
    previousProcesses = { at: Date.now(), items: new Map(items.map((item) => [item.pid, item])) };
  });
  const primeTemperature = outputOf(temperatureMonitorPath);

  async function collectProcesses() {
    const execute = async () => {
      await primeProcesses;
      const [output, users] = await Promise.all([outputOf(processMonitorPath), usersPromise]);
      const sampledAt = Date.now();
      const nowSeconds = sampledAt / 1000;
      const raw = parseNativeProcessList(output);
      const elapsedNs = Math.max(1, sampledAt - previousProcesses.at) * 1_000_000;
      const totalMemory = os.totalmem();
      const rows = raw.map((item) => {
        const before = previousProcesses.items.get(item.pid);
        const sameProcess = before?.startedAtSeconds === item.startedAtSeconds;
        const cpuDelta = sameProcess && item.cpuTimeNs >= before.cpuTimeNs ? item.cpuTimeNs - before.cpuTimeNs : 0n;
        const cpu = Number(cpuDelta) / elapsedNs * 100;
        const application = applicationForCommand(item.command);
        return {
          pid: item.pid,
          parentPid: item.parentPid,
          processName: item.processName || path.basename(item.command),
          command: item.command,
          user: users.get(item.uid) || String(item.uid),
          uid: item.uid,
          threads: item.threads,
          state: processState(item.status),
          elapsed: elapsedLabel(item.startedAtSeconds, nowSeconds),
          elapsedSeconds: Math.max(0, Math.floor(nowSeconds - item.startedAtSeconds)),
          cpu: Number(Math.max(0, cpu).toFixed(1)),
          memoryPercent: Number((item.rssBytes / totalMemory * 100).toFixed(1)),
          memoryMb: megabytes(item.rssBytes),
          canTerminate: item.pid !== process.pid,
          ...application
        };
      }).sort((first, second) => second.memoryMb - first.memoryMb || second.cpu - first.cpu || first.pid - second.pid);
      previousProcesses = { at: sampledAt, items: new Map(raw.map((item) => [item.pid, item])) };
      lastProcessSummary = {
        processCount: rows.length,
        threadCount: rows.reduce((total, item) => total + item.threads, 0)
      };
      return rows;
    };
    const result = processQueue.then(execute, execute);
    processQueue = result.then(() => undefined, () => undefined);
    return result;
  }

  async function collectOverview() {
    const startedAt = performance.now();
    const [vmOutput, pressureOutput, swapOutput, diskOutput, networkOutput, iostatOutput, temperatureOutput] = await Promise.all([
      outputOf("vm_stat"),
      outputOf("memory_pressure", ["-Q"]),
      outputOf("sysctl", ["-n", "vm.swapusage"]),
      outputOf("df", ["-kP"]),
      outputOf("netstat", ["-ibn"]),
      outputOf("iostat", ["-Id", "-c", "1"]),
      outputOf(temperatureMonitorPath)
    ]);
    const sampledAt = Date.now();
    const currentCpu = cpuTimesSnapshot();
    const cpu = cpuUsage(previousCpu, currentCpu);
    previousCpu = currentCpu;

    const memory = buildMemoryMetrics({
      totalBytes: os.totalmem(),
      vmStat: parseVmStat(vmOutput),
      freePercent: parseMemoryPressure(pressureOutput),
      swap: parseSwapUsage(swapOutput)
    });

    const diskTotalMb = parseIostatTotalMb(iostatOutput);
    const diskElapsed = Math.max(1, sampledAt - previousDisk.at) / 1000;
    const diskIoBytesPerSecond = previousDisk.totalMb && diskTotalMb >= previousDisk.totalMb
      ? (diskTotalMb - previousDisk.totalMb) * 1024 * 1024 / diskElapsed
      : 0;
    previousDisk = { at: sampledAt, totalMb: diskTotalMb };

    const counters = parseNetworkCounters(networkOutput);
    const networkElapsed = Math.max(1, sampledAt - previousNetwork.at) / 1000;
    const networkInterfaces = counters.map((counter) => {
      const before = previousNetwork.counters.get(counter.name);
      return {
        ...counter,
        downloadBytesPerSecond: before && counter.receivedBytes >= before.receivedBytes
          ? (counter.receivedBytes - before.receivedBytes) / networkElapsed
          : 0,
        uploadBytesPerSecond: before && counter.sentBytes >= before.sentBytes
          ? (counter.sentBytes - before.sentBytes) / networkElapsed
          : 0
      };
    }).sort((first, second) => {
      const active = (item) => item.name === "lo0" || item.name.endsWith("*") ? 0 : item.receivedBytes + item.sentBytes;
      return active(second) - active(first) || first.name.localeCompare(second.name);
    });
    previousNetwork = { at: sampledAt, counters: new Map(counters.map((item) => [item.name, item])) };
    const activeInterface = networkInterfaces.find((item) => item.name !== "lo0" && !item.name.endsWith("*"))?.name
      || networkInterfaces[0]?.name
      || "";

    return {
      metrics: {
        cpuPercent: cpu.total,
        cpuCores: cpu.perCore,
        cpuModel: currentCpu[0]?.model || "",
        logicalCpuCount: currentCpu.length,
        temperatureC: Number.isFinite(Number.parseFloat(temperatureOutput)) ? Number.parseFloat(temperatureOutput) : null,
        loadAverage: os.loadavg().map((value) => Number(value.toFixed(2))),
        uptimeSeconds: Math.floor(os.uptime()),
        ...memory,
        ...lastProcessSummary,
        generatedAt: new Date(sampledAt).toISOString(),
        sampleDurationMs: Number((performance.now() - startedAt).toFixed(1))
      },
      disks: parseDf(diskOutput),
      diskIoBytesPerSecond: Math.max(0, diskIoBytesPerSecond),
      network: { activeInterface, interfaces: networkInterfaces }
    };
  }

  async function snapshot({ includeProcesses = true } = {}) {
    if (!includeProcesses) return collectOverview();
    const [overview, processes] = await Promise.all([collectOverview(), collectProcesses()]);
    overview.metrics.processCount = processes.length;
    overview.metrics.threadCount = processes.reduce((total, item) => total + item.threads, 0);
    return { ...overview, processes };
  }

  return {
    snapshot,
    ready: () => Promise.all([primeProcesses, usersPromise, primeTemperature]).then(() => undefined)
  };
}
