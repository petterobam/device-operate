// fs / search / bash tools for the Pi agent, with permission confirmation.
//
// Every path is resolved and checked before use: reads and writes stay inside
// the user's home directory, and a deny list keeps private keys and the AI
// credential file out of the model's reach. `run_command` additionally requires
// an explicit destructive permission level, which the runtime enforces through
// the Pi agent's `beforeToolCall` hook.

import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

const MAX_READ_BYTES = 256 * 1024;
const MAX_WRITE_BYTES = 1 * 1024 * 1024;
const MAX_OUTPUT_CHARS = 20_000;
const DEFAULT_COMMAND_TIMEOUT_MS = 30_000;

// Files that must never be readable through a tool call.
const DENY_PATTERNS = [
  /(^|\/)\.config\/device-operate\/ai(-usage)?\.(json|jsonl)$/,
  /(^|\/)\.ssh\/id_[^/]*$/,
  /(^|\/)\.ssh\/.*\.pem$/,
  /(^|\/)Library\/Keychains(\/|$)/,
  /(^|\/)\.gnupg(\/|$)/,
  /(^|\/)\.aws\/credentials$/,
  /(^|\/)\.netrc$/
];

// Command fragments that are never acceptable for an agent-issued shell call.
const DENY_COMMANDS = [
  /\brm\s+-rf?\s+\/(\s|$)/,
  /\bsudo\b/,
  /\bmkfs\b/,
  /\bdiskutil\s+(erase|reformat|partitionDisk)/,
  /\bdd\s+if=/,
  /\bshutdown\b/,
  /\breboot\b/,
  /\bkill(all)?\s+-9\s+1\b/,
  /\blaunchctl\s+(bootout|unload)\s+system/,
  /\bchmod\s+-R\s+777\s+\//,
  /\bcurl\b[^|]*\|\s*(ba)?sh/,
  /\bgit\s+push\s+--force\b/,
  /:\(\)\s*\{/
];

function serviceError(message, status = 400) {
  return Object.assign(new Error(message), { status });
}

export function isDeniedPath(candidate, homeDir) {
  const relative = path.relative(homeDir, candidate).split(path.sep).join("/");
  if (relative.startsWith("..")) return false;
  return DENY_PATTERNS.some((pattern) => pattern.test(relative) || pattern.test(candidate));
}

export function resolveSafePath(input, { homeDir = os.homedir(), mustExist = false } = {}) {
  const raw = String(input ?? "").trim();
  if (!raw) throw serviceError("缺少路径参数");
  const expanded = raw.startsWith("~") ? path.join(homeDir, raw.slice(1)) : raw;
  // Relative paths are always interpreted inside the home directory; the
  // process working directory is never implied.
  const resolved = path.resolve(path.isAbsolute(expanded) ? expanded : path.join(homeDir, expanded));
  const relative = path.relative(homeDir, resolved);
  const insideHome = relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
  const insideTemp = resolved.startsWith(path.resolve(os.tmpdir()));
  if (!insideHome && !insideTemp) {
    throw serviceError("只允许访问用户主目录与临时目录内的路径", 403);
  }
  if (isDeniedPath(resolved, homeDir)) {
    throw serviceError("该路径受保护，不允许通过工具访问", 403);
  }
  if (mustExist) {
    // Access errors surface as ENOENT inside the tool, which is the desired signal.
    return resolved;
  }
  return resolved;
}

export function assertCommandAllowed(command) {
  const text = String(command ?? "").trim();
  if (!text) throw serviceError("缺少要执行的命令");
  const denied = DENY_COMMANDS.find((pattern) => pattern.test(text));
  if (denied) throw serviceError("该命令被安全策略拒绝", 403);
  return text;
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function truncate(text, limit = MAX_OUTPUT_CHARS) {
  const value = String(text ?? "");
  return value.length > limit ? `${value.slice(0, limit)}\n…（输出已截断）` : value;
}

export function createSystemTools({
  homeDir = os.homedir(),
  run = execFileAsync,
  maxReadBytes = MAX_READ_BYTES,
  commandTimeoutMs = DEFAULT_COMMAND_TIMEOUT_MS
} = {}) {
  const tools = [
    {
      name: "read_file",
      title: "读取文件",
      description: "读取用户主目录下的文本文件内容，可指定起始行与行数。",
      risk: "read",
      summarize: (data) => `${data.path} 共 ${data.totalLines} 行，返回 ${data.lines} 行`,
      inputSchema: {
        type: "object",
        required: ["path"],
        properties: {
          path: { type: "string", description: "文件路径，支持 ~ 前缀" },
          offset: { type: "number", description: "起始行（从 1 开始）" },
          limit: { type: "number", description: "读取行数，默认 200" }
        }
      },
      async execute(input) {
        const target = resolveSafePath(input?.path, { homeDir, mustExist: true });
        const stat = await fs.stat(target).catch(() => null);
        if (!stat) throw serviceError(`文件不存在：${target}`, 404);
        if (stat.isDirectory()) throw serviceError("目标是目录，请使用 list_directory");
        if (stat.size > maxReadBytes) throw serviceError(`文件超过 ${Math.round(maxReadBytes / 1024)} KB，请改用 search_files 或指定更小范围`, 413);
        const content = await fs.readFile(target, "utf8");
        const all = content.split("\n");
        const offset = clamp(Number(input?.offset) || 1, 1, Math.max(1, all.length));
        const limit = clamp(Number(input?.limit) || 200, 1, 2000);
        const slice = all.slice(offset - 1, offset - 1 + limit);
        return {
          path: target,
          bytes: stat.size,
          totalLines: all.length,
          lines: slice.length,
          offset,
          content: truncate(slice.join("\n"))
        };
      }
    },
    {
      name: "list_directory",
      title: "列出目录",
      description: "列出用户主目录下某个目录的文件与子目录，含体积与修改时间。",
      risk: "read",
      summarize: (data) => `${data.path} 下 ${data.entries.length} 项`,
      inputSchema: {
        type: "object",
        required: ["path"],
        properties: {
          path: { type: "string" },
          depth: { type: "number", description: "递归深度 1-3，默认 1" },
          includeHidden: { type: "boolean" }
        }
      },
      async execute(input) {
        const target = resolveSafePath(input?.path, { homeDir, mustExist: true });
        const depth = clamp(Number(input?.depth) || 1, 1, 3);
        const includeHidden = input?.includeHidden === true;
        const entries = [];

        async function walk(dir, level) {
          const names = await fs.readdir(dir).catch(() => []);
          for (const name of names) {
            if (!includeHidden && name.startsWith(".") && level === 0) continue;
            const full = path.join(dir, name);
            if (isDeniedPath(full, homeDir)) continue;
            const stat = await fs.stat(full).catch(() => null);
            if (!stat) continue;
            entries.push({
              name,
              path: full,
              kind: stat.isDirectory() ? "directory" : "file",
              bytes: stat.size,
              modifiedAt: stat.mtime.toISOString()
            });
            if (stat.isDirectory() && level + 1 < depth) await walk(full, level + 1);
            if (entries.length > 500) return;
          }
        }

        await walk(target, 0);
        return { path: target, depth, entries: entries.slice(0, 500), truncated: entries.length > 500 };
      }
    },
    {
      name: "search_files",
      title: "搜索文件内容",
      description: "在主目录下按文本或文件名搜索，返回匹配的文件与行号。",
      risk: "read",
      summarize: (data) => `在 ${data.scope} 中找到 ${data.matches.length} 条匹配`,
      inputSchema: {
        type: "object",
        required: ["query"],
        properties: {
          query: { type: "string", description: "要搜索的文本" },
          path: { type: "string", description: "搜索范围，默认用户主目录" },
          mode: { type: "string", enum: ["content", "filename"], description: "默认按内容搜索" },
          maxResults: { type: "number", description: "默认 40" }
        }
      },
      async execute(input) {
        const query = String(input?.query ?? "").trim();
        if (!query) throw serviceError("缺少搜索关键词");
        const scope = input?.path ? resolveSafePath(input.path, { homeDir }) : homeDir;
        const maxResults = clamp(Number(input?.maxResults) || 40, 1, 200);
        const mode = input?.mode === "filename" ? "filename" : "content";

        const rg = await run("which", ["rg"], { timeout: 5000 }).then(({ stdout }) => stdout.trim()).catch(() => "");
        const args = mode === "filename"
          ? ["--files", "--glob", `*${query}*`, "--max-count", "1"]
          : ["--line-number", "--no-heading", "--color", "never", "--max-count", "5", query];
        const list = mode === "filename" ? ["--files", `*${query}*`] : args;

        const result = await run(rg || "grep", rg ? [...list, scope] : ["-rn", "--max-count=5", query, scope], {
          timeout: 30_000,
          maxBuffer: 8 * 1024 * 1024
        }).catch((error) => ({ stdout: error.stdout || "" }));

        const matches = String(result.stdout)
          .split("\n")
          .filter(Boolean)
          .map((line) => {
            const [file, lineNumber, ...rest] = line.split(":");
            return mode === "filename"
              ? { file: line }
              : { file, line: Number(lineNumber) || null, text: truncate(rest.join(":"), 400) };
          })
          .filter((entry) => !entry.file || !isDeniedPath(path.resolve(entry.file), homeDir))
          .slice(0, maxResults);

        return { query, scope, mode, engine: rg ? "rg" : "grep", matches };
      }
    },
    {
      name: "write_file",
      title: "写入文件",
      description: "在用户主目录下创建或覆盖文本文件，可选自动创建父目录。属于写操作。",
      risk: "write",
      summarize: (data) => `已写入 ${data.path}（${data.bytes} 字节，${data.created ? "新建" : "覆盖"}）`,
      inputSchema: {
        type: "object",
        required: ["path", "content"],
        properties: {
          path: { type: "string" },
          content: { type: "string" },
          createParents: { type: "boolean", description: "默认 true" }
        }
      },
      async execute(input) {
        const target = resolveSafePath(input?.path, { homeDir });
        const content = String(input?.content ?? "");
        if (Buffer.byteLength(content) > MAX_WRITE_BYTES) throw serviceError("单次写入上限 1 MB", 413);
        const existed = await fs.access(target).then(() => true, () => false);
        if (!existed && input?.createParents !== false) await fs.mkdir(path.dirname(target), { recursive: true });
        await fs.writeFile(target, content, "utf8");
        const stat = await fs.stat(target);
        return { path: target, bytes: stat.size, created: !existed };
      }
    },
    {
      name: "run_command",
      title: "执行命令",
      description: "在主目录下执行 shell 命令并返回输出。属于破坏性操作，需要显式授权与确认。",
      risk: "destructive",
      summarize: (data) => `命令退出码 ${data.exitCode}：${truncate(data.stdout || data.stderr || "", 160)}`,
      inputSchema: {
        type: "object",
        required: ["command"],
        properties: {
          command: { type: "string", description: "要执行的命令" },
          cwd: { type: "string", description: "工作目录，默认用户主目录" },
          timeoutMs: { type: "number", description: "超时，默认 30000" }
        }
      },
      async execute(input) {
        const command = assertCommandAllowed(input?.command);
        const cwd = input?.cwd ? resolveSafePath(input.cwd, { homeDir }) : homeDir;
        const timeout = clamp(Number(input?.timeoutMs) || commandTimeoutMs, 1000, 300_000);
        const result = await run("/bin/zsh", ["-lc", command], { cwd, timeout, maxBuffer: 8 * 1024 * 1024 })
          .then(({ stdout, stderr }) => ({ exitCode: 0, stdout: stdout || "", stderr: stderr || "" }))
          .catch((error) => ({
            exitCode: typeof error.code === "number" ? error.code : 1,
            stdout: error.stdout || "",
            stderr: error.stderr || error.message
          }));
        return {
          command,
          cwd,
          exitCode: result.exitCode,
          stdout: truncate(result.stdout),
          stderr: truncate(result.stderr)
        };
      }
    }
  ];

  return {
    tools,
    resolveSafePath: (input) => resolveSafePath(input, { homeDir }),
    homeDir
  };
}

export const SYSTEM_TOOL_LIMITS = { MAX_READ_BYTES, MAX_WRITE_BYTES, MAX_OUTPUT_CHARS, DEFAULT_COMMAND_TIMEOUT_MS };
