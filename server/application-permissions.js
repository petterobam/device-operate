import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export const PERMISSION_CATEGORIES = [
  { id: "accessibility", label: "辅助功能", pane: "Privacy_Accessibility", services: ["kTCCServiceAccessibility"] },
  { id: "app-management", label: "App 管理", pane: "Privacy_AppBundles", services: ["kTCCServiceSystemPolicyAppBundles"] },
  { id: "automation", label: "自动化", pane: "Privacy_Automation", services: ["kTCCServiceAppleEvents"] },
  { id: "bluetooth", label: "蓝牙", pane: "Privacy_Bluetooth", services: ["kTCCServiceBluetoothAlways"] },
  { id: "calendar", label: "日历", pane: "Privacy_Calendars", services: ["kTCCServiceCalendar"] },
  { id: "camera", label: "相机", pane: "Privacy_Camera", services: ["kTCCServiceCamera"] },
  { id: "contacts", label: "通讯录", pane: "Privacy_Contacts", services: ["kTCCServiceAddressBook"] },
  { id: "developer-tools", label: "开发者工具", pane: "Privacy_DeveloperTools", services: ["kTCCServiceDeveloperTool"] },
  {
    id: "files-folders",
    label: "文件与文件夹",
    pane: "Privacy_FilesAndFolders",
    services: [
      "kTCCServiceSystemPolicyDesktopFolder",
      "kTCCServiceSystemPolicyDocumentsFolder",
      "kTCCServiceSystemPolicyDownloadsFolder",
      "kTCCServiceSystemPolicyNetworkVolumes",
      "kTCCServiceSystemPolicyRemovableVolumes"
    ]
  },
  { id: "focus", label: "专注模式", pane: "Privacy_FocusStatus", services: ["kTCCServiceFocusStatus"] },
  { id: "full-disk", label: "完全磁盘访问权限", pane: "Privacy_AllFiles", services: ["kTCCServiceSystemPolicyAllFiles"] },
  { id: "input-monitoring", label: "输入监控", pane: "Privacy_ListenEvent", services: ["kTCCServiceListenEvent", "kTCCServicePostEvent"] },
  { id: "local-network", label: "本地网络", pane: "Privacy_LocalNetwork", services: ["kTCCServiceLocalNetwork"] },
  { id: "location", label: "定位服务", pane: "Privacy_LocationServices", services: ["kTCCServiceLocation"] },
  { id: "media", label: "媒体与 Apple Music", pane: "Privacy_Media", services: ["kTCCServiceMediaLibrary"] },
  { id: "microphone", label: "麦克风", pane: "Privacy_Microphone", services: ["kTCCServiceMicrophone"] },
  { id: "motion", label: "运动与健身", pane: "Privacy_Motion", services: ["kTCCServiceMotion"] },
  { id: "photos", label: "照片", pane: "Privacy_Photos", services: ["kTCCServicePhotos", "kTCCServicePhotosAdd"] },
  { id: "reminders", label: "提醒事项", pane: "Privacy_Reminders", services: ["kTCCServiceReminders"] },
  { id: "screen-recording", label: "屏幕与系统音频录制", pane: "Privacy_ScreenCapture", services: ["kTCCServiceScreenCapture"] },
  { id: "speech", label: "语音识别", pane: "Privacy_SpeechRecognition", services: ["kTCCServiceSpeechRecognition"] },
  { id: "sensitive-content", label: "敏感内容警告", pane: "Privacy_SensitiveContentAnalysis", services: ["kTCCServiceSensitiveContentAnalysis"] }
];

const SERVICE_DETAILS = {
  kTCCServiceSystemPolicyDesktopFolder: "桌面文件夹",
  kTCCServiceSystemPolicyDocumentsFolder: "文稿文件夹",
  kTCCServiceSystemPolicyDownloadsFolder: "下载文件夹",
  kTCCServiceSystemPolicyNetworkVolumes: "网络宗卷",
  kTCCServiceSystemPolicyRemovableVolumes: "可移动宗卷",
  kTCCServicePhotosAdd: "仅添加照片",
  kTCCServiceListenEvent: "监听输入",
  kTCCServicePostEvent: "控制输入"
};

