import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai";
import { createAiConfigStore, maskKey, normalizeConfig } from "../server/agent/ai-config.js";
import { createAiUsageLedger, summarizeUsage } from "../server/agent/ai-usage.js";
import {
  applyBaseUrl,
  buildAgentTools,
  createPiRuntime,
  normalizePermissionLevel,
  permissionAllows,
  riskRank
} from "../server/agent/pi-runtime.js";
import {
  assertCommandAllowed,
  createSystemTools,
  isDeniedPath,
  resolveSafePath
} from "../server/agent/system-tools.js";

async function makeWorkspace() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "device-operate-pi-"));
  const home = path.join(dir, "home");
  await fs.mkdir(home, { recursive: true });
  return { dir, home };
}

// ---------------------------------------------------------------------------
// Manual AI configuration
// ---------------------------------------------------------------------------

test("config normalisation keeps known fields and drops junk", () => {
  const config = normalizeConfig({
    version: 99,
    default: { provider: "anthropic", model: "claude", thinkingLevel: "nonsense" },
    providers: { anthropic: { apiKey: "sk-1", baseUrl: "https://x", junk: true }, bad: null },
    customProviders: [{ id: "gw", baseUrl: "https://gw", models: ["a", { id: "b" }] }, { id: "" }]
  });
  assert.equal(config.version, 1);
  assert.equal(config.default.thinkingLevel, "medium", "invalid thinking level falls back");
  assert.deepEqual(Object.keys(config.providers), ["anthropic"]);
  assert.equal(config.providers.anthropic.junk, undefined);
  assert.equal(config.customProviders.length, 1);
  assert.deepEqual(config.customProviders[0].models, [{ id: "a" }, { id: "b" }]);
});

test("maskKey never reveals the whole secret", () => {
  assert.equal(maskKey(""), "");
  assert.equal(maskKey("sk-abcdefghijklmnop"), "sk-abc…mnop");
  assert.equal(maskKey("short"), "sh…rt");
});

test("config store persists keys owner-only and redacts them on read", async () => {
  const { dir } = await makeWorkspace();
  const filePath = path.join(dir, "ai.json");
  const store = createAiConfigStore({ filePath, env: {} });

  await store.setProvider("openai", { apiKey: "sk-test-1234567890", label: "OpenAI" });
  await store.setDefault({ provider: "openai", model: "gpt-5", thinkingLevel: "high" });

  const stat = await fs.stat(filePath);
  assert.equal(stat.mode & 0o777, 0o600, "credential file must be owner-only");

  const snapshot = await store.snapshot();
  assert.equal(snapshot.default.model, "gpt-5");
  assert.equal(snapshot.providers.openai.credential.preview, "sk-tes…7890");
  assert.ok(!JSON.stringify(snapshot).includes("sk-test-1234567890"), "snapshot must not leak the raw key");
  assert.equal(snapshot.configured, true);

  await store.clearProvider("openai");
  assert.equal((await store.snapshot()).providers.openai, undefined);
  await fs.rm(dir, { recursive: true, force: true });
});

test("config store falls back to ambient environment variables", async () => {
  const { dir } = await makeWorkspace();
  const store = createAiConfigStore({
    filePath: path.join(dir, "ai.json"),
    env: { ANTHROPIC_API_KEY: "env-key-123" }
  });
  const info = await store.credentialInfo("anthropic");
  assert.equal(info.configured, true);
  assert.equal(info.source, "ANTHROPIC_API_KEY");
  assert.equal(info.preview, "", "ambient keys are never echoed back");

  const credential = await store.credentialStore().read("anthropic");
  assert.deepEqual(credential, { type: "api_key", key: "env-key-123" });
  await fs.rm(dir, { recursive: true, force: true });
});

