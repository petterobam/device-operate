import test from "node:test";
import assert from "node:assert/strict";
import { createFileAssociationService, FILE_TYPE_CATALOG } from "../server/file-associations.js";

const quickTime = {
  id: "quicktime",
  name: "QuickTime Player",
  bundleId: "com.apple.QuickTimePlayerX",
  path: "/System/Applications/QuickTime Player.app",
  iconUrl: "/quicktime.png",
  system: true
};

function createApplicationStub() {
  return {
    async listInstalledApplications() {
      return [quickTime];
    }
  };
}

test("file associations map installed handlers and flag removed defaults", async () => {
  const service = createFileAssociationService({
    applicationService: createApplicationStub(),
    helperPath: process.execPath,
    runHelper: async (args) => ({
      ok: true,
      types: args.slice(1).map((extension) => ({
        extension,
        uti: `public.${extension}`,
        defaultHandler: extension === "mp4" ? "missing.video.player" : "com.apple.QuickTimePlayerX",
        handlers: ["com.apple.QuickTimePlayerX"]
      }))
    })
  });

  const result = await service.listFileAssociations();
  const mp4 = result.types.find(({ id }) => id === "mp4");
  const mov = result.types.find(({ id }) => id === "mov");

  assert.equal(result.types.length, FILE_TYPE_CATALOG.length);
  assert.equal(mp4.handlerMissing, true);
  assert.equal(mp4.defaultApplication, null);
  assert.equal(mp4.compatibleApplications[0].name, "QuickTime Player");
  assert.equal(mov.handlerMissing, false);
  assert.equal(mov.defaultApplication.name, "QuickTime Player");
  assert.equal(result.summary.missing, 1);
});

test("changing a default validates the app and writes the resolved UTI", async () => {
  const calls = [];
  const service = createFileAssociationService({
    applicationService: createApplicationStub(),
    helperPath: process.execPath,
    runHelper: async (args) => {
      calls.push(args);
      if (args[0] === "get") {
        return { ok: true, types: [{ extension: args[1], uti: "public.mpeg-4", handlers: [] }] };
      }
      return { ok: true };
    }
  });

  const result = await service.setDefaultApplication("mp4", quickTime.bundleId);

  assert.equal(result.application.name, "QuickTime Player");
  assert.deepEqual(calls, [
    ["get", "mp4"],
    ["set", "public.mpeg-4", "com.apple.QuickTimePlayerX"]
  ]);
});
