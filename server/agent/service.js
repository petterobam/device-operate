// Agent conversation service: runs the harness agent with tool calling and
// falls back to a deterministic local engine when the Claude Agent SDK is
// unavailable. Both paths execute the same tool catalog.

import readline from "node:readline";

const DEFAULT_HISTORY = 12;
const MAX_MESSAGE_CHARS = 4000;
const HARNESS_TIMEOUT_MS = 120_000;
// A conversational turn must feel responsive; if the harness cannot answer in
// this window we hand the turn to the local engine and stop retrying it.
const HARNESS_CHAT_TIMEOUT_MS = 25_000;
const HARNESS_COOLDOWN_MS = 5 * 60_000;

const SYSTEM_PROMPT = `你是「我的 macOS」本机运维助手。你可以调用本机工具读取和修改系统状态。

规则：
1. 先调用工具获取真实数据，再基于结果回答；不要凭经验编造本机状态。
2. 回答使用简体中文，只给结论和关键数字，避免罗列原始 JSON。
3. 只读工具可直接调用。写操作与破坏性操作（终止进程、移入废纸篓、卸载应用、改任务开关）只有在用户已开启对应权限时才可调用；没有权限时说明需要开启哪一级权限，不要尝试绕过。
4. 工具返回错误时如实说明错误原因和下一步建议。
5. 涉及删除、终止、卸载时，先复述对象再执行，并在回答中说明已执行的动作。`;

function cleanMessage(value) {
  return String(value ?? "").replace(/\u0000/g, "").trim().slice(0, MAX_MESSAGE_CHARS);
}

function normalizeHistory(history, limit = DEFAULT_HISTORY) {
  if (!Array.isArray(history)) return [];
  return history
    .filter((entry) => entry && (entry.role === "user" || entry.role === "assistant") && typeof entry.content === "string")
    .slice(-limit)
    .map((entry) => ({ role: entry.role, content: entry.content.slice(0, MAX_MESSAGE_CHARS) }));
}

function permissionsOf(input = {}) {
  const level = String(input.permissionLevel || input.permissions?.level || "read");
  if (level === "destructive") return { level, write: true, destructive: true };
  if (level === "write") return { level, write: true, destructive: false };
  return { level: "read", write: false, destructive: false };
}

function joinSummary(items) {
  return items.filter(Boolean).join("；");
}

// ---------------------------------------------------------------------------
// Deterministic local engine
// ---------------------------------------------------------------------------

const NUMBER_WORDS = { 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9, 十: 10 };

function extractLimit(message, fallback = 5) {
  const digits = message.match(/(\d+)\s*(?:个|条|项|名|款)?/);
  if (digits) return Math.max(1, Math.min(20, Number(digits[1])));
  const word = message.match(/([一二两三四五六七八九十])\s*(?:个|条|项|名|款)/);
  if (word) return Math.max(1, Math.min(20, NUMBER_WORDS[word[1]] || fallback));
  return fallback;
}

function extractPids(message) {
  return [...String(message).matchAll(/(?:pid\s*|进程\s*)?(\d{2,7})\b/gi)]
    .map((match) => Number(match[1]))
    .filter((pid, index, all) => pid > 1 && all.indexOf(pid) === index)
    .slice(0, 20);
}

function looksLikeDelete(message) {
  return /(删除|清理|清掉|移到废纸篓|移入废纸篓|卸载)/.test(message);
}

