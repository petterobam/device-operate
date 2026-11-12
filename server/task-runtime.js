function parseNumericStatus(value) {
  return /^-?\d+$/.test(value) ? Number(value) : null;
}

function createServiceState(pidValue, statusValue) {
  const numericPid = Number(pidValue);
  const pid = Number.isInteger(numericPid) && numericPid > 0 ? numericPid : null;
  return {
    loaded: true,
    running: pid !== null,
    pid,
    lastExitStatus: parseNumericStatus(statusValue)
  };
}

export function parseLaunchctlList(stdout) {
  const services = new Map();
  for (const line of stdout.split("\n").slice(1)) {
    const parts = line.trim().split(/\s+/);
    if (parts.length < 3) continue;
    const [pid, status] = parts;
    const label = parts.slice(2).join(" ");
    services.set(label, createServiceState(pid, status));
  }
  return services;
}

export function parseLaunchctlServices(stdout) {
  const match = stdout.match(/\n\tservices = \{\n([\s\S]*?)\n\t\}/);
  const services = new Map();
  if (!match) return services;

  for (const line of match[1].split("\n")) {
    const parts = line.trim().split(/\s+/);
    if (parts.length < 3) continue;
    const [pid, status] = parts;
    const label = parts.at(-1);
    services.set(label, createServiceState(pid, status));
  }
  return services;
}

export function parseProcessList(stdout) {
  return stdout
    .split("\n")
    .map((line) => line.match(/^\s*(\d+)\s+(\d+)\s+(\S+)\s+(.+)$/))
    .filter(Boolean)
    .map((match) => ({
      pid: Number(match[1]),
      parentPid: Number(match[2]),
      elapsed: match[3],
      command: match[4]
    }));
}

function shellCommand(command) {
  return command.match(/^(?:\/bin\/)?(?:ba|z)?sh\s+-c\s+([\s\S]+)$/)?.[1] || "";
}

function hasCronAncestor(processInfo, byPid) {
  let current = processInfo;
  const visited = new Set();
  while (current && !visited.has(current.pid)) {
    visited.add(current.pid);
    if (/(?:^|\/)cron(?:\s|$)/.test(current.command)) return true;
    current = byPid.get(current.parentPid);
  }
  return false;
}

export function findCronTaskProcesses(command, processes) {
  const byPid = new Map(processes.map((processInfo) => [processInfo.pid, processInfo]));
  return processes.filter(
    (processInfo) => shellCommand(processInfo.command) === command && hasCronAncestor(processInfo, byPid)
  );
}

export function getLaunchdStatus({ disabled, loaded, running, lastExitStatus }) {
  if (running) return "running";
  if (disabled) return "disabled";
  if (loaded && lastExitStatus !== null && lastExitStatus !== 0) return "failed";
  return loaded ? "waiting" : "stopped";
}
