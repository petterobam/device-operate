// Finds and removes leftovers of uninstalled macOS applications.
//
// Matching is deliberately conservative: a directory is only reported when it
// matches the bundle identifier or the full application name after normalising
// separators. Removing a leftover always goes through the user's Trash.

import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

const SCAN_ROOTS = [
  { id: "application-support", relative: "Library/Application Support", label: "应用支持数据" },
  { id: "caches", relative: "Library/Caches", label: "缓存" },
  { id: "preferences", relative: "Library/Preferences", label: "偏好设置" },
  { id: "logs", relative: "Library/Logs", label: "日志" },
  { id: "saved-state", relative: "Library/Saved Application State", label: "窗口状态" },
  { id: "containers", relative: "Library/Containers", label: "沙盒容器" },
  { id: "group-containers", relative: "Library/Group Containers", label: "共享容器" },
  { id: "http-storage", relative: "Library/HTTPStorages", label: "网络存储" },
  { id: "webkit", relative: "Library/WebKit", label: "网页数据" }
];

const BUNDLE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9-]*(\.[A-Za-z0-9][A-Za-z0-9-]*){1,}$/;

// Tooling and package caches share the resource library with app containers but
// are never "uninstalled application leftovers", so they are excluded from the
// reverse-DNS heuristic.
const NON_APP_KEYS = [
  "msplaywright",
  "electron",
  "cocoapods",
  "nodejs",
  "npm",
  "yarn",
  "pnpm",
  "pip",
  "golang",
  "gomod",
  "cargo",
  "rustup",
  "gradle",
  "maven",
  "homebrew",
  "xcode",
  "coresimulator",
  "swiftpm",
  "cloudkit",
  "comapple",
  "comgooglecode",
  "chromium",
  "puppeteer",
  "playwright"
];

const NON_APP_SUFFIXES = ["-cache", "_cache", ".cache", "-logs", ".log"];

export function looksLikeApplicationContainer(name = "") {
  const raw = String(name).replace(/\.plist$/i, "").replace(/\.savedState$/i, "").trim();
  if (!raw) return false;
  const lower = raw.toLowerCase();
  if (NON_APP_SUFFIXES.some((suffix) => lower.endsWith(suffix))) return false;
  const key = normalizeKey(raw);
  if (NON_APP_KEYS.some((blocked) => key.includes(blocked))) return false;
  // A leftover app container practically always uses reverse-DNS naming.
  return /^(?:[A-Za-z0-9-]+\.){2,}[A-Za-z0-9-]+$/.test(raw);
}

function serviceError(message, status = 400) {
  return Object.assign(new Error(message), { status });
}

/** Normalises names so "Google Chrome" and "com.google.Chrome" can be compared. */
export function normalizeKey(value = "") {
  return String(value).toLowerCase().replace(/[^a-z0-9]/g, "");
}

export function isBundleIdentifier(value = "") {
  return BUNDLE_PATTERN.test(String(value).trim());
}

export function matchesApplication(name, bundleId, candidate) {
  const target = normalizeKey(candidate);
  if (!target || target.length < 5) return false;
  const normalizedBundle = normalizeKey(bundleId);
  const normalizedName = normalizeKey(name);
  if (normalizedBundle && target === normalizedBundle) return true;
  if (normalizedBundle && normalizedBundle.length >= 8 && target.startsWith(normalizedBundle)) return true;
  if (normalizedName && normalizedName.length >= 5 && target === normalizedName) return true;
  return false;
}

