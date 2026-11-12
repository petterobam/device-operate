import React, { useEffect, useMemo, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import {
  Activity,
  AlertTriangle,
  ArrowLeft,
  Archive,
  Battery,
  BatteryCharging,
  Download,
  Moon,
  AppWindow,
  ArrowDown,
  ArrowUp,
  BarChart3,
  Bell,
  Bot,
  Brain,
  Cable,
  Copy,
  CalendarDays,
  CalendarClock,
  Check,
  ChevronDown,
  ChevronRight,
  CircleAlert,
  Clock3,
  Cpu,
  Database,
  FileText,
  FileCode2,
  Files,
  FolderOpen,
  GitBranch,
  Globe,
  ExternalLink,
  Eye,
  File,
  ListRestart,
  HardDrive,
  Info as InfoIcon,
  LayoutList,
  MemoryStick,
  MessageSquare,
  Monitor,
  PackageOpen,
  Pencil,
  Plus,
  Power,
  PowerOff,
  RefreshCw,
  RotateCcw,
  Save,
  Search,
  Send,
  ShieldCheck,
  Settings2,
  Sparkles,
  Square,
  Tag,
  Terminal,
  Trash2,
  TrendingUp,
  User,
  Volume2,
  Wifi,
  Keyboard,
  KeyRound,
  Wrench,
  X,
  Zap
} from "lucide-react";
import { geoGraticule10, geoPath } from "d3-geo";
import { feature as topojsonFeature } from "topojson-client";
import worldAtlas from "world-atlas/countries-110m.json";
import { buildNetworkArc, createNetworkWorldProjection, NETWORK_WORLD_HEIGHT, NETWORK_WORLD_WIDTH } from "./network-map.js";
import { parseSseStream } from "../server/sse.js";
import "./styles.css";

async function requestJson(method, path, payload) {
  const res = await fetch(path, {
    method,
    headers: payload === undefined ? undefined : { "Content-Type": "application/json" },
    body: payload === undefined ? undefined : JSON.stringify(payload)
  });
  const body = await res.json();
  if (!body.ok) throw new Error(body.error || "Request failed");
  return body.data;
}

const api = {
  async get(path) {
    const res = await fetch(path);
    const body = await res.json();
    if (!body.ok) throw new Error(body.error || "Request failed");
    return body.data;
  },
  async post(path, payload) {
    const res = await fetch(path, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload)
    });
    const body = await res.json();
    if (!body.ok) throw new Error(body.error || "Request failed");
    return body.data;
  },
  async put(path, payload) {
    return requestJson("PUT", path, payload);
  },
  async del(path) {
    return requestJson("DELETE", path);
  },
  async patch(path, payload) {
    const res = await fetch(path, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload)
    });
    const body = await res.json();
    if (!body.ok) throw new Error(body.error || "Request failed");
    return body.data;
  },
  async delete(path, payload) {
    const options = { method: "DELETE" };
    if (payload !== undefined) {
      options.headers = { "Content-Type": "application/json" };
      options.body = JSON.stringify(payload);
    }
    const res = await fetch(path, options);
    const body = await res.json();
    if (!body.ok) throw new Error(body.error || "Request failed");
    return body.data;
  }
};

const MENU_SNAPSHOT_VERSION = 1;
const MENU_SNAPSHOT_PREFIX = "device-operate:menu-snapshot";

function readMenuSnapshot(key) {
  if (typeof window === "undefined") return null;
  try {
    const parsed = JSON.parse(window.localStorage.getItem(`${MENU_SNAPSHOT_PREFIX}:${key}:v${MENU_SNAPSHOT_VERSION}`) || "null");
    if (!parsed || parsed.version !== MENU_SNAPSHOT_VERSION || !("data" in parsed)) return null;
    return parsed.data;
  } catch {
    return null;
  }
}

function writeMenuSnapshot(key, data) {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(
      `${MENU_SNAPSHOT_PREFIX}:${key}:v${MENU_SNAPSHOT_VERSION}`,
      JSON.stringify({ version: MENU_SNAPSHOT_VERSION, savedAt: new Date().toISOString(), data })
    );
  } catch {
    // A full or unavailable localStorage must not block menu management.
  }
}

function removeMenuSnapshot(key) {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.removeItem(`${MENU_SNAPSHOT_PREFIX}:${key}:v${MENU_SNAPSHOT_VERSION}`);
  } catch {
    // An unavailable localStorage must not block menu management.
  }
}

const SYSTEM_SETTING_CARDS = [
  {
    id: "battery",
    label: "电池与电源",
    description: "电池健康、低电量模式和电源策略",
    icon: Battery,
    items: [
      ["电池健康", "查看电池状态、最大容量与优化电池充电"],
      ["低电量模式", "分别配置使用电池和电源适配器时的节能策略"],
      ["电量使用情况", "查看近 24 小时或 10 天的电量与屏幕使用记录"],
      ["电源选项", "管理网络唤醒、显示器关闭与自动睡眠相关选项"]
    ],
    note: "可用项目会随 Mac 机型、电池状态和外接电源情况变化。"
  },
  {
    id: "displays",
    label: "屏幕与显示器",
    description: "亮度、分辨率、夜览和显示器布局",
    icon: Monitor,
    items: [
      ["亮度与色彩", "调整亮度、色彩描述文件与原彩显示"],
      ["分辨率与缩放", "选择显示分辨率、文字大小与刷新率"],
      ["夜览", "设置色温以及按时间自动启用夜览"],
      ["排列与镜像", "管理外接显示器的位置、主屏幕与镜像方式"]
    ],
    note: "外接显示器连接后，排列、刷新率和色彩配置会在此分类中出现。"
  },
  {
    id: "sound",
    label: "声音",
    description: "输出、输入和提示音策略",
    icon: Volume2,
    items: [
      ["声音输出", "选择扬声器、耳机或外接音频设备并调整平衡"],
      ["声音输入", "选择麦克风并查看输入音量"],
      ["声音效果", "调整提醒音、提醒音量和界面声音"],
      ["菜单栏控制", "设置声音控制是否常驻菜单栏或控制中心"]
    ],
    note: "蓝牙或外接音频设备连接后会自动加入输入和输出列表。"
  },
  {
    id: "network",
    label: "网络",
    description: "Wi-Fi、VPN 和网络服务",
    icon: Wifi,
    items: [
      ["Wi-Fi", "查看当前网络、已知网络与自动加入策略"],
      ["有线网络", "管理以太网、USB 网络与服务顺序"],
      ["VPN 与过滤器", "查看 VPN 配置和网络内容过滤器"],
      ["网络详情", "配置 TCP/IP、DNS、代理和硬件参数"]
    ],
    note: "修改 DNS、代理、VPN 或网络服务可能会立即影响当前连接。"
  },
  {
    id: "keyboard",
    label: "键盘与输入",
    description: "键盘、输入法和快捷键策略",
    icon: Keyboard,
    items: [
      ["键盘响应", "调整按键重复速度、重复前延迟和功能键行为"],
      ["键盘快捷键", "管理系统、聚焦、辅助功能和 App 快捷键"],
      ["输入法", "添加输入法并设置菜单栏切换方式"],
      ["听写", "配置听写语言、快捷键与自动标点"]
    ],
    note: "外接键盘可能提供额外的修饰键、功能键和键盘类型选项。"
  },
  {
    id: "general",
    label: "通用设置",
    description: "更新、共享、登录项与系统级选项",
    icon: Settings2,
    items: [
      ["软件更新", "查看 macOS 更新、安全响应与自动更新策略"],
      ["隔空投送与接力", "管理附近共享、接力与跨设备协作"],
      ["共享", "配置文件共享、屏幕共享与远程登录"],
      ["登录项与扩展", "查看后台项目、系统扩展与文件扩展"]
    ],
    note: "开机启动应用仍可在左侧“我的应用 > 开机启动”中直接管理。"
  }
];

function TaskBadge({ type }) {
  return <span className={`badge ${type}`}>{type === "launchd" ? "Launch" : "Cron"}</span>;
}

function getTaskStatus(task) {
  if (task?.running || task?.status === "running") return { className: "statusRunning", label: "执行中" };
  if (task?.status === "error") return { className: "statusError", label: "状态异常" };
  if (task?.status === "failed") return { className: "statusFailed", label: "最近失败" };
  if (task?.disabled) return { className: "statusDisabled", label: "已禁用" };
  if (task?.status === "waiting" || task?.type === "cron" || task?.loaded) {
    return { className: "statusWaiting", label: "等待调度" };
  }
  return { className: "statusStopped", label: "未加载" };
}

function getTaskRuntime(task) {
  if (!task) return "-";
  if (task.running) {
    const pids = task.pids?.length ? task.pids : task.pid ? [task.pid] : [];
    const source = task.runSource === "manual" ? "手动触发" : task.runSource === "scheduler" ? "系统调度" : "";
    return [pids.length ? `PID ${pids.join(", ")}` : "进程已启动", task.elapsed ? `已运行 ${task.elapsed}` : "", source]
      .filter(Boolean)
      .join(" · ");
  }
  if (task.status === "failed") {
    if (task.lastSignal) return `最近执行被 ${task.lastSignal} 终止`;
    if (task.lastExitStatus < 0) return `最近执行因信号 ${Math.abs(task.lastExitStatus)} 终止`;
    return `最近执行退出码 ${task.lastExitStatus}`;
  }
  if (task.disabled) return "任务已禁用，不会自动执行";
  if (task.type === "launchd" && !task.loaded) return "服务尚未加载";
  return "已启用，等待下一次触发";
}

function TaskStatus({ task }) {
  const status = getTaskStatus(task);
  return <span className={`statusBadge ${status.className}`} title={getTaskRuntime(task)}>{status.label}</span>;
}

function App() {
  const taskSnapshotRef = useRef(undefined);
  if (taskSnapshotRef.current === undefined) taskSnapshotRef.current = readMenuSnapshot("tasks");
  const agentSnapshotRef = useRef(undefined);
  if (agentSnapshotRef.current === undefined) agentSnapshotRef.current = readMenuSnapshot("agent");
  const initialTasks = taskSnapshotRef.current?.tasks || { launchd: [], cron: [] };
  const initialAgentData = agentSnapshotRef.current || { status: null, tools: [], skills: [] };
  const [tasks, setTasks] = useState(initialTasks);
  const [selected, setSelected] = useState(() => {
    const initial = [...initialTasks.launchd, ...initialTasks.cron];
    return initial[0] || null;
  });
  const [detail, setDetail] = useState(null);
  const [filter, setFilter] = useState("all");
  const [query, setQuery] = useState("");
  const [activeSection, setActiveSection] = useState("processes");
  const [appsExpanded, setAppsExpanded] = useState(true);
  const [settingsExpanded, setSettingsExpanded] = useState(false);
  const [systemSettingView, setSystemSettingView] = useState(null);
  const [systemInfoExpanded, setSystemInfoExpanded] = useState(false);
  const [systemInfoView, setSystemInfoView] = useState("power");
  const [toolsExpanded, setToolsExpanded] = useState(false);
  const [toolsView, setToolsView] = useState(null);
  const [agentExpanded, setAgentExpanded] = useState(false);
  const [agentView, setAgentView] = useState("harness");
  const [agentData, setAgentData] = useState(initialAgentData);
  const [error, setError] = useState("");
  const [refreshing, setRefreshing] = useState(false);
  const [agentRefreshing, setAgentRefreshing] = useState(false);
  const [showCreate, setShowCreate] = useState(false);
  const [batchProgress, setBatchProgress] = useState({ running: false, completed: 0, total: 0 });
  const [batchMessage, setBatchMessage] = useState("");

  const allTasks = useMemo(() => [...tasks.launchd, ...tasks.cron], [tasks]);
  const missingRemarkCount = useMemo(() => allTasks.filter((task) => !task.note?.trim()).length, [allTasks]);
  const visibleTasks = useMemo(() => {
    const normalizedQuery = query.trim().toLowerCase();
    return allTasks.filter((task) => {
      if (filter !== "all" && task.type !== filter) return false;
      if (!normalizedQuery) return true;
      return [task.name, task.alias, task.note, task.tags?.join(" "), task.command, task.schedule, task.scope, task.source]
        .filter(Boolean)
        .join(" ")
        .toLowerCase()
        .includes(normalizedQuery);
    });
  }, [allTasks, filter, query]);

  async function refresh({ silent = false, fresh = false } = {}) {
    if (!silent) {
      setRefreshing(true);
      setError("");
    }
    try {
      const data = await api.get(`/api/tasks${fresh ? "?fresh=1" : ""}`);
      setTasks(data);
      writeMenuSnapshot("tasks", { tasks: data });
      const nextTasks = [...data.launchd, ...data.cron];
      setDetail((current) => {
        if (!current) return current;
        const latest = nextTasks.find((task) => task.type === current.type && task.id === current.id);
        return latest ? { ...current, ...latest } : null;
      });
      setSelected((current) => {
        if (!current) return nextTasks[0] || null;
        return nextTasks.find((task) => task.type === current.type && task.id === current.id) || nextTasks[0] || null;
      });
    } catch (err) {
      setError(err.message);
    } finally {
      if (!silent) setRefreshing(false);
    }
  }

  useEffect(() => {
    refresh({ silent: Boolean(taskSnapshotRef.current) });
    if (!agentSnapshotRef.current) loadAgentData();
  }, []);

  // Warm the slow storage scan after the fast process preview has rendered.
  useEffect(() => {
    if (readStorageSnapshot()) return undefined;
    const timer = window.setTimeout(() => {
      api.get("/api/storage/volume").catch(() => {});
      api.post("/api/storage/refresh", { includeAnalysis: true }).catch(() => {});
    }, 1200);
    return () => window.clearTimeout(timer);
  }, []);

  useEffect(() => {
    if (activeSection !== "tasks") return undefined;
    const interval = window.setInterval(() => refresh({ silent: true }), 3000);
    return () => window.clearInterval(interval);
  }, [activeSection]);

  useEffect(() => {
    if (activeSection !== "tasks" || !selected) return;
    setDetail(null);
    api
      .get(`/api/tasks/${selected.type}/${selected.id}`)
      .then(setDetail)
      .catch((err) => setError(err.message));
  }, [activeSection, selected?.type, selected?.id]);

  async function runSelected() {
    if (!selected) return;
    try {
      await api.post(`/api/tasks/${selected.type}/${selected.id}/run`, {});
      await refresh();
    } catch (err) {
      setError(err.message);
    }
  }

  async function toggleSelected(enabled) {
    if (!selected) return null;
    try {
      const updated = await api.post(`/api/tasks/${selected.type}/${selected.id}/enabled`, { enabled });
      await refresh();
      return updated;
    } catch (err) {
      setError(err.message);
      throw err;
    }
  }

  async function saveMetadata(payload) {
    if (!selected) return;
    try {
      await api.patch(`/api/tasks/${selected.type}/${selected.id}/metadata`, payload);
      await refresh();
    } catch (err) {
      setError(err.message);
      throw err;
    }
  }

  async function generateRemark() {
    if (!selected) return null;
    try {
      const remark = await api.post("/api/agent/generate-task-remark", { type: selected.type, id: selected.id });
      await saveMetadata(remark);
      return remark;
    } catch (err) {
      setError(err.message);
      throw err;
    }
  }

  async function generateBatchRemarks() {
    if (batchProgress.running) return;
    const pendingTasks = allTasks.filter((task) => !task.note?.trim());
    if (!pendingTasks.length) {
      setBatchMessage("所有系统任务都已有备注");
      return;
    }
    if (!window.confirm(`将为 ${pendingTasks.length} 个尚无备注的系统任务批量生成备注。已有内容不会被覆盖，是否继续？`)) return;

    setError("");
    setBatchMessage("");
    setBatchProgress({ running: true, completed: 0, total: pendingTasks.length });
    let nextIndex = 0;
    let completed = 0;
    let fallbackCount = 0;
    const failures = [];

    async function worker() {
      while (nextIndex < pendingTasks.length) {
        const task = pendingTasks[nextIndex];
        nextIndex += 1;
        try {
          const remark = await api.post("/api/agent/generate-task-remark", {
            type: task.type,
            id: task.id,
            save: true,
            preserveExisting: true
          });
          if (remark.source === "local-fallback") fallbackCount += 1;
        } catch (err) {
          failures.push(`${task.alias || task.name}: ${err.message}`);
        } finally {
          completed += 1;
          setBatchProgress({ running: true, completed, total: pendingTasks.length });
        }
      }
    }

    await Promise.all(Array.from({ length: Math.min(2, pendingTasks.length) }, () => worker()));
    await refresh();
    setBatchProgress({ running: false, completed, total: pendingTasks.length });

    const successCount = pendingTasks.length - failures.length;
    if (failures.length) {
      setError(`批量生成完成：成功 ${successCount} 个，失败 ${failures.length} 个。${failures[0]}`);
      return;
    }
    const fallbackText = fallbackCount ? `，其中 ${fallbackCount} 个使用本地规则` : "";
    setBatchMessage(`已为 ${successCount} 个系统任务补全备注${fallbackText}`);
  }

  async function loadAgentData({ silent = false } = {}) {
    if (!silent) setAgentRefreshing(true);
    try {
      const [status, tools, skills] = await Promise.all([api.get("/api/agent/status"), api.get("/api/agent/tools"), api.get("/api/agent/skills")]);
      const next = { status, tools, skills };
      setAgentData(next);
      agentSnapshotRef.current = next;
      writeMenuSnapshot("agent", next);
    } catch (err) {
      setError(err.message);
    } finally {
      if (!silent) setAgentRefreshing(false);
    }
  }

  async function deleteSelected() {
    if (!selected) return;
    const label = selected.alias || selected.name;
    if (!window.confirm(`确认删除任务「${label}」？`)) return;
    try {
      await api.delete(`/api/tasks/${selected.type}/${selected.id}`);
      setSelected(null);
      setDetail(null);
      await refresh();
    } catch (err) {
      setError(err.message);
    }
  }

  function showSystemSettingFromNav(id) {
    setActiveSection("system-settings");
    setSettingsExpanded(true);
    setSystemSettingView(id);
    setError("");
  }

  const selectedSystemSetting = SYSTEM_SETTING_CARDS.find(({ id }) => id === systemSettingView) || null;

  return (
    <div className="shell">
      <aside className="sidebar">
        <div className="brand">
          <Activity size={22} />
          <span>我的macOS</span>
        </div>
        <div className="navSectionLabel">快捷访问</div>
        <button className={`navItem navItemPrimary ${activeSection === "processes" ? "active" : ""}`} onClick={() => setActiveSection("processes")} title="进程管理">
          <Cpu size={18} />
          <span>进程管理</span>
        </button>
        <button className={`navItem ${activeSection === "storage" ? "active" : ""}`} onClick={() => setActiveSection("storage")} title="存储空间">
          <HardDrive size={18} />
          <span>存储空间</span>
        </button>
        <button className={`navItem ${activeSection === "tasks" ? "active" : ""}`} onClick={() => setActiveSection("tasks")} title="系统任务">
          <CalendarClock size={18} />
          <span>系统任务</span>
        </button>
        <button className={`navItem ${activeSection === "network-monitor" ? "active" : ""}`} onClick={() => setActiveSection("network-monitor")} title="网络足迹">
          <Globe size={18} />
          <span>网络足迹</span>
        </button>
        <div className="navSectionLabel navSectionLabelSpaced">应用</div>
        <div className="navGroup">
          <button
            className={`navItem ${["apps", "files", "login-items", "permissions"].includes(activeSection) ? "active" : ""}`}
            onClick={() => {
              setActiveSection("apps");
              setAppsExpanded((expanded) => !expanded);
            }}
            aria-expanded={appsExpanded}
            aria-controls="apps-subnav"
            title="我的应用"
          >
            <PackageOpen size={18} />
            <span>我的应用</span>
            {appsExpanded ? <ChevronDown size={15} /> : <ChevronRight size={15} />}
          </button>
          {appsExpanded && (
            <div className="subnav" id="apps-subnav">
              {[
                ["apps", "应用管理", <PackageOpen size={15} />],
                ["files", "默认打开", <FolderOpen size={15} />],
                ["login-items", "开机启动", <Power size={15} />],
                ["permissions", "应用授权", <ShieldCheck size={15} />]
              ].map(([id, label, icon]) => (
                <button key={id} className={activeSection === id ? "selected" : ""} onClick={() => { setActiveSection(id); setAppsExpanded(true); }} title={label}>
                  {icon}
                  <span>{label}</span>
                </button>
              ))}
            </div>
          )}
        </div>
        <div className="navSectionLabel navSectionLabelSpaced">系统</div>
        <div className="navGroup">
          <button
            className={`navItem ${activeSection === "system-settings" ? "active" : ""}`}
            onClick={() => {
              setActiveSection("system-settings");
              setSystemSettingView(null);
              setSettingsExpanded((expanded) => !expanded);
            }}
            aria-expanded={settingsExpanded}
            aria-controls="settings-subnav"
            title="系统设置"
          >
            <Settings2 size={18} />
            <span>系统设置</span>
            {settingsExpanded ? <ChevronDown size={15} /> : <ChevronRight size={15} />}
          </button>
          {settingsExpanded && (
            <div className="subnav" id="settings-subnav">
              {SYSTEM_SETTING_CARDS.map(({ id, label, icon: Icon }) => (
                <button
                  key={id}
                  className={activeSection === "system-settings" && systemSettingView === id ? "selected" : ""}
                  onClick={() => showSystemSettingFromNav(id)}
                  title={label}
                >
                  <Icon size={15} />
                  <span>{label}</span>
                </button>
              ))}
            </div>
          )}
        </div>
        <div className="navSectionLabel navSectionLabelSpaced">系统信息</div>
        <div className="navGroup">
          <button
            className={`navItem ${activeSection === "system-info" ? "active" : ""}`}
            onClick={() => {
              setActiveSection("system-info");
              setSystemInfoExpanded((expanded) => !expanded);
            }}
            aria-expanded={systemInfoExpanded}
            aria-controls="system-info-subnav"
            title="系统信息"
          >
            <BatteryCharging size={18} />
            <span>系统信息</span>
            {systemInfoExpanded ? <ChevronDown size={15} /> : <ChevronRight size={15} />}
          </button>
          {systemInfoExpanded && (
            <div className="subnav" id="system-info-subnav">
              {[
                ["power", "电池与电源", <Battery size={15} />],
                ["sleep", "睡眠唤醒", <Moon size={15} />],
                ["updates", "软件更新", <Download size={15} />],
                ["network", "网络诊断", <Wifi size={15} />],
                ["backup", "备份与导出", <Archive size={15} />],
                ["leftovers", "卸载残留", <Trash2 size={15} />]
              ].map(([id, label, icon]) => (
                <button
                  key={id}
                  className={activeSection === "system-info" && systemInfoView === id ? "selected" : ""}
                  onClick={() => {
                    setActiveSection("system-info");
                    setSystemInfoView(id);
                    setSystemInfoExpanded(true);
                  }}
                  title={label}
                >
                  {icon}
                  <span>{label}</span>
                </button>
              ))}
            </div>
          )}
        </div>
        <div className="navSectionLabel navSectionLabelSpaced">工具</div>
        <div className="navGroup">
          <button
            className={`navItem ${activeSection === "tools" ? "active" : ""}`}
            onClick={() => {
              setActiveSection("tools");
              setToolsView(null);
              setToolsExpanded((expanded) => !expanded);
            }}
            aria-expanded={toolsExpanded}
            aria-controls="tools-subnav"
            title="工具配置"
          >
            <Wrench size={18} />
            <span>工具配置</span>
            {toolsExpanded ? <ChevronDown size={15} /> : <ChevronRight size={15} />}
          </button>
          {toolsExpanded && (
            <div className="subnav" id="tools-subnav">
              <button
                className={activeSection === "tools" && toolsView === "ssh" ? "selected" : ""}
                onClick={() => {
                  setActiveSection("tools");
                  setToolsView("ssh");
                  setToolsExpanded(true);
                }}
                title="SSH 管理"
              >
                <KeyRound size={15} />
                <span>SSH 管理</span>
              </button>
            </div>
          )}
        </div>
        <div className="navGroup agentNavGroup">
          <button
            className={`navItem ${activeSection === "agent" ? "active" : ""}`}
            onClick={() => {
              setActiveSection("agent");
              setAgentExpanded((expanded) => !expanded);
            }}
            aria-expanded={agentExpanded}
            aria-controls="agent-subnav"
            title="Agent 管理"
          >
            <Bot size={18} />
            <span>Agent 管理</span>
            {agentExpanded ? <ChevronDown size={15} /> : <ChevronRight size={15} />}
          </button>
          {agentExpanded && (
            <div className="subnav" id="agent-subnav">
              {[
                ["chat", "对话", <MessageSquare size={15} />],
                ["harness", "Harness Agent", <Brain size={15} />],
                ["tools", "MCP Tools", <Cable size={15} />],
                ["skills", "内置 Skills", <Sparkles size={15} />],
                ["model", "AI 配置", <Settings2 size={15} />]
              ].map(([id, label, icon]) => (
                <button
                  key={id}
                  className={activeSection === "agent" && agentView === id ? "selected" : ""}
                  onClick={() => {
                    setActiveSection("agent");
                    setAgentView(id);
                  }}
                >
                  {icon}
                  <span>{label}</span>
                </button>
              ))}
            </div>
          )}
        </div>
      </aside>

      <main className="workspace">
        {activeSection === "storage" ? (
          <header className="topbar storageTopbar">
            <div>
              <h1>存储空间</h1>
              <p>查看本机磁盘占用，找到大文件与目录，并安全清理不再需要的内容。</p>
            </div>
          </header>
        ) : activeSection === "tasks" ? (
          <header className="topbar">
            <div>
              <h1>系统定时任务</h1>
              <p>查看 LaunchAgent 与 Crontab，读取本机任务状态与输出日志。</p>
            </div>
            <div className="topbarActions">
              <button
                className="secondaryButton batchButton"
                onClick={generateBatchRemarks}
                disabled={batchProgress.running || !missingRemarkCount}
                title="只为尚无备注的系统任务生成，不覆盖已有内容"
              >
                <Sparkles size={16} className={batchProgress.running ? "spin" : ""} />
                <span>
                  {batchProgress.running
                    ? `生成中 ${batchProgress.completed}/${batchProgress.total}`
                    : `批量补全备注 (${missingRemarkCount})`}
                </span>
              </button>
              <button className="iconButton addButton" onClick={() => setShowCreate(true)} aria-label="新增任务" title="新增任务">
                <Plus size={18} />
              </button>
              <button className="iconButton" onClick={() => refresh({ fresh: true })} aria-label="刷新" title="刷新">
                <RefreshCw size={18} className={refreshing ? "spin" : ""} />
              </button>
            </div>
          </header>
        ) : activeSection === "network-monitor" ? (
          <header className="topbar">
            <div>
              <h1>网络足迹</h1>
              <p>按应用观察本机对外访问与入站服务，并将公网目标映射到国家和省级地区。</p>
            </div>
          </header>
        ) : activeSection === "apps" ? (
          <header className="topbar">
            <div>
              <h1>我的应用</h1>
              <p>管理本机应用，并根据使用频率、稳定性和同类重叠情况做出取舍。</p>
            </div>
          </header>
        ) : activeSection === "processes" ? (
          <header className="topbar">
            <div>
              <h1>进程管理</h1>
              <p>查看本机正在运行的进程，按资源占用快速定位并强行终止异常任务。</p>
            </div>
          </header>
        ) : activeSection === "login-items" ? (
          <header className="topbar">
            <div>
              <h1>开机启动</h1>
              <p>管理登录时自动打开的应用，以及系统维护的后台项目。</p>
            </div>
          </header>
        ) : activeSection === "permissions" ? (
          <header className="topbar">
            <div>
              <h1>应用授权</h1>
              <p>集中核对应用隐私授权，并进入对应的 macOS 系统设置。</p>
            </div>
          </header>
        ) : activeSection === "files" ? (
          <header className="topbar filesTopbar">
            <div>
              <h1>默认打开</h1>
              <p>按文件类型管理本机应用的默认打开方式。</p>
            </div>
          </header>
        ) : activeSection === "system-settings" ? (
          <header className="topbar">
            <div>
              <h1>{selectedSystemSetting?.label || "系统设置"}</h1>
              <p>{selectedSystemSetting?.description || "集中查看电池、屏幕、声音、网络等系统策略。"}</p>
            </div>
          </header>
        ) : activeSection === "system-info" ? (
          <header className="topbar">
            <div>
              <h1>{{ power: "电池与电源", sleep: "睡眠与唤醒", updates: "软件更新", network: "网络诊断", backup: "备份与导出", leftovers: "卸载残留" }[systemInfoView] || "系统信息"}</h1>
              <p>{{
                power: "电池健康度、循环次数、供电状态与电源管理策略",
                sleep: "最近的睡眠、唤醒与暗唤醒事件及原因",
                updates: "当前 macOS 版本、可用更新与自动更新策略",
                network: "连通性、DNS、端口监听与下行带宽检测",
                backup: "Time Machine 状态、APFS 本地快照与配置导出导入",
                leftovers: "扫描并清理已卸载应用残留在用户资源库中的文件"
              }[systemInfoView] || ""}</p>
            </div>
            <div className="topbarActions" />
          </header>
        ) : activeSection === "tools" ? (
          <header className="topbar">
            <div>
              <h1>{toolsView === "ssh" ? "SSH 管理" : "工具配置"}</h1>
              <p>{toolsView === "ssh" ? "管理本机 SSH Key 与 ~/.ssh/config 主机配置。" : "集中管理开发与运维工具的本机配置。"}</p>
            </div>
          </header>
        ) : (
          <header className="topbar">
            <div>
              <h1>Agent 管理</h1>
              <p>管理本机内置 MCP Tools、系统任务识别 Skill，以及 Claude Agent SDK harness。</p>
            </div>
            <button className="iconButton" onClick={() => loadAgentData()} disabled={agentRefreshing} aria-label="刷新 Agent" title="刷新 Agent">
              <RefreshCw size={18} className={agentRefreshing ? "spin" : ""} />
            </button>
          </header>
        )}

        {error && <div className="error">{error}</div>}
        {batchMessage && <div className="notice" role="status">{batchMessage}</div>}

        {activeSection === "storage" ? (
          <StorageManager />
        ) : activeSection === "tasks" ? (
          <section className="contentGrid">
            <div className="taskPanel">
              <div className="panelHeader">
                <div className="segmented">
                  {["all", "launchd", "cron"].map((item) => (
                    <button key={item} className={filter === item ? "selected" : ""} onClick={() => setFilter(item)}>
                      {item === "all" ? "全部" : item === "launchd" ? "Launch" : "Cron"}
                    </button>
                  ))}
                </div>
                <label className="searchBox">
                  <Search size={16} />
                  <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="搜索任务、命令、备注" />
                </label>
              </div>

              <div className="taskList">
                {visibleTasks.map((task) => (
                  <button
                    key={`${task.type}-${task.id}`}
                    className={`taskRow ${selected?.id === task.id && selected?.type === task.type ? "active" : ""}`}
                    onClick={() => setSelected(task)}
                  >
                    <TaskBadge type={task.type} />
                    <div className="taskMeta">
                      <strong>{task.alias || task.name}</strong>
                      {task.alias && <span className="aliasLine">{task.name}</span>}
                      <TaskTags tags={task.tags} />
                      <span className="taskStatusLine">
                        <TaskStatus task={task} />
                        <span>{task.scope ? `${task.scope} · ${task.schedule}` : task.schedule}</span>
                      </span>
                    </div>
                    <ChevronRight size={16} />
                  </button>
                ))}
                {!visibleTasks.length && <div className="emptyState">没有匹配的任务</div>}
              </div>
            </div>

            <TaskDetail
              detail={detail}
              selected={selected}
              onRun={runSelected}
              onSaveMetadata={saveMetadata}
              onDelete={deleteSelected}
              onGenerateRemark={generateRemark}
              onToggleEnabled={toggleSelected}
            />
          </section>
        ) : activeSection === "network-monitor" ? (
          <NetworkMonitorManager />
        ) : activeSection === "apps" ? (
          <ApplicationsManager />
        ) : activeSection === "processes" ? (
          <ProcessesManager />
        ) : activeSection === "login-items" ? (
          <LoginItemsManager />
        ) : activeSection === "permissions" ? (
          <ApplicationPermissionsManager />
        ) : activeSection === "files" ? (
          <FilesManager />
        ) : activeSection === "system-settings" ? (
          <SystemSettingsManager selectedId={systemSettingView} onSelect={setSystemSettingView} />
        ) : activeSection === "system-info" ? (
          <SystemInfoManager view={systemInfoView} />
        ) : activeSection === "tools" ? (
          <ToolsConfigManager view={toolsView} onSelect={setToolsView} />
        ) : (
          <AgentManager view={agentView} data={agentData} onRefresh={() => loadAgentData()} />
        )}

        {showCreate && <TaskCreateModal onCreated={refresh} onClose={() => setShowCreate(false)} />}
      </main>
    </div>
  );
}

function FileApplicationIcon({ application, missing = false, size = "normal" }) {
  const [failed, setFailed] = useState(false);
  if (!application || failed) {
    return (
      <span className={`fileApplicationIcon fallback ${missing ? "missing" : ""} ${size}`} aria-hidden="true">
        {missing ? <FileText size={20} /> : <AppWindow size={20} />}
      </span>
    );
  }
  return (
    <span className={`fileApplicationIcon ${size}`}>
      <img src={application.iconUrl} alt="" loading="lazy" onError={() => setFailed(true)} />
    </span>
  );
}

function fileGroupKey(type) {
  return type.defaultBundleId || "__unassigned__";
}

function initialFileGroupKeys(types) {
  const ranked = new Map();
  for (const type of types || []) {
    const key = fileGroupKey(type);
    const value = ranked.get(key) || { count: 0, missing: false };
    value.count += 1;
    value.missing ||= type.handlerMissing;
    ranked.set(key, value);
  }
  return new Set(
    [...ranked.entries()]
      .sort((a, b) => Number(b[1].missing) - Number(a[1].missing) || b[1].count - a[1].count)
      .slice(0, 3)
      .map(([key]) => key)
  );
}

