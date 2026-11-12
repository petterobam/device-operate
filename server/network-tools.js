// Network diagnostics: connectivity checks, DNS, listening ports, proxy state
// and a bandwidth probe. All targets are validated before being passed to a
// command, so arbitrary shell input can never reach the shell.

import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

const HOST_PATTERN = /^(?=.{1,253}$)([A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?\.)*[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?$/;
const IP_PATTERN = /^[0-9a-fA-F.:]+$/;
const SPEED_TEST_URL = "https://speed.cloudflare.com/__down?bytes=25000000";

function serviceError(message, status = 400) {
  return Object.assign(new Error(message), { status });
}

export function normalizeHost(value) {
  const host = String(value ?? "").trim();
  if (!host) throw serviceError("请提供要检测的主机名或 IP");
  const withoutScheme = host.replace(/^[a-z]+:\/\//i, "").split("/")[0].split("@").pop();
  const withoutPort = withoutScheme.replace(/:\d+$/, "");
  if (IP_PATTERN.test(withoutPort) && withoutPort.includes(".")) return withoutPort;
  if (!HOST_PATTERN.test(withoutPort)) throw serviceError("主机名格式不合法");
  return withoutPort;
}

export function normalizePort(value) {
  if (value === undefined || value === null || value === "") return null;
  const port = Number(value);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw serviceError("端口必须是 1-65535 之间的整数");
  return port;
}

export function parsePing(output = "") {
  const text = String(output);
  const transmitted = Number(text.match(/(\d+) packets transmitted/)?.[1] ?? 0);
  const received = Number(text.match(/(\d+) packets received/)?.[1] ?? 0);
  const loss = text.match(/([\d.]+)% packet loss/)?.[1];
  const rtt = text.match(/=\s*([\d.]+)\/([\d.]+)\/([\d.]+)\/([\d.]+)\s*ms/);
  const perPacket = [...text.matchAll(/icmp_seq[= ](\d+).*?time[=<]([\d.]+)\s*ms/g)].map((match) => ({
    sequence: Number(match[1]),
    ms: Number(match[2])
  }));
  return {
    transmitted,
    received,
    packetLossPercent: loss !== undefined ? Number(loss) : transmitted ? Math.round(((transmitted - received) / transmitted) * 1000) / 10 : null,
    minMs: rtt ? Number(rtt[1]) : null,
    avgMs: rtt ? Number(rtt[2]) : null,
    maxMs: rtt ? Number(rtt[3]) : null,
    stddevMs: rtt ? Number(rtt[4]) : null,
    samples: perPacket,
    reachable: received > 0
  };
}

export function parseDig(output = "") {
  return String(output)
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => (line.endsWith(".") ? line.slice(0, -1) : line));
}

export function parseListeningPorts(output = "") {
  const entries = [];
  for (const line of String(output).split("\n").slice(1)) {
    if (!line.trim()) continue;
    const parts = line.trim().split(/\s+/);
    if (parts.length < 9) continue;
    const [command, pid, user] = parts;
    // lsof prints the address as the token containing "host:port"; the trailing
    // "(LISTEN)" token must be ignored.
    const addressToken = parts.find((part) => part.includes(":") && /:(\d+)$/.test(part)) || "";
    const port = Number(addressToken.split(":").pop());
    entries.push({
      command,
      pid: Number(pid) || null,
      user,
      protocol: line.includes("IPv6") ? "IPv6" : "IPv4",
      address: addressToken,
      port: Number.isFinite(port) ? port : null
    });
  }
  return entries;
}

export function parseTraceroute(output = "") {
  return String(output)
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith("traceroute to"))
    .map((line) => {
      const hop = Number(line.match(/^(\d+)/)?.[1]);
      const address = line.match(/(\d{1,3}(?:\.\d{1,3}){3}|[0-9a-f:]{4,})/)?.[1] || "";
      const times = [...line.matchAll(/([\d.]+)\s*ms/g)].map((match) => Number(match[1]));
      return { hop: Number.isFinite(hop) ? hop : null, address, times, raw: line };
    });
}

function formatDurationMs(seconds) {
  return Number((seconds * 1000).toFixed(0));
}

export function createNetworkToolService({
  run = execFileAsync,
  speedTestUrl = SPEED_TEST_URL,
  platform = process.platform
} = {}) {
  async function ping({ host, count = 4 } = {}) {
    const target = normalizeHost(host);
    const packets = Math.max(1, Math.min(10, Number(count) || 4));
    const result = await run("ping", ["-c", String(packets), "-W", "2000", target], {
      timeout: 30_000,
      maxBuffer: 2 * 1024 * 1024
    }).catch((error) => ({ stdout: error.stdout || "", stderr: error.stderr || error.message }));
    return { host: target, packets, ...parsePing(result.stdout || result.stderr) };
  }

  async function traceroute({ host, maxHops = 12 } = {}) {
    const target = normalizeHost(host);
    const hops = Math.max(1, Math.min(30, Number(maxHops) || 12));
    const result = await run("traceroute", ["-m", String(hops), "-w", "2", "-q", "1", target], {
      timeout: 60_000,
      maxBuffer: 4 * 1024 * 1024
    }).catch((error) => ({ stdout: error.stdout || "", stderr: error.stderr || error.message }));
    return { host: target, maxHops: hops, hops: parseTraceroute(result.stdout || result.stderr) };
  }

  async function dnsLookup({ host, record = "A" } = {}) {
    const target = normalizeHost(host);
    const type = ["A", "AAAA", "CNAME", "MX", "TXT", "NS"].includes(String(record).toUpperCase()) ? String(record).toUpperCase() : "A";
    const [answer, reverse] = await Promise.all([
      run("dig", ["+short", type, target], { timeout: 15_000, maxBuffer: 512 * 1024 }).catch((error) => ({ stdout: error.stderr || "" })),
      run("dig", ["+short", "-x", target], { timeout: 15_000, maxBuffer: 512 * 1024 }).catch(() => ({ stdout: "" }))
    ]);
    return { host: target, record: type, answers: parseDig(answer.stdout), reverse: parseDig(reverse.stdout) };
  }

  async function checkPort({ host, port, timeoutMs = 3000 } = {}) {
    const target = normalizeHost(host);
    const targetPort = normalizePort(port);
    if (!targetPort) throw serviceError("请提供要检测的端口");
    const started = Date.now();
    const reachable = await new Promise((resolve) => {
      import("node:net").then(({ Socket }) => {
        const socket = new Socket();
        const finish = (value) => {
          socket.removeAllListeners();
          socket.destroy();
          resolve(value);
        };
        socket.setTimeout(timeoutMs);
        socket.once("connect", () => finish(true));
        socket.once("timeout", () => finish(false));
        socket.once("error", () => finish(false));
        socket.connect(targetPort, target);
      });
    });
    return { host: target, port: targetPort, reachable, elapsedMs: Date.now() - started };
  }

  async function listListeningPorts() {
    const result = await run("/bin/zsh", ["-lc", "lsof -nP -iTCP -sTCP:LISTEN 2>/dev/null | head -200"], {
      timeout: 20_000,
      maxBuffer: 2 * 1024 * 1024
    }).catch((error) => ({ stdout: error.stdout || "" }));
    const entries = parseListeningPorts(result.stdout);
    return {
      entries,
      summary: {
        total: entries.length,
        loopbackOnly: entries.filter((entry) => /127\.0\.0\.1|\[::1\]/.test(entry.address)).length,
        exposed: entries.filter((entry) => !/127\.0\.0\.1|\[::1\]/.test(entry.address)).length
      }
    };
  }

  async function proxyState() {
    const servicesResult = await run("networksetup", ["-listallnetworkservices"], { timeout: 10_000, maxBuffer: 256 * 1024 })
      .catch(() => ({ stdout: "" }));
    const services = servicesResult.stdout
      .split("\n")
      .slice(1)
      .map((line) => line.replace(/^\*/, "").trim())
      .filter(Boolean)
      .slice(0, 6);
    const proxies = [];
    for (const service of services) {
      const [web, secure, auto] = await Promise.all([
        run("networksetup", ["-getwebproxy", service], { timeout: 8000 }).catch(() => ({ stdout: "" })),
        run("networksetup", ["-getsecurewebproxy", service], { timeout: 8000 }).catch(() => ({ stdout: "" })),
        run("networksetup", ["-getautoproxyurl", service], { timeout: 8000 }).catch(() => ({ stdout: "" }))
      ]);
      const read = (output, key) => output.split("\n").find((line) => line.startsWith(`${key}:`))?.split(":").slice(1).join(":").trim() || "";
      proxies.push({
        service,
        http: { enabled: read(web.stdout, "Enabled") === "Yes", server: read(web.stdout, "Server"), port: read(web.stdout, "Port") },
        https: { enabled: read(secure.stdout, "Enabled") === "Yes", server: read(secure.stdout, "Server"), port: read(secure.stdout, "Port") },
        auto: { enabled: read(auto.stdout, "Enabled") === "Yes", url: read(auto.stdout, "URL") }
      });
    }
    return { services, proxies, platform };
  }

  async function speedTest({ bytes = 25_000_000 } = {}) {
    const size = Math.max(1_000_000, Math.min(100_000_000, Number(bytes) || 25_000_000));
    const url = speedTestUrl.includes("bytes=") ? speedTestUrl.replace(/bytes=\d+/, `bytes=${size}`) : speedTestUrl;
    const started = Date.now();
    const result = await run("curl", ["-sSL", "-o", "/dev/null", "-w", "%{size_download} %{time_total} %{speed_download} %{http_code}", url], {
      timeout: 90_000,
      maxBuffer: 256 * 1024
    }).catch((error) => ({ stdout: "", stderr: error.message }));
    if (!result.stdout) throw serviceError(`测速失败：${result.stderr || "无法连接测速服务"}`, 502);
    const [downloaded, seconds, speed, status] = String(result.stdout).trim().split(/\s+/);
    const total = Number(seconds);
    const bytesPerSecond = Number(speed) || (total > 0 ? Number(downloaded) / total : 0);
    return {
      url,
      statusCode: Number(status) || null,
      bytesDownloaded: Number(downloaded) || 0,
      elapsedMs: formatDurationMs(total),
      megabytesPerSecond: Number((bytesPerSecond / 1024 / 1024).toFixed(2)),
      megabitsPerSecond: Number(((bytesPerSecond * 8) / 1_000_000).toFixed(2)),
      measuredAt: new Date(started).toISOString()
    };
  }

  return { ping, traceroute, dnsLookup, checkPort, listListeningPorts, proxyState, speedTest };
}
