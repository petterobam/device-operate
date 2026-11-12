import assert from "node:assert/strict";
import test from "node:test";
import {
  aggregateNetwork,
  applicationNameForProcess,
  buildProxyFlows,
  buildSystemFlows,
  classifyAddress,
  discoverMihomoSocket,
  isPrivateAddress,
  isPublicAddress,
  parseLsofFields,
  parseMihomoConnections,
  parsePsOutput,
  splitEndpoint
} from "../server/network-monitor.js";

const LSOF_OUTPUT = `p689
cstable
f35
PTCP
n192.168.1.20:54272->34.117.41.85:443
TST=ESTABLISHED
f39
PTCP
n127.0.0.1:9277
TST=LISTEN
p699
cWeChat
f88
PTCP
n192.168.1.20:53413->180.101.242.227:80
TST=CLOSE_WAIT
f377
PTCP
n192.168.1.20:62615->101.91.37.18:80
TST=ESTABLISHED
p1000
cverge-mihomo
f10
PTCP
n127.0.0.1:7897
TST=LISTEN
`;

test("endpoint parsing handles IPv4, wildcard and bracketed IPv6", () => {
  assert.deepEqual(splitEndpoint("192.168.1.2:443"), { address: "192.168.1.2", port: 443 });
  assert.deepEqual(splitEndpoint("*:51303"), { address: "*", port: 51303 });
  assert.deepEqual(splitEndpoint("[::1]:8080"), { address: "::1", port: 8080 });
  assert.deepEqual(splitEndpoint("*:*"), { address: "*", port: null });
});

test("lsof field output preserves one record per socket", () => {
  const records = parseLsofFields(LSOF_OUTPUT);
  assert.equal(records.length, 5);
  assert.equal(records[0].pid, 689);
  assert.equal(records[0].protocol, "TCP");
  assert.equal(records[0].state, "ESTABLISHED");
  assert.match(records[0].name, /34\.117\.41\.85:443/);
  assert.equal(records[1].state, "LISTEN");
});

test("address classification distinguishes public, private and loopback", () => {
  assert.equal(isPublicAddress("1.1.1.1"), true);
  assert.equal(isPublicAddress("180.101.242.227"), true);
  assert.equal(isPrivateAddress("192.168.1.20"), true);
  assert.equal(isPrivateAddress("100.64.0.1"), true);
  assert.equal(classifyAddress("127.0.0.1"), "loopback");
  assert.equal(classifyAddress("fe80::1"), "private");
  assert.equal(classifyAddress("example.com"), "hostname");
});

test("process records and application bundle names are grouped by app", () => {
  const processes = parsePsOutput("1288 /Applications/Lark.app/Contents/MacOS/Lark\n42 /usr/sbin/mDNSResponder\n");
  assert.equal(processes.get(1288), "/Applications/Lark.app/Contents/MacOS/Lark");
  assert.equal(applicationNameForProcess(processes.get(1288)), "Lark");
  assert.equal(applicationNameForProcess(processes.get(42)), "mDNSResponder");
  assert.equal(
    applicationNameForProcess("/Library/Developer/CoreSimulator/Volumes/iOS_22F77/Library/Developer/CoreSimulator/Profiles/Runtimes/iOS 18.5.simruntime/Contents/Resources/RuntimeRoot/System/Library/PrivateFrameworks/CloudKitDaemon.framework/Support/cloudd", "cloudd"),
    "iOS 18.5 模拟器"
  );
});

test("system flows infer outbound, inbound and listener directions", () => {
  const records = parseLsofFields(`p10
cecho-server
f3
PTCP
n*:8080
TST=LISTEN
f4
PTCP
n192.168.1.20:8080->203.0.113.9:51111
TST=ESTABLISHED
p11
cbrowser
f5
PTCP
n192.168.1.20:60200->1.1.1.1:443
TST=ESTABLISHED
`);
  const flows = buildSystemFlows({
    records,
    processes: new Map([[10, "/Applications/Web.app/Contents/MacOS/Web"], [11, "/Applications/Browser.app/Contents/MacOS/Browser"]])
  });
  assert.equal(flows.length, 3);
  assert.equal(flows.find((flow) => flow.localPort === 8080 && flow.direction === "listener").applicationName, "Web");
  assert.equal(flows.find((flow) => flow.localPort === 8080 && flow.direction === "inbound").remoteAddress, "203.0.113.9");
  assert.equal(flows.find((flow) => flow.localPort === 60200).direction, "outbound");
});

