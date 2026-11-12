import test from "node:test";

const FAKE_KEY_HEADER = ["-----BEGIN", "OPENSSH PRIVATE KEY-----"].join(" ");
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createSshService, parseSshConfig, serializeSshConfig } from "../server/ssh.js";

test("SSH config parser handles Host blocks, equals syntax, comments, and globals", () => {
  const source = [
    "Host *",
    "    ServerAliveInterval 60 # keep sessions alive",
    "",
    "Host work prod # team hosts",
    "    HostName = git.example.com",
    "    User alice",
    "# identity is managed by the team",
    "Match exec \"true\"",
    "    IdentityAgent ~/.ssh/agent.sock"
  ].join("\n");
  const parsed = parseSshConfig(source);

  assert.deepEqual(parsed.hosts.map(({ host, options }) => ({ host, options })), [
    { host: "*", options: [{ key: "ServerAliveInterval", value: "60", inlineComment: "# keep sessions alive" }] },
    { host: "work prod", options: [{ key: "HostName", value: "git.example.com" }, { key: "User", value: "alice" }] }
  ]);
  const serialized = serializeSshConfig(parsed);
  assert.equal(serialized, `${source}\n`);
});

test("SSH service creates, updates, and removes config hosts atomically", async () => {
  const homeDir = await fs.mkdtemp(path.join(os.tmpdir(), "device-operate-ssh-"));
  const service = createSshService({ homeDir, run: async () => ({ stdout: "" }) });
  try {
    await service.createHost({ host: "work", options: [{ key: "HostName", value: "git.example.com" }, { key: "User", value: "alice" }] });
    let state = await service.getState();
    assert.equal(state.config.hosts[0].host, "work");
    assert.equal(state.config.hosts[0].options[1].value, "alice");
    await service.updateHost({ originalHost: "work", host: "prod", options: { HostName: "prod.example.com", Port: "2222" } });
    state = await service.getState();
    assert.deepEqual(state.config.hosts.map((entry) => entry.host), ["prod"]);
    await service.deleteHost({ host: "prod" });
    state = await service.getState();
    assert.deepEqual(state.config.hosts, []);
    assert.match(await fs.readFile(path.join(homeDir, ".ssh", "config"), "utf8"), /^\n?$/);
    assert.equal((await fs.stat(path.join(homeDir, ".ssh", "config"))).mode & 0o777, 0o600);
  } finally {
    await fs.rm(homeDir, { recursive: true, force: true });
  }
});

