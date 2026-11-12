import assert from "node:assert/strict";
import test from "node:test";
import {
  parseSleepLog,
  parseSoftwareUpdateList,
  parseSoftwareUpdateSettings,
  parseSystemProfilerPower
} from "../server/system-info.js";

const POWER_OUTPUT = `Power:

    Battery Information:

      Model Information:
          Serial Number: ABC123
          Firmware Version: 1002
      Charge Information:
          Charging: No
          Fully Charged: Yes
          State of Charge (%): 100
      Health Information:
          Cycle Count: 473
          Condition: Normal
          Maximum Capacity: 85%

    System Power Settings:

      AC Power:
          System Sleep Timer (Minutes): 0
          Display Sleep Timer (Minutes): 10
          Low Power Mode: No
          Current Power Source: Yes
      Battery Power:
          System Sleep Timer (Minutes): 0
          Display Sleep Timer (Minutes): 45
          Low Power Mode: Yes
`;

test("system profiler output is parsed into battery and power settings", () => {
  const parsed = parseSystemProfilerPower(POWER_OUTPUT);
  assert.equal(parsed.battery.present, true);
  assert.equal(parsed.battery.healthPercent, 85);
  assert.equal(parsed.battery.condition, "Normal");
  assert.equal(parsed.battery.cycleCount, 473);
  assert.equal(parsed.battery.stateOfChargePercent, 100);
  assert.equal(parsed.battery.charging, false);
  assert.equal(parsed.battery.fullyCharged, true);
  assert.equal(parsed.battery.serialNumber, "ABC123");
  assert.equal(parsed.settings.ac["Display Sleep Timer (Minutes)"], "10");
  assert.equal(parsed.settings.battery["Low Power Mode"], "Yes");
});

test("a Mac without a battery reports present=false", () => {
  const parsed = parseSystemProfilerPower("Power:\n\n    Battery Information:\n\n");
  assert.equal(parsed.battery.present, false);
});

const SLEEP_OUTPUT = `2026-10-15 17:54:49 +0800 Sleep               \tEntering Sleep state due to 'Clamshell Sleep':TCPKeepAlive=active Using Batt (Charge:27%) 122 secs
2026-10-15 17:56:51 +0800 DarkWake            \tDarkWake from Deep Idle [CDNP] : due to smc.sysState.Wake(0x70070000) USB-C_plug SMC.OutboxNotEmpty/ Using BATT (Charge:27%) 1 secs
2026-10-15 17:56:52 +0800 Wake                \tDarkWake to FullWake from Deep Idle [CDNVAP] : due to Notification Using AC (Charge:27%)
some unrelated line that must be ignored
`;

test("pmset sleep log is parsed into structured events", () => {
  const events = parseSleepLog(SLEEP_OUTPUT, { limit: 10 });
  assert.equal(events.length, 3);
  // Newest first.
  assert.equal(events[0].kind, "Wake");
  assert.equal(events[0].reason, "Notification");
  assert.equal(events[0].chargePercent, 27);
  assert.equal(events[1].kind, "DarkWake");
  assert.match(events[1].reason, /smc\.sysState\.Wake/);
  assert.equal(events[2].kind, "Sleep");
  assert.equal(events[2].reason, "Clamshell Sleep");
  assert.equal(events[2].durationSeconds, 122);
  assert.ok(events.every((event) => event.at));
});

test("sleep event limit keeps the most recent entries", () => {
  const events = parseSleepLog(SLEEP_OUTPUT, { limit: 1 });
  assert.equal(events.length, 1);
  assert.equal(events[0].kind, "Wake");
});

const UPDATE_OUTPUT = `Software Update Tool

Finding available software
Software Update found the following new or updated software:
* Label: Safari27.0TahoeAuto-27.0
\tTitle: Safari, Version: 27.0, Size: 249465KiB, Recommended: YES,
* Label: macOS Tahoe 26.7.1-25G241
\tTitle: macOS Tahoe 26.7.1, Version: 26.7.1, Size: 2960823KiB, Recommended: YES, Action: restart,
`;

test("softwareupdate output is parsed into update entries with sizes", () => {
  const parsed = parseSoftwareUpdateList(UPDATE_OUTPUT);
  assert.equal(parsed.blocked, false);
  assert.equal(parsed.upToDate, false);
  assert.equal(parsed.updates.length, 2);
  assert.equal(parsed.updates[0].title, "Safari");
  assert.equal(parsed.updates[0].version, "27.0");
  assert.equal(parsed.updates[0].sizeBytes, 249465 * 1024);
  assert.equal(parsed.updates[0].recommended, true);
  assert.equal(parsed.updates[1].action, "restart");
});

test("no updates available is reported as up to date", () => {
  const parsed = parseSoftwareUpdateList("Software Update Tool\n\nFinding available software\nNo new software available.\n");
  assert.equal(parsed.blocked, true);
  assert.equal(parsed.upToDate, true);
  assert.equal(parsed.updates.length, 0);
});

test("software update preference plist is summarised", () => {
  const settings = parseSoftwareUpdateSettings(`{
    AutomaticDownload = 1;
    AutomaticallyInstallMacOSUpdates = 0;
    CriticalUpdateInstall = 1;
    ConfigDataInstall = 1;
}`);
  assert.equal(settings.automaticDownload, true);
  assert.equal(settings.automaticInstallMacOS, false);
  assert.equal(settings.criticalUpdateInstall, true);
  assert.equal(settings.configDataInstall, true);
});
