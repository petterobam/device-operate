import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const MIB = 1024 ** 2;
const OVERVIEW_TTL_MS = 5 * 60_000;
const CLEANUP_TTL_MS = 10 * 60_000;
const ANALYSIS_TTL_MS = 10 * 60_000;
const DIRECTORY_SIZE_TTL_MS = 120_000;
const DEFAULT_LARGE_FILE_SIZE = 100 * MIB;
const MAX_SCAN_ENTRIES = 120_000;
const MAX_CLEANUP_TREE_ITEMS = 80;
const XCODE_SHARED_CACHE_NAMES = new Set([
  "CompilationCache.noindex",
  "ModuleCache.noindex",
  "SDKStatCaches.noindex"
]);

const CATEGORY_DEFINITIONS = [
  { id: "applications", label: "应用", color: "#2878b8", locations: ["/Applications", "Applications"] },
  { id: "documents", label: "文稿", color: "#e2a43a", locations: ["Documents", "Desktop"] },
  { id: "downloads", label: "下载", color: "#d75b52", locations: ["Downloads"] },
  { id: "photos", label: "照片", color: "#63a05b", locations: ["Pictures"] },
  { id: "media", label: "影音", color: "#8b6bb2", locations: ["Movies", "Music"] },
  { id: "developer", label: "开发者", color: "#477c78", locations: ["Library/Developer"] },
  { id: "messages", label: "邮件与信息", color: "#bc6b92", locations: ["Library/Mail", "Library/Messages"] },
  { id: "cloud", label: "云端文件", color: "#5f8fc5", locations: ["Library/Mobile Documents"] }
];

function errorWithStatus(message, status) {
  return Object.assign(new Error(message), { status });
}