const intents = [
  {
    id: "system-overview",
    test: /(系统|整机|电脑|机器).*(状态|健康|怎么样|如何|概览|总览)|(状态|健康).*(怎么样|如何)|cpu|内存|swap|负载|温度|磁盘空间不够|电脑卡|变慢/i,
    tools: () => ["system_monitor_overview"],
    reply: (results) => `当前系统状态：${results.system_monitor_overview?.summary || "读取失败"}。`
  },
  {
    id: "storage",
    test: /(存储|磁盘|硬盘|容量|空间|缓存|清理|废纸篓|大文件|占用)/,
    tools: () => ["storage_overview", "storage_cleanup_suggestions"],
    reply: (results) => joinSummary([
      `存储：${results.storage_overview?.summary || "读取失败"}`,
      `清理建议：${results.storage_cleanup_suggestions?.summary || "读取失败"}`
    ]) + "。需要我具体清理某一项时告诉我路径或建议名称。"
  },
  {
    id: "processes",
    test: /(进程|process|cpu 占用|内存占用|谁在跑|占用高)/i,
    tools: () => ["process_list"],
    reply: (results) => `进程情况：${results.process_list?.summary || "读取失败"}。`
  },
  {
    id: "battery",
    test: /(电池|电量|充电|电源|续航|低电量)/,
    tools: () => ["system_monitor_overview"],
    reply: () => "目前还没有采集电池健康与循环次数，只能读取整机资源；电池与电源采集正在后续版本补充。"
  },
  {
    id: "applications",
    test: /(应用|软件|app|安装了什么|装了哪些|应用列表)/i,
    tools: () => ["applications_list"],
    reply: (results) => `应用盘点：${results.applications_list?.summary || "读取失败"}。`
  },
  {
    id: "permissions",
    test: /(授权|权限|隐私|tcc|相机|麦克风|完全磁盘)/,
    tools: () => ["application_permissions"],
    reply: (results) => `授权情况：${results.application_permissions?.summary || "读取失败"}。`
  },
  {
    id: "login-items",
    test: /(开机启动|开机自启|登录项|启动项)/,
    tools: () => ["login_items"],
    reply: (results) => `开机启动项：${results.login_items?.summary || "读取失败"}。`
  },
  {
    id: "file-associations",
    test: /(默认打开|文件关联|用什么打开|默认应用)/,
    tools: () => ["file_associations"],
    reply: (results) => `默认打开方式：${results.file_associations?.summary || "读取失败"}。`
  },
  {
    id: "ssh",
    test: /(ssh|密钥|host\s*配置|known_hosts)/i,
    tools: () => ["ssh_state"],
    reply: (results) => `SSH 状态：${results.ssh_state?.summary || "读取失败"}。私钥内容不会在对话中返回。`
  },
  {
    id: "tasks",
    test: /(定时任务|计划任务|launchd|cron|系统任务|任务列表)/i,
    tools: () => ["system_tasks_list"],
    reply: (results) => `系统任务：${results.system_tasks_list?.summary || "读取失败"}。`
  },
  {
    id: "task-detail",
    test: /(任务详情|这个任务|任务日志|日志输出)/,
    tools: () => ["system_tasks_list"],
    reply: (results) => `先列出任务：${results.system_tasks_list?.summary || "读取失败"}。告诉我任务名或 ID，我再读取它的命令与日志。`
  },
  {
    id: "terminate",
    risk: true,
    test: /(杀掉|终止|结束|kill)/i,
    tools: (message, permissions) => {
      const pids = extractPids(message);
      if (!pids.length) return [];
      return pids.map((pid) => ["process_terminate", { pid }]);
    },
    note: "终止进程需要开启破坏性操作权限，且会先复述目标。",
    reply: (results, { permissions }) => {
      if (!permissions.destructive) return "终止进程属于破坏性操作。请在对话上方把权限切到「破坏性操作」后重试。";
      if (!results.process_terminate) return "没有从消息里识别出要终止的 PID，请用“终止进程 12345”这样的格式。";
      return `已执行：${results.process_terminate.summary}。`;
    }
  },
  {
    id: "trash",
    risk: true,
    test: /(移入废纸篓|移到废纸篓|删掉|删除文件)/,
    tools: (message) => {
      const target = message.match(/(~?\/[\w./\u4e00-\u9fa5-]+)/);
      return target ? [["storage_trash_item", { path: target[1] }]] : [];
    },
    note: "移入废纸篓需要开启破坏性操作权限。",
    reply: (results, { permissions }) => {
      if (!permissions.destructive) return "移入废纸篓属于破坏性操作。请在对话上方把权限切到「破坏性操作」后重试。";
      if (!results.storage_trash_item) return "没有识别出要删除的绝对路径，请提供完整路径后重试。";
      return `已执行：${results.storage_trash_item.summary}。`;
    }
  }
];