const categoryByService = new Map(
  PERMISSION_CATEGORIES.flatMap((category) => category.services.map((service) => [service, category]))
);
const knownServices = new Set(categoryByService.keys());

function categoryForService(service) {
  const known = categoryByService.get(service);
  if (known) return known;
  return {
    id: `other-${String(service).replace(/^kTCCService/, "").replace(/[^a-z0-9]+/gi, "-").toLowerCase()}`,
    label: String(service).replace(/^kTCCService/, "") || "其他权限",
    pane: "Privacy",
    services: [service]
  };
}

export function permissionStatus(authValue, hasRecord = true) {
  if (!hasRecord) return "not-requested";
  if (Number(authValue) === 2) return "granted";
  if (Number(authValue) === 3) return "limited";
  if (Number(authValue) === 0) return "denied";
  return "unknown";
}

function toIsoDate(value) {
  const seconds = Number(value);
  if (!Number.isFinite(seconds) || seconds <= 0) return "";
  return new Date(seconds * 1000).toISOString();
}

function permissionRecord(row, applicationsByBundleId) {
  const category = categoryForService(row.service);
  const targetBundleId = row.indirect_object_identifier && row.indirect_object_identifier !== "UNUSED"
    ? row.indirect_object_identifier
    : "";
  return {
    service: row.service,
    categoryId: category.id,
    label: SERVICE_DETAILS[row.service] || category.label,
    status: permissionStatus(row.auth_value),
    hasRecord: true,
    authReason: Number(row.auth_reason || 0),
    lastModifiedAt: toIsoDate(row.last_modified),
    targetBundleId,
    targetName: applicationsByBundleId.get(targetBundleId.toLowerCase())?.name || targetBundleId,
    resettable: knownServices.has(row.service)
  };
}

function declaredPermission(service, accessAvailable) {
  const category = categoryForService(service);
  return {
    service,
    categoryId: category.id,
    label: SERVICE_DETAILS[service] || category.label,
    status: accessAvailable ? "not-requested" : "unavailable",
    hasRecord: false,
    authReason: 0,
    lastModifiedAt: "",
    targetBundleId: "",
    targetName: "",
    resettable: false
  };
}

export function buildPermissionModel(applications, rows, access = { available: true, requiresFullDiskAccess: false, detail: "" }) {
  const applicationsByBundleId = new Map(
    applications.filter(({ bundleId }) => bundleId).map((application) => [application.bundleId.toLowerCase(), application])
  );
  const recordsByBundleId = new Map();
  const unknownCategories = new Map();

  for (const row of rows) {
    if (Number(row.client_type) !== 0 || !row.client) continue;
    const bundleKey = row.client.toLowerCase();
    if (!applicationsByBundleId.has(bundleKey)) continue;
    const permission = permissionRecord(row, applicationsByBundleId);
    const category = categoryForService(row.service);
    if (!categoryByService.has(row.service)) unknownCategories.set(category.id, category);
    const current = recordsByBundleId.get(bundleKey) || [];
    current.push(permission);
    recordsByBundleId.set(bundleKey, current);
  }

  const resultApplications = applications.map((application) => {
    const bundleKey = application.bundleId?.toLowerCase() || "";
    const permissions = [...(recordsByBundleId.get(bundleKey) || [])];
    const recordedServices = new Set(permissions.map(({ service }) => service));
    for (const service of application.declaredPermissions || []) {
      if (!recordedServices.has(service)) permissions.push(declaredPermission(service, access.available));
    }
    permissions.sort((a, b) => {
      const aCategory = categoryForService(a.service);
      const bCategory = categoryForService(b.service);
      return aCategory.label.localeCompare(bCategory.label, "zh-CN") || a.label.localeCompare(b.label, "zh-CN");
    });
    return {
      id: application.id,
      name: application.name,
      bundleId: application.bundleId,
      path: application.path,
      iconUrl: application.iconUrl,
      system: application.system,
      permissions
    };
  }).filter(({ permissions }) => permissions.length)
    .sort((a, b) => Number(a.system) - Number(b.system) || a.name.localeCompare(b.name, "zh-CN"));

  const categories = [...PERMISSION_CATEGORIES, ...unknownCategories.values()].map((category) => {
    const permissions = resultApplications.flatMap((application) => application.permissions)
      .filter(({ categoryId }) => categoryId === category.id);
    return {
      id: category.id,
      label: category.label,
      settingsUrl: `x-apple.systempreferences:com.apple.preference.security?${category.pane}`,
      count: permissions.length,
      granted: permissions.filter(({ status }) => status === "granted").length,
      denied: permissions.filter(({ status }) => status === "denied").length
    };
  });
  const allPermissions = resultApplications.flatMap(({ permissions }) => permissions);

  return {
    access,
    categories,
    applications: resultApplications,
    summary: {
      applications: resultApplications.length,
      total: allPermissions.length,
      records: allPermissions.filter(({ hasRecord }) => hasRecord).length,
      granted: allPermissions.filter(({ status }) => status === "granted").length,
      denied: allPermissions.filter(({ status }) => status === "denied").length,
      limited: allPermissions.filter(({ status }) => status === "limited").length,
      unavailable: allPermissions.filter(({ status }) => status === "unavailable").length,
      notRequested: allPermissions.filter(({ status }) => status === "not-requested").length
    }
  };
}

