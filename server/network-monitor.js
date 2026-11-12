// Read-only network footprint monitor.
//
// The collector combines two local sources:
//   1. macOS lsof socket ownership, which identifies processes and active peers.
//   2. Clash/Mihomo's local connections API, when present, which recovers the
//      final destination hidden behind a loopback proxy.
//
// It never captures payloads. Public IP geolocation is optional and results are
// cached under ~/.config/device-operate.

import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import http from "node:http";
import dns from "node:dns/promises";
import net from "node:net";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { extractApplicationPath } from "./applications.js";

const execFileAsync = promisify(execFile);
const DEFAULT_INTERVAL_MS = 5_000;
const DEFAULT_RETENTION_MINUTES = 10;
const DEFAULT_GEO_URL = "https://ipwho.is";
const GEO_FIELDS = "success,message,ip,country,country_code,region,region_code,city,latitude,longitude,connection,timezone";
const GEO_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const GEO_ERROR_TTL_MS = 60 * 60 * 1000;
const SELF_GEO_TTL_MS = 24 * 60 * 60 * 1000;
const PROCESS_TTL_MS = 15_000;
const PROXY_DISCOVERY_TTL_MS = 30_000;

function number(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function cleanName(value) {
  return String(value || "").replace(/\\([0-7]{3})/g, (_match, octal) => String.fromCharCode(Number.parseInt(octal, 8)));
}

export function splitEndpoint(value) {
  const endpoint = String(value || "").trim();
  if (!endpoint || endpoint === "*" || endpoint === "*:*") return { address: "*", port: null };
  const wildcard = endpoint.match(/^\*:(\d+|\*)$/);
  if (wildcard) return { address: "*", port: wildcard[1] === "*" ? null : Number(wildcard[1]) };
  const bracketed = endpoint.match(/^\[([^\]]+)\]:(\d+|\*)$/);
  if (bracketed) return { address: bracketed[1], port: bracketed[2] === "*" ? null : Number(bracketed[2]) };
  const separator = endpoint.lastIndexOf(":");
  if (separator > 0) {
    const address = endpoint.slice(0, separator);
    const portText = endpoint.slice(separator + 1);
    return {
      address,
      port: /^\d+$/.test(portText) ? Number(portText) : null
    };
  }
  return { address: endpoint, port: null };
}

export function parseLsofFields(output) {
  const records = [];
  let pid = null;
  let command = "";
  let fd = null;

  const flush = () => {
    if (!fd || !fd.name || pid === null) return;
    records.push({
      pid,
      command: cleanName(command),
      fd: fd.fd || "",
      protocol: fd.protocol || "",
      name: fd.name,
      state: fd.state || ""
    });
  };

  for (const rawLine of String(output || "").split("\n")) {
    if (!rawLine) continue;
    const type = rawLine[0];
    const value = rawLine.slice(1);
    if (type === "p") {
      flush();
      fd = null;
      pid = /^\d+$/.test(value) ? Number(value) : null;
      command = "";
      continue;
    }
    if (pid === null) continue;
    if (type === "c") {
      command = value;
      continue;
    }
    if (type === "f") {
      flush();
      fd = { fd: value, protocol: "", name: "", state: "" };
      continue;
    }
    if (!fd) continue;
    if (type === "P") fd.protocol = value.toUpperCase();
    else if (type === "n") fd.name = value;
    else if (rawLine.startsWith("TST=")) fd.state = rawLine.slice(4);
  }
  flush();
  return records;
}

export function parsePsOutput(output) {
  const processes = new Map();
  for (const line of String(output || "").split("\n")) {
    const match = line.match(/^\s*(\d+)\s+(.+)$/);
    if (!match) continue;
    processes.set(Number(match[1]), match[2].trim());
  }
  return processes;
}

export function isPrivateAddress(address) {
  const raw = String(address || "").replace(/^\[|\]$/g, "").split("%")[0].toLowerCase();
  const version = net.isIP(raw);
  if (!version) return false;
  if (version === 6) {
    if (raw === "::" || raw === "::1") return true;
    if (raw.startsWith("fe8") || raw.startsWith("fe9") || raw.startsWith("fea") || raw.startsWith("feb")) return true;
    if (/^f[cd][0-9a-f]{2}:/.test(raw)) return true;
    if (raw.startsWith("ff")) return true;
    const mapped = raw.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
    if (mapped) return isPrivateAddress(mapped[1]);
    return false;
  }
  const octets = raw.split(".").map(Number);
  const [a, b] = octets;
  return a === 0 || a === 10 || a === 127 || (a === 169 && b === 254)
    || (a === 172 && b >= 16 && b <= 31)
    || (a === 192 && b === 168)
    || (a === 100 && b >= 64 && b <= 127)
    || (a >= 224 && a <= 239);
}

