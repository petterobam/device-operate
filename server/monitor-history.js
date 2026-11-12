// Append-only JSONL metric history plus the alert monitor that feeds it.
//
// Samples are stored one JSON object per line so the file stays inspectable and
// trivially appendable; the service trims the file once it exceeds a size cap.

import fs from "node:fs/promises";
import path from "node:path";
import { DEFAULT_ALERT_RULES, describeAlert, evaluateAlerts, metricsFromSnapshot } from "./alert-rules.js";

const DEFAULT_INTERVAL_MS = 30_000;
const DEFAULT_MAX_BYTES = 4 * 1024 * 1024;
const READ_TAIL_BYTES = 1024 * 1024;

async function readLinesTail(filePath, byteLimit) {
  try {
    const stat = await fs.stat(filePath);
    const start = Math.max(0, stat.size - byteLimit);
    const handle = await fs.open(filePath, "r");
    try {
      const buffer = Buffer.alloc(stat.size - start);
      await handle.read(buffer, 0, buffer.length, start);
      const text = buffer.toString("utf8");
      const lines = text.split("\n");
      // Drop the first (probably partial) line unless we read from the start.
      if (start > 0) lines.shift();
      return lines.filter(Boolean);
    } finally {
      await handle.close();
    }
  } catch {
    return [];
  }
}

export function createMonitorHistoryService({
  filePath,
  snapshot,
  volume,
  notifications,
  rules = DEFAULT_ALERT_RULES,
  intervalMs = DEFAULT_INTERVAL_MS,
  maxBytes = DEFAULT_MAX_BYTES,
  now = () => Date.now(),
  logger = console
} = {}) {
  const state = { counters: {}, lastNotifiedAt: {} };
  let timer = null;
  let running = false;
  let lastSampleAt = null;
  let lastError = "";
  let activeAlerts = [];
  let sampleCount = 0;
  let lastSample = null;

  async function append(sample) {
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    await fs.appendFile(filePath, `${JSON.stringify(sample)}\n`, "utf8");
    const stat = await fs.stat(filePath);
    if (stat.size > maxBytes) await trim();
  }

  async function trim() {
    const lines = await readLinesTail(filePath, maxBytes);
    const keep = lines.slice(-Math.floor(1000));
    const tempPath = `${filePath}.tmp`;
    await fs.writeFile(tempPath, keep.length ? `${keep.join("\n")}\n` : "", "utf8");
    await fs.rename(tempPath, filePath);
  }

  async function sampleOnce({ notify = true } = {}) {
    const snapshotData = await snapshot();
    if (volume) {
      // The storage service reads the authoritative macOS volume (including the
      // Data volume), so prefer it over the raw df list.
      snapshotData.volume = await volume().catch(() => null);
    }
    const metrics = metricsFromSnapshot(snapshotData);
    const capturedAt = now();
    const { fired, active } = evaluateAlerts(metrics, state, rules, capturedAt);
    activeAlerts = active;
    const sample = {
      at: new Date(capturedAt).toISOString(),
      cpuPercent: metrics.cpuPercent,
      memoryPercent: metrics.memoryPercent,
      swapUsedMb: metrics.swapUsedMb,
      swapTotalMb: metrics.swapTotalMb,
      swapUsedPercent: Number(metrics.swapUsedPercent.toFixed(1)),
      diskUsedPercent: metrics.diskUsedPercent,
      diskAvailableMb: Number.isFinite(metrics.diskAvailableMb) ? metrics.diskAvailableMb : undefined,
      temperatureC: metrics.temperatureC,
      memoryPressure: metrics.memoryPressure,
      processCount: metrics.processCount,
      alerts: active.map((alert) => alert.ruleId)
    };
    await append(sample);
    lastSample = sample;
    lastSampleAt = sample.at;
    sampleCount += 1;
    lastError = "";

    if (notify) {
      for (const alert of fired) {
        await notifications?.notify({
          title: `我的 macOS · ${alert.severity === "critical" ? "严重告警" : "告警"}`,
          subtitle: alert.label,
          message: describeAlert(alert),
          severity: alert.severity,
          ruleId: alert.ruleId,
          dedupeKey: `${alert.ruleId}:${alert.at}`
        });
      }
    }
    return { sample, fired, active };
  }

  async function tick() {
    if (running) return;
    running = true;
    try {
      await sampleOnce();
    } catch (error) {
      lastError = error.message;
      logger.error?.(`[monitor-history] 采样失败：${error.message}`);
    } finally {
      running = false;
    }
  }

  function start({ immediate = true } = {}) {
    if (timer) return { started: false, intervalMs };
    timer = setInterval(tick, intervalMs);
    timer.unref?.();
    if (immediate) tick();
    return { started: true, intervalMs };
  }

  function stop() {
    if (timer) clearInterval(timer);
    timer = null;
    return { started: false };
  }

  async function history({ limit = 240, since } = {}) {
    const lines = await readLinesTail(filePath, READ_TAIL_BYTES);
    const parsed = [];
    for (const line of lines) {
      try {
        const entry = JSON.parse(line);
        if (since && new Date(entry.at).getTime() < since) continue;
        parsed.push(entry);
      } catch {
        // Skip a partially written line.
      }
    }
    return parsed.slice(-Math.max(1, Math.min(2000, limit)));
  }

  async function summary({ limit = 240 } = {}) {
    const samples = await history({ limit });
    if (!samples.length) {
      return { samples: 0, from: null, to: null, metrics: {}, alerts: [], storageBytes: await fileSize() };
    }
    const pick = (key) => samples.map((sample) => sample[key]).filter((value) => Number.isFinite(value));
    const stats = (key) => {
      const values = pick(key);
      if (!values.length) return null;
      return {
        min: Math.min(...values),
        max: Math.max(...values),
        avg: Number((values.reduce((total, value) => total + value, 0) / values.length).toFixed(1)),
        last: values[values.length - 1]
      };
    };
    const alertCounts = new Map();
    for (const sample of samples) {
      for (const ruleId of sample.alerts || []) alertCounts.set(ruleId, (alertCounts.get(ruleId) || 0) + 1);
    }
    return {
      samples: samples.length,
      from: samples[0].at,
      to: samples[samples.length - 1].at,
      metrics: {
        cpuPercent: stats("cpuPercent"),
        memoryPercent: stats("memoryPercent"),
        swapUsedPercent: stats("swapUsedPercent"),
        diskUsedPercent: stats("diskUsedPercent"),
        temperatureC: stats("temperatureC")
      },
      alerts: [...alertCounts.entries()].map(([ruleId, count]) => ({ ruleId, count })),
      storageBytes: await fileSize()
    };
  }

  async function fileSize() {
    try {
      return (await fs.stat(filePath)).size;
    } catch {
      return 0;
    }
  }

  return {
    start,
    stop,
    sampleOnce,
    history,
    summary,
    rules: () => rules,
    status() {
      return {
        running: Boolean(timer),
        intervalMs,
        lastSampleAt,
        lastSample,
        sampleCount,
        activeAlerts,
        lastError,
        filePath
      };
    }
  };
}

export const monitorHistoryInternals = { readLinesTail, DEFAULT_INTERVAL_MS, DEFAULT_MAX_BYTES };
