// Threshold evaluation for system metrics. Pure functions so the rules can be
// unit tested and reused by the page, the tray, and the notifier.

export const DEFAULT_ALERT_RULES = Object.freeze([
  {
    id: "cpu-sustained",
    label: "CPU 持续高负载",
    metric: "cpuPercent",
    comparator: "gte",
    threshold: 85,
    consecutive: 3,
    cooldownMs: 10 * 60_000,
    severity: "warning",
    advice: "定位占用最高的进程，必要时结束它，或确认是否存在死循环/编译任务。"
  },
  {
    id: "memory-pressure",
    label: "内存使用偏高",
    metric: "memoryPercent",
    comparator: "gte",
    threshold: 90,
    consecutive: 3,
    cooldownMs: 10 * 60_000,
    severity: "warning",
    advice: "检查内存占用最高的应用；如果 Swap 同时增长，建议释放或重启高占用应用。"
  },
  {
    id: "swap-pressure",
    label: "Swap 使用过高",
    metric: "swapUsedPercent",
    comparator: "gte",
    threshold: 85,
    consecutive: 2,
    cooldownMs: 15 * 60_000,
    severity: "critical",
    advice: "系统正在大量使用交换空间，性能会明显下降；优先关闭高内存应用并考虑重启。"
  },
  {
    id: "disk-space",
    label: "磁盘空间不足",
    metric: "diskUsedPercent",
    comparator: "gte",
    threshold: 90,
    consecutive: 1,
    cooldownMs: 60 * 60_000,
    severity: "critical",
    advice: "在存储空间页面清理缓存、废纸篓与大文件，建议至少保留 10% 可用空间。"
  },
  {
    id: "temperature",
    label: "CPU 温度偏高",
    metric: "temperatureC",
    comparator: "gte",
    threshold: 95,
    consecutive: 2,
    cooldownMs: 15 * 60_000,
    severity: "warning",
    advice: "确认散热环境与高负载进程；持续高温会触发降频。"
  }
]);

function compare(value, comparator, threshold) {
  if (!Number.isFinite(value)) return false;
  if (comparator === "gte") return value >= threshold;
  if (comparator === "gt") return value > threshold;
  if (comparator === "lte") return value <= threshold;
  if (comparator === "lt") return value < threshold;
  return false;
}

// On macOS "/" is the read-only system snapshot; real user data lives on the
// Data volume, so that is the volume worth alerting about.
const PRIMARY_DISK_MOUNTS = ["/System/Volumes/Data", "/"];

export function pickPrimaryDisk(disks = []) {
  for (const mount of PRIMARY_DISK_MOUNTS) {
    const disk = disks.find((entry) => entry.mount === mount);
    if (disk) return disk;
  }
  return disks[0] || {};
}

function percentOf(usedBytes, totalBytes) {
  if (!Number.isFinite(usedBytes) || !Number.isFinite(totalBytes) || totalBytes <= 0) return null;
  return Number(((usedBytes / totalBytes) * 100).toFixed(1));
}

/** Flattens one system monitor snapshot into the numeric metrics rules can read. */
export function metricsFromSnapshot(snapshot = {}) {
  const metrics = snapshot.metrics || {};
  const disks = snapshot.disks || [];
  const primaryDisk = pickPrimaryDisk(disks);
  const volume = snapshot.volume || {};
  const diskUsedPercent = Number(volume.usedPercent)
    || percentOf(Number(volume.used), Number(volume.total))
    || Number(primaryDisk.usedPercent)
    || 0;
  const swapTotal = Number(metrics.swapTotalMb) || 0;
  const swapUsed = Number(metrics.swapUsedMb) || 0;
  return {
    cpuPercent: Number(metrics.cpuPercent) || 0,
    memoryPercent: Number(metrics.memoryPercent) || 0,
    swapUsedPercent: swapTotal > 0 ? (swapUsed / swapTotal) * 100 : 0,
    swapUsedMb: swapUsed,
    swapTotalMb: swapTotal,
    diskUsedPercent,
    diskAvailableMb: Number.isFinite(Number(volume.available)) ? Number((Number(volume.available) / 1024 ** 2).toFixed(0)) : null,
    temperatureC: Number.isFinite(Number(metrics.temperatureC)) ? Number(metrics.temperatureC) : null,
    memoryPressure: metrics.memoryPressure || "unknown",
    processCount: Number(metrics.processCount) || 0,
    capturedAt: metrics.generatedAt || new Date().toISOString()
  };
}

/**
 * Evaluates rules against a metric reading.
 * `state` carries the consecutive-hit counters and last notification times and
 * is mutated in place, so callers can keep one state object per monitor process.
 */
export function evaluateAlerts(reading, state = { counters: {}, lastNotifiedAt: {} }, rules = DEFAULT_ALERT_RULES, now = Date.now()) {
  if (!state.counters) state.counters = {};
  if (!state.lastNotifiedAt) state.lastNotifiedAt = {};
  const fired = [];
  const active = [];

  for (const rule of rules) {
    const value = Number(reading?.[rule.metric]);
    const hit = compare(value, rule.comparator, rule.threshold);
    if (!hit) {
      state.counters[rule.id] = 0;
      continue;
    }
    state.counters[rule.id] = (state.counters[rule.id] || 0) + 1;
    const streak = state.counters[rule.id];
    const alert = {
      ruleId: rule.id,
      label: rule.label,
      metric: rule.metric,
      value: Number.isFinite(value) ? Number(value.toFixed(1)) : null,
      threshold: rule.threshold,
      comparator: rule.comparator,
      severity: rule.severity,
      advice: rule.advice,
      streak,
      required: rule.consecutive || 1,
      at: new Date(now).toISOString()
    };
    if (streak < (rule.consecutive || 1)) continue;
    active.push(alert);
    const lastAt = state.lastNotifiedAt[rule.id];
    if (!lastAt || now - lastAt >= (rule.cooldownMs || 0)) {
      state.lastNotifiedAt[rule.id] = now;
      fired.push(alert);
    }
  }

  return { fired, active };
}

export function describeAlert(alert) {
  const unit = alert.metric === "temperatureC" ? "°C" : "%";
  return `${alert.label}：当前 ${alert.value}${unit}（阈值 ${alert.threshold}${unit}）。${alert.advice}`;
}