function selectIntents(message) {
  const specific = intents.filter((intent) => intent.test.test(message) && intent.risk);
  if (specific.length) return specific;
  return intents.filter((intent) => intent.test.test(message));
}

export function plainFallbackReply(tools, permissions) {
  const readable = tools.list(permissions).slice(0, 8).map((tool) => tool.title);
  return `本地 Agent 引擎连接不上（Claude Agent SDK 不可用），已降级为规则模式。我可以直接读取：${readable.join("、")}。试试“系统现在怎么样”“存储还能清多少”“有哪些定时任务”。`;
}

async function runLocalEngine({ tools, permissions, message, onEvent }) {
  const matched = selectIntents(message);
  if (!matched.length) {
    const reply = plainFallbackReply(tools, permissions);
    await onEvent?.({ type: "final", reply, source: "local-fallback" });
    return { reply, toolLog: [], source: "local-fallback" };
  }

  const toolLog = [];
  const results = {};
  for (const intent of matched.slice(0, 2)) {
    const planned = intent.tools(message, permissions) || [];
    for (const plan of planned) {
      const [name, input] = Array.isArray(plan) ? plan : [plan, {}];
      if (!tools.has(name)) continue;
      const tool = tools.get(name);
      if (["write", "destructive"].includes(tool.risk) && !permissions.write) {
        results[name] = { ok: false, summary: `${tool.title}需要写操作权限` };
        continue;
      }
      try {
        const result = await tools.execute(name, input, { permissions, onEvent });
        results[name] = result;
        toolLog.push({ tool: name, title: result.title, risk: result.risk, input, summary: result.summary, durationMs: result.durationMs });
      } catch (error) {
        results[name] = { ok: false, summary: error.message };
        toolLog.push({ tool: name, title: tool.title, risk: tool.risk, input, error: error.message });
      }
    }
  }

  const primary = matched.find((intent) => (intent.tools(message, permissions) || []).length) || matched[0];
  let reply;
  try {
    reply = primary.reply(results, { permissions });
  } catch (error) {
    reply = `处理失败：${error.message}`;
  }
  if (primary.note && !permissions.destructive) {
    reply = `${reply} ${primary.note}`;
  }
  const detailLines = toolLog
    .filter((entry) => !entry.error)
    .map((entry) => `· ${entry.title}：${entry.summary}`)
    .join("\n");
  if (detailLines && matched.length > 1) {
    reply = `${reply}\n${detailLines}`;
  }
  await onEvent?.({ type: "final", reply, source: "local-fallback" });
  return { reply, toolLog, source: "local-fallback" };
}

// ---------------------------------------------------------------------------
// Harness agent engine
// ---------------------------------------------------------------------------

