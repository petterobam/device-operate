import test from "node:test";
import assert from "node:assert/strict";
import {
  buildPermissionModel,
  createApplicationPermissionService,
  parseSqliteJson,
  permissionStatus
} from "../server/application-permissions.js";

const editor = {
  id: "editor-id",
  name: "Editor",
  bundleId: "com.example.editor",
  path: "/Applications/Editor.app",
  iconUrl: "/editor.png",
  system: false,
  declaredPermissions: ["kTCCServiceCamera", "kTCCServiceMicrophone"]
};

function applicationStub() {
  return { async listInstalledApplications() { return [editor]; } };
}

test("TCC authorization values map to stable UI states", () => {
  assert.equal(permissionStatus(2), "granted");
  assert.equal(permissionStatus(0), "denied");
  assert.equal(permissionStatus(3), "limited");
  assert.equal(permissionStatus(null, false), "not-requested");
  assert.deepEqual(parseSqliteJson('[{"service":"kTCCServiceCamera"}]'), [{ service: "kTCCServiceCamera" }]);
});

test("permission model combines TCC decisions with declared but unrequested access", () => {
  const result = buildPermissionModel([editor], [{
    service: "kTCCServiceCamera",
    client: editor.bundleId,
    client_type: 0,
    auth_value: 2,
    auth_reason: 2,
    indirect_object_identifier: "UNUSED",
    last_modified: 1_700_000_000
  }]);

  assert.deepEqual(result.applications[0].permissions.map(({ service, status }) => ({ service, status })).sort((a, b) => a.service.localeCompare(b.service)), [
    { service: "kTCCServiceCamera", status: "granted" },
    { service: "kTCCServiceMicrophone", status: "not-requested" }
  ].sort((a, b) => a.service.localeCompare(b.service)));
  assert.equal(result.summary.granted, 1);
  assert.equal(result.summary.notRequested, 1);
  assert.equal(result.categories.find(({ id }) => id === "camera").count, 1);
});

test("missing full disk access keeps declarations but does not guess their state", async () => {
  const error = Object.assign(new Error("sqlite failed"), { stderr: "authorization denied" });
  const service = createApplicationPermissionService({
    applicationService: applicationStub(),
    run: async () => { throw error; }
  });

  const result = await service.listPermissions();
  assert.equal(result.access.available, false);
  assert.equal(result.access.requiresFullDiskAccess, true);
  assert.ok(result.applications[0].permissions.every(({ status }) => status === "unavailable"));
  assert.equal(result.summary.unavailable, 2);
});

test("reset validates the installed app and invokes tccutil with the public service name", async () => {
  const calls = [];
  const service = createApplicationPermissionService({
    applicationService: applicationStub(),
    run: async (command, args) => {
      calls.push({ command, args });
      return { stdout: "" };
    }
  });

  await service.resetPermission(editor.id, "kTCCServiceCamera");
  assert.deepEqual(calls, [{ command: "tccutil", args: ["reset", "Camera", editor.bundleId] }]);
  await assert.rejects(service.resetPermission("missing", "kTCCServiceCamera"), /应用不存在/);
  await assert.rejects(service.resetPermission(editor.id, "kTCCServiceUnknown"), /不支持重置/);
});
