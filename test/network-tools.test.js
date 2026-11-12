import assert from "node:assert/strict";
import test from "node:test";
import {
  createNetworkToolService,
  normalizeHost,
  normalizePort,
  parseDig,
  parseListeningPorts,
  parsePing,
  parseTraceroute
} from "../server/network-tools.js";

const PING_OUTPUT = `PING 1.1.1.1 (1.1.1.1): 56 data bytes
64 bytes from 1.1.1.1: icmp_seq=0 ttl=55 time=12.345 ms
64 bytes from 1.1.1.1: icmp_seq=1 ttl=55 time=15.678 ms
64 bytes from 1.1.1.1: icmp_seq=2 ttl=55 time=11.111 ms

--- 1.1.1.1 ping statistics ---
3 packets transmitted, 3 packets received, 0.0% packet loss
round-trip min/avg/max/stddev = 11.111/13.045/15.678/2.003 ms
`;

test("ping output is parsed into latency and loss statistics", () => {
  const parsed = parsePing(PING_OUTPUT);
  assert.equal(parsed.transmitted, 3);
  assert.equal(parsed.received, 3);
  assert.equal(parsed.packetLossPercent, 0);
  assert.equal(parsed.minMs, 11.111);
  assert.equal(parsed.avgMs, 13.045);
  assert.equal(parsed.reachable, true);
  assert.equal(parsed.samples.length, 3);
});

test("ping output without replies reports unreachable", () => {
  const parsed = parsePing("PING 10.0.0.1: 56 data bytes\nRequest timeout for icmp_seq 0\n\n--- 10.0.0.1 ping statistics ---\n2 packets transmitted, 0 packets received, 100.0% packet loss\n");
  assert.equal(parsed.reachable, false);
  assert.equal(parsed.packetLossPercent, 100);
});

test("host and port validation blocks shell input", () => {
  assert.equal(normalizeHost("https://github.com/"), "github.com");
  assert.equal(normalizeHost("1.1.1.1"), "1.1.1.1");
  assert.equal(normalizeHost("example.com:8443"), "example.com");
  assert.throws(() => normalizeHost("evil.com; rm -rf /"), /不合法/);
  assert.throws(() => normalizeHost(""), /请提供/);
  assert.equal(normalizePort("443"), 443);
  assert.throws(() => normalizePort("70000"), /1-65535/);
  assert.throws(() => normalizePort("abc"), /1-65535/);
});

test("dig and traceroute output are structured", () => {
  assert.deepEqual(parseDig("20.205.243.166\nexample.com.\n"), ["20.205.243.166", "example.com"]);
  const hops = parseTraceroute("traceroute to github.com (20.205.243.166), 12 hops max\n 1  192.168.1.1  1.234 ms\n 2  * \n 3  10.0.0.1  8.5 ms\n");
  assert.equal(hops.length, 3);
  assert.equal(hops[0].hop, 1);
  assert.equal(hops[0].address, "192.168.1.1");
  assert.deepEqual(hops[0].times, [1.234]);
  assert.equal(hops[1].address, "");
});

test("listening port output is parsed with loopback detection", () => {
  const output = `COMMAND     PID  USER   FD   TYPE             DEVICE SIZE/OFF NODE NAME
rapportd    658 oyjie   10u  IPv4 0xabc      0t0  TCP *:55267 (LISTEN)
stable      689 oyjie   39u  IPv4 0xdef      0t0  TCP 127.0.0.1:9277 (LISTEN)
`;
  const entries = parseListeningPorts(output);
  assert.equal(entries.length, 2);
  assert.equal(entries[0].command, "rapportd");
  assert.equal(entries[0].port, 55267);
  assert.equal(entries[1].port, 9277);
  assert.match(entries[1].address, /127\.0\.0\.1/);
});

test("network service validates before invoking commands", async () => {
  const calls = [];
  const service = createNetworkToolService({
    run: async (command, args) => {
      calls.push([command, args]);
      return { stdout: PING_OUTPUT };
    }
  });

  const result = await service.ping({ host: "1.1.1.1", count: 3 });
  assert.equal(result.host, "1.1.1.1");
  assert.equal(result.reachable, true);
  assert.equal(calls[0][0], "ping");
  assert.deepEqual(calls[0][1], ["-c", "3", "-W", "2000", "1.1.1.1"]);

  await assert.rejects(() => service.ping({ host: "a; rm -rf /" }), /不合法/);
  assert.equal(calls.length, 1, "invalid host must not reach the command runner");
});

test("speed test converts curl output into bandwidth numbers", async () => {
  const service = createNetworkToolService({
    run: async () => ({ stdout: "25000000 2.5 10000000 200" })
  });
  const result = await service.speedTest({ bytes: 25_000_000 });
  assert.equal(result.bytesDownloaded, 25_000_000);
  assert.equal(result.elapsedMs, 2500);
  assert.equal(result.megabytesPerSecond, 9.54);
  assert.equal(result.megabitsPerSecond, 80);
});
