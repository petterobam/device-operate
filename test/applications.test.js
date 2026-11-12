import test from "node:test";
import assert from "node:assert/strict";
import {
  decodeApplicationId,
  encodeApplicationId,
  extractApplicationPath,
  inferDeclaredPermissions,
  isPathWithinRoot,
  normalizeProcessPids,
  parseProcessList,
  parseSystemProcessList,
  runIconCommand
} from "../server/applications.js";

test("application ids round-trip paths containing spaces and Chinese characters", () => {
  const appPath = "/Applications/我的应用.app";
  assert.equal(decodeApplicationId(encodeApplicationId(appPath)), appPath);
});

test("path root checks do not accept sibling prefixes", () => {
  assert.equal(isPathWithinRoot("/Applications/Notes.app", "/Applications"), true);
  assert.equal(isPathWithinRoot("/Applications-old/Notes.app", "/Applications"), false);
});

test("extractApplicationPath maps nested helpers to the outer application", () => {
  const command = "/Applications/Chrome.app/Contents/Frameworks/Chrome Helper.app/Contents/MacOS/Chrome Helper";
  assert.equal(extractApplicationPath(command), "/Applications/Chrome.app");
});

test("parseProcessList keeps application processes and ignores plain commands", () => {
  const output = [
    "  671     1   1.5  0.4 14-06:01:11 /Applications/Lark.app/Contents/MacOS/Feishu",
    "  758   671   0.1  0.2    23:16:40 /Applications/Lark.app/Contents/Frameworks/Lark Helper.app/Contents/MacOS/Lark Helper",
    " 9000     1   0.0  0.1       01:20 /usr/bin/node"
  ].join("\n");

  assert.deepEqual(parseProcessList(output), [
    {
      pid: 671,
      parentPid: 1,
      cpu: 1.5,
      memory: 0.4,
      elapsed: "14-06:01:11",
      command: "/Applications/Lark.app/Contents/MacOS/Feishu",
      appPath: "/Applications/Lark.app"
    },
    {
      pid: 758,
      parentPid: 671,
      cpu: 0.1,
      memory: 0.2,
      elapsed: "23:16:40",
      command: "/Applications/Lark.app/Contents/Frameworks/Lark Helper.app/Contents/MacOS/Lark Helper",
      appPath: "/Applications/Lark.app"
    }
  ]);
});

test("parseSystemProcessList keeps RSS and classifies non-application processes", () => {
  const output = [
    "  671     1   1.5  0.4  2048  14-06:01:11 /Applications/Lark.app/Contents/MacOS/Feishu",
    " 9000     1   0.0  0.1   512       01:20 /usr/bin/node"
  ].join("\n");

  assert.deepEqual(parseSystemProcessList(output), [
    {
      pid: 671,
      parentPid: 1,
      cpu: 1.5,
      memory: 0.4,
      rssKb: 2048,
      elapsed: "14-06:01:11",
      command: "/Applications/Lark.app/Contents/MacOS/Feishu",
      processName: "Feishu",
      appPath: "/Applications/Lark.app"
    },
    {
      pid: 9000,
      parentPid: 1,
      cpu: 0,
      memory: 0.1,
      rssKb: 512,
      elapsed: "01:20",
      command: "/usr/bin/node",
      processName: "node",
      appPath: ""
    }
  ]);
});

test("normalizeProcessPids deduplicates valid numeric ids and rejects unsafe input", () => {
  assert.deepEqual(normalizeProcessPids(["12", 12, 45]), [12, 45]);
  assert.throws(() => normalizeProcessPids([]), /至少选择一个进程/);
  assert.throws(() => normalizeProcessPids(["12.5"]), /无效的进程 PID/);
  assert.throws(() => normalizeProcessPids([1, 2], { max: 1 }), /一次最多选择 1 个进程/);
});

test("icon commands are killed when they exceed their timeout", async () => {
  const startedAt = Date.now();

  await assert.rejects(
    runIconCommand(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { timeoutMs: 50 }),
    (error) => error.killed && error.signal === "SIGKILL"
  );

  assert.ok(Date.now() - startedAt < 1_000);
});

test("application metadata identifies declared privacy permissions without duplicates", () => {
  assert.deepEqual(inferDeclaredPermissions({
    NSCameraUsageDescription: "Video calls",
    NSMicrophoneUsageDescription: "Voice calls",
    NSBluetoothAlwaysUsageDescription: "Accessories",
    NSBluetoothPeripheralUsageDescription: "Legacy accessories",
    NSContactsUsageDescription: ""
  }), [
    "kTCCServiceBluetoothAlways",
    "kTCCServiceCamera",
    "kTCCServiceMicrophone"
  ]);
});
