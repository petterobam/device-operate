import test from "node:test";
import assert from "node:assert/strict";
import {
  findCronTaskProcesses,
  getLaunchdStatus,
  parseLaunchctlList,
  parseLaunchctlServices,
  parseProcessList
} from "../server/task-runtime.js";

test("launchctl user services distinguish loaded jobs from running processes", () => {
  const services = parseLaunchctlList([
    "PID\tStatus\tLabel",
    "-\t0\tcom.example.waiting",
    "4242\t0\tcom.example.running",
    "-\t-9\tcom.example.failed"
  ].join("\n"));

  assert.deepEqual(services.get("com.example.waiting"), {
    loaded: true,
    running: false,
    pid: null,
    lastExitStatus: 0
  });
  assert.equal(services.get("com.example.running").pid, 4242);
  assert.equal(services.get("com.example.failed").lastExitStatus, -9);
});

test("launchctl system services treat pid zero as waiting", () => {
  const services = parseLaunchctlServices(`domain = system\n\tservices = {\n\t\t0  0  com.example.waiting\n\t\t712  -  com.example.running\n\t}\n`);

  assert.equal(services.get("com.example.waiting").running, false);
  assert.equal(services.get("com.example.running").pid, 712);
});

test("launchd status prioritizes active execution and reports recent failures", () => {
  assert.equal(getLaunchdStatus({ disabled: false, loaded: true, running: true, lastExitStatus: -9 }), "running");
  assert.equal(getLaunchdStatus({ disabled: false, loaded: true, running: false, lastExitStatus: 2 }), "failed");
  assert.equal(getLaunchdStatus({ disabled: false, loaded: true, running: false, lastExitStatus: 0 }), "waiting");
  assert.equal(getLaunchdStatus({ disabled: true, loaded: false, running: false, lastExitStatus: null }), "disabled");
});

test("cron process detection requires an exact command and cron ancestor", () => {
  const processes = parseProcessList([
    "  100     1 01:00:00 /usr/sbin/cron",
    "  101   100    00:04 /bin/sh -c /usr/local/bin/backup --daily",
    "  102   101    00:04 /usr/local/bin/backup --daily",
    "  200     1    00:03 /bin/zsh -c /usr/local/bin/backup --daily",
    "  201   100    00:02 /bin/sh -c /usr/local/bin/backup --weekly"
  ].join("\n"));

  assert.deepEqual(
    findCronTaskProcesses("/usr/local/bin/backup --daily", processes).map(({ pid }) => pid),
    [101]
  );
});
