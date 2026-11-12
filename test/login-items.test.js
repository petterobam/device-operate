import test from "node:test";
import assert from "node:assert/strict";
import {
  createLoginItemService,
  decodeLoginItemId,
  encodeLoginItemId,
  parseLoginItems
} from "../server/login-items.js";

const notes = {
  id: "notes-id",
  name: "备忘录",
  bundleId: "com.apple.Notes",
  path: "/System/Applications/Notes.app",
  iconUrl: "/notes.png",
  system: true,
  location: "系统应用"
};
const chrome = {
  id: "chrome-id",
  name: "Google Chrome",
  bundleId: "com.google.Chrome",
  path: "/Applications/Google Chrome.app",
  iconUrl: "/chrome.png",
  system: false,
  location: "应用程序"
};

function applicationStub() {
  return { async listInstalledApplications() { return [notes, chrome]; } };
}

test("login item ids round-trip and parser preserves item state", () => {
  const item = { name: "Google Chrome", path: chrome.path, hidden: true };
  assert.deepEqual(decodeLoginItemId(encodeLoginItemId(item)), { name: item.name, path: item.path });
  const parsed = parseLoginItems(JSON.stringify([item]));
  assert.equal(parsed[0].name, item.name);
  assert.equal(parsed[0].path, item.path);
  assert.equal(parsed[0].hidden, true);
});

test("login item listing matches helpers inside app bundles and excludes enabled candidates", async () => {
  const service = createLoginItemService({
    applicationService: applicationStub(),
    run: async () => ({ stdout: JSON.stringify([
      { name: "Google Chrome", path: `${chrome.path}/Contents/MacOS/Google Chrome`, hidden: false }
    ]) })
  });

  const result = await service.listLoginItems();
  assert.equal(result.items[0].application.bundleId, chrome.bundleId);
  assert.deepEqual(result.candidates.map(({ id }) => id), [notes.id]);
  assert.equal(result.summary.total, 1);
});

test("adding and removing login items validate against the current system list", async () => {
  const calls = [];
  let loginItems = [];
  const service = createLoginItemService({
    applicationService: applicationStub(),
    run: async (command, args) => {
      calls.push({ command, args });
      if (args.includes("JavaScript")) return { stdout: JSON.stringify(loginItems) };
      if (args.at(-1) === chrome.path && args.some((arg) => String(arg).includes("make new login item"))) {
        loginItems = [{ name: chrome.name, path: chrome.path, hidden: false }];
      }
      if (args.at(-1) === chrome.path && args.some((arg) => String(arg).includes("delete (item 1 of matchingItems)"))) {
        loginItems = [];
      }
      return { stdout: "" };
    }
  });

  await service.addLoginItem(chrome.id);
  await assert.rejects(service.addLoginItem(chrome.id), /已在开机启动列表/);
  await service.removeLoginItem(encodeLoginItemId(loginItems[0]));

  assert.equal(loginItems.length, 0);
  assert.ok(calls.some(({ args }) => args.some((arg) => String(arg).includes("make new login item"))));
  const removeCall = calls.find(({ args }) => args.some((arg) => String(arg).includes("delete (item 1 of matchingItems)")));
  assert.ok(removeCall);
  assert.ok(removeCall.args.some((arg) => String(arg).includes("every login item whose path is targetPath")));
  assert.ok(!removeCall.args.some((arg) => String(arg).includes("delete currentItem")));
});

test("removing a login item translates a stale match into a 404", async () => {
  const missingError = Object.assign(new Error("Command failed"), {
    stderr: "execution error: Login item not found (404)"
  });
  let calls = 0;
  const service = createLoginItemService({
    applicationService: applicationStub(),
    run: async (_command, args) => {
      calls += 1;
      if (args.includes("JavaScript")) {
        return { stdout: JSON.stringify([{ name: chrome.name, path: chrome.path, hidden: false }]) };
      }
      throw missingError;
    }
  });

  await assert.rejects(
    service.removeLoginItem(encodeLoginItemId({ name: chrome.name, path: chrome.path })),
    (error) => error.status === 404 && error.message === "登录项不存在或已被移除"
  );
  assert.equal(calls, 2);
});

test("automation denial returns an actionable access state", async () => {
  const error = Object.assign(new Error("execution error"), { stderr: "Not authorized to send Apple events. (-1743)" });
  const service = createLoginItemService({
    applicationService: applicationStub(),
    run: async () => { throw error; }
  });
  const result = await service.listLoginItems();
  assert.equal(result.access.available, false);
  assert.equal(result.access.requiresAutomation, true);
});