export function isPathInside(candidate, root) {
  const relative = path.relative(path.resolve(root), path.resolve(candidate));
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

export function parseDuSize(output) {
  const match = String(output || "").match(/^\s*(\d+)/m);
  return match ? Number(match[1]) * 1024 : 0;
}

export function parseDiskutilInfo(output) {
  const fields = new Map();
  for (const line of String(output || "").split("\n")) {
    const match = line.match(/^\s*([^:]+):\s*(.*?)\s*$/);
    if (match) fields.set(match[1].trim(), match[2].trim());
  }
  const booleanValue = (key) => {
    const value = fields.get(key);
    if (!value) return null;
    if (/^yes$/i.test(value)) return true;
    if (/^no$/i.test(value)) return false;
    return null;
  };
  return {
    name: fields.get("Volume Name") || fields.get("Media Name") || "",
    mountPoint: fields.get("Mount Point") || "",
    fileSystem: fields.get("File System Personality") || fields.get("Type (Bundle)") || "",
    protocol: fields.get("Protocol") || "",
    internal: booleanValue("Internal"),
    solidState: booleanValue("Solid State")
  };
}

function toIso(value) {
  return value instanceof Date && !Number.isNaN(value.valueOf()) ? value.toISOString() : "";
}

function itemKind(stat) {
  if (stat.isDirectory()) return "directory";
  if (stat.isFile()) return "file";
  return "other";
}

function fileExtension(filePath) {
  const extension = path.extname(filePath).slice(1).toLowerCase();
  return extension || "文件";
}

function isManagedApplicationData(targetPath, homeDir) {
  const relative = path.relative(homeDir, targetPath);
  return relative === "Library" || relative.startsWith(`Library${path.sep}`);
}

async function mapWithConcurrency(items, concurrency, mapper) {
  const output = new Array(items.length);
  let cursor = 0;
  async function worker() {
    while (cursor < items.length) {
      const index = cursor;
      cursor += 1;
      output[index] = await mapper(items[index], index);
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, () => worker()));
  return output;
}

async function defaultDirectorySize(targetPath) {
  try {
    const { stdout } = await execFileAsync("du", ["-sk", targetPath], {
      timeout: 45_000,
      killSignal: "SIGKILL",
      maxBuffer: 2 * MIB
    });
    return parseDuSize(stdout);
  } catch (error) {
    return parseDuSize(error.stdout);
  }
}

function parseDuEntries(output) {
  return String(output || "")
    .split("\n")
    .map((line) => {
      const match = line.match(/^\s*(\d+)\s+(.+?)\s*$/);
      return match ? { size: Number(match[1]) * 1024, path: match[2] } : null;
    })
    .filter(Boolean);
}

async function defaultListDirectorySizes(targetPath, depth = 1) {
  try {
    const { stdout } = await execFileAsync("du", ["-k", "-d", String(depth), targetPath], {
      timeout: 45_000,
      killSignal: "SIGKILL",
      maxBuffer: 4 * MIB
    });
    return parseDuEntries(stdout);
  } catch (error) {
    return parseDuEntries(error.stdout);
  }
}

async function pathExists(targetPath) {
  try {
    await fs.access(targetPath);
    return true;
  } catch {
    return false;
  }
}

function cleanupDefinitions(homeDir) {
  return [
    {
      id: "trash",
      title: "废纸篓",
      description: "永久移除废纸篓中的内容",
      action: "清空",
      paths: [path.join(homeDir, ".Trash")],
      destructive: true,
      risk: "medium",
      riskLabel: "需确认",
      guidance: "清空后无法从废纸篓恢复，且只有这一步才会真正释放磁盘空间。"
    },
    {
      id: "caches",
      title: "系统与应用缓存",
      description: "当前用户的 macOS 与常见软件缓存",
      action: "清理",
      paths: [path.join(homeDir, "Library", "Caches")],
      destructive: true,
      risk: "low",
      riskLabel: "低风险",
      guidance: "退出相关应用后清理；缓存通常会自动重建，首次启动可能稍慢。"
    },
    {
      id: "developer-caches",
      title: "研发依赖缓存",
      description: "npm、Gradle 与 pnpm 的可重新下载依赖",
      action: "清理",
      paths: [
        path.join(homeDir, ".npm", "_cacache"),
        path.join(homeDir, ".gradle", "caches"),
        path.join(homeDir, "Library", "pnpm", "store")
      ],
      destructive: true,
      risk: "medium",
      riskLabel: "开发影响",
      guidance: "不会删除项目源码，但后续构建或安装依赖需要重新下载；离线开发前不要清理。"
    },
    {
      id: "logs",
      title: "应用日志",
      description: "移除用户应用产生的历史日志",
      action: "清理",
      paths: [path.join(homeDir, "Library", "Logs")],
      destructive: true,
      risk: "low",
      riskLabel: "低风险",
      guidance: "日志不影响应用数据；正在排查崩溃或异常时建议先保留。"
    },
    {
      id: "xcode",
      title: "Xcode 设备支持文件",
      description: "清理连接旧系统设备时下载的调试支持文件",
      action: "清理",
      paths: [path.join(homeDir, "Library", "Developer", "Xcode", "iOS DeviceSupport")],
      destructive: true,
      risk: "low",
      riskLabel: "可重建",
      guidance: "不会删除源码或 Archive；连接旧系统设备时可能需要重新下载支持文件。"
    },
    {
      id: "xcode-archives",
      title: "Xcode Archives",
      description: "按项目查看发布归档，默认选择每个项目较旧的版本",
      action: "移到废纸篓",
      paths: [path.join(homeDir, "Library", "Developer", "Xcode", "Archives")],
      selectionMode: "xcode-archives",
      moveToTrash: true,
      destructive: false,
      risk: "high",
      riskLabel: "保留最新",
      guidance: "Archive 可能是重新签名、回滚或上传商店的唯一产物；默认保留每个项目最近的一个版本。"
    },
    {
      id: "xcode-derived-data",
      title: "Xcode DerivedData",
      description: "同名项目归组，识别失效路径与只剩日志的旧副本",
      action: "移到废纸篓",
      paths: [path.join(homeDir, "Library", "Developer", "Xcode", "DerivedData")],
      selectionMode: "xcode-derived-data",
      moveToTrash: true,
      destructive: false,
      risk: "low",
      riskLabel: "可重建",
      guidance: "Xcode 会按项目绝对路径生成不同哈希目录；只移除选中的旧副本，保留仍有关联源项目的构建缓存。"
    },
    {
      id: "browser-assets",
      title: "浏览器模型与更新缓存",
      description: "Chrome 系列可重新下载的本地模型和更新包",
      action: "清理",
      paths: [
        path.join(homeDir, "Library", "Application Support", "Google", "Chrome", "OptGuideOnDeviceModel"),
        path.join(homeDir, "Library", "Application Support", "Google", "Chrome-CDP", "OptGuideOnDeviceModel"),
        path.join(homeDir, "Library", "Application Support", "Google", "GoogleUpdater", "crx_cache")
      ],
      destructive: true,
      risk: "medium",
      riskLabel: "会重新下载",
      guidance: "先退出 Chrome 及自动化浏览器；不会删除书签和历史记录，但相关能力会重新下载资源。"
    },
    {
      id: "ios-backups",
      title: "iPhone / iPad 备份",
      description: "删除本机保存的移动设备备份",
      action: "清理",
      paths: [path.join(homeDir, "Library", "Application Support", "MobileSync", "Backup")],
      destructive: true,
      risk: "high",
      riskLabel: "高风险",
      guidance: "这是设备恢复数据，不可自动重建；只删除已确认不再需要的备份。"
    },
    {
      id: "old-downloads",
      title: "较早的下载",
      description: "下载目录中超过 30 天未修改的文件",
      action: "移到废纸篓",
      paths: [path.join(homeDir, "Downloads")],
      moveToTrash: true,
      olderThanDays: 30,
      destructive: false,
      risk: "medium",
      riskLabel: "逐项确认",
      guidance: "只按修改时间筛选，不代表内容无用；项目会先移到废纸篓。"
    }
  ];
}

const INSTALLER_EXTENSIONS = new Set(["dmg", "pkg", "iso"]);
const ARCHIVE_EXTENSIONS = new Set(["zip", "rar", "7z", "tar", "gz", "bz2", "xz"]);
const MEDIA_EXTENSIONS = new Set(["mov", "mp4", "mkv", "avi", "m4v", "mp3", "wav", "flac", "aiff", "jpg", "jpeg", "png", "heic", "raw"]);

function pathParts(targetPath, homeDir) {
  return path.relative(homeDir, targetPath).split(path.sep).filter(Boolean);
}

function itemGroup(targetPath, homeDir) {
  const parts = pathParts(targetPath, homeDir);
  if (!parts.length) return { id: "home", label: "用户目录", path: homeDir };
  if (parts[0] === "Library" && ["Application Support", "Containers", "Group Containers"].includes(parts[1])) {
    const depth = parts.length >= 3 ? 3 : parts.length;
    const groupPath = path.join(homeDir, ...parts.slice(0, depth));
    return { id: groupPath, label: `应用数据 · ${parts[2] || parts[1]}`, path: groupPath };
  }
  if (parts[0] === "Library" && ["Developer", "Android", "pnpm"].includes(parts[1])) {
    const groupPath = path.join(homeDir, ...parts.slice(0, 2));
    return { id: groupPath, label: `研发环境 · ${parts[1]}`, path: groupPath };
  }
  if (parts[0] === "WorkSpace") {
    const depth = parts.length >= 2 ? 2 : 1;
    const groupPath = path.join(homeDir, ...parts.slice(0, depth));
    return { id: groupPath, label: `工作资料 · ${parts[1] || "WorkSpace"}`, path: groupPath };
  }
  const groupPath = path.join(homeDir, parts[0]);
  const labels = {
    Downloads: "下载",
    Desktop: "桌面",
    Documents: "文稿",
    Movies: "视频",
    Music: "音乐",
    Pictures: "图片",
    Applications: "用户应用",
    ".npm": "研发环境 · npm",
    ".gradle": "研发环境 · Gradle"
  };
  return { id: groupPath, label: labels[parts[0]] || parts[0], path: groupPath };
}

export function classifyStorageItem(targetPath, { homeDir = os.homedir(), kind = "file" } = {}) {
  const normalized = path.resolve(targetPath);
  const relative = path.relative(homeDir, normalized);
  const lower = relative.toLowerCase();
  const extension = path.extname(normalized).slice(1).toLowerCase();
  const group = itemGroup(normalized, homeDir);
  const result = {
    category: "other",
    categoryLabel: "其他大文件",
    risk: "medium",
    riskLabel: "需确认",
    riskReason: "无法仅凭路径判断是否可以重新生成。",
    recommendation: "先预览内容并在 Finder 中确认来源。",
    group,
    batchEligible: true
  };

  if (lower.startsWith(`library${path.sep.toLowerCase()}caches`) || /(^|\/)(cache|code cache|gpucache)(\/|$)/i.test(relative)) {
    return {
      ...result,
      category: "cache",
      categoryLabel: "软件缓存",
      risk: "low",
      riskLabel: "低风险",
      riskReason: "缓存通常可由应用重新生成。",
      recommendation: "退出相关应用后可清理，首次启动可能稍慢。"
    };
  }
  if (/library\/developer\/xcode\/deriveddata/i.test(relative)) {
    return {
      ...result,
      category: "developer-build",
      categoryLabel: "Xcode 构建缓存",
      risk: "low",
      riskLabel: "可重建",
      riskReason: "DerivedData 是编译派生内容。",
      recommendation: "可清理，下一次编译会重新生成。"
    };
  }
  if (/library\/developer\/xcode\/archives/i.test(relative)) {
    return {
      ...result,
      category: "release-archive",
      categoryLabel: "发布归档",
      risk: "high",
      riskLabel: "高风险",
      riskReason: "Archive 可能是重新签名、回滚或上传商店的唯一产物。",
      recommendation: "确认已有可验证备份后再逐项处理。"
    };
  }
  if (/^(\.npm\/_cacache|\.gradle\/caches|library\/pnpm\/store)(\/|$)/i.test(relative)) {
    return {
      ...result,
      category: "dependency-cache",
      categoryLabel: "依赖缓存",
      risk: "medium",
      riskLabel: "开发影响",
      riskReason: "内容可重新下载，但会影响离线构建并增加下次安装时间。",
      recommendation: "确认网络可用且近期不依赖离线构建后清理。"
    };
  }
  if (/^library\/(developer|android)(\/|$)/i.test(relative)) {
    return {
      ...result,
      category: "developer-toolchain",
      categoryLabel: "研发工具链",
      risk: "medium",
      riskLabel: "开发影响",
      riskReason: "可能是 SDK、模拟器镜像或调试工具，不是普通缓存。",
      recommendation: "优先通过 Xcode 或 Android SDK Manager 卸载不用的版本。"
    };
  }
  if (/^library\/(application support|containers|group containers)(\/|$)/i.test(relative)) {
    return {
      ...result,
      category: "application-data",
      categoryLabel: "应用数据",
      risk: "high",
      riskLabel: "高风险",
      riskReason: "可能包含账号状态、本地数据库、下载模型或用户内容。",
      recommendation: "不要按体积直接删除；先确认所属应用及其内置清理方式。"
    };
  }
  if (/^applications(\/|$)/i.test(relative) || normalized.endsWith(".app")) {
    return {
      ...result,
      category: "application",
      categoryLabel: "已安装应用",
      risk: "high",
      riskLabel: "高风险",
      riskReason: "直接移走应用可能遗留数据或中断工作流。",
      recommendation: "优先在应用管理中卸载。",
      batchEligible: false
    };
  }
  if (/^downloads(\/|$)/i.test(relative) && (INSTALLER_EXTENSIONS.has(extension) || ARCHIVE_EXTENSIONS.has(extension))) {
    return {
      ...result,
      category: INSTALLER_EXTENSIONS.has(extension) ? "installer" : "archive",
      categoryLabel: INSTALLER_EXTENSIONS.has(extension) ? "安装包" : "下载归档",
      risk: "low",
      riskLabel: "低风险",
      riskReason: "位于下载目录，通常可重新获取。",
      recommendation: "确认软件已安装或归档已有副本后可移到废纸篓。"
    };
  }
  if (/^(movies|music|pictures)(\/|$)/i.test(relative) || MEDIA_EXTENSIONS.has(extension)) {
    return {
      ...result,
      category: "personal-media",
      categoryLabel: "个人影音图片",
      risk: "high",
      riskLabel: "高风险",
      riskReason: "可能是不可重新生成的个人素材。",
      recommendation: "先确认云端或外置磁盘备份。"
    };
  }
  if (/^(workspace|documents|desktop)(\/|$)/i.test(relative)) {
    const generated = /\/(build|dist|release|exports?|deriveddata|node_modules)\//i.test(`/${relative}/`) || INSTALLER_EXTENSIONS.has(extension);
    return generated
      ? {
          ...result,
          category: "developer-output",
          categoryLabel: "研发构建产物",
          risk: "medium",
          riskLabel: "验证后清理",
          riskReason: "通常可重新构建，但也可能是签名发布或回滚基线。",
          recommendation: "确认源码、签名材料和已发布版本均可复现后处理。"
        }
      : {
          ...result,
          category: "work-content",
          categoryLabel: "项目与工作资料",
          risk: "high",
          riskLabel: "高风险",
          riskReason: kind === "directory" ? "目录可能包含源码和多个关联文件。" : "可能是项目原始资料或唯一归档。",
          recommendation: "先核对项目用途和备份，不建议批量清理。"
        };
  }
  return result;
}

export function createStorageService({
  homeDir = os.homedir(),
  platform = process.platform,
  directorySize = defaultDirectorySize,
  listDirectorySizes = defaultListDirectorySizes,
  statfs = fs.statfs,
  runCommand = execFileAsync,
  now = () => Date.now()
} = {}) {
  const trashDir = path.join(homeDir, ".Trash");
  const realHomeDirPromise = fs.realpath(homeDir).catch(() => path.resolve(homeDir));
  const protectedRoots = [
    homeDir,
    trashDir,
    ...["Desktop", "Documents", "Downloads", "Movies", "Music", "Pictures", "Library", "Applications"].map((name) =>
      path.join(homeDir, name)
    )
  ];
  const contentRoots = ["Desktop", "Documents", "Downloads", "Movies", "Music", "Pictures"].map((name) => path.join(homeDir, name));
  let overviewCache = { expiresAt: 0, value: null };
  let cleanupCache = { expiresAt: 0, value: null };
  let analysisCache = { expiresAt: 0, value: null };
  let largeFileCache = { expiresAt: 0, value: null };
  let overviewInFlight = null;
  let cleanupInFlight = null;
  let analysisInFlight = null;
  let largeFileInFlight = null;
  let refreshSequence = 0;
  let refreshJob = null;
  const directorySizeCache = new Map();
  const directorySizeInFlight = new Map();
  const activeTrashOperations = new Set();
  const activeCleanupOperations = new Set();

  function resolveLocation(location) {
    return path.isAbsolute(location) ? location : path.join(homeDir, location);
  }

  async function measuredDirectorySize(targetPath, { fresh = false } = {}) {
    const key = path.resolve(targetPath);
    const cached = directorySizeCache.get(key);
    if (!fresh && cached && cached.expiresAt > now()) return cached.value;
    if (directorySizeInFlight.has(key)) return directorySizeInFlight.get(key);
    const promise = (async () => {
      const value = (await pathExists(key)) ? Number(await directorySize(key)) || 0 : 0;
      directorySizeCache.set(key, { value, expiresAt: now() + DIRECTORY_SIZE_TTL_MS });
      return value;
    })();
    directorySizeInFlight.set(key, promise);
    try {
      return await promise;
    } finally {
      directorySizeInFlight.delete(key);
    }
  }

  function invalidateDirectorySizes(targetPaths = []) {
    for (const targetPath of targetPaths) {
      const key = path.resolve(targetPath);
      directorySizeCache.delete(key);
      for (const cachedKey of directorySizeCache.keys()) {
        if (isPathInside(cachedKey, key) || isPathInside(key, cachedKey)) directorySizeCache.delete(cachedKey);
      }
    }
  }

  async function readDiskInfo() {
    // Use the user's data volume. On macOS, statfs("/") can point at the sealed
    // system volume while the cleaned files live on /System/Volumes/Data.
    const stats = await statfs(homeDir);
    const total = Number(stats.blocks) * Number(stats.bsize);
    const available = Number(stats.bavail ?? stats.bfree) * Number(stats.bsize);
    const used = Math.max(0, total - available);
    const volume = {
      name: "Macintosh HD",
      mountPoint: "/",
      fileSystem: "APFS",
      protocol: "",
      internal: true,
      solidState: null,
      total,
      used,
      available,
      usedPercent: total ? Math.round((used / total) * 1000) / 10 : 0
    };

    if (platform !== "darwin") return volume;
    try {
      const { stdout } = await runCommand("diskutil", ["info", "/"], { maxBuffer: 2 * MIB });
      const info = parseDiskutilInfo(stdout);
      volume.name = info.name || volume.name;
      volume.mountPoint = info.mountPoint || volume.mountPoint;
      volume.fileSystem = info.fileSystem || volume.fileSystem;
      volume.protocol = info.protocol;
      if (info.internal !== null) volume.internal = info.internal;
      volume.solidState = info.solidState;
    } catch {
      // statfs remains authoritative when diskutil details are unavailable.
    }
    return volume;
  }

  async function getCategories(usedBytes) {
    const categories = await mapWithConcurrency(CATEGORY_DEFINITIONS, CATEGORY_DEFINITIONS.length, async (definition) => {
      const locations = definition.locations.map(resolveLocation);
      const sizes = await mapWithConcurrency(locations, 2, async (location) =>
        (await pathExists(location)) ? measuredDirectorySize(location) : 0
      );
      return { ...definition, locations, size: sizes.reduce((sum, size) => sum + size, 0) };
    });
    const measured = categories.reduce((sum, category) => sum + category.size, 0);
    categories.push({
      id: "system-other",
      label: "系统数据与其他",
      color: "#8c929a",
      locations: [],
      size: Math.max(0, usedBytes - measured),
      estimated: true
    });
    return { categories: categories.filter((category) => category.size > 0), measured };
  }

  async function getOverview({ fresh = false } = {}) {
    if (!fresh && overviewCache.value && overviewCache.expiresAt > now()) return overviewCache.value;
    if (overviewInFlight) return overviewInFlight;
    overviewInFlight = (async () => {
      const volume = await readDiskInfo();
      const { categories, measured } = await getCategories(volume.used);
      const value = {
        volume,
        categories,
        scanCoverage: volume.used ? Math.round((measured / volume.used) * 1000) / 10 : 0,
        limitedAccess: volume.used > 0 && measured / volume.used < 0.05,
        measuredAt: new Date(now()).toISOString(),
        note: "分类容量来自常用目录扫描；“系统数据与其他”为磁盘已用空间扣除已识别目录后的估算值。受 macOS 隐私保护的目录可能无法读取。"
      };
      overviewCache = { value, expiresAt: now() + OVERVIEW_TTL_MS };
      return value;
    })();
    try {
      return await overviewInFlight;
    } finally {
      overviewInFlight = null;
    }
  }

  async function collectOldFiles(root, olderThanDays, { includeSmall = true } = {}) {
    const cutoff = now() - olderThanDays * 24 * 60 * 60 * 1000;
    const files = [];
    const stack = [root];
    let visited = 0;
    while (stack.length && visited < MAX_SCAN_ENTRIES) {
      const current = stack.pop();
      let entries;
      try {
        entries = await fs.readdir(current, { withFileTypes: true });
      } catch {
        continue;
      }
      for (const entry of entries) {
        visited += 1;
        if (visited >= MAX_SCAN_ENTRIES) break;
        const entryPath = path.join(current, entry.name);
        if (entry.isSymbolicLink()) continue;
        if (entry.isDirectory()) {
          stack.push(entryPath);
          continue;
        }
        if (!entry.isFile()) continue;
        const stat = await fs.stat(entryPath).catch(() => null);
        if (!stat || stat.mtimeMs >= cutoff || (!includeSmall && stat.size < DEFAULT_LARGE_FILE_SIZE)) continue;
        files.push({ path: entryPath, size: stat.size, modifiedAt: toIso(stat.mtime), kind: "file" });
      }
    }
    return files;
  }

  async function buildDirectoryTree(targetPath) {
    if (!(await pathExists(targetPath))) return null;
    const listed = await listDirectorySizes(targetPath);
    const sizeByPath = new Map(listed.map((entry) => [path.resolve(entry.path), Number(entry.size) || 0]));
    const entries = await fs.readdir(targetPath, { withFileTypes: true }).catch(() => []);
    const children = await mapWithConcurrency(entries.slice(0, MAX_CLEANUP_TREE_ITEMS + 1), 8, async (entry) => {
      const childPath = path.join(targetPath, entry.name);
      const stat = await fs.lstat(childPath).catch(() => null);
      if (!stat) return null;
      const kind = itemKind(stat);
      const sizeKnown = sizeByPath.has(path.resolve(childPath)) || kind === "file";
      const size = sizeByPath.get(path.resolve(childPath)) ?? (kind === "file" ? stat.size : 0);
      return { name: entry.name, path: childPath, kind, size, sizeKnown, modifiedAt: toIso(stat.mtime), children: [] };
    });
    const rootSizeKnown = sizeByPath.has(path.resolve(targetPath));
    const rootSize = sizeByPath.get(path.resolve(targetPath)) ?? 0;
    const sortedChildren = children.filter(Boolean).sort((a, b) => b.size - a.size);
    return {
      name: path.basename(targetPath),
      path: targetPath,
      kind: "directory",
      size: rootSize,
      sizeKnown: rootSizeKnown,
      itemCount: entries.length,
      children: sortedChildren.slice(0, MAX_CLEANUP_TREE_ITEMS),
      truncated: sortedChildren.length > MAX_CLEANUP_TREE_ITEMS || entries.length > MAX_CLEANUP_TREE_ITEMS
    };
  }

  function archiveProjectName(archivePath) {
    const archiveName = path.basename(archivePath).replace(/\.xcarchive$/i, "");
    return archiveName
      .replace(/\s+\d{4}-\d{2}-\d{2}(?:[ ,]+\d{1,2}[.:]\d{2}(?:\s*[AP]M)?)?$/i, "")
      .trim() || archiveName;
  }

  async function readArchiveMetadata(archivePath) {
    const fallbackName = archiveProjectName(archivePath);
    const infoPath = path.join(archivePath, "Info.plist");
    if (platform !== "darwin" || !(await pathExists(infoPath))) return { projectName: fallbackName, version: "" };
    try {
      const { stdout } = await runCommand("plutil", ["-convert", "json", "-o", "-", infoPath], { maxBuffer: MIB });
      const info = JSON.parse(String(stdout || "{}"));
      const application = info.ApplicationProperties || {};
      const projectName = info.Name || application.CFBundleDisplayName || application.CFBundleName || fallbackName;
      const shortVersion = application.CFBundleShortVersionString || "";
      const buildVersion = application.CFBundleVersion || "";
      const version = shortVersion ? `${shortVersion}${buildVersion ? ` (${buildVersion})` : ""}` : buildVersion;
      return { projectName: String(projectName), version: String(version || "") };
    } catch {
      return { projectName: fallbackName, version: "" };
    }
  }

  async function collectArchiveDirectories(rootPath) {
    const archives = [];
    const stack = [{ targetPath: rootPath, depth: 0 }];
    while (stack.length) {
      const current = stack.pop();
      const entries = await fs.readdir(current.targetPath, { withFileTypes: true }).catch(() => []);
      for (const entry of entries) {
        if (entry.isSymbolicLink() || !entry.isDirectory()) continue;
        const entryPath = path.join(current.targetPath, entry.name);
        if (entry.name.endsWith(".xcarchive")) {
          archives.push(entryPath);
        } else if (current.depth < 1) {
          stack.push({ targetPath: entryPath, depth: current.depth + 1 });
        }
      }
    }
    return archives;
  }

  async function buildXcodeArchiveSelection(rootPath) {
    if (!(await pathExists(rootPath))) return { tree: [], selectionItems: [], recommendedPaths: [] };
    const archivePaths = await collectArchiveDirectories(rootPath);
    const listedSizes = await listDirectorySizes(rootPath, 2);
    const sizeByPath = new Map(listedSizes.map((entry) => [path.resolve(entry.path), Number(entry.size) || 0]));
    const archiveItems = (await mapWithConcurrency(archivePaths, 6, async (archivePath) => {
      const [stat, size, metadata] = await Promise.all([
        fs.stat(archivePath).catch(() => null),
        sizeByPath.has(path.resolve(archivePath)) ? Promise.resolve(sizeByPath.get(path.resolve(archivePath))) : measuredDirectorySize(archivePath),
        readArchiveMetadata(archivePath)
      ]);
      if (!stat?.isDirectory()) return null;
      return {
        name: path.basename(archivePath),
        label: metadata.version || path.basename(archivePath).replace(/\.xcarchive$/i, ""),
        path: archivePath,
        kind: "directory",
        size,
        sizeKnown: true,
        modifiedAt: toIso(stat.mtime),
        projectName: metadata.projectName,
        selectable: true,
        children: []
      };
    })).filter(Boolean);

    const byProject = new Map();
    for (const item of archiveItems) {
      const projectItems = byProject.get(item.projectName) || [];
      projectItems.push(item);
      byProject.set(item.projectName, projectItems);
    }
    for (const projectItems of byProject.values()) {
      projectItems.sort((a, b) => String(b.modifiedAt).localeCompare(String(a.modifiedAt)));
      projectItems.forEach((item, index) => {
        item.keepLatest = index === 0;
        item.recommended = index > 0;
      });
    }

    const projectGroups = [...byProject.entries()]
      .map(([projectName, items]) => ({
        name: projectName,
        label: projectName,
        path: `${rootPath}#project:${projectName}`,
        kind: "directory",
        size: items.reduce((sum, item) => sum + item.size, 0),
        virtual: true,
        children: items
      }))
      .sort((a, b) => b.size - a.size);
    const root = {
      name: path.basename(rootPath),
      path: rootPath,
      kind: "directory",
      size: archiveItems.reduce((sum, item) => sum + item.size, 0),
      sizeKnown: true,
      itemCount: archiveItems.length,
      children: projectGroups,
      truncated: false
    };
    const selectionItems = archiveItems.sort((a, b) => String(b.modifiedAt).localeCompare(String(a.modifiedAt)));
    return {
      tree: archiveItems.length ? [root] : [],
      selectionItems,
      recommendedPaths: selectionItems.filter((item) => item.recommended).map((item) => item.path)
    };
  }

  async function buildXcodeDerivedDataSelection(rootPath) {
    if (!(await pathExists(rootPath))) return { tree: [], selectionItems: [], recommendedPaths: [] };
    const entries = await fs.readdir(rootPath, { withFileTypes: true }).catch(() => []);
    const listedSizes = await listDirectorySizes(rootPath, 1);
    const sizeByPath = new Map(listedSizes.map((entry) => [path.resolve(entry.path), Number(entry.size) || 0]));
    const selectionItems = (await mapWithConcurrency(entries, 6, async (entry) => {
      if (entry.isSymbolicLink() || !entry.isDirectory()) return null;
      const entryPath = path.join(rootPath, entry.name);
      const sharedCache = XCODE_SHARED_CACHE_NAMES.has(entry.name);
      const projectName = sharedCache ? "Xcode 共享缓存" : entry.name.replace(/-[a-z0-9]{20,}$/i, "");
      const infoPath = path.join(entryPath, "info.plist");
      const [stat, size, contents, hasInfo] = await Promise.all([
        fs.stat(entryPath).catch(() => null),
        sizeByPath.has(path.resolve(entryPath)) ? Promise.resolve(sizeByPath.get(path.resolve(entryPath))) : measuredDirectorySize(entryPath),
        fs.readdir(entryPath, { withFileTypes: true }).catch(() => []),
        pathExists(infoPath)
      ]);
      if (!stat?.isDirectory()) return null;
      let workspacePath = "";
      if (platform === "darwin" && hasInfo) {
        try {
          const { stdout } = await runCommand("plutil", ["-convert", "json", "-o", "-", infoPath], { maxBuffer: MIB });
          workspacePath = String(JSON.parse(String(stdout || "{}")).WorkspacePath || "");
        } catch {
          workspacePath = "";
        }
      }
      const workspaceExists = workspacePath ? await pathExists(workspacePath) : null;
      const contentNames = contents.map(({ name }) => name);
      const orphanedShell = !hasInfo
        && contentNames.length > 0
        && contentNames.every((name) => name === "Logs" || name === "TestResults");
      const detail = workspacePath
        ? `${workspaceExists ? "源项目" : "源项目已不存在"} · ${workspacePath}`
        : orphanedShell
          ? "仅残留 Xcode 日志目录"
          : sharedCache
            ? "Xcode 全局共享缓存"
            : "来源路径未记录";
      return {
        name: entry.name,
        label: sharedCache ? entry.name : projectName,
        path: entryPath,
        kind: "directory",
        size,
        sizeKnown: true,
        modifiedAt: toIso(stat.mtime),
        projectName,
        workspacePath,
        workspaceExists,
        orphanedShell,
        sharedCache,
        detail,
        selectable: true,
        recommended: false,
        children: []
      };
    })).filter(Boolean);

    const byProject = new Map();
    for (const item of selectionItems) {
      const projectItems = byProject.get(item.projectName) || [];
      projectItems.push(item);
      byProject.set(item.projectName, projectItems);
    }

    const groupedItems = [...byProject.entries()].map(([projectName, projectItems]) => {
      projectItems.sort((a, b) => {
        const activeDifference = Number(b.workspaceExists === true) - Number(a.workspaceExists === true);
        if (activeDifference) return activeDifference;
        const shellDifference = Number(a.orphanedShell) - Number(b.orphanedShell);
        if (shellDifference) return shellDifference;
        return String(b.modifiedAt).localeCompare(String(a.modifiedAt)) || b.size - a.size;
      });

      const hasDuplicates = projectItems.length > 1 && !projectItems[0].sharedCache;
      const shouldRecommend = (item) => !item.sharedCache
        && ((hasDuplicates && item.orphanedShell) || Boolean(item.workspacePath && item.workspaceExists === false));
      const hasRecommendedCandidate = projectItems.some(shouldRecommend);
      for (const [index, item] of projectItems.entries()) {
        item.label = hasDuplicates ? item.name : item.label;
        item.recommended = shouldRecommend(item);
        item.keepLatest = hasDuplicates && index === 0 && hasRecommendedCandidate;
      }

      if (!hasDuplicates) return projectItems[0];
      return {
        name: projectName,
        label: projectName,
        path: `${rootPath}#project:${projectName}`,
        kind: "directory",
        size: projectItems.reduce((sum, item) => sum + item.size, 0),
        sizeKnown: true,
        itemCount: projectItems.length,
        virtual: true,
        expandedByDefault: false,
        children: projectItems
      };
    }).sort((a, b) => b.size - a.size);

    selectionItems.sort((a, b) => b.size - a.size || String(b.modifiedAt).localeCompare(String(a.modifiedAt)));
    const root = {
      name: path.basename(rootPath),
      path: rootPath,
      kind: "directory",
      size: selectionItems.reduce((sum, item) => sum + item.size, 0),
      sizeKnown: true,
      itemCount: selectionItems.length,
      expandedByDefault: true,
      children: groupedItems,
      truncated: false
    };
    return {
      tree: selectionItems.length ? [root] : [],
      selectionItems,
      recommendedPaths: selectionItems.filter((item) => item.recommended).map((item) => item.path)
    };
  }

  async function buildSelectableCleanup(definition) {
    const rootPath = definition.paths[0];
    return definition.selectionMode === "xcode-archives"
      ? buildXcodeArchiveSelection(rootPath)
      : buildXcodeDerivedDataSelection(rootPath);
  }

  function buildFileTree(rootPath, files) {
    const root = { name: path.basename(rootPath), path: rootPath, kind: "directory", size: 0, itemCount: files.length, children: [], truncated: files.length > MAX_CLEANUP_TREE_ITEMS };
    const nodeByPath = new Map([[rootPath, root]]);
    for (const file of files.slice(0, MAX_CLEANUP_TREE_ITEMS)) {
      const relativeParts = path.relative(rootPath, file.path).split(path.sep).filter(Boolean);
      let parent = root;
      let currentPath = rootPath;
      for (let index = 0; index < relativeParts.length; index += 1) {
        currentPath = path.join(currentPath, relativeParts[index]);
        let node = nodeByPath.get(currentPath);
        if (!node) {
          node = {
            name: relativeParts[index],
            path: currentPath,
            kind: index === relativeParts.length - 1 ? "file" : "directory",
            size: 0,
            modifiedAt: index === relativeParts.length - 1 ? file.modifiedAt : "",
            children: []
          };
          nodeByPath.set(currentPath, node);
          parent.children.push(node);
        }
        node.size += file.size;
        parent = node;
      }
    }
    const sortTree = (node) => {
      node.children.sort((a, b) => b.size - a.size);
      node.children.forEach(sortTree);
    };
    root.size = files.reduce((sum, file) => sum + file.size, 0);
    sortTree(root);
    return root;
  }

  async function getCleanupSuggestions({ fresh = false } = {}) {
    if (!fresh && cleanupCache.value && cleanupCache.expiresAt > now()) return cleanupCache.value;
    if (cleanupInFlight) return cleanupInFlight;
    cleanupInFlight = (async () => {
      const definitions = cleanupDefinitions(homeDir);
      const value = await mapWithConcurrency(definitions, 3, async (definition) => {
        let size = 0;
        let itemCount = 0;
        let tree = [];
        let cleanedPaths = [];
        let selectionItems = [];
        let recommendedPaths = [];
        if (definition.selectionMode) {
          const selectable = await buildSelectableCleanup(definition);
          tree = selectable.tree;
          selectionItems = selectable.selectionItems;
          recommendedPaths = selectable.recommendedPaths;
          size = selectionItems.reduce((sum, item) => sum + item.size, 0);
          itemCount = selectionItems.length;
          cleanedPaths = selectionItems.map((item) => item.path);
        } else if (definition.olderThanDays) {
          const files = await collectOldFiles(definition.paths[0], definition.olderThanDays);
          size = files.reduce((sum, item) => sum + item.size, 0);
          itemCount = files.length;
          tree = files.length ? [buildFileTree(definition.paths[0], files)] : [];
          cleanedPaths = files.map((file) => file.path);
        } else {
          const roots = await mapWithConcurrency(definition.paths, 2, buildDirectoryTree);
          tree = roots.filter(Boolean);
          size = tree.reduce((sum, root) => sum + root.size, 0);
          itemCount = tree.reduce((sum, root) => sum + root.itemCount, 0);
          cleanedPaths = tree.map((root) => root.path);
        }
        return {
          id: definition.id,
          title: definition.title,
          description: definition.description,
          action: definition.action,
          size,
          itemCount,
          destructive: definition.destructive,
          risk: definition.risk,
          riskLabel: definition.riskLabel,
          guidance: definition.guidance,
          selectionMode: definition.selectionMode || "",
          selectionItems,
          recommendedPaths,
          tree,
          cleanedPaths,
          sizeKnown: size > 0 || itemCount === 0,
          available: itemCount > 0
        };
      });
      cleanupCache = { value, expiresAt: now() + CLEANUP_TTL_MS };
      return value;
    })();
    try {
      return await cleanupInFlight;
    } finally {
      cleanupInFlight = null;
    }
  }

  async function scanLargeFiles(minSize = DEFAULT_LARGE_FILE_SIZE) {
    const largeFiles = [];
    if (platform === "darwin") {
      try {
        const { stdout } = await runCommand("mdfind", ["-onlyin", homeDir, `kMDItemFSSize >= ${minSize}`], {
          timeout: 15_000,
          killSignal: "SIGKILL",
          maxBuffer: 8 * MIB
        });
        const candidates = [...new Set(String(stdout || "").split("\n").filter(Boolean))].slice(0, 2_000);
        const items = await mapWithConcurrency(candidates, 12, async (entryPath) => {
          if (!isPathInside(entryPath, homeDir) || isPathInside(entryPath, trashDir)) return null;
          const stat = await fs.stat(entryPath).catch(() => null);
          if (!stat?.isFile() || stat.size < minSize) return null;
          return {
            name: path.basename(entryPath),
            path: entryPath,
            size: stat.size,
            modifiedAt: toIso(stat.mtime),
            kind: "file",
            type: fileExtension(entryPath),
            managed: isManagedApplicationData(entryPath, homeDir),
            canDelete: true,
            ...classifyStorageItem(entryPath, { homeDir, kind: "file" })
          };
        });
        return items.filter(Boolean).sort((a, b) => b.size - a.size).slice(0, 100);
      } catch {
        // Fall through to a bounded directory walk when Spotlight is unavailable.
      }
    }

    const roots = contentRoots;
    const stack = (await Promise.all(roots.map(async (root) => ((await pathExists(root)) ? [root] : [])))).flat();
    let visited = 0;
    while (stack.length && visited < MAX_SCAN_ENTRIES) {
      const current = stack.pop();
      let entries;
      try {
        entries = await fs.readdir(current, { withFileTypes: true });
      } catch {
        continue;
      }
      for (const entry of entries) {
        visited += 1;
        if (visited >= MAX_SCAN_ENTRIES) break;
        const entryPath = path.join(current, entry.name);
        if (entry.isSymbolicLink()) continue;
        if (entry.isDirectory()) {
          if (!entry.name.endsWith(".app") && entry.name !== "node_modules" && entry.name !== ".git") stack.push(entryPath);
          continue;
        }
        if (!entry.isFile()) continue;
        const stat = await fs.stat(entryPath).catch(() => null);
        if (!stat || stat.size < minSize) continue;
        largeFiles.push({
          name: entry.name,
          path: entryPath,
          size: stat.size,
          modifiedAt: toIso(stat.mtime),
          kind: "file",
          type: fileExtension(entryPath),
          managed: isManagedApplicationData(entryPath, homeDir),
          canDelete: true,
          ...classifyStorageItem(entryPath, { homeDir, kind: "file" })
        });
      }
    }
    return largeFiles.sort((a, b) => b.size - a.size).slice(0, 100);
  }

  function inferredDirectoryPath(filePath) {
    const parts = path.relative(homeDir, filePath).split(path.sep).filter(Boolean);
    if (parts.length < 2) return "";
    if (parts[0] === "Library") {
      if (["Application Support", "Containers", "Group Containers", "Developer"].includes(parts[1]) && parts.length >= 4) {
        return path.join(homeDir, ...parts.slice(0, 3));
      }
      return parts.length >= 3 ? path.join(homeDir, ...parts.slice(0, 2)) : "";
    }
    if (["Desktop", "Documents", "Downloads", "Movies", "Music", "Pictures"].includes(parts[0])) {
      return parts.length >= 3 ? path.join(homeDir, ...parts.slice(0, 2)) : "";
    }
    return parts.length >= 3 ? path.join(homeDir, ...parts.slice(0, 2)) : path.join(homeDir, parts[0]);
  }

  async function inferDirectoriesFromFiles(files) {
    const groups = new Map();
    for (const file of files) {
      const directoryPath = inferredDirectoryPath(file.path);
      if (!directoryPath || protectedRoots.some((root) => path.resolve(root) === path.resolve(directoryPath))) continue;
      groups.set(directoryPath, (groups.get(directoryPath) || 0) + file.size);
    }
    const entries = [...groups.entries()].filter(([, size]) => size >= DEFAULT_LARGE_FILE_SIZE);
    return mapWithConcurrency(entries, 12, async ([targetPath, size]) => {
      const stat = await fs.stat(targetPath).catch(() => null);
      if (!stat?.isDirectory()) return null;
      return {
        name: path.basename(targetPath),
        path: targetPath,
        size,
        modifiedAt: toIso(stat.mtime),
        kind: "directory",
        type: isManagedApplicationData(targetPath, homeDir) ? "应用数据" : "文件夹",
        managed: isManagedApplicationData(targetPath, homeDir),
        estimated: true,
        canDelete: true,
        ...classifyStorageItem(targetPath, { homeDir, kind: "directory" })
      };
    });
  }

  async function scanLargeDirectories(files = []) {
    const candidateRoots = [
      ...contentRoots,
      path.join(homeDir, "Applications"),
      path.join(homeDir, "Library", "Application Support"),
      path.join(homeDir, "Library", "Developer")
    ];
    const groups = await mapWithConcurrency(candidateRoots, candidateRoots.length, async (root) => {
      if (!(await pathExists(root))) return [];
      const entries = await listDirectorySizes(root);
      return entries.filter((entry) => path.resolve(entry.path) !== path.resolve(root) && path.dirname(path.resolve(entry.path)) === path.resolve(root));
    });
    const entries = groups.flat();
    const items = await mapWithConcurrency(entries, 12, async ({ path: targetPath, size }) => {
      const stat = await fs.stat(targetPath).catch(() => null);
      return {
        name: path.basename(targetPath),
        path: targetPath,
        size: Number(size || 0),
        modifiedAt: toIso(stat?.mtime),
        kind: "directory",
        type: "文件夹",
        managed: isManagedApplicationData(targetPath, homeDir),
        canDelete: true,
        ...classifyStorageItem(targetPath, { homeDir, kind: "directory" })
      };
    });
    const inferred = await inferDirectoriesFromFiles(files);
    const byPath = new Map();
    for (const item of [...inferred.filter(Boolean), ...items]) {
      if (!item || item.size < DEFAULT_LARGE_FILE_SIZE) continue;
      const existing = byPath.get(item.path);
      if (!existing || item.size > existing.size || (!item.estimated && existing.estimated)) byPath.set(item.path, item);
    }
    return [...byPath.values()].sort((a, b) => b.size - a.size).slice(0, 80);
  }

  async function getLargeFilePreview({ fresh = false } = {}) {
    if (!fresh && largeFileCache.value && largeFileCache.expiresAt > now()) return largeFileCache.value;
    if (largeFileInFlight) return largeFileInFlight;
    largeFileInFlight = (async () => {
      const files = await scanLargeFiles();
      const value = {
        files,
        scannedAt: new Date(now()).toISOString(),
        threshold: DEFAULT_LARGE_FILE_SIZE,
        truncated: files.length >= 100
      };
      largeFileCache = { value, expiresAt: now() + ANALYSIS_TTL_MS };
      return value;
    })();
    try {
      return await largeFileInFlight;
    } finally {
      largeFileInFlight = null;
    }
  }

  async function getAnalysis({ fresh = false } = {}) {
    if (!fresh && analysisCache.value && analysisCache.expiresAt > now()) return analysisCache.value;
    if (analysisInFlight) return analysisInFlight;
    analysisInFlight = (async () => {
      const filePreview = await getLargeFilePreview({ fresh });
      const files = filePreview.files;
      const directories = await scanLargeDirectories(files);
      const value = {
        files,
        directories,
        scannedAt: filePreview.scannedAt,
        threshold: filePreview.threshold,
        truncated: filePreview.truncated || directories.length >= 80
      };
      analysisCache = { value, expiresAt: now() + ANALYSIS_TTL_MS };
      return value;
    })();
    try {
      return await analysisInFlight;
    } finally {
      analysisInFlight = null;
    }
  }

  function publicRefreshJob(job = refreshJob) {
    if (!job) return null;
    const { promise: _promise, ...status } = job;
    return status;
  }

  function startRefresh({ includeAnalysis = false, includeBase = true } = {}) {
    if (refreshJob?.state === "running") {
      if (includeAnalysis) refreshJob.includeAnalysis = true;
      return publicRefreshJob();
    }
    const id = `storage-${now()}-${++refreshSequence}`;
    refreshJob = {
      id,
      state: "running",
      phase: includeBase ? "base" : "analysis",
      includeBase: Boolean(includeBase),
      includeAnalysis: Boolean(includeAnalysis),
      startedAt: new Date(now()).toISOString(),
      baseCompletedAt: "",
      completedAt: "",
      error: "",
      promise: null
    };
    const job = refreshJob;
    job.promise = (async () => {
      try {
        if (job.includeBase) {
          await Promise.all([
            getOverview({ fresh: true }),
            getCleanupSuggestions({ fresh: true })
          ]);
          job.baseCompletedAt = new Date(now()).toISOString();
        }
        if (job.includeAnalysis) {
          job.phase = "analysis";
          await getAnalysis({ fresh: true });
        }
        job.phase = "complete";
        job.state = "complete";
        job.completedAt = new Date(now()).toISOString();
      } catch (error) {
        job.phase = "failed";
        job.state = "failed";
        job.error = error.message || "存储扫描失败";
        job.completedAt = new Date(now()).toISOString();
      }
    })();
    return publicRefreshJob(job);
  }

  function getRefreshStatus(id) {
    if (!refreshJob || refreshJob.id !== id) throw errorWithStatus("存储扫描任务不存在", 404);
    return publicRefreshJob();
  }

  async function validateUserItem(targetPath) {
    if (!targetPath || !path.isAbsolute(targetPath)) throw errorWithStatus("文件路径无效", 400);
    const resolved = path.resolve(targetPath);
    if (!isPathInside(resolved, homeDir)) throw errorWithStatus("只能管理当前用户目录中的文件", 403);
    if (protectedRoots.some((root) => path.resolve(root) === resolved)) throw errorWithStatus("不能删除系统保留目录", 403);
    const stat = await fs.lstat(resolved).catch(() => null);
    if (stat) {
      const [realTarget, realHomeDir] = await Promise.all([
        fs.realpath(resolved).catch(() => resolved),
        realHomeDirPromise
      ]);
      if (!isPathInside(realTarget, realHomeDir)) throw errorWithStatus("符号链接指向当前用户目录之外", 403);
    }
    return resolved;
  }

  async function uniqueTrashPath(sourcePath) {
    await fs.mkdir(trashDir, { recursive: true });
    const parsed = path.parse(sourcePath);
    let destination = path.join(trashDir, parsed.base);
    let sequence = 2;
    while (await pathExists(destination)) {
      destination = path.join(trashDir, `${parsed.name} ${sequence}${parsed.ext}`);
      sequence += 1;
    }
    return destination;
  }

  async function trashItem(targetPath) {
    const operationKey = path.resolve(String(targetPath || ""));
    if (activeTrashOperations.has(operationKey)) throw errorWithStatus("该项目正在处理中，请稍候", 409);
    activeTrashOperations.add(operationKey);
    try {
      const resolved = await validateUserItem(targetPath);
      const stat = await fs.lstat(resolved).catch(() => null);
      if (!stat) throw errorWithStatus("文件或目录不存在", 404);
      const destination = await uniqueTrashPath(resolved);
      await fs.rename(resolved, destination);
      analysisCache.expiresAt = 0;
      largeFileCache.expiresAt = 0;
      overviewCache.expiresAt = 0;
      cleanupCache.expiresAt = 0;
      invalidateDirectorySizes([path.dirname(resolved), trashDir]);
      return { path: resolved, trashedTo: destination, name: path.basename(resolved), size: stat.isDirectory() ? await measuredDirectorySize(destination) : stat.size };
    } finally {
      activeTrashOperations.delete(operationKey);
    }
  }

  async function trashItems(targetPaths = []) {
    if (!Array.isArray(targetPaths) || !targetPaths.length || targetPaths.length > 100) throw errorWithStatus("批量项目数量无效", 400);
    const uniquePaths = [...new Set(targetPaths.map((targetPath) => path.resolve(String(targetPath || ""))))];
    const trashed = [];
    const errors = [];
    for (const targetPath of uniquePaths) {
      try {
        trashed.push(await trashItem(targetPath));
      } catch (error) {
        errors.push({ path: targetPath, error: error.message, status: error.status || 500 });
      }
    }
    return {
      trashed,
      errors,
      removed: trashed.length,
      reclaimed: trashed.reduce((sum, item) => sum + Number(item.size || 0), 0),
      movedToTrash: true
    };
  }

  async function removeContents(targetRoot) {
    const entries = await fs.readdir(targetRoot, { withFileTypes: true }).catch(() => []);
    let removed = 0;
    for (const entry of entries) {
      await fs.rm(path.join(targetRoot, entry.name), { recursive: true, force: true });
      removed += 1;
    }
    return removed;
  }

  async function cleanCategory(id) {
    const definition = cleanupDefinitions(homeDir).find((item) => item.id === id);
    if (!definition) throw errorWithStatus("未知的清理项目", 404);
    if (definition.selectionMode) throw errorWithStatus("该清理项目需要先选择具体目录", 400);
    if (activeCleanupOperations.has(id)) throw errorWithStatus("该清理项目正在处理中，请稍候", 409);
    activeCleanupOperations.add(id);
    let removed = 0;
    let reclaimed = 0;
    let cleanedPaths = [];
    try {
      const volumeBefore = await readDiskInfo();
      if (definition.olderThanDays) {
        const files = await collectOldFiles(definition.paths[0], definition.olderThanDays);
        cleanedPaths = files.map((file) => file.path);
        for (const file of files) {
          await trashItem(file.path);
          removed += 1;
          reclaimed += file.size;
        }
      } else {
        cleanedPaths = definition.paths;
        const sizes = await Promise.all(definition.paths.map((targetPath) => measuredDirectorySize(targetPath, { fresh: true })));
        reclaimed = sizes.reduce((sum, size) => sum + size, 0);
        for (const targetPath of definition.paths) removed += await removeContents(targetPath);
      }
      overviewCache.expiresAt = 0;
      analysisCache.expiresAt = 0;
      largeFileCache.expiresAt = 0;
      cleanupCache.expiresAt = 0;
      invalidateDirectorySizes([...definition.paths, trashDir]);
      const volume = await readDiskInfo();
      return {
        id,
        removed,
        reclaimed,
        actualReclaimed: Math.max(0, volume.available - volumeBefore.available),
        movedToTrash: Boolean(definition.moveToTrash),
        cleanedPaths,
        volume
      };
    } finally {
      activeCleanupOperations.delete(id);
    }
  }

  async function cleanCategoryItems(id, targetPaths = []) {
    const definition = cleanupDefinitions(homeDir).find((item) => item.id === id);
    if (!definition?.selectionMode) throw errorWithStatus("该清理项目不支持目录选择", 400);
    if (!Array.isArray(targetPaths) || !targetPaths.length || targetPaths.length > 100) throw errorWithStatus("批量项目数量无效", 400);
    if (activeCleanupOperations.has(id)) throw errorWithStatus("该清理项目正在处理中，请稍候", 409);
    activeCleanupOperations.add(id);
    try {
      const uniquePaths = [...new Set(targetPaths.map((targetPath) => path.resolve(String(targetPath || ""))))];
      const selectable = await buildSelectableCleanup(definition);
      const allowedPaths = new Set(selectable.selectionItems.map((item) => path.resolve(item.path)));
      const invalidPath = uniquePaths.find((targetPath) => !allowedPaths.has(targetPath));
      if (invalidPath) throw errorWithStatus("选择中包含不属于该清理项目的目录", 403);

      const volumeBefore = await readDiskInfo();
      const result = await trashItems(uniquePaths);
      overviewCache.expiresAt = 0;
      analysisCache.expiresAt = 0;
      largeFileCache.expiresAt = 0;
      cleanupCache.expiresAt = 0;
      invalidateDirectorySizes([...uniquePaths, ...definition.paths, trashDir]);
      const volume = await readDiskInfo();
      return {
        ...result,
        id,
        cleanedPaths: result.trashed.map((item) => item.path),
        actualReclaimed: Math.max(0, volume.available - volumeBefore.available),
        volume
      };
    } finally {
      activeCleanupOperations.delete(id);
    }
  }

  async function checkPathsExist(targetPaths = []) {
    if (!Array.isArray(targetPaths) || targetPaths.length > 10_000) throw errorWithStatus("路径数量无效", 400);
    const uniquePaths = [...new Set(targetPaths.map((targetPath) => String(targetPath || "")))];
    const checks = await mapWithConcurrency(uniquePaths, 32, async (rawPath) => {
      if (!path.isAbsolute(rawPath)) return { path: rawPath, exists: false };
      const targetPath = path.resolve(rawPath);
      if (!isPathInside(targetPath, homeDir)) return { path: targetPath, exists: false };
      const stat = await fs.lstat(targetPath).catch(() => null);
      if (!stat) return { path: targetPath, exists: false };
      const realTarget = await fs.realpath(targetPath).catch(() => targetPath);
      const realHomeDir = await realHomeDirPromise;
      return { path: targetPath, exists: isPathInside(realTarget, realHomeDir) };
    });
    return {
      existing: checks.filter((entry) => entry.exists).map((entry) => entry.path),
      missing: checks.filter((entry) => !entry.exists).map((entry) => entry.path)
    };
  }

  async function inspectItem(targetPath) {
    const resolved = await validateUserItem(targetPath);
    const stat = await fs.lstat(resolved).catch(() => null);
    if (!stat) throw errorWithStatus("文件或目录不存在", 404);
    let children = [];
    if (stat.isDirectory()) {
      const entries = (await fs.readdir(resolved, { withFileTypes: true }).catch(() => [])).slice(0, 60);
      children = await mapWithConcurrency(entries, 4, async (entry) => {
        const childPath = path.join(resolved, entry.name);
        const childStat = await fs.lstat(childPath).catch(() => null);
        const kind = childStat ? itemKind(childStat) : "other";
        return {
          name: entry.name,
          path: childPath,
          kind,
          size: kind === "directory" ? await measuredDirectorySize(childPath) : childStat?.size || 0,
          modifiedAt: toIso(childStat?.mtime)
        };
      });
      children.sort((a, b) => b.size - a.size);
    }
    return {
      name: path.basename(resolved),
      path: resolved,
      kind: itemKind(stat),
      size: stat.isDirectory() ? await measuredDirectorySize(resolved) : stat.size,
      modifiedAt: toIso(stat.mtime),
      createdAt: toIso(stat.birthtime),
      type: stat.isDirectory() ? "文件夹" : fileExtension(resolved),
      managed: isManagedApplicationData(resolved, homeDir),
      canDelete: true,
      ...classifyStorageItem(resolved, { homeDir, kind: itemKind(stat) }),
      children,
      childCount: children.length
    };
  }

  async function revealItem(targetPath) {
    const resolved = await validateUserItem(targetPath);
    if (!(await pathExists(resolved))) throw errorWithStatus("文件或目录不存在", 404);
    if (platform === "darwin") await runCommand("open", ["-R", resolved]);
    return { revealed: resolved };
  }

  async function openItem(targetPath) {
    const resolved = await validateUserItem(targetPath);
    if (!(await pathExists(resolved))) throw errorWithStatus("文件或目录不存在", 404);
    if (platform === "darwin") await runCommand("open", [resolved]);
    return { opened: resolved };
  }

  async function openStorageSettings() {
    if (platform === "darwin") {
      await runCommand("open", ["x-apple.systempreferences:com.apple.settings.Storage"]);
    }
    return { opened: platform === "darwin" };
  }

  return {
    getOverview,
    getVolume: readDiskInfo,
    getCleanupSuggestions,
    getLargeFilePreview,
    getAnalysis,
    startRefresh,
    getRefreshStatus,
    inspectItem,
    revealItem,
    openItem,
    trashItem,
    trashItems,
    cleanCategory,
    cleanCategoryItems,
    checkPathsExist,
    openStorageSettings
  };
}
