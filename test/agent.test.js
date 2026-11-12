import assert from "node:assert/strict";
import test from "node:test";
import { createAgentTools } from "../server/agent/tools.js";
import { createAgentConversationService, plainFallbackReply } from "../server/agent/service.js";

function buildContext() {
  return {
    systemMonitorService: {
      snapshot: async () => ({
        metrics: {
          cpuPercent: 12.5,
          memoryPercent: 48.2,
          memoryAvailableMb: 8192,
          swapUsedMb: 128,
          swapTotalMb: 1024,
          memoryPressure: "normal",
          processCount: 512,
          threadCount: 3200
        },
        disks: [{ mount: "/", usedPercent: 71, usedBytes: 512 * 1024 ** 3, totalBytes: 1024 * 1024 ** 3 }],
        network: { activeInterface: "en0", interfaces: [{ name: "en0", downloadBytesPerSecond: 2048, uploadBytesPerSecond: 512 }] }
      })
    },
    storageService: {
      getOverview: async () => ({ volume: { totalBytes: 10 ** 12, usedBytes: 7 * 10 ** 11, usedPercent: 70 }, cleanup: { items: [{}, {}] } }),
      getCleanupSuggestions: async () => ({ items: [{ label: "用户缓存", bytes: 1024 ** 3, path: "~/Library/Caches" }] }),
      getAnalysis: async () => ({ items: [{ name: "big.iso", path: "/tmp/big.iso", bytes: 1024 ** 4 }], summary: { count: 1 } }),
      trashItem: async (target) => ({ path: target })
    },
    applicationService: {
      listApplications: async () => [{ name: "Xcode", bundleId: "com.apple.dt.Xcode", memoryMb: 512 }],
      listProcesses: async () => [
        { pid: 100, processName: "Xcode", memoryMb: 1024 },
        { pid: 200, processName: "node", memoryMb: 256 }
      ],
      terminateProcess: async (pid) => ({ terminated: pid }),
      uninstallApplication: async (id) => ({ id })
    },
    applicationPermissionService: { getPermissions: async () => ({ access: { available: true }, applications: [], summary: { applications: 0, total: 0 } }) },
    fileAssociationService: { listFileAssociations: async () => ({ types: [], summary: { total: 0 } }) },
    loginItemService: { listLoginItems: async () => ({ items: [{ name: "Docker" }] }) },
    sshService: { getState: async () => ({ keys: [{ name: "id_ed25519" }], config: { hosts: [{ host: "github.com" }] } }) },
    systemSettingsService: { open: async (id) => ({ opened: true, id }) },
    listTasks: async () => ({ launchd: [{ id: "a", name: "同步", status: "failed" }], cron: [] }),
    getTaskDetail: async (type, id) => ({ id, type, name: "同步", command: "/bin/echo hi", stdout: "hello" }),
    taskActions: {
      run: async (type, id) => ({ started: `${type}:${id}` }),
      setEnabled: async (type, id, enabled) => ({ type, id, enabled }),
      updateMetadata: async (type, id, alias) => ({ type, id, alias }),
      generateRemark: async (type, id, save) => ({ type, id, save, alias: "同步任务" })
    }
  };
}

const readPermissions = { level: "read", write: false, destructive: false };
const destructivePermissions = { level: "destructive", write: true, destructive: true };

test("tool catalog separates read, write and destructive tools", () => {
  const tools = createAgentTools(buildContext());
  const readOnly = tools.list(readPermissions);
  const catalog = tools.catalog();
  const full = tools.list(destructivePermissions);

  assert.ok(readOnly.length >= 10, "expected a broad read-only catalog");
  assert.ok(readOnly.every((tool) => tool.risk === "read" && tool.allowed));
  assert.ok(readOnly.every((tool) => tool.annotations.readOnlyHint));
  assert.ok(readOnly.every((tool) => tool.annotations.destructiveHint === false));
  assert.ok(!readOnly.some((tool) => tool.name === "process_terminate"));
  assert.ok(!readOnly.some((tool) => tool.name === "storage_trash_item"));

  assert.ok(full.some((tool) => tool.name === "process_terminate" && tool.allowed));
  assert.ok(full.some((tool) => tool.name === "storage_trash_item" && tool.allowed));
  assert.ok(tools.specs(readPermissions).every((spec) => spec.inputSchema?.type === "object"));
  assert.equal(catalog.length, readOnly.length + 8, "catalog covers every tool regardless of permission");
});

