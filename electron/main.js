import { app, BrowserWindow, Menu, Notification, Tray, nativeImage, shell } from "electron";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { startServer, exposeServerServices } from "../server/index.js";

const currentFile = fileURLToPath(import.meta.url);
const currentDir = path.dirname(currentFile);
const trayIconPath = path.join(currentDir, "..", "build", "trayTemplate.png");

const TRAY_POLL_MS = 10_000;
const NOTIFICATION_POLL_MS = 5_000;

let mainWindow = null;
let apiServer = null;
let trayController = null;
let notificationTimer = null;
let runtimePromise = null;
let appUrl = "";

/**
 * Starts the local API server, the menu bar tray and the notification bridge
 * exactly once per process.
 *
 * This used to live inside `createWindow()`, which meant every "activate" or
 * "open main window" click started another server and created another Tray.
 * The old tray was never destroyed, so two menu bar items with different
 * readings appeared after a while.
 */
async function ensureRuntime() {
  if (runtimePromise) return runtimePromise;
  runtimePromise = (async () => {
    const { server, url } = await startServer({ port: 0 });
    apiServer = server;
    appUrl = url.endsWith("/") ? url.slice(0, -1) : url;

    trayController = createTrayController({ url: appUrl });
    trayController.start();
    wireNativeNotifications(appUrl);

    return { url: appUrl };
  })().catch((error) => {
    runtimePromise = null;
    throw error;
  });
  return runtimePromise;
}

/** Shows the existing window, or creates exactly one if none is open. */
async function showWindow() {
  const runtime = await ensureRuntime();

  if (mainWindow && !mainWindow.isDestroyed()) {
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.show();
    mainWindow.focus();
    return mainWindow;
  }

  mainWindow = new BrowserWindow({
    width: 1280,
    height: 860,
    minWidth: 960,
    minHeight: 680,
    title: "我的macOS",
    backgroundColor: "#f3f4f6",
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false
    }
  });

  mainWindow.webContents.setWindowOpenHandler(({ url: targetUrl }) => {
    shell.openExternal(targetUrl);
    return { action: "deny" };
  });

  mainWindow.on("closed", () => {
    mainWindow = null;
  });

  await mainWindow.loadURL(runtime.url);
  return mainWindow;
}

function createTrayController({ url }) {
  let tray = null;
  let timer = null;

  async function fetchJson(route) {
    const response = await fetch(`${url}${route}`);
    const body = await response.json();
    if (!body.ok) throw new Error(body.error || "request failed");
    return body.data;
  }

  async function refresh() {
    if (!tray) return;
    try {
      const [metrics, alerts] = await Promise.all([
        fetchJson("/api/processes/metrics"),
        fetchJson("/api/monitor/status")
      ]);
      const cpu = Math.round(metrics.metrics?.cpuPercent || 0);
      const memory = Math.round(metrics.metrics?.memoryPercent || 0);
      // The df list starts with the read-only system volume; the monitor sample
      // already resolved the data volume, which is what users care about.
      const disk = Math.round(
        alerts.lastSample?.diskUsedPercent
        ?? (metrics.disks || []).find((entry) => entry.mount === "/System/Volumes/Data")?.usedPercent
        ?? (metrics.disks || [])[0]?.usedPercent
        ?? 0
      );
      tray.setTitle(` ${cpu}% · ${memory}%`);
      const active = alerts.activeAlerts || [];
      const menu = Menu.buildFromTemplate([
        { label: `CPU ${cpu}% · 内存 ${memory}%`, enabled: false },
        { label: `磁盘 ${disk}%`, enabled: false },
        { type: "separator" },
        ...(active.length
          ? active.map((alert) => ({ label: `⚠︎ ${alert.label} ${alert.value}`, enabled: false }))
          : [{ label: "当前没有触发的告警", enabled: false }]),
        { type: "separator" },
        { label: "打开主窗口", click: () => { showWindow().catch(() => {}); } },
        { label: "打开监控目录", click: () => shell.openPath(path.dirname(alerts.filePath || "")) },
        { type: "separator" },
        { label: "退出我的macOS", click: () => app.quit() }
      ]);
      tray.setContextMenu(menu);
      tray.setToolTip(`我的macOS｜CPU ${cpu}%｜内存 ${memory}%${active.length ? `｜${active.length} 条告警` : ""}`);
    } catch {
      tray.setTitle(" -- / --");
    }
  }

  return {
    start() {
      // Defensive: never leave a previous tray alive if start() is called twice.
      if (tray) return;
      const image = nativeImage.createFromPath(trayIconPath);
      image.setTemplateImage(true);
      tray = new Tray(image);
      tray.on("click", () => { showWindow().catch(() => {}); });
      refresh();
      timer = setInterval(refresh, TRAY_POLL_MS);
      timer.unref?.();
    },
    stop() {
      if (timer) clearInterval(timer);
      timer = null;
      tray?.destroy();
      tray = null;
    }
  };
}

// The server evaluates thresholds and pushes entries through its notification
// service; Electron mirrors them into macOS Notification Center.
function wireNativeNotifications(url) {
  if (!Notification.isSupported()) return;
  const { notificationService } = exposeServerServices();
  notificationService.setSender(async (entry) => {
    new Notification({
      title: entry.title,
      subtitle: entry.subtitle,
      body: entry.message
    }).show();
    return { delivered: true, channel: "electron" };
  });

  if (notificationTimer) clearInterval(notificationTimer);
  notificationTimer = setInterval(async () => {
    try {
      const response = await fetch(`${url}/api/notifications`);
      if (!response.ok) return;
    } catch {
      // The app may be quitting; polling failures are not actionable.
    }
  }, NOTIFICATION_POLL_MS);
  notificationTimer.unref?.();
}

app.setName("我的macOS");

// A second launch (double-click, dock, or a relaunch script) must focus the
// existing process instead of spawning another tray.
const hasSingleInstanceLock = app.requestSingleInstanceLock();
if (!hasSingleInstanceLock) {
  app.quit();
} else {
  app.on("second-instance", () => {
    showWindow().catch(() => {});
  });

  app.whenReady().then(() => {
    showWindow().catch((error) => {
      console.error(`[main] failed to start: ${error.stack || error.message}`);
      app.quit();
    });
  });

  app.on("activate", () => {
    showWindow().catch(() => {});
  });

  app.on("window-all-closed", () => {
    if (process.platform !== "darwin") {
      app.quit();
    }
  });

  app.on("before-quit", () => {
    if (notificationTimer) clearInterval(notificationTimer);
    notificationTimer = null;
    trayController?.stop();
    trayController = null;
    runtimePromise = null;
    if (apiServer) {
      apiServer.close();
      apiServer = null;
    }
  });
}
