import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const DAY_MS = 24 * 60 * 60 * 1000;
const APPLE_EPOCH_OFFSET_SECONDS = 978_307_200;
const ANALYSIS_PERIOD_DAYS = 30;
const CRASH_PERIOD_DAYS = 90;
const SPOTLIGHT_ATTRIBUTES = [
  "kMDItemLastUsedDate",
  "kMDItemUseCount",
  "kMDItemUsedDates",
  "kMDItemAppStoreCategoryType"
];
const SPOTLIGHT_FIRST_ATTRIBUTE = [...SPOTLIGHT_ATTRIBUTES].sort()[0];

const CATEGORY_TYPES = {
  "public.app-category.business": ["business", "商务"],
  "public.app-category.developer-tools": ["development", "开发"],
  "public.app-category.education": ["education", "教育"],
  "public.app-category.entertainment": ["entertainment", "娱乐"],
  "public.app-category.finance": ["finance", "财务"],
  "public.app-category.games": ["games", "游戏"],
  "public.app-category.graphics-design": ["design", "设计"],
  "public.app-category.healthcare-fitness": ["health", "健康"],
  "public.app-category.lifestyle": ["lifestyle", "生活"],
  "public.app-category.medical": ["medical", "医疗"],
  "public.app-category.music": ["music", "音乐"],
  "public.app-category.news": ["news", "新闻"],
  "public.app-category.photography": ["photography", "摄影"],
  "public.app-category.productivity": ["productivity", "效率"],
  "public.app-category.reference": ["reference", "参考"],
  "public.app-category.social-networking": ["social", "社交"],
  "public.app-category.sports": ["sports", "体育"],
  "public.app-category.travel": ["travel", "旅行"],
  "public.app-category.utilities": ["utilities", "工具"],
  "public.app-category.video": ["video", "视频"],
  "public.app-category.weather": ["weather", "天气"]
};

const CATEGORY_KEYWORDS = [
  ["development", "开发", ["xcode", "visual studio", "vscode", "terminal", "iterm", "github", "postman", "docker", "cursor", "codex", "ollama", "developer"]],
  ["games", "游戏", ["game", "steam", "retroarch", "crossover", "植物大战", "minecraft"]],
  ["design", "设计", ["figma", "sketch", "photoshop", "illustrator", "affinity", "pixelmator", "blender"]],
  ["photography", "摄影", ["photo", "照片", "lightroom", "capture one", "image"]],
  ["video", "视频", ["video", "final cut", "premiere", "handbrake", "quicktime", "剪映", "obs"]],
  ["music", "音乐", ["music", "音乐", "spotify", "garageband", "logic pro", "audio"]],
  ["social", "社交", ["wechat", "微信", "qq", "telegram", "discord", "slack", "lark", "feishu", "飞书", "messages"]],
  ["productivity", "效率", ["notion", "obsidian", "office", "word", "excel", "powerpoint", "calendar", "reminders", "notes", "备忘录"]],
  ["business", "商务", ["zoom", "meeting", "teams", "打印", "printer"]],
  ["finance", "财务", ["finance", "bank", "stock", "money", "账单"]],
  ["education", "教育", ["book", "dictionary", "kindle", "学习", "词典"]],
  ["entertainment", "娱乐", ["tv", "podcast", "bilibili", "netflix", "opera gx"]],
  ["utilities", "工具", ["utility", "cleaner", "finder", "settings", "系统设置", "archive", "compress", "vpn", "clash", "menubar"]]
];

export const RECOMMENDATIONS = {
  high: { id: "high", label: "高频应用", tone: "success", order: 0 },
  review: { id: "review", label: "建议取舍", tone: "warning", order: 1 },
  remove: { id: "remove", label: "建议删除", tone: "danger", order: 2 },
  observe: { id: "observe", label: "继续观察", tone: "neutral", order: 3 },
  system: { id: "system", label: "系统保留", tone: "system", order: 4 }
};

function clamp(value, minimum, maximum) {
  return Math.min(maximum, Math.max(minimum, value));
}