test("Mihomo output is mapped back to the owning application", () => {
  const socket = discoverMihomoSocket("verge-mihomo -d /tmp -ext-ctl-unix /tmp/verge/verge-mihomo.sock");
  assert.equal(socket, "/tmp/verge/verge-mihomo.sock");
  const entries = parseMihomoConnections({
    connections: [{
      id: "c1",
      metadata: {
        network: "tcp",
        sourceIP: "127.0.0.1",
        sourcePort: "54841",
        inboundPort: "7897",
        destinationPort: "443",
        remoteDestination: "104.16.248.249",
        host: "cloudflare-dns.com",
        process: "Google Chrome Helper",
        processPath: "/Applications/Google Chrome.app/Contents/Frameworks/Google Chrome Helper.app/Contents/MacOS/Google Chrome Helper"
      },
      upload: 12,
      download: 34,
      chains: ["proxy", "auto"],
      rule: "DomainSuffix"
    }]
  });
  assert.equal(entries.length, 1);
  assert.equal(entries[0].applicationName, "Google Chrome");
  assert.equal(entries[0].remoteAddress, "104.16.248.249");
  assert.equal(entries[0].route, "proxy → auto");
});

test("proxy and direct flows can be merged without double-counting", () => {
  const entries = parseMihomoConnections({
    connections: [{
      id: "c1",
      metadata: {
        network: "tcp",
        sourcePort: "60200",
        inboundPort: "7897",
        destinationPort: "443",
        remoteDestination: "1.1.1.1",
        host: "one.one.one.one",
        processPath: "/Applications/Safari.app/Contents/MacOS/Safari"
      }
    }]
  });
  const system = buildSystemFlows({
    records: parseLsofFields(`p20
cSafari
f4
PTCP
n127.0.0.1:60200->127.0.0.1:7897
TST=ESTABLISHED
`),
    processes: new Map([[20, "/Applications/Safari.app/Contents/MacOS/Safari"]]),
    proxyPorts: new Set([7897]),
    clashSourcePorts: new Set([60200]),
    proxyAvailable: true
  });
  assert.equal(system.length, 0);
  const proxy = buildProxyFlows(entries, system);
  assert.equal(proxy.length, 1);
  assert.equal(proxy[0].applicationName, "Safari");
  assert.equal(proxy[0].remoteAddress, "1.1.1.1");
});

test("aggregation produces app, country, region and map views", () => {
  const now = new Date().toISOString();
  const geo = { success: true, country: "United States", countryCode: "US", region: "California", city: "San Jose", latitude: 37.3, longitude: -121.8 };
  const flows = [
    { key: "a", direction: "outbound", applicationName: "Browser", processPath: "/Applications/Browser.app", remoteAddress: "1.1.1.1", remotePort: 443, firstSeen: now, lastSeen: now, connectionCount: 2, geo },
    { key: "b", direction: "inbound", applicationName: "Server", processPath: "/usr/bin/server", remoteAddress: "8.8.8.8", remotePort: 50000, firstSeen: now, lastSeen: now, connectionCount: 1, geo: { ...geo, country: "Japan", countryCode: "JP", region: "Tokyo", city: "Tokyo", latitude: 35.6, longitude: 139.7 } },
    { key: "c", direction: "outbound", applicationName: "Browser", remoteAddress: "192.168.1.2", remotePort: 80, firstSeen: now, lastSeen: now, connectionCount: 1 }
  ];
  const result = aggregateNetwork(flows, { scoredAt: now, retentionMinutes: 10 });
  assert.equal(result.summary.total, 4);
  assert.equal(result.summary.outbound, 3);
  assert.equal(result.summary.inbound, 1);
  assert.equal(result.summary.publicFlows, 2);
  assert.equal(result.applications.find((entry) => entry.name === "Browser").total, 3);
  assert.equal(result.countries.length, 2);
  assert.equal(result.mapPoints.length, 2);
  assert.equal(result.mapPoints.find((entry) => entry.countryCode === "JP").inbound, 1);
});
