// Agent tool catalog: exposes the existing local APIs to the harness agent.
//
// Every entry maps 1:1 onto an existing service method already used by the HTTP
// routes, so the agent and the UI share one implementation. `risk: "read"`
// tools are always available; `risk: "write"` tools only run when the caller
// has explicitly enabled write access for the conversation.

import path from "node:path";

const MAX_TOOL_RESULT_CHARS = 12_000;

function text(value) {
  return String(value ?? "").trim();
}

function bytes(value) {
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB", "PB"];
  const index = Math.min(units.length - 1, Math.floor(Math.log(number) / Math.log(1024)));
  const scaled = number / 1024 ** index;
  return `${scaled.toFixed(index === 0 || scaled >= 100 ? 0 : 1)} ${units[index]}`;
}

function list(values, mapper, limit = 8) {
  const items = Array.isArray(values) ? values : [];
  const shown = items.slice(0, limit).map(mapper).filter(Boolean);
  const rest = items.length - shown.length;
  return rest > 0 ? `${shown.join("；")}；等 ${items.length} 项` : shown.join("；");
}

function truncate(value, limit = MAX_TOOL_RESULT_CHARS) {
  const serialized = typeof value === "string" ? value : JSON.stringify(value ?? null);
  if (serialized.length <= limit) return serialized;
  return `${serialized.slice(0, limit)}\n…（结果已截断）`;
}

