import { createServer } from "node:http";
import { copyFile, mkdir, open, readFile, rename, writeFile } from "node:fs/promises";
import { existsSync, createWriteStream } from "node:fs";
import { extname, join, resolve } from "node:path";
import { spawn } from "node:child_process";
import { createHmac, randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { dirname } from "node:path";

const rootDir = dirname(fileURLToPath(import.meta.url));
const publicDir = join(rootDir, "public");
const configPath = join(rootDir, "farm.json");
const accountsPath = join(rootDir, "accounts.txt");
const statePath = join(rootDir, "web-farm-state.json");
const logsDir = join(rootDir, "logs");
const port = Number(process.env.PORT || 3000);
const bindHost = process.env.BIND_HOST || "127.0.0.1";

const contentTypes = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
};

function json(res, status, body) {
  const payload = JSON.stringify(body, null, 2);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
  });
  res.end(payload);
}

function mask(value) {
  if (!value) return "";
  if (value.length <= 4) return "*".repeat(value.length);
  return `${value.slice(0, 2)}${"*".repeat(Math.min(10, value.length - 4))}${value.slice(-2)}`;
}

function normalizeProxyId(value) {
  return String(value || "").trim();
}

function normalizeWorldMode(value) {
  const mode = String(value || "fixed").trim();
  return ["fixed", "random-f2p", "random-p2p"].includes(mode) ? mode : "fixed";
}

function parseAccountLine(line, index) {
  const firstColon = line.indexOf(":");
  const lastColon = line.lastIndexOf(":");
  if (firstColon <= 0 || lastColon <= firstColon) {
    throw new Error(`Invalid account format on line ${index + 1}. Expected email:password:totp_secret`);
  }

  return {
    index,
    email: line.slice(0, firstColon),
    password: line.slice(firstColon + 1, lastColon),
    totpSecret: line.slice(lastColon + 1),
  };
}

