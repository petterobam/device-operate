// Pi runtime: pi-agent-core's Agent loop on top of pi-ai's provider catalog.
//
// The desktop app never talks to a model directly. This module owns the
// provider abstraction (pi-ai), the agent loop (pi-agent-core), the tool bridge
// and the usage accounting, and exposes a small streaming API for the UI.

import { Agent } from "@earendil-works/pi-agent-core";
import { Type, calculateCost, createProvider, createModels, envApiKeyAuth } from "@earendil-works/pi-ai";
import { builtinProviders } from "@earendil-works/pi-ai/providers/all";

const MAX_MODELS_PER_PROVIDER = 400;
const MAX_TOOL_TEXT = 12_000;

export const RISK_LEVELS = Object.freeze({ read: 1, write: 2, destructive: 3 });
export const PERMISSION_LADDER = Object.freeze(["read", "write", "destructive"]);

export const DEFAULT_SYSTEM_PROMPT = `你是「我的 macOS」的本机运维助手，运行在用户的 Mac 上。

规则：
1. 先用工具获取真实数据再回答，不要凭借经验编造本机状态。
2. 只读工具可以直接调用；写操作与破坏性操作只有在用户已授权时才可调用。没有权限时说明需要开启哪一级权限。
3. 只访问用户主目录内你确实需要的文件；不要读取凭据类文件。
4. 回答使用简体中文，给出结论与关键数字，不要罗列原始 JSON。
5. 执行删除、终止、覆盖写入前，先复述对象再执行，并在回答里说明已执行的动作。`;

export function riskRank(risk) {
  return RISK_LEVELS[risk] || RISK_LEVELS.read;
}

export function permissionAllows(risk, level) {
  const ladder = PERMISSION_LADDER.indexOf(PERMISSION_LADDER.includes(level) ? level : "read");
  return riskRank(risk) <= ladder + 1;
}

export function normalizePermissionLevel(level) {
  return PERMISSION_LADDER.includes(level) ? level : "read";
}

function truncate(value, limit = MAX_TOOL_TEXT) {
  const text = typeof value === "string" ? value : JSON.stringify(value ?? null);
  if (!text) return "";
  return text.length > limit ? `${text.slice(0, limit)}…（已截断）` : text;
}

/**
 * Built-in catalog models carry their own `baseUrl`, which wins over the
 * provider-level value. Gateways and proxies therefore have to be applied to the
 * model object that is actually handed to the stream function.
 */
export function applyBaseUrl(model, baseUrl) {
  const base = String(baseUrl || "").trim().replace(/\/+$/, "");
  if (!base || !model) return model;
  return model.baseUrl === base ? model : { ...model, baseUrl: base };
}

function toTypeBoxSchema(inputSchema) {
  const schema = inputSchema && typeof inputSchema === "object" ? inputSchema : { type: "object", properties: {} };
  // TypeBox's Unsafe passthrough accepts a raw JSON Schema, which is what the
  // tool catalog already declares and what the HTTP surface publishes.
  return Type.Unsafe(schema);
}

/**
 * Builds the pi-agent-core tool list from an existing tool catalog so the chat,
 * the HTTP surface and the Pi loop share one implementation.
 */
export function buildAgentTools(toolDescriptors, { onEvent } = {}) {
  return toolDescriptors.map((tool) => ({
    name: tool.name,
    label: tool.title || tool.name,
    description: tool.description || tool.title || tool.name,
    parameters: toTypeBoxSchema(tool.inputSchema),
    execute: async (toolCallId, params) => {
      const startedAt = Date.now();
      try {
        const data = await tool.execute(params || {});
        const summarize = tool.summarize || (() => "");
        const summary = summarize(data) || truncate(data, 600);
        await onEvent?.({ type: "tool-summary", tool: tool.name, summary });
        return {
          content: [{ type: "text", text: `${summary}\n\n${truncate(data)}` }],
          details: { summary, data, durationMs: Date.now() - startedAt }
        };
      } catch (error) {
        const message = error?.message || String(error);
        return {
          content: [{ type: "text", text: `工具执行失败：${message}` }],
          details: { error: message, durationMs: Date.now() - startedAt },
          isError: true
        };
      }
    }
  }));
}