test("read tools summarise live data instead of dumping raw JSON", async () => {
  const tools = createAgentTools(buildContext());
  const overview = await tools.execute("system_monitor_overview", {}, { permissions: readPermissions });
  assert.match(overview.summary, /CPU 12\.5%/);
  assert.match(overview.summary, /内存已用 48\.2%/);
  assert.equal(overview.risk, "read");

  const processes = await tools.execute("process_list", {}, { permissions: readPermissions });
  assert.match(processes.summary, /共 2 个进程/);
  assert.match(processes.summary, /Xcode/);
});

test("unpermitted tools are refused before execution", async () => {
  let terminated = null;
  const context = buildContext();
  context.applicationService.terminateProcess = async (pid) => {
    terminated = pid;
    return { terminated: pid };
  };
  const tools = createAgentTools(context);

  await assert.rejects(
    () => tools.execute("process_terminate", { pid: 42 }, { permissions: readPermissions }),
    /需要破坏性操作授权/
  );
  assert.equal(terminated, null);

  const result = await tools.execute("process_terminate", { pid: 42 }, { permissions: destructivePermissions });
  assert.equal(terminated, 42);
  assert.equal(result.ok, true);
});

test("local engine answers with real tool output when the harness is unavailable", async () => {
  const tools = createAgentTools(buildContext());
  const service = createAgentConversationService({
    tools,
    harness: { python: "python3", script: "harness.py", available: async () => false }
  });
  const events = [];
  const result = await service.chat({ message: "系统现在怎么样？", permissionLevel: "read" }, { onEvent: (event) => events.push(event) });

  assert.equal(result.source, "local-fallback");
  assert.equal(result.harnessAvailable, false);
  assert.match(result.reply, /当前系统状态/);
  assert.match(result.reply, /CPU 12\.5%/);
  assert.equal(result.toolLog[0].tool, "system_monitor_overview");
  assert.ok(events.some((event) => event.type === "tool-result"));
});

test("local engine refuses destructive intents until permission is granted", async () => {
  const tools = createAgentTools(buildContext());
  const service = createAgentConversationService({
    tools,
    harness: { python: "python3", script: "harness.py", available: async () => false }
  });

  const blocked = await service.chat({ message: "终止进程 4242", permissionLevel: "read" });
  assert.match(blocked.reply, /破坏性操作/);
  assert.equal(blocked.toolLog.length, 0);

  const allowed = await service.chat({ message: "终止进程 4242", permissionLevel: "destructive" });
  assert.match(allowed.reply, /已终止 PID 4242/);
  assert.equal(allowed.toolLog[0].tool, "process_terminate");
});

test("storage questions return cleanup suggestions", async () => {
  const tools = createAgentTools(buildContext());
  const service = createAgentConversationService({
    tools,
    harness: { python: "python3", script: "harness.py", available: async () => false }
  });
  const result = await service.chat({ message: "存储还能清出多少空间？", permissionLevel: "read" });
  assert.match(result.reply, /存储：/);
  assert.deepEqual(result.toolLog.map((entry) => entry.tool), ["storage_overview", "storage_cleanup_suggestions"]);
});

test("empty messages are rejected and the fallback lists available tools", async () => {
  const tools = createAgentTools(buildContext());
  const service = createAgentConversationService({
    tools,
    harness: { python: "python3", script: "harness.py", available: async () => false }
  });

  await assert.rejects(() => service.chat({ message: "   " }), /消息不能为空/);

  const reply = plainFallbackReply(tools, readPermissions);
  assert.match(reply, /本地 Agent 引擎/);
  assert.match(reply, /系统资源总览/);
});