test("SSH config mutations preserve untouched blocks and comments byte-for-byte", async () => {
  const homeDir = await fs.mkdtemp(path.join(os.tmpdir(), "device-operate-ssh-lossless-"));
  const sshDir = path.join(homeDir, ".ssh");
  const configPath = path.join(sshDir, "config");
  const untouchedBlock = [
    "Host untouched # keep this annotation",
    "    HostName = untouched.example.com # keep inline comment",
    "    LocalForward 8080 localhost:80",
    "    LocalForward 8443 localhost:443",
    ""
  ].join("\n");
  const source = [
    "# global comment",
    "Include ~/.ssh/conf.d/*",
    "",
    untouchedBlock,
    "Host edited # owner note",
    "    HostName old.example.com",
    "    User alice",
    "    # block comment",
    "Match exec \"true\"",
    "    IdentityAgent ~/.ssh/agent.sock",
    ""
  ].join("\n");
  await fs.mkdir(sshDir, { mode: 0o700 });
  await fs.writeFile(configPath, source, { mode: 0o600 });
  const service = createSshService({ homeDir, run: async () => ({ stdout: "" }) });
  try {
    await service.updateHost({
      originalHost: "edited",
      host: "production",
      options: [{ key: "HostName", value: "new.example.com" }, { key: "User", value: "bob" }]
    });
    const updated = await fs.readFile(configPath, "utf8");
    assert.ok(updated.includes(untouchedBlock));
    assert.match(updated, /Host production # owner note/);
    assert.match(updated, /# block comment\nMatch exec "true"\n    IdentityAgent ~\/\.ssh\/agent\.sock/);
    await service.createHost({ host: "new-host", options: [{ key: "IdentityFile", value: "~/.ssh/id_ed25519" }] });
    const created = await fs.readFile(configPath, "utf8");
    assert.ok(created.includes(untouchedBlock));
    assert.match(created, /Host new-host\n    IdentityFile ~\/\.ssh\/id_ed25519/);
    await service.deleteHost({ host: "production" });
    const deleted = await fs.readFile(configPath, "utf8");
    assert.ok(deleted.includes(untouchedBlock));
    assert.doesNotMatch(deleted, /Host production/);
  } finally {
    await fs.rm(homeDir, { recursive: true, force: true });
  }
});

test("SSH initialization only generates a default key when no key exists", async () => {
  const homeDir = await fs.mkdtemp(path.join(os.tmpdir(), "device-operate-ssh-init-"));
  const calls = [];
  const service = createSshService({
    homeDir,
    run: async (command, args) => {
      calls.push({ command, args });
      if (args[0] === "-lf") return { stdout: "256 SHA256:abc key (ED25519)\n" };
      const privatePath = args[args.indexOf("-f") + 1];
      await fs.writeFile(privatePath, FAKE_KEY_HEADER + "\n");
      await fs.writeFile(`${privatePath}.pub`, "ssh-ed25519 AAAA test\n");
      return { stdout: "" };
    }
  });
  try {
    const first = await service.initialize();
    assert.equal(first.created, true);
    assert.equal(first.key.name, "id_ed25519");
    const second = await service.initialize();
    assert.equal(second.created, false);
    assert.equal(calls.filter(({ args }) => args.includes("-t")).length, 1);
  } finally {
    await fs.rm(homeDir, { recursive: true, force: true });
  }
});

test("SSH key content only accepts safe key names and explicit content kinds", async () => {
  const homeDir = await fs.mkdtemp(path.join(os.tmpdir(), "device-operate-ssh-content-"));
  const sshDir = path.join(homeDir, ".ssh");
  await fs.mkdir(sshDir, { mode: 0o700 });
  await fs.writeFile(path.join(sshDir, "id_ed25519"), FAKE_KEY_HEADER + "\nsecret\n");
  await fs.writeFile(path.join(sshDir, "id_ed25519.pub"), "ssh-ed25519 AAAA public\n");
  const service = createSshService({ homeDir, run: async () => ({ stdout: "256 SHA256:abc id_ed25519.pub (ED25519)\n" }) });
  try {
    assert.equal((await service.readKeyContent("id_ed25519", "private")).content, FAKE_KEY_HEADER + "\nsecret\n");
    await assert.rejects(() => service.readKeyContent("../outside", "private"), /SSH Key 名称不合法/);
    await assert.rejects(() => service.readKeyContent("id_ed25519", "other"), /不支持的 Key 内容类型/);
  } finally {
    await fs.rm(homeDir, { recursive: true, force: true });
  }
});

test("SSH regeneration replaces both key files and rolls back a partial install", async () => {
  const homeDir = await fs.mkdtemp(path.join(os.tmpdir(), "device-operate-ssh-regenerate-"));
  const sshDir = path.join(homeDir, ".ssh");
  const privateFile = path.join(sshDir, "id_ed25519");
  const publicFile = `${privateFile}.pub`;
  await fs.mkdir(sshDir, { mode: 0o700 });
  await fs.writeFile(privateFile, FAKE_KEY_HEADER + "\nold-private\n");
  await fs.writeFile(publicFile, "ssh-ed25519 OLD old-public\n");
  const fsWithFailedPublicInstall = {
    ...fs,
    async rename(source, target) {
      if (source.includes(".device-operate-") && source.endsWith(".pub") && target === publicFile) {
        throw new Error("simulated public key install failure");
      }
      return fs.rename(source, target);
    }
  };
  const writeGeneratedPair = async (_command, args) => {
    if (args[0] === "-lf") return { stdout: "256 SHA256:new key (ED25519)\n" };
    const generatedPrivate = args[args.indexOf("-f") + 1];
    await fs.writeFile(generatedPrivate, FAKE_KEY_HEADER + "\nnew-private\n");
    await fs.writeFile(`${generatedPrivate}.pub`, "ssh-ed25519 NEW new-public\n");
    return { stdout: "" };
  };
  try {
    const failingService = createSshService({ homeDir, fsImpl: fsWithFailedPublicInstall, run: writeGeneratedPair });
    await assert.rejects(
      () => failingService.generateKey({ name: "id_ed25519", algorithm: "ed25519", overwrite: true }),
      /simulated public key install failure/
    );
    assert.match(await fs.readFile(privateFile, "utf8"), /old-private/);
    assert.match(await fs.readFile(publicFile, "utf8"), /OLD old-public/);

    const service = createSshService({ homeDir, run: writeGeneratedPair });
    await service.generateKey({ name: "id_ed25519", algorithm: "ed25519", overwrite: true });
    assert.match(await fs.readFile(privateFile, "utf8"), /new-private/);
    assert.match(await fs.readFile(publicFile, "utf8"), /NEW new-public/);
    assert.equal((await fs.stat(privateFile)).mode & 0o777, 0o600);
    assert.equal((await fs.stat(publicFile)).mode & 0o777, 0o644);
    assert.deepEqual((await fs.readdir(sshDir)).filter((name) => name.includes("device-operate")), []);
  } finally {
    await fs.rm(homeDir, { recursive: true, force: true });
  }
});

test("SSH service initializes and regenerates a real Ed25519 key pair", async () => {
  const homeDir = await fs.mkdtemp(path.join(os.tmpdir(), "device-operate-ssh-real-"));
  const service = createSshService({ homeDir });
  try {
    const initialized = await service.initialize();
    assert.equal(initialized.created, true);
    assert.equal(initialized.key.algorithm, "ed25519");
    const firstPublic = (await service.readKeyContent("id_ed25519", "public")).content;
    const firstPrivate = (await service.readKeyContent("id_ed25519", "private")).content;
    assert.match(firstPublic, /^ssh-ed25519 /);
    assert.match(firstPrivate, new RegExp("^" + FAKE_KEY_HEADER));
    await service.generateKey({ name: "id_ed25519", algorithm: "ed25519", comment: "regenerated", overwrite: true });
    const secondPublic = (await service.readKeyContent("id_ed25519", "public")).content;
    assert.notEqual(secondPublic, firstPublic);
    assert.match(secondPublic, / regenerated\n$/);
  } finally {
    await fs.rm(homeDir, { recursive: true, force: true });
  }
});