export function isPublicAddress(address) {
  return Boolean(net.isIP(String(address || "").replace(/^\[|\]$/g, ""))) && !isPrivateAddress(address);
}

export function classifyAddress(address) {
  const raw = String(address || "").replace(/^\[|\]$/g, "").split("%")[0];
  if (!raw || raw === "*") return "unknown";
  if (raw === "::1" || raw.startsWith("127.")) return "loopback";
  if (net.isIP(raw)) return isPrivateAddress(raw) ? "private" : "public";
  return "hostname";
}

export function applicationNameForProcess(command, processName = "") {
  const raw = String(command || processName || "").trim();
  const appPath = extractApplicationPath(raw);
  if (appPath) return path.basename(appPath, ".app");

  // CoreSimulator runtime processes live under a path such as
  // ".../Runtimes/iOS 18.5.simruntime/.../cloudd". The runtime name contains
  // a space, so splitting the command at whitespace would incorrectly label
  // the whole app as just "iOS". Keep the simulator context explicit instead.
  const simulator = raw.match(/\/Runtimes\/([^/]+)\.simruntime\/Contents\//i);
  if (simulator) return `${simulator[1]} 模拟器`;

  const looksLikeExactPath = raw.startsWith("/") && !/\s+--?/.test(raw);
  const executable = looksLikeExactPath ? raw : raw.split(/\s+/)[0];
  const base = path.basename(executable || processName || "未知进程");
  return base || processName || "未知进程";
}

export function isProxyProcess(command, applicationName = "") {
  return /(?:^|[\s/])(clash|mihomo|surge|sing-box|v2ray|xray|shadowsocks|trojan)(?:[\s/]|$)/i.test(String(command || ""))
    || /clash|mihomo|sing-box|v2ray/i.test(String(applicationName || ""));
}

export function discoverMihomoSocket(output) {
  const text = String(output || "");
  const patterns = [
    /-ext-ctl-unix\s+("[^"]+"|'[^']+'|\S+)/,
    /-external-controller-unix\s+("[^"]+"|'[^']+'|\S+)/,
    /-ext-ctl\s+unix:\/\/(\S+)/
  ];
  for (const pattern of patterns) {
    const match = text.match(pattern);
    if (match) return match[1].replace(/^['"]|['"]$/g, "").replace(/^unix:\/\//, "");
  }
  return "";
}

function requestUnixJson(socketPath, requestPath = "/connections", timeoutMs = 2_500) {
  return new Promise((resolve, reject) => {
    const request = http.request({
      socketPath,
      path: requestPath,
      method: "GET",
      timeout: timeoutMs,
      headers: { Accept: "application/json" }
    }, (response) => {
      let body = "";
      response.setEncoding("utf8");
      response.on("data", (chunk) => { body += chunk; });
      response.on("end", () => {
        if ((response.statusCode || 500) >= 400) return reject(new Error(`代理 API 返回 HTTP ${response.statusCode}`));
        try {
          resolve(JSON.parse(body));
        } catch {
          reject(new Error("代理 API 返回了无法解析的数据"));
        }
      });
    });
    request.on("timeout", () => request.destroy(new Error("代理 API 请求超时")));
    request.on("error", reject);
    request.end();
  });
}

export function parseMihomoConnections(payload) {
  const connections = Array.isArray(payload?.connections) ? payload.connections : [];
  return connections.map((entry) => {
    const metadata = entry.metadata || {};
    const processPath = String(metadata.processPath || "");
    const applicationName = applicationNameForProcess(processPath, metadata.process || "");
    return {
      hasProcess: Boolean(processPath || metadata.process),
      id: String(entry.id || ""),
      applicationName,
      processName: String(metadata.process || applicationName),
      processPath,
      sourceAddress: String(metadata.sourceIP || ""),
      sourcePort: number(metadata.sourcePort),
      inboundPort: number(metadata.inboundPort),
      remoteAddress: String(metadata.remoteDestination || metadata.destinationIP || ""),
      host: String(metadata.host || metadata.sniffHost || ""),
      remotePort: number(metadata.destinationPort),
      protocol: String(metadata.network || "tcp").toUpperCase(),
      state: "PROXY",
      route: Array.isArray(entry.chains) ? entry.chains.filter(Boolean).join(" → ") : "",
      rule: String(entry.rule || ""),
      rulePayload: String(entry.rulePayload || ""),
      uploadBytes: Number(entry.upload) || 0,
      downloadBytes: Number(entry.download) || 0,
      startedAt: entry.start || null
    };
  }).filter((entry) => entry.hasProcess && (entry.remoteAddress || entry.host));
}

export function buildSystemFlows({ records, processes = new Map(), proxyPorts = new Set(), clashSourcePorts = new Set(), proxyAvailable = false }) {
  const listenersByPid = new Map();
  const listenersByPort = new Map();
  for (const record of records) {
    if (record.state !== "LISTEN" || !record.protocol.startsWith("TCP")) continue;
    const local = splitEndpoint(record.name);
    if (!local.port) continue;
    if (!listenersByPid.has(record.pid)) listenersByPid.set(record.pid, new Set());
    listenersByPid.get(record.pid).add(local.port);
    if (!listenersByPort.has(local.port)) listenersByPort.set(local.port, new Set());
    listenersByPort.get(local.port).add(record.pid);
  }

  const flows = [];
  for (const record of records) {
    const [localText, remoteText] = String(record.name || "").split("->");
    const local = splitEndpoint(localText);
    const remote = splitEndpoint(remoteText || "");
    const command = processes.get(record.pid) || record.command;
    const applicationName = applicationNameForProcess(command, record.command);
    const listening = record.state === "LISTEN";
    const localPortListening = Boolean(local.port && listenersByPid.get(record.pid)?.has(local.port));
    const inbound = listening || localPortListening;
    const direction = listening ? "listener" : inbound ? "inbound" : "outbound";

    if (!listening && !remoteText) continue;
    if (listening && !local.port) continue;
    if (proxyAvailable && isProxyProcess(command, applicationName)) continue;
    if (clashSourcePorts.has(local.port)) continue;
    if (remoteText && remote.port && proxyPorts.has(remote.port) && classifyAddress(remote.address) !== "public") continue;

    const remoteAddress = remote.address === "*" ? "" : remote.address;
    flows.push({
      key: `system:${direction}:${record.pid}:${record.protocol}:${local.address}:${local.port || 0}:${remoteAddress}:${remote.port || 0}`,
      direction,
      source: "system",
      applicationName,
      processName: path.basename(command || "") || record.command || "未知进程",
      processPath: command,
      pid: record.pid,
      protocol: record.protocol || "",
      localAddress: local.address,
      localPort: local.port,
      remoteAddress,
      remotePort: remote.port,
      state: record.state || "",
      host: "",
      route: "",
      rule: "",
      uploadBytes: 0,
      downloadBytes: 0,
      listener: listening
    });
  }
  return flows;
}

export function buildProxyFlows(proxyEntries, systemFlows = []) {
  const bySourcePort = new Map();
  for (const flow of systemFlows) {
    if (flow.direction === "outbound" && flow.localPort) bySourcePort.set(flow.localPort, flow);
  }
  const grouped = new Map();
  for (const entry of proxyEntries) {
    const linked = bySourcePort.get(entry.sourcePort);
    const remoteAddress = entry.remoteAddress || "";
    const key = `proxy:${entry.applicationName}:${entry.remoteAddress}:${entry.host}:${entry.remotePort}:${entry.protocol}`;
    const existing = grouped.get(key);
    if (existing) {
      existing.uploadBytes += entry.uploadBytes || 0;
      existing.downloadBytes += entry.downloadBytes || 0;
      existing.connectionCount += 1;
      if (!existing.hosts.includes(entry.host) && entry.host) existing.hosts.push(entry.host);
      continue;
    }
    grouped.set(key, {
      key,
      direction: "outbound",
      source: "proxy",
      applicationName: entry.applicationName,
      processName: entry.processName,
      processPath: entry.processPath || linked?.processPath || "",
      pid: linked?.pid || null,
      protocol: entry.protocol,
      localAddress: linked?.localAddress || entry.sourceAddress || "",
      localPort: entry.sourcePort,
      remoteAddress,
      remotePort: entry.remotePort,
      state: entry.state,
      host: entry.host,
      hosts: entry.host ? [entry.host] : [],
      route: entry.route,
      rule: entry.rule,
      rulePayload: entry.rulePayload,
      uploadBytes: entry.uploadBytes || 0,
      downloadBytes: entry.downloadBytes || 0,
      listener: false,
      connectionCount: 1
    });
  }
  return [...grouped.values()];
}

function dedupeFlows(flows) {
  const merged = new Map();
  for (const flow of flows) {
    const key = flow.direction === "listener"
      ? `listener:${flow.pid}:${flow.protocol}:${flow.localAddress}:${flow.localPort}`
      : `${flow.source}:${flow.direction}:${flow.applicationName}:${flow.remoteAddress || flow.host}:${flow.remotePort}:${flow.protocol}`;
    const existing = merged.get(key);
    if (!existing) {
      merged.set(key, { ...flow, key, connectionCount: flow.connectionCount || 1 });
      continue;
    }
    existing.connectionCount += flow.connectionCount || 1;
    existing.uploadBytes += flow.uploadBytes || 0;
    existing.downloadBytes += flow.downloadBytes || 0;
    if (!existing.host && flow.host) existing.host = flow.host;
  }
  return [...merged.values()];
}

export function aggregateNetwork(flows, { scoredAt = new Date().toISOString(), retentionMinutes = DEFAULT_RETENTION_MINUTES } = {}) {
  const cutoff = new Date(scoredAt).getTime() - retentionMinutes * 60_000;
  const visible = flows.filter((flow) => {
    if (!flow.firstSeen && !flow.lastSeen) return true;
    return new Date(flow.lastSeen || flow.firstSeen).getTime() >= cutoff;
  });

  const appMap = new Map();
  const regionMap = new Map();
  const countryMap = new Map();
  const mapPoints = new Map();
  let publicFlows = 0;
  let geolocatedFlows = 0;
  let pendingFlows = 0;

  for (const flow of visible) {
    if (flow.listener || flow.direction === "listener") continue;
    const direction = flow.direction === "inbound" ? "inbound" : "outbound";
    const appKey = flow.applicationName || flow.processName || "未知进程";
    const app = appMap.get(appKey) || {
      name: appKey,
      processPath: flow.processPath || "",
      outbound: 0,
      inbound: 0,
      total: 0,
      public: 0,
      countries: new Set(),
      countryCodes: new Set(),
      regions: new Set()
    };
    app[direction] += flow.connectionCount || 1;
    app.total += flow.connectionCount || 1;
    appMap.set(appKey, app);

    const classification = classifyAddress(flow.remoteAddress);
    if (classification !== "public") continue;
    publicFlows += 1;
    app.public += 1;

    const geo = flow.geo;
    if (!geo || geo.success === false) {
      pendingFlows += 1;
      continue;
    }
    geolocatedFlows += 1;
    const country = geo.country || "未知国家";
    const countryCode = geo.countryCode || geo.country_code || "";
    const region = geo.region || geo.regionName || "未知地区";
    const city = geo.city || "";
    const countryKey = countryCode || country;
    const regionKey = `${countryKey}:${region}`;
    app.countries.add(country);
    app.countryCodes.add(countryCode);
    app.regions.add(`${country} · ${region}`);

    const countryEntry = countryMap.get(countryKey) || {
      country,
      countryCode,
      total: 0,
      outbound: 0,
      inbound: 0,
      applications: new Set(),
      ips: new Set(),
      regions: new Set()
    };
    countryEntry[direction] += flow.connectionCount || 1;
    countryEntry.total += flow.connectionCount || 1;
    countryEntry.applications.add(appKey);
    countryEntry.ips.add(flow.remoteAddress);
    countryEntry.regions.add(region);
    countryMap.set(countryKey, countryEntry);

    const regionEntry = regionMap.get(regionKey) || {
      country,
      countryCode,
      region,
      city,
      latitude: number(geo.latitude ?? geo.lat),
      longitude: number(geo.longitude ?? geo.lon),
      outbound: 0,
      inbound: 0,
      total: 0,
      applications: new Set(),
      ips: new Set()
    };
    regionEntry[direction] += flow.connectionCount || 1;
    regionEntry.total += flow.connectionCount || 1;
    regionEntry.applications.add(appKey);
    regionEntry.ips.add(flow.remoteAddress);
    regionMap.set(regionKey, regionEntry);

    if (Number.isFinite(regionEntry.latitude) && Number.isFinite(regionEntry.longitude)) {
      const point = mapPoints.get(regionKey) || {
        id: regionKey,
        country: regionEntry.country,
        countryCode: regionEntry.countryCode,
        region: regionEntry.region,
        city: regionEntry.city,
        latitude: regionEntry.latitude,
        longitude: regionEntry.longitude,
        outbound: 0,
        inbound: 0,
        total: 0,
        applications: new Set(),
        ips: new Set()
      };
      point[direction] += flow.connectionCount || 1;
      point.total += flow.connectionCount || 1;
      point.applications.add(appKey);
      point.ips.add(flow.remoteAddress);
      mapPoints.set(regionKey, point);
    }
  }

  const serialiseSet = (value) => [...value].sort((a, b) => String(a).localeCompare(String(b), "zh-CN"));
  const countFlows = (predicate) => visible.filter(predicate).reduce((sum, flow) => sum + (flow.connectionCount || 1), 0);
  return {
    visibleFlows: visible,
    summary: {
      total: countFlows((flow) => !flow.listener && flow.direction !== "listener"),
      outbound: countFlows((flow) => flow.direction === "outbound"),
      inbound: countFlows((flow) => flow.direction === "inbound"),
      listeners: countFlows((flow) => flow.direction === "listener" || flow.listener),
      publicFlows,
      geolocatedFlows,
      pendingFlows,
      applications: appMap.size,
      countries: countryMap.size,
      regions: regionMap.size
    },
    applications: [...appMap.values()]
      .map((entry) => ({ ...entry, countries: serialiseSet(entry.countries), countryCodes: serialiseSet(entry.countryCodes), regions: serialiseSet(entry.regions) }))
      .sort((a, b) => b.total - a.total || a.name.localeCompare(b.name, "zh-CN")),
    countries: [...countryMap.values()]
      .map((entry) => ({
        ...entry,
        applications: serialiseSet(entry.applications),
        ips: serialiseSet(entry.ips),
        regions: serialiseSet(entry.regions)
      }))
      .sort((a, b) => b.total - a.total || a.country.localeCompare(b.country, "zh-CN")),
    regions: [...regionMap.values()]
      .map((entry) => ({ ...entry, applications: serialiseSet(entry.applications), ips: serialiseSet(entry.ips) }))
      .sort((a, b) => b.total - a.total || a.region.localeCompare(b.region, "zh-CN")),
    mapPoints: [...mapPoints.values()]
      .map((entry) => ({ ...entry, applications: serialiseSet(entry.applications), ips: serialiseSet(entry.ips) }))
      .sort((a, b) => b.total - a.total)
  };
}

function validConfig(input, fallback = {}) {
  const source = input && typeof input === "object" ? input : {};
  return {
    geolocationEnabled: typeof source.geolocationEnabled === "boolean"
      ? source.geolocationEnabled
      : fallback.geolocationEnabled !== false,
    includeLocal: typeof source.includeLocal === "boolean"
      ? source.includeLocal
      : Boolean(fallback.includeLocal),
    retentionMinutes: Math.max(1, Math.min(60, Number(source.retentionMinutes) || Number(fallback.retentionMinutes) || DEFAULT_RETENTION_MINUTES))
  };
}

export function createNetworkMonitorService({
  configDir = path.join(os.homedir(), ".config", "device-operate"),
  intervalMs = DEFAULT_INTERVAL_MS,
  run = execFileAsync,
  fetchImpl = globalThis.fetch,
  geoUrl = DEFAULT_GEO_URL,
  logger = console
} = {}) {
  const geoCachePath = path.join(configDir, "network-geo-cache.json");
  const configPath = path.join(configDir, "network-monitor-config.json");
  let config = validConfig({});
  let geoCache = { version: 1, ips: {}, self: null };
  let timer = null;
  let scanning = false;
  let scanQueue = Promise.resolve();
  let processCache = { at: 0, items: new Map() };
  let proxyCache = { at: 0, socket: "" };
  let dnsCache = new Map();
  let knownFlows = new Map();
  let latest = null;
  let lastError = "";
  let startedAt = null;
  let scanCount = 0;
  let geoQueuePromise = null;
  let saveGeoPromise = Promise.resolve();
  let initialised = false;

  async function initialise() {
    if (initialised) return;
    initialised = true;
    await fs.mkdir(configDir, { recursive: true });
    await Promise.all([
      fs.readFile(configPath, "utf8").then((text) => { config = validConfig(JSON.parse(text), config); }).catch(() => {}),
      fs.readFile(geoCachePath, "utf8").then((text) => {
        const parsed = JSON.parse(text);
        if (parsed?.ips && typeof parsed.ips === "object") geoCache = parsed;
      }).catch(() => {})
    ]);
  }

  async function saveGeoCache() {
    const serialise = async () => {
      const tempPath = `${geoCachePath}.tmp`;
      await fs.writeFile(tempPath, JSON.stringify(geoCache, null, 2), "utf8");
      await fs.rename(tempPath, geoCachePath);
    };
    saveGeoPromise = saveGeoPromise.then(serialise, serialise);
    return saveGeoPromise;
  }

  async function saveConfig() {
    await fs.mkdir(configDir, { recursive: true });
    await fs.writeFile(configPath, JSON.stringify(config, null, 2), "utf8");
  }

  async function commandOutput(command, args, options = {}) {
    try {
      const result = await run(command, args, { timeout: 15_000, maxBuffer: 8 * 1024 * 1024, ...options });
      return result?.stdout || "";
    } catch (error) {
      return error?.stdout || "";
    }
  }

  async function loadProcesses() {
    if (Date.now() - processCache.at < PROCESS_TTL_MS) return processCache.items;
    const output = await commandOutput("ps", ["-axo", "pid=,comm="]);
    const items = parsePsOutput(output);
    processCache = { at: Date.now(), items };
    return items;
  }

  async function discoverProxy() {
    if (Date.now() - proxyCache.at < PROXY_DISCOVERY_TTL_MS) return proxyCache;
    const output = await commandOutput("ps", ["-axo", "pid=,command="]);
    const socket = discoverMihomoSocket(output);
    proxyCache = { at: Date.now(), socket };
    return proxyCache;
  }

  async function readMihomoConnections() {
    const proxy = await discoverProxy();
    if (!proxy.socket) return { available: false, socket: "", entries: [] };
    try {
      const payload = await requestUnixJson(proxy.socket);
      return { available: true, socket: proxy.socket, entries: parseMihomoConnections(payload) };
    } catch (error) {
      proxyCache = { at: Date.now(), socket: "" };
      logger.warn?.(`[network-monitor] 代理连接读取失败：${error.message}`);
      return { available: false, socket: proxy.socket, error: error.message, entries: [] };
    }
  }

  async function resolveFlowAddress(flow) {
    const direct = String(flow.remoteAddress || "").replace(/^\[|\]$/g, "");
    if (net.isIP(direct)) return direct;
    const host = String(flow.host || "").split(":")[0];
    if (!host || net.isIP(host) || !host.includes(".")) return "";
    if (dnsCache.has(host)) return dnsCache.get(host);
    try {
      const answers = await dns.lookup(host, { family: 0, all: true, verbatim: false });
      const publicAnswer = answers.find((entry) => isPublicAddress(entry.address)) || answers[0];
      dnsCache.set(host, publicAnswer?.address || "");
      return publicAnswer?.address || "";
    } catch {
      dnsCache.set(host, "");
      return "";
    }
  }

  async function attachAddresses(flows) {
    const unresolved = flows.filter((flow) => !net.isIP(String(flow.remoteAddress || "")) && flow.host);
    const queue = [...new Set(unresolved.map((flow) => flow.host).filter(Boolean))];
    const answers = new Map();
    let index = 0;
    async function worker() {
      while (index < queue.length) {
        const host = queue[index++];
        const synthetic = { host, remoteAddress: "" };
        answers.set(host, await resolveFlowAddress(synthetic));
      }
    }
    await Promise.all(Array.from({ length: Math.min(6, queue.length || 1) }, worker));
    for (const flow of flows) {
      if (!net.isIP(String(flow.remoteAddress || "")) && flow.host && answers.get(flow.host)) {
        flow.remoteAddress = answers.get(flow.host);
        flow.resolvedHost = flow.host;
      }
    }
    return flows;
  }

  async function fetchGeo(ip) {
    if (typeof fetchImpl !== "function") throw new Error("当前运行环境不支持网络查询");
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 4_500);
    try {
      const target = ip
        ? `${geoUrl.replace(/\/$/, "")}/${encodeURIComponent(ip)}?fields=${GEO_FIELDS}`
        : `${geoUrl.replace(/\/$/, "")}/?fields=${GEO_FIELDS}`;
      const response = await fetchImpl(target, {
        signal: controller.signal,
        headers: { Accept: "application/json", "User-Agent": "device-operate-network-monitor/1.0" }
      });
      if (!response.ok) throw new Error(`GeoIP HTTP ${response.status}`);
      return await response.json();
    } finally {
      clearTimeout(timeout);
    }
  }

  async function geolocateIp(ip) {
    const cached = geoCache.ips[ip];
    const cachedAt = Number(cached?.fetchedAt) || 0;
    const ttl = cached?.success ? GEO_TTL_MS : GEO_ERROR_TTL_MS;
    if (cached && Date.now() - cachedAt < ttl) return cached;
    try {
      const payload = await fetchGeo(ip);
      const result = {
        success: payload.success !== false,
        country: payload.country || "",
        countryCode: payload.country_code || payload.countryCode || "",
        region: payload.region || payload.regionName || "",
        regionCode: payload.region_code || payload.regionCode || "",
        city: payload.city || "",
        latitude: number(payload.latitude ?? payload.lat),
        longitude: number(payload.longitude ?? payload.lon),
        organization: payload.connection?.org || payload.connection?.isp || "",
        asn: payload.connection?.asn || "",
        fetchedAt: Date.now()
      };
      geoCache.ips[ip] = result;
      return result;
    } catch (error) {
      const result = { success: false, error: error.message, fetchedAt: Date.now() };
      geoCache.ips[ip] = result;
      return result;
    }
  }

  function queueGeolocation(ips) {
    if (!config.geolocationEnabled || geoQueuePromise) return;
    const candidates = [...new Set(ips.filter(isPublicAddress))]
      .filter((ip) => {
        const cached = geoCache.ips[ip];
        const ttl = cached?.success ? GEO_TTL_MS : GEO_ERROR_TTL_MS;
        return !cached || Date.now() - Number(cached.fetchedAt || 0) >= ttl;
      })
      .slice(0, 20);
    if (!candidates.length) return;
    geoQueuePromise = (async () => {
      let index = 0;
      async function worker() {
        while (index < candidates.length) {
          const ip = candidates[index++];
          await geolocateIp(ip);
        }
      }
      await Promise.all(Array.from({ length: Math.min(3, candidates.length) }, worker));
      await saveGeoCache();
    })()
      .catch((error) => logger.warn?.(`[network-monitor] IP 归属地查询失败：${error.message}`))
      .finally(() => { geoQueuePromise = null; });
  }

  async function ensureSelfGeo() {
    if (!config.geolocationEnabled) return null;
    if (geoCache.self?.fetchedAt && Date.now() - geoCache.self.fetchedAt < SELF_GEO_TTL_MS) return geoCache.self;
    try {
      const payload = await fetchGeo("");
      geoCache.self = {
        success: payload.success !== false,
        ip: payload.ip || "",
        country: payload.country || "",
        countryCode: payload.country_code || "",
        region: payload.region || "",
        city: payload.city || "",
        latitude: number(payload.latitude),
        longitude: number(payload.longitude),
        fetchedAt: Date.now()
      };
      await saveGeoCache();
    } catch (error) {
      geoCache.self = { success: false, error: error.message, fetchedAt: Date.now() };
    }
    return geoCache.self;
  }

  function mergeKnownFlows(flows, sampledAt) {
    const now = new Date(sampledAt).toISOString();
    const activeKeys = new Set();
    for (const flow of flows) {
      activeKeys.add(flow.key);
      const before = knownFlows.get(flow.key);
      const geo = net.isIP(String(flow.remoteAddress || "")) ? geoCache.ips[flow.remoteAddress] : null;
      knownFlows.set(flow.key, {
        ...before,
        ...flow,
        firstSeen: before?.firstSeen || now,
        lastSeen: now,
        seenCount: (before?.seenCount || 0) + 1,
        active: true,
        geo
      });
    }
    for (const [key, flow] of knownFlows) {
      if (!activeKeys.has(key)) knownFlows.set(key, { ...flow, active: false });
    }
    const retentionMs = Math.max(config.retentionMinutes, 30) * 60_000;
    const cutoff = new Date(sampledAt).getTime() - retentionMs;
    for (const [key, flow] of knownFlows) {
      if (new Date(flow.lastSeen).getTime() < cutoff) knownFlows.delete(key);
    }
    if (knownFlows.size > 2000) {
      const keep = [...knownFlows.entries()]
        .sort((a, b) => new Date(b[1].lastSeen).getTime() - new Date(a[1].lastSeen).getTime())
        .slice(0, 2000);
      knownFlows = new Map(keep);
    }
  }

  async function collect() {
    await initialise();
    const started = Date.now();
    const [processes, output, proxy] = await Promise.all([
      loadProcesses(),
      commandOutput("lsof", ["-nP", "-iTCP", "-iUDP", "-FpcnPT"]),
      readMihomoConnections()
    ]);
    const records = parseLsofFields(output);
    const proxyPorts = new Set(proxy.entries.map((entry) => entry.inboundPort).filter(Boolean));
    const clashSourcePorts = new Set(proxy.entries.map((entry) => entry.sourcePort).filter(Boolean));
    const systemFlows = buildSystemFlows({
      records,
      processes,
      proxyPorts,
      clashSourcePorts,
      proxyAvailable: proxy.available
    });
    const proxyFlows = buildProxyFlows(proxy.entries, systemFlows);
    const flows = dedupeFlows([...systemFlows, ...proxyFlows]);
    await attachAddresses(flows);
    const sampledAt = Date.now();
    mergeKnownFlows(flows, sampledAt);
    queueGeolocation([...knownFlows.values()].map((flow) => flow.remoteAddress));
    const self = await ensureSelfGeo();
    const snapshot = aggregateNetwork([...knownFlows.values()], {
      scoredAt: new Date(sampledAt).toISOString(),
      retentionMinutes: config.retentionMinutes
    });
    const publicConnections = snapshot.visibleFlows
      .filter((flow) => flow.direction !== "listener" && isPublicAddress(flow.remoteAddress))
      .map((flow) => ({
        ...flow,
        ip: flow.remoteAddress,
        country: flow.geo?.country || "",
        countryCode: flow.geo?.countryCode || flow.geo?.country_code || "",
        region: flow.geo?.region || "",
        city: flow.geo?.city || "",
        geolocating: !flow.geo && config.geolocationEnabled
      }))
      .sort((a, b) => Number(b.active) - Number(a.active) || new Date(b.lastSeen).getTime() - new Date(a.lastSeen).getTime());
    const localConnections = snapshot.visibleFlows
      .filter((flow) => flow.direction !== "listener" && !isPublicAddress(flow.remoteAddress))
      .sort((a, b) => Number(b.active) - Number(a.active) || new Date(b.lastSeen).getTime() - new Date(a.lastSeen).getTime());
    const listeners = snapshot.visibleFlows
      .filter((flow) => flow.direction === "listener" || flow.listener)
      .sort((a, b) => Number(b.active) - Number(a.active) || (a.localPort || 0) - (b.localPort || 0));

    lastError = "";
    scanCount += 1;
    latest = {
      generatedAt: new Date(sampledAt).toISOString(),
      scanning: false,
      scanDurationMs: sampledAt - started,
      scanCount,
      monitoringSince: startedAt,
      lastScanAt: new Date(sampledAt).toISOString(),
      config,
      privacy: {
        payloadCapture: false,
        geolocationProvider: config.geolocationEnabled ? "ipwho.is" : null,
        sharedData: config.geolocationEnabled ? "仅公网 IP 地址" : "无"
      },
      self,
      proxy: {
        available: proxy.available,
        socket: proxy.socket || "",
        entries: proxy.entries.length,
        error: proxy.error || ""
      },
      summary: snapshot.summary,
      applications: snapshot.applications,
      countries: snapshot.countries,
      regions: snapshot.regions,
      mapPoints: snapshot.mapPoints,
      connections: publicConnections,
      localConnections,
      listeners,
      geolocation: {
        enabled: config.geolocationEnabled,
        cached: Object.keys(geoCache.ips).length,
        queued: Boolean(geoQueuePromise)
      }
    };
    return latest;
  }

  function scan() {
    const execute = async () => {
      if (scanning) return latest;
      scanning = true;
      try {
        return await collect();
      } catch (error) {
        lastError = error.message;
        logger.error?.(`[network-monitor] 扫描失败：${error.message}`);
        if (latest) return { ...latest, scanning: false, lastError };
        return {
          generatedAt: new Date().toISOString(),
          scanning: false,
          lastError,
          monitoringSince: startedAt,
          summary: { total: 0, outbound: 0, inbound: 0, listeners: 0, applications: 0, countries: 0, regions: 0 },
          applications: [],
          countries: [],
          regions: [],
          mapPoints: [],
          connections: [],
          localConnections: [],
          listeners: [],
          config,
          proxy: { available: false }
        };
      } finally {
        scanning = false;
      }
    };
    const result = scanQueue.then(execute, execute);
    scanQueue = result.then(() => undefined, () => undefined);
    return result;
  }

  async function snapshot() {
    if (!latest) {
      return {
        generatedAt: new Date().toISOString(),
        scanning: true,
        monitoringSince: startedAt,
        summary: { total: 0, outbound: 0, inbound: 0, listeners: 0, applications: 0, countries: 0, regions: 0 },
        applications: [],
        countries: [],
        regions: [],
        mapPoints: [],
        connections: [],
        localConnections: [],
        listeners: [],
        config,
        self: geoCache.self,
        proxy: { available: false },
        geolocation: { enabled: config.geolocationEnabled, cached: Object.keys(geoCache.ips).length, queued: true }
      };
    }
    return latest;
  }

  async function updateConfig(patch) {
    await initialise();
    config = validConfig({ ...config, ...patch }, config);
    await saveConfig();
    if (!config.geolocationEnabled) geoQueuePromise = null;
    return config;
  }

  function start({ immediate = true } = {}) {
    if (timer) return { started: false, intervalMs };
    startedAt = new Date().toISOString();
    timer = setInterval(() => { scan().catch(() => {}); }, intervalMs);
    timer.unref?.();
    if (immediate) scan().catch(() => {});
    return { started: true, intervalMs };
  }

  function stop() {
    if (timer) clearInterval(timer);
    timer = null;
    return { started: false };
  }

  async function refresh() {
    return scan();
  }

  return {
    start,
    stop,
    refresh,
    snapshot,
    updateConfig,
    config: () => ({ ...config }),
    status: () => ({
      running: Boolean(timer),
      scanning,
      intervalMs,
      monitoringSince: startedAt,
      lastScanAt: latest?.lastScanAt || null,
      scanCount,
      lastError,
      proxy: latest?.proxy || null,
      geolocation: { enabled: config.geolocationEnabled, cached: Object.keys(geoCache.ips).length }
    })
  };
}

export const networkMonitorInternals = {
  DEFAULT_INTERVAL_MS,
  DEFAULT_RETENTION_MINUTES,
  GEO_TTL_MS,
  GEO_ERROR_TTL_MS,
  GEO_FIELDS,
  validConfig,
  requestUnixJson
};
