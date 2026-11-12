import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const DEFAULT_KEY_NAME = "id_ed25519";
const PRIVATE_KEY_HEADER = /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----/;
const SAFE_KEY_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const RESERVED_SSH_FILES = new Set(["config", "known_hosts", "known_hosts.old", "authorized_keys", "environment"]);
const KEY_ALGORITHMS = Object.freeze({
  ed25519: { sshType: "ed25519", label: "Ed25519", defaultBits: null },
  rsa: { sshType: "rsa", label: "RSA", defaultBits: 4096 },
  ecdsa: { sshType: "ecdsa", label: "ECDSA", defaultBits: 521 }
});

function serviceError(message, status = 400) {
  return Object.assign(new Error(message), { status });
}

function splitInlineComment(value) {
  const source = String(value || "");
  const match = source.match(/^(.*?)(\s+#.*)$/);
  return {
    value: (match ? match[1] : source).trim(),
    inlineComment: match ? match[2].trim() : ""
  };
}

function parseOptionLine(line) {
  const match = String(line).match(/^\s*([A-Za-z][A-Za-z0-9]*)\s*(?:=\s*)?(.*?)\s*$/);
  if (!match) return null;
  const key = match[1];
  const { value, inlineComment } = splitInlineComment(match[2]);
  if (!value) return null;
  return { key, value, ...(inlineComment ? { inlineComment } : {}) };
}

function normalizeHostPatterns(value) {
  const patterns = Array.isArray(value) ? value : String(value || "").trim().split(/\s+/);
  const result = patterns.map((item) => String(item).trim()).filter(Boolean);
  if (!result.length || result.some((item) => /[\r\n]/.test(item))) {
    throw serviceError("Host 匹配模式不能为空且不能包含换行");
  }
  return result;
}

function normalizeOptions(value) {
  const entries = Array.isArray(value)
    ? value
    : Object.entries(value || {}).map(([key, optionValue]) => ({ key, value: optionValue }));
  const result = [];
  for (const entry of entries) {
    const key = String(entry?.key || "").trim();
    const optionValue = String(entry?.value ?? "").trim();
    const inlineComment = String(entry?.inlineComment || "").trim();
    if (!key && !optionValue) continue;
    if (!/^[A-Za-z][A-Za-z0-9]*$/.test(key) || /[\r\n]/.test(optionValue) || /[\r\n]/.test(inlineComment)) {
      throw serviceError("SSH 配置项名称或值格式不正确");
    }
    if (inlineComment && !inlineComment.startsWith("#")) throw serviceError("SSH 配置项注释格式不正确");
    if (!optionValue) continue;
    if (key.toLowerCase() === "host" || key.toLowerCase() === "match") {
      throw serviceError("Host 和 Match 不能作为主机配置项");
    }
    result.push({ key, value: optionValue, ...(inlineComment ? { inlineComment } : {}) });
  }
  return result;
}

export function parseSshConfig(text = "") {
  const globals = [];
  const hosts = [];
  let current = null;
  let passthrough = false;
  for (const line of String(text).split(/\r?\n/)) {
    const trimmed = line.trim();
    const hostMatch = trimmed.match(/^Host\s+(.+)$/i);
    if (hostMatch) {
      const { value: hostValue, inlineComment: headerComment } = splitInlineComment(hostMatch[1]);
      const patterns = normalizeHostPatterns(hostValue);
      current = { host: patterns.join(" "), patterns, options: [], comments: [], headerComment, rawLines: [line] };
      passthrough = false;
      hosts.push(current);
      continue;
    }
    if (!current) {
      globals.push(line);
      continue;
    }
    current.rawLines.push(line);
    if (!trimmed || trimmed.startsWith("#")) {
      current.comments.push(line);
      continue;
    }
    if (passthrough || /^Match(?:\s|$)/i.test(trimmed)) {
      passthrough = true;
      current.comments.push(line);
      continue;
    }
    const option = parseOptionLine(line);
    if (option) current.options.push(option);
    else current.comments.push(line);
  }
  return { globals, hosts };
}

export function serializeSshConfig({ globals = [], hosts = [] } = {}) {
  const lines = [...globals];
  for (const entry of hosts) {
    if (entry.rawLines?.length && !entry.modified) {
      lines.push(...entry.rawLines);
      continue;
    }
    const patterns = normalizeHostPatterns(entry.patterns || entry.host);
    const options = normalizeOptions(entry.options);
    if (lines.length && lines.at(-1) !== "") lines.push("");
    lines.push(`Host ${patterns.join(" ")}${entry.headerComment ? ` ${entry.headerComment}` : ""}`);
    for (const option of options) lines.push(`    ${option.key} ${option.value}${option.inlineComment ? ` ${option.inlineComment}` : ""}`);
    if (entry.comments?.length) lines.push(...entry.comments);
  }
  const output = lines.join("\n");
  return output.endsWith("\n") ? output : `${output}\n`;
}

function keyNameOrThrow(name) {
  const normalized = String(name || "").trim();
  if (!SAFE_KEY_NAME.test(normalized) || normalized.endsWith(".pub") || RESERVED_SSH_FILES.has(normalized.toLowerCase())) {
    throw serviceError("SSH Key 名称不合法");
  }
  return normalized;
}

function algorithmOrThrow(algorithm) {
  const normalized = String(algorithm || "ed25519").toLowerCase();
  if (!KEY_ALGORITHMS[normalized]) throw serviceError("不支持的 SSH Key 类型");
  return normalized;
}

function toPublicAlgorithm(raw) {
  if (raw === "ssh-ed25519") return "ed25519";
  if (raw === "ssh-rsa") return "rsa";
  if (raw.startsWith("ecdsa-")) return "ecdsa";
  return raw || "unknown";
}

export function createSshService({ homeDir = os.homedir(), fsImpl = fs, run = execFileAsync } = {}) {
  const sshDir = path.join(homeDir, ".ssh");
  const configPath = path.join(sshDir, "config");

  function privatePath(name) {
    return path.join(sshDir, keyNameOrThrow(name));
  }

  async function exists(filePath) {
    try {
      const stat = await fsImpl.stat(filePath);
      return stat.isFile();
    } catch {
      return false;
    }
  }

  async function readConfig() {
    try {
      return await fsImpl.readFile(configPath, "utf8");
    } catch (error) {
      if (error.code === "ENOENT") return "";
      throw error;
    }
  }

  async function writeConfig(parsed) {
    await fsImpl.mkdir(sshDir, { recursive: true, mode: 0o700 });
    await fsImpl.chmod(sshDir, 0o700).catch(() => {});
    const tempPath = path.join(sshDir, `.config.device-operate-${process.pid}-${Date.now()}`);
    try {
      await fsImpl.writeFile(tempPath, serializeSshConfig(parsed), { encoding: "utf8", mode: 0o600 });
      await fsImpl.chmod(tempPath, 0o600);
      await fsImpl.rename(tempPath, configPath);
    } finally {
      await fsImpl.rm(tempPath, { force: true }).catch(() => {});
    }
  }

  async function fingerprint(publicFile) {
    try {
      const { stdout } = await run("ssh-keygen", ["-lf", publicFile], { timeout: 5_000 });
      return String(stdout).trim().split(/\s+/)[1] || "";
    } catch {
      return "";
    }
  }

  async function readKey(name) {
    const normalizedName = keyNameOrThrow(name);
    const privateFile = privatePath(normalizedName);
    const publicFile = `${privateFile}.pub`;
    const [privateExists, publicExists] = await Promise.all([exists(privateFile), exists(publicFile)]);
    if (!privateExists && !publicExists) return null;
    let algorithm = "unknown";
    if (publicExists) {
      try {
        const firstLine = (await fsImpl.readFile(publicFile, "utf8")).trim().split(/\s+/)[0];
        algorithm = toPublicAlgorithm(firstLine);
      } catch {
        // The metadata endpoint still reports the key when its public half is unreadable.
      }
    }
    return {
      name: normalizedName,
      algorithm,
      algorithmLabel: KEY_ALGORITHMS[algorithm]?.label || algorithm,
      privateExists,
      publicExists,
      fingerprint: publicExists ? await fingerprint(publicFile) : ""
    };
  }

  async function listKeys() {
    let names = [];
    try {
      names = await fsImpl.readdir(sshDir);
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
    const candidates = new Set();
    for (const name of names) {
      if (name.endsWith(".pub")) {
        const base = name.slice(0, -4);
        if (SAFE_KEY_NAME.test(base) && !RESERVED_SSH_FILES.has(base.toLowerCase())) candidates.add(base);
        continue;
      }
      if (SAFE_KEY_NAME.test(name) && !RESERVED_SSH_FILES.has(name.toLowerCase())) {
        try {
          const header = (await fsImpl.readFile(path.join(sshDir, name), { encoding: "utf8" })).slice(0, 120);
          if (PRIVATE_KEY_HEADER.test(header)) candidates.add(name);
        } catch {
          // Ignore sockets, directories, and files we cannot read.
        }
      }
    }
    const keys = (await Promise.all([...candidates].sort().map(readKey))).filter(Boolean);
    return keys;
  }

  async function readKeyContent(name, kind = "public") {
    const key = await readKey(name);
    if (!key) throw serviceError("SSH Key 不存在", 404);
    if (kind !== "public" && kind !== "private") throw serviceError("不支持的 Key 内容类型");
    const target = kind === "public" ? `${privatePath(name)}.pub` : privatePath(name);
    if (!(await exists(target))) throw serviceError(`SSH ${kind === "public" ? "公钥" : "私钥"}不存在`, 404);
    return { name: key.name, kind, content: await fsImpl.readFile(target, "utf8") };
  }

  async function generateKey({ name = DEFAULT_KEY_NAME, algorithm = "ed25519", comment = "", overwrite = false } = {}) {
    const normalizedName = keyNameOrThrow(name);
    const normalizedAlgorithm = algorithmOrThrow(algorithm);
    const privateFile = privatePath(normalizedName);
    const publicFile = `${privateFile}.pub`;
    if ((await exists(privateFile) || await exists(publicFile)) && !overwrite) {
      throw serviceError("SSH Key 已存在；如需重新生成请确认覆盖", 409);
    }
    await fsImpl.mkdir(sshDir, { recursive: true, mode: 0o700 });
    await fsImpl.chmod(sshDir, 0o700).catch(() => {});
    const temporaryFile = path.join(sshDir, `.${normalizedName}.device-operate-${process.pid}-${Date.now()}`);
    const temporaryPublicFile = `${temporaryFile}.pub`;
    const backupPrivateFile = `${temporaryFile}.previous`;
    const backupPublicFile = `${temporaryPublicFile}.previous`;
    const spec = KEY_ALGORITHMS[normalizedAlgorithm];
    const args = ["-q", "-t", spec.sshType, "-f", temporaryFile, "-N", ""];
    if (spec.defaultBits) args.push("-b", String(spec.defaultBits));
    if (String(comment).trim()) args.push("-C", String(comment).trim().replace(/[\r\n]/g, " "));
    let privateBackedUp = false;
    let publicBackedUp = false;
    let privateInstalled = false;
    let publicInstalled = false;
    try {
      await run("ssh-keygen", args, { timeout: 30_000 });
      await fsImpl.chmod(temporaryFile, 0o600).catch(() => {});
      await fsImpl.chmod(temporaryPublicFile, 0o644).catch(() => {});
      if (!overwrite && (await exists(privateFile) || await exists(publicFile))) {
        throw serviceError("SSH Key 已存在；如需重新生成请确认覆盖", 409);
      }
      if (overwrite && await exists(privateFile)) {
        await fsImpl.rename(privateFile, backupPrivateFile);
        privateBackedUp = true;
      }
      if (overwrite && await exists(publicFile)) {
        await fsImpl.rename(publicFile, backupPublicFile);
        publicBackedUp = true;
      }
      await fsImpl.rename(temporaryFile, privateFile);
      privateInstalled = true;
      await fsImpl.rename(temporaryPublicFile, publicFile);
      publicInstalled = true;
      await Promise.all([
        fsImpl.rm(backupPrivateFile, { force: true }).catch(() => {}),
        fsImpl.rm(backupPublicFile, { force: true }).catch(() => {})
      ]);
    } catch (error) {
      if (privateInstalled) await fsImpl.rm(privateFile, { force: true }).catch(() => {});
      if (publicInstalled) await fsImpl.rm(publicFile, { force: true }).catch(() => {});
      if (privateBackedUp) await fsImpl.rename(backupPrivateFile, privateFile).catch(() => {});
      if (publicBackedUp) await fsImpl.rename(backupPublicFile, publicFile).catch(() => {});
      await Promise.all([
        fsImpl.rm(temporaryFile, { force: true }).catch(() => {}),
        fsImpl.rm(temporaryPublicFile, { force: true }).catch(() => {})
      ]);
      if (error.status) throw error;
      throw serviceError(`SSH Key 生成失败：${error.message}`, 500);
    }
    return readKey(normalizedName);
  }

  async function initialize() {
    const keys = await listKeys();
    if (keys.length) return { created: false, reason: "existing", key: keys[0], keys };
    const key = await generateKey({ name: DEFAULT_KEY_NAME, algorithm: "ed25519", comment: "device-operate" });
    return { created: true, key, keys: [key] };
  }

  async function getState() {
    const rawConfig = await readConfig();
    const parsed = parseSshConfig(rawConfig);
    const keys = await listKeys();
    return {
      directory: sshDir,
      configPath,
      configExists: Boolean(rawConfig),
      config: {
        hosts: parsed.hosts.map((entry) => ({
          host: entry.host,
          patterns: entry.patterns,
          options: entry.options
        })),
        globals: parsed.globals.filter((line) => line.trim())
      },
      keys,
      hasKey: keys.some((key) => key.privateExists || key.publicExists)
    };
  }

  async function createHost({ host, options } = {}) {
    const patterns = normalizeHostPatterns(host);
    const parsed = parseSshConfig(await readConfig());
    if (parsed.hosts.some((entry) => entry.host.toLowerCase() === patterns.join(" ").toLowerCase())) {
      throw serviceError("SSH Host 配置已存在", 409);
    }
    parsed.hosts.push({ host: patterns.join(" "), patterns, options: normalizeOptions(options), modified: true });
    await writeConfig(parsed);
    return getState();
  }

  async function updateHost({ originalHost, host, options } = {}) {
    const oldPatterns = normalizeHostPatterns(originalHost || host);
    const newPatterns = normalizeHostPatterns(host || originalHost);
    const parsed = parseSshConfig(await readConfig());
    const index = parsed.hosts.findIndex((entry) => entry.host.toLowerCase() === oldPatterns.join(" ").toLowerCase());
    if (index < 0) throw serviceError("SSH Host 配置不存在", 404);
    const duplicate = parsed.hosts.some((entry, entryIndex) => entryIndex !== index && entry.host.toLowerCase() === newPatterns.join(" ").toLowerCase());
    if (duplicate) throw serviceError("SSH Host 配置已存在", 409);
    const existing = parsed.hosts[index];
    parsed.hosts[index] = {
      host: newPatterns.join(" "),
      patterns: newPatterns,
      options: normalizeOptions(options),
      comments: existing.comments,
      headerComment: existing.headerComment,
      modified: true
    };
    await writeConfig(parsed);
    return getState();
  }

  async function deleteHost({ host } = {}) {
    const patterns = normalizeHostPatterns(host);
    const parsed = parseSshConfig(await readConfig());
    const index = parsed.hosts.findIndex((entry) => entry.host.toLowerCase() === patterns.join(" ").toLowerCase());
    if (index < 0) throw serviceError("SSH Host 配置不存在", 404);
    parsed.hosts.splice(index, 1);
    await writeConfig(parsed);
    return getState();
  }

  return { getState, initialize, listKeys, readKeyContent, generateKey, createHost, updateHost, deleteHost };
}

export { DEFAULT_KEY_NAME, KEY_ALGORITHMS };
