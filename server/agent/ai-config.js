// Manual AI configuration: providers, credentials and the default model.
//
// The file is the single source of truth for the app. It doubles as a pi-ai
// `CredentialStore`, so the Pi runtime resolves keys the same way the UI writes
// them. Ambient environment variables are honoured as a read-only fallback so a
// machine with ANTHROPIC_API_KEY set works without any manual step.

import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

export const AI_CONFIG_VERSION = 1;

// Environment variables checked per provider when no manual key is stored.
export const PROVIDER_ENV_VARS = Object.freeze({
  anthropic: ["ANTHROPIC_API_KEY"],
  openai: ["OPENAI_API_KEY"],
  google: ["GOOGLE_API_KEY", "GEMINI_API_KEY"],
  deepseek: ["DEEPSEEK_API_KEY"],
  groq: ["GROQ_API_KEY"],
  mistral: ["MISTRAL_API_KEY"],
  xai: ["XAI_API_KEY"],
  openrouter: ["OPENROUTER_API_KEY"],
  cerebras: ["CEREBRAS_API_KEY"],
  together: ["TOGETHER_API_KEY"],
  minimax: ["MINIMAX_API_KEY"],
  moonshotai: ["MOONSHOT_API_KEY"],
  zai: ["ZAI_API_KEY"],
  fireworks: ["FIREWORKS_API_KEY"],
  nvidia: ["NVIDIA_API_KEY"],
  baseten: ["BASETEN_API_KEY"],
  "github-copilot": ["GITHUB_TOKEN"],
  opencode: ["OPENCODE_API_KEY"]
});

export const THINKING_LEVELS = Object.freeze(["off", "minimal", "low", "medium", "high", "xhigh", "max", "ultra"]);

export function defaultConfig() {
  return {
    version: AI_CONFIG_VERSION,
    default: { provider: "", model: "", thinkingLevel: "medium", systemPrompt: "" },
    providers: {},
    customProviders: [],
    updatedAt: null
  };
}

/** Never expose a stored key in full; the UI only needs to recognise it. */
export function maskKey(key) {
  const value = String(key || "");
  if (!value) return "";
  if (value.length <= 10) return `${value.slice(0, 2)}…${value.slice(-2)}`;
  return `${value.slice(0, 6)}…${value.slice(-4)}`;
}

export function normalizeConfig(raw) {
  const base = defaultConfig();
  if (!raw || typeof raw !== "object") return base;
  const providers = {};
  for (const [id, entry] of Object.entries(raw.providers || {})) {
    if (!entry || typeof entry !== "object") continue;
    providers[id] = {
      apiKey: typeof entry.apiKey === "string" ? entry.apiKey : "",
      baseUrl: typeof entry.baseUrl === "string" ? entry.baseUrl : "",
      label: typeof entry.label === "string" ? entry.label : "",
      updatedAt: typeof entry.updatedAt === "string" ? entry.updatedAt : null
    };
  }
  const customProviders = Array.isArray(raw.customProviders)
    ? raw.customProviders
        .filter((entry) => entry && typeof entry.id === "string" && entry.id.trim())
        .map((entry) => ({
          id: String(entry.id).trim(),
          label: typeof entry.label === "string" ? entry.label : "",
          baseUrl: typeof entry.baseUrl === "string" ? entry.baseUrl : "",
          apiKey: typeof entry.apiKey === "string" ? entry.apiKey : "",
          api: typeof entry.api === "string" ? entry.api : "openai-completions",
          models: Array.isArray(entry.models)
            ? entry.models.map((model) => (typeof model === "string" ? { id: model } : { id: String(model?.id || "").trim() })).filter((model) => model.id)
            : []
        }))
    : [];
  const thinking = THINKING_LEVELS.includes(raw.default?.thinkingLevel) ? raw.default.thinkingLevel : base.default.thinkingLevel;
  return {
    version: AI_CONFIG_VERSION,
    default: {
      provider: typeof raw.default?.provider === "string" ? raw.default.provider : "",
      model: typeof raw.default?.model === "string" ? raw.default.model : "",
      thinkingLevel: thinking,
      systemPrompt: typeof raw.default?.systemPrompt === "string" ? raw.default.systemPrompt : ""
    },
    providers,
    customProviders,
    updatedAt: typeof raw.updatedAt === "string" ? raw.updatedAt : null
  };
}

/**
 * File-backed config plus a pi-ai CredentialStore view over it.
 *
 * `env` may be injected for tests; it defaults to `process.env`.
 */