/**
 * @param {object} options
 * @param {object} options.aiConfig      store from createAiConfigStore()
 * @param {object} options.tools         catalog from createAgentTools()
 * @param {object} [options.usageLedger] ledger from createAiUsageLedger()
 * @param {Function} [options.providerCatalog] injectable provider list (tests use the faux provider)
 */
export function createPiRuntime({
  aiConfig,
  tools,
  usageLedger,
  logger = console,
  systemPrompt = DEFAULT_SYSTEM_PROMPT,
  providerCatalog,
  maxTurns
} = {}) {
  let collection = null;
  const sessions = new Map();

  /**
   * Finds a built-in provider whose models speak `api`. Provider instances
   * expose `stream`/`streamSimple` (not an `api` map), so the API id is read
   * from the catalog model instead.
   */
  function templateProvider(providers, api) {
    const preferred = ["groq", "deepseek", "together", "cerebras", "anthropic", "openai", "opencode"];
    const speaks = (provider) => {
      if (typeof provider.streamSimple !== "function" && typeof provider.stream !== "function") return false;
      const models = provider.getModels?.() || provider.models || [];
      return models.some((model) => model.api === api);
    };
    for (const id of preferred) {
      const candidate = providers.find((provider) => provider.id === id && speaks(provider));
      if (candidate) return candidate;
    }
    return providers.find(speaks) || null;
  }

  async function buildCollection() {
    const providers = providerCatalog ? providerCatalog() : builtinProviders();
    const config = await aiConfig.read();
    const credentials = aiConfig.credentialStore();
    const models = createModels({ credentials });

    for (const provider of providers) {
      const override = config.providers[provider.id];
      if (override?.baseUrl) {
        models.setProvider({ ...provider, baseUrl: override.baseUrl });
        continue;
      }
      models.setProvider(provider);
    }

    // User-defined OpenAI-compatible endpoints reuse a built-in provider's
    // request implementation and model shape, so no provider code is generated.
    for (const custom of config.customProviders) {
      const api = custom.api || "openai-completions";
      const template = templateProvider(providers, api);
      if (!template) {
        logger.warn?.(`[pi] 自定义提供方 ${custom.id} 找不到可复用的 ${api} 实现`);
        continue;
      }
      const templateModels = template.getModels?.() || template.models || [];
      const templateModel = templateModels.find((model) => model.api === api) || templateModels[0];
      const modelsForProvider = (custom.models.length ? custom.models : [{ id: templateModel?.id || "default" }]).map((entry) => ({
        ...templateModel,
        id: entry.id,
        name: entry.name || entry.id,
        provider: custom.id,
        baseUrl: custom.baseUrl || template.baseUrl
      }));
      // The credential store resolves by provider id, and the catalog is built
      // after the config was written, so a stored key is known synchronously.
      const customKey = custom.apiKey || (await aiConfig.credentialStore().read(custom.id))?.key;
      const provider = createProvider({
        id: custom.id,
        name: custom.label || custom.id,
        baseUrl: custom.baseUrl || template.baseUrl,
        auth: {
          apiKey: {
            name: `${custom.label || custom.id} API key`,
            resolve: async () => customKey
              ? { auth: { apiKey: customKey }, source: "stored credential" }
              : undefined
          }
        },
        models: modelsForProvider,
        // Reuse the built-in provider's transport instead of rebuilding it.
        api: {
          [api]: {
            stream: template.stream,
            streamSimple: template.streamSimple
          }
        }
      });
      models.setProvider(provider);
    }

    collection = models;
    return models;
  }

  async function ensureCollection() {
    if (!collection) await buildCollection();
    return collection;
  }

  async function invalidate() {
    collection = null;
    sessions.clear();
    return ensureCollection();
  }

  async function listProviders() {
    const models = await ensureCollection();
    const config = await aiConfig.read();
    const ids = [...new Set([...models.getModels().map((model) => model.provider), ...config.customProviders.map((entry) => entry.id)])];
    const result = [];
    for (const id of ids.sort()) {
      const providerModels = models.getModels(id).slice(0, MAX_MODELS_PER_PROVIDER);
      result.push({
        id,
        name: config.providers[id]?.label || config.customProviders.find((entry) => entry.id === id)?.label || id,
        modelCount: models.getModels(id).length,
        credential: await aiConfig.credentialInfo(id),
        models: providerModels.map((model) => ({
          id: model.id,
          name: model.name || model.id,
          api: model.api,
          contextWindow: model.contextWindow,
          maxTokens: model.maxTokens,
          reasoning: Boolean(model.reasoning),
          cost: model.cost
        }))
      });
    }
    return result;
  }

  async function resolveDefault() {
    const models = await ensureCollection();
    const config = await aiConfig.read();
    const { provider, model } = config.default;
    if (!provider || !model) return { configured: false, provider: "", model: "", reason: "尚未选择默认模型" };
    const found = models.getModel(provider, model);
    if (!found) return { configured: false, provider, model, reason: `找不到模型 ${provider}/${model}` };
    const target = applyBaseUrl(found, config.providers[provider]?.baseUrl);
    const credential = await aiConfig.credentialInfo(provider);
    if (!credential.configured) {
      return { configured: false, provider, model, modelObject: target, reason: `${provider} 还没有配置凭证` };
    }
    return { configured: true, provider, model, modelObject: target, credential };
  }

  async function status() {
    const models = await ensureCollection();
    const config = await aiConfig.read();
    const resolved = await resolveDefault();
    const withCredential = [];
    for (const providerId of new Set(models.getModels().map((model) => model.provider))) {
      const info = await aiConfig.credentialInfo(providerId);
      if (info.configured) withCredential.push(providerId);
    }
    return {
      runtime: "pi",
      runtimeVersion: RUNTIME_VERSION,
      configured: resolved.configured,
      reason: resolved.reason || "",
      default: config.default,
      credential: resolved.credential || { configured: false, source: "", preview: "" },
      providersWithCredential: withCredential.sort(),
      providerCount: new Set(models.getModels().map((model) => model.provider)).size,
      modelCount: models.getModels().length,
      thinkingLevels: config.default.thinkingLevel ? [config.default.thinkingLevel] : []
    };
  }

  function sessionKey(sessionId) {
    return sessionId && String(sessionId).trim() ? String(sessionId).trim() : "default";
  }

  async function createSession({ sessionId, permissionLevel, onEvent, confirm }) {
    const resolved = await resolveDefault();
    if (!resolved.configured) {
      const error = new Error(resolved.reason || "AI 尚未完成配置");
      error.status = 412;
      error.code = "ai-config-required";
      throw error;
    }
    const models = await ensureCollection();
    const agentTools = buildAgentTools(tools.registry(), { onEvent });
    const byName = new Map(tools.registry().map((tool) => [tool.name, tool]));
    const level = normalizePermissionLevel(permissionLevel);
    const gate = async (context) => {
      const name = context?.toolCall?.name;
      const tool = byName.get(name);
      if (!tool) return { block: true, reason: `未知工具：${name}` };
      if (!permissionAllows(tool.risk, level)) {
        return {
          block: true,
          reason: `工具「${tool.title || name}」需要${tool.risk === "destructive" ? "破坏性操作" : "写操作"}授权，请先在对话里提升权限等级。`
        };
      }
      if (tool.risk === "destructive" && typeof confirm === "function") {
        const approved = await confirm({ tool: name, title: tool.title, args: context.args });
        if (!approved) return { block: true, reason: `用户拒绝执行「${tool.title || name}」` };
      }
      return undefined;
    };

    const agent = new Agent({
      initialState: { systemPrompt, model: resolved.modelObject, tools: agentTools },
      streamFn: (model, context, options) => models.streamSimple(model, context, options),
      getApiKey: async (providerId) => {
        const credential = await aiConfig.credentialStore().read(providerId);
        return credential?.key;
      },
      beforeToolCall: gate,
      sessionId: sessionKey(sessionId),
      maxTurns,
      maxRetryDelayMs: 5000
    });

    const state = {
      agent,
      provider: resolved.provider,
      model: resolved.model,
      modelObject: resolved.modelObject,
      permissionLevel: level,
      usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0, costUsd: 0 },
      toolLog: []
    };
    sessions.set(sessionKey(sessionId), state);
    return state;
  }

  function assistantFailure(message) {
    if (!message || message.role !== "assistant") return "";
    if (message.errorMessage) return String(message.errorMessage);
    if (message.stopReason === "error") {
      const text = Array.isArray(message.content) ? message.content.map((block) => block.text).filter(Boolean).join(" ") : "";
      return text || "模型返回了错误";
    }
    return "";
  }

  async function run({ sessionId, message, permissionLevel, onEvent, confirm, signal } = {}) {
    const text = String(message ?? "").trim();
    if (!text) {
      const error = new Error("消息不能为空");
      error.status = 400;
      throw error;
    }
    const key = sessionKey(sessionId);
    let state = sessions.get(key);
    if (!state || state.permissionLevel !== normalizePermissionLevel(permissionLevel)) {
      state = await createSession({ sessionId: key, permissionLevel, onEvent, confirm });
    }

    const runState = { reply: "", thinking: "", toolLog: [], usage: { ...state.usage } };
    const unsubscribe = state.agent.subscribe(async (event) => {
      switch (event.type) {
        case "message_update": {
          const update = event.assistantMessageEvent;
          if (update?.type === "text_delta" && update.delta) {
            runState.reply += update.delta;
            await onEvent?.({ type: "delta", text: update.delta });
          } else if (update?.type === "thinking_delta" && update.delta) {
            runState.thinking += update.delta;
            await onEvent?.({ type: "thinking", text: update.delta });
          }
          break;
        }
        case "message_end": {
          const failure = assistantFailure(event.message);
          if (failure) {
            runState.error = failure;
            await onEvent?.({ type: "error", message: failure });
          }
          const usage = event.message?.usage;
          if (event.message?.role === "assistant" && usage) {
            // Prefer the provider's own accounting, but fall back to the model's
            // published price table when it reports zero/absent cost.
            const reported = Number(usage.cost?.total);
            const computed = Number(calculateCost(state.modelObject, usage)?.total);
            const cost = Number.isFinite(reported) && reported > 0 ? reported : Number.isFinite(computed) ? computed : NaN;
            const entry = {
              provider: state.provider,
              model: state.model,
              inputTokens: Number(usage.input) || 0,
              outputTokens: Number(usage.output) || 0,
              cacheReadTokens: Number(usage.cacheRead) || 0,
              cacheWriteTokens: Number(usage.cacheWrite) || 0,
              costUsd: Number.isFinite(cost) ? Number(cost.toFixed(6)) : null,
              sessionId: key
            };
            runState.usage = {
              input: runState.usage.input + entry.inputTokens,
              output: runState.usage.output + entry.outputTokens,
              cacheRead: runState.usage.cacheRead + entry.cacheReadTokens,
              cacheWrite: runState.usage.cacheWrite + entry.cacheWriteTokens,
              total: runState.usage.total + entry.inputTokens + entry.outputTokens,
              costUsd: Number((runState.usage.costUsd + (entry.costUsd || 0)).toFixed(6))
            };
            await usageLedger?.record(entry);
            await onEvent?.({ type: "usage", usage: entry, total: runState.usage });
          }
          break;
        }
        case "tool_execution_start": {
          const entry = { tool: event.toolName, title: byTitle(state, event.toolName), input: event.args, startedAt: Date.now() };
          runState.toolLog.push(entry);
          await onEvent?.({ type: "tool-start", tool: event.toolName, title: entry.title, input: event.args });
          break;
        }
        case "tool_execution_end": {
          const entry = runState.toolLog.find((item) => item.tool === event.toolName && !item.finished);
          const summary = event.result?.details?.summary || (Array.isArray(event.result?.content) ? event.result.content.map((block) => block.text).join("\n") : "");
          if (entry) {
            entry.finished = true;
            entry.isError = Boolean(event.isError);
            entry.durationMs = event.durationMs;
            entry.summary = truncate(summary, 400);
            entry.error = event.isError ? truncate(summary, 400) : "";
          }
          await onEvent?.({
            type: "tool-result",
            tool: event.toolName,
            title: byTitle(state, event.toolName),
            isError: Boolean(event.isError),
            durationMs: event.durationMs,
            summary: truncate(summary, 400)
          });
          break;
        }
        case "agent_end": {
          await onEvent?.({ type: "final", reply: runState.reply, usage: runState.usage });
          break;
        }
        default:
          break;
      }
    });

    if (signal) signal.addEventListener("abort", () => state.agent.abort(), { once: true });

    try {
      await state.agent.prompt(text);
      await state.agent.waitForIdle();
    } finally {
      unsubscribe();
      state.usage = runState.usage;
    }

    return {
      source: "pi",
      runtime: "pi",
      provider: state.provider,
      model: state.model,
      permissionLevel: state.permissionLevel,
      error: runState.error || "",
      reply: runState.reply.trim() || (runState.error ? `模型调用失败：${runState.error}` : ""),
      thinking: runState.thinking.trim(),
      toolLog: runState.toolLog,
      usage: runState.usage
    };
  }

  function byTitle(state, toolName) {
    return tools.get(toolName)?.title || toolName;
  }

  function resetSession(sessionId) {
    const key = sessionKey(sessionId);
    const state = sessions.get(key);
    state?.agent.reset();
    sessions.delete(key);
    return { reset: Boolean(state) };
  }

  /**
   * One-shot structured completion with no tools, used for task metadata.
   * Runs through pi-ai directly so it does not disturb a chat session.
   */
  async function complete({ system, prompt, maxTokens = 600, thinkingLevel = "low" } = {}) {
    const resolved = await resolveDefault();
    if (!resolved.configured) {
      const error = new Error(resolved.reason || "AI 尚未完成配置");
      error.status = 412;
      error.code = "ai-config-required";
      throw error;
    }
    const models = await ensureCollection();
    const model = resolved.modelObject;
    const stream = models.streamSimple(model, {
      systemPrompt: system || "",
      messages: [{ role: "user", content: [{ type: "text", text: prompt }] }]
    }, { maxTokens, thinkingLevel });

    let text = "";
    let usage = null;
    for await (const event of stream) {
      if (event.type === "text_delta") text += event.delta;
      if (event.type === "done") {
        usage = event.message?.usage || null;
        break;
      }
      if (event.type === "error") throw new Error(event.error?.message || "模型调用失败");
    }
    if (usage) {
      const reported = Number(usage.cost?.total);
      const computed = Number(calculateCost(model, usage)?.total);
      const cost = Number.isFinite(reported) && reported > 0 ? reported : Number.isFinite(computed) ? computed : NaN;
      await usageLedger?.record({
        provider: resolved.provider,
        model: resolved.model,
        inputTokens: Number(usage.input) || 0,
        outputTokens: Number(usage.output) || 0,
        cacheReadTokens: Number(usage.cacheRead) || 0,
        cacheWriteTokens: Number(usage.cacheWrite) || 0,
        costUsd: Number.isFinite(cost) ? Number(cost.toFixed(6)) : null,
        purpose: "task-remark"
      });
    }
    return { text: text.trim(), provider: resolved.provider, model: resolved.model };
  }

  async function testProvider({ provider, model, live = false } = {}) {
    const models = await ensureCollection();
    if (!provider) {
      const error = new Error("需要提供 provider");
      error.status = 400;
      throw error;
    }
    const credential = await aiConfig.credentialInfo(provider);
    const auth = await models.getAuth(provider).catch((error) => ({ error: error.message }));
    const available = models.getModels(provider);
    const result = {
      provider,
      model: model || available[0]?.id || "",
      credential,
      authSource: auth?.source || "",
      modelCount: available.length,
      ok: Boolean(auth) && available.length > 0,
      live: false
    };
    if (!result.ok) {
      result.reason = credential.configured ? "该提供方没有可用模型" : "尚未配置 API Key";
      return result;
    }
    if (!live) return result;

    const config = await aiConfig.read();
    const target = applyBaseUrl(models.getModel(provider, result.model), config.providers[provider]?.baseUrl);
    if (!target) {
      result.ok = false;
      result.reason = `找不到模型 ${provider}/${result.model}`;
      return result;
    }
    const startedAt = Date.now();
    try {
      const stream = models.streamSimple(target, {
        messages: [{ role: "user", content: [{ type: "text", text: "ping" }] }]
      }, { maxTokens: 16 });
      let text = "";
      for await (const event of stream) {
        if (event.type === "text_delta") text += event.delta;
        if (event.type === "error") throw new Error(event.error?.message || "provider error");
        if (event.type === "done") break;
      }
      result.live = true;
      result.ok = true;
      result.latencyMs = Date.now() - startedAt;
      result.sample = truncate(text, 200);
    } catch (error) {
      result.live = true;
      result.ok = false;
      result.reason = error.message;
      result.latencyMs = Date.now() - startedAt;
    }
    return result;
  }

  return {
    run,
    complete,
    status,
    listProviders,
    resolveDefault,
    invalidate,
    resetSession,
    testProvider,
    buildCollection,
    sessions,
    get collection() {
      return collection;
    }
  };
}

export const RUNTIME_VERSION = "pi-agent-core+pi-ai 1.3.0";
