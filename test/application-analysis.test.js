import test from "node:test";
import assert from "node:assert/strict";
import {
  buildApplicationAnalysis,
  categorizeApplication,
  collectSpotlightMetrics,
  parseCrashReportHeader,
  parseMdlsOutput,
  parseMdlsRecords,
  parseUsageRows,
  spotlightMetricsFromMetadata
} from "../server/application-analysis.js";

const NOW = new Date("2026-07-26T04:00:00.000Z");

function app(id, overrides = {}) {
  return {
    id,
    name: id,
    bundleId: `com.example.${id}`,
    path: `/Applications/${id}.app`,
    categoryType: "public.app-category.productivity",
    removable: true,
    system: false,
    running: false,
    processes: null,
    ...overrides
  };
}

function metrics({ spotlight = {}, usage = {}, crashes = {}, usageAvailable = true } = {}) {
  return {
    spotlight: {
      byId: spotlight,
      source: { available: true, coverage: 1, label: "Spotlight" }
    },
    usage: {
      byBundleId: usage,
      source: { available: usageAvailable, coverage: usageAvailable ? 1 : 0, label: "Screen Time" }
    },
    crashes: {
      byId: crashes,
      source: { available: true, periodDays: 90, label: "诊断报告" }
    }
  };
}

test("mdls output is parsed into scalar and array metadata", () => {
  const parsed = parseMdlsOutput([
    "kMDItemLastUsedDate = 2026-07-25 16:57:53 +0000",
    "kMDItemUseCount = 1440",
    "kMDItemUsedDates = (",
    '    "2026-07-24 16:00:00 +0000",',
    '    "2026-07-25 16:00:00 +0000"',
    ")",
    "kMDItemAppStoreCategoryType = (null)"
  ].join("\n"));

  assert.equal(parsed.kMDItemUseCount, 1440);
  assert.deepEqual(parsed.kMDItemUsedDates, ["2026-07-24 16:00:00 +0000", "2026-07-25 16:00:00 +0000"]);
  assert.equal(parsed.kMDItemAppStoreCategoryType, null);
  assert.equal(spotlightMetricsFromMetadata(parsed, NOW).activeDays30, 2);
});

test("batched mdls output preserves application record order", () => {
  const records = parseMdlsRecords([
    "kMDItemAppStoreCategoryType = (null)",
    "kMDItemLastUsedDate = 2026-07-25 16:57:53 +0000",
    "kMDItemUseCount = 12",
    "kMDItemUsedDates = (",
    '    "2026-07-25 16:00:00 +0000"',
    ")",
    'kMDItemAppStoreCategoryType = "public.app-category.developer-tools"',
    "kMDItemLastUsedDate = (null)",
    "kMDItemUseCount = 0",
    "kMDItemUsedDates = (null)"
  ].join("\n"));

  assert.equal(records.length, 2);
  assert.equal(records[0].kMDItemUseCount, 12);
  assert.equal(records[1].kMDItemAppStoreCategoryType, "public.app-category.developer-tools");
});

test("spotlight collection reads application metadata in batches", async () => {
  const applications = [app("first"), app("second")];
  let invocationCount = 0;
  const result = await collectSpotlightMetrics(applications, {
    now: NOW,
    run: async (_command, args) => {
      invocationCount += 1;
      assert.ok(args.includes("/Applications/first.app"));
      assert.ok(args.includes("/Applications/second.app"));
      return {
        stdout: [
          "kMDItemAppStoreCategoryType = (null)",
          "kMDItemLastUsedDate = 2026-07-25 16:57:53 +0000",
          "kMDItemUseCount = 12",
          "kMDItemUsedDates = (null)",
          "kMDItemAppStoreCategoryType = (null)",
          "kMDItemLastUsedDate = (null)",
          "kMDItemUseCount = (null)",
          "kMDItemUsedDates = (null)"
        ].join("\n")
      };
    }
  });

  assert.equal(invocationCount, 1);
  assert.equal(result.byId.first.useCount, 12);
  assert.equal(result.source.readCount, 2);
  assert.equal(result.source.recordCount, 1);
  assert.equal(result.source.coverage, 0.5);
});

