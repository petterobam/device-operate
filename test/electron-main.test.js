// Source-level guards for the Electron lifecycle.
//
// The double-tray bug came from createWindow() being called again while the app
// was still alive: it started a second local server and constructed a second
// Tray without destroying the first. These assertions keep the single-instance
// and single-tray invariants from regressing.

import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const source = await fs.readFile(path.join(root, "electron", "main.js"), "utf8");

test("the app takes a single-instance lock and focuses the existing window", () => {
  assert.match(source, /app\.requestSingleInstanceLock\(\)/);
  assert.match(source, /app\.on\("second-instance"/);
  assert.match(source, /app\.quit\(\)/, "a losing second instance must quit");
});

test("the local server and the menu bar tray are created exactly once", () => {
  const startServerCalls = source.match(/startServer\(/g) || [];
  const trayCalls = source.match(/new Tray\(/g) || [];
  assert.equal(startServerCalls.length, 1, "startServer must have exactly one call site");
  assert.equal(trayCalls.length, 1, "new Tray must have exactly one call site");
});

test("window creation is idempotent and reuses the existing window", () => {
  assert.match(source, /if \(mainWindow && !mainWindow\.isDestroyed\(\)\)/);
  assert.match(source, /mainWindow\.show\(\)/);
  assert.match(source, /runtimePromise/, "runtime startup must be memoised");
});

test("activating the app never starts a new runtime", () => {
  const activateBlock = source.slice(source.indexOf('app.on("activate"'));
  assert.match(activateBlock, /showWindow\(\)/);
  assert.doesNotMatch(activateBlock.slice(0, 260), /startServer|new Tray/);
});

test("quitting tears down the tray, the server and the notification timer", () => {
  const quitBlock = source.slice(source.indexOf('app.on("before-quit"'));
  assert.match(quitBlock, /trayController\?\.stop\(\)/);
  assert.match(quitBlock, /apiServer\.close\(\)/);
  assert.match(quitBlock, /clearInterval\(notificationTimer\)/);
});
