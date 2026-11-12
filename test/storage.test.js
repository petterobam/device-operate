import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { classifyStorageItem, createStorageService, isPathInside, parseDiskutilInfo, parseDuSize } from "../server/storage.js";

test("storage path checks reject sibling prefixes", () => {
  assert.equal(isPathInside("/Users/demo/Documents/report.pdf", "/Users/demo"), true);
  assert.equal(isPathInside("/Users/demo-old/report.pdf", "/Users/demo"), false);
});

test("du output is converted from KiB to bytes", () => {
  assert.equal(parseDuSize("2048\t/tmp/example\n"), 2 * 1024 * 1024);
  assert.equal(parseDuSize("du: unreadable"), 0);
});

test("diskutil output exposes native volume details", () => {
  const info = parseDiskutilInfo(`
   Volume Name:               Macintosh HD
   Mount Point:               /
   File System Personality:   APFS
   Protocol:                  Apple Fabric
   Internal:                  Yes
   Solid State:               Yes
  `);
  assert.deepEqual(info, {
    name: "Macintosh HD",
    mountPoint: "/",
    fileSystem: "APFS",
    protocol: "Apple Fabric",
    internal: true,
    solidState: true
  });
});

test("overview combines statfs capacity with scanned categories", async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "storage-overview-"));
  try {
    await fs.mkdir(path.join(tempDir, "Documents"), { recursive: true });
    const service = createStorageService({
      homeDir: tempDir,
      platform: "linux",
      statfs: async () => ({ blocks: 1_000, bavail: 250, bsize: 1_024 }),
      directorySize: async (targetPath) => (targetPath.endsWith("Documents") ? 100 * 1_024 : 0),
      now: () => Date.parse("2026-07-26T08:00:00.000Z")
    });

    const overview = await service.getOverview();
    assert.equal(overview.volume.total, 1_024_000);
    assert.equal(overview.volume.available, 256_000);
    assert.equal(overview.volume.usedPercent, 75);
    assert.equal(overview.categories.find(({ id }) => id === "documents").size, 102_400);
    assert.ok(overview.categories.find(({ id }) => id === "system-other").size > 0);
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
});

test("concurrent overview requests share one directory scan", async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "storage-overview-inflight-"));
  try {
    const documents = path.join(tempDir, "Documents");
    await fs.mkdir(documents, { recursive: true });
    const scannedPaths = [];
    const service = createStorageService({
      homeDir: tempDir,
      platform: "linux",
      statfs: async () => ({ blocks: 1_000, bavail: 500, bsize: 1_024 }),
      directorySize: async (targetPath) => {
        scannedPaths.push(targetPath);
        await new Promise((resolve) => setTimeout(resolve, 10));
        return 100;
      }
    });

    const [first, second] = await Promise.all([service.getOverview(), service.getOverview()]);
    assert.equal(scannedPaths.filter((targetPath) => targetPath === documents).length, 1);
    assert.equal(scannedPaths.length, new Set(scannedPaths).size);
    assert.deepEqual(first, second);
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
});

test("cleanup suggestions reuse the server snapshot until an explicit refresh", async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "storage-cleanup-cache-"));
  try {
    const caches = path.join(tempDir, "Library", "Caches");
    await fs.mkdir(caches, { recursive: true });
    let scans = 0;
    const service = createStorageService({
      homeDir: tempDir,
      platform: "linux",
      listDirectorySizes: async (targetPath) => {
        scans += 1;
        return [{ path: targetPath, size: 100 }];
      }
    });

    await service.getCleanupSuggestions();
    await service.getCleanupSuggestions();
    assert.equal(scans, 1);
    await service.getCleanupSuggestions({ fresh: true });
    assert.equal(scans, 2);
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
});

test("storage refresh starts in the background and exposes completion status", async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "storage-background-refresh-"));
  try {
    const documents = path.join(tempDir, "Documents");
    await fs.mkdir(documents, { recursive: true });
    let releaseScan;
    const scanGate = new Promise((resolve) => {
      releaseScan = resolve;
    });
    const service = createStorageService({
      homeDir: tempDir,
      platform: "linux",
      statfs: async () => ({ blocks: 1_000, bavail: 500, bsize: 1_024 }),
      directorySize: async () => {
        await scanGate;
        return 100;
      }
    });

    const started = service.startRefresh();
    assert.equal(started.state, "running");
    assert.equal(started.phase, "base");
    assert.equal(started.baseCompletedAt, "");
    assert.equal(service.startRefresh().id, started.id);

    releaseScan();
    let status = service.getRefreshStatus(started.id);
    for (let attempts = 0; attempts < 20 && status.state === "running"; attempts += 1) {
      await new Promise((resolve) => setTimeout(resolve, 10));
      status = service.getRefreshStatus(started.id);
    }
    assert.equal(status.state, "complete");
    assert.ok(status.baseCompletedAt);
    assert.ok(status.completedAt);
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
});