function parseDate(value) {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

function daysSince(value, now) {
  const date = parseDate(value);
  return date ? Math.max(0, Math.floor((now.getTime() - date.getTime()) / DAY_MS)) : null;
}

function normalizedCategoryType(value) {
  return String(value || "").trim().toLowerCase();
}

export function categorizeApplication(application, spotlight = {}) {
  const categoryType = normalizedCategoryType(spotlight.categoryType || application.categoryType);
  if (CATEGORY_TYPES[categoryType]) {
    const [id, label] = CATEGORY_TYPES[categoryType];
    return { id, label };
  }

  const searchable = [application.name, application.bundleId, application.path].filter(Boolean).join(" ").toLowerCase();
  const matched = CATEGORY_KEYWORDS.find(([, , keywords]) => keywords.some((keyword) => searchable.includes(keyword)));
  if (matched) return { id: matched[0], label: matched[1] };
  return { id: "other", label: "其他" };
}

function normalizeDateList(values) {
  if (!Array.isArray(values)) return [];
  return values.map((value) => parseDate(value)).filter(Boolean).map((date) => date.toISOString());
}

export function spotlightMetricsFromMetadata(metadata = {}, now = new Date()) {
  const usedDates = normalizeDateList(metadata.kMDItemUsedDates);
  const periodStart = now.getTime() - ANALYSIS_PERIOD_DAYS * DAY_MS;
  const activeDays30 = new Set(
    usedDates
      .map((value) => new Date(value))
      .filter((date) => date.getTime() >= periodStart && date.getTime() <= now.getTime())
      .map((date) => date.toISOString().slice(0, 10))
  ).size;
  const rawUseCount = metadata.kMDItemUseCount;
  const useCount = Number.isFinite(Number(rawUseCount)) && rawUseCount !== null ? Math.max(0, Number(rawUseCount)) : null;
  const lastUsedDate = parseDate(metadata.kMDItemLastUsedDate);
  return {
    lastUsedAt: lastUsedDate?.toISOString() || null,
    useCount,
    activeDays30,
    categoryType: metadata.kMDItemAppStoreCategoryType || null
  };
}

export function parseMdlsOutput(output) {
  const metadata = {};
  const lines = String(output || "").split("\n");
  for (let index = 0; index < lines.length; index += 1) {
    const match = lines[index].match(/^([A-Za-z0-9_]+)\s+=\s+(.*)$/);
    if (!match) continue;
    const [, key, rawValue] = match;
    if (rawValue === "(null)") {
      metadata[key] = null;
      continue;
    }
    if (rawValue === "(") {
      const values = [];
      index += 1;
      while (index < lines.length && lines[index].trim() !== ")") {
        const value = lines[index].trim().replace(/,$/, "");
        if (value.startsWith('"') && value.endsWith('"')) values.push(value.slice(1, -1));
        index += 1;
      }
      metadata[key] = values;
      continue;
    }
    if (rawValue.startsWith('"') && rawValue.endsWith('"')) {
      metadata[key] = rawValue.slice(1, -1);
      continue;
    }
    const numericValue = Number(rawValue);
    metadata[key] = Number.isFinite(numericValue) ? numericValue : rawValue;
  }
  return metadata;
}

export function parseMdlsRecords(output) {
  const records = [];
  let current = [];
  for (const line of String(output || "").split("\n")) {
    if (line.startsWith(`${SPOTLIGHT_FIRST_ATTRIBUTE} `) && current.length) {
      records.push(parseMdlsOutput(current.join("\n")));
      current = [];
    }
    if (current.length || /^[A-Za-z0-9_]+\s+=/.test(line)) current.push(line);
  }
  if (current.length) records.push(parseMdlsOutput(current.join("\n")));
  return records;
}

function chunks(items, size) {
  return Array.from({ length: Math.ceil(items.length / size) }, (_, index) => items.slice(index * size, (index + 1) * size));
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

export async function collectSpotlightMetrics(applications, { now = new Date(), run = execFileAsync } = {}) {
  const emptyMetrics = { lastUsedAt: null, useCount: null, activeDays30: 0, categoryType: null };
  const mdlsArguments = SPOTLIGHT_ATTRIBUTES.flatMap((attribute) => ["-name", attribute]);

  async function readOne(application) {
    try {
      const { stdout } = await run("mdls", [...mdlsArguments, application.path], { maxBuffer: 512 * 1024, timeout: 4_000 });
      return [application.id, spotlightMetricsFromMetadata(parseMdlsOutput(stdout), now), true];
    } catch {
      return [application.id, emptyMetrics, false];
    }
  }

  const batchResults = await mapWithConcurrency(chunks(applications, 24), 4, async (batch) => {
    try {
      const { stdout } = await run("mdls", [...mdlsArguments, ...batch.map(({ path: appPath }) => appPath)], {
        maxBuffer: 4 * 1024 * 1024,
        timeout: 10_000
      });
      const metadataRecords = parseMdlsRecords(stdout);
      if (metadataRecords.length !== batch.length) return mapWithConcurrency(batch, 6, readOne);
      return batch.map((application, index) => [
        application.id,
        spotlightMetricsFromMetadata(metadataRecords[index], now),
        true
      ]);
    } catch {
      return mapWithConcurrency(batch, 6, readOne);
    }
  });
  const records = batchResults.flat();
  const successfulReads = records.filter(([, , read]) => read).length;
  const evidenceRecords = records.filter(([, metrics]) => metrics.lastUsedAt || metrics.useCount !== null).length;
  return {
    byId: Object.fromEntries(records.map(([id, metrics]) => [id, metrics])),
    source: {
      available: successfulReads > 0,
      coverage: applications.length ? evidenceRecords / applications.length : 1,
      recordCount: evidenceRecords,
      readCount: successfulReads,
      totalCount: applications.length,
      label: "Spotlight"
    }
  };
}

function parseCrashDate(value) {
  if (!value) return null;
  const normalized = String(value).replace(/([+-]\d{2})(\d{2})$/, "$1:$2");
  return parseDate(normalized)?.toISOString() || null;
}

export function parseCrashReportHeader(content, fileName = "") {
  const text = String(content || "");
  const firstLine = text.split("\n", 1)[0];
  if (firstLine.startsWith("{")) {
    try {
      const metadata = JSON.parse(firstLine);
      return {
        bundleId: metadata.bundleID || metadata.bundle_id || "",
        processName: metadata.app_name || metadata.name || "",
        crashedAt: parseCrashDate(metadata.timestamp),
        bugType: String(metadata.bug_type || "")
      };
    } catch {
      // Fall through to the legacy crash format.
    }
  }
  const bundleId = text.match(/^Identifier:\s+(.+)$/m)?.[1]?.trim() || "";
  const processName = text.match(/^Process:\s+(.+?)(?:\s+\[\d+\])?$/m)?.[1]?.trim() || path.basename(fileName).split("_")[0];
  const crashedAt = parseCrashDate(text.match(/^(?:Date\/Time|Timestamp):\s+(.+)$/m)?.[1]?.trim());
  return { bundleId, processName, crashedAt, bugType: "legacy" };
}

async function readFilePrefix(filePath, length = 24 * 1024) {
  const handle = await fs.open(filePath, "r");
  try {
    const buffer = Buffer.alloc(length);
    const { bytesRead } = await handle.read(buffer, 0, length, 0);
    return buffer.subarray(0, bytesRead).toString("utf8");
  } finally {
    await handle.close();
  }
}

function crashIdentityCandidates(application) {
  return new Set([
    application.bundleId?.toLowerCase(),
    application.name?.toLowerCase(),
    path.basename(application.path || "", ".app").toLowerCase()
  ].filter(Boolean));
}

export async function collectCrashMetrics(applications, { now = new Date() } = {}) {
  const directories = [
    path.join(os.homedir(), "Library", "Logs", "DiagnosticReports"),
    "/Library/Logs/DiagnosticReports"
  ];
  const cutoff = now.getTime() - CRASH_PERIOD_DAYS * DAY_MS;
  let accessibleDirectories = 0;
  const reportPaths = [];
  for (const directory of directories) {
    try {
      const entries = await fs.readdir(directory, { withFileTypes: true });
      accessibleDirectories += 1;
      for (const entry of entries) {
        if (!entry.isFile() || !/\.(?:ips|crash)$/i.test(entry.name)) continue;
        const reportPath = path.join(directory, entry.name);
        const stat = await fs.stat(reportPath).catch(() => null);
        if (stat?.mtimeMs >= cutoff) reportPaths.push(reportPath);
      }
    } catch {
      // Report source remains unavailable when neither directory can be read.
    }
  }

  const reports = (await mapWithConcurrency(reportPaths, 6, async (reportPath) => {
    try {
      return parseCrashReportHeader(await readFilePrefix(reportPath), path.basename(reportPath));
    } catch {
      return null;
    }
  })).filter(Boolean);

  const byId = {};
  for (const application of applications) {
    const candidates = crashIdentityCandidates(application);
    const matched = reports.filter((report) => {
      const bundleId = report.bundleId?.toLowerCase();
      const processName = report.processName?.toLowerCase();
      return (bundleId && candidates.has(bundleId)) || (processName && candidates.has(processName));
    });
    byId[application.id] = {
      crashCount90: matched.length,
      lastCrashAt: matched.map(({ crashedAt }) => crashedAt).filter(Boolean).sort().at(-1) || null
    };
  }

  return {
    byId,
    source: {
      available: accessibleDirectories > 0,
      periodDays: CRASH_PERIOD_DAYS,
      reportCount: reports.length,
      label: "诊断报告"
    }
  };
}

export function parseUsageRows(rows) {
  const byBundleId = {};
  for (const row of Array.isArray(rows) ? rows : []) {
    const bundleId = String(row.bundleId || "").trim().toLowerCase();
    if (!bundleId) continue;
    byBundleId[bundleId] = {
      usageMinutes30: Math.max(0, Math.round(Number(row.usageMinutes30) || 0)),
      sessionCount30: Math.max(0, Math.round(Number(row.sessionCount30) || 0))
    };
  }
  return byBundleId;
}

export async function collectUsageMetrics(applications, { run = execFileAsync } = {}) {
  const databasePath = path.join(os.homedir(), "Library", "Application Support", "Knowledge", "knowledgeC.db");
  const cutoff = Math.floor(Date.now() / 1000) - APPLE_EPOCH_OFFSET_SECONDS - ANALYSIS_PERIOD_DAYS * 24 * 60 * 60;
  const query = `
    SELECT LOWER(ZVALUESTRING) AS bundleId,
           ROUND(SUM(MAX(0, ZENDDATE - ZSTARTDATE)) / 60.0) AS usageMinutes30,
           COUNT(*) AS sessionCount30
      FROM ZOBJECT
     WHERE ZSTREAMNAME = '/app/usage'
       AND ZSTARTDATE >= ${cutoff}
       AND ZENDDATE > ZSTARTDATE
       AND ZVALUESTRING IS NOT NULL
     GROUP BY LOWER(ZVALUESTRING)
  `;
  try {
    const { stdout } = await run("sqlite3", ["-readonly", "-json", databasePath, query], {
      maxBuffer: 2 * 1024 * 1024,
      timeout: 8_000
    });
    const byBundleId = parseUsageRows(stdout.trim() ? JSON.parse(stdout) : []);
    const matchedCount = applications.filter(({ bundleId }) => byBundleId[bundleId?.toLowerCase()]).length;
    return {
      byBundleId,
      source: {
        available: true,
        coverage: applications.length ? matchedCount / applications.length : 1,
        recordCount: matchedCount,
        totalCount: applications.length,
        periodDays: ANALYSIS_PERIOD_DAYS,
        label: "Screen Time",
        requiresFullDiskAccess: false
      }
    };
  } catch (error) {
    return {
      byBundleId: {},
      source: {
        available: false,
        coverage: 0,
        recordCount: 0,
        totalCount: applications.length,
        periodDays: ANALYSIS_PERIOD_DAYS,
        label: "Screen Time",
        requiresFullDiskAccess: /authori[sz]ation denied|operation not permitted|unable to open database/i.test(error.message || "")
      }
    };
  }
}

function activityScore(metrics) {
  const recentScore = metrics.lastUsedDays === null ? 0 : clamp(38 - metrics.lastUsedDays * 1.4, 0, 38);
  const dayScore = clamp(metrics.activeDays30 * 3, 0, 30);
  const durationScore = clamp(metrics.usageMinutes30 / 30, 0, 22);
  const countScore = metrics.useCount === null ? 0 : clamp(Math.log10(metrics.useCount + 1) * 5, 0, 10);
  return Math.round(recentScore + dayScore + durationScore + countScore);
}

function frequencyFromMetrics(metrics) {
  if (metrics.usageMinutes30 >= 600 || metrics.activeDays30 >= 12 || (metrics.lastUsedDays !== null && metrics.lastUsedDays <= 2 && (metrics.useCount || 0) >= 60)) {
    return { id: "high", label: "高频" };
  }
  if (metrics.usageMinutes30 >= 120 || metrics.activeDays30 >= 4 || (metrics.lastUsedDays !== null && metrics.lastUsedDays <= 7 && (metrics.useCount || 0) >= 10)) {
    return { id: "regular", label: "常用" };
  }
  if (metrics.activeDays30 >= 1 || (metrics.lastUsedDays !== null && metrics.lastUsedDays <= 30)) {
    return { id: "occasional", label: "偶尔" };
  }
  return { id: "dormant", label: "闲置" };
}

function recommendationFor(application, metrics, peer) {
  const hasUsageEvidence = Boolean(metrics.lastUsedAt) || metrics.useCount !== null || metrics.usageAvailable;
  const frequency = frequencyFromMetrics(metrics);
  const reasons = [];

  if (frequency.id === "high") {
    if (metrics.usageMinutes30 >= 600) reasons.push(`近30天使用 ${Math.round(metrics.usageMinutes30 / 60)} 小时`);
    if (metrics.activeDays30 >= 8) reasons.push(`近30天活跃 ${metrics.activeDays30} 天`);
    if (!reasons.length && metrics.lastUsedDays !== null) reasons.push(`${metrics.lastUsedDays || "今天"}${metrics.lastUsedDays ? " 天内" : ""}刚使用过`);
    return { ...RECOMMENDATIONS.high, reasons, frequency };
  }

  if (application.system || !application.removable) {
    reasons.push("macOS 系统组件，不参与清理建议");
    if (metrics.crashCount90) reasons.push(`近90天有 ${metrics.crashCount90} 次异常退出`);
    return { ...RECOMMENDATIONS.system, reasons, frequency };
  }

  const neverUsed = metrics.useCount === 0 && !metrics.lastUsedAt;
  const longIdle = metrics.lastUsedDays !== null && metrics.lastUsedDays >= 180;
  const veryLowUse = metrics.useCount !== null && metrics.useCount <= 5;
  if (hasUsageEvidence && (neverUsed || (longIdle && veryLowUse && metrics.activeDays30 === 0 && metrics.usageMinutes30 === 0))) {
    reasons.push(neverUsed ? "安装后没有打开记录" : `已 ${metrics.lastUsedDays} 天未打开`);
    if (veryLowUse) reasons.push(`累计仅打开 ${metrics.useCount} 次`);
    reasons.push("可移入废纸篓回收空间");
    return { ...RECOMMENDATIONS.remove, reasons, frequency };
  }

  const categoryOverlap = hasUsageEvidence
    && application.category.id !== "other"
    && peer.count >= 3
    && peer.rankRatio >= 0.65
    && (frequency.id === "dormant" || (frequency.id === "occasional" && (metrics.lastUsedDays || 0) >= 14));
  const reliabilityIssue = metrics.crashCount90 >= 3;
  const mediumIdle = metrics.lastUsedDays !== null && metrics.lastUsedDays >= 45;
  if (reliabilityIssue || categoryOverlap || mediumIdle) {
    if (reliabilityIssue) reasons.push(`近90天崩溃 ${metrics.crashCount90} 次`);
    if (categoryOverlap) reasons.push(`同类 ${peer.count} 个应用中活跃度靠后`);
    if (mediumIdle) reasons.push(`已 ${metrics.lastUsedDays} 天未打开`);
    return { ...RECOMMENDATIONS.review, reasons: reasons.slice(0, 3), frequency };
  }

  if (!hasUsageEvidence) reasons.push("使用数据不足，暂不建议清理");
  else if (metrics.lastUsedDays !== null && metrics.lastUsedDays <= 30) reasons.push("近期仍有使用记录");
  else reasons.push("频率一般，继续观察一段时间");
  if (metrics.crashCount90) reasons.push(`近90天崩溃 ${metrics.crashCount90} 次`);
  return { ...RECOMMENDATIONS.observe, reasons, frequency };
}

export function buildApplicationAnalysis(applications, metricSources = {}, { now = new Date() } = {}) {
  const spotlightById = metricSources.spotlight?.byId || {};
  const crashById = metricSources.crashes?.byId || {};
  const usageByBundleId = metricSources.usage?.byBundleId || {};
  const usageAvailable = Boolean(metricSources.usage?.source?.available);

  const enriched = applications.map((application) => {
    const spotlight = spotlightById[application.id] || { lastUsedAt: null, useCount: null, activeDays30: 0, categoryType: null };
    const crash = crashById[application.id] || { crashCount90: 0, lastCrashAt: null };
    const usage = usageByBundleId[application.bundleId?.toLowerCase()] || { usageMinutes30: 0, sessionCount30: 0 };
    const category = categorizeApplication(application, spotlight);
    const metrics = {
      lastUsedAt: spotlight.lastUsedAt || null,
      lastUsedDays: daysSince(spotlight.lastUsedAt, now),
      useCount: spotlight.useCount ?? null,
      activeDays30: spotlight.activeDays30 || 0,
      usageMinutes30: usage.usageMinutes30 || 0,
      sessionCount30: usage.sessionCount30 || 0,
      usageAvailable,
      crashCount90: crash.crashCount90 || 0,
      lastCrashAt: crash.lastCrashAt || null
    };
    return { ...application, category, metrics: { ...metrics, activityScore: activityScore(metrics) } };
  });

  const categoryGroups = new Map();
  for (const application of enriched.filter(({ removable, system }) => removable && !system)) {
    const group = categoryGroups.get(application.category.id) || [];
    group.push(application);
    categoryGroups.set(application.category.id, group);
  }

  const analyzed = enriched.map((application) => {
    const peers = (categoryGroups.get(application.category.id) || []).sort((a, b) => b.metrics.activityScore - a.metrics.activityScore);
    const peerIndex = peers.findIndex(({ id }) => id === application.id);
    const peer = {
      count: peers.length,
      rank: peerIndex >= 0 ? peerIndex + 1 : 0,
      rankRatio: peerIndex >= 0 && peers.length > 1 ? peerIndex / (peers.length - 1) : 0
    };
    const recommendation = recommendationFor(application, application.metrics, peer);
    const evidenceCount = [application.metrics.lastUsedAt, application.metrics.useCount !== null, usageAvailable, metricSources.crashes?.source?.available].filter(Boolean).length;
    return {
      ...application,
      peer,
      recommendation,
      confidence: evidenceCount >= 3 ? "high" : evidenceCount >= 2 ? "medium" : "low"
    };
  }).sort((a, b) => (
    a.recommendation.order - b.recommendation.order
    || b.metrics.activityScore - a.metrics.activityScore
    || a.name.localeCompare(b.name, "zh-CN")
  ));

  const counts = Object.fromEntries(Object.keys(RECOMMENDATIONS).map((id) => [id, analyzed.filter(({ recommendation }) => recommendation.id === id).length]));
  const categories = [...new Map(analyzed.map(({ category }) => [category.id, category])).values()]
    .map((category) => ({ ...category, count: analyzed.filter((application) => application.category.id === category.id).length }))
    .sort((a, b) => b.count - a.count || a.label.localeCompare(b.label, "zh-CN"));

  return {
    applications: analyzed,
    recommendations: Object.values(RECOMMENDATIONS).map((recommendation) => ({ ...recommendation, count: counts[recommendation.id] })),
    categories,
    summary: {
      total: analyzed.length,
      high: counts.high,
      review: counts.review,
      remove: counts.remove,
      observe: counts.observe,
      system: counts.system,
      totalUsageMinutes30: analyzed.reduce((total, application) => total + application.metrics.usageMinutes30, 0),
      totalCrashes90: analyzed.reduce((total, application) => total + application.metrics.crashCount90, 0)
    },
    sources: {
      spotlight: metricSources.spotlight?.source || { available: false, coverage: 0, label: "Spotlight" },
      usage: metricSources.usage?.source || { available: false, coverage: 0, periodDays: ANALYSIS_PERIOD_DAYS, label: "Screen Time" },
      crashes: metricSources.crashes?.source || { available: false, periodDays: CRASH_PERIOD_DAYS, label: "诊断报告" }
    },
    generatedAt: now.toISOString()
  };
}