// Compact, model-friendly summaries so the agent sees the signal, not raw JSON.
const summarizers = {
  system_monitor_overview(data = {}) {
    const metrics = data.metrics || {};
    const primaryDisk = (data.disks || []).find((disk) => disk.mount === "/") || (data.disks || [])[0];
    const network = data.network?.interfaces?.find((item) => item.name === data.network?.activeInterface) || data.network?.interfaces?.[0];
    return [
      `CPU ${(metrics.cpuPercent ?? 0).toFixed?.(1) ?? metrics.cpuPercent}%`,
      `内存已用 ${(metrics.memoryPercent ?? 0).toFixed?.(1) ?? metrics.memoryPercent}%（可用 ${bytes(metrics.memoryAvailableMb * 1024 * 1024)}）`,
      `Swap ${bytes(metrics.swapUsedMb * 1024 * 1024)} / ${bytes(metrics.swapTotalMb * 1024 * 1024)}，压力 ${metrics.memoryPressure || "未知"}`,
      primaryDisk ? `系统盘 ${primaryDisk.usedPercent}% 已用（${bytes(primaryDisk.usedBytes)} / ${bytes(primaryDisk.totalBytes)}）` : "磁盘等待采样",
      network ? `网络 ${network.name} 下行 ${bytes(network.downloadBytesPerSecond)}/s、上行 ${bytes(network.uploadBytesPerSecond)}/s` : "网络等待采样",
      `进程 ${metrics.processCount ?? "-"} 个、线程 ${metrics.threadCount ?? "-"} 个`
    ].join("；");
  },
  storage_overview(data = {}) {
    const volume = data.volume || {};
    const total = volume.total ?? volume.totalBytes ?? 0;
    const used = volume.used ?? volume.usedBytes ?? 0;
    const usedPercent = volume.usedPercent ?? (total ? Math.round((used / total) * 1000) / 10 : null);
    const categories = data.categories || data.analysis?.categories || [];
    return [
      total ? `容量 ${bytes(used)} / ${bytes(total)}（已用 ${usedPercent}%，可用 ${bytes(volume.available ?? volume.availableBytes ?? Math.max(0, total - used))}）` : "容量等待采样",
      volume.fileSystem ? `文件系统 ${volume.fileSystem}${volume.solidState ? " · SSD" : ""}` : "",
      categories.length ? `分类占用：${list(categories, (item) => `${item.label || item.name} ${bytes(item.size ?? item.bytes)}`, 5)}` : ""
    ].filter(Boolean).join("；");
  },
  storage_suggestions(data) {
    const items = Array.isArray(data) ? data : data?.items || data?.suggestions || [];
    const actionable = items.filter((item) => (item.size ?? item.bytes ?? 0) > 0);
    if (!actionable.length) return `当前没有可回收的清理建议（已检查 ${items.length} 类目标）`;
    const reclaimable = actionable.reduce((total, item) => total + Number(item.size ?? item.bytes ?? 0), 0);
    return `可回收约 ${bytes(reclaimable)}，${actionable.length} 类：${list(actionable, (item) => `${item.title || item.label} ${bytes(item.size ?? item.bytes)}（${item.riskLabel || item.risk || "需确认"}）`, 8)}`;
  },
  storage_analysis(data = {}) {
    const totalBytes = data.totalBytes || data.summary?.totalBytes;
    return [
      totalBytes ? `大文件合计 ${bytes(totalBytes)}` : "",
      data.summary?.count ? `共 ${data.summary.count} 项` : "",
      list(data.items || data.files || [], (item) => `${item.name || path.basename(item.path || "")} ${bytes(item.bytes || item.size)}`, 10)
    ].filter(Boolean).join("；") || "没有扫描到大文件";
  },
  applications_list(data) {
    const items = Array.isArray(data) ? data : data?.applications || [];
    return `${items.length} 个应用：${list(items, (item) => `${item.name}${item.bundleId ? ` (${item.bundleId})` : ""}`, 10)}`;
  },
  process_list(data) {
    const items = Array.isArray(data) ? data : data?.processes || [];
    const top = [...items].sort((a, b) => (b.memoryMb || 0) - (a.memoryMb || 0)).slice(0, 8);
    return `共 ${items.length} 个进程，内存占用最高：${list(top, (item) => `${item.processName} PID ${item.pid} ${bytes((item.memoryMb || 0) * 1024 * 1024)}`, 8)}`;
  },
  tasks_list(data = {}) {
    const launchd = data.launchd || [];
    const cron = data.cron || [];
    const failing = [...launchd, ...cron].filter((task) => task.status === "failed" || task.status === "error");
    return [
      `Launchd ${launchd.length} 个、Cron ${cron.length} 个`,
      failing.length ? `异常 ${failing.length} 个：${list(failing, (task) => task.name || task.label, 6)}` : "没有异常任务",
      list([...launchd, ...cron], (task) => `${task.name || task.label || task.id}（${task.schedule || task.command || ""}）`.slice(0, 80), 8)
    ].join("；");
  },
  ssh_state(data = {}) {
    return [
      `Key ${(data.keys || []).length} 个`,
      `Host ${(data.config?.hosts || []).length} 个`,
      list(data.config?.hosts || [], (host) => host.host, 8)
    ].join("；");
  },
  application_permissions(data = {}) {
    const summary = data.summary || {};
    return `已盘点 ${summary.applications ?? (data.applications || []).length} 个应用、${summary.total ?? 0} 条授权；已允许 ${summary.granted ?? 0}、已拒绝 ${summary.denied ?? 0}、待读取 ${summary.unavailable ?? 0}。TCC 读取${data.access?.available ? "可用" : "需要完全磁盘访问权限"}。`;
  },
  file_associations(data = {}) {
    const summary = data.summary || {};
    return `已登记 ${summary.total ?? (data.types || []).length} 类文件类型，${summary.assigned ?? 0} 类已指定默认应用，${summary.missing ?? 0} 类默认应用缺失。`;
  },
  login_items(data = {}) {
    return `开机启动项 ${(data.items || []).length} 个：${list(data.items || [], (item) => item.name, 8)}`;
  },
  default(value) {
    return truncate(value, 2000);
  }
};

function serviceError(message, status = 400) {
  return Object.assign(new Error(message), { status });
}

function requireString(input, key) {
  const value = text(input?.[key]);
  if (!value) throw serviceError(`缺少必需参数 ${key}`);
  return value;
}

/**
 * Builds the agent tool catalog bound to a service context.
 * The context is supplied by server/index.js so this module never imports it.
 */
