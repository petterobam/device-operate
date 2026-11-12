import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  createBackupService,
  parseBackupDates,
  parseBackupStatus,
  parseDestinations,
  parseLocalSnapshots,
  redactConfig
} from "../server/backup-service.js";
import {
  createUninstallCleanupService,
  isBundleIdentifier,
  matchesApplication,
  normalizeKey
} from "../server/uninstall-cleanup.js";

test("Time Machine destination output is parsed", () => {
  const parsed = parseDestinations(`Name          : Backup Disk
Kind          : Disk
ID            : 1234-5678
Mount Point   : /Volumes/Backup
`);
  assert.equal(parsed.configured, true);
  assert.equal(parsed.destinations.length, 1);
  assert.equal(parsed.destinations[0].name, "Backup Disk");
  assert.equal(parsed.destinations[0].mountPoint, "/Volumes/Backup");
});

test("no configured destination is reported", () => {
  const parsed = parseDestinations("tmutil: No destinations configured.");
  assert.equal(parsed.configured, false);
  assert.equal(parsed.destinations.length, 0);
});

test("local snapshots are parsed and sorted newest first", () => {
  const snapshots = parseLocalSnapshots(`Snapshots for disk /:
com.apple.TimeMachine.2026-10-10-090000.local
com.apple.TimeMachine.2026-10-15-180000.local
`);
  assert.equal(snapshots.length, 2);
  assert.equal(snapshots[0].name, "com.apple.TimeMachine.2026-10-15-180000.local");
  assert.equal(snapshots[0].createdAt, "2026-10-15 18:00:00");
});

test("backup status and dates are parsed", () => {
  const status = parseBackupStatus(`Backup session status:
{
    ClientID = "com.apple.backupd";
    Percent = "42.5";
    Running = 1;
    BackupPhase = "Copying";
}`);
  assert.equal(status.running, true);
  assert.equal(status.percent, 42.5);

  const dates = parseBackupDates("2026-10-10-090000\n2026-10-15-180000\nnoise\n");
  assert.deepEqual(dates, ["2026-10-15-180000", "2026-10-10-090000"]);
});

test("configuration export redacts credential-looking lines", () => {
  const config = `Host github.com
  HostName github.com
  IdentityFile ~/.ssh/id_ed25519
  User git
`;
  const redacted = redactConfig(config, "ssh-config");
  assert.match(redacted, /HostName github\.com/);
  assert.match(redacted, /IdentityFile = "<redacted>"/);
  assert.doesNotMatch(redacted, /id_ed25519/);
});

test("configuration export and import round-trips files", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "device-operate-backup-"));
  await fs.mkdir(path.join(home, ".config", "device-operate"), { recursive: true });
  await fs.writeFile(path.join(home, ".config", "device-operate", "task-metadata.json"), '{"launchd:x":{"alias":"A"}}', "utf8");

  const service = createBackupService({ homeDir: home });
  const exported = await service.exportConfig();
  assert.equal(exported.bundle.format, "device-operate-config");
  assert.ok(exported.bundle.files.some((file) => file.id === "task-metadata"));

  await fs.writeFile(path.join(home, ".config", "device-operate", "task-metadata.json"), "{}", "utf8");
  const imported = await service.importConfig({ bundle: exported.bundle });
  assert.equal(imported.applied.length, exported.bundle.files.length);
  const restored = await fs.readFile(path.join(home, ".config", "device-operate", "task-metadata.json"), "utf8");
  assert.match(restored, /"alias":"A"/);

  await fs.rm(home, { recursive: true, force: true });
});

test("leftover matching recognises bundle ids and app names", () => {
  assert.equal(normalizeKey("com.google.Chrome"), "comgooglechrome");
  assert.equal(isBundleIdentifier("com.google.Chrome"), true);
  assert.equal(isBundleIdentifier("Google Chrome"), false);
  assert.equal(matchesApplication("Google Chrome", "com.google.Chrome", "com.google.Chrome"), true);
  assert.equal(matchesApplication("Google Chrome", "com.google.Chrome", "Google Chrome"), true);
  assert.equal(matchesApplication("Google Chrome", "com.google.Chrome", "com.google.Chrome.helper"), true);
  assert.equal(matchesApplication("Google Chrome", "com.google.Chrome", "Slack"), false);
});

test("leftover scan finds only files outside the installed application set", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "device-operate-leftover-"));
  await fs.mkdir(path.join(home, "Library", "Application Support"), { recursive: true });
  await fs.mkdir(path.join(home, "Library", "Caches"), { recursive: true });
  await fs.mkdir(path.join(home, "Library", "Application Support", "com.acme.Removed"), { recursive: true });
  await fs.mkdir(path.join(home, "Library", "Caches", "com.google.Chrome"), { recursive: true });
  await fs.writeFile(path.join(home, "Library", "Application Support", "com.acme.Removed", "data.bin"), "x".repeat(2048), "utf8");

  const service = createUninstallCleanupService({
    homeDir: home,
    applicationService: {
      listInstalledApplications: async () => [
        { name: "Google Chrome", bundleId: "com.google.Chrome" }
      ]
    },
    run: async (command, args) => {
      if (command === "du") return { stdout: `${Math.ceil(1024)}\t${args[1]}\n` };
      return { stdout: "" };
    }
  });

  const result = await service.listUninstalledLeftovers({ limit: 10 });
  assert.equal(result.installedApplicationCount, 1);
  assert.ok(result.orphans.some((item) => item.label === "com.acme.Removed"));
  assert.ok(!result.orphans.some((item) => item.label === "com.google.Chrome"), "installed app data must not be reported");

  const scan = await service.scanApplication({ name: "Removed", bundleId: "com.acme.Removed" });
  assert.ok(scan.leftovers.length >= 1);
  assert.match(scan.leftovers[0].path, /Library\//);

  await fs.rm(home, { recursive: true, force: true });
});

test("leftover removal refuses paths outside the user library", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "device-operate-leftover-guard-"));
  const service = createUninstallCleanupService({
    homeDir: home,
    applicationService: { listInstalledApplications: async () => [] },
    storageService: { trashItem: async () => { throw new Error("should not be reached"); } },
    run: async () => ({ stdout: "" })
  });

  const result = await service.trashLeftovers({ paths: ["/Applications/Something.app", path.join(home, "Documents", "x")] });
  assert.equal(result.trashedCount, 0);
  assert.equal(result.errorCount, 2);
  assert.ok(result.errors.every((entry) => /资源库/.test(entry.error)));

  await fs.rm(home, { recursive: true, force: true });
});
