import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { DEFAULT_ALERT_RULES, evaluateAlerts, metricsFromSnapshot, describeAlert } from "../server/alert-rules.js";
import { createMonitorHistoryService } from "../server/monitor-history.js";
import { createNotificationService } from "../server/notification-service.js";

function snapshotWith(overrides = {}) {
  return {
    metrics: {
      cpuPercent: 10,
      memoryPercent: 40,
      swapUsedMb: 100,
      swapTotalMb: 1000,
      temperatureC: 45,
      memoryPressure: "normal",
      processCount: 400,
      generatedAt: "2026-10-16T02:00:00.000Z",
      ...overrides
    },
    disks: [{ mount: "/", usedPercent: 50, usedBytes: 500, totalBytes: 1000 }]
  };
}

test("metricsFromSnapshot flattens monitor output into alert inputs", () => {
  const metrics = metricsFromSnapshot(snapshotWith({ swapUsedMb: 900 }));
  assert.equal(metrics.cpuPercent, 10);
  assert.equal(metrics.diskUsedPercent, 50);
  assert.equal(metrics.swapUsedPercent, 90);
  assert.equal(metrics.temperatureC, 45);
});

test("sustained rules require consecutive hits before firing", () => {
  const state = { counters: {}, lastNotifiedAt: {} };
  const cpuRule = DEFAULT_ALERT_RULES.filter((rule) => rule.id === "cpu-sustained");
  const first = evaluateAlerts({ cpuPercent: 90 }, state, cpuRule, 1000);
  assert.equal(first.fired.length, 0, "single spike must not fire");
  assert.equal(first.active.length, 0);

  evaluateAlerts({ cpuPercent: 90 }, state, cpuRule, 2000);
  const third = evaluateAlerts({ cpuPercent: 90 }, state, cpuRule, 3000);
  assert.equal(third.fired.length, 1);
  assert.equal(third.fired[0].ruleId, "cpu-sustained");
  assert.match(describeAlert(third.fired[0]), /CPU 持续高负载/);
});

test("a rule stops firing and resets its streak when the metric recovers", () => {
  const state = { counters: {}, lastNotifiedAt: {} };
  evaluateAlerts({ cpuPercent: 90 }, state, DEFAULT_ALERT_RULES, 1000);
  evaluateAlerts({ cpuPercent: 90 }, state, DEFAULT_ALERT_RULES, 2000);
  const recovered = evaluateAlerts({ cpuPercent: 20 }, state, DEFAULT_ALERT_RULES, 3000);
  assert.equal(recovered.fired.length, 0);
  assert.equal(state.counters["cpu-sustained"], 0);
});

test("cooldown suppresses duplicate notifications for an ongoing alert", () => {
  const state = { counters: {}, lastNotifiedAt: {} };
  evaluateAlerts({ diskUsedPercent: 95 }, state, DEFAULT_ALERT_RULES, 1000);
  const again = evaluateAlerts({ diskUsedPercent: 95 }, state, DEFAULT_ALERT_RULES, 2000);
  assert.equal(again.fired.length, 0, "same alert must not re-fire inside the cooldown");
  assert.equal(again.active.length, 1, "alert still reported as active");

  const afterCooldown = evaluateAlerts({ diskUsedPercent: 95 }, state, DEFAULT_ALERT_RULES, 1000 + 60 * 60_000 + 1);
  assert.equal(afterCooldown.fired.length, 1);
});

test("notification service records deliveries and failures", async () => {
  const sent = [];
  const service = createNotificationService({ sender: async (entry) => {
    sent.push(entry);
    return { delivered: true, channel: "test" };
  } });
  const result = await service.notify({ title: "T", message: "M", ruleId: "r" });
  assert.equal(result.delivered, true);
  assert.equal(service.list().length, 1);
  assert.equal(sent[0].message, "M");

  const failing = createNotificationService({ sender: async () => { throw new Error("boom"); } });
  const failed = await failing.notify({ title: "T", message: "M" });
  assert.equal(failed.delivered, false);
  assert.match(failed.reason, /boom/);
});

test("monitor history persists samples, evaluates alerts and summarises trends", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "device-operate-monitor-"));
  const filePath = path.join(dir, "history.jsonl");
  const notifications = [];
  const notificationsService = createNotificationService({
    sender: async (entry) => {
      notifications.push(entry);
      return { delivered: true, channel: "test" };
    }
  });
  let cpu = 10;
  const service = createMonitorHistoryService({
    filePath,
    snapshot: async () => snapshotWith({ cpuPercent: cpu }),
    notifications: notificationsService,
    intervalMs: 60_000
  });

  const first = await service.sampleOnce();
  assert.equal(first.fired.length, 0);
  cpu = 95;
  await service.sampleOnce();
  await service.sampleOnce();
  const third = await service.sampleOnce();
  assert.ok(third.fired.some((alert) => alert.ruleId === "cpu-sustained"));
  assert.equal(notifications.length, 1);

  const history = await service.history({ limit: 10 });
  assert.equal(history.length, 4);
  assert.deepEqual(history.map((entry) => entry.cpuPercent), [10, 95, 95, 95]);

  const summary = await service.summary({ limit: 10 });
  assert.equal(summary.samples, 4);
  assert.equal(summary.metrics.cpuPercent.max, 95);
  assert.equal(summary.metrics.cpuPercent.last, 95);
  assert.deepEqual(summary.alerts.map((entry) => entry.ruleId), ["cpu-sustained"]);
  assert.ok(summary.storageBytes > 0);

  const status = service.status();
  assert.equal(status.running, false);
  assert.equal(status.sampleCount, 4);
  // The tray reads the menu bar disk figure from this snapshot rather than the
  // raw df list, whose first entry is the read-only system volume.
  assert.equal(status.lastSample.diskUsedPercent, 50);
  assert.equal(status.lastSample.cpuPercent, 95);
  assert.ok(status.activeAlerts.some((alert) => alert.ruleId === "cpu-sustained"));

  await fs.rm(dir, { recursive: true, force: true });
});