test("large file preview returns before directory aggregation", async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "storage-large-file-preview-"));
  try {
    const downloads = path.join(tempDir, "Downloads");
    const largeFile = path.join(downloads, "archive.bin");
    await fs.mkdir(downloads, { recursive: true });
    await fs.writeFile(largeFile, "");
    await fs.truncate(largeFile, 101 * 1024 ** 2);
    const service = createStorageService({
      homeDir: tempDir,
      platform: "linux",
      listDirectorySizes: async () => {
        throw new Error("directory aggregation must not run for a file preview");
      }
    });

    const preview = await service.getLargeFilePreview();
    assert.equal(preview.files.length, 1);
    assert.equal(preview.files[0].path, largeFile);
    assert.equal(preview.threshold, 100 * 1024 ** 2);
    assert.ok(preview.scannedAt);
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
});

test("large user items move to a collision-safe Trash path", async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "storage-trash-"));
  try {
    const downloads = path.join(tempDir, "Downloads");
    const trash = path.join(tempDir, ".Trash");
    await fs.mkdir(downloads, { recursive: true });
    await fs.mkdir(trash, { recursive: true });
    const target = path.join(downloads, "archive.zip");
    await fs.writeFile(target, "new");
    await fs.writeFile(path.join(trash, "archive.zip"), "existing");
    const service = createStorageService({ homeDir: tempDir, platform: "linux" });

    const result = await service.trashItem(target);
    assert.equal(result.trashedTo, path.join(trash, "archive 2.zip"));
    assert.equal(await fs.readFile(result.trashedTo, "utf8"), "new");
    await assert.rejects(() => service.trashItem(downloads), /不能删除系统保留目录/);
    await assert.rejects(() => service.trashItem(path.join(tempDir, "..", "outside.txt")), /只能管理当前用户目录/);
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
});

test("storage actions reject paths that escape through a directory symlink", async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "storage-symlink-home-"));
  const outsideDir = await fs.mkdtemp(path.join(os.tmpdir(), "storage-symlink-outside-"));
  try {
    await fs.mkdir(path.join(tempDir, "Downloads"), { recursive: true });
    await fs.writeFile(path.join(outsideDir, "private.txt"), "private");
    await fs.symlink(outsideDir, path.join(tempDir, "Downloads", "outside"));
    const service = createStorageService({ homeDir: tempDir, platform: "linux" });

    await assert.rejects(
      () => service.inspectItem(path.join(tempDir, "Downloads", "outside", "private.txt")),
      /符号链接指向当前用户目录之外/
    );
    assert.equal(await fs.readFile(path.join(outsideDir, "private.txt"), "utf8"), "private");
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
    await fs.rm(outsideDir, { recursive: true, force: true });
  }
});

test("cleanup only accepts catalogued categories", async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "storage-cleanup-"));
  try {
    const caches = path.join(tempDir, "Library", "Caches");
    await fs.mkdir(caches, { recursive: true });
    await fs.writeFile(path.join(caches, "cache.data"), "cached");
    const service = createStorageService({
      homeDir: tempDir,
      platform: "linux",
      directorySize: async (targetPath) => (targetPath === caches ? 6 : 0)
    });

    const result = await service.cleanCategory("caches");
    assert.equal(result.removed, 1);
    assert.equal(result.reclaimed, 6);
    assert.deepEqual(await fs.readdir(caches), []);
    await assert.rejects(() => service.cleanCategory("Documents"), /未知的清理项目/);
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
});

test("large storage items expose source category, directory group and risk", () => {
  const homeDir = "/Users/demo";
  const cache = classifyStorageItem("/Users/demo/Library/Application Support/Code/Cache/blob", { homeDir });
  assert.equal(cache.category, "cache");
  assert.equal(cache.risk, "low");
  assert.match(cache.group.label, /应用数据/);

  const source = classifyStorageItem("/Users/demo/WorkSpace/AI/影视资源/知识库原始数据.zip", { homeDir });
  assert.equal(source.category, "work-content");
  assert.equal(source.risk, "high");

  const derived = classifyStorageItem("/Users/demo/Library/Developer/Xcode/DerivedData/App/Build", { homeDir, kind: "directory" });
  assert.equal(derived.category, "developer-build");
  assert.equal(derived.risk, "low");
});