export function createUninstallCleanupService({
  applicationService,
  storageService,
  homeDir = os.homedir(),
  run = execFileAsync
} = {}) {
  const libraryRoot = path.join(homeDir, "Library");

  function assertInsideLibrary(target) {
    const resolved = path.resolve(target);
    const root = path.resolve(libraryRoot);
    if (resolved !== root && !resolved.startsWith(`${root}${path.sep}`)) {
      throw serviceError("只允许清理用户资源库中的残留文件", 403);
    }
    if (resolved === root) throw serviceError("不能删除资源库根目录", 403);
    return resolved;
  }

  async function directorySize(target) {
    const result = await run("du", ["-sk", target], { timeout: 20_000, maxBuffer: 512 * 1024 }).catch(() => ({ stdout: "" }));
    const kb = Number(String(result.stdout).trim().split(/\s+/)[0]);
    return Number.isFinite(kb) ? kb * 1024 : null;
  }

  const installCache = new Map();

  /**
   * Spotlight knows about applications outside /Applications (PlayCover,
   * ~/Applications, external volumes). A container is only a leftover when no
   * live bundle claims that identifier.
   */
  async function isBundleInstalled(bundleId) {
    const identifier = String(bundleId || "").trim();
    if (!identifier || !identifier.includes(".")) return null;
    if (installCache.has(identifier)) return installCache.get(identifier);
    const result = await run("mdfind", [`kMDItemCFBundleIdentifier == '${identifier}'`], { timeout: 10_000, maxBuffer: 512 * 1024 })
      .catch(() => ({ stdout: "" }));
    const paths = String(result.stdout).split("\n").map((line) => line.trim()).filter(Boolean);
    let installed = false;
    for (const candidate of paths) {
      if (candidate.endsWith(".app") && await fs.access(candidate).then(() => true, () => false)) {
        installed = true;
        break;
      }
    }
    installCache.set(identifier, installed);
    return installed;
  }

  function bundleIdentifierFromContainerName(name = "") {
    const raw = String(name).replace(/\.plist$/i, "").replace(/\.savedState$/i, "").trim();
    const match = raw.match(/((?:[A-Za-z0-9-]+\.){2,}[A-Za-z0-9-]+)/);
    return match ? match[1] : "";
  }

  async function scanCandidates() {
    const entries = [];
    for (const root of SCAN_ROOTS) {
      const absoluteRoot = path.join(homeDir, root.relative);
      let names = [];
      try {
        names = await fs.readdir(absoluteRoot);
      } catch {
        continue;
      }
      for (const name of names) {
        entries.push({ root, name, fullPath: path.join(absoluteRoot, name) });
      }
    }
    return entries;
  }

  async function scanApplication({ name, bundleId, appPath } = {}) {
    const displayName = String(name || "").trim();
    const identifier = String(bundleId || "").trim();
    if (!displayName && !identifier) throw serviceError("需要提供应用名称或 Bundle ID");

    const candidates = await scanCandidates();
    const matched = candidates.filter((candidate) => {
      const base = candidate.name.replace(/\.plist$/i, "").replace(/\.savedState$/i, "");
      return matchesApplication(displayName, identifier, base)
        || (identifier && base.toLowerCase().startsWith(identifier.toLowerCase()) && identifier.includes("."));
    });

    const leftovers = [];
    for (const item of matched) {
      leftovers.push({
        id: Buffer.from(item.fullPath).toString("base64url"),
        path: item.fullPath,
        name: item.name,
        category: item.root.id,
        categoryLabel: item.root.label,
        bytes: await directorySize(item.fullPath)
      });
    }
    leftovers.sort((first, second) => (second.bytes || 0) - (first.bytes || 0));

    return {
      application: { name: displayName, bundleId: identifier, appPath: appPath || "" },
      leftovers,
      totalBytes: leftovers.reduce((total, item) => total + (item.bytes || 0), 0),
      scannedRoots: SCAN_ROOTS.length,
      scannedAt: new Date().toISOString()
    };
  }

  async function listUninstalledLeftovers({ limit = 25 } = {}) {
    const applications = await applicationService.listInstalledApplications();
    const installedKeys = new Set();
    for (const application of applications) {
      const bundle = normalizeKey(application.bundleId);
      const name = normalizeKey(application.name);
      if (bundle) installedKeys.add(bundle);
      if (name) installedKeys.add(name);
    }

    const grouped = new Map();
    for (const candidate of await scanCandidates()) {
      const base = candidate.name.replace(/\.plist$/i, "").replace(/\.savedState$/i, "");
      if (!looksLikeApplicationContainer(base)) continue;
      const key = normalizeKey(base);
      if (!key || key.length < 6) continue;
      let owned = false;
      for (const installed of installedKeys) {
        if (key === installed || key.startsWith(installed) || installed.startsWith(key)) {
          owned = true;
          break;
        }
      }
      if (owned) continue;
      const bundleId = bundleIdentifierFromContainerName(base);
      if (bundleId && await isBundleInstalled(bundleId)) continue;
      const groupKey = `${candidate.root.id}:${key}`;
      const existing = grouped.get(groupKey) || {
        id: groupKey,
        label: candidate.name,
        category: candidate.root.id,
        categoryLabel: candidate.root.label,
        paths: [],
        bytes: 0
      };
      existing.paths.push(candidate.fullPath);
      grouped.set(groupKey, existing);
    }

    const orphans = await Promise.all([...grouped.values()].map(async (item) => {
      const sizes = await Promise.all(item.paths.map((target) => directorySize(target)));
      return { ...item, bytes: sizes.reduce((total, size) => total + (size || 0), 0) };
    }));
    orphans.sort((first, second) => second.bytes - first.bytes);
    return {
      installedApplicationCount: applications.length,
      orphans: orphans.slice(0, Math.max(1, Math.min(200, Number(limit) || 25))),
      totalBytes: orphans.reduce((total, item) => total + item.bytes, 0),
      candidateCount: orphans.length,
      scannedAt: new Date().toISOString(),
      note: "只按目录名与已安装应用的名称/Bundle ID 比对，可能包含同名但独立的数据；删除前请确认。"
    };
  }

  async function trashLeftovers({ paths } = {}) {
    const list = Array.isArray(paths) ? [...new Set(paths.filter((item) => typeof item === "string" && item.trim()))] : [];
    if (!list.length) throw serviceError("请选择要清理的残留路径");
    const trashed = [];
    const errors = [];
    for (const target of list) {
      try {
        const safePath = assertInsideLibrary(target);
        if (storageService?.trashItem) {
          await storageService.trashItem(safePath);
        } else {
          await run("osascript", ["-e", `tell application "Finder" to delete POSIX file "${safePath.replace(/"/g, '\\"')}"`], { timeout: 20_000 });
        }
        trashed.push({ path: safePath });
      } catch (error) {
        errors.push({ path: target, error: error.message });
      }
    }
    return { trashed, errors, trashedCount: trashed.length, errorCount: errors.length };
  }

  return { scanApplication, listUninstalledLeftovers, trashLeftovers, libraryRoot };
}