export function createAiConfigStore({
  filePath = path.join(os.homedir(), ".config", "device-operate", "ai.json"),
  env = process.env,
  now = () => new Date().toISOString()
} = {}) {
  let cache = null;

  async function read() {
    if (cache) return cache;
    try {
      const raw = JSON.parse(await fs.readFile(filePath, "utf8"));
      cache = normalizeConfig(raw);
    } catch {
      cache = defaultConfig();
    }
    return cache;
  }

  async function write(next) {
    const normalized = normalizeConfig({ ...next, updatedAt: now() });
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    const temp = `${filePath}.tmp`;
    await fs.writeFile(temp, JSON.stringify(normalized, null, 2), { encoding: "utf8", mode: 0o600 });
    await fs.rename(temp, filePath);
    // The file holds API keys; keep it owner-only even if it already existed.
    await fs.chmod(filePath, 0o600).catch(() => {});
    cache = normalized;
    return normalized;
  }

  /** Ambient key for a provider, if the environment provides one. */
  function envKey(providerId) {
    for (const name of PROVIDER_ENV_VARS[providerId] || []) {
      const value = env[name];
      if (value && String(value).trim()) return { key: String(value).trim(), source: name };
    }
    return null;
  }

  function resolveCredential(providerId) {
    const configured = cache?.providers?.[providerId];
    if (configured?.apiKey) return { key: configured.apiKey, source: "manual" };
    const custom = cache?.customProviders?.find((entry) => entry.id === providerId);
    if (custom?.apiKey) return { key: custom.apiKey, source: "manual" };
    const ambient = envKey(providerId);
    if (ambient) return ambient;
    return null;
  }

  return {
    filePath,
    read,
    write,

    async setProvider(providerId, patch = {}) {
      const config = { ...(await read()) };
      const current = config.providers[providerId] || {};
      const next = { ...current };
      if (typeof patch.apiKey === "string") next.apiKey = patch.apiKey.trim();
      if (typeof patch.baseUrl === "string") next.baseUrl = patch.baseUrl.trim();
      if (typeof patch.label === "string") next.label = patch.label.trim();
      next.updatedAt = now();
      config.providers = { ...config.providers, [providerId]: next };
      return write(config);
    },

    async clearProvider(providerId) {
      const config = { ...(await read()) };
      const providers = { ...config.providers };
      delete providers[providerId];
      config.providers = providers;
      return write(config);
    },

    async setCustomProviders(list) {
      const config = { ...(await read()) };
      config.customProviders = Array.isArray(list) ? list : [];
      return write(config);
    },

    async setDefault(patch = {}) {
      const config = { ...(await read()) };
      config.default = { ...config.default, ...patch };
      return write(config);
    },

    /** Key + provenance for a provider without exposing the secret. */
    async credentialInfo(providerId) {
      const resolved = resolveCredential(providerId);
      if (!resolved) return { configured: false, source: "", preview: "" };
      return {
        configured: true,
        source: resolved.source,
        preview: resolved.source === "manual" ? maskKey(resolved.key) : "",
        envVar: resolved.source === "manual" ? "" : resolved.source
      };
    },

    async listCredentialInfo(providerIds = []) {
      const out = {};
      for (const id of providerIds) out[id] = await this.credentialInfo(id);
      return out;
    },

    /** Redacted snapshot for the UI and the HTTP API. */
    async snapshot() {
      const config = await read();
      const providers = {};
      for (const [id, entry] of Object.entries(config.providers)) {
        providers[id] = {
          label: entry.label,
          baseUrl: entry.baseUrl,
          updatedAt: entry.updatedAt,
          credential: await this.credentialInfo(id)
        };
      }
      return {
        filePath,
        version: config.version,
        default: config.default,
        providers,
        customProviders: config.customProviders.map((entry) => ({
          id: entry.id,
          label: entry.label,
          baseUrl: entry.baseUrl,
          api: entry.api,
          models: entry.models,
          hasKey: Boolean(entry.apiKey),
          keyPreview: maskKey(entry.apiKey),
          credential: entry.apiKey ? { configured: true, source: "manual", preview: maskKey(entry.apiKey) } : { configured: false, source: "", preview: "" }
        })),
        configured: Object.keys(providers).length > 0 || config.customProviders.length > 0
      };
    },

    /** The pi-ai CredentialStore contract (`read`/`list`/`modify`/`delete`). */
    credentialStore() {
      return {
        read: async (providerId) => {
          await read();
          const resolved = resolveCredential(providerId);
          return resolved ? { type: "api_key", key: resolved.key } : undefined;
        },
        list: async () => {
          const config = await read();
          return [
            ...Object.keys(config.providers).map((providerId) => ({ providerId, type: "api_key" })),
            ...config.customProviders.filter((entry) => entry.apiKey).map((entry) => ({ providerId: entry.id, type: "api_key" }))
          ];
        },
        modify: async (providerId, fn) => {
          const current = await this.credentialStore().read(providerId);
          const next = await fn(current);
          if (next && typeof next.key === "string") {
            const known = (envKey(providerId) || {}).source;
            const config = await read();
            if (!config.providers[providerId] && !config.customProviders.some((entry) => entry.id === providerId) && known) {
              // Ambient credentials are not persisted; nothing to write.
              return current;
            }
            await this.setProvider(providerId, { apiKey: next.key });
          } else if (next === undefined && current) {
            await this.clearProvider(providerId);
          }
          return next;
        },
        delete: async (providerId) => {
          await this.clearProvider(providerId);
        }
      };
    }
  };
}