export function parseSqliteJson(output) {
  const text = String(output || "").trim();
  if (!text) return [];
  const parsed = JSON.parse(text);
  if (!Array.isArray(parsed)) throw new Error("TCC 数据返回格式无效");
  return parsed;
}

function isFullDiskAccessError(error) {
  return /authorization denied|operation not permitted|unable to open database|not authorized/i.test(
    `${error?.message || ""}\n${error?.stderr || ""}`
  );
}

function tccServiceName(service) {
  return String(service).replace(/^kTCCService/, "");
}

export function createApplicationPermissionService({
  applicationService,
  tccDatabasePath = path.join(os.homedir(), "Library", "Application Support", "com.apple.TCC", "TCC.db"),
  run = execFileAsync
} = {}) {
  if (!applicationService) throw new Error("applicationService is required");

  async function readTccRows() {
    const query = [
      "SELECT service, client, client_type, auth_value, auth_reason,",
      "indirect_object_identifier, last_modified",
      "FROM access WHERE client_type = 0",
      "ORDER BY client, service, indirect_object_identifier"
    ].join(" ");
    const { stdout } = await run("sqlite3", ["-readonly", "-json", tccDatabasePath, query], {
      timeout: 10_000,
      maxBuffer: 8 * 1024 * 1024
    });
    return parseSqliteJson(stdout);
  }

  async function listPermissions({ fresh = false } = {}) {
    const applications = await applicationService.listInstalledApplications({ fresh });
    try {
      const rows = await readTccRows();
      return buildPermissionModel(applications, rows, {
        available: true,
        requiresFullDiskAccess: false,
        detail: ""
      });
    } catch (error) {
      if (!isFullDiskAccessError(error)) throw error;
      return buildPermissionModel(applications, [], {
        available: false,
        requiresFullDiskAccess: true,
        detail: "需要为“我的macOS”开启完全磁盘访问权限后才能读取各应用的授权状态"
      });
    }
  }

  async function openPermissionSettings(categoryId) {
    const category = PERMISSION_CATEGORIES.find(({ id }) => id === categoryId);
    if (!category) throw Object.assign(new Error("未知的权限类别"), { status: 404 });
    await run("open", [`x-apple.systempreferences:com.apple.preference.security?${category.pane}`]);
    return { opened: true, categoryId };
  }

  async function resetPermission(applicationId, service) {
    if (!knownServices.has(service)) throw Object.assign(new Error("不支持重置该权限"), { status: 400 });
    const applications = await applicationService.listInstalledApplications();
    const application = applications.find(({ id }) => id === applicationId);
    if (!application) throw Object.assign(new Error("应用不存在"), { status: 404 });
    if (!application.bundleId) throw Object.assign(new Error("该应用没有可用于重置权限的 Bundle ID"), { status: 409 });
    await run("tccutil", ["reset", tccServiceName(service), application.bundleId], {
      timeout: 10_000,
      maxBuffer: 2 * 1024 * 1024
    });
    return { reset: true, applicationId, service };
  }

  return { listPermissions, openPermissionSettings, resetPermission };
}
