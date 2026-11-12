import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createNetworkMonitorService } from "../server/network-monitor.js";

const LSOF = `p689
cstable
f35
PTCP
n192.168.1.20:54272->34.117.41.85:443
TST=ESTABLISHED
p700
cserver
f10
PTCP
n*:8080
TST=LISTEN
f11
PTCP
n192.168.1.20:8080->8.8.8.8:50000
TST=ESTABLISHED
`;

test("network monitor service initialises, scans and persists privacy config", async () => {
  const configDir = await fs.mkdtemp(path.join(os.tmpdir(), "device-operate-network-"));
  try {
    let scans = 0;
    const service = createNetworkMonitorService({
      configDir,
      intervalMs: 5_000,
      run: async (command, args) => {
        if (command === "ps" && args.includes("pid=,comm=")) {
          return { stdout: "689 /Applications/Warp.app/Contents/MacOS/stable\n700 /Applications/Server.app/Contents/MacOS/server\n" };
        }
        if (command === "ps") return { stdout: "" };
        if (command === "lsof") {
          scans += 1;
          return { stdout: LSOF.replace("54272", String(54272 + scans)) };
        }
        return { stdout: "" };
      }
    });
    await service.updateConfig({ geolocationEnabled: false, retentionMinutes: 12 });
    const snapshot = await service.refresh();
    assert.equal(snapshot.scanning, false);
    assert.equal(snapshot.summary.outbound, 1);
    assert.equal(snapshot.summary.inbound, 1);
    assert.equal(snapshot.summary.listeners, 1);
    assert.equal(snapshot.applications.find((entry) => entry.name === "Warp").outbound, 1);
    assert.equal(snapshot.connections[0].applicationName, "Warp");
    assert.equal(snapshot.config.geolocationEnabled, false);
    assert.equal(snapshot.config.retentionMinutes, 12);
    const second = await service.refresh();
    assert.equal(second.summary.outbound, 1, "ephemeral source ports must not create duplicate destinations");
    assert.equal(second.connections.filter((flow) => flow.applicationName === "Warp").length, 1);
    const saved = JSON.parse(await fs.readFile(path.join(configDir, "network-monitor-config.json"), "utf8"));
    assert.equal(saved.geolocationEnabled, false);
    assert.equal(saved.retentionMinutes, 12);
  } finally {
    await fs.rm(configDir, { recursive: true, force: true });
  }
});