test("cleanup suggestions include an inspectable directory tree", async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "storage-tree-"));
  try {
    const cacheDir = path.join(tempDir, "Library", "Caches");
    const chromeDir = path.join(cacheDir, "Google", "Chrome");
    await fs.mkdir(chromeDir, { recursive: true });
    await fs.writeFile(path.join(chromeDir, "cache.bin"), "cache");
    const service = createStorageService({
      homeDir: tempDir,
      platform: "linux",
      directorySize: async (targetPath) => targetPath === cacheDir ? 500 : 0,
      listDirectorySizes: async (targetPath) => targetPath === cacheDir
        ? [{ path: cacheDir, size: 500 }, { path: chromeDir, size: 500 }]
        : []
    });

    const item = (await service.getCleanupSuggestions()).find(({ id }) => id === "caches");
    assert.equal(item.available, true);
    assert.equal(item.tree[0].path, cacheDir);
    assert.equal(item.tree[0].children[0].name, "Google");
    assert.equal(item.risk, "low");
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
});

test("batch trash moves unique items and leaves a second request as a miss", async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "storage-batch-"));
  try {
    const downloads = path.join(tempDir, "Downloads");
    await fs.mkdir(downloads, { recursive: true });
    const first = path.join(downloads, "one.zip");
    const second = path.join(downloads, "two.zip");
    await fs.writeFile(first, "one");
    await fs.writeFile(second, "two");
    const service = createStorageService({ homeDir: tempDir, platform: "linux" });

    const result = await service.trashItems([first, second, first]);
    assert.equal(result.removed, 2);
    assert.equal(result.errors.length, 0);
    await assert.rejects(() => service.trashItem(first), /文件或目录不存在/);
    assert.equal((await fs.readdir(path.join(tempDir, ".Trash"))).length, 2);
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
});

test("Xcode cleanup suggestions group Archives by project and recommend keeping the newest one", async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "storage-xcode-archives-"));
  try {
    const archivesRoot = path.join(tempDir, "Library", "Developer", "Xcode", "Archives");
    const derivedRoot = path.join(tempDir, "Library", "Developer", "Xcode", "DerivedData");
    const oldArchive = path.join(archivesRoot, "2026-07-30", "Demo 2026-07-30.xcarchive");
    const latestArchive = path.join(archivesRoot, "2026-07-31", "Demo 2026-07-31.xcarchive");
    await fs.mkdir(oldArchive, { recursive: true });
    await fs.mkdir(latestArchive, { recursive: true });
    await fs.writeFile(path.join(oldArchive, "payload.bin"), "old");
    await fs.writeFile(path.join(latestArchive, "payload.bin"), "latest");
    await fs.mkdir(path.join(derivedRoot, "Demo-abc123"), { recursive: true });
    await fs.mkdir(path.join(derivedRoot, "Other-def456"), { recursive: true });
    const oldTime = new Date("2026-07-30T10:00:00.000Z");
    const latestTime = new Date("2026-07-31T10:00:00.000Z");
    await fs.utimes(oldArchive, oldTime, oldTime);
    await fs.utimes(latestArchive, latestTime, latestTime);
    const service = createStorageService({
      homeDir: tempDir,
      platform: "linux",
      statfs: async () => ({ blocks: 1_000, bavail: 500, bsize: 1_024 }),
      directorySize: async (targetPath) => (targetPath.endsWith(".xcarchive") ? 100 : targetPath.includes("DerivedData") ? 200 : 0)
    });

    const suggestions = await service.getCleanupSuggestions();
    const archives = suggestions.find(({ id }) => id === "xcode-archives");
    const derived = suggestions.find(({ id }) => id === "xcode-derived-data");
    assert.equal(archives.selectionItems.length, 2);
    assert.deepEqual(archives.recommendedPaths, [oldArchive]);
    assert.equal(archives.tree[0].children.length, 1);
    assert.equal(archives.tree[0].children[0].children.length, 2);
    assert.equal(archives.tree[0].children[0].children.find((entry) => entry.path === latestArchive).keepLatest, true);
    assert.equal(derived.selectionItems.length, 2);
    assert.deepEqual(derived.recommendedPaths, []);

    const result = await service.cleanCategoryItems("xcode-archives", [oldArchive]);
    assert.equal(result.removed, 1);
    assert.equal(result.movedToTrash, true);
    await assert.rejects(() => fs.access(oldArchive));
    await assert.rejects(() => service.cleanCategoryItems("xcode-archives", [archivesRoot]), /不属于该清理项目/);
    await assert.rejects(() => service.cleanCategory("xcode-archives"), /需要先选择具体目录/);
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
});