function FilesManager() {
  const snapshotRef = useRef(undefined);
  if (snapshotRef.current === undefined) snapshotRef.current = readMenuSnapshot("files");
  const [data, setData] = useState(() => snapshotRef.current || { types: [], applications: [], summary: { total: 0, assigned: 0, missing: 0, applicationCount: 0 } });
  const [query, setQuery] = useState("");
  const [loading, setLoading] = useState(() => !snapshotRef.current);
  const [expandedGroups, setExpandedGroups] = useState(() => initialFileGroupKeys(data.types));
  const [editingType, setEditingType] = useState(null);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");

  const groups = useMemo(() => {
    const normalizedQuery = query.trim().toLowerCase();
    const grouped = new Map();
    for (const type of data.types) {
      const haystack = [
        type.label,
        type.category,
        type.extensions.join(" "),
        type.defaultApplication?.name,
        type.defaultBundleId
      ]
        .filter(Boolean)
        .join(" ")
        .toLowerCase();
      if (normalizedQuery && !haystack.includes(normalizedQuery)) continue;
      const key = fileGroupKey(type);
      const current = grouped.get(key) || {
        key,
        application: type.defaultApplication,
        bundleId: type.defaultBundleId,
        missing: type.handlerMissing,
        types: []
      };
      current.types.push(type);
      current.missing ||= type.handlerMissing;
      grouped.set(key, current);
    }
    return [...grouped.values()].sort((a, b) => {
      if (a.missing !== b.missing) return Number(b.missing) - Number(a.missing);
      if (a.types.length !== b.types.length) return b.types.length - a.types.length;
      return (a.application?.name || "未指定").localeCompare(b.application?.name || "未指定", "zh-CN");
    });
  }, [data.types, query]);

  async function refresh({ announce = false, fresh = false, silent = false } = {}) {
    if (!silent) setLoading(true);
    setError("");
    try {
      const next = await api.get(`/api/file-associations${fresh ? "?fresh=1" : ""}`);
      setData(next);
      writeMenuSnapshot("files", next);
      setExpandedGroups((current) => {
        if (current.size) return current;
        return initialFileGroupKeys(next.types);
      });
      if (announce) setMessage("文件打开方式已刷新");
    } catch (err) {
      setError(err.message);
    } finally {
      if (!silent) setLoading(false);
    }
  }

  useEffect(() => {
    if (!snapshotRef.current) refresh();
  }, []);

  function toggleGroup(key) {
    setExpandedGroups((current) => {
      const next = new Set(current);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }

  async function handleChanged(type, application) {
    setEditingType(null);
    setMessage(`.${type.extensions[0]} 现在默认使用「${application.name}」打开`);
    await refresh({ fresh: true });
    setExpandedGroups((current) => new Set([...current, application.bundleId]));
  }

  return (
    <section className="filesPanel">
      <div className="filesToolbar">
        <label className="searchBox filesSearch">
          <Search size={17} />
          <input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="搜索文件类型、扩展名或应用"
            autoFocus
          />
          {query && (
            <button type="button" onClick={() => setQuery("")} aria-label="清空搜索" title="清空搜索">
              <X size={15} />
            </button>
          )}
        </label>
        <div className="filesStats" aria-label="文件关联概览">
          <span><strong>{data.summary.total}</strong> 种格式</span>
          <span><strong>{data.summary.applicationCount}</strong> 个默认应用</span>
          {data.summary.missing > 0 && <span className="missingStat"><strong>{data.summary.missing}</strong> 项需处理</span>}
        </div>
        <button className="iconButton" onClick={() => refresh({ announce: true, fresh: true })} disabled={loading} aria-label="刷新打开方式" title="刷新">
          <RefreshCw size={17} className={loading ? "spin" : ""} />
        </button>
      </div>

      {error && <div className="error fileFeedback" role="alert">{error}</div>}
      {message && <div className="notice fileFeedback" role="status">{message}</div>}

      <div className="fileGroups" aria-busy={loading}>
        {groups.map((group) => {
          const isExpanded = Boolean(query) || expandedGroups.has(group.key);
          const title = group.application?.name || (group.missing ? "应用不存在" : "未指定默认应用");
          return (
            <section className={`fileGroup ${group.missing ? "hasMissingHandler" : ""}`} key={group.key}>
              <button className="fileGroupHeader" onClick={() => toggleGroup(group.key)} aria-expanded={isExpanded}>
                <FileApplicationIcon application={group.application} missing={group.missing} />
                <span className="fileGroupIdentity">
                  <strong>{title}</strong>
                  <span title={group.missing ? group.bundleId : ""}>
                    {group.types.length} 种文件格式{group.missing ? ` · ${group.bundleId}` : ""}
                  </span>
                </span>
                {group.missing && <span className="missingHandlerBadge">原应用已移除</span>}
                <span className="fileTypePreview" aria-hidden="true">
                  {group.types.slice(0, 4).map((type) => `.${type.extensions[0]}`).join("  ")}
                  {group.types.length > 4 ? "  …" : ""}
                </span>
                {isExpanded ? <ChevronDown size={18} /> : <ChevronRight size={18} />}
              </button>

              {isExpanded && (
                <div className="fileTypeList">
                  {group.types.map((type) => (
                    <div className="fileTypeRow" key={type.id}>
                      <span className={`fileTypeGlyph category-${type.category}`} aria-hidden="true">
                        {type.extensions[0].slice(0, 4).toUpperCase()}
                      </span>
                      <span className="fileTypeIdentity">
                        <strong>{type.label}</strong>
                        <span>{type.extensions.map((extension) => `.${extension}`).join("  ")}</span>
                      </span>
                      <span className="fileCategory">{type.category}</span>
                      <button className="secondaryButton changeAssociationButton" onClick={() => setEditingType(type)}>
                        <Pencil size={14} />
                        <span>更改</span>
                      </button>
                    </div>
                  ))}
                </div>
              )}
            </section>
          );
        })}
        {!loading && !groups.length && (
          <div className="filesEmpty">
            <Files size={28} />
            <strong>没有匹配的文件类型</strong>
          </div>
        )}
        {loading && !data.types.length && <div className="filesEmpty">正在读取本机打开方式...</div>}
      </div>

      {editingType && (
        <ApplicationPickerModal
          fileType={editingType}
          applications={data.applications}
          onChanged={handleChanged}
          onClose={() => setEditingType(null)}
        />
      )}
    </section>
  );
}

function ApplicationPickerModal({ fileType, applications, onChanged, onClose }) {
  const [query, setQuery] = useState("");
  const [selectedBundleId, setSelectedBundleId] = useState(fileType.defaultBundleId || "");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const compatibleIds = useMemo(
    () => new Set(fileType.compatibleApplications.map(({ bundleId }) => bundleId.toLowerCase())),
    [fileType]
  );
  const visibleApplications = useMemo(() => {
    const normalizedQuery = query.trim().toLowerCase();
    return applications
      .filter((application) => {
        if (!normalizedQuery) return true;
        return [application.name, application.bundleId, application.path].join(" ").toLowerCase().includes(normalizedQuery);
      })
      .sort((a, b) => {
        const aCompatible = compatibleIds.has(a.bundleId.toLowerCase());
        const bCompatible = compatibleIds.has(b.bundleId.toLowerCase());
        if (aCompatible !== bCompatible) return Number(bCompatible) - Number(aCompatible);
        return a.name.localeCompare(b.name, "zh-CN");
      });
  }, [applications, compatibleIds, query]);

  useEffect(() => {
    function handleKeyDown(event) {
      if (event.key === "Escape") onClose();
    }
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [onClose]);

  async function save() {
    const application = applications.find(({ bundleId }) => bundleId === selectedBundleId);
    if (!application) return;
    setSaving(true);
    setError("");
    try {
      await api.post(`/api/file-associations/${fileType.id}/default`, { bundleId: application.bundleId });
      await onChanged(fileType, application);
    } catch (err) {
      setError(err.message);
      setSaving(false);
    }
  }

  return (
    <div className="modalBackdrop" onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
      <section className="applicationPicker" role="dialog" aria-modal="true" aria-labelledby="application-picker-title">
        <header className="pickerHeader">
          <div>
            <span className="fileTypeGlyph large" aria-hidden="true">{fileType.extensions[0].slice(0, 4).toUpperCase()}</span>
            <span>
              <h2 id="application-picker-title">选择默认应用</h2>
              <p>{fileType.label} · {fileType.extensions.map((extension) => `.${extension}`).join("  ")}</p>
            </span>
          </div>
          <button className="modalClose" type="button" onClick={onClose} aria-label="关闭" title="关闭">
            <X size={18} />
          </button>
        </header>

        <label className="searchBox pickerSearch">
          <Search size={16} />
          <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="搜索本机应用" autoFocus />
        </label>

        <div className="pickerList">
          {visibleApplications.map((application) => {
            const compatible = compatibleIds.has(application.bundleId.toLowerCase());
            const selected = application.bundleId === selectedBundleId;
            return (
              <button
                type="button"
                className={`pickerApplicationRow ${selected ? "selected" : ""}`}
                key={application.id}
                onClick={() => setSelectedBundleId(application.bundleId)}
              >
                <FileApplicationIcon application={application} size="small" />
                <span>
                  <strong>{application.name}</strong>
                  <small>{compatible ? "兼容此格式" : application.path}</small>
                </span>
                {compatible && <em>推荐</em>}
                <i>{selected && <Check size={15} />}</i>
              </button>
            );
          })}
          {!visibleApplications.length && <div className="pickerEmpty">没有匹配的应用</div>}
        </div>

        {error && <div className="error pickerError" role="alert">{error}</div>}
        <footer className="modalFooter pickerFooter">
          <span>{compatibleIds.size} 个兼容应用</span>
          <div>
            <button className="secondaryButton" type="button" onClick={onClose}>取消</button>
            <button className="primaryButton" type="button" onClick={save} disabled={saving || !selectedBundleId}>
              {saving ? "正在修改..." : "设为默认"}
            </button>
          </div>
        </footer>
      </section>
    </div>
  );
}

function ApplicationIcon({ application }) {
  const [failed, setFailed] = useState(false);
  if (failed || !application?.iconUrl) {
    return (
      <span className="applicationIcon fallback" aria-hidden="true">
        <AppWindow size={25} />
      </span>
    );
  }
  return (
    <span className="applicationIcon">
      <img src={application.iconUrl} alt="" loading="lazy" onError={() => setFailed(true)} />
    </span>
  );
}

const ANALYSIS_GROUP_COPY = {
  high: "持续使用，建议保留在常用工作流中",
  review: "同类重叠、长期低频或稳定性不佳",
  remove: "有明确闲置证据，且可安全移入废纸篓",
  observe: "使用强度一般，暂时没有足够证据清理",
  system: "系统组件，不纳入卸载建议"
};

function formatUsageDuration(minutes) {
  if (minutes === null || minutes === undefined) return "--";
  if (minutes < 60) return `${minutes} 分钟`;
  const hours = Math.floor(minutes / 60);
  const remainder = minutes % 60;
  return remainder ? `${hours} 小时 ${remainder} 分` : `${hours} 小时`;
}

function formatRelativeDate(value) {
  if (!value) return { relative: "无记录", exact: "没有可用的最近打开记录" };
  const date = new Date(value);
  const days = Math.max(0, Math.floor((Date.now() - date.getTime()) / 86_400_000));
  const relative = days === 0 ? "今天" : days === 1 ? "昨天" : days < 30 ? `${days} 天前` : days < 365 ? `${Math.floor(days / 30)} 个月前` : `${Math.floor(days / 365)} 年前`;
  return {
    relative,
    exact: new Intl.DateTimeFormat("zh-CN", { year: "numeric", month: "long", day: "numeric", hour: "2-digit", minute: "2-digit" }).format(date)
  };
}

function RecommendationIcon({ id, size = 15 }) {
  if (id === "high") return <TrendingUp size={size} />;
  if (id === "review") return <CircleAlert size={size} />;
  if (id === "remove") return <Trash2 size={size} />;
  if (id === "system") return <ShieldCheck size={size} />;
  return <CalendarDays size={size} />;
}

function AnalysisApplicationRow({ application, usageAvailable, busy, onAction }) {
  const { metrics, recommendation } = application;
  const lastUsed = formatRelativeDate(metrics.lastUsedAt);
  const openCount = metrics.useCount === null ? "累计次数未知" : `累计 ${metrics.useCount.toLocaleString("zh-CN")} 次`;
  const usageText = usageAvailable ? formatUsageDuration(metrics.usageMinutes30) : "--";

  return (
    <article className={`analysisApplicationRow recommendation-${recommendation.id}`}>
      <div className="analysisApplicationMain">
        <ApplicationIcon application={application} />
        <div className="applicationIdentity">
          <div className="applicationNameLine">
            <strong>{application.name}</strong>
            {application.running && <span className="appStatus running">运行中</span>}
            {application.system && <span className="systemLabel">系统</span>}
          </div>
          <span className="analysisCategoryTag">{application.category.label}</span>
          <span className="applicationVersion" title={application.bundleId}>{application.bundleId || application.location}</span>
        </div>
      </div>

      <div className="analysisMetric" data-label="打开频率">
        <strong className={`frequency-${recommendation.frequency.id}`}>{recommendation.frequency.label}</strong>
        <span>近30天 {metrics.activeDays30} 天</span>
        <small>{openCount}</small>
      </div>

      <div className="analysisMetric" data-label="最近打开" title={lastUsed.exact}>
        <strong>{lastUsed.relative}</strong>
        <span>{metrics.lastUsedAt ? new Intl.DateTimeFormat("zh-CN", { month: "numeric", day: "numeric" }).format(new Date(metrics.lastUsedAt)) : "Spotlight"}</span>
      </div>

      <div className="analysisMetric usageMetric" data-label="使用时间" title={usageAvailable ? "近30天前台使用时间" : "需要完全磁盘访问权限"}>
        <strong>{usageText}</strong>
        <span>{usageAvailable ? `${metrics.sessionCount30} 个会话` : "等待授权"}</span>
      </div>

      <div className={`analysisMetric crashMetric ${metrics.crashCount90 ? "hasCrashes" : ""}`} data-label="崩溃">
        <strong>{metrics.crashCount90}</strong>
        <span>近90天</span>
      </div>

      <div className="analysisRecommendation">
        <span className={`recommendationBadge ${recommendation.tone}`}>
          <RecommendationIcon id={recommendation.id} />
          {recommendation.label}
        </span>
        <small title={recommendation.reasons.join("；")}>{recommendation.reasons.join(" · ")}</small>
      </div>

      <div className="analysisRowActions">
        <button className="iconButton" onClick={() => onAction(application, "open")} disabled={busy} aria-label={`打开${application.name}`} title="打开应用">
          <ExternalLink size={15} />
        </button>
        {application.removable && !application.system && (
          <button
            className="iconButton analysisDeleteButton"
            onClick={() => {
              const runningText = application.running ? "应用将先被强制停止，" : "";
              if (window.confirm(`${runningText}确认将「${application.name}」移入废纸篓？`)) onAction(application, "uninstall");
            }}
            disabled={busy || application.current}
            aria-label={`卸载${application.name}`}
            title="移入废纸篓"
          >
            <Trash2 size={15} />
          </button>
        )}
      </div>
    </article>
  );
}

function ApplicationAnalysisView({ analysis, query, onQueryChange, loading, busyId, onRefresh, onAction, onOpenFullDiskAccess }) {
  const [recommendationFilter, setRecommendationFilter] = useState("all");
  const [categoryFilter, setCategoryFilter] = useState("all");
  const normalizedQuery = query.trim().toLowerCase();
  const usageAvailable = Boolean(analysis.sources?.usage?.available);

  const visibleApplications = useMemo(() => analysis.applications.filter((application) => {
    if (recommendationFilter !== "all" && application.recommendation.id !== recommendationFilter) return false;
    if (categoryFilter !== "all" && application.category.id !== categoryFilter) return false;
    if (!normalizedQuery) return true;
    return [
      application.name,
      application.bundleId,
      application.category.label,
      application.recommendation.label,
      application.recommendation.reasons.join(" ")
    ].filter(Boolean).join(" ").toLowerCase().includes(normalizedQuery);
  }), [analysis.applications, categoryFilter, normalizedQuery, recommendationFilter]);

  const groups = analysis.recommendations
    .filter(({ id }) => recommendationFilter === "all" || recommendationFilter === id)
    .map((recommendation) => ({
      ...recommendation,
      applications: visibleApplications.filter((application) => application.recommendation.id === recommendation.id)
    }))
    .filter(({ applications }) => applications.length);

  const spotlightCoverage = Math.round((analysis.sources?.spotlight?.coverage || 0) * 100);
  const summary = analysis.summary || {};

  return (
    <div className="applicationAnalysis" aria-busy={loading}>
      <div className="analysisSummaryBand" aria-label="分析概览">
        <div className="analysisSummaryItem high">
          <TrendingUp size={18} />
          <span><small>高频应用</small><strong>{summary.high || 0}</strong></span>
        </div>
        <div className="analysisSummaryItem review">
          <CircleAlert size={18} />
          <span><small>建议取舍</small><strong>{summary.review || 0}</strong></span>
        </div>
        <div className="analysisSummaryItem remove">
          <Trash2 size={18} />
          <span><small>建议删除</small><strong>{summary.remove || 0}</strong></span>
        </div>
        <div className="analysisSummaryItem duration">
          <Clock3 size={18} />
          <span><small>近30天使用</small><strong>{usageAvailable ? formatUsageDuration(summary.totalUsageMinutes30 || 0) : "待授权"}</strong></span>
        </div>
        <div className="analysisSummaryItem crashes">
          <CircleAlert size={18} />
          <span><small>近90天崩溃</small><strong>{summary.totalCrashes90 || 0}</strong></span>
        </div>
      </div>

      <div className={`analysisCoverage ${usageAvailable ? "complete" : "needsPermission"}`}>
        <Database size={17} />
        <div>
          <strong>数据覆盖 {spotlightCoverage}%</strong>
          <span>
            最近使用来自 Spotlight · 崩溃记录 {analysis.sources?.crashes?.available ? "已读取" : "不可用"} · 使用时间 {usageAvailable ? "已读取" : "未授权"}
          </span>
        </div>
        {!usageAvailable && analysis.sources?.usage?.requiresFullDiskAccess && (
          <button className="secondaryButton" onClick={onOpenFullDiskAccess}>
            <ShieldCheck size={15} />
            <span>授权使用时间</span>
          </button>
        )}
      </div>

      <div className="analysisFilterBar">
        <div className="analysisRecommendationFilters" role="tablist" aria-label="分析建议筛选">
          <button className={recommendationFilter === "all" ? "selected" : ""} onClick={() => setRecommendationFilter("all")}>
            全部 <strong>{analysis.summary?.total || 0}</strong>
          </button>
          {analysis.recommendations.map((recommendation) => (
            <button
              key={recommendation.id}
              className={`${recommendationFilter === recommendation.id ? "selected" : ""} tone-${recommendation.tone}`}
              onClick={() => setRecommendationFilter(recommendation.id)}
            >
              <RecommendationIcon id={recommendation.id} size={14} />
              <span>{recommendation.label}</span>
              <strong>{recommendation.count}</strong>
            </button>
          ))}
        </div>
        <div className="analysisTools">
          <label className="searchBox analysisSearch">
            <Search size={16} />
            <input value={query} onChange={(event) => onQueryChange(event.target.value)} placeholder="搜索应用或分析理由" />
            {query && (
              <button type="button" onClick={() => onQueryChange("")} aria-label="清空搜索" title="清空搜索"><X size={14} /></button>
            )}
          </label>
          <label className="analysisCategorySelect">
            <span>应用类型</span>
            <select value={categoryFilter} onChange={(event) => setCategoryFilter(event.target.value)}>
              <option value="all">全部类型</option>
              {analysis.categories.map((category) => <option key={category.id} value={category.id}>{category.label} · {category.count}</option>)}
            </select>
          </label>
          <button className="iconButton" onClick={() => onRefresh({ fresh: true })} disabled={loading} aria-label="刷新分析" title="刷新分析数据">
            <RefreshCw size={17} className={loading ? "spin" : ""} />
          </button>
        </div>
      </div>

      <div className="analysisGroups">
        {groups.map((group) => (
          <section className={`analysisGroup tone-${group.tone}`} key={group.id}>
            <header className="analysisGroupHeader">
              <div>
                <RecommendationIcon id={group.id} size={16} />
                <strong>{group.label}</strong>
                <span>{group.applications.length}</span>
              </div>
              <p>{ANALYSIS_GROUP_COPY[group.id]}</p>
            </header>
            <div className="analysisTableHeader" aria-hidden="true">
              <span>应用</span><span>打开频率</span><span>最近打开</span><span>使用时间</span><span>崩溃</span><span>分析建议</span><span />
            </div>
            {group.applications.map((application) => (
              <AnalysisApplicationRow
                key={application.id}
                application={application}
                usageAvailable={usageAvailable}
                busy={busyId.startsWith(`${application.id}:`)}
                onAction={onAction}
              />
            ))}
          </section>
        ))}
        {!loading && !groups.length && (
          <div className="applicationsEmpty">
            <BarChart3 size={28} />
            <strong>没有符合当前条件的应用</strong>
          </div>
        )}
        {loading && !analysis.applications.length && <div className="applicationsEmpty">正在汇总本机使用记录...</div>}
      </div>
    </div>
  );
}

function ApplicationsManager() {
  const dataSnapshotRef = useRef(undefined);
  if (dataSnapshotRef.current === undefined) dataSnapshotRef.current = readMenuSnapshot("apps");
  const analysisSnapshotRef = useRef(undefined);
  if (analysisSnapshotRef.current === undefined) analysisSnapshotRef.current = readMenuSnapshot("apps-analysis");
  const analysisRefreshStartedRef = useRef(false);
  const initialData = dataSnapshotRef.current || { applications: [], summary: { total: 0, running: 0, removable: 0 } };
  const initialAnalysis = analysisSnapshotRef.current || { applications: [], recommendations: [], categories: [], summary: {}, sources: {} };
  const [view, setView] = useState("manage");
  const [data, setData] = useState(initialData);
  const [analysis, setAnalysis] = useState(initialAnalysis);
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState("all");
  const [loading, setLoading] = useState(() => !dataSnapshotRef.current);
  const [analysisLoading, setAnalysisLoading] = useState(false);
  const [busyId, setBusyId] = useState("");
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");

  const visibleApplications = useMemo(() => {
    const normalizedQuery = query.trim().toLowerCase();
    return data.applications.filter((application) => {
      if (filter === "running" && !application.running) return false;
      if (!normalizedQuery) return true;
      return [application.name, application.bundleId, application.version, application.path, application.location]
        .filter(Boolean)
        .join(" ")
        .toLowerCase()
        .includes(normalizedQuery);
    });
  }, [data.applications, filter, query]);

  async function refreshApplications({ fresh = false, silent = false } = {}) {
    if (!silent) setLoading(true);
    setError("");
    try {
      const next = await api.get(`/api/apps${fresh ? "?fresh=1" : ""}`);
      setData(next);
      writeMenuSnapshot("apps", next);
    } catch (err) {
      setError(err.message);
    } finally {
      if (!silent) setLoading(false);
    }
  }

  async function refreshAnalysis({ fresh = false, silent = false } = {}) {
    if (!silent) setAnalysisLoading(true);
    setError("");
    try {
      const next = await api.get(`/api/apps-analysis${fresh ? "?fresh=1" : ""}`);
      setAnalysis(next);
      writeMenuSnapshot("apps-analysis", next);
    } catch (err) {
      setError(err.message);
    } finally {
      if (!silent) setAnalysisLoading(false);
    }
  }

  useEffect(() => {
    if (!dataSnapshotRef.current) refreshApplications();
  }, []);

  useEffect(() => {
    if (view !== "analysis" || analysisRefreshStartedRef.current) return;
    analysisRefreshStartedRef.current = true;
    if (!analysisSnapshotRef.current) refreshAnalysis();
  }, [view]);

  async function openFullDiskAccess() {
    setError("");
    try {
      await api.post("/api/apps-analysis/open-full-disk-access", {});
      setMessage("已打开“完全磁盘访问权限”，授权后请刷新分析数据");
    } catch (err) {
      setError(err.message);
    }
  }

  async function runAction(application, action) {
    const actionKey = `${application.id}:${action}`;
    setBusyId(actionKey);
    setError("");
    setMessage("");
    try {
      if (action === "uninstall") {
        await api.delete(`/api/apps/${application.id}`);
        setMessage(`「${application.name}」已移入废纸篓`);
      } else {
        await api.post(`/api/apps/${application.id}/${action}`, {});
        const labels = { open: "已打开", stop: "已强制停止", restart: "已重启" };
        setMessage(`「${application.name}」${labels[action]}`);
      }
      await refreshApplications({ fresh: action === "uninstall" });
      if (analysis.applications.length) await refreshAnalysis({ fresh: action === "uninstall" || action === "open" });
    } catch (err) {
      setError(err.message);
    } finally {
      setBusyId("");
    }
  }

  return (
    <section className="applicationsPanel">
      <div className="applicationsViewBar">
        <div className="applicationsViewTabs" role="tablist" aria-label="我的应用视图">
          <button className={view === "manage" ? "selected" : ""} onClick={() => { setView("manage"); setQuery(""); }}>
            <LayoutList size={16} />
            <span>应用列表</span>
          </button>
          <button className={view === "analysis" ? "selected" : ""} onClick={() => { setView("analysis"); setQuery(""); }}>
            <BarChart3 size={16} />
            <span>应用分析</span>
          </button>
        </div>
        {view === "analysis" && analysis.generatedAt && (
          <span className="analysisGeneratedAt">分析于 {new Intl.DateTimeFormat("zh-CN", { hour: "2-digit", minute: "2-digit" }).format(new Date(analysis.generatedAt))}</span>
        )}
      </div>

      {error && <div className="error applicationFeedback" role="alert">{error}</div>}
      {message && <div className="notice applicationFeedback" role="status">{message}</div>}

      {view === "analysis" ? (
        <ApplicationAnalysisView
          analysis={analysis}
          query={query}
          onQueryChange={setQuery}
          loading={analysisLoading}
          busyId={busyId}
          onRefresh={refreshAnalysis}
          onAction={runAction}
          onOpenFullDiskAccess={openFullDiskAccess}
        />
      ) : (
        <>
          <div className="applicationsToolbar">
            <label className="searchBox applicationSearch">
              <Search size={17} />
              <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="搜索应用名称、版本、标识或路径" autoFocus />
              {query && (
                <button type="button" onClick={() => setQuery("")} aria-label="清空搜索" title="清空搜索"><X size={15} /></button>
              )}
            </label>
            <div className="segmented applicationFilter" aria-label="应用筛选">
              <button className={filter === "all" ? "selected" : ""} onClick={() => setFilter("all")}>全部 {data.summary.total}</button>
              <button className={filter === "running" ? "selected" : ""} onClick={() => setFilter("running")}>运行中 {data.summary.running}</button>
            </div>
            <button className="iconButton" onClick={() => refreshApplications({ fresh: true })} disabled={loading} aria-label="刷新应用" title="刷新应用">
              <RefreshCw size={17} className={loading ? "spin" : ""} />
            </button>
          </div>

          <div className="applicationsSummary" aria-label="应用概览">
            <span><strong>{data.summary.total}</strong> 个应用</span>
            <span><i className="runningDot" /> <strong>{data.summary.running}</strong> 个正在运行</span>
            <span><strong>{data.summary.removable}</strong> 个可清理</span>
          </div>

          <div className="applicationList" aria-busy={loading}>
            {visibleApplications.map((application) => {
              const processInfo = application.processes;
              const isBusy = busyId.startsWith(`${application.id}:`);
              return (
                <article className="applicationRow" key={application.id}>
                  <ApplicationIcon application={application} />
                  <div className="applicationIdentity">
                    <div className="applicationNameLine">
                      <strong>{application.name}</strong>
                      {application.running ? <span className="appStatus running">运行中</span> : <span className="appStatus">未运行</span>}
                      {application.system && <span className="systemLabel">系统</span>}
                    </div>
                    <span className="applicationVersion">
                      {application.version ? `版本 ${application.version}` : "版本未知"}
                      {application.bundleId ? ` · ${application.bundleId}` : ""}
                    </span>
                    <span className="applicationPath" title={application.path}>{application.location} · {application.path}</span>
                  </div>

                  <div className={`processFacts ${application.running ? "visible" : ""}`}>
                    {application.running ? (
                      <>
                        <span title={`PID ${processInfo.pids.join(", ")}`}><Activity size={14} /> {processInfo.processCount} 个进程</span>
                        <span><MemoryStick size={14} /> {processInfo.memory.toFixed(1)}% 内存</span>
                        <span><Clock3 size={14} /> {processInfo.elapsed}</span>
                      </>
                    ) : <span className="inactiveProcess">当前没有活动进程</span>}
                  </div>

                  <div className="applicationActions">
                    <button className="secondaryButton" onClick={() => runAction(application, "open")} disabled={isBusy}>
                      <ExternalLink size={15} /><span>打开</span>
                    </button>
                    {application.running && (
                      <>
                        <button className="secondaryButton stopButton" onClick={() => runAction(application, "stop")} disabled={isBusy || application.current} title={application.current ? "不能强制停止当前管理器" : "强制停止全部相关进程"}>
                          <Square size={14} /><span>强停</span>
                        </button>
                        <button className="secondaryButton" onClick={() => runAction(application, "restart")} disabled={isBusy || application.current} title={application.current ? "不能从当前管理器内重启自身" : "强制停止后重新打开"}>
                          <RotateCcw size={15} className={busyId === `${application.id}:restart` ? "spin" : ""} /><span>重启</span>
                        </button>
                      </>
                    )}
                    <button
                      className="dangerButton"
                      onClick={() => {
                        const runningText = application.running ? "应用将先被强制停止，" : "";
                        if (window.confirm(`${runningText}确认将「${application.name}」移入废纸篓？`)) runAction(application, "uninstall");
                      }}
                      disabled={isBusy || !application.removable || application.current}
                      title={application.current ? "不能卸载当前管理器" : application.removable ? "移入废纸篓" : "系统应用不能卸载"}
                    >
                      <Trash2 size={15} /><span>卸载</span>
                    </button>
                  </div>
                </article>
              );
            })}
            {!loading && !visibleApplications.length && (
              <div className="applicationsEmpty">
                <AppWindow size={28} />
                <strong>{query ? "没有匹配的应用" : filter === "running" ? "当前没有运行中的应用" : "没有找到应用"}</strong>
              </div>
            )}
            {loading && !data.applications.length && <div className="applicationsEmpty">正在读取本机应用...</div>}
          </div>
        </>
      )}
    </section>
  );
}

const EMPTY_PROCESS_DATA = {
  processes: [],
  metrics: {
    cpuPercent: 0,
    cpuCores: [],
    cpuModel: "",
    logicalCpuCount: 0,
    temperatureC: null,
    loadAverage: [0, 0, 0],
    uptimeSeconds: 0,
    memoryPercent: 0,
    memoryUsedMb: 0,
    memoryAvailableMb: 0,
    memoryTotalMb: 0,
    memoryFreeMb: 0,
    memoryCachedMb: 0,
    memoryWiredMb: 0,
    memoryCompressedMb: 0,
    memoryPressure: "normal",
    swapUsedMb: 0,
    swapTotalMb: 0,
    swapEncrypted: false,
    processCount: 0,
    threadCount: 0,
    sampleDurationMs: 0,
    generatedAt: ""
  },
  disks: [],
  diskIoBytesPerSecond: 0,
  network: { activeInterface: "", interfaces: [] }
};

const PROCESS_ROW_HEIGHT = 58;

function formatMetricBytes(value, { rate = false } = {}) {
  const bytes = Math.max(0, Number(value) || 0);
  const units = ["B", "KiB", "MiB", "GiB", "TiB"];
  let amount = bytes;
  let unitIndex = 0;
  while (amount >= 1024 && unitIndex < units.length - 1) {
    amount /= 1024;
    unitIndex += 1;
  }
  const digits = amount >= 100 || unitIndex === 0 ? 0 : amount >= 10 ? 1 : 2;
  return `${amount.toFixed(digits)} ${units[unitIndex]}${rate ? "/s" : ""}`;
}

function formatMemory(mb) {
  return formatMetricBytes((Number(mb) || 0) * 1024 * 1024);
}

function formatUptime(seconds) {
  const total = Math.max(0, Math.floor(Number(seconds) || 0));
  const days = Math.floor(total / 86400);
  const hours = Math.floor((total % 86400) / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  return days ? `${days}天 ${hours}小时` : hours ? `${hours}小时 ${minutes}分` : `${minutes}分钟`;
}

function compareProcesses(first, second, sort) {
  const firstValue = first[sort.key];
  const secondValue = second[sort.key];
  let result;
  if (typeof firstValue === "number" && typeof secondValue === "number") result = firstValue - secondValue;
  else result = String(firstValue || "").localeCompare(String(secondValue || ""), "zh-CN");
  return (sort.direction === "asc" ? result : -result) || first.pid - second.pid;
}

function processMatchesQuery(processInfo, query) {
  if (!query) return true;
  return [processInfo.processName, processInfo.applicationName, processInfo.command, processInfo.user, processInfo.pid]
    .filter(Boolean)
    .join(" ")
    .toLowerCase()
    .includes(query);
}

function buildProcessRows(processes, query, sort, viewMode) {
  const normalizedQuery = query.trim().toLowerCase();
  if (viewMode === "list") {
    return processes.filter((item) => processMatchesQuery(item, normalizedQuery)).sort((a, b) => compareProcesses(a, b, sort));
  }

  const byPid = new Map(processes.map((item) => [item.pid, item]));
  const included = normalizedQuery
    ? new Set(processes.filter((item) => processMatchesQuery(item, normalizedQuery)).map((item) => item.pid))
    : new Set(byPid.keys());
  if (normalizedQuery) {
    for (const pid of [...included]) {
      let current = byPid.get(pid);
      const ancestors = new Set();
      while (current && byPid.has(current.parentPid) && !ancestors.has(current.parentPid)) {
        ancestors.add(current.parentPid);
        included.add(current.parentPid);
        current = byPid.get(current.parentPid);
      }
    }
  }

  const children = new Map();
  const roots = [];
  for (const processInfo of processes) {
    if (!included.has(processInfo.pid)) continue;
    if (included.has(processInfo.parentPid) && processInfo.parentPid !== processInfo.pid) {
      const siblings = children.get(processInfo.parentPid) || [];
      siblings.push(processInfo);
      children.set(processInfo.parentPid, siblings);
    } else {
      roots.push(processInfo);
    }
  }
  const ordered = [];
  const visited = new Set();
  const visit = (item, depth) => {
    if (visited.has(item.pid)) return;
    visited.add(item.pid);
    ordered.push({ ...item, depth });
    for (const child of (children.get(item.pid) || []).sort((a, b) => compareProcesses(a, b, sort))) visit(child, depth + 1);
  };
  for (const root of roots.sort((a, b) => compareProcesses(a, b, sort))) visit(root, 0);
  for (const item of processes) {
    if (included.has(item.pid) && !visited.has(item.pid)) visit(item, 0);
  }
  return ordered;
}

function ProcessSortHeader({ label, sortKey, sort, onSort, className = "" }) {
  const active = sort.key === sortKey;
  return (
    <button
      type="button"
      className={`processSortHeader ${active ? "active" : ""} ${className}`}
      onClick={() => onSort(sortKey)}
      aria-label={`按${label}排序`}
      aria-sort={active ? (sort.direction === "asc" ? "ascending" : "descending") : "none"}
    >
      <span>{label}</span>
      {active ? (sort.direction === "asc" ? <ArrowUp size={13} /> : <ArrowDown size={13} />) : <ArrowDown size={12} className="sortHint" />}
    </button>
  );
}

function ResourceTrendChart({ history }) {
  const width = 470;
  const height = 136;
  const padding = 12;
  const pointsFor = (key) => {
    const values = history.length ? history.map((sample) => Number(sample[key]) || 0) : [0];
    const step = values.length > 1 ? (width - padding * 2) / (values.length - 1) : 0;
    return values.map((value, index) => `${(padding + step * index).toFixed(1)},${(height - padding - (Math.min(100, Math.max(0, value)) / 100) * (height - padding * 2)).toFixed(1)}`).join(" ");
  };

  return (
    <div className="resourceTrend" aria-label="CPU 和内存最近波动">
      <div className="resourceTrendHeader">
        <div><strong>资源趋势</strong><span>最近 {Math.max(history.length, 1)} 秒</span></div>
        <span className="liveIndicator"><i />实时</span>
      </div>
      <svg className="resourceChart" viewBox={`0 0 ${width} ${height}`} role="img" aria-label="CPU 和内存使用率折线图" preserveAspectRatio="none">
        {[25, 50, 75].map((value) => {
          const y = height - padding - (value / 100) * (height - padding * 2);
          return <line key={value} x1={padding} x2={width - padding} y1={y} y2={y} className="chartGridLine" />;
        })}
        <polyline points={pointsFor("memory")} className="chartLine memoryLine" />
        <polyline points={pointsFor("cpu")} className="chartLine cpuLine" />
      </svg>
      <div className="resourceTrendLegend"><span><i className="legendSwatch cpuSwatch" />CPU</span><span><i className="legendSwatch memorySwatch" />内存</span><span className="chartScale">0&nbsp;&nbsp;&nbsp;25&nbsp;&nbsp;&nbsp;50&nbsp;&nbsp;&nbsp;75&nbsp;&nbsp;&nbsp;100%</span></div>
    </div>
  );
}

function SystemMonitorOverview({ data, history }) {
  const { metrics, disks, network } = data;
  const primaryDisk = disks.find(({ mount }) => mount.endsWith("/Data")) || disks.find(({ mount }) => mount === "/") || disks[0];
  const activeNetwork = network.interfaces.find(({ name }) => name === network.activeInterface) || network.interfaces[0];
  const visibleDisks = disks
    .filter(({ mount }) => mount === "/" || mount.endsWith("/Data") || mount.includes("/VM") || mount.includes("/Preboot"))
    .slice(0, 4);

  return (
    <div className="systemOverview">
      <div className="monitorGrid">
        <section className="monitorSection cpuMonitor" aria-label="CPU 状态">
          <header className="monitorHeader">
            <div><Cpu size={15} /><span>CPU</span></div>
            <strong>{metrics.cpuPercent.toFixed(1)}%</strong>
          </header>
          <div className="coreUsageGrid">
            {metrics.cpuCores.map((core) => (
              <div className="coreUsage" key={core.id} title={`核心 ${core.id}：${core.percent.toFixed(1)}%`}>
                <span>C{core.id}</span>
                <i><b style={{ width: `${core.percent}%` }} /></i>
                <em>{core.percent.toFixed(0)}%</em>
              </div>
            ))}
          </div>
          <footer className="monitorMeta">
            <span>负载 {metrics.loadAverage.map((value) => value.toFixed(2)).join(" / ")}</span>
            <span>运行 {formatUptime(metrics.uptimeSeconds)}</span>
            <span title={metrics.temperatureC === null ? "当前系统未提供非特权温度读数" : "CPU 温度"}>温度 {metrics.temperatureC === null ? "--" : `${metrics.temperatureC.toFixed(0)}°C`}</span>
          </footer>
        </section>

        <section className={`monitorSection memoryMonitor pressure-${metrics.memoryPressure}`} aria-label="内存状态">
          <header className="monitorHeader">
            <div><MemoryStick size={15} /><span>内存</span></div>
            <strong>{metrics.memoryPercent.toFixed(1)}%</strong>
          </header>
          <div className="memoryUsageBar" title={`已用 ${formatMemory(metrics.memoryUsedMb)}，可用 ${formatMemory(metrics.memoryAvailableMb)}`}>
            <i style={{ width: `${metrics.memoryPercent}%` }} />
          </div>
          <div className="memoryBreakdown">
            <span><small>已用</small><strong>{formatMemory(metrics.memoryUsedMb)}</strong></span>
            <span><small>可用</small><strong>{formatMemory(metrics.memoryAvailableMb)}</strong></span>
            <span><small>缓存</small><strong>{formatMemory(metrics.memoryCachedMb)}</strong></span>
            <span><small>联动</small><strong>{formatMemory(metrics.memoryWiredMb)}</strong></span>
            <span><small>压缩</small><strong>{formatMemory(metrics.memoryCompressedMb)}</strong></span>
            <span><small>Swap</small><strong>{formatMemory(metrics.swapUsedMb)} / {formatMemory(metrics.swapTotalMb)}</strong></span>
          </div>
        </section>

        <section className="monitorSection diskMonitor" aria-label="磁盘状态">
          <header className="monitorHeader">
            <div><HardDrive size={15} /><span>磁盘</span></div>
            <strong>{primaryDisk ? `${primaryDisk.usedPercent}%` : "--"}</strong>
          </header>
          <div className="diskHeadline">
            <span>{primaryDisk ? `${formatMetricBytes(primaryDisk.usedBytes)} / ${formatMetricBytes(primaryDisk.totalBytes)}` : "等待磁盘采样"}</span>
            <span>I/O {formatMetricBytes(data.diskIoBytesPerSecond, { rate: true })}</span>
          </div>
          <div className="compactMetricList">
            {visibleDisks.map((disk) => (
              <div key={`${disk.filesystem}:${disk.mount}`} title={disk.mount}>
                <span>{disk.mount === "/" ? "root" : disk.mount.split("/").filter(Boolean).at(-1)}</span>
                <i><b style={{ width: `${disk.usedPercent}%` }} /></i>
                <em>{disk.usedPercent}%</em>
              </div>
            ))}
          </div>
        </section>

        <section className="monitorSection networkMonitor" aria-label="网络状态">
          <header className="monitorHeader">
            <div><Cable size={15} /><span>网络</span><small>{activeNetwork?.name || "--"}</small></div>
            <strong>{activeNetwork ? formatMetricBytes(activeNetwork.downloadBytesPerSecond, { rate: true }) : "--"}</strong>
          </header>
          <div className="networkRates">
            <span><ArrowDown size={14} /><small>下载</small><strong>{activeNetwork ? formatMetricBytes(activeNetwork.downloadBytesPerSecond, { rate: true }) : "0 B/s"}</strong></span>
            <span><ArrowUp size={14} /><small>上传</small><strong>{activeNetwork ? formatMetricBytes(activeNetwork.uploadBytesPerSecond, { rate: true }) : "0 B/s"}</strong></span>
          </div>
          <footer className="monitorMeta">
            <span>累计下载 {formatMetricBytes(activeNetwork?.receivedBytes || 0)}</span>
            <span>累计上传 {formatMetricBytes(activeNetwork?.sentBytes || 0)}</span>
          </footer>
        </section>
      </div>
      <ResourceTrendChart history={history} />
    </div>
  );
}

const ALERT_SEVERITY_LABEL = { warning: "告警", critical: "严重" };

function HistorySparkline({ samples, metric, label, unit = "%" }) {
  const values = samples.map((sample) => Number(sample[metric])).filter((value) => Number.isFinite(value));
  if (values.length < 2) return null;
  const width = 132;
  const height = 30;
  const min = Math.min(...values);
  const max = Math.max(...values);
  const span = max - min || 1;
  const step = width / (values.length - 1);
  const points = values
    .map((value, index) => `${(index * step).toFixed(1)},${(height - ((value - min) / span) * (height - 4) - 2).toFixed(1)}`)
    .join(" ");

  return (
    <div className="historySpark" title={`${label}：最低 ${min.toFixed(1)}${unit}，最高 ${max.toFixed(1)}${unit}`}>
      <svg viewBox={`0 0 ${width} ${height}`} preserveAspectRatio="none" aria-hidden="true">
        <polyline points={points} />
      </svg>
    </div>
  );
}

function MonitoringPanel() {
  const [status, setStatus] = useState(null);
  const [summary, setSummary] = useState(null);
  const [samples, setSamples] = useState([]);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  async function refresh() {
    try {
      const [nextStatus, nextSummary, nextSamples] = await Promise.all([
        api.get("/api/monitor/status"),
        api.get("/api/monitor/summary?limit=240"),
        api.get("/api/monitor/history?limit=120")
      ]);
      setStatus(nextStatus);
      setSummary(nextSummary);
      setSamples(nextSamples);
    } catch (err) {
      setError(err.message);
    }
  }

  useEffect(() => {
    refresh();
    const interval = window.setInterval(refresh, 30_000);
    return () => window.clearInterval(interval);
  }, []);

  async function sendTestNotification() {
    setBusy(true);
    setError("");
    setMessage("");
    try {
      const result = await api.post("/api/notifications/test", { label: "通知链路测试", value: 91, threshold: 85, metric: "cpuPercent" });
      setMessage(result.delivered ? "已发送测试通知，请查看通知中心。" : `发送失败：${result.reason || "未知原因"}`);
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  async function sampleNow() {
    setBusy(true);
    setError("");
    try {
      const result = await api.post("/api/monitor/sample", {});
      setMessage(result.active?.length ? `采样完成，当前 ${result.active.length} 条告警生效中。` : "采样完成，当前没有告警。");
      await refresh();
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  const active = status?.activeAlerts || [];
  const rules = status?.rules || [];
  const metrics = summary?.metrics || {};
  const statRows = [
    ["CPU", "cpuPercent", "%"],
    ["内存", "memoryPercent", "%"],
    ["Swap", "swapUsedPercent", "%"],
    ["磁盘", "diskUsedPercent", "%"]
  ];

  return (
    <section className="monitoringPanel" aria-label="告警与历史趋势">
      <div className="monitoringHeader">
        <div className="monitoringTitle">
          <Bell size={15} />
          <strong>告警与历史趋势</strong>
          <span className={`monitoringState ${active.length ? "alerting" : "calm"}`}>
            {active.length ? `${active.length} 条告警生效中` : "一切正常"}
          </span>
        </div>
        <div className="monitoringActions">
          <span className="monitoringSamples">
            {summary?.samples ? `${summary.samples} 个采样 · ${new Intl.DateTimeFormat("zh-CN", { hour: "2-digit", minute: "2-digit" }).format(new Date(summary.from))} 起` : "等待历史采样"}
          </span>
          <button className="secondaryButton" type="button" onClick={sampleNow} disabled={busy} title="立即采集一次">
            <Activity size={14} />
            <span>立即采样</span>
          </button>
          <button className="secondaryButton" type="button" onClick={sendTestNotification} disabled={busy} title="发送一条测试通知">
            <Bell size={14} />
            <span>测试通知</span>
          </button>
        </div>
      </div>

      {error && <div className="error monitoringFeedback" role="alert">{error}</div>}
      {message && <div className="notice monitoringFeedback" role="status">{message}</div>}

      <div className="monitoringBody">
        <div className="monitoringAlerts">
          {active.length > 0 ? active.map((alert) => (
            <div className={`monitoringAlert ${alert.severity}`} key={alert.ruleId}>
              <span className="monitoringAlertBadge">{ALERT_SEVERITY_LABEL[alert.severity] || "告警"}</span>
              <strong>{alert.label}</strong>
              <span>当前 {alert.value}{alert.metric === "temperatureC" ? "°C" : "%"} · 阈值 {alert.threshold}</span>
              <p>{alert.advice}</p>
            </div>
          )) : (
            <div className="monitoringCalm">
              <Check size={15} />
              <div>
                <strong>没有触发阈值</strong>
                <span>后台每 30 秒采样一次，命中阈值会通过 macOS 通知中心提醒你。</span>
              </div>
            </div>
          )}
        </div>

        <div className="monitoringStats">
          {statRows.map(([label, key, unit]) => {
            const stat = metrics[key];
            return (
              <div className="monitoringStat" key={key}>
                <div>
                  <span>{label}</span>
                  <strong>{stat ? `${stat.last}${unit}` : "--"}</strong>
                </div>
                <HistorySparkline samples={samples} metric={key} label={label} unit={unit} />
                <small>{stat ? `最低 ${stat.min} · 平均 ${stat.avg} · 最高 ${stat.max}` : "等待历史采样"}</small>
              </div>
            );
          })}
        </div>
      </div>

      <details className="monitoringRules">
        <summary>阈值规则（{rules.length}）</summary>
        <div className="monitoringRuleList">
          {rules.map((rule) => (
            <span key={rule.id}>
              {rule.label}：{rule.comparator === "gte" ? "≥" : "≤"} {rule.threshold}
              {rule.metric === "temperatureC" ? "°C" : "%"}，连续 {rule.consecutive} 次
            </span>
          ))}
        </div>
      </details>
    </section>
  );
}

function ProcessesManager() {
  const snapshotRef = useRef(undefined);
  if (snapshotRef.current === undefined) {
    removeMenuSnapshot("processes");
    snapshotRef.current = readMenuSnapshot("process-overview");
  }
  const initialHistory = snapshotRef.current?.history || [];
  const historyRef = useRef(initialHistory);
  const initialOverview = snapshotRef.current?.data || {};
  const [data, setData] = useState(() => ({
    ...EMPTY_PROCESS_DATA,
    ...initialOverview,
    processes: [],
    metrics: { ...EMPTY_PROCESS_DATA.metrics, ...(initialOverview.metrics || {}) },
    network: { ...EMPTY_PROCESS_DATA.network, ...(initialOverview.network || {}) }
  }));
  const [history, setHistory] = useState(initialHistory);
  const [query, setQuery] = useState("");
  const [sort, setSort] = useState({ key: "memoryMb", direction: "desc" });
  const [viewMode, setViewMode] = useState("list");
  const [loading, setLoading] = useState(true);
  const [busyPid, setBusyPid] = useState("");
  const [selectedPids, setSelectedPids] = useState(() => new Set());
  const [batchBusy, setBatchBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const [scrollTop, setScrollTop] = useState(0);
  const [viewportHeight, setViewportHeight] = useState(480);
  const processViewportRef = useRef(null);
  const processRequestRef = useRef(false);
  const metricsRequestRef = useRef(false);

  const visibleProcesses = useMemo(() => {
    return buildProcessRows(data.processes, query, sort, viewMode);
  }, [data.processes, query, sort, viewMode]);

  const overscan = 8;
  const startIndex = Math.max(0, Math.floor(Math.max(0, scrollTop - 32) / PROCESS_ROW_HEIGHT) - overscan);
  const visibleCount = Math.ceil(viewportHeight / PROCESS_ROW_HEIGHT) + overscan * 2;
  const renderedProcesses = visibleProcesses.slice(startIndex, startIndex + visibleCount);
  const selectableVisiblePids = useMemo(
    () => visibleProcesses.filter((processInfo) => processInfo.canTerminate !== false).map((processInfo) => processInfo.pid),
    [visibleProcesses]
  );
  const selectedVisibleCount = selectableVisiblePids.filter((pid) => selectedPids.has(pid)).length;
  const allVisibleSelected = selectableVisiblePids.length > 0 && selectedVisibleCount === selectableVisiblePids.length;
  const someVisibleSelected = selectedVisibleCount > 0 && !allVisibleSelected;
  const selectAllRef = useRef(null);

  function rememberOverview(next, nextHistory) {
    writeMenuSnapshot("process-overview", {
      data: {
        metrics: next.metrics,
        disks: next.disks,
        diskIoBytesPerSecond: next.diskIoBytesPerSecond,
        network: next.network
      },
      history: nextHistory
    });
  }

  function appendHistory(next) {
    const nextHistory = [...historyRef.current, {
      cpu: next.metrics.cpuPercent,
      memory: next.metrics.memoryPercent,
      timestamp: next.metrics.generatedAt
    }].slice(-60);
    historyRef.current = nextHistory;
    setHistory(nextHistory);
    rememberOverview(next, nextHistory);
  }

  async function refreshProcesses({ silent = false } = {}) {
    if (processRequestRef.current) return;
    processRequestRef.current = true;
    if (!silent) {
      setLoading(true);
      setError("");
    }
    try {
      const next = await api.get("/api/processes");
      setData(next);
      appendHistory(next);
    } catch (err) {
      setError(err.message);
    } finally {
      processRequestRef.current = false;
      if (!silent) setLoading(false);
    }
  }

  async function refreshMetrics() {
    if (metricsRequestRef.current || processRequestRef.current) return;
    metricsRequestRef.current = true;
    try {
      const next = await api.get("/api/processes/metrics");
      setData((current) => ({ ...current, ...next, processes: current.processes }));
      appendHistory(next);
    } catch (err) {
      setError(err.message);
    } finally {
      metricsRequestRef.current = false;
    }
  }

  useEffect(() => {
    refreshProcesses();
    const metricsInterval = window.setInterval(refreshMetrics, 1000);
    const processInterval = window.setInterval(() => refreshProcesses({ silent: true }), 5000);
    return () => {
      window.clearInterval(metricsInterval);
      window.clearInterval(processInterval);
    };
  }, []);

  useEffect(() => {
    const viewport = processViewportRef.current;
    if (!viewport || typeof ResizeObserver === "undefined") return undefined;
    const observer = new ResizeObserver(([entry]) => setViewportHeight(entry.contentRect.height));
    observer.observe(viewport);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    if (processViewportRef.current) processViewportRef.current.scrollTop = 0;
    setScrollTop(0);
  }, [query, sort, viewMode]);

  useEffect(() => {
    const available = new Set(data.processes.map((processInfo) => processInfo.pid));
    setSelectedPids((current) => {
      const next = new Set([...current].filter((pid) => available.has(pid)));
      return next.size === current.size ? current : next;
    });
  }, [data.processes]);

  useEffect(() => {
    if (selectAllRef.current) selectAllRef.current.indeterminate = someVisibleSelected;
  }, [someVisibleSelected]);

  function handleSort(sortKey) {
    setSort((current) => current.key === sortKey
      ? { key: sortKey, direction: current.direction === "asc" ? "desc" : "asc" }
      : { key: sortKey, direction: ["processName", "applicationName", "user"].includes(sortKey) ? "asc" : "desc" });
  }

  function toggleProcessSelection(pid) {
    setSelectedPids((current) => {
      const next = new Set(current);
      if (next.has(pid)) next.delete(pid);
      else next.add(pid);
      return next;
    });
  }

  function toggleVisibleSelection() {
    setSelectedPids((current) => {
      const next = new Set(current);
      if (allVisibleSelected) selectableVisiblePids.forEach((pid) => next.delete(pid));
      else selectableVisiblePids.forEach((pid) => next.add(pid));
      return next;
    });
  }

  async function terminate(processInfo) {
    if (!window.confirm(`确认强行终止「${processInfo.processName}」(PID ${processInfo.pid})？未保存的数据可能丢失。`)) return;
    setBusyPid(String(processInfo.pid));
    setError("");
    setMessage("");
    try {
      await api.post(`/api/processes/${processInfo.pid}/terminate`, {});
      setSelectedPids((current) => {
        const next = new Set(current);
        next.delete(processInfo.pid);
        return next;
      });
      setMessage(`已强行终止 ${processInfo.processName}（PID ${processInfo.pid}）`);
      await refreshProcesses({ silent: true });
    } catch (err) {
      setError(err.message);
    } finally {
      setBusyPid("");
    }
  }

  async function terminateSelected() {
    const pids = [...selectedPids];
    if (!pids.length || batchBusy) return;
    const processByPid = new Map(data.processes.map((processInfo) => [processInfo.pid, processInfo]));
    const names = pids
      .map((pid) => processByPid.get(pid)?.processName || `PID ${pid}`)
      .slice(0, 4);
    const suffix = pids.length > names.length ? ` 等 ${pids.length} 个进程` : "";
    if (!window.confirm(`确认强行终止 ${names.join("、")}${suffix}？未保存的数据可能丢失。`)) return;
    setBatchBusy(true);
    setError("");
    setMessage("");
    try {
      const result = await api.post("/api/processes/terminate", { pids });
      const terminated = result.terminated || [];
      setSelectedPids((current) => new Set([...current].filter((pid) => !terminated.includes(pid))));
      const failedCount = (result.failed?.length || 0) + (result.skipped?.length || 0);
      setMessage(`已强行终止 ${terminated.length} 个进程${failedCount ? `，${failedCount} 个未完成` : ""}`);
      await refreshProcesses({ silent: true });
    } catch (err) {
      setError(err.message);
    } finally {
      setBatchBusy(false);
    }
  }

  const metrics = data.metrics;
  return (
    <section className="processesPanel">
      <div className="processesToolbar">
        <label className="searchBox processSearch">
          <Search size={17} />
          <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="搜索进程名、应用或 PID" autoFocus />
          {query && <button type="button" onClick={() => setQuery("")} aria-label="清空搜索" title="清空搜索"><X size={15} /></button>}
        </label>
        <span className="processUpdatedAt">{metrics.generatedAt ? `更新于 ${new Intl.DateTimeFormat("zh-CN", { hour: "2-digit", minute: "2-digit", second: "2-digit" }).format(new Date(metrics.generatedAt))}` : "等待采样"}</span>
        <button className="iconButton" onClick={() => refreshProcesses()} disabled={loading} aria-label="刷新进程" title="刷新进程"><RefreshCw size={17} className={loading ? "spin" : ""} /></button>
      </div>

      {error && <div className="error processFeedback" role="alert">{error}</div>}
      {message && <div className="notice processFeedback" role="status">{message}</div>}

      <SystemMonitorOverview data={data} history={history} />

      <MonitoringPanel />

      <div className="processTableSummary">
        <span>进程</span><strong>{visibleProcesses.length}</strong><span>项</span>
        <span className="processThreadSummary">{metrics.threadCount.toLocaleString("zh-CN")} 个线程 · 采样 {metrics.sampleDurationMs.toFixed(0)} ms</span>
        <div className="processBatchActions">
          <span className="processSelectionCount">{selectedPids.size ? `已选 ${selectedPids.size} 项` : "可多选进程"}</span>
          <button type="button" className="dangerButton processBatchButton" onClick={terminateSelected} disabled={!selectedPids.size || batchBusy} title="批量发送 SIGKILL">
            <PowerOff size={14} />
            <span>{batchBusy ? "终止中" : "批量终止"}</span>
          </button>
        </div>
        <div className="processViewModes" role="group" aria-label="进程显示模式">
          <button type="button" className={viewMode === "list" ? "active" : ""} onClick={() => setViewMode("list")} aria-pressed={viewMode === "list"} title="列表模式"><LayoutList size={14} /><span>列表</span></button>
          <button type="button" className={viewMode === "tree" ? "active" : ""} onClick={() => setViewMode("tree")} aria-pressed={viewMode === "tree"} title="树状模式"><GitBranch size={14} /><span>树状</span></button>
        </div>
      </div>
      <div className="processTableViewport" ref={processViewportRef} onScroll={(event) => setScrollTop(event.currentTarget.scrollTop)} aria-busy={loading}>
        <div className="processTableHeader">
          <label className="processSelectionHeader" title="选择当前筛选结果中的全部进程">
            <input
              ref={selectAllRef}
              className="processCheckbox"
              type="checkbox"
              checked={allVisibleSelected}
              onChange={toggleVisibleSelection}
              disabled={!selectableVisiblePids.length || batchBusy}
              aria-label="选择当前筛选结果中的全部进程"
            />
          </label>
          <ProcessSortHeader label="进程名" sortKey="processName" sort={sort} onSort={handleSort} />
          <ProcessSortHeader label="应用" sortKey="applicationName" sort={sort} onSort={handleSort} />
          <ProcessSortHeader label="用户 / 线程" sortKey="user" sort={sort} onSort={handleSort} />
          <ProcessSortHeader label="PID" sortKey="pid" sort={sort} onSort={handleSort} />
          <ProcessSortHeader label="内存" sortKey="memoryMb" sort={sort} onSort={handleSort} />
          <ProcessSortHeader label="CPU" sortKey="cpu" sort={sort} onSort={handleSort} />
          <ProcessSortHeader label="运行时长" sortKey="elapsedSeconds" sort={sort} onSort={handleSort} />
          <span className="processActionHeader">操作</span>
        </div>
        <div className="processVirtualSpace" style={{ height: `${visibleProcesses.length * PROCESS_ROW_HEIGHT}px` }}>
          <div className="processVirtualRows" style={{ transform: `translateY(${startIndex * PROCESS_ROW_HEIGHT}px)` }}>
            {renderedProcesses.map((processInfo) => (
              <article className={`processRow ${selectedPids.has(processInfo.pid) ? "selected" : ""}`} key={processInfo.pid}>
                <label className="processSelection" title={`选择 ${processInfo.processName}（PID ${processInfo.pid}）`}>
                  <input
                    className="processCheckbox"
                    type="checkbox"
                    checked={selectedPids.has(processInfo.pid)}
                    onChange={() => toggleProcessSelection(processInfo.pid)}
                    disabled={processInfo.canTerminate === false || batchBusy}
                    aria-label={`选择 ${processInfo.processName}（PID ${processInfo.pid}）`}
                  />
                </label>
                <div className="processIdentity" title={processInfo.command} style={{ paddingLeft: `${Math.min(8, processInfo.depth || 0) * 13}px` }}>
                  <strong>{viewMode === "tree" && processInfo.depth > 0 && <GitBranch size={11} />}{processInfo.processName}</strong>
                  <span>{processInfo.command}</span>
                </div>
                <div className="processApplication" title={processInfo.applicationPath || "系统进程"}>
                  <span className={`processAppDot ${processInfo.applicationName === "系统进程" ? "system" : ""}`} />
                  <span>{processInfo.applicationName}</span>
                </div>
                <span className="processUser"><strong>{processInfo.user}</strong><small>{processInfo.threads} 线程 · {processInfo.state}</small></span>
                <span className="processPid">{processInfo.pid}</span>
                <span className="processMetric memoryMetric"><strong>{formatMemory(processInfo.memoryMb)}</strong><small>{processInfo.memoryPercent.toFixed(1)}%</small></span>
                <span className="processMetric cpuMetric"><strong>{processInfo.cpu.toFixed(1)}%</strong></span>
                <span className="processElapsed">{processInfo.elapsed}</span>
                <button className="secondaryButton terminateButton" onClick={() => terminate(processInfo)} disabled={busyPid === String(processInfo.pid) || batchBusy || processInfo.canTerminate === false} title="发送 SIGKILL 强行终止">
                  <Square size={14} />
                  <span>{busyPid === String(processInfo.pid) ? "终止中" : "强行终止"}</span>
                </button>
              </article>
            ))}
          </div>
          {!loading && !visibleProcesses.length && <div className="processesEmpty"><Cpu size={28} /><strong>{query ? "没有匹配的进程" : "当前没有可显示的进程"}</strong></div>}
          {loading && !data.processes.length && <div className="processesEmpty">正在读取本机进程...</div>}
        </div>
      </div>
    </section>
  );
}

const EMPTY_LOGIN_ITEMS = {
  access: { available: true, requiresAutomation: false, detail: "" },
  items: [],
  candidates: [],
  summary: { total: 0, hidden: 0, unavailable: 0 }
};

function LoginItemsManager() {
  const snapshotRef = useRef(undefined);
  if (snapshotRef.current === undefined) snapshotRef.current = readMenuSnapshot("login-items");
  const [data, setData] = useState(() => snapshotRef.current || EMPTY_LOGIN_ITEMS);
  const [query, setQuery] = useState("");
  const [loading, setLoading] = useState(() => !snapshotRef.current);
  const [busyId, setBusyId] = useState("");
  const [showPicker, setShowPicker] = useState(false);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");

  const visibleItems = useMemo(() => {
    const normalizedQuery = query.trim().toLowerCase();
    if (!normalizedQuery) return data.items;
    return data.items.filter((item) => [item.name, item.path, item.application?.bundleId]
      .filter(Boolean).join(" ").toLowerCase().includes(normalizedQuery));
  }, [data.items, query]);

  async function refresh({ fresh = false, silent = false } = {}) {
    if (!silent) setLoading(true);
    setError("");
    try {
      const next = await api.get(`/api/login-items${fresh ? "?fresh=1" : ""}`);
      setData(next);
      writeMenuSnapshot("login-items", next);
    } catch (err) {
      setError(err.message);
    } finally {
      if (!silent) setLoading(false);
    }
  }

  useEffect(() => {
    if (!snapshotRef.current) refresh();
  }, []);

  async function openSettings(kind = "settings") {
    setError("");
    try {
      await api.post(`/api/login-items/${kind}/open`, {});
    } catch (err) {
      setError(err.message);
    }
  }

  async function removeItem(item) {
    if (!window.confirm(`确认从开机启动中移除「${item.name}」？应用本身不会被卸载。`)) return;
    setBusyId(item.id);
    setError("");
    setMessage("");
    try {
      await api.delete(`/api/login-items/${item.id}`);
      setMessage(`已从开机启动中移除「${item.name}」`);
      await refresh({ fresh: true });
    } catch (err) {
      setError(err.message);
    } finally {
      setBusyId("");
    }
  }

  return (
    <section className="systemManagerPanel loginItemsPanel">
      <div className="systemManagerToolbar">
        <label className="searchBox systemManagerSearch">
          <Search size={16} />
          <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="搜索登录项或路径" autoFocus />
          {query && <button type="button" onClick={() => setQuery("")} aria-label="清空搜索" title="清空搜索"><X size={14} /></button>}
        </label>
        <button className="secondaryButton" onClick={() => openSettings("settings")} title="在系统设置中查看登录项与后台项目">
          <ExternalLink size={15} /><span>系统设置</span>
        </button>
        <button className="iconButton addButton" onClick={() => setShowPicker(true)} disabled={!data.access.available} aria-label="添加开机启动应用" title="添加应用">
          <Plus size={17} />
        </button>
        <button className="iconButton" onClick={() => refresh({ fresh: true })} disabled={loading} aria-label="刷新开机启动" title="刷新">
          <RefreshCw size={17} className={loading ? "spin" : ""} />
        </button>
      </div>

      {!data.access.available && (
        <div className="systemAccessBanner warning">
          <CircleAlert size={17} />
          <div><strong>无法读取登录项</strong><span>{data.access.detail}</span></div>
          <button className="secondaryButton" onClick={() => openSettings("automation")}><ExternalLink size={14} /><span>自动化设置</span></button>
        </div>
      )}
      {error && <div className="error systemFeedback" role="alert">{error}</div>}
      {message && <div className="notice systemFeedback" role="status">{message}</div>}

      <div className="systemSummaryBand" aria-label="开机启动概览">
        <span><strong>{data.summary.total}</strong> 个登录项</span>
        <span><strong>{data.candidates.length}</strong> 个可添加应用</span>
        {data.summary.unavailable > 0 && <span className="summaryWarning"><strong>{data.summary.unavailable}</strong> 个路径不可用</span>}
      </div>

      <div className="loginItemList" aria-busy={loading}>
        {visibleItems.map((item) => (
          <article className="loginItemRow" key={item.id}>
            <ApplicationIcon application={item.application || item} />
            <div className="applicationIdentity">
              <div className="applicationNameLine">
                <strong>{item.name}</strong>
                <span className="appStatus running">已启用</span>
                {item.hidden && <span className="systemLabel">启动后隐藏</span>}
                {item.missing && <span className="permissionStatus denied">路径不可用</span>}
              </div>
              <span className="applicationVersion">{item.application?.bundleId || "登录项"}</span>
              <span className="applicationPath" title={item.path}>{item.path || "系统未返回路径"}</span>
            </div>
            <button className="iconButton loginItemRemove" onClick={() => removeItem(item)} disabled={busyId === item.id || !data.access.available} aria-label={`移除${item.name}`} title="从开机启动中移除">
              <Trash2 size={16} />
            </button>
          </article>
        ))}
        {!loading && data.access.available && !visibleItems.length && (
          <div className="applicationsEmpty"><Power size={28} /><strong>{query ? "没有匹配的登录项" : "还没有开机启动应用"}</strong></div>
        )}
        {loading && !data.items.length && <div className="applicationsEmpty">正在读取登录项...</div>}
      </div>

      {showPicker && (
        <LoginItemPicker
          applications={data.candidates}
          onAdded={async (application) => {
            setShowPicker(false);
            setMessage(`已将「${application.name}」加入开机启动`);
            await refresh({ fresh: true });
          }}
          onClose={() => setShowPicker(false)}
        />
      )}
    </section>
  );
}

function LoginItemPicker({ applications, onAdded, onClose }) {
  const [query, setQuery] = useState("");
  const [selectedId, setSelectedId] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const visibleApplications = useMemo(() => {
    const normalizedQuery = query.trim().toLowerCase();
    return applications.filter((application) => !normalizedQuery || [application.name, application.bundleId, application.path]
      .filter(Boolean).join(" ").toLowerCase().includes(normalizedQuery));
  }, [applications, query]);

  useEffect(() => {
    function handleKeyDown(event) {
      if (event.key === "Escape" && !saving) onClose();
    }
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [onClose, saving]);

  async function addSelected() {
    const application = applications.find(({ id }) => id === selectedId);
    if (!application) return;
    setSaving(true);
    setError("");
    try {
      await api.post("/api/login-items", { applicationId: application.id });
      await onAdded(application);
    } catch (err) {
      setError(err.message);
      setSaving(false);
    }
  }

  return (
    <div className="modalBackdrop" onMouseDown={(event) => event.target === event.currentTarget && !saving && onClose()}>
      <section className="applicationPicker loginItemPicker" role="dialog" aria-modal="true" aria-labelledby="login-item-picker-title">
        <header className="pickerHeader">
          <div><span className="modalTitleIcon"><Power size={16} /></span><span><h2 id="login-item-picker-title">添加开机启动应用</h2><p>选择一个本机应用</p></span></div>
          <button className="modalClose" type="button" onClick={onClose} disabled={saving} aria-label="关闭" title="关闭"><X size={18} /></button>
        </header>
        <label className="searchBox pickerSearch"><Search size={16} /><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="搜索本机应用" autoFocus /></label>
        <div className="pickerList">
          {visibleApplications.map((application) => (
            <button type="button" className={`pickerApplicationRow ${selectedId === application.id ? "selected" : ""}`} key={application.id} onClick={() => setSelectedId(application.id)}>
              <ApplicationIcon application={application} />
              <span><strong>{application.name}</strong><small>{application.bundleId || application.path}</small></span>
              {application.system && <em>系统</em>}
              <i>{selectedId === application.id && <Check size={15} />}</i>
            </button>
          ))}
          {!visibleApplications.length && <div className="pickerEmpty">没有匹配的应用</div>}
        </div>
        {error && <div className="error pickerError" role="alert">{error}</div>}
        <footer className="modalFooter pickerFooter">
          <span>{applications.length} 个可添加应用</span>
          <div><button className="secondaryButton" type="button" onClick={onClose} disabled={saving}>取消</button><button className="primaryButton" type="button" onClick={addSelected} disabled={saving || !selectedId}>{saving ? "正在添加..." : "添加"}</button></div>
        </footer>
      </section>
    </div>
  );
}

const EMPTY_PERMISSION_DATA = {
  access: { available: true, requiresFullDiskAccess: false, detail: "" },
  categories: [],
  applications: [],
  summary: { applications: 0, total: 0, records: 0, granted: 0, denied: 0, limited: 0, unavailable: 0, notRequested: 0 }
};

const PERMISSION_STATUS = {
  granted: { label: "已允许", className: "granted" },
  denied: { label: "已拒绝", className: "denied" },
  limited: { label: "受限", className: "limited" },
  "not-requested": { label: "未请求", className: "notRequested" },
  unavailable: { label: "待读取", className: "unavailable" },
  unknown: { label: "未确认", className: "unknown" }
};

function ApplicationPermissionsManager() {
  const snapshotRef = useRef(undefined);
  if (snapshotRef.current === undefined) snapshotRef.current = readMenuSnapshot("permissions");
  const [data, setData] = useState(() => snapshotRef.current || EMPTY_PERMISSION_DATA);
  const [categoryId, setCategoryId] = useState("all");
  const [query, setQuery] = useState("");
  const [loading, setLoading] = useState(() => !snapshotRef.current);
  const [busyId, setBusyId] = useState("");
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");

  const selectedCategory = data.categories.find(({ id }) => id === categoryId);
  const visibleApplications = useMemo(() => {
    const normalizedQuery = query.trim().toLowerCase();
    return data.applications.map((application) => ({
      ...application,
      visiblePermissions: application.permissions.filter((permission) => categoryId === "all" || permission.categoryId === categoryId)
    })).filter((application) => {
      if (!application.visiblePermissions.length) return false;
      if (!normalizedQuery) return true;
      return [application.name, application.bundleId, application.path, ...application.visiblePermissions.map(({ label, targetName }) => `${label} ${targetName}`)]
        .filter(Boolean).join(" ").toLowerCase().includes(normalizedQuery);
    });
  }, [categoryId, data.applications, query]);

  async function refresh({ fresh = false, silent = false } = {}) {
    if (!silent) setLoading(true);
    setError("");
    try {
      const next = await api.get(`/api/application-permissions${fresh ? "?fresh=1" : ""}`);
      setData(next);
      writeMenuSnapshot("permissions", next);
    } catch (err) {
      setError(err.message);
    } finally {
      if (!silent) setLoading(false);
    }
  }

  useEffect(() => {
    if (!snapshotRef.current) refresh();
  }, []);

  async function openSettings(nextCategoryId) {
    setError("");
    try {
      await api.post("/api/application-permissions/settings/open", { categoryId: nextCategoryId });
    } catch (err) {
      setError(err.message);
    }
  }

  async function resetPermission(application, permission) {
    if (!window.confirm(`重置「${application.name}」的「${permission.label}」授权记录？应用下次使用相关功能时可能再次请求。`)) return;
    const key = `${application.id}:${permission.service}`;
    setBusyId(key);
    setError("");
    setMessage("");
    try {
      await api.post(`/api/application-permissions/${application.id}/${encodeURIComponent(permission.service)}/reset`, {});
      setMessage(`已重置「${application.name}」的「${permission.label}」授权记录`);
      await refresh({ fresh: true });
    } catch (err) {
      setError(err.message);
    } finally {
      setBusyId("");
    }
  }

  return (
    <section className="systemManagerPanel permissionsPanel">
      <div className="systemManagerToolbar permissionToolbar">
        <label className="searchBox systemManagerSearch">
          <Search size={16} />
          <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="搜索应用、标识或权限" autoFocus />
          {query && <button type="button" onClick={() => setQuery("")} aria-label="清空搜索" title="清空搜索"><X size={14} /></button>}
        </label>
        <button className="iconButton" onClick={() => refresh({ fresh: true })} disabled={loading} aria-label="刷新应用授权" title="刷新">
          <RefreshCw size={17} className={loading ? "spin" : ""} />
        </button>
      </div>

      {!data.access.available && (
        <div className="systemAccessBanner warning">
          <ShieldCheck size={17} />
          <div><strong>授权状态尚未读取</strong><span>{data.access.detail}</span></div>
          <button className="secondaryButton" onClick={() => openSettings("full-disk")}><ExternalLink size={14} /><span>完全磁盘访问</span></button>
        </div>
      )}
      {error && <div className="error systemFeedback" role="alert">{error}</div>}
      {message && <div className="notice systemFeedback" role="status">{message}</div>}

      <div className="systemSummaryBand permissionSummary" aria-label="应用授权概览">
        <span><strong>{data.summary.applications}</strong> 个相关应用</span>
        <span className="summarySuccess"><strong>{data.summary.granted}</strong> 项已允许</span>
        <span className="summaryWarning"><strong>{data.summary.denied}</strong> 项已拒绝</span>
        {data.summary.unavailable > 0
          ? <span><strong>{data.summary.unavailable}</strong> 项待读取</span>
          : <span><strong>{data.summary.notRequested}</strong> 项未请求</span>}
      </div>

      <div className="permissionWorkspace">
        <nav className="permissionCategories" aria-label="权限类别">
          <button className={categoryId === "all" ? "selected" : ""} onClick={() => setCategoryId("all")}>
            <span>所有授权</span><strong>{data.summary.total}</strong>
          </button>
          {data.categories.map((category) => (
            <button className={categoryId === category.id ? "selected" : ""} key={category.id} onClick={() => setCategoryId(category.id)}>
              <span>{category.label}</span><strong>{category.count}</strong>
            </button>
          ))}
        </nav>

        <div className="permissionContent">
          <div className="permissionContentHeader">
            <div><strong>{selectedCategory?.label || "所有授权"}</strong><span>{visibleApplications.length} 个应用</span></div>
            {selectedCategory && <button className="secondaryButton" onClick={() => openSettings(selectedCategory.id)}><ExternalLink size={14} /><span>系统设置</span></button>}
          </div>
          <div className="permissionApplicationList" aria-busy={loading}>
            {visibleApplications.map((application) => (
              <article className="permissionApplicationRow" key={application.id}>
                <div className="permissionApplicationIdentity">
                  <ApplicationIcon application={application} />
                  <span><strong>{application.name}</strong><small title={application.bundleId}>{application.bundleId || application.path}</small></span>
                </div>
                <div className="permissionEntries">
                  {application.visiblePermissions.map((permission) => {
                    const status = PERMISSION_STATUS[permission.status] || PERMISSION_STATUS.unknown;
                    const key = `${permission.service}:${permission.targetBundleId || "self"}`;
                    return (
                      <div className="permissionEntry" key={key}>
                        <span className="permissionName"><strong>{permission.label}</strong>{permission.targetName && <small>控制 {permission.targetName}</small>}</span>
                        <span className={`permissionStatus ${status.className}`}>{status.label}</span>
                        <span className="permissionEntryActions">
                          <button className="iconButton" onClick={() => openSettings(permission.categoryId)} aria-label={`打开${permission.label}设置`} title="在系统设置中管理"><ExternalLink size={14} /></button>
                          {permission.resettable && data.access.available && (
                            <button className="iconButton permissionReset" onClick={() => resetPermission(application, permission)} disabled={busyId === `${application.id}:${permission.service}`} aria-label={`重置${application.name}的${permission.label}`} title="重置授权记录"><RotateCcw size={14} /></button>
                          )}
                        </span>
                      </div>
                    );
                  })}
                </div>
              </article>
            ))}
            {!loading && !visibleApplications.length && <div className="applicationsEmpty"><ShieldCheck size={28} /><strong>{query ? "没有匹配的授权记录" : "此类别暂无应用记录"}</strong></div>}
            {loading && !data.applications.length && <div className="applicationsEmpty">正在读取应用授权...</div>}
          </div>
        </div>
      </div>
    </section>
  );
}

const EMPTY_STORAGE = {
  volume: { name: "Macintosh HD", total: 0, used: 0, available: 0, usedPercent: 0 },
  categories: [],
  scanCoverage: 0,
  limitedAccess: false,
  measuredAt: "",
  note: ""
};

const EMPTY_ANALYSIS = { files: [], directories: [], scannedAt: "", threshold: 0, truncated: false };
const STORAGE_SNAPSHOT_VERSION = 2;
const STORAGE_SNAPSHOT_KEY = `device-operate:storage-snapshot:v${STORAGE_SNAPSHOT_VERSION}`;
const STORAGE_REFRESH_POLL_MS = 750;

function waitForStorageRefreshPoll() {
  return new Promise((resolve) => window.setTimeout(resolve, STORAGE_REFRESH_POLL_MS));
}

function readStorageSnapshot() {
  if (typeof window === "undefined") return null;
  try {
    const parsed = JSON.parse(window.localStorage.getItem(STORAGE_SNAPSHOT_KEY) || "null");
    if (!parsed || parsed.version !== STORAGE_SNAPSHOT_VERSION || !parsed.storage || !Array.isArray(parsed.cleanup)) return null;
    return parsed;
  } catch {
    return null;
  }
}

function writeStorageSnapshot(snapshot) {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(STORAGE_SNAPSHOT_KEY, JSON.stringify({ version: STORAGE_SNAPSHOT_VERSION, savedAt: new Date().toISOString(), ...snapshot }));
  } catch {
    // A full or unavailable localStorage must not block storage management.
  }
}

function isCachedVirtualPath(targetPath) {
  return String(targetPath || "").includes("#project:");
}

function collectCleanupTreePaths(nodes, paths) {
  for (const node of nodes || []) {
    if (node.path && !node.virtual && !isCachedVirtualPath(node.path)) paths.add(node.path);
    collectCleanupTreePaths(node.children, paths);
  }
}

function collectStorageSnapshotPaths(snapshot) {
  const paths = new Set();
  for (const category of snapshot.storage?.categories || []) {
    for (const targetPath of category.locations || []) paths.add(targetPath);
  }
  for (const item of snapshot.cleanup || []) {
    for (const targetPath of item.cleanedPaths || []) paths.add(targetPath);
    for (const entry of item.selectionItems || []) paths.add(entry.path);
    collectCleanupTreePaths(item.tree, paths);
  }
  for (const item of snapshot.analysis?.files || []) paths.add(item.path);
  for (const item of snapshot.analysis?.directories || []) paths.add(item.path);
  return [...paths].filter((targetPath) => String(targetPath).startsWith("/"));
}

function cleanupNodeCount(node) {
  if (node.selectable) return 1;
  if (node.kind !== "directory") return 1;
  if (node.children?.length) return node.children.reduce((sum, child) => sum + cleanupNodeCount(child), 0);
  return Number(node.itemCount || 0);
}

function pruneCleanupTreeNode(node, existingPaths) {
  const originalChildren = Array.isArray(node.children) ? node.children : [];
  const children = originalChildren.map((child) => pruneCleanupTreeNode(child, existingPaths)).filter(Boolean);
  const virtual = node.virtual || isCachedVirtualPath(node.path);
  const exists = virtual ? children.length > 0 : existingPaths.has(node.path);
  if (!exists && !children.length) return null;
  return {
    ...node,
    children,
    size: children.length ? children.reduce((sum, child) => sum + Number(child.size || 0), 0) : exists ? node.size : 0,
    itemCount: node.selectable ? 1 : children.length ? children.reduce((sum, child) => sum + cleanupNodeCount(child), 0) : originalChildren.length ? 0 : Number(node.itemCount || 0)
  };
}

function pruneCleanupSnapshot(cleanup, existingPaths) {
  return cleanup.map((item) => {
    const selectionItems = (item.selectionItems || []).filter((entry) => existingPaths.has(entry.path));
    const tree = (item.tree || []).map((root) => pruneCleanupTreeNode(root, existingPaths)).filter(Boolean);
    const cleanedPaths = (item.cleanedPaths || []).filter((targetPath) => existingPaths.has(targetPath));
    const size = item.selectionMode
      ? selectionItems.reduce((sum, entry) => sum + Number(entry.size || 0), 0)
      : tree.reduce((sum, root) => sum + Number(root.size || 0), 0);
    const itemCount = item.selectionMode
      ? selectionItems.length
      : tree.reduce((sum, root) => sum + cleanupNodeCount(root), 0);
    return {
      ...item,
      selectionItems,
      recommendedPaths: (item.recommendedPaths || []).filter((targetPath) => existingPaths.has(targetPath)),
      cleanedPaths,
      tree,
      size,
      itemCount,
      sizeKnown: true,
      available: itemCount > 0
    };
  });
}

function pruneStorageSnapshot(storage, existingPaths) {
  return {
    ...storage,
    categories: (storage.categories || []).filter((category) => category.id === "system-other" || !category.locations?.length || category.locations.some((targetPath) => existingPaths.has(targetPath)))
  };
}

function pruneAnalysisSnapshot(analysis, existingPaths) {
  return {
    ...analysis,
    files: (analysis.files || []).filter((item) => existingPaths.has(item.path)),
    directories: (analysis.directories || []).filter((item) => existingPaths.has(item.path))
  };
}

function formatBytes(value) {
  const bytes = Number(value || 0);
  if (bytes <= 0) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"];
  const index = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  const amount = bytes / 1024 ** index;
  return `${amount >= 100 || index === 0 ? amount.toFixed(0) : amount >= 10 ? amount.toFixed(1) : amount.toFixed(2)} ${units[index]}`;
}

function formatStorageDate(value) {
  if (!value) return "-";
  const date = new Date(value);
  if (Number.isNaN(date.valueOf())) return "-";
  return new Intl.DateTimeFormat("zh-CN", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit"
  }).format(date);
}

function isStoragePathWithin(candidate, root) {
  if (!candidate || !root) return false;
  const normalizedCandidate = String(candidate).replaceAll("\\", "/");
  const normalizedRoot = String(root).replaceAll("\\", "/").replace(/\/$/, "");
  return normalizedCandidate === normalizedRoot || normalizedCandidate.startsWith(`${normalizedRoot}/`);
}

function StorageManager() {
  const [view, setView] = useState("overview");
  const snapshotRef = useRef(undefined);
  if (snapshotRef.current === undefined) snapshotRef.current = readStorageSnapshot();
  const initialSnapshot = snapshotRef.current;
  const [storage, setStorage] = useState(() => initialSnapshot?.storage || EMPTY_STORAGE);
  const [cleanup, setCleanup] = useState(() => initialSnapshot?.cleanup || []);
  const [analysis, setAnalysis] = useState(() => initialSnapshot?.analysis || EMPTY_ANALYSIS);
  const [baseLoading, setBaseLoading] = useState(() => !initialSnapshot);
  const [analysisLoading, setAnalysisLoading] = useState(false);
  const [analysisLoaded, setAnalysisLoaded] = useState(() => Boolean(initialSnapshot?.analysisLoaded || initialSnapshot?.analysis?.scannedAt));
  const [cacheChecking, setCacheChecking] = useState(false);
  const [busyCleanup, setBusyCleanup] = useState(new Set());
  const busyCleanupRef = useRef(new Set());
  const [busyPaths, setBusyPaths] = useState(new Set());
  const busyPathsRef = useRef(new Set());
  const [selectedPaths, setSelectedPaths] = useState(new Set());
  const [cleanupSelections, setCleanupSelections] = useState(() => Object.fromEntries(
    (initialSnapshot?.cleanup || [])
      .filter((item) => item.selectionMode)
      .map((item) => [item.id, new Set(item.recommendedPaths || [])])
  ));
  const [batchBusy, setBatchBusy] = useState(false);
  const [expandedCleanup, setExpandedCleanup] = useState(() => new Set(
    (initialSnapshot?.cleanup || []).filter((item) => item.selectionMode && item.available).map((item) => item.id)
  ));
  const [query, setQuery] = useState("");
  const [sortBy, setSortBy] = useState("size");
  const [preview, setPreview] = useState(null);
  const [previewLoading, setPreviewLoading] = useState(false);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const baseRequestRef = useRef(0);
  const analysisRequestRef = useRef(0);
  const cacheRequestRef = useRef(0);

  async function validateCachedSnapshot() {
    const snapshot = snapshotRef.current;
    if (!snapshot) return;
    const paths = collectStorageSnapshotPaths(snapshot);
    if (!paths.length) return;
    const requestId = ++cacheRequestRef.current;
    setCacheChecking(true);
    try {
      const result = await api.post("/api/storage/paths/exists", { paths });
      if (requestId !== cacheRequestRef.current) return;
      const existingPaths = new Set(result.existing || []);
      setStorage((current) => pruneStorageSnapshot(current, existingPaths));
      setCleanup((current) => pruneCleanupSnapshot(current, existingPaths));
      setAnalysis((current) => pruneAnalysisSnapshot(current, existingPaths));
      setCleanupSelections((current) => Object.fromEntries(
        Object.entries(current).map(([id, selected]) => [id, new Set([...selected].filter((targetPath) => existingPaths.has(targetPath)))])
      ));
    } catch {
      // Cached data remains useful when the lightweight existence check is unavailable.
    } finally {
      if (requestId === cacheRequestRef.current) setCacheChecking(false);
    }
  }

  function applyBaseData(overview, suggestions) {
    setStorage(overview);
    setCleanup(suggestions);
    setCleanupSelections((current) => {
      const next = {};
      for (const item of suggestions.filter((entry) => entry.selectionMode)) {
        const allowed = new Set((item.selectionItems || []).map((entry) => entry.path));
        const existing = current[item.id];
        next[item.id] = existing
          ? new Set([...existing].filter((targetPath) => allowed.has(targetPath)))
          : new Set((item.recommendedPaths || []).filter((targetPath) => allowed.has(targetPath)));
      }
      return next;
    });
    setExpandedCleanup((current) => {
      if (current.size) return current;
      return new Set(suggestions.filter((entry) => entry.selectionMode && entry.available).map((entry) => entry.id));
    });
  }

  async function loadBase({ fresh = false, background = false, includeAnalysis = false } = {}) {
    const requestId = ++baseRequestRef.current;
    if (!background) setBaseLoading(true);
    if (includeAnalysis) setAnalysisLoading(true);
    setError("");
    try {
      if (!fresh) {
        const volume = await api.get("/api/storage/volume");
        if (requestId !== baseRequestRef.current) return false;
        setStorage((current) => ({ ...current, volume, measuredAt: new Date().toISOString() }));
      }

      let refresh = await api.post("/api/storage/refresh", { includeAnalysis });
      let baseApplied = false;
      while (refresh.state === "running") {
        if (requestId !== baseRequestRef.current) return false;
        if (!baseApplied && refresh.baseCompletedAt) {
          const [overview, suggestions] = await Promise.all([
            api.get("/api/storage/overview"),
            api.get("/api/storage/cleanup")
          ]);
          if (requestId !== baseRequestRef.current) return false;
          applyBaseData(overview, suggestions);
          baseApplied = true;
          if (!background) setBaseLoading(false);
        }
        await waitForStorageRefreshPoll();
        refresh = await api.get(`/api/storage/refresh/${encodeURIComponent(refresh.id)}`);
      }
      if (refresh.state === "failed") throw new Error(refresh.error || "存储扫描失败");
      if (!baseApplied) {
        const [overview, suggestions] = await Promise.all([
          api.get("/api/storage/overview"),
          api.get("/api/storage/cleanup")
        ]);
        if (requestId !== baseRequestRef.current) return false;
        applyBaseData(overview, suggestions);
      }
      if (includeAnalysis) {
        const result = await api.get("/api/storage/analysis");
        if (requestId !== baseRequestRef.current) return false;
        setAnalysis(result);
        setAnalysisLoaded(true);
      }
      return true;
    } catch (err) {
      if (requestId === baseRequestRef.current) setError(err.message);
      return false;
    } finally {
      if (!background && requestId === baseRequestRef.current) setBaseLoading(false);
      if (includeAnalysis && requestId === baseRequestRef.current) setAnalysisLoading(false);
    }
  }

  async function loadAnalysis({ fresh = false } = {}) {
    const requestId = ++analysisRequestRef.current;
    setAnalysisLoading(true);
    setError("");
    try {
      api.get(`/api/storage/analysis/files${fresh ? "?fresh=1" : ""}`)
        .then((previewResult) => {
          if (requestId !== analysisRequestRef.current) return;
          setAnalysis((current) => ({
            ...current,
            files: previewResult.files,
            scannedAt: previewResult.scannedAt,
            threshold: previewResult.threshold,
            truncated: previewResult.truncated || current.truncated
          }));
        })
        .catch(() => {
          // The full analysis below remains the authoritative fallback.
        });
      let refresh = await api.post("/api/storage/refresh", { includeAnalysis: true, includeBase: false });
      while (refresh.state === "running") {
        if (requestId !== analysisRequestRef.current) return;
        await waitForStorageRefreshPoll();
        refresh = await api.get(`/api/storage/refresh/${encodeURIComponent(refresh.id)}`);
      }
      if (refresh.state === "failed") throw new Error(refresh.error || "大文件分析失败");
      const result = await api.get(`/api/storage/analysis${fresh ? "?fresh=1" : ""}`);
      if (requestId !== analysisRequestRef.current) return;
      setAnalysis(result);
      setAnalysisLoaded(true);
    } catch (err) {
      if (requestId === analysisRequestRef.current) setError(err.message);
    } finally {
      if (requestId === analysisRequestRef.current) setAnalysisLoading(false);
    }
  }

  useEffect(() => {
    writeStorageSnapshot({ storage, cleanup, analysis, analysisLoaded });
  }, [storage, cleanup, analysis, analysisLoaded]);

  useEffect(() => {
    if (initialSnapshot) {
      validateCachedSnapshot();
    } else {
      loadBase();
    }
  }, []);

  useEffect(() => {
    if ((view === "files" || view === "directories") && !analysisLoaded && !analysisLoading) loadAnalysis();
  }, [view, analysisLoaded, analysisLoading]);

  async function refreshCurrent() {
    cacheRequestRef.current += 1;
    setCacheChecking(false);
    const includeAnalysis = analysisLoaded || view === "files" || view === "directories";
    setMessage("正在后台扫描，当前结果保持可用");
    const refreshed = await loadBase({ fresh: true, includeAnalysis });
    if (refreshed) setMessage("存储信息已更新");
  }

  function acquireCleanup(id) {
    if (busyCleanupRef.current.has(id)) return false;
    const next = new Set(busyCleanupRef.current);
    next.add(id);
    busyCleanupRef.current = next;
    setBusyCleanup(next);
    return true;
  }

  function releaseCleanup(id) {
    const next = new Set(busyCleanupRef.current);
    next.delete(id);
    busyCleanupRef.current = next;
    setBusyCleanup(next);
  }

  function acquirePaths(paths) {
    const uniquePaths = [...new Set(paths)];
    if (uniquePaths.some((targetPath) => busyPathsRef.current.has(targetPath))) return false;
    const next = new Set(busyPathsRef.current);
    uniquePaths.forEach((targetPath) => next.add(targetPath));
    busyPathsRef.current = next;
    setBusyPaths(next);
    return true;
  }

  function releasePaths(paths) {
    const next = new Set(busyPathsRef.current);
    paths.forEach((targetPath) => next.delete(targetPath));
    busyPathsRef.current = next;
    setBusyPaths(next);
  }

  function removeAnalysisPaths(paths) {
    const roots = paths.filter(Boolean);
    if (!roots.length) return;
    analysisRequestRef.current += 1;
    setAnalysisLoading(false);
    setAnalysis((current) => ({
      ...current,
      files: current.files.filter((item) => !roots.some((root) => isStoragePathWithin(item.path, root))),
      directories: current.directories.filter((item) => !roots.some((root) => isStoragePathWithin(item.path, root)))
    }));
  }

  async function cleanSuggestion(item) {
    if (!acquireCleanup(item.id)) return;
    const warning = item.destructive
      ? `将永久清理「${item.title}」中的 ${formatBytes(item.size)} 内容，此操作无法撤销。\n\n${item.guidance || ""}\n\n是否继续？`
      : `将把「${item.title}」中的 ${item.itemCount} 个文件移到废纸篓。是否继续？`;
    if (!window.confirm(warning)) {
      releaseCleanup(item.id);
      return;
    }
    setError("");
    setMessage("");
    try {
      const result = await api.post(`/api/storage/cleanup/${item.id}`, {});
      setMessage(
        result.movedToTrash
          ? `已将 ${result.removed} 个项目移到废纸篓`
          : result.actualReclaimed > 0
            ? `已清理 ${result.removed} 个项目，磁盘可用空间增加 ${formatBytes(result.actualReclaimed)}`
            : `已清理 ${result.removed} 个项目，预计释放 ${formatBytes(result.reclaimed)}；APFS 容量统计将在下一次回读时确认`
      );
      setCleanup((current) => current.map((entry) => entry.id === item.id ? { ...entry, available: false, itemCount: 0, size: 0, tree: [] } : entry));
      removeAnalysisPaths(result.cleanedPaths || item.cleanedPaths || []);
      if (result.volume) setStorage((current) => ({ ...current, volume: result.volume, measuredAt: new Date().toISOString() }));
      void loadBase({ fresh: true, background: true });
    } catch (err) {
      setError(err.message);
    } finally {
      releaseCleanup(item.id);
    }
  }

  function setCleanupSelection(id, paths) {
    setCleanupSelections((current) => ({ ...current, [id]: new Set(paths) }));
  }

  function toggleCleanupSelection(id, targetPath) {
    setCleanupSelections((current) => {
      const nextSelection = new Set(current[id] || []);
      nextSelection.has(targetPath) ? nextSelection.delete(targetPath) : nextSelection.add(targetPath);
      return { ...current, [id]: nextSelection };
    });
  }

  async function cleanSelectedSuggestion(item) {
    const selectedPaths = [...(cleanupSelections[item.id] || [])];
    const selectedItems = (item.selectionItems || []).filter((entry) => selectedPaths.includes(entry.path));
    if (!selectedItems.length || !acquireCleanup(item.id)) return;
    const selectedLatest = selectedItems.filter((entry) => entry.keepLatest).length;
    const warning = `将把「${item.title}」中选中的 ${selectedItems.length} 个目录（${formatBytes(selectedItems.reduce((sum, entry) => sum + entry.size, 0))}）移到废纸篓。${selectedLatest ? `\n\n其中 ${selectedLatest} 个是项目最近的版本。` : ""}\n\n${item.guidance || ""}\n\n是否继续？`;
    if (!window.confirm(warning)) {
      releaseCleanup(item.id);
      return;
    }
    setError("");
    setMessage("");
    try {
      const result = await api.post(`/api/storage/cleanup/${item.id}/items`, { paths: selectedPaths });
      const removedPaths = result.cleanedPaths || [];
      setCleanupSelection(item.id, []);
      removeAnalysisPaths(removedPaths);
      setMessage(result.errors?.length
        ? `已将 ${result.removed} 个目录移到废纸篓，${result.errors.length} 个目录未处理`
        : `已将 ${result.removed} 个目录移到废纸篓，可在 Finder 中恢复`);
      if (result.volume) setStorage((current) => ({ ...current, volume: result.volume, measuredAt: new Date().toISOString() }));
      await loadBase({ fresh: true, background: true });
    } catch (err) {
      setError(err.message);
    } finally {
      releaseCleanup(item.id);
    }
  }

  async function showPreview(item) {
    setPreview(item);
    setPreviewLoading(true);
    setError("");
    try {
      setPreview(await api.post("/api/storage/inspect", { path: item.path }));
    } catch (err) {
      setError(err.message);
    } finally {
      setPreviewLoading(false);
    }
  }

  async function revealItem(item) {
    try {
      await api.post("/api/storage/reveal", { path: item.path });
    } catch (err) {
      setError(err.message);
    }
  }

  async function openItem(item) {
    try {
      await api.post("/api/storage/open", { path: item.path });
    } catch (err) {
      setError(err.message);
    }
  }

  async function trashItem(item) {
    if (!acquirePaths([item.path])) return;
    if (!window.confirm(`将「${item.name}」移到废纸篓？`)) {
      releasePaths([item.path]);
      return;
    }
    setError("");
    setPreview((current) => current?.path === item.path ? { ...current, busy: true } : current);
    try {
      const result = await api.post("/api/storage/items/trash", { path: item.path });
      setPreview(null);
      setMessage(`「${item.name}」已移到废纸篓，可在 Finder 中恢复`);
      removeAnalysisPaths([item.path]);
      setSelectedPaths((current) => {
        const next = new Set(current);
        next.delete(item.path);
        return next;
      });
      if (result.volume) setStorage((current) => ({ ...current, volume: result.volume, measuredAt: new Date().toISOString() }));
      void loadBase({ fresh: true, background: true });
    } catch (err) {
      setError(err.message);
    } finally {
      setPreview((current) => current?.path === item.path ? { ...current, busy: false } : current);
      releasePaths([item.path]);
    }
  }

  async function trashSelected(items) {
    const selectedItems = items.filter((item) => selectedPaths.has(item.path));
    if (!selectedItems.length || batchBusy) return;
    const highRiskCount = selectedItems.filter((item) => item.risk === "high").length;
    const warning = `将 ${selectedItems.length} 个项目移到废纸篓（${formatBytes(selectedItems.reduce((sum, item) => sum + item.size, 0))}）。${highRiskCount ? `其中 ${highRiskCount} 个项目标记为高风险，可能包含应用数据或工作资料。` : ""}\n\n移入废纸篓不会立即释放磁盘空间。是否继续？`;
    if (!window.confirm(warning)) return;
    const paths = selectedItems.map((item) => item.path);
    if (!acquirePaths(paths)) return;
    setBatchBusy(true);
    setError("");
    try {
      const result = await api.post("/api/storage/items/trash-batch", { paths });
      const trashedPaths = (result.trashed || []).map((entry) => entry.path);
      removeAnalysisPaths(trashedPaths);
      setSelectedPaths((current) => {
        const next = new Set(current);
        trashedPaths.forEach((targetPath) => next.delete(targetPath));
        return next;
      });
      setPreview(null);
      setMessage(result.errors?.length ? `已移入 ${result.removed} 个项目，${result.errors.length} 个项目未处理` : `已将 ${result.removed} 个项目移到废纸篓`);
      void loadBase({ fresh: true, background: true });
    } catch (err) {
      setError(err.message);
    } finally {
      releasePaths(paths);
      setBatchBusy(false);
    }
  }

  async function openStorageSettings() {
    try {
      await api.post("/api/storage/settings/open", {});
    } catch (err) {
      setError(err.message);
    }
  }

  const items = view === "directories" ? analysis.directories : analysis.files;
  const visibleItems = useMemo(() => {
    const normalizedQuery = query.trim().toLowerCase();
    return [...items]
      .filter((item) => !normalizedQuery || [item.name, item.path, item.type].join(" ").toLowerCase().includes(normalizedQuery))
      .sort((a, b) => (sortBy === "date" ? String(b.modifiedAt).localeCompare(String(a.modifiedAt)) : b.size - a.size));
  }, [items, query, sortBy]);
  useEffect(() => {
    setSelectedPaths(new Set());
  }, [view]);
  const cleanupTotal = cleanup.reduce((sum, item) => sum + item.size, 0);
  const volume = storage.volume;

  return (
    <section className="storageManager">
      <div className="storageToolbar">
        <div className="storageTabs" role="tablist" aria-label="存储空间视图">
          {[
            ["overview", "存储概览", <HardDrive size={15} />],
            ["cleanup", `清理建议${cleanupTotal ? ` · ${formatBytes(cleanupTotal)}` : ""}`, <ShieldCheck size={15} />],
            ["files", "大文件", <File size={15} />],
            ["directories", "占用目录", <Archive size={15} />]
          ].map(([id, label, icon]) => (
            <button key={id} className={view === id ? "selected" : ""} onClick={() => setView(id)} role="tab" aria-selected={view === id}>
              {icon}
              <span>{label}</span>
            </button>
          ))}
        </div>
        <div className="storageToolbarActions">
          <button className="secondaryButton" onClick={openStorageSettings} title="打开 macOS 系统设置中的存储空间">
            <ExternalLink size={15} />
            <span>系统存储设置</span>
          </button>
          <button className="iconButton" onClick={refreshCurrent} disabled={baseLoading || analysisLoading} aria-label="重新扫描" title="重新扫描">
            <RefreshCw size={16} className={baseLoading || analysisLoading ? "spin" : ""} />
          </button>
        </div>
      </div>

      {error && <div className="error storageFeedback" role="alert">{error}</div>}
      {message && <div className="notice storageFeedback" role="status">{message}</div>}

      <div className="storageContent" aria-busy={baseLoading || analysisLoading || cacheChecking}>
        {view === "overview" && (
          <div className="storageOverview">
            <section className="capacitySection">
              <div className="capacityHeadline">
                <div className="diskGlyph" aria-hidden="true"><HardDrive size={24} /></div>
                <div>
                  <span>{volume.name || "Macintosh HD"}</span>
                  <strong>{baseLoading && !volume.total ? "正在读取..." : `${formatBytes(volume.available)} 可用磁盘空间`}</strong>
                  <p>{baseLoading && !volume.total ? "正在读取 macOS 磁盘容量与目录占用" : `共 ${formatBytes(volume.total)} · 已使用 ${formatBytes(volume.used)} (${volume.usedPercent || 0}%)`}</p>
                </div>
                <dl className="volumeFacts">
                  <div><dt>格式</dt><dd>{volume.fileSystem || "-"}</dd></div>
                  <div><dt>介质</dt><dd>{volume.solidState === true ? "SSD" : volume.solidState === false ? "机械硬盘" : volume.protocol || "内置磁盘"}</dd></div>
                  <div><dt>挂载点</dt><dd>{volume.mountPoint || "/"}</dd></div>
                </dl>
              </div>

              <div className={`capacityBar ${baseLoading && !volume.total ? "loading" : ""}`} aria-label={`已使用 ${volume.usedPercent || 0}%`}>
                {storage.categories.map((category) => (
                  <span
                    key={category.id}
                    style={{ width: `${Math.max(0.35, (category.size / Math.max(volume.total, 1)) * 100)}%`, backgroundColor: category.color }}
                    title={`${category.label} ${formatBytes(category.size)}`}
                  />
                ))}
                <span className="availableSegment" style={{ width: `${(volume.available / Math.max(volume.total, 1)) * 100}%` }} title={`可用 ${formatBytes(volume.available)}`} />
              </div>
              <div className="capacityLegend">
                {storage.categories.map((category) => (
                  <span key={category.id}><i style={{ backgroundColor: category.color }} />{category.label}</span>
                ))}
                <span><i className="availableSwatch" />可用</span>
              </div>
            </section>

            <section className="storageBoundary" aria-label="磁盘与运行内存边界">
              <div><HardDrive size={16} /><span><strong>磁盘空间</strong> 清理文件、缓存和废纸篓内容；移入废纸篓不会立即释放空间。</span></div>
              <div><MemoryStick size={16} /><span><strong>运行内存</strong> 不由磁盘清理改变；请在进程管理中结束高占用应用，macOS 会自动管理内存与 Swap。</span></div>
            </section>

            <section className="categorySection">
              <div className="storageSectionTitle">
                <div><h2>占用分类</h2><p>基于本机常用目录扫描</p></div>
                <span>{storage.categories.length} 个分类</span>
              </div>
              <div className="categoryList">
                {storage.categories.map((category) => (
                  <div className="categoryRow" key={category.id}>
                    <i style={{ backgroundColor: category.color }} />
                    <span className="categoryIdentity"><strong>{category.label}</strong>{category.estimated && <small>估算</small>}</span>
                    <span className="categoryTrack"><i style={{ width: `${Math.min(100, (category.size / Math.max(volume.used, 1)) * 100)}%`, backgroundColor: category.color }} /></span>
                    <strong className="categorySize">{formatBytes(category.size)}</strong>
                  </div>
                ))}
                {baseLoading && !storage.categories.length && <div className="storageEmpty compact"><RefreshCw size={18} className="spin" /><strong>正在扫描占用分类...</strong></div>}
              </div>
              {storage.note && <div className="storageNote"><InfoIcon size={15} /><span>{storage.note}</span></div>}
              {storage.limitedAccess && (
                <div className="storageAccessNote">
                  <ShieldCheck size={15} />
                  <span>当前仅识别约 {storage.scanCoverage || 0}% 的已用空间。macOS 隐私权限可能限制了文稿、下载或应用数据扫描；系统存储设置仍会显示完整的系统分类。</span>
                </div>
              )}
            </section>

            <section className="quickCleanupSection">
              <div className="storageSectionTitle">
                <div><h2>可以立即处理</h2><p>先从占用明显、可识别的内容开始</p></div>
                <button className="secondaryButton" onClick={() => setView("cleanup")}>查看全部</button>
              </div>
              <div className="quickCleanupGrid">
                {cleanup.filter((item) => item.available).sort((a, b) => b.size - a.size).slice(0, 3).map((item) => (
                  <button key={item.id} onClick={() => setView("cleanup")}>
                    <span>{item.title}</span>
                    <strong>{item.sizeKnown ? formatBytes(item.size) : "待计算"}</strong>
                    <small>{item.itemCount} 个项目</small>
                    <ChevronRight size={16} />
                  </button>
                ))}
                {!cleanup.some((item) => item.available) && (
                  <div className="storageEmpty compact">
                    {baseLoading && <RefreshCw size={17} className="spin" />}
                    <span>{baseLoading ? "正在检查可清理内容..." : "暂未发现可清理内容"}</span>
                  </div>
                )}
              </div>
            </section>
          </div>
        )}

        {view === "cleanup" && (
          <section className="cleanupView">
            <div className="storageSectionTitle cleanupTitle">
              <div><h2>清理建议</h2><p>预计可处理 {formatBytes(cleanupTotal)}，每项都可展开查看实际目录内容</p></div>
            </div>
            <div className="cleanupList">
              {cleanup.map((item) => (
                <article className={`cleanupRow ${item.available ? "" : "empty"} ${busyCleanup.has(item.id) ? "busy" : ""}`} key={item.id}>
                  <span className={`cleanupIcon cleanup-${item.id}`}><ShieldCheck size={18} /></span>
                  <span className="cleanupIdentity">
                    <strong>{item.title}</strong>
                    <span>{item.description}</span>
                    <small className={`riskBadge risk-${item.risk || "medium"}`}>{item.riskLabel || "需确认"}</small>
                  </span>
                  <span className="cleanupCount">{item.itemCount ? `${item.itemCount} 个项目` : "没有内容"}</span>
                  <strong className="cleanupSize">{item.sizeKnown ? formatBytes(item.size) : "待计算"}</strong>
                  <span className="cleanupActions">
                    <button className="iconButton" onClick={() => setExpandedCleanup((current) => { const next = new Set(current); next.has(item.id) ? next.delete(item.id) : next.add(item.id); return next; })} aria-expanded={expandedCleanup.has(item.id)} aria-label={expandedCleanup.has(item.id) ? `收起${item.title}目录清单` : `展开${item.title}目录清单`} title={expandedCleanup.has(item.id) ? "收起目录清单" : "展开目录清单"}>
                      {expandedCleanup.has(item.id) ? <ChevronDown size={15} /> : <ChevronRight size={15} />}
                    </button>
                    {!item.selectionMode && <button className={`iconButton cleanupActionButton ${item.destructive ? "dangerButton" : "secondaryButton"}`} disabled={!item.available || busyCleanup.has(item.id)} onClick={() => cleanSuggestion(item)} aria-label={`${item.action}${item.title}`} title={`${item.action}${item.title}`}>
                      {busyCleanup.has(item.id) ? <RefreshCw size={15} className="spin" /> : <Trash2 size={15} />}
                    </button>}
                  </span>
                  {expandedCleanup.has(item.id) && <CleanupTree
                    item={item}
                    onReveal={revealItem}
                    selectedPaths={cleanupSelections[item.id] || new Set()}
                    onToggleSelection={toggleCleanupSelection}
                    onSelectAll={setCleanupSelection}
                    onCleanSelected={cleanSelectedSuggestion}
                    busy={busyCleanup.has(item.id)}
                  />}
                </article>
              ))}
            </div>
            <div className="cleanupSafety"><ShieldCheck size={17} /><div><strong>清理边界</strong><span>这里只检测当前用户目录。系统级 /Library/Caches 需要额外权限且由 macOS 自己管理；这里优先展示可解释的用户缓存、研发缓存和应用资源。</span></div></div>
          </section>
        )}

        {(view === "files" || view === "directories") && (
          <StorageItemList
            kind={view}
            items={visibleItems}
            query={query}
            setQuery={setQuery}
            sortBy={sortBy}
            setSortBy={setSortBy}
            loading={analysisLoading}
            scannedAt={analysis.scannedAt}
            threshold={analysis.threshold}
            truncated={analysis.truncated}
            selectedPaths={selectedPaths}
            busyPaths={busyPaths}
            batchBusy={batchBusy}
            onPreview={showPreview}
            onReveal={revealItem}
            onTrash={trashItem}
            onToggleSelection={(path) => setSelectedPaths((current) => { const next = new Set(current); next.has(path) ? next.delete(path) : next.add(path); return next; })}
            onSelectAll={(paths) => setSelectedPaths(new Set(paths))}
            onBatchTrash={trashSelected}
          />
        )}
      </div>

      {preview && (
        <StoragePreviewModal
          item={preview}
          loading={previewLoading}
          onOpen={() => openItem(preview)}
          onReveal={() => revealItem(preview)}
          onTrash={() => trashItem(preview)}
          onClose={() => setPreview(null)}
        />
      )}
    </section>
  );
}

function CleanupTreeNode({ node, depth = 0, onReveal }) {
  return (
    <>
      <div className="cleanupTreeNode" style={{ "--tree-depth": depth }}>
        <span className="cleanupTreeGlyph">{node.kind === "directory" ? <FolderOpen size={14} /> : <File size={14} />}</span>
        <span className="cleanupTreeName" title={node.path}>{node.name}</span>
        <strong>{formatBytes(node.size)}</strong>
        <button className="iconButton" onClick={() => onReveal({ path: node.path })} aria-label={`在 Finder 中显示 ${node.name}`} title="在 Finder 中显示"><FolderOpen size={14} /></button>
      </div>
      {node.children?.map((child) => <CleanupTreeNode key={child.path} node={child} depth={depth + 1} onReveal={onReveal} />)}
    </>
  );
}

function CleanupTree({ item, onReveal, selectedPaths, onToggleSelection, onSelectAll, onCleanSelected, busy }) {
  if (item.selectionMode) {
    return <SelectableCleanupTree
      item={item}
      selectedPaths={selectedPaths}
      onToggleSelection={onToggleSelection}
      onSelectAll={onSelectAll}
      onCleanSelected={onCleanSelected}
      busy={busy}
    />;
  }
  if (!item.tree?.length) return <div className="cleanupTree emptyTree">当前没有可清理项目</div>;
  return (
    <div className="cleanupTree">
      <div className="cleanupTreeHeader"><strong>将处理的目录清单</strong><span>按占用从大到小</span></div>
      {item.tree.map((root) => <CleanupTreeNode key={root.path} node={root} onReveal={onReveal} />)}
      {item.tree.some((root) => root.truncated) && <small className="cleanupTreeMore">仅展开占用最大的项目，清理范围仍以本项目录为准。</small>}
    </div>
  );
}

function SelectableCleanupTree({ item, selectedPaths, onToggleSelection, onSelectAll, onCleanSelected, busy }) {
  const selectionItems = item.selectionItems || [];
  const selectablePaths = selectionItems.map((entry) => entry.path);
  const selectedItems = selectionItems.filter((entry) => selectedPaths.has(entry.path));
  const allSelected = selectablePaths.length > 0 && selectablePaths.every((targetPath) => selectedPaths.has(targetPath));
  const recommendedPaths = item.recommendedPaths || [];
  const isArchiveSelection = item.selectionMode === "xcode-archives";
  return (
    <div className="cleanupTree selectableCleanupTree">
      <div className="cleanupTreeHeader">
        <strong>按项目选择目录</strong>
        <span>{selectedItems.length ? `已选 ${selectedItems.length} 个 · ${formatBytes(selectedItems.reduce((sum, entry) => sum + entry.size, 0))}` : "未选择"}</span>
      </div>
      <div className="cleanupSelectionToolbar">
        <label className="cleanupSelectAll">
          <input type="checkbox" checked={allSelected} disabled={!selectablePaths.length || busy} onChange={(event) => onSelectAll(item.id, event.target.checked ? selectablePaths : [])} />
          <span>选择全部</span>
        </label>
        {recommendedPaths.length > 0 && <button className="secondaryButton" disabled={busy} onClick={() => onSelectAll(item.id, recommendedPaths)}><Check size={14} /><span>{isArchiveSelection ? "自动选择旧版本" : "自动选择旧副本"}</span></button>}
        <span className="cleanupSelectionHint">{isArchiveSelection ? "每个项目最近的归档不会被选中" : "同名项目已归组；只推荐失效路径与日志空壳"}</span>
        <button className="dangerButton" disabled={!selectedItems.length || busy} onClick={() => onCleanSelected(item)}>
          {busy ? <RefreshCw size={14} className="spin" /> : <Trash2 size={14} />}
          <span>{busy ? "处理中" : "移到废纸篓"}</span>
        </button>
      </div>
      {!item.tree?.length ? <div className="emptyTree">当前没有可选择项目</div> : item.tree.map((root) => <SelectableCleanupTreeNode key={root.path} node={root} depth={0} selectedPaths={selectedPaths} onToggleSelection={onToggleSelection} itemId={item.id} />)}
    </div>
  );
}

function SelectableCleanupTreeNode({ node, depth, selectedPaths, onToggleSelection, itemId }) {
  const selected = node.selectable && selectedPaths.has(node.path);
  const expandable = !node.selectable && Boolean(node.children?.length);
  const [expanded, setExpanded] = useState(Boolean(node.expandedByDefault));
  return (
    <>
      <div className={`cleanupTreeNode selectableCleanupNode ${node.selectable ? "selectable" : ""}`} style={{ "--tree-depth": depth }}>
        {node.selectable
          ? <label className="cleanupTreeCheckbox" title={`选择${node.label || node.name}`}><input type="checkbox" checked={selected} onChange={() => onToggleSelection(itemId, node.path)} /><span /></label>
          : expandable
            ? <button className="cleanupTreeDisclosure" type="button" onClick={() => setExpanded((value) => !value)} aria-label={`${expanded ? "收起" : "展开"}${node.label || node.name}`} title={expanded ? "收起" : "展开"}>{expanded ? <ChevronDown size={14} /> : <ChevronRight size={14} />}</button>
            : <span className="cleanupTreeCheckboxPlaceholder" />}
        <span className="cleanupTreeGlyph">{node.kind === "directory" ? <FolderOpen size={14} /> : <File size={14} />}</span>
        <span className="cleanupTreeName" title={node.path}>
          <strong>{node.label || node.name}</strong>
          {node.selectable && (node.detail || node.projectName) && <small>{node.detail || node.projectName}</small>}
          {!node.selectable && node.itemCount > 1 && <small>{node.itemCount} 个目录</small>}
          {node.keepLatest && <em className="cleanupKeepBadge">当前 · 保留</em>}
          {node.orphanedShell && <em className="cleanupStaleBadge">日志空壳</em>}
          {node.workspaceExists === false && <em className="cleanupStaleBadge">源路径失效</em>}
        </span>
        <strong>{formatBytes(node.size)}</strong>
        {node.selectable && <time>{formatStorageDate(node.modifiedAt)}</time>}
      </div>
      {expandable && expanded && node.children.map((child) => <SelectableCleanupTreeNode key={child.path} node={child} depth={depth + 1} selectedPaths={selectedPaths} onToggleSelection={onToggleSelection} itemId={itemId} />)}
    </>
  );
}

function StorageItemList({ kind, items, query, setQuery, sortBy, setSortBy, loading, scannedAt, threshold, truncated, selectedPaths, busyPaths, batchBusy, onPreview, onReveal, onTrash, onToggleSelection, onSelectAll, onBatchTrash }) {
  const directoryView = kind === "directories";
  const selectableItems = items.filter((item) => item.canDelete !== false && item.batchEligible !== false);
  const selectablePaths = selectableItems.map((item) => item.path);
  const selectedVisibleItems = items.filter((item) => selectedPaths.has(item.path));
  const allSelected = selectablePaths.length > 0 && selectablePaths.every((targetPath) => selectedPaths.has(targetPath));
  const groups = useMemo(() => {
    const byGroup = new Map();
    for (const item of items) {
      const group = item.group || { id: "other", label: "其他大文件", path: "" };
      const current = byGroup.get(group.id) || { ...group, items: [], size: 0, highRisk: 0 };
      current.items.push(item);
      current.size += item.size;
      if (item.risk === "high") current.highRisk += 1;
      byGroup.set(group.id, current);
    }
    return [...byGroup.values()].sort((a, b) => b.size - a.size);
  }, [items]);
  return (
    <section className="storageItemsView">
      <div className="storageItemsToolbar">
        <label className="searchBox storageSearch">
          <Search size={16} />
          <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder={directoryView ? "搜索目录名称或路径" : "搜索文件名称、类型或路径"} />
          {query && <button onClick={() => setQuery("")} aria-label="清空搜索" title="清空搜索"><X size={15} /></button>}
        </label>
        <div className="segmented small storageSort">
          <button className={sortBy === "size" ? "selected" : ""} onClick={() => setSortBy("size")}>按大小</button>
          <button className={sortBy === "date" ? "selected" : ""} onClick={() => setSortBy("date")}>按日期</button>
        </div>
      </div>
      <div className="storageBatchBar">
        <label className="storageSelectAll"><input type="checkbox" checked={allSelected} disabled={!selectablePaths.length || batchBusy} onChange={(event) => onSelectAll(event.target.checked ? selectablePaths : [])} /><span>选择当前结果</span></label>
        <span>{selectedVisibleItems.length ? `已选 ${selectedVisibleItems.length} 个 · ${formatBytes(selectedVisibleItems.reduce((sum, item) => sum + item.size, 0))}` : "批量操作前请按目录和风险复核"}</span>
        <button className="dangerButton" disabled={!selectedVisibleItems.length || batchBusy} onClick={() => onBatchTrash(items)}>
          {batchBusy ? <RefreshCw size={15} className="spin" /> : <Trash2 size={15} />}
          <span>{batchBusy ? "处理中" : "移到废纸篓"}</span>
        </button>
      </div>
      <div className="storageItemsSummary">
        <span>{directoryView ? "大存储占用目录" : `大于 ${formatBytes(threshold || 100 * 1024 ** 2)} 的文件`}</span>
        <span>{items.length} 个结果 · {groups.length} 个目录组</span>
        <span>扫描于 {formatStorageDate(scannedAt)}</span>
        {truncated && <span>仅显示占用最大的结果</span>}
      </div>
      <div className="storageItemTable">
        {groups.map((group) => (
          <section className="storageItemGroup" key={group.id}>
            <header className="storageItemGroupHeader">
              <div><FolderOpen size={16} /><strong>{group.label}</strong><small>{group.path}</small></div>
              <span>{formatBytes(group.size)} · {group.items.length} 项{group.highRisk ? ` · ${group.highRisk} 个高风险` : ""}</span>
            </header>
            <div className="storageItemHeader"><span className="storageSelectHeader" /><span>名称</span><span>分类 / 风险</span><span>修改时间</span><span>大小</span><span>操作</span></div>
            {group.items.map((item) => {
              const busy = busyPaths.has(item.path);
              const selected = selectedPaths.has(item.path);
              return (
                <article className={`storageItemRow ${busy ? "busy" : ""} ${selected ? "selected" : ""}`} key={item.path} onDoubleClick={() => onPreview(item)} aria-busy={busy}>
                  <label className="storageItemSelect" title={item.batchEligible === false ? "请在应用管理中处理" : item.riskReason}>
                    <input type="checkbox" checked={selected} disabled={busy || item.canDelete === false || item.batchEligible === false} onChange={() => onToggleSelection(item.path)} />
                  </label>
                  <button className="storageItemIdentity" onClick={() => onPreview(item)} title="查看详情">
                    <span className="storageItemGlyph">{directoryView ? <Archive size={19} /> : <File size={19} />}</span>
                    <span><strong>{item.name}</strong><small>{item.path}</small></span>
                  </button>
                  <span className="storageItemClassification"><span>{item.categoryLabel || item.type}</span><small className={`riskBadge risk-${item.risk || "medium"}`} title={item.riskReason}>{item.riskLabel || "需确认"}</small></span>
                  <time>{formatStorageDate(item.modifiedAt)}</time>
                  <strong className="storageItemSize">{item.estimated ? `至少 ${formatBytes(item.size)}` : formatBytes(item.size)}</strong>
                  <span className="storageItemActions">
                    <button className="iconButton" onClick={() => onPreview(item)} disabled={busy} aria-label="预览" title="预览"><Eye size={15} /></button>
                    <button className="iconButton" onClick={() => onReveal(item)} disabled={busy} aria-label="在 Finder 中显示" title="在 Finder 中显示"><FolderOpen size={15} /></button>
                    <button className="iconButton dangerIcon" onClick={() => onTrash(item)} disabled={busy} aria-label={busy ? "处理中" : "移到废纸篓"} title={busy ? "处理中" : "移到废纸篓"}>{busy ? <RefreshCw size={15} className="spin" /> : <Trash2 size={15} />}</button>
                  </span>
                </article>
              );
            })}
          </section>
        ))}
        {!loading && !items.length && <div className="storageEmpty"><Archive size={28} /><strong>{query ? "没有匹配的项目" : "没有发现达到阈值的项目"}</strong></div>}
        {loading && !items.length && <div className="storageEmpty"><RefreshCw size={24} className="spin" /><strong>正在扫描本机目录...</strong></div>}
      </div>
    </section>
  );
}

function StoragePreviewModal({ item, loading, onOpen, onReveal, onTrash, onClose }) {
  useEffect(() => {
    function handleKeyDown(event) {
      if (event.key === "Escape") onClose();
    }
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [onClose]);

  return (
    <div className="modalBackdrop" onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
      <section className="storagePreview" role="dialog" aria-modal="true" aria-labelledby="storage-preview-title">
        <header className="previewHeader">
          <span className="previewGlyph">{item.kind === "directory" ? <Archive size={22} /> : <File size={22} />}</span>
          <div><h2 id="storage-preview-title">{item.name}</h2><p>{item.path}</p></div>
          <button className="iconButton" onClick={onClose} aria-label="关闭" title="关闭"><X size={17} /></button>
        </header>
        <div className="previewFacts">
          <div><span>大小</span><strong>{formatBytes(item.size)}</strong></div>
          <div><span>类型</span><strong>{item.type || (item.kind === "directory" ? "文件夹" : "文件")}</strong></div>
          <div><span>修改时间</span><strong>{formatStorageDate(item.modifiedAt)}</strong></div>
          <div><span>创建时间</span><strong>{formatStorageDate(item.createdAt)}</strong></div>
        </div>
        {(item.managed || item.risk) && (
          <div className="previewWarning">
            <InfoIcon size={16} />
            <span><strong>{item.riskLabel || "需确认"}</strong> · {item.riskReason || "这是应用管理的数据。"} {item.recommendation || "移到废纸篓前请先退出相关应用，并确认数据不再需要。"}</span>
          </div>
        )}
        {item.kind === "directory" && (
          <div className="previewChildren">
            <div className="previewChildrenTitle"><strong>目录内容</strong><span>按占用从大到小</span></div>
            {loading ? (
              <div className="previewLoading"><RefreshCw size={18} className="spin" />正在计算目录内容...</div>
            ) : (
              item.children?.slice(0, 12).map((child) => (
                <div key={child.path}>
                  <span>{child.kind === "directory" ? <Archive size={15} /> : <File size={15} />}</span>
                  <strong>{child.name}</strong>
                  <time>{formatStorageDate(child.modifiedAt)}</time>
                  <b>{formatBytes(child.size)}</b>
                </div>
              ))
            )}
            {!loading && !item.children?.length && <div className="previewLoading">目录为空或没有读取权限</div>}
          </div>
        )}
        <footer className="previewFooter">
          <button className="secondaryButton" onClick={onReveal}><FolderOpen size={15} /><span>Finder 中显示</span></button>
          <button className="secondaryButton" onClick={onOpen}><ExternalLink size={15} /><span>{item.kind === "directory" ? "打开目录" : "打开文件"}</span></button>
          <span />
          <button className="dangerButton" onClick={onTrash} disabled={item.busy}><Trash2 size={15} /><span>{item.busy ? "处理中" : "移到废纸篓"}</span></button>
        </footer>
      </section>
    </div>
  );
}

const SSH_OPTION_SUGGESTIONS = [
  ["HostName", "主机地址", "example.com"],
  ["User", "用户名", "root"],
  ["Port", "端口", "22"],
  ["IdentityFile", "身份文件", "~/.ssh/id_ed25519"],
  ["ProxyJump", "跳板机", "bastion"],
  ["ForwardAgent", "代理转发", "yes"]
];

const EMPTY_SSH_DATA = {
  directory: "~/.ssh",
  configPath: "~/.ssh/config",
  configExists: false,
  config: { hosts: [], globals: [] },
  keys: [],
  hasKey: false
};

async function copyTextToClipboard(value) {
  if (navigator.clipboard?.writeText) {
    await navigator.clipboard.writeText(value);
    return;
  }
  const textarea = document.createElement("textarea");
  textarea.value = value;
  textarea.style.position = "fixed";
  textarea.style.opacity = "0";
  document.body.appendChild(textarea);
  textarea.select();
  const copied = document.execCommand("copy");
  textarea.remove();
  if (!copied) throw new Error("当前环境不允许访问剪贴板");
}

function ToolsConfigManager({ view, onSelect }) {
  if (view === "ssh") return <SshManager />;
  return (
    <section className="toolsConfigPanel">
      <div className="toolsConfigIntro">
        <span className="toolsConfigIntroIcon"><Wrench size={22} /></span>
        <div>
          <strong>本机工具</strong>
          <p>选择一个工具进入配置管理。</p>
        </div>
      </div>
      <div className="toolsConfigGrid">
        <button type="button" className="toolConfigCard" onClick={() => onSelect("ssh")}>
          <span className="toolConfigIcon"><KeyRound size={21} /></span>
          <span className="toolConfigCopy"><strong>SSH 管理</strong><small>SSH Key 与 ~/.ssh/config</small></span>
          <ChevronRight size={16} />
        </button>
      </div>
    </section>
  );
}

function SshManager() {
  const [data, setData] = useState(EMPTY_SSH_DATA);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const [keyForm, setKeyForm] = useState({ name: "id_ed25519", algorithm: "ed25519", comment: "" });
  const [editor, setEditor] = useState(null);

  async function refresh({ silent = false } = {}) {
    if (!silent) {
      setLoading(true);
      setError("");
    }
    try {
      setData(await api.get("/api/tools/ssh"));
    } catch (err) {
      setError(err.message);
    } finally {
      if (!silent) setLoading(false);
    }
  }

  useEffect(() => {
    refresh();
  }, []);

  async function initializeKey() {
    setBusy("initialize");
    setError("");
    setMessage("");
    try {
      const result = await api.post("/api/tools/ssh/initialize", {});
      await refresh({ silent: true });
      setMessage(result.created ? `已生成 ${result.key.name}（${result.key.algorithmLabel}）` : `已检测到现有 SSH Key：${result.key.name}`);
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy("");
    }
  }

  async function generateKey(event) {
    event.preventDefault();
    setBusy("generate");
    setError("");
    setMessage("");
    try {
      const result = await api.post("/api/tools/ssh/keys/generate", keyForm);
      await refresh({ silent: true });
      setMessage(`已生成 ${result.name}（${result.algorithmLabel}）`);
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy("");
    }
  }

  async function copyKey(key, kind) {
    const label = kind === "private" ? "私钥" : "公钥";
    if (kind === "private" && !window.confirm(`确认复制「${key.name}」私钥？请勿将私钥发送给他人或粘贴到不受信任的位置。`)) return;
    setBusy(`copy-${key.name}-${kind}`);
    setError("");
    setMessage("");
    try {
      const result = await api.get(`/api/tools/ssh/keys/${encodeURIComponent(key.name)}/content?kind=${kind}`);
      await copyTextToClipboard(result.content);
      setMessage(`已复制 ${key.name} 的${label}`);
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy("");
    }
  }

  async function regenerateKey(key) {
    if (!window.confirm(`确认重新生成「${key.name}」？旧公钥和私钥会被覆盖。`)) return;
    setBusy(`regenerate-${key.name}`);
    setError("");
    setMessage("");
    try {
      const algorithm = ["ed25519", "rsa", "ecdsa"].includes(key.algorithm) ? key.algorithm : "ed25519";
      await api.post("/api/tools/ssh/keys/generate", { name: key.name, algorithm, overwrite: true });
      await refresh({ silent: true });
      setMessage(`已重新生成 ${key.name}`);
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy("");
    }
  }

  function startNewHost() {
    setEditor({ originalHost: "", host: "", options: [{ key: "HostName", value: "" }] });
    setError("");
    setMessage("");
  }

  function startEditHost(host) {
    setEditor({ originalHost: host.host, host: host.host, options: host.options?.length ? host.options.map((item) => ({ ...item })) : [{ key: "HostName", value: "" }] });
    setError("");
    setMessage("");
  }

  function updateEditor(field, value) {
    setEditor((current) => ({ ...current, [field]: value }));
  }

  function updateEditorOption(index, field, value) {
    setEditor((current) => ({
      ...current,
      options: current.options.map((option, optionIndex) => optionIndex === index ? { ...option, [field]: value } : option)
    }));
  }

  function addEditorOption() {
    setEditor((current) => ({ ...current, options: [...current.options, { key: "", value: "" }] }));
  }

  function removeEditorOption(index) {
    setEditor((current) => ({ ...current, options: current.options.filter((_option, optionIndex) => optionIndex !== index) }));
  }

  async function saveHost(event) {
    event.preventDefault();
    if (!editor?.host.trim()) {
      setError("请填写 Host 匹配模式");
      return;
    }
    setBusy("config");
    setError("");
    setMessage("");
    try {
      const payload = { host: editor.host, options: editor.options };
      if (editor.originalHost) {
        payload.originalHost = editor.originalHost;
        await api.patch("/api/tools/ssh/config", payload);
        setMessage(`已更新 Host ${editor.host}`);
      } else {
        await api.post("/api/tools/ssh/config", payload);
        setMessage(`已新增 Host ${editor.host}`);
      }
      await refresh({ silent: true });
      setEditor(null);
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy("");
    }
  }

  async function deleteHost(host) {
    if (!window.confirm(`确认删除 Host「${host.host}」？`)) return;
    setBusy(`delete-${host.host}`);
    setError("");
    setMessage("");
    try {
      await api.delete("/api/tools/ssh/config", { host: host.host });
      await refresh({ silent: true });
      setMessage(`已删除 Host ${host.host}`);
      if (editor?.originalHost === host.host) setEditor(null);
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy("");
    }
  }

  return (
    <section className="sshPanel">
      <div className="sshPanelHeader">
        <div className="sshPanelIdentity">
          <span className="sshPanelIcon"><KeyRound size={22} /></span>
          <div>
            <strong>SSH 管理</strong>
            <p>{data.directory} · {data.configPath}</p>
          </div>
        </div>
        <div className="topbarActions">
          <button type="button" className="secondaryButton" onClick={initializeKey} disabled={busy === "initialize" || loading} title="没有 SSH Key 时生成默认 Ed25519 Key">
            <KeyRound size={15} className={busy === "initialize" ? "spin" : ""} />
            <span>{busy === "initialize" ? "正在检查" : "初始化 SSH Key"}</span>
          </button>
          <button type="button" className="iconButton" onClick={() => refresh()} disabled={loading} aria-label="刷新 SSH 配置" title="刷新">
            <RefreshCw size={17} className={loading ? "spin" : ""} />
          </button>
        </div>
      </div>
      {error && <div className="error sshFeedback" role="alert">{error}</div>}
      {message && <div className="notice sshFeedback" role="status">{message}</div>}
      <div className="sshSectionHeader">
        <div><strong>SSH Key</strong><span>{data.keys.length ? `${data.keys.length} 个 Key` : "尚未检测到 Key"}</span></div>
      </div>
      {loading && !data.keys.length ? (
        <div className="sshEmptyState"><RefreshCw size={18} className="spin" /><span>正在读取 ~/.ssh...</span></div>
      ) : data.keys.length ? (
        <div className="sshKeyList">
          {data.keys.map((key) => (
            <article className="sshKeyRow" key={key.name}>
              <span className="sshKeyGlyph"><KeyRound size={17} /></span>
              <div className="sshKeyMain">
                <div className="sshKeyTitle"><strong>{key.name}</strong><span>{key.algorithmLabel}</span></div>
                <div className="sshKeyMeta">
                  <span className={key.publicExists ? "sshStateOk" : "sshStateMissing"}>{key.publicExists ? "公钥可用" : "缺少公钥"}</span>
                  <span className={key.privateExists ? "sshStateOk" : "sshStateMissing"}>{key.privateExists ? "私钥可用" : "缺少私钥"}</span>
                  {key.fingerprint && <code>{key.fingerprint}</code>}
                </div>
              </div>
              <div className="sshKeyActions">
                <button type="button" className="iconButton" onClick={() => copyKey(key, "public")} disabled={!key.publicExists || busy.startsWith("copy-")} aria-label={`复制 ${key.name} 公钥`} title="复制公钥"><Copy size={15} /></button>
                <button type="button" className="iconButton" onClick={() => copyKey(key, "private")} disabled={!key.privateExists || busy.startsWith("copy-")} aria-label={`复制 ${key.name} 私钥`} title="复制私钥"><FileCode2 size={15} /></button>
                <button type="button" className="iconButton" onClick={() => regenerateKey(key)} disabled={busy === `regenerate-${key.name}`} aria-label={`重新生成 ${key.name}`} title="重新生成"><RotateCcw size={15} /></button>
              </div>
            </article>
          ))}
        </div>
      ) : (
        <div className="sshEmptyState"><KeyRound size={20} /><strong>没有 SSH Key</strong><span>点击“初始化 SSH Key”生成默认 Ed25519 Key。</span></div>
      )}
      <form className="sshGenerateForm" onSubmit={generateKey}>
        <div className="sshSectionHeader"><div><strong>生成或重新生成</strong><span>生成前会检查同名文件，覆盖操作需要明确确认。</span></div></div>
        <div className="sshFormGrid">
          <label><span>Key 名称</span><input value={keyForm.name} onChange={(event) => setKeyForm((current) => ({ ...current, name: event.target.value }))} placeholder="id_ed25519" /></label>
          <label><span>类型</span><select value={keyForm.algorithm} onChange={(event) => setKeyForm((current) => ({ ...current, algorithm: event.target.value }))}><option value="ed25519">Ed25519</option><option value="rsa">RSA 4096</option><option value="ecdsa">ECDSA 521</option></select></label>
          <label className="sshFormWide"><span>备注（可选）</span><input value={keyForm.comment} onChange={(event) => setKeyForm((current) => ({ ...current, comment: event.target.value }))} placeholder="work laptop" /></label>
          <button type="submit" className="secondaryButton" disabled={busy === "generate"}><KeyRound size={15} className={busy === "generate" ? "spin" : ""} /><span>{busy === "generate" ? "生成中" : "生成 Key"}</span></button>
        </div>
      </form>
      <div className="sshSectionHeader sshConfigHeader">
        <div><strong>~/.ssh/config</strong><span>{data.config.hosts.length} 个 Host 配置 · {data.configExists ? "已解析" : "文件不存在，将在首次保存时创建"}</span></div>
        <button type="button" className="secondaryButton" onClick={startNewHost}><Plus size={15} /><span>新增 Host</span></button>
      </div>
      {editor && (
        <form className="sshConfigEditor" onSubmit={saveHost}>
          <div className="sshEditorTitle"><strong>{editor.originalHost ? "编辑 Host" : "新增 Host"}</strong><button type="button" className="iconButton" onClick={() => setEditor(null)} aria-label="关闭编辑器" title="关闭"><X size={15} /></button></div>
          <label><span>Host 匹配模式</span><input value={editor.host} onChange={(event) => updateEditor("host", event.target.value)} placeholder="work 或 *.example.com" autoFocus /></label>
          <div className="sshOptionsEditor">
            {editor.options.map((option, index) => (
              <div className="sshOptionEditorRow" key={index}>
                <select value={option.key} onChange={(event) => updateEditorOption(index, "key", event.target.value)} aria-label={`第 ${index + 1} 个配置项名称`}>
                  <option value="">自定义配置项</option>
                  {SSH_OPTION_SUGGESTIONS.map(([key, label]) => <option key={key} value={key}>{label}（{key}）</option>)}
                </select>
                {SSH_OPTION_SUGGESTIONS.some(([key]) => key === option.key) ? (
                  <input value={option.value} onChange={(event) => updateEditorOption(index, "value", event.target.value)} placeholder={SSH_OPTION_SUGGESTIONS.find(([key]) => key === option.key)?.[2] || "配置项值"} aria-label={`第 ${index + 1} 个配置项值`} />
                ) : (
                  <div className="sshCustomOptionInputs"><input value={option.key} onChange={(event) => updateEditorOption(index, "key", event.target.value)} placeholder="配置项名称" aria-label={`第 ${index + 1} 个自定义配置项名称`} /><input value={option.value} onChange={(event) => updateEditorOption(index, "value", event.target.value)} placeholder="配置项值" aria-label={`第 ${index + 1} 个自定义配置项值`} /></div>
                )}
                <button type="button" className="iconButton" onClick={() => removeEditorOption(index)} aria-label="删除配置项" title="删除"><Trash2 size={14} /></button>
              </div>
            ))}
          </div>
          <div className="sshEditorActions"><button type="button" className="secondaryButton" onClick={addEditorOption}><Plus size={14} /><span>添加配置项</span></button><span /><button type="button" className="secondaryButton" onClick={() => setEditor(null)}>取消</button><button type="submit" className="primaryButton" disabled={busy === "config"}><Save size={14} /><span>{busy === "config" ? "保存中" : "保存配置"}</span></button></div>
        </form>
      )}
      {data.config.hosts.length ? (
        <div className="sshHostList">
          {data.config.hosts.map((host) => (
            <article className="sshHostRow" key={host.host}>
              <div className="sshHostHeader"><div><code>Host {host.host}</code><span>{host.options.length} 项配置</span></div><div className="sshHostActions"><button type="button" className="iconButton" onClick={() => startEditHost(host)} aria-label={`编辑 Host ${host.host}`} title="编辑"><Pencil size={15} /></button><button type="button" className="iconButton" onClick={() => deleteHost(host)} disabled={busy === `delete-${host.host}`} aria-label={`删除 Host ${host.host}`} title="删除"><Trash2 size={15} /></button></div></div>
              {host.options.length ? <div className="sshOptionsPreview">{host.options.map((option, index) => <span key={`${host.host}-${option.key}-${index}`}><strong>{option.key}</strong><code>{option.value}</code></span>)}</div> : <span className="sshNoOptions">没有 Host 专属配置</span>}
            </article>
          ))}
        </div>
      ) : (
        <div className="sshEmptyState sshConfigEmpty"><FileCode2 size={20} /><strong>还没有 Host 配置</strong><span>新增配置后会写入 {data.configPath}。</span></div>
      )}
      {data.config.globals.length > 0 && <details className="sshGlobals"><summary>全局配置（{data.config.globals.length} 行）</summary><pre>{data.config.globals.join("\n")}</pre></details>}
    </section>
  );
}

const POWER_SETTING_LABELS = {
  "System Sleep Timer (Minutes)": "系统睡眠",
  "Disk Sleep Timer (Minutes)": "磁盘睡眠",
  "Display Sleep Timer (Minutes)": "显示器睡眠",
  "Sleep on Power Button": "电源键睡眠",
  "Wake on LAN": "网络唤醒",
  "Hibernate Mode": "休眠模式",
  "Low Power Mode": "低电量模式",
  "Current Power Source": "当前供电",
  "Prioritize Network Reachability Over Sleep": "优先网络可达",
  "Reduce Brightness": "降低亮度"
};

function formatPowerSetting(key, value) {
  const label = POWER_SETTING_LABELS[key] || key;
  if (/Minutes$/.test(key)) {
    const minutes = Number(value);
    return [label, Number.isFinite(minutes) && minutes > 0 ? `${minutes} 分钟` : "永不"];
  }
  if (/^(Yes|No)$/.test(value)) return [label, value === "Yes" ? "开启" : "关闭"];
  return [label, value];
}

function PowerSettingsTable({ title, settings }) {
  const entries = Object.entries(settings || {});
  if (!entries.length) return null;
  return (
    <div className="powerSettingsSection">
      <strong>{title}</strong>
      <div className="powerSettingsGrid">
        {entries.map(([key, value]) => {
          const [label, displayValue] = formatPowerSetting(key, value);
          return (
            <div key={key}>
              <span>{label}</span>
              <em>{displayValue}</em>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function BackupManager() {
  const [status, setStatus] = useState(null);
  const [bundle, setBundle] = useState(null);
  const [loading, setLoading] = useState("");
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");

  useEffect(() => {
    refresh();
  }, []);

  async function refresh() {
    setLoading("status");
    setError("");
    try {
      setStatus(await api.get("/api/backup/status"));
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading("");
    }
  }

  async function startBackup() {
    if (!status?.configured) {
      setError("还没有配置 Time Machine 备份目的地，请先在系统设置中添加备份磁盘。");
      return;
    }
    setLoading("start");
    setError("");
    setMessage("");
    try {
      await api.post("/api/backup/start", {});
      setMessage("已请求启动 Time Machine 备份，进度会在下方刷新。");
      await refresh();
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading("");
    }
  }

  async function exportConfig() {
    setLoading("export");
    setError("");
    try {
      const result = await api.get("/api/backup/config/export");
      setBundle(result);
      setMessage(`已导出 ${result.files.length} 个配置文件，敏感行已脱敏。`);
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading("");
    }
  }

  async function importConfig() {
    if (!bundle?.bundle) return;
    if (!window.confirm(`确认使用当前导出内容覆盖 ${bundle.bundle.fileCount} 个本地配置文件？`)) return;
    setLoading("import");
    setError("");
    setMessage("");
    try {
      const result = await api.post("/api/backup/config/import", { bundle: bundle.bundle });
      setMessage(`已恢复 ${result.applied.length} 个配置文件${result.skipped.length ? `，跳过 ${result.skipped.length} 个` : ""}。`);
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading("");
    }
  }

  async function deleteSnapshot(name) {
    if (!window.confirm(`确认删除本地快照 ${name}？该快照内的历史副本将无法恢复。`)) return;
    setLoading(`snapshot:${name}`);
    setError("");
    try {
      await api.post("/api/backup/snapshots/delete", { name });
      setMessage(`已删除本地快照 ${name}。`);
      await refresh();
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading("");
    }
  }

  return (
    <section className="systemInfoPanel">
      <div className="systemInfoToolbar">
        <div className="updateVersion">
          <strong>{status?.configured ? `已配置 ${status.destinations.length} 个备份目的地` : "尚未配置 Time Machine"}</strong>
          <span>{status?.session?.running ? `正在备份：${status.session.percent ?? "?"}%` : status?.measuredAt ? `状态更新于 ${new Intl.DateTimeFormat("zh-CN", { hour: "2-digit", minute: "2-digit" }).format(new Date(status.measuredAt))}` : ""}</span>
        </div>
        <div className="systemInfoActions">
          <button className="secondaryButton" type="button" onClick={refresh} disabled={Boolean(loading)}>
            <RefreshCw size={14} className={loading === "status" ? "spin" : ""} />
            <span>刷新</span>
          </button>
          <button className="primaryButton" type="button" onClick={startBackup} disabled={Boolean(loading) || !status?.configured}>
            <Archive size={14} />
            <span>{loading === "start" ? "启动中" : "立即备份"}</span>
          </button>
        </div>
      </div>

      {error && <div className="error" role="alert">{error}</div>}
      {message && <div className="notice" role="status">{message}</div>}
      {status?.note && <div className="systemInfoNote"><InfoIcon size={15} /><span>{status.note}</span></div>}

      {status && (
        <div className="networkPanels">
          <div className="networkPanel">
            <div className="networkPanelHeader">
              <strong>备份目的地</strong>
              <span>{status.destinations.length} 个</span>
            </div>
            <div className="proxyList">
              {status.destinations.map((destination) => (
                <div key={`${destination.id}-${destination.name}`}>
                  <strong>{destination.name}</strong>
                  <span>{destination.kind || "未知类型"}{destination.mountPoint ? ` · ${destination.mountPoint}` : ""}</span>
                </div>
              ))}
              {!status.destinations.length && <div className="emptyState">没有配置备份磁盘</div>}
            </div>
            <div className="networkPanelHeader backupHistoryHeader">
              <strong>最近备份</strong>
              <span>{status.backups.length} 条</span>
            </div>
            <div className="proxyList">
              {status.backups.slice(0, 6).map((backup) => (
                <div key={backup}><span>{backup}</span></div>
              ))}
              {!status.backups.length && <div className="emptyState">没有可用的备份记录</div>}
            </div>
          </div>

          <div className="networkPanel">
            <div className="networkPanelHeader">
              <strong>APFS 本地快照</strong>
              <span>{status.localSnapshots.length} 个</span>
            </div>
            <div className="proxyList">
              {status.localSnapshots.map((snapshot) => (
                <div key={snapshot.name}>
                  <strong>{snapshot.createdAt || snapshot.name}</strong>
                  <button className="secondaryButton snapshotDelete" type="button" onClick={() => deleteSnapshot(snapshot.name)} disabled={Boolean(loading)}>
                    <Trash2 size={13} />
                    <span>删除</span>
                  </button>
                </div>
              ))}
              {!status.localSnapshots.length && <div className="emptyState">没有本地快照</div>}
            </div>
            <div className="systemInfoNote">
              <InfoIcon size={15} />
              <span>本地快照由 Time Machine 在本地磁盘保留；删除后该时间点的本地历史副本不可恢复。</span>
            </div>
          </div>
        </div>
      )}

      <div className="networkPanel">
        <div className="networkPanelHeader">
          <strong>配置导出与恢复</strong>
          <span>包含任务备注、Agent 权限、SSH Host 与自动化配置</span>
        </div>
        <div className="systemInfoActions">
          <button className="secondaryButton" type="button" onClick={exportConfig} disabled={Boolean(loading)}>
            <Download size={14} />
            <span>{loading === "export" ? "导出中" : "导出配置"}</span>
          </button>
          <button className="secondaryButton" type="button" onClick={importConfig} disabled={Boolean(loading) || !bundle}>
            <Save size={14} />
            <span>{loading === "import" ? "恢复中" : "恢复当前导出"}</span>
          </button>
        </div>
        {bundle && (
          <div className="configFileList">
            {bundle.files.map((file) => (
              <div key={file.id}>
                <strong>{file.label}</strong>
                <span>{file.path}</span>
                <em>{formatMemory(Math.round(file.bytes / 1024))}{file.redacted ? " · 已脱敏" : ""}</em>
              </div>
            ))}
            {!bundle.files.length && <div className="emptyState">没有找到可导出的配置文件</div>}
          </div>
        )}
      </div>
    </section>
  );
}

function LeftoverCleanupManager() {
  const [data, setData] = useState(null);
  const [selected, setSelected] = useState(() => new Set());
  const [loading, setLoading] = useState("");
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");

  useEffect(() => {
    scan();
  }, []);

  const orphans = data?.orphans || [];
  const selectedPaths = orphans.filter((item) => selected.has(item.id)).flatMap((item) => item.paths);
  const selectedBytes = orphans.filter((item) => selected.has(item.id)).reduce((total, item) => total + (item.bytes || 0), 0);

  async function scan() {
    setLoading("scan");
    setError("");
    try {
      setData(await api.get("/api/cleanup/leftovers?limit=40"));
      setSelected(new Set());
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading("");
    }
  }

  function toggle(id) {
    setSelected((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  async function trashSelected() {
    if (!selectedPaths.length) return;
    if (!window.confirm(`确认把 ${selectedPaths.length} 个残留路径移入废纸篓？可在废纸篓中恢复。`)) return;
    setLoading("trash");
    setError("");
    setMessage("");
    try {
      const result = await api.post("/api/cleanup/leftovers/trash", { paths: selectedPaths });
      setMessage(`已移入废纸篓 ${result.trashedCount} 项${result.errorCount ? `，${result.errorCount} 项失败` : ""}。`);
      await scan();
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading("");
    }
  }

  return (
    <section className="systemInfoPanel">
      <div className="systemInfoToolbar">
        <span className="monitoringSamples">
          {data ? `已安装 ${data.installedApplicationCount} 个应用 · 发现 ${data.candidateCount} 组疑似残留 · 当前列出 ${formatMemory(Math.round((data.displayedBytes ?? data.totalBytes ?? 0) / 1024))}` : "尚未扫描"}
        </span>
        <div className="systemInfoActions">
          <button className="secondaryButton" type="button" onClick={scan} disabled={Boolean(loading)}>
            <RefreshCw size={14} className={loading === "scan" ? "spin" : ""} />
            <span>{loading === "scan" ? "扫描中" : "重新扫描"}</span>
          </button>
          <button className="dangerButton" type="button" onClick={trashSelected} disabled={!selectedPaths.length || loading === "trash"}>
            <Trash2 size={14} />
            <span>{loading === "trash" ? "清理中" : `清理所选（${selected.size}）`}</span>
          </button>
        </div>
      </div>

      {error && <div className="error" role="alert">{error}</div>}
      {message && <div className="notice" role="status">{message}</div>}
      {data && <div className="systemInfoNote"><InfoIcon size={15} /><span>{data.note}</span></div>}

      <div className="leftoverList">
        {orphans.map((item) => (
          <label className={`leftoverRow ${selected.has(item.id) ? "selected" : ""}`} key={item.id}>
            <input type="checkbox" checked={selected.has(item.id)} onChange={() => toggle(item.id)} />
            <div className="leftoverIdentity">
              <strong>{item.label}</strong>
              <span>{item.paths.join("、")}</span>
            </div>
            <span className="leftoverCategory">{item.categoryLabel}</span>
            <em>{item.bytes ? formatMemory(Math.round(item.bytes / 1024)) : "大小未知"}</em>
          </label>
        ))}
        {data && !orphans.length && <div className="emptyState">没有发现明显的卸载残留。</div>}
        {loading === "scan" && !data && <div className="emptyState">正在扫描用户资源库…</div>}
      </div>

      {selectedBytes > 0 && (
        <div className="leftoverSummary">
          <span>已选 {selectedPaths.length} 条路径</span>
          <strong>{formatMemory(Math.round(selectedBytes / 1024))}</strong>
        </div>
      )}
    </section>
  );
}

const NETWORK_COUNTRY_NAMES = (() => {
  try {
    return new Intl.DisplayNames(["zh-CN"], { type: "region" });
  } catch {
    return null;
  }
})();

const WORLD_WIDTH = NETWORK_WORLD_WIDTH;
const WORLD_HEIGHT = NETWORK_WORLD_HEIGHT;
const WORLD_COUNTRIES = topojsonFeature(worldAtlas, worldAtlas.objects.countries).features;

function networkCountryName(country, countryCode = "") {
  if (!countryCode) return country || "未知国家";
  try {
    return NETWORK_COUNTRY_NAMES?.of(countryCode.toUpperCase()) || country || countryCode;
  } catch {
    return country || countryCode;
  }
}

function networkFlag(countryCode = "") {
  const code = String(countryCode || "").toUpperCase();
  if (!/^[A-Z]{2}$/.test(code)) return "·";
  return String.fromCodePoint(...[...code].map((letter) => 127397 + letter.charCodeAt(0)));
}

const CHINA_REGION_NAMES = {
  "Beijing": "北京", "Tianjin": "天津", "Shanghai": "上海", "Chongqing": "重庆",
  "Hebei Sheng": "河北省", "Shanxi Sheng": "山西省", "Liaoning Sheng": "辽宁省",
  "Jilin Sheng": "吉林省", "Heilongjiang Sheng": "黑龙江省", "Jiangsu Sheng": "江苏省",
  "Zhejiang Sheng": "浙江省", "Anhui Sheng": "安徽省", "Fujian Sheng": "福建省",
  "Jiangxi Sheng": "江西省", "Shandong Sheng": "山东省", "Henan Sheng": "河南省",
  "Hubei Sheng": "湖北省", "Hunan Sheng": "湖南省", "Guangdong Sheng": "广东省",
  "Hainan Sheng": "海南省", "Sichuan Sheng": "四川省", "Guizhou Sheng": "贵州省",
  "Yunnan Sheng": "云南省", "Shaanxi Sheng": "陕西省", "Gansu Sheng": "甘肃省",
  "Qinghai Sheng": "青海省", "Taiwan Sheng": "台湾省", "Nei Mongol Zizhiqu": "内蒙古自治区",
  "Guangxi Zhuangzu Zizhiqu": "广西壮族自治区", "Xizang Zizhiqu": "西藏自治区",
  "Ningxia Huizu Zizhiqu": "宁夏回族自治区", "Xinjiang Uygur Zizhiqu": "新疆维吾尔自治区",
  "Hong Kong": "香港特别行政区", "Macau": "澳门特别行政区"
};

const CHINA_CITY_NAMES = {
  "Beijing": "北京", "Shanghai": "上海", "Tianjin": "天津", "Chongqing": "重庆",
  "Hangzhou": "杭州", "Ningbo": "宁波", "Wenzhou": "温州", "Jinhua": "金华",
  "Nanjing": "南京", "Suzhou": "苏州", "Wuxi": "无锡", "Yangzhou": "扬州",
  "Guangzhou": "广州", "Shenzhen": "深圳", "Dongguan": "东莞", "Foshan": "佛山",
  "Chengdu": "成都", "Wuhan": "武汉", "Changsha": "长沙", "Xiamen": "厦门",
  "Fuzhou": "福州", "Qingdao": "青岛", "Jinan": "济南", "Zhengzhou": "郑州",
  "Xi'an": "西安", "Kunming": "昆明", "Hefei": "合肥", "Shijiazhuang": "石家庄",
  "Shenyang": "沈阳", "Dalian": "大连", "Harbin": "哈尔滨", "Changchun": "长春"
};

function networkRegionName(region, countryCode = "") {
  const value = String(region || "");
  if (String(countryCode || "").toUpperCase() === "CN") return CHINA_REGION_NAMES[value] || value;
  return value.replace(/ Sheng$/, " Province").replace(/ Shi$/, " City").replace(/ Zizhiqu$/, " Autonomous Region");
}

function networkCityName(city, countryCode = "") {
  const value = String(city || "");
  if (String(countryCode || "").toUpperCase() === "CN") return CHINA_CITY_NAMES[value] || value;
  return value;
}

function networkApplicationCountries(application) {
  if (application?.countryCodes?.length) {
    return application.countryCodes.map((code) => networkCountryName("", code));
  }
  return application?.countries || [];
}

function formatNetworkTime(value) {
  if (!value) return "等待首次扫描";
  const time = new Date(value);
  const seconds = Math.max(0, Math.round((Date.now() - time.getTime()) / 1000));
  if (seconds < 10) return "刚刚";
  if (seconds < 60) return `${seconds} 秒前`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)} 分钟前`;
  return new Intl.DateTimeFormat("zh-CN", { hour: "2-digit", minute: "2-digit" }).format(time);
}

function formatNetworkBytes(bytes) {
  const value = Number(bytes) || 0;
  if (value < 1024) return `${value} B`;
  if (value < 1024 ** 2) return `${(value / 1024).toFixed(1)} KB`;
  if (value < 1024 ** 3) return `${(value / 1024 ** 2).toFixed(1)} MB`;
  return `${(value / 1024 ** 3).toFixed(1)} GB`;
}

function networkDirectionMeta(direction) {
  if (direction === "inbound") return { label: "入站", className: "inbound", icon: <ArrowDown size={13} /> };
  if (direction === "listener") return { label: "监听", className: "listener", icon: <Wifi size={13} /> };
  return { label: "外联", className: "outbound", icon: <ArrowUp size={13} /> };
}

function WorldFootprintMap({ points, self, direction, selectedId, onSelect }) {
  const visiblePoints = (points || []).filter((point) => {
    if (direction === "outbound") return point.outbound > 0;
    if (direction === "inbound") return point.inbound > 0;
    return point.total > 0;
  });
  const origin = self?.success && Number.isFinite(self.latitude) && Number.isFinite(self.longitude)
    ? [self.longitude, self.latitude]
    : null;
  const originKey = origin ? `${origin[0].toFixed(4)},${origin[1].toFixed(4)}` : "default";
  const projection = useMemo(() => createNetworkWorldProjection(origin), [originKey]);
  const worldPath = useMemo(() => geoPath(projection), [projection]);
  const originPoint = origin ? projection(origin) : null;
  const graticulePath = worldPath(geoGraticule10());

  return (
    <div className="worldFootprint">
      <svg viewBox={`0 0 ${WORLD_WIDTH} ${WORLD_HEIGHT}`} role="img" aria-label="本机网络连接世界地图">
        <defs>
          <linearGradient id="worldOcean" x1="0" y1="0" x2="1" y2="1">
            <stop offset="0" stopColor="#eef6f8" />
            <stop offset="1" stopColor="#dfeef1" />
          </linearGradient>
          <filter id="networkGlow" x="-100%" y="-100%" width="300%" height="300%">
            <feGaussianBlur stdDeviation="3" result="blur" />
            <feMerge><feMergeNode in="blur" /><feMergeNode in="SourceGraphic" /></feMerge>
          </filter>
          <marker id="networkArrowOutbound" viewBox="0 0 8 8" refX="7" refY="4" markerWidth="6" markerHeight="6" orient="auto">
            <path d="M0 0L8 4L0 8Z" fill="#238276" />
          </marker>
          <marker id="networkArrowInbound" viewBox="0 0 8 8" refX="7" refY="4" markerWidth="6" markerHeight="6" orient="auto">
            <path d="M0 0L8 4L0 8Z" fill="#bf7420" />
          </marker>
          <marker id="networkArrowMixed" viewBox="0 0 8 8" refX="7" refY="4" markerWidth="6" markerHeight="6" orient="auto">
            <path d="M0 0L8 4L0 8Z" fill="#765dab" />
          </marker>
        </defs>
        <rect className="worldOcean" x="0" y="0" width={WORLD_WIDTH} height={WORLD_HEIGHT} rx="13" />
        <path className="worldSphere" d={worldPath({ type: "Sphere" })} />
        <path className="worldGraticule" d={graticulePath} />
        {WORLD_COUNTRIES.map((country, index) => (
          <path className="worldCountry" d={worldPath(country)} key={country.id || index} />
        ))}
        {originPoint && visiblePoints.map((point) => {
          const arc = buildNetworkArc({ origin, point, direction });
          if (!arc) return null;
          return (
            <path
              className={`worldArc ${arc.kind}`}
              d={worldPath({ type: "LineString", coordinates: arc.coordinates })}
              markerEnd={`url(#${arc.markerId})`}
              key={`arc-${point.id}`}
            />
          );
        })}
        {visiblePoints.map((point) => {
          const projected = projection([point.longitude, point.latitude]);
          if (!projected) return null;
          const count = direction === "inbound" ? point.inbound : direction === "outbound" ? point.outbound : point.total;
          const radius = Math.min(12, 3.8 + Math.sqrt(Math.max(1, count)) * 1.45);
          const className = point.inbound && point.outbound ? "mixed" : point.inbound ? "inbound" : "outbound";
          return (
            <g
              className={`worldPoint ${className} ${selectedId === point.id ? "selected" : ""}`}
              transform={`translate(${projected[0]}, ${projected[1]})`}
              key={point.id}
              role="button"
              tabIndex="0"
              onClick={() => onSelect(point.id)}
              onKeyDown={(event) => { if (event.key === "Enter" || event.key === " ") onSelect(point.id); }}
            >
              <circle className="worldPointHalo" r={radius + 7} />
              <circle className="worldPointCore" r={radius} />
              <text x={radius + 7} y="4">{networkCountryName(point.country, point.countryCode)}</text>
              <title>{`${networkCountryName(point.country, point.countryCode)} · ${networkRegionName(point.region, point.countryCode)} · ${count} 条连接`}</title>
            </g>
          );
        })}
        {originPoint && (
          <g className="worldOrigin" transform={`translate(${originPoint[0]}, ${originPoint[1]})`} aria-label={`本机出口：${networkCountryName(self.country, self.countryCode)} ${self.city || self.region || ""}`}>
            <circle className="worldOriginHalo" r="17" />
            <circle className="worldOriginRing" r="8.5" />
            <circle className="worldOriginCore" r="4.5" />
            <text className="worldOriginLabel" x="0" y="22">本机</text>
          </g>
        )}
      </svg>
      {!visiblePoints.length && (
        <div className="worldMapEmpty">
          <Globe size={22} />
          <strong>正在绘制网络足迹</strong>
          <span>公网连接出现后会在这里落点；IP 定位结果可能需要几秒。</span>
        </div>
      )}
      <div className="worldMapLegend">
        <span><i className="legendOutbound" />外联 → 目标</span>
        <span><i className="legendInbound" />入站 → 本机</span>
        <span><i className="legendMixed" />双向</span>
        {self?.success && <span className="worldMapEgress">本机居中：{networkCountryName(self.country, self.countryCode)} · {self.city || self.region}</span>}
      </div>
    </div>
  );
}

function NetworkMonitorManager() {
  const [data, setData] = useState(null);
  const [error, setError] = useState("");
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState("all");
  const [mapDirection, setMapDirection] = useState("all");
  const [selectedPointId, setSelectedPointId] = useState("");
  const [showLocal, setShowLocal] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [savingConfig, setSavingConfig] = useState(false);
  const mountedRef = useRef(true);

  async function loadSnapshot({ manual = false } = {}) {
    if (manual) setRefreshing(true);
    try {
      const next = manual
        ? await api.post("/api/network-monitor/refresh", {})
        : await api.get("/api/network-monitor/snapshot");
      if (mountedRef.current) {
        setData(next);
        setShowLocal(Boolean(next.config?.includeLocal));
        setError("");
      }
    } catch (err) {
      if (mountedRef.current) setError(err.message);
    } finally {
      if (mountedRef.current && manual) setRefreshing(false);
    }
  }

  useEffect(() => {
    mountedRef.current = true;
    loadSnapshot();
    const timer = window.setInterval(() => {
      if (!document.hidden) loadSnapshot();
    }, 5_000);
    return () => {
      mountedRef.current = false;
      window.clearInterval(timer);
    };
  }, []);

  async function updateConfig(patch) {
    setSavingConfig(true);
    try {
      const config = await api.patch("/api/network-monitor/config", patch);
      setData((current) => current ? { ...current, config: { ...current.config, ...config } } : current);
      setShowLocal(Boolean(config.includeLocal));
      setError("");
      await loadSnapshot({ manual: true });
    } catch (err) {
      setError(err.message);
    } finally {
      setSavingConfig(false);
    }
  }

  const selectedPoint = useMemo(
    () => data?.mapPoints?.find((point) => point.id === selectedPointId) || null,
    [data?.mapPoints, selectedPointId]
  );

  const rows = useMemo(() => {
    if (!data) return [];
    const source = filter === "listener"
      ? data.listeners || []
      : [
        ...(data.connections || []),
        ...(showLocal ? data.localConnections || [] : [])
      ].filter((flow) => filter === "all" || flow.direction === filter);
    const needle = query.trim().toLowerCase();
    return source.filter((flow) => {
      if (!needle) return true;
      return [
        flow.applicationName,
        flow.processName,
        flow.processPath,
        flow.remoteAddress,
        flow.resolvedHost,
        flow.host,
        flow.hosts?.join(" "),
        flow.country,
        flow.region,
        flow.city,
        flow.state,
        flow.route,
        flow.localPort,
        flow.remotePort
      ].filter(Boolean).join(" ").toLowerCase().includes(needle);
    }).slice(0, 240);
  }, [data, filter, query, showLocal]);

  const summary = data?.summary || {};
  const publicInbound = data?.connections?.filter((flow) => flow.direction === "inbound").length || 0;
  const topCountries = (data?.countries || []).slice(0, 6);
  const topApplications = (data?.applications || []).slice(0, 10);
  const proxyReady = Boolean(data?.proxy?.available);

  return (
    <div className="networkMonitorPage">
      <section className="networkMonitorHero">
        <div className="networkMonitorStatus">
          <span className={`liveIndicator ${data?.scanning ? "scanning" : ""}`}><i />{data?.scanning ? "扫描中" : "实时监控"}</span>
          <span>上次扫描 {formatNetworkTime(data?.lastScanAt)}</span>
          <span>监控自 {data?.monitoringSince ? new Intl.DateTimeFormat("zh-CN", { hour: "2-digit", minute: "2-digit" }).format(new Date(data.monitoringSince)) : "--"}</span>
          {proxyReady && <span className="networkProxyBadge"><ShieldCheck size={13} />代理目标已还原</span>}
        </div>
        <div className="networkMonitorActions">
          <button className="secondaryButton" onClick={() => loadSnapshot({ manual: true })} disabled={refreshing}>
            <RefreshCw size={15} className={refreshing ? "spin" : ""} />
            <span>{refreshing ? "扫描中" : "立即扫描"}</span>
          </button>
        </div>
      </section>

      {error && <div className="error" role="alert">{error}</div>}

      <div className="networkStatGrid">
        <article className="networkStatCard outbound">
          <span className="networkStatIcon"><ArrowUp size={17} /></span>
          <div><span>外联目标</span><strong>{summary.outbound ?? 0}</strong><small>{summary.publicFlows ?? 0} 个公网端点已归类</small></div>
        </article>
        <article className="networkStatCard inbound">
          <span className="networkStatIcon"><ArrowDown size={17} /></span>
          <div><span>入站连接</span><strong>{summary.inbound ?? 0}</strong><small>{publicInbound} 个来自公网，其余为局域网</small></div>
        </article>
        <article className="networkStatCard apps">
          <span className="networkStatIcon"><Activity size={17} /></span>
          <div><span>活跃应用</span><strong>{summary.applications ?? 0}</strong><small>按应用进程与 App Bundle 聚合</small></div>
        </article>
        <article className="networkStatCard geography">
          <span className="networkStatIcon"><Globe size={17} /></span>
          <div><span>覆盖地区</span><strong>{summary.countries ?? 0}</strong><small>{summary.regions ?? 0} 个国家/省级地区</small></div>
        </article>
        <article className="networkStatCard services">
          <span className="networkStatIcon"><Wifi size={17} /></span>
          <div><span>本机监听</span><strong>{summary.listeners ?? 0}</strong><small>仅展示套接字，不读取流量内容</small></div>
        </article>
      </div>

      <section className="networkMapPanel">
        <header className="networkSectionHeader">
          <div>
            <strong>世界足迹</strong>
            <span>以本机出口为中心；外联箭头指向目标，入站箭头指回本机。</span>
          </div>
          <div className="segmented networkMapSegment">
            {[["all", "全部"], ["outbound", "外联"], ["inbound", "入站"]].map(([id, label]) => (
              <button key={id} className={mapDirection === id ? "selected" : ""} onClick={() => setMapDirection(id)}>{label}</button>
            ))}
          </div>
        </header>
        <div className="networkMapLayout">
          <WorldFootprintMap
            points={data?.mapPoints || []}
            self={data?.self}
            direction={mapDirection}
            selectedId={selectedPointId}
            onSelect={(id) => setSelectedPointId((current) => current === id ? "" : id)}
          />
          <aside className="networkMapAside">
            {selectedPoint ? (
              <div className="networkPointDetail">
                <span className="networkPointFlag">{networkFlag(selectedPoint.countryCode)}</span>
                <div>
                  <strong>{networkCountryName(selectedPoint.country, selectedPoint.countryCode)}</strong>
                  <span>{networkRegionName(selectedPoint.region, selectedPoint.countryCode)}{selectedPoint.city ? ` · ${networkCityName(selectedPoint.city, selectedPoint.countryCode)}` : ""}</span>
                </div>
                <div className="networkPointCounts">
                  <span><ArrowUp size={12} />{selectedPoint.outbound}</span>
                  <span><ArrowDown size={12} />{selectedPoint.inbound}</span>
                </div>
                <p>{selectedPoint.applications.join("、")}</p>
                <code>{selectedPoint.ips.slice(0, 4).join(" · ")}</code>
              </div>
            ) : (
              <div className="networkMapAsideIntro">
                <Globe size={20} />
                <strong>{summary.geolocatedFlows || 0} 个公网端点已定位</strong>
                <span>{summary.pendingFlows ? `${summary.pendingFlows} 个端点正在补全归属地` : "点击地图落点查看应用与 IP"}</span>
              </div>
            )}
            <div className="networkRanking">
              <div className="networkRankingHeader"><strong>国家与地区</strong><span>{topCountries.length ? "按连接数" : "等待定位"}</span></div>
              {topCountries.map((country) => (
                <button
                  className="networkRankingRow"
                  key={country.countryCode || country.country}
                  onClick={() => {
                    const point = (data?.mapPoints || []).find((item) => item.countryCode === country.countryCode);
                    if (point) setSelectedPointId(point.id);
                  }}
                >
                  <span className="networkPointFlag">{networkFlag(country.countryCode)}</span>
                  <span><strong>{networkCountryName(country.country, country.countryCode)}</strong><em>{country.regions.slice(0, 2).map((region) => networkRegionName(region, country.countryCode)).join(" · ")}</em></span>
                  <b>{country.total}</b>
                </button>
              ))}
              {!topCountries.length && <div className="networkRankingEmpty">归属地查询在后台进行，地图会自动补点。</div>}
            </div>
          </aside>
        </div>
      </section>

      <div className="networkLowerGrid">
        <section className="networkAppsPanel">
          <header className="networkSectionHeader">
            <div><strong>应用网络活动</strong><span>同一 App Bundle 下的 Helper 进程会合并显示。</span></div>
            <span className="networkSectionCount">{topApplications.length} 个应用</span>
          </header>
          <div className="networkAppList">
            {topApplications.map((application) => (
              <button
                className="networkAppRow"
                key={application.name}
                onClick={() => {
                  setQuery(application.name);
                  setFilter("all");
                }}
              >
                <span className="networkAppGlyph">{application.name.slice(0, 1).toUpperCase()}</span>
                <span className="networkAppIdentity">
                  <strong>{application.name}</strong>
                  <em>{networkApplicationCountries(application).length ? networkApplicationCountries(application).slice(0, 3).join(" · ") : "局域网或待定位"}</em>
                </span>
                <span className="networkAppFlowBars">
                  <i className="outbound" style={{ width: `${Math.max(6, application.outbound / Math.max(1, application.total) * 100)}%` }} />
                  <i className="inbound" style={{ width: `${Math.max(0, application.inbound / Math.max(1, application.total) * 100)}%` }} />
                </span>
                <span className="networkAppCounts"><b>{application.outbound}</b><em>{application.inbound}</em></span>
              </button>
            ))}
            {!topApplications.length && <div className="emptyState">等待应用建立网络连接</div>}
          </div>
        </section>

        <section className="networkPrivacyPanel">
          <header className="networkSectionHeader">
            <div><strong>监控与隐私</strong><span>本地采集优先，只有定位功能会访问公网。</span></div>
            <ShieldCheck size={19} />
          </header>
          <div className="networkToggleRow">
            <div><strong>IP 归属地查询</strong><span>向 ipwho.is 发送公网 IP，不发送应用名、域名或流量内容。</span></div>
            <button
              className={`toggleSwitch ${data?.config?.geolocationEnabled ? "on" : ""}`}
              role="switch"
              aria-checked={Boolean(data?.config?.geolocationEnabled)}
              onClick={() => updateConfig({ geolocationEnabled: !data?.config?.geolocationEnabled })}
              disabled={!data || savingConfig}
            ><i /></button>
          </div>
          <div className="networkToggleRow">
            <div><strong>显示局域网与本机连接</strong><span>包含 127.0.0.1、私有地址和 mDNS 等本地流量。</span></div>
            <button
              className={`toggleSwitch ${showLocal ? "on" : ""}`}
              role="switch"
              aria-checked={showLocal}
              onClick={() => updateConfig({ includeLocal: !showLocal })}
              disabled={!data || savingConfig}
            ><i /></button>
          </div>
          <dl className="networkPrivacyFacts">
            <div><dt>采集方式</dt><dd>lsof 套接字表 + 进程/App Bundle 归属</dd></div>
            <div><dt>代理透视</dt><dd>{proxyReady ? "Clash/Mihomo 已连接，可还原应用真实目标" : "未检测到代理控制接口"}</dd></div>
            <div><dt>数据留存</dt><dd>当前会话 {data?.config?.retentionMinutes || 10} 分钟；归属地缓存 30 天</dd></div>
            <div><dt>不会采集</dt><dd>网页内容、请求正文、账号、密码或数据包载荷</dd></div>
            <div><dt>可见范围</dt><dd>当前用户可读取的进程套接字；部分 root 专属服务可能需要特权采集</dd></div>
          </dl>
          <div className="networkLimitNote">
            <InfoIcon size={14} />
            <span>“入站”只统计已建立/已接受的连接，不包括被防火墙直接丢弃的扫描包。要审计丢包需另外启用有权限的 pf/pcap 采集。</span>
          </div>
        </section>
      </div>

      <section className="networkConnectionsPanel">
        <header className="networkSectionHeader networkConnectionsHeader">
          <div><strong>连接明细</strong><span>外联、入站与监听服务统一查看。</span></div>
          <div className="networkConnectionTools">
            <div className="segmented">
              {[["all", "全部"], ["outbound", "外联"], ["inbound", "入站"], ["listener", "监听"]].map(([id, label]) => (
                <button key={id} className={filter === id ? "selected" : ""} onClick={() => setFilter(id)}>{label}</button>
              ))}
            </div>
            <label className="searchBox networkSearch">
              <Search size={15} />
              <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="搜索应用、IP、地区" />
            </label>
          </div>
        </header>
        <div className="networkTable" role="table" aria-label="网络连接明细">
          <div className="networkTableHeader" role="row">
            <span>应用 / 进程</span><span>方向</span><span>远端或监听地址</span><span>归属地</span><span>链路与状态</span><span>最近活动</span>
          </div>
          <div className="networkTableBody">
            {rows.map((flow) => {
              const direction = networkDirectionMeta(flow.direction);
              const target = flow.direction === "listener" || flow.listener
                ? `${flow.localAddress || "*"}:${flow.localPort || "*"}`
                : flow.resolvedHost || flow.host || flow.remoteAddress || "未知目标";
              const secondary = flow.direction === "listener" || flow.listener
                ? `${flow.protocol} 监听`
                : `${flow.remoteAddress || "解析中"}:${flow.remotePort || ""}${flow.host && flow.host !== target ? ` · ${flow.host}` : ""}${flow.connectionCount > 1 ? ` · ${flow.connectionCount} 个套接字` : ""}`;
              const location = flow.direction === "listener" || flow.listener
                ? "本机服务"
                : flow.country
                  ? `${networkFlag(flow.countryCode)} ${networkCountryName(flow.country, flow.countryCode)}${flow.region ? ` · ${networkRegionName(flow.region, flow.countryCode)}` : ""}`
                  : flow.geolocating ? "定位中" : "本地/未定位";
              return (
                <div className={`networkTableRow ${!flow.active ? "inactive" : ""}`} role="row" key={flow.key}>
                  <div className="networkConnectionApp">
                    <span className={`networkActivityDot ${flow.active ? "active" : ""}`} />
                    <span><strong>{flow.applicationName || flow.processName}</strong><em>{flow.pid ? `PID ${flow.pid}` : flow.processName || "系统服务"}</em></span>
                  </div>
                  <span className={`networkDirectionBadge ${direction.className}`}>{direction.icon}{direction.label}</span>
                  <div className="networkTarget"><strong>{target}</strong><em>{secondary}</em></div>
                  <span className="networkLocation">{location}</span>
                  <div className="networkRoute"><strong>{flow.route || flow.state || (flow.listener ? "LISTEN" : "活动")}</strong><em>{flow.rule ? `${flow.rule}${flow.rulePayload ? ` · ${flow.rulePayload}` : ""}` : flow.source === "proxy" ? "代理目标" : formatNetworkBytes((flow.uploadBytes || 0) + (flow.downloadBytes || 0))}</em></div>
                  <span className="networkLastSeen">{formatNetworkTime(flow.lastSeen)}</span>
                </div>
              );
            })}
            {!rows.length && <div className="networkTableEmpty"><Wifi size={19} /><span>{data ? "当前筛选条件下没有连接" : "正在加载本机网络连接"}</span></div>}
          </div>
        </div>
      </section>
    </div>
  );
}

function NetworkDiagnostics() {
  const [host, setHost] = useState("1.1.1.1");
  const [port, setPort] = useState("443");
  const [result, setResult] = useState(null);
  const [ports, setPorts] = useState(null);
  const [proxy, setProxy] = useState(null);
  const [loading, setLoading] = useState("");
  const [error, setError] = useState("");

  useEffect(() => {
    refreshLocal();
  }, []);

  async function refreshLocal() {
    try {
      const [nextPorts, nextProxy] = await Promise.all([
        api.get("/api/network/listening-ports"),
        api.get("/api/network/proxy")
      ]);
      setPorts(nextPorts);
      setProxy(nextProxy);
    } catch (err) {
      setError(err.message);
    }
  }

  async function run(kind) {
    setLoading(kind);
    setError("");
    setResult(null);
    try {
      if (kind === "ping") setResult({ kind, ...(await api.post("/api/network/ping", { host, count: 4 })) });
      else if (kind === "traceroute") setResult({ kind, ...(await api.post("/api/network/traceroute", { host })) });
      else if (kind === "dns") setResult({ kind, ...(await api.post("/api/network/dns", { host })) });
      else if (kind === "port") setResult({ kind, ...(await api.post("/api/network/port", { host, port: Number(port) })) });
      else if (kind === "speed") setResult({ kind, ...(await api.post("/api/network/speed-test", {})) });
      else if (kind === "ports") {
        setPorts(await api.get("/api/network/listening-ports"));
        setResult({ kind: "ports" });
      } else if (kind === "proxy") {
        setProxy(await api.get("/api/network/proxy"));
        setResult({ kind: "proxy" });
      }
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading("");
    }
  }

  return (
    <section className="systemInfoPanel">
      <div className="networkToolbar">
        <label className="searchBox networkHostField">
          <Search size={16} />
          <input value={host} onChange={(event) => setHost(event.target.value)} placeholder="主机名或 IP，例如 github.com" />
        </label>
        <label className="networkPortField">
          <span>端口</span>
          <input value={port} onChange={(event) => setPort(event.target.value)} inputMode="numeric" placeholder="443" />
        </label>
      </div>

      <div className="networkActions">
        <button className="secondaryButton" type="button" onClick={() => run("ping")} disabled={Boolean(loading)}>
          <Activity size={14} /><span>{loading === "ping" ? "检测中" : "Ping"}</span>
        </button>
        <button className="secondaryButton" type="button" onClick={() => run("traceroute")} disabled={Boolean(loading)}>
          <GitBranch size={14} /><span>{loading === "traceroute" ? "追踪中" : "路由追踪"}</span>
        </button>
        <button className="secondaryButton" type="button" onClick={() => run("dns")} disabled={Boolean(loading)}>
          <Globe size={14} /><span>{loading === "dns" ? "解析中" : "DNS 查询"}</span>
        </button>
        <button className="secondaryButton" type="button" onClick={() => run("port")} disabled={Boolean(loading)}>
          <Cable size={14} /><span>{loading === "port" ? "检测中" : "端口检测"}</span>
        </button>
        <button className="secondaryButton" type="button" onClick={() => run("speed")} disabled={Boolean(loading)} title="下载约 25MB 测试文件">
          <ArrowDown size={14} /><span>{loading === "speed" ? "测速中" : "测速"}</span>
        </button>
        <button className="secondaryButton" type="button" onClick={() => run("ports")} disabled={Boolean(loading)}>
          <ListRestart size={14} /><span>监听端口</span>
        </button>
      </div>

      {error && <div className="error" role="alert">{error}</div>}

      {result && (
        <div className="networkResult">
          {result.kind === "ping" && (
            <>
              <div className="networkResultHeader">
                <strong>{result.host}</strong>
                <span className={result.reachable ? "ok" : "bad"}>{result.reachable ? "可达" : "不可达"}</span>
              </div>
              <div className="networkStatGrid">
                <Info icon={<Activity size={15} />} label="平均延迟" value={result.avgMs === null ? "-" : `${result.avgMs} ms`} />
                <Info icon={<ArrowDown size={15} />} label="丢包率" value={`${result.packetLossPercent}%`} />
                <Info icon={<TrendingUp size={15} />} label="最小/最大" value={`${result.minMs ?? "-"} / ${result.maxMs ?? "-"} ms`} />
              </div>
            </>
          )}
          {result.kind === "dns" && (
            <>
              <div className="networkResultHeader"><strong>{result.host}</strong><span>{result.record} 记录</span></div>
              <div className="networkAnswerList">
                {result.answers.length ? result.answers.map((answer) => <code key={answer}>{answer}</code>) : <span className="emptyState">没有解析结果</span>}
              </div>
            </>
          )}
          {result.kind === "port" && (
            <div className="networkResultHeader">
              <strong>{result.host}:{result.port}</strong>
              <span className={result.reachable ? "ok" : "bad"}>{result.reachable ? `可连接（${result.elapsedMs} ms）` : "不可连接"}</span>
            </div>
          )}
          {result.kind === "speed" && (
            <>
              <div className="networkResultHeader"><strong>下行带宽</strong><span className="ok">{result.megabitsPerSecond} Mbps</span></div>
              <div className="networkStatGrid">
                <Info icon={<ArrowDown size={15} />} label="下载速率" value={`${result.megabytesPerSecond} MB/s`} />
                <Info icon={<Activity size={15} />} label="耗时" value={`${result.elapsedMs} ms`} />
                <Info icon={<HardDrive size={15} />} label="下载量" value={formatMemory(Math.round(result.bytesDownloaded / 1024 / 1024))} />
              </div>
            </>
          )}
          {result.kind === "traceroute" && (
            <>
              <div className="networkResultHeader"><strong>{result.host}</strong><span>{result.hops.length} 跳</span></div>
              <div className="hopList">
                {result.hops.map((hop) => (
                  <div key={`${hop.hop}-${hop.address}`}>
                    <span>{hop.hop}</span>
                    <code>{hop.address || "*"}</code>
                    <em>{hop.times.length ? `${hop.times.join(" / ")} ms` : "无响应"}</em>
                  </div>
                ))}
              </div>
            </>
          )}
        </div>
      )}

      <div className="networkPanels">
        <div className="networkPanel">
          <div className="networkPanelHeader">
            <strong>本机监听端口</strong>
            <span>{ports ? `${ports.summary.total} 个，其中 ${ports.summary.exposed} 个对外可访问` : "读取中"}</span>
          </div>
          <div className="networkPortList">
            {(ports?.entries || []).slice(0, 40).map((entry) => (
              <div key={`${entry.pid}-${entry.address}`} className={/127\.0\.0\.1|\[::1\]/.test(entry.address) ? "loopback" : "exposed"}>
                <strong>{entry.port}</strong>
                <span>{entry.command}</span>
                <em>PID {entry.pid ?? "-"} · {/127\.0\.0\.1|\[::1\]/.test(entry.address) ? "仅本机" : "对外"}</em>
              </div>
            ))}
            {ports && !ports.entries.length && <div className="emptyState">没有读取到监听端口</div>}
          </div>
        </div>
        <div className="networkPanel">
          <div className="networkPanelHeader">
            <strong>代理状态</strong>
            <span>{proxy ? `${proxy.proxies.filter((entry) => entry.http.enabled || entry.https.enabled).length} 个网络服务启用了代理` : "读取中"}</span>
          </div>
          <div className="proxyList">
            {(proxy?.proxies || []).map((entry) => (
              <div key={entry.service}>
                <strong>{entry.service}</strong>
                <span>HTTP {entry.http.enabled ? `${entry.http.server}:${entry.http.port}` : "未启用"}</span>
                <span>HTTPS {entry.https.enabled ? `${entry.https.server}:${entry.https.port}` : "未启用"}</span>
                {entry.auto.enabled && <span>自动代理 {entry.auto.url}</span>}
              </div>
            ))}
            {proxy && !proxy.proxies.length && <div className="emptyState">没有读取到网络服务</div>}
          </div>
        </div>
      </div>
    </section>
  );
}

function SystemInfoManager({ view }) {
  const [power, setPower] = useState(null);
  const [sleep, setSleep] = useState(null);
  const [updates, setUpdates] = useState(null);
  const [loading, setLoading] = useState("");
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");

  useEffect(() => {
    setError("");
    setMessage("");
    if (view === "power" && !power) loadPower();
    if (view === "sleep" && !sleep) loadSleep();
    if (view === "updates" && !updates) loadUpdates();
  }, [view]);

  if (view === "network") {
    return <NetworkDiagnostics />;
  }
  if (view === "backup") {
    return <BackupManager />;
  }
  if (view === "leftovers") {
    return <LeftoverCleanupManager />;
  }

  async function loadPower() {
    setLoading("power");
    try {
      setPower(await api.get("/api/system-info/power"));
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading("");
    }
  }

  async function loadSleep({ limit = 40 } = {}) {
    setLoading("sleep");
    try {
      setSleep(await api.get(`/api/system-info/sleep?limit=${limit}`));
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading("");
    }
  }

  async function loadUpdates({ fresh = false } = {}) {
    setLoading("updates");
    setError("");
    try {
      setUpdates(await api.get(`/api/system-info/updates${fresh ? "?fresh=1" : ""}`));
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading("");
    }
  }

  async function openUpdateSettings() {
    setMessage("");
    try {
      await api.post("/api/system-settings/open", { id: "general" });
      setMessage("已打开系统设置中的通用面板，可继续进入软件更新。");
    } catch (err) {
      setError(err.message);
    }
  }

  if (view === "power") {
    const battery = power?.battery || {};
    const health = battery.healthPercent;
    return (
      <section className="systemInfoPanel">
        {error && <div className="error" role="alert">{error}</div>}
        {loading === "power" && !power && <div className="emptyState">正在读取电池与电源数据…</div>}
        {power && (
          <>
            <div className="batteryHero">
              <div className={`batteryGauge ${health !== null && health !== undefined && health < 80 ? "degraded" : ""}`}>
                <strong>{battery.stateOfChargePercent ?? "--"}%</strong>
                <span>{battery.charging ? "正在充电" : battery.fullyCharged ? "已充满" : battery.currentPowerSource ? "外接电源" : "使用电池"}</span>
              </div>
              <div className="batteryFacts">
                <Info icon={<BatteryCharging size={16} />} label="健康度" value={health === null || health === undefined ? "未知" : `${health}%`} />
                <Info icon={<Activity size={16} />} label="电池状况" value={battery.condition || "未知"} />
                <Info icon={<RefreshCw size={16} />} label="循环次数" value={battery.cycleCount ?? "未知"} />
                <Info icon={<Zap size={16} />} label="供电来源" value={battery.currentPowerSource ? "外接电源" : "电池"} />
                <Info icon={<FileText size={16} />} label="电池序列号" value={battery.serialNumber || "-"} mono />
              </div>
            </div>
            <div className="systemInfoNote">
              <InfoIcon size={15} />
              <span>健康度由 macOS 报告的「最大容量」换算；低于 80% 时系统通常会建议维修。</span>
            </div>
            <div className="powerSettingsColumns">
              <PowerSettingsTable title="电池供电" settings={power.settings?.battery} />
              <PowerSettingsTable title="外接电源" settings={power.settings?.ac} />
            </div>
          </>
        )}
      </section>
    );
  }

  if (view === "sleep") {
    const events = sleep?.events || [];
    return (
      <section className="systemInfoPanel">
        <div className="systemInfoToolbar">
          <span>{events.length ? `最近 ${events.length} 条事件` : "还没有读取到事件"}</span>
          <button className="secondaryButton" type="button" onClick={() => loadSleep()} disabled={loading === "sleep"}>
            <RefreshCw size={14} className={loading === "sleep" ? "spin" : ""} />
            <span>刷新事件</span>
          </button>
        </div>
        {error && <div className="error" role="alert">{error}</div>}
        {loading === "sleep" && !sleep && <div className="emptyState">正在读取 pmset 睡眠日志…</div>}
        {sleep && !events.length && <div className="emptyState">没有读取到睡眠或唤醒记录。</div>}
        {events.length > 0 && (
          <div className="sleepEventList">
            {events.map((event, index) => (
              <div className={`sleepEvent ${event.kind.toLowerCase()}`} key={`${event.at}-${index}`}>
                <span className="sleepEventKind">{event.kind}</span>
                <strong>{event.reason || "未记录原因"}</strong>
                <span className="sleepEventTime">{event.at}</span>
                <span className="sleepEventMeta">
                  {event.chargePercent !== null ? `电量 ${event.chargePercent}%` : ""}
                  {event.durationSeconds !== null ? ` · 持续 ${event.durationSeconds}s` : ""}
                </span>
              </div>
            ))}
          </div>
        )}
      </section>
    );
  }

  const current = updates?.current || {};
  const items = updates?.updates || [];
  return (
    <section className="systemInfoPanel">
      <div className="systemInfoToolbar">
        <div className="updateVersion">
          <strong>{current.productName || "macOS"} {current.productVersion || ""}</strong>
          <span>{current.buildVersion ? `Build ${current.buildVersion}` : ""}{updates?.checkedAt ? ` · 检查于 ${new Intl.DateTimeFormat("zh-CN", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" }).format(new Date(updates.checkedAt))}` : ""}</span>
        </div>
        <div className="systemInfoActions">
          <button className="secondaryButton" type="button" onClick={() => loadUpdates({ fresh: true })} disabled={loading === "updates"}>
            <RefreshCw size={14} className={loading === "updates" ? "spin" : ""} />
            <span>{loading === "updates" ? "检查中" : "重新检查"}</span>
          </button>
          <button className="secondaryButton" type="button" onClick={openUpdateSettings}>
            <ExternalLink size={14} />
            <span>打开系统设置</span>
          </button>
        </div>
      </div>
      {error && <div className="error" role="alert">{error}</div>}
      {message && <div className="notice" role="status">{message}</div>}
      {loading === "updates" && !updates && <div className="emptyState">正在调用 softwareupdate 检查更新，macOS 首次扫描可能需要 30 秒以上…</div>}
      {updates && (
        <>
          {updates.upToDate ? (
            <div className="monitoringCalm systemInfoCalm">
              <Check size={15} />
              <div>
                <strong>已是最新版本</strong>
                <span>没有检测到可安装的更新。{updates.blocked ? "（softwareupdate 报告当前没有新软件）" : ""}</span>
              </div>
            </div>
          ) : (
            <div className="updateList">
              {items.map((item) => (
                <div className="updateRow" key={item.label}>
                  <div>
                    <strong>{item.title || item.label}</strong>
                    <span>版本 {item.version || "-"}{item.recommended ? " · 建议安装" : ""}{item.action === "restart" ? " · 需要重启" : ""}</span>
                  </div>
                  <em>{item.sizeBytes ? formatMemory(Math.round(item.sizeBytes / 1024 / 1024)) : ""}</em>
                </div>
              ))}
            </div>
          )}
          <div className="updateSettings">
            {[
              ["自动下载更新", updates.settings?.automaticDownload],
              ["自动安装 macOS 更新", updates.settings?.automaticInstallMacOS],
              ["安装安全响应", updates.settings?.criticalUpdateInstall],
              ["为系统数据文件安装更新", updates.settings?.configDataInstall]
            ].map(([label, enabled]) => (
              <span className={enabled ? "on" : "off"} key={label}>
                <Check size={13} />
                {label}：{enabled ? "已开启" : "未开启"}
              </span>
            ))}
          </div>
          {updates.output && <LogBlock title="softwareupdate 输出" value={updates.output} />}
        </>
      )}
    </section>
  );
}

function SystemSettingsManager({ selectedId, onSelect }) {
  const [busyId, setBusyId] = useState("");
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const selectedSetting = SYSTEM_SETTING_CARDS.find(({ id }) => id === selectedId) || null;

  useEffect(() => {
    setMessage("");
    setError("");
  }, [selectedId]);

  async function openSetting(setting) {
    setBusyId(setting.id);
    setMessage("");
    setError("");
    try {
      await api.post("/api/system-settings/open", { id: setting.id });
      setMessage(`已打开「${setting.label}」系统设置`);
    } catch (err) {
      setError(err.message);
    } finally {
      setBusyId("");
    }
  }

  if (selectedSetting) {
    const Icon = selectedSetting.icon;
    const busy = busyId === selectedSetting.id;
    return (
      <section className="systemSettingsPanel systemSettingDetailPanel">
        <button className="systemSettingsBackButton" type="button" onClick={() => onSelect(null)}>
          <ArrowLeft size={15} />
          <span>所有系统设置</span>
        </button>
        <div className="systemSettingDetailHeader">
          <span className="systemSettingDetailIcon"><Icon size={23} /></span>
          <div className="systemSettingDetailTitle">
            <span>系统设置预览</span>
            <h2>{selectedSetting.label}</h2>
            <p>{selectedSetting.description}</p>
          </div>
          <button
            className="secondaryButton systemSettingOpenButton"
            onClick={() => openSetting(selectedSetting)}
            disabled={Boolean(busyId)}
          >
            {busy ? <RefreshCw size={15} className="spin" /> : <ExternalLink size={15} />}
            <span>{busy ? "正在打开" : "在系统设置中打开"}</span>
          </button>
        </div>
        {error && <div className="error systemSettingsFeedback" role="alert">{error}</div>}
        {message && <div className="notice systemSettingsFeedback" role="status">{message}</div>}
        <div className="systemSettingScopeHeader">
          <strong>可管理内容</strong>
          <span>{selectedSetting.items.length} 项</span>
        </div>
        <div className="systemSettingItems">
          {selectedSetting.items.map(([label, description]) => (
            <div className="systemSettingItem" key={label}>
              <span className="systemSettingItemIcon"><Check size={14} /></span>
              <div><strong>{label}</strong><p>{description}</p></div>
            </div>
          ))}
        </div>
        <div className="systemSettingsNote"><InfoIcon size={15} /><span>{selectedSetting.note}</span></div>
      </section>
    );
  }

  return (
    <section className="systemSettingsPanel">
      <div className="systemSettingsIntro">
        <div className="systemSettingsIntroIcon"><Settings2 size={22} /></div>
        <div>
          <strong>系统策略</strong>
          <p>集中浏览常用策略的管理范围，再按需进入 macOS 原生设置。</p>
        </div>
      </div>
      {error && <div className="error systemSettingsFeedback" role="alert">{error}</div>}
      {message && <div className="notice systemSettingsFeedback" role="status">{message}</div>}
      <div className="systemSettingsGrid">
        {SYSTEM_SETTING_CARDS.map((setting) => {
          const Icon = setting.icon;
          return (
            <button className="systemSettingCard" key={setting.id} onClick={() => onSelect(setting.id)}>
              <span className="systemSettingIcon"><Icon size={19} /></span>
              <span className="systemSettingCopy"><strong>{setting.label}</strong><small>{setting.description}</small></span>
              <ChevronRight size={15} />
            </button>
          );
        })}
      </div>
      <div className="systemSettingsNote"><InfoIcon size={15} /><span>分类页展示可管理内容；更改系统策略时再进入对应的官方面板。</span></div>
    </section>
  );
}

function TaskTags({ tags }) {
  if (!tags?.length) return null;
  return (
    <span className="tagLine">
      {tags.map((tag) => (
        <em key={tag}>{tag}</em>
      ))}
    </span>
  );
}

const AGENT_PERMISSION_OPTIONS = [
  ["read", "只读", "只读取系统信息，不做任何修改"],
  ["write", "写操作", "可以执行任务、修改备注、打开系统设置"],
  ["destructive", "破坏性操作", "可以终止进程、移入废纸篓、卸载应用"]
];

const AGENT_EXAMPLES = [
  "系统现在怎么样？",
  "存储还能清出多少空间？",
  "有哪些定时任务在跑？",
  "列出内存占用最高的进程"
];

function AgentChatPanel({ data, onRefresh }) {
  const [aiStatus, setAiStatus] = useState(null);
  const [messages, setMessages] = useState([]);
  const messageSeq = useRef(0);
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [permissionLevel, setPermissionLevel] = useState("read");
  const [configLoaded, setConfigLoaded] = useState(false);
  const scrollRef = useRef(null);

  useEffect(() => {
    api.get("/api/agent/config")
      .then((config) => setPermissionLevel(config.permissionLevel || "read"))
      .catch(() => {})
      .finally(() => setConfigLoaded(true));
    api.get("/api/ai/status").then(setAiStatus).catch(() => {});
  }, []);

  useEffect(() => {
    const node = scrollRef.current;
    if (node) node.scrollTop = node.scrollHeight;
  }, [messages, busy]);

  async function changePermission(level) {
    const previous = permissionLevel;
    setPermissionLevel(level);
    setError("");
    try {
      const config = await api.post("/api/agent/config", { permissionLevel: level });
      setPermissionLevel(config.permissionLevel);
      onRefresh?.();
    } catch (err) {
      setPermissionLevel(previous);
      setError(err.message);
    }
  }

  function updateMessage(id, patch) {
    setMessages((current) => current.map((message) => {
      if (message.id !== id) return message;
      return { ...message, ...(typeof patch === "function" ? patch(message) : patch) };
    }));
  }

  async function send(text) {
    const content = String(text ?? draft).trim();
    if (!content || busy) return;
    const history = messages
      .filter((message) => !message.streaming)
      .map(({ role, content: body }) => ({ role, content: body }));
    messageSeq.current += 1;
    const userId = `u${messageSeq.current}`;
    messageSeq.current += 1;
    const assistantId = `a${messageSeq.current}`;

    setMessages((current) => [
      ...current,
      { id: userId, role: "user", content },
      { id: assistantId, role: "assistant", content: "", toolLog: [], streaming: true }
    ]);
    setDraft("");
    setBusy(true);
    setError("");

    try {
      const response = await fetch("/api/agent/chat/stream", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message: content, history, permissionLevel, sessionId: "desktop" })
      });
      if (!response.ok || !response.body) throw new Error(`HTTP ${response.status}`);

      for await (const frame of parseSseStream(response.body)) {
        const payload = frame.data || {};
        if (frame.event === "delta") {
          updateMessage(assistantId, (message) => ({ content: message.content + (payload.text || "") }));
        } else if (frame.event === "thinking") {
          updateMessage(assistantId, (message) => ({ thinking: `${message.thinking || ""}${payload.text || ""}` }));
        } else if (frame.event === "tool-start") {
          updateMessage(assistantId, (message) => ({
            toolLog: [...(message.toolLog || []), { tool: payload.tool, title: payload.title, input: payload.input }]
          }));
        } else if (frame.event === "tool-result") {
          updateMessage(assistantId, (message) => {
            const toolLog = [...(message.toolLog || [])];
            const index = toolLog.findLastIndex((entry) => entry.tool === payload.tool && !entry.finished);
            const merged = {
              ...(index >= 0 ? toolLog[index] : { tool: payload.tool }),
              title: payload.title,
              isError: payload.isError,
              durationMs: payload.durationMs,
              summary: payload.summary,
              error: payload.isError ? payload.summary : "",
              finished: true
            };
            if (index >= 0) toolLog[index] = merged;
            else toolLog.push(merged);
            return { toolLog };
          });
        } else if (frame.event === "usage") {
          updateMessage(assistantId, { usage: payload.total || payload.usage });
        } else if (frame.event === "config-required") {
          updateMessage(assistantId, { needsConfiguration: true, configReason: payload.reason });
        } else if (frame.event === "error") {
          updateMessage(assistantId, { error: payload.message, failed: true });
          setError(payload.message);
        } else if (frame.event === "final") {
          updateMessage(assistantId, (message) => ({
            content: payload.reply || message.content,
            toolLog: payload.toolLog?.length ? payload.toolLog : message.toolLog,
            source: payload.source,
            runtime: payload.runtime,
            model: payload.provider ? `${payload.provider}/${payload.model}` : message.model,
            usage: payload.usage || message.usage,
            error: payload.error || message.error,
            needsConfiguration: payload.needsConfiguration || message.needsConfiguration,
            configReason: payload.configReason || message.configReason
          }));
        }
      }
    } catch (err) {
      setError(err.message);
      updateMessage(assistantId, { content: `请求失败：${err.message}`, failed: true });
    } finally {
      updateMessage(assistantId, { streaming: false });
      setBusy(false);
    }
  }

  function onKeyDown(event) {
    if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
      event.preventDefault();
      send();
    }
  }

  const status = data.status || {};
  const allowedTools = (data.tools || []).filter((tool) => tool.allowed);
  const aiConfigured = Boolean(aiStatus?.configured);

  return (
    <section className="agentPanel agentChatPanel">
      <div className="agentHeader">
        <MessageSquare size={18} />
        <div>
          <h2>Agent 对话</h2>
          <p>直接用人话操作系统：Agent 会调用本机工具读取或修改状态，工具与页面共用同一套实现。</p>
        </div>
      </div>

      <div className="agentChatToolbar">
        <div className="agentPermissionGroup" role="group" aria-label="Agent 权限级别">
          <span>权限</span>
          {AGENT_PERMISSION_OPTIONS.map(([id, label, description]) => (
            <button
              key={id}
              type="button"
              className={permissionLevel === id ? "active" : ""}
              onClick={() => changePermission(id)}
              disabled={!configLoaded || busy}
              title={description}
              aria-pressed={permissionLevel === id}
            >
              {label}
            </button>
          ))}
        </div>
        <div className="agentChatMeta">
          <span className={`agentRuntimeBadge ${aiConfigured ? "ready" : "fallback"}`} title={aiStatus?.reason || ""}>
            {aiConfigured ? `Pi · ${aiStatus?.default?.model || "已配置"}` : "Pi 未配置 · 本地规则"}
          </span>
          <span>{allowedTools.length} / {(data.tools || []).length} 个工具可用</span>
          <button className="iconButton" type="button" onClick={() => { setMessages([]); messageSeq.current = 0; }} disabled={!messages.length || busy} title="清空对话" aria-label="清空对话">
            <Trash2 size={15} />
          </button>
        </div>
      </div>

      {permissionLevel === "destructive" && (
        <div className="agentPermissionWarning" role="status">
          <AlertTriangle size={15} />
          <span>破坏性操作已开启：Agent 可以终止进程、把文件移入废纸篓或卸载应用。请确认后再发送指令。</span>
        </div>
      )}
      {error && <div className="error agentChatFeedback" role="alert">{error}</div>}

      <div className="agentChatLog" ref={scrollRef}>
        {!messages.length && !busy && (
          <div className="agentChatEmpty">
            <Bot size={26} />
            <strong>问点什么</strong>
            <span>例如下面这些问题，Agent 会先调用工具取数，再给出结论。</span>
            <div className="agentExampleList">
              {AGENT_EXAMPLES.map((example) => (
                <button key={example} type="button" onClick={() => send(example)}>{example}</button>
              ))}
            </div>
          </div>
        )}
        {messages.map((message, index) => (
          <article className={`agentBubble ${message.role}${message.streaming ? " pending" : ""}`} key={message.id || `${message.role}-${index}`}>
            <div className="agentBubbleAvatar">{message.role === "user" ? <User size={14} /> : <Bot size={14} />}</div>
            <div className="agentBubbleBody">
              <p>
                {message.content || (message.streaming ? <><RefreshCw size={13} className="spin" /> 正在调用本机工具…</> : "")}
                {message.streaming && message.content ? <span className="agentCaret">▌</span> : null}
              </p>
              {message.toolLog?.length > 0 && (
                <div className="agentToolLog">
                  {message.toolLog.map((entry, toolIndex) => (
                    <div className={`agentToolEntry ${entry.error ? "failed" : ""}`} key={`${entry.tool}-${toolIndex}`}>
                      <Cable size={12} />
                      <strong>{entry.title || entry.tool}</strong>
                      <span>{entry.error || entry.summary}</span>
                      {entry.durationMs ? <em>{entry.durationMs} ms</em> : null}
                    </div>
                  ))}
                </div>
              )}
              {message.needsConfiguration && (
                <div className="agentBubbleNote configNeeded">
                  <AlertTriangle size={12} />
                  <span>
                    还没有可用的 AI 模型（{message.configReason || "请先在 AI 配置里设置提供方与默认模型"}），当前由本地规则回答。
                    请到「Agent 管理 &gt; AI 配置」完成配置。
                  </span>
                </div>
              )}
              {message.runtime === "pi" && message.usage && (
                <div className="agentBubbleNote tokenNote">
                  <Activity size={12} />
                  <span>
                    {message.model} · 输入 {formatTokens(message.usage.input)} / 输出 {formatTokens(message.usage.output)} tokens · {formatCost(message.usage.costUsd)}
                  </span>
                </div>
              )}
              {!message.needsConfiguration && message.source === "local-fallback" && (
                <div className="agentBubbleNote">
                  <AlertTriangle size={12} />
                  <span>本地规则模式{message.harnessError ? `：${message.harnessError}` : ""}</span>
                </div>
              )}
            </div>
          </article>
        ))}

      </div>

      <div className="agentChatComposer">
        <textarea
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={onKeyDown}
          placeholder="例如：系统现在怎么样？存储还能清出多少？（⌘/Ctrl + Enter 发送）"
          rows={2}
          disabled={busy}
        />
        <button className="primaryButton agentSendButton" type="button" onClick={() => send()} disabled={!draft.trim() || busy}>
          <Send size={15} />
          <span>{busy ? "执行中" : "发送"}</span>
        </button>
      </div>
    </section>
  );
}

const THINKING_LEVEL_LABELS = {
  off: "关闭思考",
  minimal: "最少",
  low: "低",
  medium: "中",
  high: "高",
  xhigh: "很高",
  max: "最高",
  ultra: "极限"
};

function formatTokens(value) {
  const number = Number(value) || 0;
  if (number < 1000) return String(number);
  if (number < 1_000_000) return `${(number / 1000).toFixed(number < 10_000 ? 2 : 1)}k`;
  return `${(number / 1_000_000).toFixed(2)}M`;
}

function formatCost(value) {
  const number = Number(value) || 0;
  if (number === 0) return "$0";
  if (number < 0.01) return `$${number.toFixed(6)}`;
  return `$${number.toFixed(4)}`;
}

function AiConfigPanel() {
  const [status, setStatus] = useState(null);
  const [providers, setProviders] = useState([]);
  const [models, setModels] = useState([]);
  const [usage, setUsage] = useState(null);
  const [provider, setProvider] = useState("");
  const [model, setModel] = useState("");
  const [thinkingLevel, setThinkingLevel] = useState("medium");
  const [apiKey, setApiKey] = useState("");
  const [baseUrl, setBaseUrl] = useState("");
  const [testResult, setTestResult] = useState(null);
  const [customDraft, setCustomDraft] = useState({ id: "", label: "", baseUrl: "", apiKey: "", api: "openai-completions", models: "" });
  const [customProviders, setCustomProviders] = useState([]);
  const [loading, setLoading] = useState("");
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");

  useEffect(() => {
    refresh();
  }, []);

  useEffect(() => {
    if (!provider) {
      setModels([]);
      return undefined;
    }
    let cancelled = false;
    api.get(`/api/ai/models?provider=${encodeURIComponent(provider)}`)
      .then((data) => {
        if (cancelled) return;
        setModels(data.providers?.[0]?.models || []);
      })
      .catch((err) => { if (!cancelled) setError(err.message); });
    return () => { cancelled = true; };
  }, [provider]);

  async function refresh() {
    setLoading("refresh");
    setError("");
    try {
      const [nextStatus, providerData, usageData, config] = await Promise.all([
        api.get("/api/ai/status"),
        api.get("/api/ai/providers"),
        api.get("/api/ai/usage"),
        api.get("/api/ai/config")
      ]);
      setStatus(nextStatus);
      setUsage(usageData);
      const list = providerData.providers || [];
      setProviders(list);
      const defaults = config.default || {};

      // Keep the user's current selection across refreshes: saving a credential
      // must not snap the panel back to the first provider in the catalog.
      const keepSelection = provider && list.some((entry) => entry.id === provider);
      const nextProvider = keepSelection ? provider : defaults.provider || list[0]?.id || "";
      setProvider(nextProvider);
      if (!keepSelection) {
        setModel(defaults.provider === nextProvider ? defaults.model || "" : "");
      } else if (!model && defaults.provider === nextProvider) {
        setModel(defaults.model || "");
      }
      setThinkingLevel(defaults.thinkingLevel || "medium");
      setApiKey("");
      setBaseUrl(config.providers?.[nextProvider]?.baseUrl || "");
      setCustomProviders(config.customProviders || []);
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading("");
    }
  }

  const activeProvider = providers.find((entry) => entry.id === provider) || null;

  async function saveCredential() {
    if (!provider) return;
    setLoading("credential");
    setError("");
    setMessage("");
    try {
      const payload = {};
      if (apiKey.trim()) payload.apiKey = apiKey.trim();
      if (baseUrl.trim()) payload.baseUrl = baseUrl.trim();
      await api.put(`/api/ai/config/provider/${encodeURIComponent(provider)}`, payload);
      setApiKey("");
      setMessage(`已保存 ${provider} 的配置。`);
      await refresh();
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading("");
    }
  }

  async function clearCredential() {
    if (!provider) return;
    if (!window.confirm(`确认清除 ${provider} 保存的 API Key？`)) return;
    setLoading("credential");
    setError("");
    try {
      await api.del(`/api/ai/config/provider/${encodeURIComponent(provider)}`);
      setMessage(`已清除 ${provider} 的凭证。`);
      await refresh();
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading("");
    }
  }

  async function saveDefault() {
    setLoading("default");
    setError("");
    setMessage("");
    try {
      await api.put("/api/ai/config/default", { provider, model, thinkingLevel });
      setMessage(`默认模型已设为 ${provider} / ${model}。`);
      await refresh();
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading("");
    }
  }

  function updateCustom(field, value) {
    setCustomDraft((current) => ({ ...current, [field]: value }));
  }

  async function saveCustomProviders(nextList) {
    setLoading("custom");
    setError("");
    setMessage("");
    try {
      const config = await api.put("/api/ai/config/custom", { providers: nextList });
      setCustomProviders(config.customProviders || []);
      await refresh();
      return true;
    } catch (err) {
      setError(err.message);
      return false;
    } finally {
      setLoading("");
    }
  }

  async function addCustomProvider() {
    const id = customDraft.id.trim();
    const baseUrl = customDraft.baseUrl.trim();
    if (!id || !baseUrl) {
      setError("自定义提供方需要填写 ID 与 Base URL");
      return;
    }
    if (!/^[a-z0-9][a-z0-9-]*$/i.test(id)) {
      setError("ID 只能包含字母、数字与连字符");
      return;
    }
    if (customProviders.some((entry) => entry.id === id) || providers.some((entry) => entry.id === id)) {
      setError(`提供方 ${id} 已存在`);
      return;
    }
    const models = customDraft.models
      .split(/[\n,]/)
      .map((model) => model.trim())
      .filter(Boolean)
      .map((model) => ({ id: model }));
    const next = [
      ...customProviders.map(({ credential, hasKey, keyPreview, ...entry }) => entry),
      {
        id,
        label: customDraft.label.trim() || id,
        baseUrl,
        apiKey: customDraft.apiKey.trim(),
        api: customDraft.api,
        models
      }
    ];
    if (await saveCustomProviders(next)) {
      setCustomDraft({ id: "", label: "", baseUrl: "", apiKey: "", api: "openai-completions", models: "" });
      setMessage(`已添加自定义提供方 ${id}，可在上方选择并设置默认模型。`);
    }
  }

  async function removeCustomProvider(id) {
    if (!window.confirm(`确认移除自定义提供方 ${id}？`)) return;
    const next = customProviders
      .filter((entry) => entry.id !== id)
      .map(({ credential, hasKey, keyPreview, ...entry }) => entry);
    if (await saveCustomProviders(next)) setMessage(`已移除自定义提供方 ${id}。`);
  }

  async function runTest({ live }) {
    setLoading(live ? "live" : "test");
    setError("");
    setTestResult(null);
    try {
      setTestResult(await api.post("/api/ai/test", { provider, model, live }));
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading("");
    }
  }

  const configured = Boolean(status?.configured);

  return (
    <section className="agentPanel aiConfigPanel">
      <div className="agentHeader">
        <Settings2 size={18} />
        <div>
          <h2>AI 配置</h2>
          <p>对话由 Pi 运行时驱动（pi-agent-core 的 Agent 循环 + pi-ai 的模型接入）。在这里手动配置提供方、凭证与默认模型。</p>
        </div>
      </div>

      {error && <div className="error agentChatFeedback" role="alert">{error}</div>}
      {message && <div className="notice agentChatFeedback" role="status">{message}</div>}

      <div className="aiStatusRow">
        <div className={`aiStatusBadge ${configured ? "ready" : "unconfigured"}`}>
          {configured ? <Check size={14} /> : <AlertTriangle size={14} />}
          <span>{configured ? "已配置" : "尚未配置"}</span>
        </div>
        <div className="aiStatusMeta">
          <span>运行时 {status?.runtimeVersion || "pi"}</span>
          <span>{status?.providerCount ?? 0} 个提供方</span>
          <span>{status?.modelCount ?? 0} 个可用模型</span>
          {!configured && status?.reason ? <em>{status.reason}</em> : null}
        </div>
        <button className="iconButton" type="button" onClick={refresh} disabled={Boolean(loading)} title="刷新" aria-label="刷新">
          <RefreshCw size={16} className={loading === "refresh" ? "spin" : ""} />
        </button>
      </div>

      <div className="aiConfigGrid">
        <section className="aiConfigCard">
          <header>
            <KeyRound size={15} />
            <strong>提供方与凭证</strong>
          </header>
          <label className="aiField">
            <span>提供方</span>
            <select value={provider} onChange={(event) => setProvider(event.target.value)}>
              {providers.map((entry) => (
                <option key={entry.id} value={entry.id}>
                  {entry.name}（{entry.modelCount} 个模型）{entry.credential?.configured ? " · 已配置" : ""}
                </option>
              ))}
            </select>
          </label>
          <div className="aiCredentialLine">
            <span className={`aiCredentialDot ${activeProvider?.credential?.configured ? "on" : "off"}`} />
            <span>
              {activeProvider?.credential?.configured
                ? activeProvider.credential.source === "manual"
                  ? `已保存 Key：${activeProvider.credential.preview}`
                  : `使用环境变量 ${activeProvider.credential.envVar || activeProvider.credential.source}`
                : "尚未配置凭证"}
            </span>
          </div>
          <label className="aiField">
            <span>API Key</span>
            <input
              type="password"
              value={apiKey}
              onChange={(event) => setApiKey(event.target.value)}
              placeholder={activeProvider?.credential?.configured ? "已保存，留空则不修改" : "粘贴 API Key"}
              autoComplete="off"
            />
          </label>
          <label className="aiField">
            <span>Base URL（可选，自建或代理网关）</span>
            <input value={baseUrl} onChange={(event) => setBaseUrl(event.target.value)} placeholder="https://…/v1" />
          </label>
          <div className="aiConfigActions">
            <button className="primaryButton" type="button" onClick={saveCredential} disabled={Boolean(loading) || !provider}>
              <Save size={14} /><span>{loading === "credential" ? "保存中" : "保存凭证"}</span>
            </button>
            <button className="secondaryButton" type="button" onClick={clearCredential} disabled={Boolean(loading) || !activeProvider?.credential?.configured}>
              <Trash2 size={14} /><span>清除</span>
            </button>
          </div>
        </section>

        <section className="aiConfigCard">
          <header>
            <Brain size={15} />
            <strong>默认模型</strong>
          </header>
          <label className="aiField">
            <span>模型</span>
            <select value={model} onChange={(event) => setModel(event.target.value)}>
              <option value="">请选择模型</option>
              {models.map((entry) => (
                <option key={entry.id} value={entry.id}>
                  {entry.name}{entry.reasoning ? " · 推理" : ""}{entry.contextWindow ? ` · ${Math.round(entry.contextWindow / 1000)}k 上下文` : ""}
                </option>
              ))}
            </select>
          </label>
          <label className="aiField">
            <span>思考等级</span>
            <select value={thinkingLevel} onChange={(event) => setThinkingLevel(event.target.value)}>
              {Object.entries(THINKING_LEVEL_LABELS).map(([value, label]) => (
                <option key={value} value={value}>{label}</option>
              ))}
            </select>
          </label>
          <div className="aiConfigActions">
            <button className="primaryButton" type="button" onClick={saveDefault} disabled={Boolean(loading) || !provider || !model}>
              <Save size={14} /><span>{loading === "default" ? "保存中" : "设为默认"}</span>
            </button>
            <button className="secondaryButton" type="button" onClick={() => runTest({ live: false })} disabled={Boolean(loading) || !provider}>
              <ShieldCheck size={14} /><span>{loading === "test" ? "检查中" : "检查凭证"}</span>
            </button>
            <button className="secondaryButton" type="button" onClick={() => runTest({ live: true })} disabled={Boolean(loading) || !provider || !model} title="会向提供方发送一次极小的真实请求">
              <Activity size={14} /><span>{loading === "live" ? "请求中" : "实测连通"}</span>
            </button>
          </div>
          {testResult && (
            <div className={`aiTestResult ${testResult.ok ? "ok" : "bad"}`}>
              {testResult.ok ? <Check size={14} /> : <AlertTriangle size={14} />}
              <span>
                {testResult.ok ? "检查通过" : `失败：${testResult.reason || "未知原因"}`}
                {testResult.live ? ` · 实测耗时 ${testResult.latencyMs} ms` : ""}
                {testResult.authSource ? ` · 凭证来源 ${testResult.authSource}` : ""}
              </span>
            </div>
          )}
        </section>

        <section className="aiConfigCard">
          <header>
            <Cable size={15} />
            <strong>自定义提供方</strong>
          </header>
          <p className="aiCardHint">接入任意 OpenAI 兼容网关（LiteLLM、One API、Ollama、公司内网代理等）。</p>
          <div className="aiCustomGrid">
            <label className="aiField">
              <span>ID</span>
              <input value={customDraft.id} onChange={(event) => updateCustom("id", event.target.value)} placeholder="my-gateway" />
            </label>
            <label className="aiField">
              <span>显示名称</span>
              <input value={customDraft.label} onChange={(event) => updateCustom("label", event.target.value)} placeholder="公司网关" />
            </label>
          </div>
          <label className="aiField">
            <span>Base URL</span>
            <input value={customDraft.baseUrl} onChange={(event) => updateCustom("baseUrl", event.target.value)} placeholder="https://gateway.example.com/v1" />
          </label>
          <label className="aiField">
            <span>API Key（可选）</span>
            <input type="password" value={customDraft.apiKey} onChange={(event) => updateCustom("apiKey", event.target.value)} autoComplete="off" placeholder="网关通常也需要 Key" />
          </label>
          <div className="aiCustomGrid">
            <label className="aiField">
              <span>协议</span>
              <select value={customDraft.api} onChange={(event) => updateCustom("api", event.target.value)}>
                <option value="openai-completions">OpenAI Chat Completions</option>
                <option value="openai-responses">OpenAI Responses</option>
                <option value="anthropic-messages">Anthropic Messages</option>
              </select>
            </label>
            <label className="aiField">
              <span>模型 ID（每行一个，可留空）</span>
              <textarea value={customDraft.models} onChange={(event) => updateCustom("models", event.target.value)} rows={2} placeholder={"gpt-4o-mini\nclaude-sonnet"} />
            </label>
          </div>
          <div className="aiConfigActions">
            <button className="primaryButton" type="button" onClick={addCustomProvider} disabled={Boolean(loading)}>
              <Plus size={14} /><span>{loading === "custom" ? "保存中" : "添加提供方"}</span>
            </button>
          </div>
          {customProviders.length > 0 && (
            <div className="aiUsageList">
              {customProviders.map((entry) => (
                <div key={entry.id}>
                  <strong>{entry.label || entry.id}</strong>
                  <span>{entry.id} · {entry.api} · {entry.models.length} 个模型 · {entry.hasKey ? `Key ${entry.keyPreview}` : "无 Key"}</span>
                  <button className="iconButton" type="button" onClick={() => removeCustomProvider(entry.id)} title="移除" aria-label={`移除 ${entry.id}`}>
                    <Trash2 size={14} />
                  </button>
                </div>
              ))}
            </div>
          )}
        </section>

        <section className="aiConfigCard">
          <header>
            <BarChart3 size={15} />
            <strong>用量与成本</strong>
          </header>
          <div className="aiUsageTotals">
            <div><span>对话轮次</span><strong>{usage?.turns ?? 0}</strong></div>
            <div><span>输入 tokens</span><strong>{formatTokens(usage?.inputTokens)}</strong></div>
            <div><span>输出 tokens</span><strong>{formatTokens(usage?.outputTokens)}</strong></div>
            <div><span>累计成本</span><strong>{formatCost(usage?.costUsd)}</strong></div>
          </div>
          {(usage?.byModel || []).length > 0 ? (
            <div className="aiUsageList">
              {usage.byModel.slice(0, 6).map((entry) => (
                <div key={`${entry.provider}/${entry.model}`}>
                  <strong>{entry.model}</strong>
                  <span>{entry.provider} · {entry.turns} 轮 · {formatTokens(entry.inputTokens + entry.outputTokens)} tokens</span>
                  <em>{formatCost(entry.costUsd)}</em>
                </div>
              ))}
            </div>
          ) : (
            <div className="emptyState">还没有用量记录。发起一次对话后这里会显示 token 与成本。</div>
          )}
          <div className="systemInfoNote">
            <InfoIcon size={15} />
            <span>凭证保存在 ~/.config/device-operate/ai.json（权限 0600），界面只显示掩码；环境变量中的 Key 同样会被识别，但不会写入文件。</span>
          </div>
        </section>
      </div>
    </section>
  );
}

function AgentManager({ view, data, onRefresh }) {
  const status = data.status || {};
  const currentSkill = data.skills[0];
  if (view === "chat") {
    return <AgentChatPanel data={data} onRefresh={onRefresh} />;
  }
  if (view === "tools") {
    return (
      <section className="agentPanel">
        <div className="agentHeader">
          <Cable size={18} />
          <div>
            <h2>MCP Tools</h2>
            <p>这些工具由本机 Express 服务内置提供，可被 harness agent 调用，也和页面操作保持同一套逻辑。</p>
          </div>
        </div>
        <div className="toolGrid">
          {data.tools.map((tool) => (
            <article className="toolCard" key={tool.name}>
              <div>
                <strong>{tool.title}</strong>
                <code>{tool.name}</code>
              </div>
              <p>{tool.description}</p>
              <div className="miniTags">
                <span>{tool.annotations?.readOnlyHint ? "只读" : "可写"}</span>
                {tool.annotations?.destructiveHint && <span>危险操作</span>}
                {tool.annotations?.idempotentHint && <span>幂等</span>}
              </div>
            </article>
          ))}
        </div>
      </section>
    );
  }

  if (view === "skills") {
    return (
      <section className="agentPanel">
        <div className="agentHeader">
          <Sparkles size={18} />
          <div>
            <h2>内置 Skills</h2>
            <p>系统任务识别规则被打包成内置 skill，供 AI 备注和后续 Agent 流程复用。</p>
          </div>
        </div>
        <div className="skillLayout">
          <div className="skillList">
            {data.skills.map((skill) => (
              <div className="skillRow" key={skill.name}>
                <strong>{skill.name}</strong>
                <span>{skill.description}</span>
                <TaskTags tags={[skill.category, skill.source]} />
              </div>
            ))}
          </div>
          <LogBlock title={currentSkill?.path || "SKILL.md"} value={currentSkill?.content || "暂无内置 skill"} />
        </div>
      </section>
    );
  }

  if (view === "model") {
    return <AiConfigPanel />;
  }

  return (
    <section className="agentPanel">
      <div className="agentHeader">
        <Bot size={18} />
        <div>
          <h2>Harness Agent</h2>
          <p>面向“系统任务理解”的轻量 Agent：读取任务详情，调用内置 skill，产出别名、备注和标签。</p>
        </div>
      </div>
      <div className="overviewGrid">
        <div className="overviewTile">
          <span>Tools</span>
          <strong>{status.tools ?? data.tools.length}</strong>
        </div>
        <div className="overviewTile">
          <span>Skills</span>
          <strong>{status.skills ?? data.skills.length}</strong>
        </div>
        <div className="overviewTile wide">
          <span>运行模式</span>
          <strong>{status.sdk?.available ? "Claude Agent SDK" : "本地规则降级"}</strong>
        </div>
      </div>
      <div className="agentFlow">
        {["读取任务", "套用 Skill", "调用 Tools", "写入备注"].map((step, index) => (
          <div key={step}>
            <span>{index + 1}</span>
            <strong>{step}</strong>
          </div>
        ))}
      </div>
    </section>
  );
}

function TaskDetail({ detail, selected, onRun, onSaveMetadata, onDelete, onGenerateRemark, onToggleEnabled }) {
  const [alias, setAlias] = useState("");
  const [note, setNote] = useState("");
  const [tags, setTags] = useState("");
  const [metadataMessage, setMetadataMessage] = useState("");
  const [generating, setGenerating] = useState(false);
  const [toggling, setToggling] = useState(false);
  const [serviceMessage, setServiceMessage] = useState("");

  useEffect(() => {
    setAlias(detail?.alias || "");
    setNote(detail?.note || "");
    setTags(detail?.tags?.join(", ") || "");
    setMetadataMessage("");
    setServiceMessage("");
  }, [detail?.id, detail?.alias, detail?.note, detail?.tags?.join("\u0000")]);

  if (!selected) {
    return <section className="detailPanel empty">暂无任务</section>;
  }
  const stdout = detail?.stdout || "";
  const stderr = detail?.stderr || "";
  const cronLogs = detail?.logs || {};
  return (
    <section className="detailPanel">
      <div className="detailTitle">
        <div>
          <div className="detailBadges">
            <TaskBadge type={selected.type} />
            <TaskStatus task={detail || selected} />
          </div>
          <h2>{detail?.alias || selected.alias || detail?.name || selected.name}</h2>
          {detail?.alias && <p className="subName">{detail.name}</p>}
          <TaskTags tags={detail?.tags} />
        </div>
        <div className="detailActions">
          <button
            className="secondaryButton"
            onClick={async () => {
              setGenerating(true);
              setMetadataMessage("");
              try {
                const remark = await onGenerateRemark();
                setAlias(remark.alias || "");
                setNote(remark.note || "");
                setTags(Array.isArray(remark.tags) ? remark.tags.join(", ") : remark.tags || "");
                setMetadataMessage(remark.source === "claude-agent-sdk" ? "AI 备注已生成" : "已用本地规则生成");
              } catch {
                setMetadataMessage("生成失败");
              } finally {
                setGenerating(false);
              }
            }}
            disabled={!detail || generating}
          >
            <Sparkles size={16} />
            <span>{generating ? "生成中" : "AI 备注"}</span>
          </button>
          <button
            className={`secondaryButton serviceToggle ${detail?.disabled ? "enable" : "disable"}`}
            onClick={async () => {
              const nextEnabled = Boolean(detail?.disabled);
              if (
                detail?.scope === "System LaunchDaemons" &&
                !window.confirm(`${nextEnabled ? "启用" : "禁用"}系统级任务需要 macOS 管理员授权，是否继续？`)
              ) {
                return;
              }
              setToggling(true);
              setServiceMessage("");
              try {
                const updated = await onToggleEnabled(nextEnabled);
                setServiceMessage(nextEnabled ? (updated.loaded ? "任务已启用并加载" : "任务已启用，等待系统加载") : "任务已禁用");
              } catch {
                setServiceMessage("状态更新失败");
              } finally {
                setToggling(false);
              }
            }}
            disabled={!detail || toggling || detail.status === "error"}
          >
            {toggling ? (
              <RefreshCw size={16} className="spin" />
            ) : detail?.disabled ? (
              <Power size={16} />
            ) : (
              <PowerOff size={16} />
            )}
            <span>{toggling ? "处理中" : detail?.disabled ? "启用任务" : "禁用任务"}</span>
          </button>
          <button className="primaryButton" onClick={onRun} disabled={!detail || detail.disabled || detail.running}>
            <Zap size={16} />
            <span>{detail?.running ? "执行中" : "立即执行"}</span>
          </button>
          <button className="dangerButton" onClick={onDelete} disabled={!detail || (detail.type === "launchd" && detail.scope !== "User LaunchAgents")}>
            <Trash2 size={16} />
            <span>删除</span>
          </button>
        </div>
      </div>

      {serviceMessage && <div className="serviceFeedback" role="status">{serviceMessage}</div>}

      <div className="metadataEditor">
        <Field label="别名" value={alias} onChange={setAlias} />
        <Field label="标签（逗号分隔）" value={tags} onChange={setTags} />
        <Field label="备注" value={note} onChange={setNote} />
        <button
          className="secondaryButton"
          onClick={async () => {
            try {
              await onSaveMetadata({ alias, note, tags });
              setMetadataMessage("已保存");
            } catch {
              setMetadataMessage("保存失败");
            }
          }}
        >
          <Save size={16} />
          <span>保存备注</span>
        </button>
        {metadataMessage && <span className="formMessage">{metadataMessage}</span>}
      </div>

      <div className="facts">
        <Info icon={<Power size={16} />} label="任务状态" value={getTaskStatus(detail || selected).label} />
        <Info icon={<Activity size={16} />} label="运行信息" value={getTaskRuntime(detail || selected)} mono={(detail || selected)?.running} />
        <Info icon={<Clock3 size={16} />} label="计划" value={detail?.schedule || selected.schedule} />
        <Info icon={<Tag size={16} />} label="别名备注" value={[detail?.alias, detail?.note].filter(Boolean).join(" · ") || "-"} />
        <Info icon={<ListRestart size={16} />} label="范围" value={detail?.scope || (detail?.type === "cron" ? "User Crontab" : "-")} />
        <Info icon={<Terminal size={16} />} label="命令" value={detail?.command || selected.command} mono />
        <Info icon={<FileText size={16} />} label="来源" value={detail?.source || selected.source} mono />
      </div>

      {detail?.type === "launchd" && (
        <div className="logs">
          <LogBlock title={`stdout ${detail.stdoutPath || ""}`} value={stdout} />
          <LogBlock title={`stderr ${detail.stderrPath || ""}`} value={stderr} />
        </div>
      )}

      {detail?.type === "cron" && (
        <div className="logs">
          {Object.keys(cronLogs).length ? (
            Object.entries(cronLogs).map(([logPath, value]) => <LogBlock key={logPath} title={logPath} value={value} />)
          ) : (
            <LogBlock title="日志" value="该 cron 命令没有检测到重定向日志路径。" />
          )}
        </div>
      )}
    </section>
  );
}

function Info({ icon, label, value, mono }) {
  return (
    <div className="info">
      <span>{icon}</span>
      <div>
        <label>{label}</label>
        <p className={mono ? "mono" : ""}>{value || "-"}</p>
      </div>
    </div>
  );
}

function LogBlock({ title, value }) {
  return (
    <div className="logBlock">
      <div className="logTitle">{title}</div>
      <pre>{value || "暂无日志"}</pre>
    </div>
  );
}

function TaskCreateModal({ onCreated, onClose }) {
  const [type, setType] = useState("launchd");
  const [form, setForm] = useState({
    label: "com.local.task",
    command: "",
    hour: "9",
    minute: "0",
    schedule: "0 9 * * *"
  });
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");

  useEffect(() => {
    function handleKeyDown(event) {
      if (event.key === "Escape" && !busy) onClose();
    }
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [busy, onClose]);

  function update(key, value) {
    setForm((current) => ({ ...current, [key]: value }));
  }

  async function submit(event) {
    event.preventDefault();
    setBusy(true);
    setMessage("");
    try {
      if (type === "launchd") {
        await api.post("/api/tasks/launchd", {
          label: form.label,
          command: form.command,
          hour: Number(form.hour),
          minute: Number(form.minute)
        });
      } else {
        await api.post("/api/tasks/cron", {
          schedule: form.schedule,
          command: form.command
        });
      }
      await onCreated();
      onClose();
    } catch (err) {
      setMessage(err.message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div
      className="modalBackdrop"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget && !busy) onClose();
      }}
    >
      <section className="taskModal" role="dialog" aria-modal="true" aria-labelledby="create-task-title">
        <header className="modalHeader">
          <div className="modalTitle">
            <span className="modalTitleIcon">
              <Plus size={17} />
            </span>
            <h2 id="create-task-title">新增系统任务</h2>
          </div>
          <button className="iconButton modalClose" type="button" onClick={onClose} disabled={busy} aria-label="关闭" title="关闭">
            <X size={17} />
          </button>
        </header>

        <form onSubmit={submit}>
          <div className="fieldRow">
            <label>类型</label>
            <div className="segmented small">
              <button type="button" className={type === "launchd" ? "selected" : ""} onClick={() => setType("launchd")}>
                Launch
              </button>
              <button type="button" className={type === "cron" ? "selected" : ""} onClick={() => setType("cron")}>
                Cron
              </button>
            </div>
          </div>
          {type === "launchd" ? (
            <>
              <Field
                className="taskLabelField"
                label="Label"
                value={form.label}
                onChange={(value) => update("label", value)}
                autoFocus
              />
              <div className="twoCols timingField">
                <Field label="Hour" type="number" value={form.hour} onChange={(value) => update("hour", value)} />
                <Field label="Minute" type="number" value={form.minute} onChange={(value) => update("minute", value)} />
              </div>
            </>
          ) : (
            <Field
              className="scheduleField"
              label="Cron"
              value={form.schedule}
              onChange={(value) => update("schedule", value)}
              autoFocus
            />
          )}
          <Field className="commandField" label="Command" value={form.command} onChange={(value) => update("command", value)} />

          <div className="modalFooter">
            {message ? <span className="formMessage" role="alert">{message}</span> : <span />}
            <div>
              <button className="secondaryButton" type="button" onClick={onClose} disabled={busy}>
                取消
              </button>
              <button className="primaryButton" disabled={busy}>
                <ListRestart size={16} />
                <span>{busy ? "写入中" : "新增任务"}</span>
              </button>
            </div>
          </div>
        </form>
      </section>
    </div>
  );
}

function Field({ className = "", label, value, onChange, type = "text", autoFocus = false }) {
  return (
    <label className={`field ${className}`.trim()}>
      <span>{label}</span>
      <input type={type} value={value} onChange={(event) => onChange(event.target.value)} autoFocus={autoFocus} />
    </label>
  );
}

createRoot(document.getElementById("root")).render(<App />);
