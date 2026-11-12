import test from "node:test";
import assert from "node:assert/strict";
import { createSystemSettingsService } from "../server/system-settings.js";

test("system settings only opens whitelisted setting IDs", async () => {
  const calls = [];
  const service = createSystemSettingsService({
    run: async (...args) => {
      calls.push(args);
      return {};
    }
  });

  assert.deepEqual(await service.open("battery"), { opened: true, id: "battery" });
  assert.equal(calls.length, 1);
  assert.equal(calls[0][0], "open");
  assert.match(calls[0][1][0], /^x-apple\.systempreferences:/);
  await assert.rejects(() => service.open("javascript:alert(1)"), /不支持的系统设置入口/);
  assert.equal(calls.length, 1);
});