function parseBulkAccountLines(text) {
  const lines = String(text || "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith("#"));

  const valid = [];
  const invalid = [];

  lines.forEach((line, lineIndex) => {
    try {
      const parsed = parseAccountLine(line, lineIndex);
      getTotpCode(parsed.totpSecret);
      valid.push({
        email: parsed.email,
        password: parsed.password,
        totpSecret: parsed.totpSecret,
        lineNumber: lineIndex + 1,
      });
    } catch (error) {
      invalid.push({
        lineNumber: lineIndex + 1,
        line,
        error: error.message || String(error),
      });
    }
  });

  return { valid, invalid, totalLines: lines.length };
}

function parseBulkProxyLines(text) {
  const lines = String(text || "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith("#"));

  const valid = [];
  const invalid = [];

  lines.forEach((line, lineIndex) => {
    const parts = line.split(":").map((part) => part.trim());
    const [name, host, port, username = "", password = ""] = parts;
    const parsedPort = Number(port);

    if (parts.length < 3 || parts.length > 5 || !name || !host || !Number.isInteger(parsedPort) || parsedPort < 1) {
      invalid.push({
        lineNumber: lineIndex + 1,
        line,
        error: "Expected name:host:port or name:host:port:username:password",
      });
      return;
    }

    valid.push({
      name,
      host,
      port: parsedPort,
      username,
      password,
      lineNumber: lineIndex + 1,
    });
  });

  return { valid, invalid, totalLines: lines.length };
}

async function readAccounts() {
  if (!existsSync(accountsPath)) return [];
  const raw = await readFile(accountsPath, "utf8");
  return raw
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith("#"))
    .map(parseAccountLine);
}

async function writeAccounts(accounts) {
  const lines = accounts.map((account) => `${account.email}:${account.password}:${account.totpSecret}`);
  await writeTextFileSafely(accountsPath, `${lines.join("\n")}${lines.length ? "\n" : ""}`);
}

async function readConfig() {
  if (!existsSync(configPath)) {
    return {
      launcherPath: "C:\\Users\\gusta\\DreamBot\\Launcher.jar",
      accountsFile: ".\\accounts.txt",
      defaultScriptName: "Teste",
      defaultWorld: 301,
      useGeneratedTotp: false,
      launchDelaySeconds: 20,
      maxInstances: 2,
      proxies: [],
      accounts: [],
    };
  }

  const config = JSON.parse(stripBom(await readFile(configPath, "utf8")));
  if (!Array.isArray(config.proxies)) config.proxies = [];
  if (!Array.isArray(config.accounts)) config.accounts = [];
  return config;
}

async function writeConfig(config) {
  await writeTextFileSafely(configPath, `${JSON.stringify(config, null, 2)}\n`);
}

async function readState() {
  if (!existsSync(statePath)) return [];
  const raw = stripBom(await readFile(statePath, "utf8"));
  if (!raw.trim()) return [];
  return JSON.parse(raw);
}

function stripBom(value) {
  return String(value || "").replace(/^\uFEFF/, "");
}

async function writeState(rows) {
  await writeTextFileSafely(statePath, `${JSON.stringify(rows, null, 2)}\n`);
}

async function writeTextFileSafely(filePath, content) {
  const tempPath = `${filePath}.${process.pid}.tmp`;
  const backupPath = `${filePath}.bak`;

  if (existsSync(filePath)) {
    try {
      await copyFile(filePath, backupPath);
    } catch {
      // A failed backup should not block saving the current change.
    }
  }

  await writeFile(tempPath, content, "utf8");
  await rename(tempPath, filePath);
}

function base32ToBuffer(value) {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
  const clean = value.toUpperCase().replace(/[^A-Z2-7]/g, "");
  if (!clean) throw new Error("TOTP secret is empty or invalid.");

  const bits = [];
  for (const char of clean) {
    const index = alphabet.indexOf(char);
    if (index < 0) throw new Error(`Invalid Base32 character in TOTP secret: ${char}`);
    for (let shift = 4; shift >= 0; shift -= 1) {
      bits.push((index >> shift) & 1);
    }
  }

  const bytes = [];
  for (let i = 0; i + 7 < bits.length; i += 8) {
    let byte = 0;
    for (let j = 0; j < 8; j += 1) {
      byte = (byte << 1) | bits[i + j];
    }
    bytes.push(byte);
  }

  return Buffer.from(bytes);
}

function getTotpCode(secret, digits = 6, periodSeconds = 30, unixSeconds = Math.floor(Date.now() / 1000)) {
  const key = base32ToBuffer(secret);
  const counter = Math.floor(unixSeconds / periodSeconds);
  const counterBytes = Buffer.alloc(8);
  counterBytes.writeBigUInt64BE(BigInt(counter));
  const hash = createHmac("sha1", key).update(counterBytes).digest();
  const offset = hash[hash.length - 1] & 0x0f;
  const binary =
    ((hash[offset] & 0x7f) << 24) |
    ((hash[offset + 1] & 0xff) << 16) |
    ((hash[offset + 2] & 0xff) << 8) |
    (hash[offset + 3] & 0xff);
  return String(binary % 10 ** digits).padStart(digits, "0");
}

function testTotpImplementation() {
  const actual = getTotpCode("GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ", 8, 30, 59);
  if (actual !== "94287082") {
    throw new Error(`Internal TOTP self-test failed. Expected 94287082, got ${actual}.`);
  }
}

function normalizeConfigAccounts(config, accounts) {
  const configAccounts = Array.isArray(config.accounts) && config.accounts.length
    ? config.accounts
    : accounts.map((account) => ({ index: account.index, enabled: true }));

  return configAccounts.map((item) => {
    const account = accounts[item.index];
    return {
      index: item.index,
      enabled: item.enabled !== false,
      email: account?.email ?? "",
      scriptName: item.scriptName || config.defaultScriptName || "",
      world: Number(item.world || config.defaultWorld || 301),
      worldMode: normalizeWorldMode(item.worldMode),
      scriptParams: Array.isArray(item.scriptParams) ? item.scriptParams : [],
      proxyId: normalizeProxyId(item.proxyId),
    };
  });
}

function normalizeProxy(proxy) {
  return {
    id: normalizeProxyId(proxy.id) || randomUUID(),
    name: String(proxy.name || "").trim(),
    host: String(proxy.host || "").trim(),
    port: Number(proxy.port || 0),
    username: String(proxy.username || ""),
    password: String(proxy.password || ""),
    enabled: proxy.enabled !== false,
  };
}

function normalizeProxies(config) {
  return (Array.isArray(config.proxies) ? config.proxies : [])
    .map(normalizeProxy)
    .filter((proxy) => proxy.name && proxy.host && Number.isInteger(proxy.port) && proxy.port > 0);
}

function buildArgs({ account, row, config }) {
  const totp = config.useGeneratedTotp ? getTotpCode(account.totpSecret) : account.totpSecret;
  const proxies = normalizeProxies(config);
  const proxy = proxies.find((item) => item.enabled && item.id === normalizeProxyId(row.proxyId));
  const world = resolveWorld(row, config);
  const args = [
    "-jar",
    config.launcherPath,
    "-script",
    row.scriptName || config.defaultScriptName,
    "-accountUsername",
    account.email,
    "-accountPassword",
    account.password,
    "-accountTotp",
    totp,
    "-world",
    world,
  ];

  if (proxy) {
    args.push("-proxyHost", proxy.host, "-proxyPort", String(proxy.port));
    if (proxy.username) args.push("-proxyUser", proxy.username);
    if (proxy.password) args.push("-proxyPass", proxy.password);
  }

  if (Array.isArray(row.scriptParams) && row.scriptParams.length) {
    args.push("-params", ...row.scriptParams);
  }

  return args;
}

function resolveWorld(row, config) {
  const mode = normalizeWorldMode(row.worldMode);
  if (mode === "random-f2p") return "f2p";
  if (mode === "random-p2p") return "members";
  return String(row.world || config.defaultWorld || 301);
}

function sanitizeConfig(config) {
  return {
    launcherPath: config.launcherPath,
    defaultScriptName: config.defaultScriptName,
    defaultWorld: config.defaultWorld,
    useGeneratedTotp: Boolean(config.useGeneratedTotp),
    launchDelaySeconds: Number(config.launchDelaySeconds || 0),
    maxInstances: Number(config.maxInstances || 1),
  };
}

async function getSnapshot() {
  const config = await readConfig();
  const accounts = await readAccounts();
  const rows = normalizeConfigAccounts(config, accounts);
  const proxies = normalizeProxies(config);
  const state = await readState();
  const alive = state.map((row) => {
    const running = isProcessRunning(row.pid);
    return { ...row, status: running ? "Running" : "StoppedOrUnknown" };
  });

  return {
    config: sanitizeConfig(config),
    accounts: accounts.map((account) => ({
      index: account.index,
      email: account.email,
      password: mask(account.password),
      totpSecret: mask(account.totpSecret),
      totpCode: getTotpCode(account.totpSecret),
    })),
    rows,
    proxies: proxies.map((proxy) => ({
      id: proxy.id,
      name: proxy.name,
      host: proxy.host,
      port: proxy.port,
      username: proxy.username,
      password: mask(proxy.password),
      enabled: proxy.enabled,
    })),
    launches: alive,
  };
}

function isProcessRunning(pid) {
  try {
    process.kill(Number(pid), 0);
    return true;
  } catch {
    return false;
  }
}

async function parseBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  if (!chunks.length) return {};
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

async function launchAccount(index) {
  const config = await readConfig();
  const accounts = await readAccounts();
  const rows = normalizeConfigAccounts(config, accounts);
  const row = rows.find((item) => item.index === index);
  const account = accounts[index];

  if (!row || !row.enabled) throw new Error(`Account index ${index} is not enabled in farm.json.`);
  if (!account) throw new Error(`Account index ${index} was not found in accounts.txt.`);
  if (!existsSync(config.launcherPath)) throw new Error(`DreamBot launcher not found: ${config.launcherPath}`);

  const existingLaunch = (await readState()).find((item) => Number(item.index) === index && isProcessRunning(item.pid));
  if (existingLaunch) throw new Error(`Account ${account.email} is already running.`);

  await mkdir(logsDir, { recursive: true });
  const safeEmail = account.email.replace(/[^a-zA-Z0-9._-]/g, "_");
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const stdoutPath = join(logsDir, `${stamp}-${safeEmail}.out.log`);
  const stderrPath = join(logsDir, `${stamp}-${safeEmail}.err.log`);
  const stdout = createWriteStream(stdoutPath, { flags: "a" });
  const stderr = createWriteStream(stderrPath, { flags: "a" });
  const child = spawn("java", buildArgs({ account, row, config }), {
    cwd: rootDir,
    windowsHide: false,
    detached: true,
    stdio: ["ignore", stdout, stderr],
  });

  stdout.unref?.();
  stderr.unref?.();
  child.unref();

  const state = await readState();
  state.push({
    email: account.email,
    index,
    scriptName: row.scriptName,
    world: row.world,
    pid: child.pid,
    startedAt: new Date().toISOString(),
    stdout: stdoutPath,
    stderr: stderrPath,
  });
  await writeState(state);

  return { pid: child.pid };
}

async function stopProcess(pid) {
  const parsed = Number(pid);
  if (!Number.isInteger(parsed)) throw new Error("Invalid pid.");
  process.kill(parsed);
  return { stopped: parsed };
}

async function addAccount(body) {
  const email = String(body.email || "").trim();
  const password = String(body.password || "");
  const totpSecret = String(body.totpSecret || "").trim();
  if (!email || !password || !totpSecret) throw new Error("Email, password and TOTP secret are required.");
  getTotpCode(totpSecret);

  const accounts = await readAccounts();
  accounts.push({ email, password, totpSecret });
  await writeAccounts(accounts);

  const config = await readConfig();
  if (!Array.isArray(config.accounts)) config.accounts = [];
  config.accounts.push({
    index: accounts.length - 1,
    enabled: true,
    scriptName: config.defaultScriptName || "Teste",
    world: Number(config.defaultWorld || 301),
    worldMode: "fixed",
    scriptParams: [],
    proxyId: "",
  });
  await writeConfig(config);
  return { added: accounts.length - 1 };
}

async function bulkImportAccounts(body) {
  const parsed = parseBulkAccountLines(body.accountsText);
  const accounts = await readAccounts();
  const existingEmails = new Set(accounts.map((account) => account.email.toLowerCase()));
  const seenEmails = new Set();
  const added = [];
  const duplicates = [];

  for (const account of parsed.valid) {
    const key = account.email.toLowerCase();
    if (existingEmails.has(key) || seenEmails.has(key)) {
      duplicates.push({
        lineNumber: account.lineNumber,
        email: account.email,
      });
      continue;
    }

    seenEmails.add(key);
    added.push({
      email: account.email,
      password: account.password,
      totpSecret: account.totpSecret,
    });
  }

  if (added.length > 0) {
    const startIndex = accounts.length;
    const nextAccounts = accounts.concat(added);
    await writeAccounts(nextAccounts);

    const config = await readConfig();
    if (!Array.isArray(config.accounts)) config.accounts = [];
    added.forEach((account, offset) => {
      config.accounts.push({
        index: startIndex + offset,
        enabled: true,
        scriptName: config.defaultScriptName || "Teste",
        world: Number(config.defaultWorld || 301),
        worldMode: "fixed",
        scriptParams: [],
        proxyId: "",
      });
    });
    await writeConfig(config);
  }

  return {
    totalLines: parsed.totalLines,
    added: added.length,
    invalid: parsed.invalid,
    duplicates,
  };
}

async function updateSettings(body) {
  const config = await readConfig();
  config.launcherPath = String(body.launcherPath || config.launcherPath || "");
  config.defaultScriptName = String(body.defaultScriptName || "");
  config.defaultWorld = Number(body.defaultWorld || 301);
  config.useGeneratedTotp = Boolean(body.useGeneratedTotp);
  config.launchDelaySeconds = Number(body.launchDelaySeconds || 0);
  config.maxInstances = Number(body.maxInstances || 1);
  await writeConfig(config);
  return { saved: true };
}

async function updateRow(body) {
  const index = Number(body.index);
  if (!Number.isInteger(index)) throw new Error("Invalid account index.");

  const config = await readConfig();
  if (!Array.isArray(config.accounts)) config.accounts = [];
  const existing = config.accounts.find((item) => Number(item.index) === index);
  const row = existing || { index };
  row.enabled = body.enabled !== false;
  row.scriptName = String(body.scriptName || config.defaultScriptName || "");
  row.world = Number(body.world || config.defaultWorld || 301);
  row.worldMode = normalizeWorldMode(body.worldMode);
  row.scriptParams = String(body.scriptParams || "")
    .split(/\s+/)
    .map((item) => item.trim())
    .filter(Boolean);
  row.proxyId = normalizeProxyId(body.proxyId);

  if (!existing) config.accounts.push(row);
  await writeConfig(config);
  return { saved: true };
}

async function addProxy(body) {
  const proxy = normalizeProxy({
    id: randomUUID(),
    name: body.name,
    host: body.host,
    port: body.port,
    username: body.username,
    password: body.password,
    enabled: body.enabled,
  });

  if (!proxy.name || !proxy.host || !Number.isInteger(proxy.port) || proxy.port < 1) {
    throw new Error("Name, host and port are required for proxy.");
  }

  const config = await readConfig();
  config.proxies = normalizeProxies(config);
  config.proxies.push(proxy);
  await writeConfig(config);
  return { added: proxy.id };
}

async function bulkImportProxies(body) {
  const parsed = parseBulkProxyLines(body.proxiesText);
  const config = await readConfig();
  const proxies = normalizeProxies(config);
  const existingNames = new Set(proxies.map((proxy) => proxy.name.toLowerCase()));
  const seenNames = new Set();
  const added = [];
  const duplicates = [];

  for (const proxy of parsed.valid) {
    const key = proxy.name.toLowerCase();
    if (existingNames.has(key) || seenNames.has(key)) {
      duplicates.push({ lineNumber: proxy.lineNumber, name: proxy.name });
      continue;
    }

    seenNames.add(key);
    added.push(normalizeProxy({
      id: randomUUID(),
      name: proxy.name,
      host: proxy.host,
      port: proxy.port,
      username: proxy.username,
      password: proxy.password,
      enabled: true,
    }));
  }

  if (added.length > 0) {
    config.proxies = proxies.concat(added);
    await writeConfig(config);
  }

  return {
    totalLines: parsed.totalLines,
    added: added.length,
    invalid: parsed.invalid,
    duplicates,
  };
}

async function deleteProxy(body) {
  const id = normalizeProxyId(body.id);
  if (!id) throw new Error("Invalid proxy id.");

  const config = await readConfig();
  config.proxies = normalizeProxies(config).filter((proxy) => proxy.id !== id);
  if (Array.isArray(config.accounts)) {
    config.accounts = config.accounts.map((account) => (
      normalizeProxyId(account.proxyId) === id ? { ...account, proxyId: "" } : account
    ));
  }
  await writeConfig(config);
  return { deleted: id };
}

async function serveStatic(req, res) {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const pathname = url.pathname === "/" ? "/index.html" : decodeURIComponent(url.pathname);
  const filePath = resolve(publicDir, `.${pathname}`);
  if (!filePath.startsWith(publicDir)) {
    json(res, 403, { error: "Forbidden" });
    return;
  }

  try {
    const file = await readFile(filePath);
    res.writeHead(200, {
      "Content-Type": contentTypes[extname(filePath)] || "application/octet-stream",
      "Cache-Control": "no-store",
    });
    res.end(file);
  } catch {
    json(res, 404, { error: "Not found" });
  }
}

testTotpImplementation();
await mkdir(publicDir, { recursive: true });
await open(statePath, "a").then((handle) => handle.close());

const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://${req.headers.host}`);

    if (url.pathname === "/api/state" && req.method === "GET") {
      json(res, 200, await getSnapshot());
      return;
    }

    if (url.pathname === "/api/account" && req.method === "POST") {
      json(res, 200, await addAccount(await parseBody(req)));
      return;
    }

    if (url.pathname === "/api/accounts/bulk" && req.method === "POST") {
      json(res, 200, await bulkImportAccounts(await parseBody(req)));
      return;
    }

    if (url.pathname === "/api/proxy" && req.method === "POST") {
      json(res, 200, await addProxy(await parseBody(req)));
      return;
    }

    if (url.pathname === "/api/proxies/bulk" && req.method === "POST") {
      json(res, 200, await bulkImportProxies(await parseBody(req)));
      return;
    }

    if (url.pathname === "/api/proxy/delete" && req.method === "POST") {
      json(res, 200, await deleteProxy(await parseBody(req)));
      return;
    }

    if (url.pathname === "/api/settings" && req.method === "POST") {
      json(res, 200, await updateSettings(await parseBody(req)));
      return;
    }

    if (url.pathname === "/api/row" && req.method === "POST") {
      json(res, 200, await updateRow(await parseBody(req)));
      return;
    }

    if (url.pathname === "/api/launch" && req.method === "POST") {
      const body = await parseBody(req);
      json(res, 200, await launchAccount(Number(body.index)));
      return;
    }

    if (url.pathname === "/api/stop" && req.method === "POST") {
      const body = await parseBody(req);
      json(res, 200, await stopProcess(body.pid));
      return;
    }

    await serveStatic(req, res);
  } catch (error) {
    json(res, 500, { error: error.message || String(error) });
  }
});

server.listen(port, bindHost, () => {
  const shownHost = bindHost === "0.0.0.0" ? "localhost" : bindHost;
  console.log(`NeuraL Farm Control running at http://${shownHost}:${port}`);
  if (bindHost === "0.0.0.0") {
    console.log(`Network access enabled on port ${port}. Use this only on a trusted network.`);
  }
});