test("application category uses plist type first and keywords as fallback", () => {
  assert.deepEqual(categorizeApplication(app("Code", { categoryType: "public.app-category.developer-tools" })), { id: "development", label: "开发" });
  assert.deepEqual(categorizeApplication(app("RetroArch", { categoryType: "" })), { id: "games", label: "游戏" });
});

test("crash headers support modern ips and legacy crash reports", () => {
  const ips = parseCrashReportHeader('{"app_name":"Editor","timestamp":"2026-07-25 15:15:06.00 +0800","bundleID":"com.example.editor","bug_type":"309"}\n{}');
  assert.equal(ips.bundleId, "com.example.editor");
  assert.equal(ips.crashedAt, "2026-07-25T07:15:06.000Z");

  const legacy = parseCrashReportHeader("Process: Editor [123]\nIdentifier: com.example.editor\nDate/Time: 2026-07-24 12:00:00.000 +0800");
  assert.equal(legacy.processName, "Editor");
  assert.equal(legacy.bundleId, "com.example.editor");
});

test("usage rows are normalized by bundle id", () => {
  assert.deepEqual(parseUsageRows([{ bundleId: "COM.Example.Editor", usageMinutes30: 42.4, sessionCount30: 3 }]), {
    "com.example.editor": { usageMinutes30: 42, sessionCount30: 3 }
  });
});

test("analysis identifies high-frequency and safely removable applications", () => {
  const high = app("high");
  const old = app("old");
  const result = buildApplicationAnalysis([high, old], metrics({
    spotlight: {
      high: { lastUsedAt: "2026-07-25T04:00:00.000Z", useCount: 600, activeDays30: 16 },
      old: { lastUsedAt: "2025-12-01T04:00:00.000Z", useCount: 2, activeDays30: 0 }
    },
    usage: {
      "com.example.high": { usageMinutes30: 900, sessionCount30: 40 }
    }
  }), { now: NOW });

  assert.equal(result.applications.find(({ id }) => id === "high").recommendation.id, "high");
  assert.equal(result.applications.find(({ id }) => id === "old").recommendation.id, "remove");
  assert.equal(result.summary.high, 1);
  assert.equal(result.summary.remove, 1);
});

test("missing usage evidence never becomes a deletion recommendation", () => {
  const unknownApps = [app("unknown-a"), app("unknown-b"), app("unknown-c")];
  const result = buildApplicationAnalysis(unknownApps, metrics({ usageAvailable: false }), { now: NOW });
  const analyzed = result.applications[0];

  assert.ok(result.applications.every(({ recommendation }) => recommendation.id === "observe"));
  assert.match(analyzed.recommendation.reasons[0], /数据不足/);
  assert.equal(analyzed.confidence, "low");
});

test("system applications are retained while unstable or overlapping apps are reviewed", () => {
  const system = app("system", { system: true, removable: false });
  const first = app("first");
  const second = app("second");
  const third = app("third");
  const result = buildApplicationAnalysis([system, first, second, third], metrics({
    spotlight: {
      system: { lastUsedAt: null, useCount: 0, activeDays30: 0 },
      first: { lastUsedAt: "2026-07-25T04:00:00.000Z", useCount: 200, activeDays30: 18 },
      second: { lastUsedAt: "2026-07-20T04:00:00.000Z", useCount: 80, activeDays30: 8 },
      third: { lastUsedAt: "2026-07-06T04:00:00.000Z", useCount: 10, activeDays30: 0 }
    },
    crashes: {
      third: { crashCount90: 3, lastCrashAt: "2026-07-22T04:00:00.000Z" }
    }
  }), { now: NOW });

  assert.equal(result.applications.find(({ id }) => id === "system").recommendation.id, "system");
  const reviewed = result.applications.find(({ id }) => id === "third");
  assert.equal(reviewed.recommendation.id, "review");
  assert.match(reviewed.recommendation.reasons.join(" "), /崩溃 3 次/);
});
