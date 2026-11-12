import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const LIST_LOGIN_ITEMS_SCRIPT = `
const systemEvents = Application("System Events");
JSON.stringify(systemEvents.loginItems().map((item) => ({
  name: item.name(),
  path: item.path(),
  hidden: item.hidden()
})));
`;
const ADD_LOGIN_ITEM_SCRIPT = [
  "on run argv",
  "set targetPath to item 1 of argv",
  'tell application "System Events"',
  "make new login item at end with properties {path:targetPath, hidden:false}",
  "end tell",
  "end run"
];
const REMOVE_LOGIN_ITEM_SCRIPT = [
  "on run argv",
  "set targetPath to item 1 of argv",
  'tell application "System Events"',
  "set matchingItems to (every login item whose path is targetPath)",
  "if (count of matchingItems) is 0 then error \"Login item not found\" number 404",
  "delete (item 1 of matchingItems)",
  "end tell",
  "return \"removed\"",
  "end run"
];

function applicationBundlePath(itemPath) {
  const match = String(itemPath || "").match(/^(.+?\.app)(?:\/|$)/i);
  return match ? path.normalize(match[1]) : "";
}

export function encodeLoginItemId(item) {
  return Buffer.from(`${item.path || ""}\u0000${item.name || ""}`).toString("base64url");
}

export function decodeLoginItemId(id) {
  const [itemPath, name] = Buffer.from(id, "base64url").toString("utf8").split("\u0000");
  return { path: itemPath || "", name: name || "" };
}

export function parseLoginItems(output) {
  const parsed = JSON.parse(String(output || "[]").trim() || "[]");
  if (!Array.isArray(parsed)) throw new Error("登录项返回格式无效");
  return parsed
    .filter((item) => item && (item.path || item.name))
    .map((item) => ({
      id: encodeLoginItemId(item),
      name: String(item.name || path.basename(item.path || "", ".app") || "未知项目"),
      path: String(item.path || ""),
      hidden: Boolean(item.hidden)
    }));
}

function isAutomationDenied(error) {
  return /-1743|not authorized to send apple events|不允许发送 apple 事件|未获授权发送 apple 事件/i.test(
    `${error?.message || ""}\n${error?.stderr || ""}`
  );
}

function isLoginItemMissing(error) {
  return /Login item not found.*\(?404\)?/i.test(`${error?.message || ""}\n${error?.stderr || ""}`);
}

function appSummary(application) {
  if (!application) return null;
  const { id, name, bundleId, path: appPath, iconUrl, system, location } = application;
  return { id, name, bundleId, path: appPath, iconUrl, system, location };
}

export function createLoginItemService({ applicationService, run = execFileAsync } = {}) {
  if (!applicationService) throw new Error("applicationService is required");

  async function readRawLoginItems() {
    const { stdout } = await run("osascript", ["-l", "JavaScript", "-e", LIST_LOGIN_ITEMS_SCRIPT], {
      timeout: 10_000,
      maxBuffer: 2 * 1024 * 1024
    });
    return parseLoginItems(stdout);
  }

  async function listLoginItems({ fresh = false } = {}) {
    const applications = await applicationService.listInstalledApplications({ fresh });
    let rawItems = [];
    let access = { available: true, requiresAutomation: false, detail: "" };
    try {
      rawItems = await readRawLoginItems();
    } catch (error) {
      if (!isAutomationDenied(error)) throw error;
      access = {
        available: false,
        requiresAutomation: true,
        detail: "需要允许“我的macOS”控制“系统事件”"
      };
    }

    const applicationsByPath = new Map(applications.map((application) => [path.normalize(application.path), application]));
    const enabledPaths = new Set();
    const items = rawItems.map((item) => {
      const bundlePath = applicationBundlePath(item.path);
      if (bundlePath) enabledPaths.add(bundlePath);
      const application = applicationsByPath.get(bundlePath);
      return {
        ...item,
        application: appSummary(application),
        name: application?.name || item.name,
        iconUrl: application?.iconUrl || "",
        missing: Boolean(bundlePath && !application)
      };
    }).sort((a, b) => a.name.localeCompare(b.name, "zh-CN"));

    const candidates = applications
      .filter((application) => !enabledPaths.has(path.normalize(application.path)))
      .map(appSummary)
      .sort((a, b) => Number(a.system) - Number(b.system) || a.name.localeCompare(b.name, "zh-CN"));

    return {
      access,
      items,
      candidates,
      summary: {
        total: items.length,
        hidden: items.filter(({ hidden }) => hidden).length,
        unavailable: items.filter(({ missing }) => missing).length
      }
    };
  }

  async function addLoginItem(applicationId) {
    const applications = await applicationService.listInstalledApplications();
    const application = applications.find(({ id }) => id === applicationId);
    if (!application) throw Object.assign(new Error("应用不存在"), { status: 404 });

    let items;
    try {
      items = await readRawLoginItems();
    } catch (error) {
      if (isAutomationDenied(error)) {
        throw Object.assign(new Error("请先在系统设置中允许“我的macOS”控制“系统事件”"), { status: 403 });
      }
      throw error;
    }
    const normalizedPath = path.normalize(application.path);
    if (items.some((item) => applicationBundlePath(item.path) === normalizedPath)) {
      throw Object.assign(new Error("该应用已在开机启动列表中"), { status: 409 });
    }

    const args = ADD_LOGIN_ITEM_SCRIPT.flatMap((line) => ["-e", line]);
    try {
      await run("osascript", [...args, application.path], { timeout: 10_000, maxBuffer: 2 * 1024 * 1024 });
    } catch (error) {
      if (isAutomationDenied(error)) {
        throw Object.assign(new Error("请先在系统设置中允许“我的macOS”控制“系统事件”"), { status: 403 });
      }
      throw error;
    }
    return { added: true, application: appSummary(application) };
  }

  async function removeLoginItem(id) {
    const target = decodeLoginItemId(id);
    let items;
    try {
      items = await readRawLoginItems();
    } catch (error) {
      if (isAutomationDenied(error)) {
        throw Object.assign(new Error("请先在系统设置中允许“我的macOS”控制“系统事件”"), { status: 403 });
      }
      throw error;
    }
    const item = items.find((candidate) => candidate.path === target.path && candidate.name === target.name);
    if (!item) throw Object.assign(new Error("登录项不存在或已被移除"), { status: 404 });

    const args = REMOVE_LOGIN_ITEM_SCRIPT.flatMap((line) => ["-e", line]);
    try {
      await run("osascript", [...args, item.path], { timeout: 10_000, maxBuffer: 2 * 1024 * 1024 });
    } catch (error) {
      if (isAutomationDenied(error)) {
        throw Object.assign(new Error("请先在系统设置中允许“我的macOS”控制“系统事件”"), { status: 403 });
      }
      if (isLoginItemMissing(error)) {
        throw Object.assign(new Error("登录项不存在或已被移除"), { status: 404 });
      }
      throw error;
    }
    return { removed: true, item };
  }

  async function openLoginItemSettings() {
    await run("open", ["x-apple.systempreferences:com.apple.LoginItems-Settings.extension"]);
    return { opened: true };
  }

  async function openAutomationSettings() {
    await run("open", ["x-apple.systempreferences:com.apple.preference.security?Privacy_Automation"]);
    return { opened: true };
  }

  return {
    listLoginItems,
    addLoginItem,
    removeLoginItem,
    openLoginItemSettings,
    openAutomationSettings
  };
}