function runHarness(options) {
  const { runProcess, harness, permissions, message, history, onEvent, tools, specs } = options;
  const timeoutMs = options.timeoutMs || HARNESS_TIMEOUT_MS;
  return new Promise((resolve, reject) => {
    const child = runProcess({
      command: harness.python,
      args: [harness.script],
      timeoutMs
    });
    const toolLog = [];
    let final = null;
    let settled = false;

    const finish = (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) reject(error);
      else resolve({ reply: final?.reply || "", toolLog, source: "claude-agent-sdk" });
    };

    const timer = setTimeout(() => {
      try { child.kill(); } catch { /* already gone */ }
      finish(new Error(`Agent harness 超时（${Math.round(timeoutMs / 1000)} 秒）`));
    }, timeoutMs);

    child.on("error", finish);
    child.on("exit", (code) => {
      if (settled) return;
      if (final) return finish();
      finish(new Error(`Agent harness 退出码 ${code}`));
    });

    const lines = readline.createInterface({ input: child.stdout });
    lines.on("line", (line) => {
      const trimmed = line.trim();
      if (!trimmed) return;
      let event;
      try {
        event = JSON.parse(trimmed);
      } catch {
        return;
      }
      if (event.type === "tool-call") {
        const { requestId, tool, input } = event;
        Promise.resolve()
          .then(async () => {
            try {
              const result = await tools.execute(tool, input || {}, { permissions, onEvent });
              toolLog.push({
                tool,
                title: result.title,
                risk: result.risk,
                input,
                summary: result.summary,
                durationMs: result.durationMs
              });
              return { ok: true, result };
            } catch (error) {
              toolLog.push({ tool, risk: tools.get(tool)?.risk, input, error: error.message });
              return { ok: false, error: error.message };
            }
          })
          .then((payload) => {
            if (settled) return;
            child.stdin.write(`${JSON.stringify({ type: "tool-result", requestId, ...payload })}\n`);
          });
      } else if (event.type === "final") {
        final = { reply: String(event.reply || "") };
      } else if (event.type === "log") {
        onEvent?.({ type: "log", message: String(event.message || "") });
      } else if (event.type === "error") {
        finish(new Error(String(event.error || "Agent harness 失败")));
      }
    });

    child.stdin.write(`${JSON.stringify({
      mode: "chat",
      system: SYSTEM_PROMPT,
      permissions: { level: permissions.level, write: permissions.write, destructive: permissions.destructive },
      tools: specs,
      history,
      message
    })}\n`);
  });
}

// ---------------------------------------------------------------------------
// Public service
// ---------------------------------------------------------------------------

/**
 * @param {object} options
 * @param {object} options.tools   created by createAgentTools
 * @param {object} options.harness { python, script, available(): Promise<boolean> }
 * @param {Function} options.runProcess  (options) => ChildProcess with stdin/stdout
 */
export function createAgentConversationService({ tools, harness, runProcess, now = () => Date.now() }) {
  let harnessDownUntil = 0;
  let harnessDownReason = "";

  async function harnessReady() {
    if (now() < harnessDownUntil) return false;
    try {
      const ready = await harness.available();
      if (!ready) {
        harnessDownUntil = now() + HARNESS_COOLDOWN_MS;
        harnessDownReason = "Claude 登录不可用";
      }
      return ready;
    } catch (error) {
      harnessDownUntil = now() + HARNESS_COOLDOWN_MS;
      harnessDownReason = error.message;
      return false;
    }
  }

  async function chat(input = {}, { onEvent, localOnly = false } = {}) {
    const message = cleanMessage(input.message);
    if (!message) throw Object.assign(new Error("消息不能为空"), { status: 400 });
    const permissions = permissionsOf(input);
    const history = normalizeHistory(input.history);
    // `localOnly` skips the harness probe entirely: used when the Pi runtime is
    // unconfigured and the app only needs the deterministic rules answer.
    const available = localOnly ? false : await harnessReady();

    if (!available) {
      const local = await runLocalEngine({ tools, permissions, message, onEvent });
      return { ...local, harnessAvailable: false, harnessError: harnessDownReason || undefined };
    }

    try {
      const specs = tools.specs(permissions);
      const result = await runHarness({
        runProcess,
        harness,
        permissions,
        message,
        history,
        onEvent,
        tools,
        specs,
        timeoutMs: HARNESS_CHAT_TIMEOUT_MS
      });
      if (!result.reply.trim()) throw new Error("Agent harness 返回了空回答");
      harnessDownUntil = 0;
      return { ...result, harnessAvailable: true };
    } catch (error) {
      harnessDownUntil = now() + HARNESS_COOLDOWN_MS;
      harnessDownReason = error.message;
      const local = await runLocalEngine({ tools, permissions, message, onEvent });
      return {
        ...local,
        harnessAvailable: false,
        harnessError: error.message
      };
    }
  }

  return {
    chat,
    listTools: (permissions) => tools.list(permissions),
    resetHarnessCooldown() {
      harnessDownUntil = 0;
      harnessDownReason = "";
    },
    harnessState() {
      return { downUntil: harnessDownUntil, reason: harnessDownReason, cooling: now() < harnessDownUntil };
    }
  };
}

export { SYSTEM_PROMPT };