export function createAgentTools(context = {}) {
  const {
    snapshotSystem,
    storageService,
    applicationService,
    applicationPermissionService,
    fileAssociationService,
    loginItemService,
    sshService,
    systemSettingsService,
    systemMonitorService,
    listTasks,
    getTaskDetail,
    taskActions = {}
  } = context;

  const tools = [
    {
      name: "system_monitor_overview",
      title: "系统资源总览",
      description: "读取 CPU、内存、Swap、磁盘、网络与进程汇总指标。",
      risk: "read",
      summarize: summarizers.system_monitor_overview,
      inputSchema: { type: "object", properties: {}, additionalProperties: false },
      execute: async () => (context.snapshotSystem ? context.snapshotSystem() : systemMonitorService.snapshot({ includeProcesses: false }))
    },
    {
      name: "process_list",
      title: "读取进程列表",
      description: "读取正在运行的进程，含 CPU、内存、线程、用户与父子关系。",
      risk: "read",
      summarize: summarizers.process_list,
      inputSchema: { type: "object", properties: {}, additionalProperties: false },
      execute: () => applicationService.listProcesses()
    },
    {
      name: "storage_overview",
      title: "存储总览",
      description: "读取磁盘容量、已用空间、分类占用与推荐清理建议。",
      risk: "read",
      summarize: summarizers.storage_overview,
      inputSchema: { type: "object", properties: {}, additionalProperties: false },
      execute: () => storageService.getOverview({ fresh: false })
    },
    {
      name: "storage_cleanup_suggestions",
      title: "清理建议",
      description: "列出可回收的缓存、日志、备份、下载与废纸篓等清理目标。",
      risk: "read",
      summarize: summarizers.storage_suggestions,
      inputSchema: { type: "object", properties: {}, additionalProperties: false },
      execute: () => storageService.getCleanupSuggestions({ fresh: false })
    },
    {
      name: "storage_analysis",
      title: "大文件与目录占用",
      description: "读取大文件与目录占用分析结果，可指定最小体积。",
      risk: "read",
      summarize: summarizers.storage_analysis,
      inputSchema: {
        type: "object",
        properties: { minBytes: { type: "number", description: "最小文件体积（字节）" } },
        additionalProperties: false
      },
      execute: (input) => storageService.getAnalysis({ fresh: false, minBytes: Number(input?.minBytes) || undefined })
    },
    {
      name: "applications_list",
      title: "应用列表",
      description: "列出已安装应用及其体积、版本、运行状态与使用统计。",
      risk: "read",
      summarize: summarizers.applications_list,
      inputSchema: {
        type: "object",
        properties: { fresh: { type: "boolean", description: "是否强制重新扫描" } },
        additionalProperties: false
      },
      execute: (input) => applicationService.listApplications({ fresh: Boolean(input?.fresh) })
    },
    {
      name: "application_permissions",
      title: "应用授权",
      description: "读取应用隐私授权目录与当前 TCC 决策，需要完全磁盘访问权限才能看到真实状态。",
      risk: "read",
      summarize: summarizers.application_permissions,
      inputSchema: { type: "object", properties: {}, additionalProperties: false },
      execute: () => applicationPermissionService.getPermissions()
    },
    {
      name: "file_associations",
      title: "默认打开方式",
      description: "读取常见文件类型当前绑定的默认应用。",
      risk: "read",
      summarize: summarizers.file_associations,
      inputSchema: { type: "object", properties: {}, additionalProperties: false },
      execute: () => fileAssociationService.listFileAssociations()
    },
    {
      name: "login_items",
      title: "开机启动项",
      description: "读取当前用户的登录项（开机自启）列表。",
      risk: "read",
      summarize: summarizers.login_items,
      inputSchema: { type: "object", properties: {}, additionalProperties: false },
      execute: () => loginItemService.listLoginItems()
    },
    {
      name: "ssh_state",
      title: "SSH 管理状态",
      description: "读取 ~/.ssh 下的 Key 清单与 ~/.ssh/config Host 配置，不返回私钥内容。",
      risk: "read",
      summarize: summarizers.ssh_state,
      inputSchema: { type: "object", properties: {}, additionalProperties: false },
      execute: () => sshService.getState()
    },
    {
      name: "system_tasks_list",
      title: "列出系统任务",
      description: "读取 launchd 与 crontab 任务，包含已保存的别名、备注和标签。",
      risk: "read",
      summarize: summarizers.tasks_list,
      inputSchema: { type: "object", properties: {}, additionalProperties: false },
      execute: () => listTasks()
    },
    {
      name: "system_task_get_detail",
      title: "读取任务详情",
      description: "读取单个系统任务的命令、计划、来源和最近日志，并附带日志尾部输出。",
      risk: "read",
      summarize: (data = {}) => `任务 ${data.name || data.label || data.id}：${data.schedule || ""}；命令 ${text(data.command).slice(0, 120)}；状态 ${data.status || (data.enabled ? "已启用" : "已禁用")}；日志 ${(data.stdout || "").slice(-500) || "无"}`,
      inputSchema: {
        type: "object",
        required: ["type", "id"],
        properties: { type: { type: "string", enum: ["launchd", "cron"] }, id: { type: "string" } }
      },
      execute: (input) => getTaskDetail(requireString(input, "type"), requireString(input, "id"))
    },
    {
      name: "system_task_run",
      title: "立即执行任务",
      description: "立即触发一个 launchd 或 crontab 任务。属于写操作。",
      risk: "write",
      summarize: (data) => `已触发任务：${data.started || data.pid || JSON.stringify(data)}`,
      inputSchema: {
        type: "object",
        required: ["type", "id"],
        properties: { type: { type: "string", enum: ["launchd", "cron"] }, id: { type: "string" } }
      },
      execute: (input) => taskActions.run(requireString(input, "type"), requireString(input, "id"))
    },
    {
      name: "system_task_set_enabled",
      title: "启用或禁用任务",
      description: "持久启用或禁用 Launchd、Cron 任务。属于写操作。",
      risk: "write",
      summarize: (data) => `任务状态已更新：${JSON.stringify(data).slice(0, 200)}`,
      inputSchema: {
        type: "object",
        required: ["type", "id", "enabled"],
        properties: {
          type: { type: "string", enum: ["launchd", "cron"] },
          id: { type: "string" },
          enabled: { type: "boolean" }
        }
      },
      execute: (input) => taskActions.setEnabled(requireString(input, "type"), requireString(input, "id"), Boolean(input?.enabled))
    },
    {
      name: "system_task_update_metadata",
      title: "修改任务备注",
      description: "为系统任务写入别名、备注和标签。属于写操作。",
      risk: "write",
      summarize: (data) => `任务备注已更新：${data.alias || data.note || ""}`,
      inputSchema: {
        type: "object",
        required: ["type", "id"],
        properties: {
          type: { type: "string", enum: ["launchd", "cron"] },
          id: { type: "string" },
          alias: { type: "string" },
          note: { type: "string" },
          tags: { type: "array", items: { type: "string" } }
        }
      },
      execute: (input) => taskActions.updateMetadata(requireString(input, "type"), requireString(input, "id"), {
        alias: input?.alias,
        note: input?.note,
        tags: input?.tags
      })
    },
    {
      name: "system_task_generate_remark",
      title: "AI 生成备注",
      description: "调用本地 Agent harness 识别任务用途，生成别名、备注与标签，可选择直接保存。属于写操作。",
      risk: "write",
      summarize: (data = {}) => `生成结果：${data.alias || ""} ${data.note || ""} ${(data.tags || []).join("/")}`,
      inputSchema: {
        type: "object",
        required: ["type", "id"],
        properties: {
          type: { type: "string", enum: ["launchd", "cron"] },
          id: { type: "string" },
          save: { type: "boolean", default: false }
        }
      },
      execute: (input) => taskActions.generateRemark(requireString(input, "type"), requireString(input, "id"), Boolean(input?.save))
    },
    {
      name: "process_terminate",
      title: "终止进程",
      description: "向指定 PID 发送 SIGKILL 强行终止进程。属于破坏性写操作。",
      risk: "destructive",
      summarize: (data = {}) => `已终止 PID ${data.terminated || data.pid || ""}`,
      inputSchema: {
        type: "object",
        required: ["pid"],
        properties: { pid: { type: "number", description: "要终止的进程 PID" } }
      },
      execute: (input) => applicationService.terminateProcess(Number(input?.pid))
    },
    {
      name: "storage_trash_item",
      title: "移入废纸篓",
      description: "把单个文件或目录移动到废纸篓，可之后恢复。属于破坏性写操作。",
      risk: "destructive",
      summarize: (data = {}) => `已移入废纸篓：${data.path || data.trashed || ""}`,
      inputSchema: {
        type: "object",
        required: ["path"],
        properties: { path: { type: "string", description: "要移入废纸篓的绝对路径" } }
      },
      execute: (input) => storageService.trashItem(requireString(input, "path"))
    },
    {
      name: "application_uninstall",
      title: "卸载应用",
      description: "把非系统应用移动到废纸篓完成卸载。属于破坏性写操作。",
      risk: "destructive",
      summarize: (data = {}) => `已卸载应用：${data.name || data.application || ""}`,
      inputSchema: {
        type: "object",
        required: ["id"],
        properties: { id: { type: "string", description: "应用 ID" } }
      },
      execute: (input) => applicationService.uninstallApplication(requireString(input, "id"))
    },
    {
      name: "system_setting_open",
      title: "打开系统设置",
      description: "按分类打开 macOS 原生系统设置面板。属于写操作（会切换前台应用）。",
      risk: "write",
      summarize: (data = {}) => `已打开系统设置：${data.id || ""}`,
      inputSchema: {
        type: "object",
        required: ["id"],
        properties: {
          id: { type: "string", enum: ["battery", "displays", "sound", "network", "keyboard", "general"] }
        }
      },
      execute: (input) => systemSettingsService.open(requireString(input, "id"))
    }
  ];

  const byName = new Map(tools.map((tool) => [tool.name, tool]));

  function riskRank(risk) {
    if (risk === "destructive") return 3;
    if (risk === "write") return 2;
    return 1;
  }

  function isAllowed(tool, permissions = {}) {
    const level = permissions.level || (permissions.destructive ? "destructive" : permissions.write ? "write" : "read");
    const allowed = level === "destructive" ? 3 : level === "write" ? 2 : 1;
    return riskRank(tool.risk) <= allowed;
  }

  function describe(tool, permissions) {
    return {
      name: tool.name,
      title: tool.title,
      description: tool.description,
      risk: tool.risk,
      allowed: isAllowed(tool, permissions),
      inputSchema: tool.inputSchema,
      annotations: {
        readOnlyHint: tool.risk === "read",
        destructiveHint: tool.risk === "destructive",
        idempotentHint: tool.risk === "read",
        openWorldHint: false
      }
    };
  }

  return {
    list(permissions = {}) {
      return tools.filter((tool) => isAllowed(tool, permissions)).map((tool) => describe(tool, permissions));
    },
    catalog() {
      return tools.map((tool) => describe(tool, {}));
    },
    /** Raw internal entries (execute/summarize/risk) for the Pi tool bridge. */
    registry() {
      return tools;
    },
    specs(permissions = {}) {
      return tools.filter((tool) => isAllowed(tool, permissions)).map((tool) => ({
        name: tool.name,
        title: tool.title,
        description: tool.description,
        inputSchema: tool.inputSchema
      }));
    },
    has(name) {
      return byName.has(name);
    },
    /** Adds extra tools discovered at wiring time (see system-info tools). */
    register(extraTools = []) {
      for (const extra of extraTools) {
        if (!extra?.name || byName.has(extra.name)) continue;
        tools.push(extra);
        byName.set(extra.name, extra);
      }
      return tools.length;
    },
    get(name) {
      return byName.get(name) || null;
    },
    async execute(name, input = {}, { permissions = {}, onEvent } = {}) {
      const tool = byName.get(name);
      if (!tool) throw serviceError(`未知工具：${name}`, 404);
      if (!isAllowed(tool, permissions)) {
        throw serviceError(`工具「${tool.title || name}」需要${tool.risk === "destructive" ? "破坏性操作" : "写操作"}授权，请先在对话中开启对应权限`, 403);
      }
      const startedAt = Date.now();
      await onEvent?.({ type: "tool-start", tool: name, title: tool.title, input });
      try {
        const raw = await tool.execute(input);
        const summary = (tool.summarize || summarizers.default)(raw);
        const result = {
          ok: true,
          tool: name,
          title: tool.title,
          risk: tool.risk,
          summary,
          durationMs: Date.now() - startedAt,
          data: truncate(raw)
        };
        await onEvent?.({ type: "tool-result", tool: name, title: tool.title, summary, durationMs: result.durationMs });
        return result;
      } catch (error) {
        const message = error?.message || String(error);
        await onEvent?.({ type: "tool-error", tool: name, title: tool.title, error: message });
        throw error;
      }
    }
  };
}

export const AGENT_TOOL_SUMMARIES = summarizers;