test("credential store implements pi-ai read/list/modify/delete", async () => {
  const { dir } = await makeWorkspace();
  const store = createAiConfigStore({ filePath: path.join(dir, "ai.json"), env: {} });
  const credentials = store.credentialStore();

  assert.equal(await credentials.read("openai"), undefined);
  await credentials.modify("openai", async (current) => {
    assert.equal(current, undefined);
    return { type: "api_key", key: "sk-written" };
  });
  assert.deepEqual(await credentials.read("openai"), { type: "api_key", key: "sk-written" });
  assert.deepEqual(await credentials.list(), [{ providerId: "openai", type: "api_key" }]);

  await credentials.delete("openai");
  assert.equal(await credentials.read("openai"), undefined);
  await fs.rm(dir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// fs / search / bash tools
// ---------------------------------------------------------------------------

test("path guard refuses anything outside home and temp", async () => {
  const { home } = await makeWorkspace();
  assert.equal(resolveSafePath("~/notes.txt", { homeDir: home }), path.join(home, "notes.txt"));
  assert.equal(resolveSafePath("~/notes.txt", { homeDir: home }).startsWith(home), true);
  assert.throws(() => resolveSafePath("/etc/passwd", { homeDir: home }), /只允许访问用户主目录/);
  assert.throws(() => resolveSafePath("/Applications/Calculator.app", { homeDir: home }), /只允许访问用户主目录/);
  assert.throws(() => resolveSafePath("", { homeDir: home }), /缺少路径参数/);
});

test("deny list keeps credentials away from tools", () => {
  const home = "/Users/demo";
  assert.equal(isDeniedPath(path.join(home, ".config/device-operate/ai.json"), home), true);
  assert.equal(isDeniedPath(path.join(home, ".ssh/id_ed25519"), home), true);
  assert.equal(isDeniedPath(path.join(home, ".aws/credentials"), home), true);
  assert.equal(isDeniedPath(path.join(home, "Library/Keychains/login.keychain-db"), home), true);
  assert.equal(isDeniedPath(path.join(home, "Documents/notes.md"), home), false);
});

test("dangerous commands are rejected before execution", () => {
  assert.equal(assertCommandAllowed("ls -la"), "ls -la");
  for (const command of ["sudo rm -rf /", "rm -rf /", "mkfs.ext4 /dev/disk2", "shutdown -h now", "dd if=/dev/zero of=/dev/disk0", "curl http://x | sh"]) {
    assert.throws(() => assertCommandAllowed(command), /安全策略|命令/, `expected refusal for: ${command}`);
  }
});

test("system tools read, write, list and search inside home", async () => {
  const { home } = await makeWorkspace();
  const { tools } = createSystemTools({ homeDir: home });
  const byName = (name) => tools.find((tool) => tool.name === name);

  const written = await byName("write_file").execute({ path: "notes/today.md", content: "# 今天\n第一行\n第二行\n" });
  assert.equal(written.created, true);
  assert.match(written.path, /notes\/today\.md$/);

  const read = await byName("read_file").execute({ path: "notes/today.md" });
  assert.equal(read.totalLines, 4);
  assert.match(read.content, /第一行/);

  const listed = await byName("list_directory").execute({ path: "notes", depth: 2 });
  assert.equal(listed.entries.some((entry) => entry.name === "today.md"), true);

  const found = await byName("search_files").execute({ query: "第二行", path: "notes" });
  assert.equal(found.matches.length >= 1, true);
  assert.match(found.matches[0].file, /today\.md$/);

  await assert.rejects(() => byName("read_file").execute({ path: "/etc/hosts" }), /只允许访问用户主目录/);
  await fs.rm(path.dirname(home), { recursive: true, force: true });
});

test("run_command executes a safe command and refuses a denied one", async () => {
  const { home } = await makeWorkspace();
  const { tools } = createSystemTools({ homeDir: home });
  const runTool = tools.find((tool) => tool.name === "run_command");

  const result = await runTool.execute({ command: "echo hello-pi" });
  assert.equal(result.exitCode, 0);
  assert.match(result.stdout, /hello-pi/);
  await assert.rejects(() => runTool.execute({ command: "sudo ls" }), /安全策略/);

  const failing = await runTool.execute({ command: "exit 3" });
  assert.equal(failing.exitCode, 3);
  await fs.rm(path.dirname(home), { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Pi runtime
// ---------------------------------------------------------------------------

test("permission ladder maps tool risk to the active level", () => {
  assert.equal(riskRank("read"), 1);
  assert.equal(riskRank("write"), 2);
  assert.equal(riskRank("destructive"), 3);
  assert.equal(permissionAllows("read", "read"), true);
  assert.equal(permissionAllows("write", "read"), false);
  assert.equal(permissionAllows("write", "write"), true);
  assert.equal(permissionAllows("destructive", "write"), false);
  assert.equal(permissionAllows("destructive", "destructive"), true);
  assert.equal(normalizePermissionLevel("nonsense"), "read");
});

test("a configured gateway URL overrides the model's own baseUrl", async () => {
  // Built-in catalog models each carry their own baseUrl, which would otherwise
  // win over a provider-level override and send traffic to the vendor.
  const model = { id: "m", provider: "groq", baseUrl: "https://api.groq.com/openai/v1" };
  const patched = applyBaseUrl(model, "http://127.0.0.1:1234/v1/");
  assert.equal(patched.baseUrl, "http://127.0.0.1:1234/v1");
  assert.equal(model.baseUrl, "https://api.groq.com/openai/v1", "the catalog model is not mutated");
  assert.equal(applyBaseUrl(model, ""), model, "no override leaves the model untouched");

  const { runtime, aiConfig, dir } = await makeRuntime({ responses: [fauxAssistantMessage("ok")] });
  await aiConfig.setProvider("faux", { baseUrl: "http://127.0.0.1:9999/v1" });
  await runtime.invalidate();
  const resolved = await runtime.resolveDefault();
  assert.equal(resolved.modelObject.baseUrl, "http://127.0.0.1:9999/v1");
  await fs.rm(dir, { recursive: true, force: true });
});

test("tool bridge wraps catalog entries into pi-agent-core tools", async () => {
  const calls = [];
  const bridged = buildAgentTools([
    {
      name: "demo_tool",
      title: "演示工具",
      description: "返回固定值",
      inputSchema: { type: "object", properties: { value: { type: "string" } } },
      execute: async (input) => {
        calls.push(input);
        return { echo: input.value };
      },
      summarize: (data) => `echo=${data.echo}`
    }
  ]);
  assert.equal(bridged.length, 1);
  assert.equal(bridged[0].label, "演示工具");
  const result = await bridged[0].execute("call-1", { value: "hi" });
  assert.deepEqual(calls, [{ value: "hi" }]);
  assert.match(result.content[0].text, /echo=hi/);
  assert.equal(result.details.summary, "echo=hi");

  const failing = buildAgentTools([
    { name: "boom", title: "失败", description: "x", inputSchema: { type: "object", properties: {} }, execute: async () => { throw new Error("炸了"); } }
  ]);
  const failure = await failing[0].execute("call-2", {});
  assert.equal(failure.isError, true);
  assert.match(failure.content[0].text, /炸了/);
});

async function makeRuntime({ responses, permissionLevel = "read", confirm, withCommand = false } = {}) {
  const { dir, home } = await makeWorkspace();
  await fs.writeFile(path.join(home, "hello.txt"), "line1\nline2\nline3\n", "utf8");

  const aiConfig = createAiConfigStore({ filePath: path.join(dir, "ai.json"), env: {} });
  await aiConfig.setProvider("faux", { apiKey: "faux-key" });
  await aiConfig.setDefault({ provider: "faux", model: "faux-model" });

  const faux = fauxProvider({
    provider: "faux",
    api: "faux-chat",
    models: [{ id: "faux-model", name: "Faux", cost: { input: 3, output: 6, cacheRead: 0, cacheWrite: 0 } }]
  });
  faux.setResponses(responses);

  const systemTools = createSystemTools({ homeDir: home });
  const catalog = {
    registry: () => systemTools.tools,
    get: (name) => systemTools.tools.find((tool) => tool.name === name)
  };

  const ledger = createAiUsageLedger({ filePath: path.join(dir, "usage.jsonl") });
  const runtime = createPiRuntime({ aiConfig, tools: catalog, usageLedger: ledger, providerCatalog: () => [faux.provider] });
  return { runtime, faux, aiConfig, ledger, dir, home, systemTools, permissionLevel, confirm };
}

test("pi runtime streams a full turn and reports usage and cost", async () => {
  const { runtime, ledger, dir } = await makeRuntime({
    responses: [fauxAssistantMessage([fauxToolCall("read_file", { path: "~/hello.txt" })]), fauxAssistantMessage("文件有三行。")]
  });

  const events = [];
  const result = await runtime.run({
    sessionId: "s1",
    message: "读一下 hello.txt",
    permissionLevel: "read",
    onEvent: (event) => events.push(event)
  });

  assert.equal(result.source, "pi");
  assert.equal(result.runtime, "pi");
  assert.equal(result.provider, "faux");
  assert.equal(result.reply, "文件有三行。");
  assert.deepEqual(result.toolLog.map((entry) => entry.tool), ["read_file"]);
  assert.equal(result.toolLog[0].isError, false);

  const types = events.map((event) => event.type);
  assert.ok(types.includes("tool-start"));
  assert.ok(types.includes("tool-result"));
  assert.ok(types.includes("delta"));
  assert.ok(types.includes("final"));
  assert.ok(types.includes("usage"));

  assert.ok(result.usage.input > 0, "input tokens recorded");
  assert.ok(result.usage.output > 0, "output tokens recorded");
  assert.equal(result.usage.total, result.usage.input + result.usage.output);
  assert.ok(result.usage.costUsd > 0, "cost derived from the model price table");

  const ledgerSummary = await ledger.summary();
  assert.equal(ledgerSummary.turns, 2, "both assistant messages are billed");
  assert.ok(ledgerSummary.costUsd > 0);
  assert.equal(ledgerSummary.byModel[0].model, "faux-model");

  await fs.rm(dir, { recursive: true, force: true });
});

test("unconfigured runtime refuses to guess and asks for configuration", async () => {
  const { dir, home } = await makeWorkspace();
  const aiConfig = createAiConfigStore({ filePath: path.join(dir, "ai.json"), env: {} });
  const systemTools = createSystemTools({ homeDir: home });
  const runtime = createPiRuntime({
    aiConfig,
    tools: { registry: () => systemTools.tools, get: () => undefined },
    providerCatalog: () => []
  });

  const status = await runtime.status();
  assert.equal(status.configured, false);
  assert.equal(status.runtime, "pi");

  await assert.rejects(
    () => runtime.run({ message: "你好", permissionLevel: "read" }),
    (error) => error.code === "ai-config-required" && error.status === 412
  );
  await fs.rm(dir, { recursive: true, force: true });
});

test("write tools stay blocked until the permission level is raised", async () => {
  const { runtime, dir, home } = await makeRuntime({
    responses: [
      fauxAssistantMessage([fauxToolCall("write_file", { path: "~/blocked.txt", content: "nope" })]),
      fauxAssistantMessage("我没有权限写入。")
    ],
    permissionLevel: "read"
  });

  const result = await runtime.run({ sessionId: "gate", message: "写一个文件", permissionLevel: "read" });
  assert.equal(result.reply, "我没有权限写入。");
  const exists = await fs.access(path.join(home, "blocked.txt")).then(() => true, () => false);
  assert.equal(exists, false, "the write must not happen at read level");
  await fs.rm(dir, { recursive: true, force: true });
});

test("destructive tools require an explicit confirmation when a confirmer is supplied", async () => {
  const confirmations = [];
  const { runtime, dir } = await makeRuntime({
    responses: [fauxAssistantMessage([fauxToolCall("run_command", { command: "echo risky" })]), fauxAssistantMessage("用户拒绝了执行。")],
    permissionLevel: "destructive",
    confirm: async ({ tool, args }) => {
      confirmations.push({ tool, args });
      return false;
    }
  });

  const result = await runtime.run({
    sessionId: "confirm",
    message: "执行 echo risky",
    permissionLevel: "destructive",
    confirm: async ({ tool, args }) => {
      confirmations.push({ tool, args });
      return false;
    }
  });

  assert.equal(confirmations.length, 1);
  assert.equal(confirmations[0].tool, "run_command");
  assert.equal(result.reply, "用户拒绝了执行。");
  await fs.rm(dir, { recursive: true, force: true });
});

test("complete() runs a tool-free structured turn through pi-ai", async () => {
  const { runtime, ledger, dir } = await makeRuntime({
    responses: [fauxAssistantMessage('{"alias":"验证任务","note":"由 Pi 生成","tags":["Pi"]}')]
  });

  const result = await runtime.complete({
    system: "你是系统任务识别助手",
    prompt: "生成备注",
    maxTokens: 200
  });

  assert.equal(result.provider, "faux");
  assert.equal(result.model, "faux-model");
  assert.match(result.text, /验证任务/);
  assert.doesNotThrow(() => JSON.parse(result.text), "the caller can parse the reply as JSON");

  const summary = await ledger.summary();
  assert.ok(summary.turns >= 1, "tool-free turns are billed too");
  await fs.rm(dir, { recursive: true, force: true });
});

test("complete() reports the missing configuration instead of guessing", async () => {
  const { dir, home } = await makeWorkspace();
  const aiConfig = createAiConfigStore({ filePath: path.join(dir, "ai.json"), env: {} });
  const runtime = createPiRuntime({
    aiConfig,
    tools: { registry: () => createSystemTools({ homeDir: home }).tools, get: () => undefined },
    providerCatalog: () => []
  });
  await assert.rejects(
    () => runtime.complete({ prompt: "生成备注" }),
    (error) => error.code === "ai-config-required" && error.status === 412
  );
  await fs.rm(dir, { recursive: true, force: true });
});

test("runtime exposes the provider catalog and can test a provider", async () => {
  const { runtime, dir } = await makeRuntime({ responses: [fauxAssistantMessage("ok")] });

  const providers = await runtime.listProviders();
  const faux = providers.find((provider) => provider.id === "faux");
  assert.ok(faux, "faux provider is listed");
  assert.equal(faux.credential.configured, true);
  assert.equal(faux.models[0].id, "faux-model");

  const withoutLive = await runtime.testProvider({ provider: "faux" });
  assert.equal(withoutLive.ok, true);
  assert.equal(withoutLive.live, false);
  assert.equal(withoutLive.modelCount, 1);

  const missing = await runtime.testProvider({ provider: "nope" });
  assert.equal(missing.ok, false);

  const status = await runtime.status();
  assert.equal(status.configured, true);
  assert.deepEqual(status.providersWithCredential, ["faux"]);
  assert.equal(status.modelCount, 1);
  await fs.rm(dir, { recursive: true, force: true });
});

test("a custom OpenAI-compatible provider is registered, authenticated and usable", async () => {
  const { dir, home } = await makeWorkspace();
  const aiConfig = createAiConfigStore({ filePath: path.join(dir, "ai.json"), env: {} });
  await aiConfig.setCustomProviders([
    {
      id: "local-gw",
      label: "本地网关",
      baseUrl: "http://127.0.0.1:9/v1",
      apiKey: "gw-key",
      api: "openai-completions",
      models: [{ id: "stub-model" }]
    }
  ]);
  await aiConfig.setDefault({ provider: "local-gw", model: "stub-model" });

  const runtime = createPiRuntime({
    aiConfig,
    tools: { registry: () => createSystemTools({ homeDir: home }).tools, get: () => undefined }
  });

  const models = await runtime.buildCollection();
  const model = models.getModel("local-gw", "stub-model");
  assert.ok(model, "custom model is in the catalog");
  assert.equal(model.provider, "local-gw");
  assert.equal(model.api, "openai-completions");
  assert.equal(model.baseUrl, "http://127.0.0.1:9/v1");

  // Regression: the custom provider must resolve its stored key, otherwise
  // every turn fails with "Provider is not configured".
  const auth = await models.getAuth("local-gw");
  assert.equal(auth?.auth?.apiKey, "gw-key");

  const resolved = await runtime.resolveDefault();
  assert.equal(resolved.configured, true);
  assert.equal(resolved.provider, "local-gw");
  await fs.rm(dir, { recursive: true, force: true });
});

test("custom providers pick the transport that matches their declared API", async () => {
  const { dir, home } = await makeWorkspace();
  const aiConfig = createAiConfigStore({ filePath: path.join(dir, "ai.json"), env: {} });
  await aiConfig.setCustomProviders([
    { id: "anthropic-gw", baseUrl: "http://127.0.0.1:9", apiKey: "k", api: "anthropic-messages", models: [{ id: "m1" }] }
  ]);
  const runtime = createPiRuntime({
    aiConfig,
    tools: { registry: () => createSystemTools({ homeDir: home }).tools, get: () => undefined }
  });
  const models = await runtime.buildCollection();
  const model = models.getModel("anthropic-gw", "m1");
  assert.equal(model.api, "anthropic-messages");
  assert.ok(await models.getAuth("anthropic-gw"));
  await fs.rm(dir, { recursive: true, force: true });
});

test("invalidate rebuilds the catalog after the configuration changes", async () => {
  const { runtime, aiConfig, dir } = await makeRuntime({ responses: [fauxAssistantMessage("ok")] });
  await aiConfig.setProvider("faux", { baseUrl: "https://example.invalid" });
  await runtime.invalidate();
  const status = await runtime.status();
  assert.equal(status.configured, true);
  await fs.rm(dir, { recursive: true, force: true });
});

test("usage ledger aggregates tokens and cost per model", () => {
  const summary = summarizeUsage([
    { provider: "anthropic", model: "claude", inputTokens: 1000, outputTokens: 500, cacheReadTokens: 200, cacheWriteTokens: 100, costUsd: 0.01 },
    { provider: "anthropic", model: "claude", inputTokens: 2000, outputTokens: 1000, costUsd: 0.02 },
    { provider: "openai", model: "gpt", inputTokens: 500, outputTokens: 100, costUsd: null }
  ]);
  assert.equal(summary.turns, 3);
  assert.equal(summary.inputTokens, 3500);
  assert.equal(summary.outputTokens, 1600);
  assert.equal(summary.totalTokens, 5100);
  assert.equal(summary.costUsd, 0.03);
  assert.equal(summary.estimatedCostEntries, 1);
  assert.equal(summary.byModel.length, 2);
  assert.equal(summary.byModel[0].model, "claude");
});