test("Xcode DerivedData groups duplicate project names and recommends only stale shells and missing workspaces", async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "storage-xcode-derived-"));
  try {
    const derivedRoot = path.join(tempDir, "Library", "Developer", "Xcode", "DerivedData");
    const activeWorkspace = path.join(tempDir, "Projects", "Demo", "Demo.xcodeproj");
    const missingWorkspace = path.join(tempDir, "Temporary", "Demo.xcodeproj");
    const active = path.join(derivedRoot, "Demo-aaaaaaaaaaaaaaaaaaaaaaaaaaaa");
    const stale = path.join(derivedRoot, "Demo-bbbbbbbbbbbbbbbbbbbbbbbbbbbb");
    const shell = path.join(derivedRoot, "Demo-cccccccccccccccccccccccccccc");
    const other = path.join(derivedRoot, "Other-dddddddddddddddddddddddddddd");
    const shared = path.join(derivedRoot, "ModuleCache.noindex");
    await fs.mkdir(activeWorkspace, { recursive: true });
    await fs.mkdir(path.join(active, "Build"), { recursive: true });
    await fs.mkdir(path.join(stale, "Build"), { recursive: true });
    await fs.mkdir(path.join(shell, "Logs"), { recursive: true });
    await fs.mkdir(path.join(shell, "TestResults"), { recursive: true });
    await fs.mkdir(other, { recursive: true });
    await fs.mkdir(shared, { recursive: true });
    await fs.writeFile(path.join(active, "info.plist"), "active");
    await fs.writeFile(path.join(stale, "info.plist"), "stale");

    const service = createStorageService({
      homeDir: tempDir,
      platform: "darwin",
      directorySize: async (targetPath) => targetPath === active ? 1_000 : 100,
      listDirectorySizes: async () => [],
      runCommand: async (command, args) => {
        assert.equal(command, "plutil");
        const infoPath = args.at(-1);
        const WorkspacePath = infoPath === path.join(active, "info.plist") ? activeWorkspace : missingWorkspace;
        return { stdout: JSON.stringify({ WorkspacePath }) };
      }
    });

    const derived = (await service.getCleanupSuggestions()).find(({ id }) => id === "xcode-derived-data");
    assert.equal(derived.selectionItems.length, 5);
    assert.deepEqual(new Set(derived.recommendedPaths), new Set([stale, shell]));
    const demoGroup = derived.tree[0].children.find((entry) => entry.label === "Demo");
    assert.equal(demoGroup.virtual, true);
    assert.equal(demoGroup.children.length, 3);
    assert.equal(demoGroup.children.find((entry) => entry.path === active).keepLatest, true);
    assert.equal(demoGroup.children.find((entry) => entry.path === stale).workspaceExists, false);
    assert.equal(demoGroup.children.find((entry) => entry.path === shell).orphanedShell, true);
    assert.equal(derived.selectionItems.find((entry) => entry.path === shared).recommended, false);
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
});

test("cached path checks are lightweight, bounded to the home directory, and report missing entries", async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "storage-path-check-"));
  const outsideDir = await fs.mkdtemp(path.join(os.tmpdir(), "storage-path-check-outside-"));
  try {
    const existing = path.join(tempDir, "Library", "Developer", "Xcode", "DerivedData", "Demo");
    const missing = path.join(tempDir, "Library", "Developer", "Xcode", "DerivedData", "Gone");
    const outside = path.join(outsideDir, "private");
    await fs.mkdir(existing, { recursive: true });
    await fs.writeFile(outside, "private");
    const service = createStorageService({ homeDir: tempDir, platform: "linux" });

    const result = await service.checkPathsExist([existing, missing, outside, "relative/path"]);
    assert.deepEqual(result.existing, [existing]);
    assert.deepEqual(result.missing, [missing, outside, "relative/path"]);
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
    await fs.rm(outsideDir, { recursive: true, force: true });
  }
});
