import test from "node:test";
import assert from "node:assert/strict";
import {
  buildMemoryMetrics,
  parseDf,
  parseIostatTotalMb,
  parseMemoryPressure,
  parseNativeProcessList,
  parseNetworkCounters,
  parseSwapUsage,
  parseUserDirectory,
  parseVmStat
} from "../server/system-monitor.js";

test("native process samples preserve hierarchy, user ids, threads and cumulative CPU", () => {
  const [processInfo] = parseNativeProcessList(
    "671\t1\t501\t62\t245366784\t1200000000\t300000000\t1722500000\t2\tLark Helper\t/Applications/Lark.app/Contents/MacOS/Lark Helper\n"
  );
  assert.deepEqual(processInfo, {
    pid: 671,
    parentPid: 1,
    uid: 501,
    threads: 62,
    rssBytes: 245366784,
    cpuTimeNs: 1500000000n,
    startedAtSeconds: 1722500000,
    status: 2,
    processName: "Lark Helper",
    command: "/Applications/Lark.app/Contents/MacOS/Lark Helper"
  });
});

test("macOS memory metrics use available pressure instead of total minus free pages", () => {
  const vmStat = parseVmStat([
    "Mach Virtual Memory Statistics: (page size of 16384 bytes)",
    "Pages free:                               13625.",
    "Pages inactive:                          250000.",
    "Pages speculative:                         1000.",
    "Pages purgeable:                           2000.",
    "Pages wired down:                         190000.",
    "Pages occupied by compressor:             120000."
  ].join("\n"));
  const swap = parseSwapUsage("total = 8192.00M  used = 6144.00M  free = 2048.00M  (encrypted)");
  const metrics = buildMemoryMetrics({
    totalBytes: 16 * 1024 ** 3,
    vmStat,
    freePercent: parseMemoryPressure("System-wide memory free percentage: 49%"),
    swap
  });

  assert.equal(metrics.memoryPercent, 51);
  assert.equal(metrics.memoryFreeMb, 212.9);
  assert.equal(metrics.memoryAvailableMb, 8028.2);
  assert.equal(metrics.swapUsedMb, 6144);
  assert.equal(metrics.swapEncrypted, true);
});

test("disk, I/O, network and user parsers keep cumulative counters", () => {
  assert.deepEqual(parseDf([
    "Filesystem 1024-blocks Used Available Capacity Mounted on",
    "/dev/disk3s3s1 971350180 12270808 138075840 9% /",
    "devfs 246 246 0 100% /dev"
  ].join("\n")), [{
    filesystem: "/dev/disk3s3s1",
    totalBytes: 994662584320,
    usedBytes: 12565307392,
    availableBytes: 141389660160,
    usedPercent: 9,
    mount: "/"
  }]);

  assert.equal(parseIostatTotalMb([
    " disk0 disk10",
    " KB/t xfrs MB KB/t xfrs MB",
    " 18.00 100 512.5 42.0 20 10.5"
  ].join("\n")), 523);

  assert.deepEqual(parseNetworkCounters([
    "Name Mtu Network Address Ipkts Ierrs Ibytes Opkts Oerrs Obytes Coll",
    "lo0 16384 <Link#1> 10 0 1000 11 0 2000 0",
    "en0 1500 <Link#4> aa:bb:cc:dd:ee:ff 20 0 3000 21 0 4000 0"
  ].join("\n")), [
    { name: "lo0", receivedBytes: 1000, sentBytes: 2000 },
    { name: "en0", receivedBytes: 3000, sentBytes: 4000 }
  ]);

  assert.deepEqual([...parseUserDirectory("root 0\noyjie 501\n")], [[0, "root"], [501, "oyjie"]]);
});
