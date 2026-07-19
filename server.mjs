import { createServer } from "node:http";
import { appendFile, copyFile, mkdir, open, readFile, readdir, rename, stat, writeFile } from "node:fs/promises";
import { existsSync, createWriteStream, readdirSync, readFileSync } from "node:fs";
import { delimiter, extname, join, resolve } from "node:path";
import { execFile, spawn } from "node:child_process";
import { createServer as createTcpServer } from "node:net";
import { createHmac, randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { dirname } from "node:path";
import { promisify } from "node:util";

const rootDir = dirname(fileURLToPath(import.meta.url));
const publicDir = join(rootDir, "public");
const dataDir = process.env.NFC_DATA_DIR ? resolve(process.env.NFC_DATA_DIR) : join(rootDir, "data");
const configPath = join(dataDir, "farm.json");
const accountsPath = join(dataDir, "accounts.txt");
const statePath = join(dataDir, "web-farm-state.json");
const logsDir = join(dataDir, "logs");
const checkerLogPath = join(logsDir, "checker.log");
const versionPath = join(rootDir, "VERSION");
const openAiResponsesEndpoint = "https://api.openai.com/v1/responses";
const dreamBotLogsDir = join(process.env.USERPROFILE || "", "DreamBot", "Logs");
const dreamBotScriptsDir = join(process.env.USERPROFILE || "", "DreamBot", "Scripts");
const nickCaptureScriptName = "NeuraL Nick Capture v2";
const nickCaptureJarPath = join(dreamBotScriptsDir, "NeuraLNickCapture.jar");
const projectNickCaptureJarPath = join(rootDir, "tools", "nick-capture-helper", "dist", "NeuraLNickCapture.jar");
const port = Number(process.env.PORT || 3000);
const bindHost = process.env.BIND_HOST || "127.0.0.1";
const execFileAsync = promisify(execFile);
let jagexLoginQueue = Promise.resolve();
const javaProcessCache = { at: 0, value: [], promise: null };
const windowTitleCache = { at: 0, value: new Map(), promise: null };
const jcefDiagnosticsCache = { at: 0, value: null, promise: null };
const machineDiagnosticsCache = { at: 0, value: null, promise: null };
let appStateWriteQueue = Promise.resolve();

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

async function readVersion() {
  try {
    return (await readFile(versionPath, "utf8")).trim() || "0.0.0";
  } catch {
    return "0.0.0";
  }
}

function mask(value) {
  if (!value) return "";
  if (value.length <= 4) return "*".repeat(value.length);
  return `${value.slice(0, 2)}${"*".repeat(Math.min(10, value.length - 4))}${value.slice(-2)}`;
}

function normalizeProxyId(value) {
  return String(value || "").trim();
}

function normalizeCategory(value) {
  const category = String(value || "").trim();
  return category || "default";
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
      tribotCliPath: "",
      epicBotPath: "",
      accountsFile: ".\\data\\accounts.txt",
      defaultScriptName: "Teste",
      defaultWorld: 301,
      useGeneratedTotp: false,
      useJagexBrowserLogin: true,
      jagexDebug: false,
      useStoredGameAccount: false,
      launchDelaySeconds: 20,
      maxInstances: 2,
      epicBot: {
        platform: "",
        heap: "",
        maxHeap: "",
        mouseProfile: "",
        useSavedProxyName: false,
      },
      ai: {
        enabled: false,
        provider: "openai",
        openAiApiKey: "",
        model: "gpt-5.6-luna",
        includeCheckerLog: true,
        includeLaunchLogs: true,
      },
      proxies: [],
      accounts: [],
      categories: ["default"],
      continuous: {
        enabled: false,
        checkIntervalSeconds: 30,
      },
      continuousTasks: [],
    };
  }

  const config = JSON.parse(stripBom(await readFile(configPath, "utf8")));
  if (!Array.isArray(config.proxies)) config.proxies = [];
  if (!Array.isArray(config.accounts)) config.accounts = [];
  if (!Array.isArray(config.categories)) config.categories = [];
  if (!config.continuous || typeof config.continuous !== "object") config.continuous = {};
  if (!Array.isArray(config.continuousTasks)) config.continuousTasks = [];
  if (!config.ai || typeof config.ai !== "object") config.ai = {};
  if (!config.epicBot || typeof config.epicBot !== "object") config.epicBot = {};
  return config;
}

async function writeConfig(config) {
  await writeTextFileSafely(configPath, `${JSON.stringify(config, null, 2)}\n`);
}

async function readState() {
  const state = await readAppState();
  return state.launches;
}

function defaultAppState() {
  return { launches: [], continuous: defaultContinuousState(), hiscores: {}, checker: {}, discordNotifications: {} };
}

function normalizeCheckerState(checker) {
  if (!checker || typeof checker !== "object") return {};
  return Object.fromEntries(Object.entries(checker).map(([key, value]) => {
    if (!value || typeof value !== "object") return [key, value];
    const totalLevel = Number(value.totalLevel || 0);
    const hasHiscoreEvidence = totalLevel > 0 || value.status === "ok";
    return [
      key,
      {
        ...value,
        status: hasHiscoreEvidence ? "ok" : value.status,
        totalLevel: totalLevel > 0 ? totalLevel : value.totalLevel,
        message: String(value.message || "").replace(/\b[Dd]etectido\b/g, (match) =>
          match[0] === "D" ? "Detectado" : "detectado"
        ),
      },
    ];
  }));
}

function checkerHasHiscoreEvidence(result, row, hiscores = {}) {
  if (!result || typeof result !== "object") return false;
  if (result.status === "ok") return true;
  if (Number(result.totalLevel || 0) > 0) return true;
  const names = [
    result.charName,
    row?.charName,
    row?.accountNickname,
    row?.jagexDisplayName,
  ].map((value) => normalizePlayerName(value).toLowerCase()).filter(Boolean);
  return names.some((name) => Number(hiscores?.[name]?.totalLevel || 0) > 0);
}

function sanitizeCheckerStateAgainstHiscores(checker, rows = [], hiscores = {}) {
  if (!checker || typeof checker !== "object") return { checker: {}, changed: false };
  const rowByIndex = new Map(rows.map((row) => [Number(row.index), row]));
  let changed = false;
  const normalized = {};

  for (const [key, value] of Object.entries(checker)) {
    if (!value || typeof value !== "object") {
      normalized[key] = value;
      continue;
    }

    if (value.status === "banned" && checkerHasHiscoreEvidence(value, rowByIndex.get(Number(key)), hiscores)) {
      changed = true;
      const charName = normalizePlayerName(value.charName || rowByIndex.get(Number(key))?.charName || "");
      const cached = hiscores?.[charName.toLowerCase()];
      normalized[key] = {
        ...value,
        status: "ok",
        message: "Conta encontrada no HiScores. Status banido antigo corrigido.",
        charName: charName || value.charName || "",
        totalLevel: Number(value.totalLevel || cached?.totalLevel || 0) || value.totalLevel,
        combatLevel: Number(value.combatLevel || cached?.combatLevel || 0) || value.combatLevel,
      };
    } else {
      normalized[key] = value;
    }
  }

  return { checker: normalized, changed };
}

async function readAppState() {
  if (!existsSync(statePath)) return defaultAppState();
  const raw = stripBom(await readFile(statePath, "utf8"));
  if (!raw.trim()) return defaultAppState();
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    const repaired = parseFirstJsonValue(raw);
    if (!repaired) throw error;
    parsed = repaired;
    await writeTextFileSafely(`${statePath}.corrupt-${Date.now()}.bak`, raw);
    await writeAppState(parsed);
  }
  if (Array.isArray(parsed)) {
    return { ...defaultAppState(), launches: parsed };
  }

  return {
    launches: Array.isArray(parsed.launches) ? parsed.launches : [],
    continuous: normalizeContinuousState(parsed.continuous),
    hiscores: parsed.hiscores && typeof parsed.hiscores === "object" ? parsed.hiscores : {},
    checker: normalizeCheckerState(parsed.checker),
    discordNotifications: parsed.discordNotifications && typeof parsed.discordNotifications === "object" ? parsed.discordNotifications : {},
  };
}

function stripBom(value) {
  return String(value || "").replace(/^\uFEFF/, "");
}

async function writeState(rows) {
  const state = await readAppState();
  state.launches = Array.isArray(rows) ? rows : [];
  await writeAppState(state);
}

async function writeAppState(state) {
  const payload = `${JSON.stringify({
    launches: Array.isArray(state.launches) ? state.launches : [],
    continuous: normalizeContinuousState(state.continuous),
    hiscores: state.hiscores && typeof state.hiscores === "object" ? state.hiscores : {},
    checker: normalizeCheckerState(state.checker),
    discordNotifications: trimNotificationState(state.discordNotifications),
  }, null, 2)}\n`;
  appStateWriteQueue = appStateWriteQueue
    .catch(() => {})
    .then(() => writeTextFileSafely(statePath, payload));
  await appStateWriteQueue;
}

function trimNotificationState(value) {
  const source = value && typeof value === "object" ? value : {};
  const entries = Object.entries(source)
    .map(([key, item]) => [key, item && typeof item === "object" ? item : { at: String(item || "") }])
    .sort((a, b) => Date.parse(b[1].at || 0) - Date.parse(a[1].at || 0))
    .slice(0, 200);
  return Object.fromEntries(entries);
}

function defaultContinuousState() {
  return {
    running: false,
    lastCheckAt: "",
    nextCheckAt: "",
    lastTaskIndex: -1,
    cooldowns: {},
    logs: [],
  };
}

function normalizeContinuousState(value = {}) {
  const state = value && typeof value === "object" ? value : {};
  return {
    running: Boolean(state.running),
    lastCheckAt: String(state.lastCheckAt || ""),
    nextCheckAt: String(state.nextCheckAt || ""),
    lastTaskIndex: Number.isInteger(Number(state.lastTaskIndex)) ? Number(state.lastTaskIndex) : -1,
    cooldowns: state.cooldowns && typeof state.cooldowns === "object" ? state.cooldowns : {},
    logs: Array.isArray(state.logs) ? state.logs.slice(-80) : [],
  };
}

async function writeTextFileSafely(filePath, content) {
  const tempPath = `${filePath}.${process.pid}.${randomUUID()}.tmp`;
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

function parseFirstJsonValue(raw) {
  let depth = 0;
  let inString = false;
  let escaped = false;
  let started = false;
  for (let index = 0; index < raw.length; index += 1) {
    const char = raw[index];
    if (!started) {
      if (/\s/.test(char)) continue;
      if (char !== "{" && char !== "[") return null;
      started = true;
    }

    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (char === "\\") {
        escaped = true;
      } else if (char === "\"") {
        inString = false;
      }
      continue;
    }

    if (char === "\"") {
      inString = true;
    } else if (char === "{" || char === "[") {
      depth += 1;
    } else if (char === "}" || char === "]") {
      depth -= 1;
      if (started && depth === 0) {
        try {
          return JSON.parse(raw.slice(0, index + 1));
        } catch {
          return null;
        }
      }
    }
  }
  return null;
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

  const byIndex = new Map();
  for (const item of configAccounts) {
    const index = Number(item?.index);
    if (!Number.isInteger(index) || byIndex.has(index)) continue;
    byIndex.set(index, item);
  }

  return accounts.map((account) => {
    const item = byIndex.get(Number(account.index)) || { index: account.index, enabled: true };
    return {
      index: account.index,
      enabled: item.enabled !== false,
      email: account.email ?? "",
      accountNickname: String(item.accountNickname || "").trim(),
      botClient: normalizeBotClient(item.botClient),
      jagexSessionId: String(item.jagexSessionId || "").trim(),
      jagexCharacterId: String(item.jagexCharacterId || "").trim(),
      jagexDisplayName: String(item.jagexDisplayName || "").trim(),
      jagexAccessToken: String(item.jagexAccessToken || "").trim(),
      jagexRefreshToken: String(item.jagexRefreshToken || "").trim(),
      notes: String(item.notes || "").trim(),
      charName: String(item.charName || "").trim(),
      category: normalizeCategory(item.category),
      scriptName: item.scriptName || config.defaultScriptName || "",
      scheduleName: String(item.scheduleName || "").trim(),
      epicBotProfilePath: String(item.epicBotProfilePath || "").trim(),
      world: Number(item.world || config.defaultWorld || 301),
      worldMode: normalizeWorldMode(item.worldMode),
      scriptParams: Array.isArray(item.scriptParams) ? item.scriptParams : [],
      proxyId: normalizeProxyId(item.proxyId),
    };
  });
}

function normalizeCategories(config, rows = [], tasks = []) {
  const values = [
    "default",
    ...(Array.isArray(config.categories) ? config.categories : []),
    ...rows.map((row) => row.category),
    ...tasks.map((task) => task.category),
  ];

  return Array.from(new Set(values.map(normalizeCategory))).sort((a, b) => a.localeCompare(b));
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

function parseScriptParams(value) {
  if (Array.isArray(value)) return value.map((item) => String(item).trim()).filter(Boolean);
  return String(value || "")
    .split(/\s+/)
    .map((item) => item.trim())
    .filter(Boolean);
}

function normalizeProxyMode(value) {
  const mode = String(value || "account").trim();
  return ["account", "task", "none"].includes(mode) ? mode : "account";
}

function normalizeTask(task, config = {}) {
  const id = String(task.id || "").trim() || randomUUID();
  const maxInstances = Number(task.maxInstances || 1);
  const launchDelaySeconds = Number(task.launchDelaySeconds ?? config.launchDelaySeconds ?? 0);
  const cooldownMinutes = Number(task.cooldownMinutes || 0);
  const completionLevel = Number(task.completionLevel || 0);
  const scheduleName = String(task.scheduleName || "").trim();
  return {
    id,
    name: String(task.name || id).trim(),
    category: normalizeCategory(task.category),
    scriptName: String(task.scriptName || (scheduleName ? "" : config.defaultScriptName || "")).trim(),
    scheduleName,
    scriptParams: parseScriptParams(task.scriptParams),
    epicBotProfilePath: String(task.epicBotProfilePath || "").trim(),
    world: Number(task.world || config.defaultWorld || 301),
    worldMode: normalizeWorldMode(task.worldMode),
    proxyMode: normalizeProxyMode(task.proxyMode),
    proxyId: normalizeProxyId(task.proxyId),
    completionSkill: normalizeCompletionSkill(task.completionSkill),
    completionLevel: Number.isFinite(completionLevel) && completionLevel > 0 ? Math.floor(completionLevel) : 0,
    moveToCategoryOnComplete: String(task.moveToCategoryOnComplete || "").trim(),
    maxInstances: Number.isFinite(maxInstances) && maxInstances > 0 ? Math.floor(maxInstances) : 1,
    launchDelaySeconds: Number.isFinite(launchDelaySeconds) && launchDelaySeconds > 0 ? Math.floor(launchDelaySeconds) : 0,
    cooldownMinutes: Number.isFinite(cooldownMinutes) && cooldownMinutes > 0 ? Math.floor(cooldownMinutes) : 0,
    enabled: task.enabled !== false,
  };
}

function normalizeTasks(config) {
  return (Array.isArray(config.continuousTasks) ? config.continuousTasks : [])
    .map((task) => normalizeTask(task, config))
    .filter((task) => task.name && (task.scriptName || task.scheduleName));
}

function normalizeContinuousConfig(config) {
  const value = config.continuous && typeof config.continuous === "object" ? config.continuous : {};
  const checkIntervalSeconds = Number(value.checkIntervalSeconds || 30);
  return {
    enabled: Boolean(value.enabled),
    checkIntervalSeconds: Number.isFinite(checkIntervalSeconds) && checkIntervalSeconds >= 5
      ? Math.floor(checkIntervalSeconds)
      : 30,
  };
}

function normalizeDiscordWebhookConfig(config) {
  const value = config.discordWebhook && typeof config.discordWebhook === "object" ? config.discordWebhook : {};
  return {
    url: String(value.url || "").trim(),
    enabled: Boolean(value.enabled),
    notifyOnStop: value.notifyOnStop !== false,
    includeLogTail: value.includeLogTail !== false,
  };
}

function normalizeAiConfig(config = {}) {
  const value = config.ai && typeof config.ai === "object" ? config.ai : {};
  return {
    enabled: Boolean(value.enabled),
    provider: "openai",
    openAiApiKey: String(value.openAiApiKey || process.env.OPENAI_API_KEY || "").trim(),
    model: String(value.model || process.env.OPENAI_MODEL || "gpt-5.6-luna").trim(),
    includeCheckerLog: value.includeCheckerLog !== false,
    includeLaunchLogs: value.includeLaunchLogs !== false,
  };
}

function sanitizeAiConfig(config = {}) {
  const ai = normalizeAiConfig(config);
  return {
    enabled: ai.enabled,
    provider: ai.provider,
    model: ai.model,
    apiKeyConfigured: Boolean(ai.openAiApiKey),
    includeCheckerLog: ai.includeCheckerLog,
    includeLaunchLogs: ai.includeLaunchLogs,
  };
}

function normalizeBotClient(value) {
  const clean = String(value || "").trim().toLowerCase();
  if (clean === "tribot") return "tribot";
  if (clean === "epicbot") return "epicbot";
  return "dreambot";
}

function normalizePositiveIntegerText(value) {
  const raw = String(value || "").trim();
  if (!raw) return "";
  const parsed = Number(raw);
  return Number.isInteger(parsed) && parsed > 0 ? String(parsed) : "";
}

function normalizeEpicBotConfig(config = {}) {
  const value = config.epicBot && typeof config.epicBot === "object" ? config.epicBot : {};
  return {
    platform: String(value.platform || "").trim(),
    heap: normalizePositiveIntegerText(value.heap),
    maxHeap: normalizePositiveIntegerText(value.maxHeap),
    mouseProfile: String(value.mouseProfile || "").trim(),
    useSavedProxyName: Boolean(value.useSavedProxyName),
  };
}

function compareVersionText(a, b) {
  const partsA = String(a || "").split(".").map((part) => Number(part) || 0);
  const partsB = String(b || "").split(".").map((part) => Number(part) || 0);
  const length = Math.max(partsA.length, partsB.length);
  for (let index = 0; index < length; index += 1) {
    const diff = (partsA[index] || 0) - (partsB[index] || 0);
    if (diff !== 0) return diff;
  }
  return 0;
}

function maskEmail(value) {
  const email = String(value || "").trim();
  const match = email.match(/^([^@\s]+)@([^@\s]+)$/);
  if (!match) return mask(email);
  const [, name, domain] = match;
  const visible = name.slice(0, Math.min(3, name.length));
  return `${visible}${"*".repeat(Math.min(8, Math.max(2, name.length - visible.length)))}@${domain}`;
}

function redactSensitiveText(text) {
  return String(text || "")
    .replace(/[A-Z2-7]{8,}/gi, (value) => (value.length >= 12 ? mask(value) : value))
    .replace(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, (value) => maskEmail(value))
    .replace(/(accountPassword|accountPass|password|pass|senha|totp|secret|sessionId|accessToken|refreshToken|proxyPass|webhook)(\s*[=:]\s*|\s+)(["']?)[^\s"']+/gi, (_match, key, sep, quote) => `${key}${sep}${quote}${mask("redacted")}`)
    .replace(/https:\/\/discord\.com\/api\/webhooks\/[^\s"']+/gi, "https://discord.com/api/webhooks/***");
}

function truncateText(value, maxLength) {
  const text = String(value || "");
  if (text.length <= maxLength) return text;
  return `${text.slice(0, Math.floor(maxLength / 2))}\n...[trecho removido para caber no contexto]...\n${text.slice(-Math.floor(maxLength / 2))}`;
}

function resolveTribotCliPath(config = {}) {
  const candidates = [
    String(config.tribotCliPath || "").trim(),
    process.env.LOCALAPPDATA ? join(process.env.LOCALAPPDATA, "Tribot", "tribot-x.exe") : "",
    process.env.LOCALAPPDATA ? join(process.env.LOCALAPPDATA, "org.tribot.x", "tribot-x.exe") : "",
    process.env.ProgramFiles ? join(process.env.ProgramFiles, "Tribot", "tribot-x.exe") : "",
  ].filter(Boolean);

  return candidates.find((candidate) => existsSync(candidate)) || "";
}

function resolveEpicBotPath(config = {}) {
  const userProfile = process.env.USERPROFILE || "";
  const candidates = [
    String(config.epicBotPath || "").trim(),
    process.env.LOCALAPPDATA ? join(process.env.LOCALAPPDATA, "EpicBot", "EpicBot-NXT.exe") : "",
    process.env.ProgramFiles ? join(process.env.ProgramFiles, "EpicBot", "EpicBot-NXT.exe") : "",
    process.env["ProgramFiles(x86)"] ? join(process.env["ProgramFiles(x86)"], "EpicBot", "EpicBot-NXT.exe") : "",
    userProfile ? join(userProfile, "EpicBot", "EpicBot-NXT.exe") : "",
    userProfile ? join(userProfile, "Documents", "EpicBot", "EpicBot-NXT.exe") : "",
    userProfile ? join(userProfile, "OneDrive", "Documents", "EpicBot", "EpicBot-NXT.exe") : "",
    userProfile ? join(userProfile, "OneDrive", "Documentos", "EpicBot", "EpicBot-NXT.exe") : "",
    userProfile ? join(userProfile, "Downloads", "EpicBot-NXT.exe") : "",
    ...findEpicBotExecutablesInFolder(userProfile ? join(userProfile, "Downloads") : ""),
    ...findEpicBotExecutablesInFolder(userProfile ? join(userProfile, "Desktop") : ""),
    ...findEpicBotExecutablesInFolder(userProfile ? join(userProfile, "OneDrive", "Documentos", "EpicBot") : ""),
  ].filter(Boolean);

  return candidates.find((candidate) => existsSync(candidate)) || "";
}

function resolveEpicBotHome() {
  const userProfile = process.env.USERPROFILE || "";
  const candidates = [
    userProfile ? join(userProfile, "EpicBot") : "",
    process.env.APPDATA ? join(process.env.APPDATA, "EpicBot") : "",
    process.env.LOCALAPPDATA ? join(process.env.LOCALAPPDATA, "EpicBot") : "",
  ].filter(Boolean);
  return candidates.find((candidate) => existsSync(join(candidate, "lib"))) || "";
}

function readEpicBotJagexAccounts() {
  const home = resolveEpicBotHome();
  const path = home ? join(home, "jagex_accounts.json") : "";
  if (!path || !existsSync(path)) return [];
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8"));
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function findEpicBotStoredSession(account, row = {}) {
  const email = String(account?.email || "").trim().toLowerCase();
  if (!email) return null;
  const stored = readEpicBotJagexAccounts()
    .find((item) => String(item.email || "").trim().toLowerCase() === email);
  if (!stored?.sessionId) return null;

  const rowChar = normalizePlayerName(row.charName || row.jagexDisplayName || row.accountNickname || "").toLowerCase();
  const characters = Array.isArray(stored.rsAccounts) ? stored.rsAccounts : [];
  const selectedCharacter = characters.find((character) => (
    rowChar && normalizePlayerName(character.displayName || "").toLowerCase() === rowChar
  )) || characters[0] || {};

  return {
    jagexSessionId: String(stored.sessionId || "").trim(),
    jagexCharacterId: String(selectedCharacter.accountId || row.jagexCharacterId || "").trim(),
    charName: normalizePlayerName(selectedCharacter.displayName || row.charName || ""),
  };
}

function findEpicBotJavaExecutablesInFolder(folder) {
  if (!folder || !existsSync(folder)) return [];
  try {
    const candidates = [];
    for (const entry of readdirSync(folder, { withFileTypes: true })) {
      if (!entry.isDirectory() || !/epicbot/i.test(entry.name)) continue;
      candidates.push(join(folder, entry.name, "jre-21", "bin", "java.exe"));
      candidates.push(join(folder, entry.name, "jre", "bin", "java.exe"));
    }
    return candidates;
  } catch {
    return [];
  }
}

function resolveEpicBotJavaPath(config = {}) {
  const userProfile = process.env.USERPROFILE || "";
  const configuredLauncher = resolveEpicBotPath(config);
  const configuredDir = configuredLauncher ? dirname(configuredLauncher) : "";
  const candidates = [
    configuredDir ? join(configuredDir, "jre-21", "bin", "java.exe") : "",
    configuredDir ? join(configuredDir, "jre", "bin", "java.exe") : "",
    ...findEpicBotJavaExecutablesInFolder(userProfile ? join(userProfile, "Downloads") : ""),
    ...findEpicBotJavaExecutablesInFolder(userProfile ? join(userProfile, "Desktop") : ""),
    process.env.JAVA_HOME ? join(process.env.JAVA_HOME, "bin", "java.exe") : "",
  ].filter(Boolean);
  return candidates.find((candidate) => existsSync(candidate)) || "";
}

function buildEpicBotClasspath(libDir) {
  if (!libDir || !existsSync(libDir)) return "";
  const selected = new Map();

  try {
    for (const entry of readdirSync(libDir, { withFileTypes: true })) {
      if (!entry.isFile() || !/\.jar$/i.test(entry.name)) continue;
      const versioned = entry.name.match(/^(epicbot-.+)-(\d+(?:\.\d+)+)\.jar$/i);
      const key = versioned ? versioned[1].toLowerCase() : entry.name.toLowerCase();
      const current = selected.get(key);
      const candidate = {
        name: entry.name,
        version: versioned ? versioned[2] : "",
        path: join(libDir, entry.name),
      };

      if (!current || compareVersionText(candidate.version, current.version) > 0) {
        selected.set(key, candidate);
      }
    }
  } catch {
    return "";
  }

  return [...selected.values()]
    .sort((a, b) => a.name.localeCompare(b.name))
    .map((item) => item.path)
    .join(delimiter);
}

function resolveEpicBotRuntime(config = {}) {
  const home = resolveEpicBotHome();
  const javaPath = resolveEpicBotJavaPath(config);
  const libDir = home ? join(home, "lib") : "";
  const classpath = buildEpicBotClasspath(libDir);
  if (!home || !javaPath || !classpath) return null;
  return { home, javaPath, classpath };
}

function buildEpicBotLaunchPlan(config = {}, { preferRuntime = true } = {}) {
  const runtime = preferRuntime ? resolveEpicBotRuntime(config) : null;
  if (runtime) {
    const epicBot = normalizeEpicBotConfig(config);
    const javaArgs = ["-Djava.net.preferIPv4Stack=true"];
    if (epicBot.heap) javaArgs.push(`-Xms${epicBot.heap}m`);
    if (epicBot.maxHeap) javaArgs.push(`-Xmx${epicBot.maxHeap}m`);
    javaArgs.push("-cp", runtime.classpath, "com.epicbot.client.nxt.Boot");
    return {
      mode: "runtime",
      command: runtime.javaPath,
      argsPrefix: javaArgs,
      cwd: runtime.home,
    };
  }

  const launcherPath = resolveEpicBotPath(config);
  if (!launcherPath) return null;
  return {
    mode: "launcher",
    command: launcherPath,
    argsPrefix: [],
    cwd: rootDir,
  };
}

function findEpicBotExecutablesInFolder(folder) {
  if (!folder || !existsSync(folder)) return [];
  try {
    const candidates = [];
    for (const entry of readdirSync(folder, { withFileTypes: true })) {
      if (!entry.isDirectory() || !/epicbot/i.test(entry.name)) continue;
      const dir = join(folder, entry.name);
      candidates.push(join(dir, "EpicBot-NXT.exe"));
      candidates.push(join(dir, "EpicBot.exe"));
    }
    return candidates;
  } catch {
    return [];
  }
}

function formatMissingEpicBotPathMessage(config = {}) {
  const configured = String(config.epicBotPath || "").trim();
  if (configured) {
    return `EpicBot nao encontrado em: ${configured}. Confira a aba Config ou abra o EpicBot uma vez para montar C:\\Users\\<usuario>\\EpicBot.`;
  }
  return "EpicBot nao encontrado. Abra o EpicBot manualmente uma vez ou informe o caminho do EpicBot-NXT.exe na aba Config.";
}

function buildTaskRow(row, task) {
  let proxyId = row.proxyId;
  if (task.proxyMode === "task") proxyId = task.proxyId;
  if (task.proxyMode === "none") proxyId = "";

  return {
    ...row,
    scriptName: task.scriptName,
    scheduleName: task.scheduleName,
    scriptParams: task.scriptParams,
    epicBotProfilePath: task.epicBotProfilePath,
    world: task.world,
    worldMode: task.worldMode,
    proxyId,
  };
}

function normalizeLaunchOverride(body, config) {
  if (!body || typeof body !== "object") return null;
  if (
    body.scriptName === undefined &&
    body.scheduleName === undefined &&
    body.scriptParams === undefined &&
    body.epicBotProfilePath === undefined &&
    body.world === undefined &&
    body.worldMode === undefined &&
    body.proxyId === undefined &&
    body.accountNickname === undefined &&
    body.jagexSessionId === undefined &&
    body.jagexCharacterId === undefined &&
    body.jagexDisplayName === undefined &&
    body.jagexAccessToken === undefined &&
    body.jagexRefreshToken === undefined &&
    body.notes === undefined &&
    body.charName === undefined &&
    body.botClient === undefined &&
    body.enabled === undefined
  ) {
    return null;
  }

  return {
    enabled: body.enabled !== false,
    category: normalizeCategory(body.category),
    scriptName: String(body.scriptName || config.defaultScriptName || ""),
    scheduleName: String(body.scheduleName || "").trim(),
    scriptParams: parseScriptParams(body.scriptParams),
    epicBotProfilePath: String(body.epicBotProfilePath || "").trim(),
    world: Number(body.world || config.defaultWorld || 301),
    worldMode: normalizeWorldMode(body.worldMode),
    proxyId: normalizeProxyId(body.proxyId),
    botClient: normalizeBotClient(body.botClient),
    accountNickname: String(body.accountNickname || "").trim(),
    jagexSessionId: String(body.jagexSessionId || "").trim(),
    jagexCharacterId: String(body.jagexCharacterId || "").trim(),
    jagexDisplayName: String(body.jagexDisplayName || "").trim(),
    jagexAccessToken: String(body.jagexAccessToken || "").trim(),
    jagexRefreshToken: String(body.jagexRefreshToken || "").trim(),
    notes: String(body.notes || "").trim(),
    charName: String(body.charName || "").trim(),
  };
}

function usesBrowserLogin(row, config) {
  const hasJagexSession = Boolean(row.jagexSessionId && row.jagexCharacterId);
  return config.useJagexBrowserLogin !== false && !hasJagexSession;
}

function buildDreamBotArgs({ account, row, config, remoteDebuggingPort = 0 }) {
  const totp = config.useGeneratedTotp ? getTotpCode(account.totpSecret) : account.totpSecret;
  const proxies = normalizeProxies(config);
  const proxy = proxies.find((item) => item.enabled && item.id === normalizeProxyId(row.proxyId));
  const world = resolveWorld(row, config);
  const hasJagexSession = Boolean(row.jagexSessionId && row.jagexCharacterId);
  const scheduleName = String(row.scheduleName || "").trim();
  const args = [
    "-jar",
    config.launcherPath,
  ];

  if (scheduleName) {
    args.push(`-schedule=${scheduleName}`);
  } else {
    args.push("-script", row.scriptName || config.defaultScriptName);
  }

  args.push("-world", world, "-covert");

  if (hasJagexSession) {
    args.push(
      "-newAccountSystem",
      "-sessionId",
      row.jagexSessionId,
      "-characterId",
      row.jagexCharacterId,
      "-displayName",
      row.jagexDisplayName || account.email,
    );
    if (row.jagexAccessToken) args.push("-accessToken", row.jagexAccessToken);
    if (row.jagexRefreshToken) args.push("-refreshToken", row.jagexRefreshToken);
  } else if (config.useStoredGameAccount !== false && row.accountNickname) {
    args.push("-account", row.accountNickname);
  } else {
    if (config.useJagexBrowserLogin !== false) {
      args.push("-newAccountBrowserLogin");
      if (remoteDebuggingPort) args.push(`-remote-debugging-port=${remoteDebuggingPort}`);
    }
    args.push(
      "-accountUsername",
      account.email,
      "-accountPassword",
      account.password,
      "-accountTotp",
      totp,
    );
  }

  if (config.useJagexBrowserLogin !== false && !hasJagexSession && config.useStoredGameAccount !== false && row.accountNickname) {
    args.push("-newAccountBrowserLogin");
    if (remoteDebuggingPort) args.push(`-remote-debugging-port=${remoteDebuggingPort}`);
  }

  if (proxy) {
    args.push("-proxyHost", proxy.host, "-proxyPort", String(proxy.port));
    if (proxy.username) args.push("-proxyUser", proxy.username);
    if (proxy.password) args.push("-proxyPass", proxy.password);
  }

  if (!scheduleName && Array.isArray(row.scriptParams) && row.scriptParams.length) {
    args.push("-params", ...row.scriptParams);
  }

  return args;
}

function buildTribotArgs({ account, row, config }) {
  const totp = config.useGeneratedTotp ? getTotpCode(account.totpSecret) : account.totpSecret;
  const proxies = normalizeProxies(config);
  const proxy = proxies.find((item) => item.enabled && item.id === normalizeProxyId(row.proxyId));
  const args = ["run"];
  const charName = String(row.charName || row.jagexDisplayName || "").trim();

  if (charName) {
    args.push("--jagex-character-name", charName);
  } else {
    args.push(
      "--legacy-username",
      account.email,
      "--legacy-password-raw",
      account.password,
      "--legacy-totp-raw",
      totp,
    );
  }

  if (proxy) {
    args.push("--proxy-host-raw", proxy.host, "--proxy-port-raw", String(proxy.port));
    if (proxy.username) args.push("--proxy-username-raw", proxy.username);
    if (proxy.password) args.push("--proxy-password-raw", proxy.password);
  }

  if (row.scriptName || config.defaultScriptName) args.push("--script-name", row.scriptName || config.defaultScriptName);
  if (Array.isArray(row.scriptParams) && row.scriptParams.length) args.push("--script-args", row.scriptParams.join(","));
  if (String(row.worldMode || "fixed") === "fixed" && Number(row.world || config.defaultWorld || 0)) {
    args.push("--world", String(row.world || config.defaultWorld));
  }

  return args;
}

function buildEpicBotArgs({ account, row, config, includeRuntimeOptions = true }) {
  const totp = String(account.totpSecret || "").trim();
  const proxies = normalizeProxies(config);
  const proxy = proxies.find((item) => item.enabled && item.id === normalizeProxyId(row.proxyId));
  const epicBot = normalizeEpicBotConfig(config);
  const args = [];
  const scheduleName = String(row.scheduleName || "").trim();
  const scriptName = String(row.scriptName || config.defaultScriptName || "").trim();
  const charName = normalizePlayerName(row.charName || row.jagexDisplayName || row.accountNickname || "");
  const scriptProfile = String(row.epicBotProfilePath || "").trim()
    || (Array.isArray(row.scriptParams) ? row.scriptParams.join(" ") : String(row.scriptParams || "")).trim();
  const hasJagexSession = Boolean(row.jagexSessionId && row.jagexCharacterId);

  if (epicBot.platform) args.push("--platform", epicBot.platform);
  if (includeRuntimeOptions && epicBot.heap) args.push("--heap", epicBot.heap);
  if (includeRuntimeOptions && epicBot.maxHeap) args.push("--max-heap", epicBot.maxHeap);
  if (epicBot.mouseProfile) args.push("--mouse-profile", epicBot.mouseProfile);

  if (hasJagexSession) {
    args.push("--jagex-session-id", row.jagexSessionId, "--jagex-character-id", row.jagexCharacterId);
  } else {
    args.push("--jagex-email", account.email, "--jagex-password", account.password);
    if (totp) args.push("--jagex-totp", totp);
    if (charName) args.push("--jagex-character", charName);
  }

  if (scheduleName) {
    args.push("--schedule-id", scheduleName);
  } else if (scriptName) {
    args.push("--script-name", scriptName);
    if (scriptProfile) args.push("--script-profile", scriptProfile);
  }

  if (String(row.worldMode || "fixed") === "fixed" && Number(row.world || config.defaultWorld || 0)) {
    args.push("--world", String(row.world || config.defaultWorld));
  }

  if (proxy) {
    if (epicBot.useSavedProxyName && proxy.name) {
      args.push("--proxy", proxy.name);
    } else {
      args.push("--proxy-host", proxy.host, "--proxy-port", String(proxy.port));
      if (proxy.username) args.push("--proxy-username", proxy.username);
      if (proxy.password) args.push("--proxy-password", proxy.password);
    }
  }

  return args;
}

function buildArgs({ account, row, config, remoteDebuggingPort = 0 }) {
  const botClient = normalizeBotClient(row.botClient);
  if (botClient === "tribot") return buildTribotArgs({ account, row, config });
  if (botClient === "epicbot") return buildEpicBotArgs({ account, row, config });
  return buildDreamBotArgs({ account, row, config, remoteDebuggingPort });
}

function redactCommandArgs(args) {
  const sensitive = new Set([
    "-accountPassword",
    "-accountPass",
    "-accountTotp",
    "-sessionId",
    "-accessToken",
    "-refreshToken",
    "--jagex-password",
    "--jagex-totp",
    "--jagex-session-id",
    "--legacy-password-raw",
    "--legacy-totp-raw",
    "-proxyPass",
    "-proxyPassArg",
    "--proxy-password-raw",
    "--proxy-password",
  ].map((item) => item.toLowerCase()));
  return args.map((arg, index) => (sensitive.has(String(args[index - 1] || "").toLowerCase()) ? mask(String(arg)) : arg));
}

function buildSafeArgs({ account, row, config, remoteDebuggingPort = 0 }) {
  return redactCommandArgs(buildArgs({ account, row, config, remoteDebuggingPort }));
}

function formatCommandPreview(args) {
  return args.map((arg) => {
    const value = String(arg);
    return /\s|"/.test(value) ? `"${value.replaceAll('"', '\\"')}"` : value;
  }).join(" ");
}

function resolveWorld(row, config) {
  const mode = normalizeWorldMode(row.worldMode);
  if (mode === "random-f2p") return "f2p";
  if (mode === "random-p2p") return "members";
  return String(row.world || config.defaultWorld || 301);
}

const osrsSkillNames = [
  "overall",
  "attack",
  "defence",
  "strength",
  "hitpoints",
  "ranged",
  "prayer",
  "magic",
  "cooking",
  "woodcutting",
  "fletching",
  "fishing",
  "firemaking",
  "crafting",
  "smithing",
  "mining",
  "herblore",
  "agility",
  "thieving",
  "slayer",
  "farming",
  "runecraft",
  "hunter",
  "construction",
];

function normalizeCompletionSkill(value) {
  const clean = String(value || "").trim().toLowerCase().replace(/\s+/g, "_");
  if (clean === "total" || clean === "total_level") return "overall";
  if (clean === "combat" || clean === "combat_level") return "combat";
  return osrsSkillNames.includes(clean) ? clean : "";
}

function normalizePlayerName(value) {
  return String(value || "").trim().replace(/\s+/g, " ");
}

function parseHiscoreLite(player, text) {
  const lines = String(text || "").trim().split(/\r?\n/);
  const skills = {};

  osrsSkillNames.forEach((name, index) => {
    const [rankRaw, levelRaw, xpRaw] = String(lines[index] || "-1,-1,-1").split(",");
    skills[name] = {
      rank: Number(rankRaw),
      level: Number(levelRaw),
      xp: Number(xpRaw),
    };
  });

  return {
    player,
    updatedAt: new Date().toISOString(),
    skills,
    totalLevel: skills.overall?.level ?? -1,
    combatLevel: calculateCombatLevel(skills),
  };
}

function skillLevel(skills, name) {
  const level = Number(skills[name]?.level ?? 1);
  return Number.isFinite(level) && level > 0 ? level : 1;
}

function calculateCombatLevel(skills) {
  const attack = skillLevel(skills, "attack");
  const strength = skillLevel(skills, "strength");
  const defence = skillLevel(skills, "defence");
  const hitpoints = skillLevel(skills, "hitpoints");
  const prayer = skillLevel(skills, "prayer");
  const ranged = skillLevel(skills, "ranged");
  const magic = skillLevel(skills, "magic");
  const base = 0.25 * (defence + hitpoints + Math.floor(prayer / 2));
  const melee = 0.325 * (attack + strength);
  const range = 0.325 * Math.floor((3 * ranged) / 2);
  const mage = 0.325 * Math.floor((3 * magic) / 2);
  return Math.floor(base + Math.max(melee, range, mage));
}

async function getHiscores(body) {
  const player = normalizePlayerName(body.player);
  const refresh = Boolean(body.refresh);
  if (!player) throw new Error("Char name is required.");

  const key = player.toLowerCase();
  const appState = await readAppState();
  const cached = appState.hiscores?.[key];
  const maxAgeMs = 30 * 60 * 1000;
  if (!refresh && cached?.updatedAt && Date.now() - new Date(cached.updatedAt).getTime() < maxAgeMs) {
    return { ...cached, cached: true };
  }

  const endpoint = `https://secure.runescape.com/m=hiscore_oldschool/index_lite.ws?player=${encodeURIComponent(player)}`;
  const response = await fetch(endpoint, {
    headers: {
      "User-Agent": "NeuraL-Farm-Control/1.0",
    },
  });
  if (response.status === 404) {
    const error = new Error(`Char "${player}" não encontrado no HiScores.`);
    error.code = "HISCORES_NOT_FOUND";
    throw error;
  }
  if (!response.ok) throw new Error(`HiScores respondeu HTTP ${response.status}.`);

  const parsed = parseHiscoreLite(player, await response.text());
  appState.hiscores = {
    ...(appState.hiscores || {}),
    [key]: parsed,
  };
  await writeAppState(appState);
  return { ...parsed, cached: false };
}

function extractCharNameFromText(text) {
  const match = String(text || "").match(/\[NFC\]\s*charName\s*=\s*([^\r\n]+)/i);
  return match ? normalizePlayerName(match[1]) : "";
}

function extractBanStatusFromText(text) {
  const raw = String(text || "");
  if (/Account is being set to banned status/i.test(raw)) {
    return "Account is being set to banned status";
  }
  if (/your account has been involved in serious rule breaking/i.test(raw)) {
    return "Serious rule breaking";
  }
  if (/High severity server response,\s*stopping script!\s*Response:\s*(?:DISABLED|BANNED)/i.test(raw)) {
    return "High severity server response";
  }
  if (/\baccount\b.*\b(?:banned|disabled|locked)\b/i.test(raw)) {
    return "Account banned/disabled";
  }
  return "";
}

function extractNickCaptureRuntimeError(text) {
  const raw = String(text || "");
  if (/script (?:was )?(?:built|compiled) using (?:a )?newer java/i.test(raw)) {
    return "NeuraL Nick Capture foi compilado para Java mais novo que o client DreamBot.";
  }
  if (/compiled using a newer version of Java|newer version of Java than what you're running/i.test(raw)) {
    return "NeuraL Nick Capture incompatível com o Java do client DreamBot.";
  }
  return "";
}

function extractNickCaptureBlockedReason(text) {
  const raw = String(text || "");
  if (/Before using this app,\s*please read and accept/i.test(raw) || /\bAccept\b[\s\S]{0,120}\bDecline\b/i.test(raw)) {
    return "DreamBot aguardando aceite do EULA.";
  }
  return "";
}

async function ensureNickCaptureJarInstalled() {
  if (!existsSync(projectNickCaptureJarPath)) return false;
  let shouldCopy = !existsSync(nickCaptureJarPath);
  if (!shouldCopy) {
    try {
      const [sourceInfo, targetInfo] = await Promise.all([
        stat(projectNickCaptureJarPath),
        stat(nickCaptureJarPath),
      ]);
      shouldCopy = sourceInfo.size !== targetInfo.size || sourceInfo.mtimeMs > targetInfo.mtimeMs + 1000;
    } catch {
      shouldCopy = true;
    }
  }
  if (!shouldCopy) return true;
  await mkdir(dreamBotScriptsDir, { recursive: true });
  await copyFile(projectNickCaptureJarPath, nickCaptureJarPath);
  return existsSync(nickCaptureJarPath);
}

async function saveCharNameForAccount(index, charName) {
  const clean = normalizePlayerName(charName);
  if (!isLikelyRunescapeName(clean)) return false;
  const config = await readConfig();
  if (!Array.isArray(config.accounts)) return false;
  let changed = false;
  config.accounts = config.accounts.map((row) => {
    if (Number(row.index) !== Number(index) || row.charName) return row;
    changed = true;
    return { ...row, charName: clean };
  });
  if (changed) await writeConfig(config);
  return changed;
}

async function saveClientPidForLaunch({ launcherPid, index, clientPid }) {
  const parsedLauncherPid = Number(launcherPid);
  const parsedClientPid = Number(clientPid);
  if (!Number.isInteger(parsedLauncherPid) || !Number.isInteger(parsedClientPid)) return false;

  const appState = await readAppState();
  let changed = false;
  appState.launches = appState.launches.map((launch) => {
    if (Number(launch.pid) !== parsedLauncherPid || Number(launch.index) !== Number(index)) return launch;
    if (Number(launch.clientPid || 0) === parsedClientPid) return launch;
    changed = true;
    return { ...launch, clientPid: parsedClientPid, effectivePid: parsedClientPid };
  });
  if (changed) await writeAppState(appState);
  return changed;
}

async function monitorDreamBotIdentity({ index, account, launcherPid, startedAt, stdoutPath }) {
  const launchTime = new Date(startedAt || Date.now()).getTime();
  const deadline = Date.now() + 120000;
  const logged = new Map();
  await appendLaunchLog(stdoutPath, "monitorando processo DreamBot para capturar nick.");

  while (Date.now() < deadline) {
    const processes = await getJavaProcesses();
    const candidates = processes
      .filter((item) => item.pid !== launcherPid)
      .filter((item) => isDreamBotClientProcess(item))
      .filter((item) => !item.startTime || item.startTime >= launchTime - 15000)
      .sort((a, b) => Math.abs((a.startTime || launchTime) - launchTime) - Math.abs((b.startTime || launchTime) - launchTime));

    for (const processInfo of candidates) {
      const identity = extractDreamBotIdentity(processInfo);
      const matchesAccount = !identity.accountUsername
        || identity.accountUsername.toLowerCase() === String(account.email || "").toLowerCase();

      if (!matchesAccount) continue;

      const signature = `${identity.displayName}|${identity.characterId}|${identity.accountUsername}|${processInfo.commandLine.length}`;
      if (logged.get(processInfo.pid) !== signature) {
        logged.set(processInfo.pid, signature);
        const savedPid = await saveClientPidForLaunch({ launcherPid, index, clientPid: processInfo.pid });
        await appendLaunchLog(
          stdoutPath,
          `processo DreamBot detectado pid=${processInfo.pid} displayName=${identity.displayName || "-"} characterId=${identity.characterId || "-"} account=${identity.accountUsername || "-"}${savedPid ? " (pid salvo)" : ""}`,
        );
      }

      if (isLikelyRunescapeName(identity.displayName)) {
        const saved = await saveCharNameForAccount(index, identity.displayName);
        await appendLaunchLog(stdoutPath, `nick capturado via processo: ${identity.displayName}${saved ? " (salvo)" : " (ja existia)"}.`);
        return identity;
      }

      if (identity.characterId) {
        await appendLaunchLog(stdoutPath, `characterId capturado via processo: ${identity.characterId}.`);
      }

      if (processInfo.commandLine) {
        await appendLaunchLog(stdoutPath, `comando DreamBot: ${getCommandLineHint(processInfo.commandLine)}`);
      }
    }

    await sleep(2500);
  }

  await appendLaunchLog(stdoutPath, "monitoramento terminou sem nick no processo DreamBot.");
  return null;
}

async function waitForNoRunningLaunch(index, timeoutMs = 30000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const launches = await reconcileLaunches(await readState(), await getJavaProcesses());
    const running = launches.find((launch) => Number(launch.index) === Number(index) && isLaunchActive(launch));
    if (!running) return true;
    await sleep(1500);
  }
  return false;
}

async function removeLaunchByPid(pid) {
  const parsed = Number(pid);
  if (!Number.isInteger(parsed)) return false;
  const appState = await readAppState();
  const before = Array.isArray(appState.launches) ? appState.launches.length : 0;
  appState.launches = (appState.launches || []).filter((launch) => Number(launch.pid) !== parsed);
  if (appState.launches.length === before) return false;
  await writeAppState(appState);
  return true;
}

async function waitForCapturedCharName({ index, account, startedAt, stdoutPath, timeoutMs = 150000 }) {
  const startedMs = new Date(startedAt || Date.now()).getTime();
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    const stdout = await readTextTail(stdoutPath, 8000);
    let charName = extractCharNameFromText(stdout);
    let banReason = extractBanStatusFromText(stdout);

    if (!charName) {
      const dreamBotLogPath = await findLatestDreamBotLog(account.email, startedMs - 5000);
      const dreamBotLog = dreamBotLogPath ? await readTextTail(dreamBotLogPath, 12000) : "";
      charName = extractCharNameFromText(dreamBotLog);
      if (!banReason) banReason = extractBanStatusFromText(dreamBotLog);
    }

    if (banReason) {
      await appendLaunchLog(stdoutPath, `ban detectado durante captura de nick: ${banReason}.`);
      return "";
    }

    if (isLikelyRunescapeName(charName)) {
      await saveCharNameForAccount(index, charName);
      await appendLaunchLog(stdoutPath, `nick capturado pelo helper: ${charName}.`);
      return charName;
    }

    await sleep(2000);
  }

  await appendLaunchLog(stdoutPath, "helper terminou sem capturar nick.");
  return "";
}

async function launchRealAfterNickCapture({ index, options, helperPid, helperStartedAt, helperStdoutPath }) {
  try {
    const accounts = await readAccounts();
    const account = accounts[index];
    if (!account) return;

    const charName = await waitForCapturedCharName({
      index,
      account,
      startedAt: helperStartedAt,
      stdoutPath: helperStdoutPath,
    });

    if (!charName) return;

    const launches = await reconcileLaunches(await readState(), await getJavaProcesses());
    const helperLaunch = launches.find((launch) => Number(launch.pid) === Number(helperPid));
    if (isLaunchActive(helperLaunch)) {
      try {
        await stopProcess(helperLaunch.effectivePid || helperLaunch.pid);
      } catch {
        // The helper normally exits by itself after writing the nick.
      }
      await sleep(2000);
    }
    await removeLaunchByPid(helperPid);

    const stopped = await waitForNoRunningLaunch(index, 45000);
    if (!stopped) {
      await appendLaunchLog(helperStdoutPath, "helper ainda aparece como Running; tentando launch real mesmo assim apos limpar registro.");
    }

    const config = await readConfig();
    const currentRow = normalizeConfigAccounts(config, accounts).find((row) => Number(row.index) === Number(index)) || {};
    const originalOverride = options?.rowOverride && typeof options.rowOverride === "object" ? options.rowOverride : {};
    const realRowOverride = {
      ...currentRow,
      ...originalOverride,
      scriptName: originalOverride.scriptName || currentRow.scriptName || config.defaultScriptName || "",
      scheduleName: String(originalOverride.scheduleName ?? currentRow.scheduleName ?? "").trim(),
      scriptParams: Array.isArray(originalOverride.scriptParams)
        ? originalOverride.scriptParams
        : Array.isArray(currentRow.scriptParams)
          ? currentRow.scriptParams
          : [],
      charName,
    };

    await appendLaunchLog(
      helperStdoutPath,
      `iniciando launch real apos nick. schedule=${realRowOverride.scheduleName || "-"} script=${realRowOverride.scriptName || "-"}.`,
    );
    await launchAccount(index, {
      ...options,
      skipNickCapture: true,
      rowOverride: realRowOverride,
    });
  } catch (error) {
    await appendLaunchLog(helperStdoutPath, `falha ao iniciar launch real apos capturar nick: ${error.message}`);
  }
}

async function discoverCharNamesFromLogs(config, rows, launches) {
  const rowsByIndex = new Map(rows.map((row) => [Number(row.index), row]));
  const missing = rows.filter((row) => !row.charName);
  if (!missing.length || !Array.isArray(launches) || !launches.length) return rows;

  let changed = false;
  const updates = new Map();

  for (const launch of launches.slice().sort((a, b) => new Date(b.startedAt || 0) - new Date(a.startedAt || 0))) {
    const index = Number(launch.index);
    const row = rowsByIndex.get(index);
    if (!row || row.charName || updates.has(index)) continue;

    const launchTime = new Date(launch.startedAt || 0).getTime();
    const stdout = await readTextTail(launch.stdout, 4000);
    let charName = extractCharNameFromText(stdout);
    if (!charName) {
      const dreamBotLogPath = await findLatestDreamBotLog(launch.email, launchTime - 5000);
      const dreamBotLog = dreamBotLogPath ? await readTextTail(dreamBotLogPath, 8000) : "";
      charName = extractCharNameFromText(dreamBotLog);
    }

    if (charName) {
      updates.set(index, charName);
      row.charName = charName;
      changed = true;
    }
  }

  if (!changed) return rows;

  if (!Array.isArray(config.accounts)) config.accounts = [];
  config.accounts = config.accounts.map((row) => {
    const index = Number(row.index);
    return updates.has(index) ? { ...row, charName: updates.get(index) } : row;
  });
  await writeConfig(config);
  return rows.map((row) => (updates.has(Number(row.index)) ? { ...row, charName: updates.get(Number(row.index)) } : row));
}

function sanitizeConfig(config) {
  return {
    launcherPath: config.launcherPath,
    tribotCliPath: config.tribotCliPath || resolveTribotCliPath(config),
    epicBotPath: config.epicBotPath || resolveEpicBotPath(config),
    defaultScriptName: config.defaultScriptName,
    defaultWorld: config.defaultWorld,
    useGeneratedTotp: Boolean(config.useGeneratedTotp),
    useJagexBrowserLogin: config.useJagexBrowserLogin !== false,
    jagexDebug: Boolean(config.jagexDebug),
    useStoredGameAccount: config.useStoredGameAccount !== false,
    launchDelaySeconds: Number(config.launchDelaySeconds || 0),
    maxInstances: Number(config.maxInstances || 1),
    discordWebhook: normalizeDiscordWebhookConfig(config),
    epicBot: normalizeEpicBotConfig(config),
    ai: sanitizeAiConfig(config),
    continuous: normalizeContinuousConfig(config),
  };
}

function buildDiagnostics({ config, accounts, rows, proxies, tasks }) {
  const issues = [];
  const accountIndexes = new Set(accounts.map((account) => Number(account.index)));
  const enabledRows = rows.filter((row) => row.enabled);
  const activeTasks = tasks.filter((task) => task.enabled);

  const addIssue = (severity, message) => {
    issues.push({ severity, message });
  };

  if (!existsSync(config.launcherPath || "")) {
    addIssue("error", `DreamBot launcher não encontrado: ${config.launcherPath || "(vazio)"}.`);
  }

  for (const row of rows) {
    if (!accountIndexes.has(Number(row.index))) {
      addIssue("error", `Conta ${row.index} existe no farm.json, mas não existe no accounts.txt.`);
      continue;
    }
    if (!row.enabled) continue;
    if (!row.scheduleName && (!row.scriptName || row.scriptName === "Teste")) {
      addIssue("warning", `Conta ${row.index} habilitada está com script "${row.scriptName || "vazio"}".`);
    }
    if (!row.category) {
      addIssue("warning", `Conta ${row.index} não tem categoria.`);
    }
    const proxyId = normalizeProxyId(row.proxyId);
    if (proxyId && !proxies.some((proxy) => proxy.id === proxyId && proxy.enabled)) {
      addIssue("error", `Conta ${row.index} usa proxy ausente ou inativo.`);
    }
  }

  if (enabledRows.length > accounts.length) {
    addIssue("warning", `${enabledRows.length} linhas habilitadas para ${accounts.length} conta(s) em accounts.txt.`);
  }

  if (Number(config.maxInstances || 1) > Math.max(1, enabledRows.length)) {
    addIssue("warning", `Max instâncias (${config.maxInstances}) é maior que contas habilitadas (${enabledRows.length}).`);
  }

  for (const task of activeTasks) {
    const matchingRows = enabledRows.filter((row) => row.category === task.category && accountIndexes.has(Number(row.index)));
    if (!matchingRows.length) {
      addIssue("error", `Task "${task.name}" ativa não tem contas habilitadas na categoria "${task.category}".`);
    }
    if (!task.scheduleName && (!task.scriptName || task.scriptName === "Teste")) {
      addIssue("warning", `Task "${task.name}" está com script "${task.scriptName || "vazio"}".`);
    }
    if (task.proxyMode === "task" && !proxies.some((proxy) => proxy.id === task.proxyId && proxy.enabled)) {
      addIssue("error", `Task "${task.name}" usa proxy ausente ou inativo.`);
    }
  }

  const status = issues.some((issue) => issue.severity === "error")
    ? "error"
    : issues.some((issue) => issue.severity === "warning")
      ? "warning"
      : "ok";

  return {
    status,
    issues,
    summary: status === "ok"
      ? "Setup pronto para launch."
      : `${issues.length} aviso(s) no setup.`,
  };
}

async function getSnapshot() {
  const config = await readConfig();
  const accounts = await readAccounts();
  const rows = normalizeConfigAccounts(config, accounts);
  const proxies = normalizeProxies(config);
  const tasks = normalizeTasks(config);
  const appState = await readAppState();
  const previousLaunchesJson = JSON.stringify(appState.launches || []);
  const previousCheckerJson = JSON.stringify(appState.checker || {});
  const previousNotificationsJson = JSON.stringify(appState.discordNotifications || {});
  const sanitizedChecker = sanitizeCheckerStateAgainstHiscores(appState.checker || {}, rows, appState.hiscores || {});
  if (sanitizedChecker.changed) {
    appState.checker = sanitizedChecker.checker;
  }
  const javaProcesses = await getJavaProcesses();
  const performance = await getPerformanceDiagnostics();
  const alive = await reconcileLaunches(appState.launches, javaProcesses);
  await processLaunchNotifications({ config, appState, rows, tasks, reconciled: alive });
  for (const launch of alive) {
    if (!launch.banReason) continue;
    const index = Number(launch.index);
    if (!Number.isInteger(index)) continue;
    const previous = appState.checker?.[index];
    const row = rows.find((item) => Number(item.index) === index);
    if (checkerHasHiscoreEvidence(previous, row, appState.hiscores || {})) continue;
    const checkedAt = launch.banDetectedAt || launch.completedAt || previous?.checkedAt || new Date().toISOString();
    appState.checker = {
      ...(appState.checker || {}),
      [index]: {
        index,
        checkedAt,
        status: "banned",
        message: `Ban detectado no DreamBot: ${launch.banReason}.`,
        charName: "",
      },
    };
  }
  appState.launches = alive;
  const stateChanged =
    previousLaunchesJson !== JSON.stringify(appState.launches || []) ||
    previousCheckerJson !== JSON.stringify(appState.checker || {}) ||
    previousNotificationsJson !== JSON.stringify(appState.discordNotifications || {});
  if (stateChanged) await writeAppState(appState);
  const rowsWithCharNames = await discoverCharNamesFromLogs(config, rows, alive);
  const visibleLaunches = compactLaunchesForRows(alive, rowsWithCharNames);

  return {
    config: sanitizeConfig(config),
    version: await readVersion(),
    accounts: accounts.map((account) => ({
      index: account.index,
      email: account.email,
      password: mask(account.password),
      totpSecret: mask(account.totpSecret),
    })),
    rows: rowsWithCharNames,
    proxies: proxies.map((proxy) => ({
      id: proxy.id,
      name: proxy.name,
      host: proxy.host,
      port: proxy.port,
      username: proxy.username,
      password: mask(proxy.password),
      enabled: proxy.enabled,
    })),
    launches: visibleLaunches,
    categories: normalizeCategories(config, rows, tasks),
    continuousTasks: tasks,
    checker: appState.checker && typeof appState.checker === "object" ? appState.checker : {},
    diagnostics: buildDiagnostics({ config, accounts, rows, proxies, tasks }),
    performance,
    continuous: {
      config: normalizeContinuousConfig(config),
      state: normalizeContinuousState(appState.continuous),
    },
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

async function getJavaProcesses() {
  const now = Date.now();
  if (javaProcessCache.promise) return javaProcessCache.promise;
  if (now - javaProcessCache.at < 3500) return javaProcessCache.value;

  javaProcessCache.promise = queryJavaProcesses()
    .then((value) => {
      javaProcessCache.at = Date.now();
      javaProcessCache.value = value;
      return value;
    })
    .finally(() => {
      javaProcessCache.promise = null;
    });

  return javaProcessCache.promise;
}

async function getPerformanceDiagnostics() {
  return {
    machine: await getMachineDiagnostics(),
    jcef: await getJcefDiagnostics(),
  };
}

async function getMachineDiagnostics() {
  const now = Date.now();
  if (machineDiagnosticsCache.promise) return machineDiagnosticsCache.promise;
  if (machineDiagnosticsCache.value && now - machineDiagnosticsCache.at < 10000) return machineDiagnosticsCache.value;

  machineDiagnosticsCache.promise = queryMachineDiagnostics()
    .then((value) => {
      machineDiagnosticsCache.at = Date.now();
      machineDiagnosticsCache.value = value;
      return value;
    })
    .finally(() => {
      machineDiagnosticsCache.promise = null;
    });

  return machineDiagnosticsCache.promise;
}

async function queryMachineDiagnostics() {
  const empty = { cpuPercent: 0, memoryPercent: 0, memoryUsedGb: 0, memoryTotalGb: 0, severity: "ok", updatedAt: new Date().toISOString() };
  if (process.platform !== "win32") return empty;

  try {
    const command = `
$ErrorActionPreference='SilentlyContinue'
$cpu = (Get-CimInstance Win32_Processor | Measure-Object -Property LoadPercentage -Average).Average
$os = Get-CimInstance Win32_OperatingSystem
$totalKb = [double]$os.TotalVisibleMemorySize
$freeKb = [double]$os.FreePhysicalMemory
$usedKb = [Math]::Max(0, $totalKb - $freeKb)
[pscustomobject]@{
  cpu = if ($cpu -ne $null) { [double]$cpu } else { 0 }
  memoryPercent = if ($totalKb -gt 0) { ($usedKb / $totalKb) * 100 } else { 0 }
  memoryUsedGb = $usedKb / 1048576
  memoryTotalGb = $totalKb / 1048576
} | ConvertTo-Json -Compress
`;
    const { stdout } = await execFileAsync("powershell.exe", ["-NoProfile", "-Command", command], {
      windowsHide: true,
      timeout: 5000,
    });
    const parsed = JSON.parse(stdout.trim() || "{}");
    const cpuPercent = Math.max(0, Number(parsed.cpu || 0));
    const memoryPercent = Math.max(0, Number(parsed.memoryPercent || 0));
    const severity = cpuPercent >= 90 || memoryPercent >= 90
      ? "critical"
      : cpuPercent >= 75 || memoryPercent >= 80
        ? "warning"
        : "ok";
    return {
      cpuPercent: Math.round(cpuPercent),
      memoryPercent: Math.round(memoryPercent),
      memoryUsedGb: Math.round(Number(parsed.memoryUsedGb || 0) * 10) / 10,
      memoryTotalGb: Math.round(Number(parsed.memoryTotalGb || 0) * 10) / 10,
      severity,
      updatedAt: new Date().toISOString(),
    };
  } catch {
    return empty;
  }
}

async function getJcefDiagnostics() {
  const now = Date.now();
  if (jcefDiagnosticsCache.promise) return jcefDiagnosticsCache.promise;
  if (jcefDiagnosticsCache.value && now - jcefDiagnosticsCache.at < 20000) return jcefDiagnosticsCache.value;

  jcefDiagnosticsCache.promise = queryJcefDiagnostics()
    .then((value) => {
      jcefDiagnosticsCache.at = Date.now();
      jcefDiagnosticsCache.value = value;
      return value;
    })
    .finally(() => {
      jcefDiagnosticsCache.promise = null;
    });

  return jcefDiagnosticsCache.promise;
}

async function queryJcefDiagnostics() {
  const empty = { count: 0, cpuPercent: 0, severity: "ok", processes: [], updatedAt: new Date().toISOString() };
  if (process.platform !== "win32") return empty;

  try {
    const command = `
$ErrorActionPreference='SilentlyContinue'
$perfRows = Get-CimInstance Win32_PerfFormattedData_PerfProc_Process |
  Where-Object { $_.IDProcess -gt 0 } |
  Group-Object -Property IDProcess -AsHashTable -AsString
$rows = Get-CimInstance Win32_Process |
  Where-Object {
    $_.Name -match '(?i)jcef|javaw?\\.exe' -or
    $_.CommandLine -match '(?i)jcef|chromium embedded|cef_helper' -or
    $_.ExecutablePath -match '(?i)jcef|chromium'
  } |
  ForEach-Object {
    $pidText = [string]$_.ProcessId
    $perf = $perfRows[$pidText] | Select-Object -First 1
    $text = "$($_.Name) $($_.ExecutablePath) $($_.CommandLine)"
    $isJcef = $text -match '(?i)jcef|chromium embedded|cef_helper'
    if (-not $isJcef) { return }
    [pscustomobject]@{
      pid = $_.ProcessId
      name = $_.Name
      cpu = if ($perf) { [double]$perf.PercentProcessorTime } else { 0 }
      path = $_.ExecutablePath
    }
  }
$rows | ConvertTo-Json -Compress
`;
    const { stdout } = await execFileAsync("powershell.exe", ["-NoProfile", "-Command", command], {
      windowsHide: true,
      timeout: 6000,
    });
    const trimmed = stdout.trim();
    if (!trimmed) return empty;
    const parsed = JSON.parse(trimmed);
    const processes = (Array.isArray(parsed) ? parsed : [parsed])
      .filter((item) => Number.isInteger(Number(item.pid)))
      .map((item) => ({
        pid: Number(item.pid),
        name: String(item.name || "JCEF"),
        cpuPercent: Math.max(0, Number(item.cpu || 0)),
      }))
      .sort((a, b) => b.cpuPercent - a.cpuPercent)
      .slice(0, 20);
    const cpuPercent = processes.reduce((sum, item) => sum + item.cpuPercent, 0);
    const count = processes.length;
    const severity = cpuPercent >= 40 || count >= 8
      ? "critical"
      : cpuPercent >= 20 || count >= 4
        ? "warning"
        : "ok";
    return {
      count,
      cpuPercent: Math.round(cpuPercent * 10) / 10,
      severity,
      processes,
      updatedAt: new Date().toISOString(),
    };
  } catch {
    return empty;
  }
}

async function queryJavaProcesses() {
  if (process.platform !== "win32") return [];
  try {
    const command = "$ErrorActionPreference='SilentlyContinue'; Get-CimInstance Win32_Process | Where-Object { $_.Name -in @('java.exe','javaw.exe','EpicBot-NXT.exe','EpicBot.exe') -or $_.CommandLine -match '(?i)EpicBot' -or $_.ExecutablePath -match '(?i)EpicBot' } | Select-Object @{Name='Id';Expression={$_.ProcessId}},@{Name='ProcessName';Expression={$_.Name}},@{Name='StartTime';Expression={$_.CreationDate}},@{Name='Path';Expression={$_.ExecutablePath}},CommandLine | ConvertTo-Json -Compress; exit 0";
    const { stdout } = await execFileAsync("powershell.exe", ["-NoProfile", "-Command", command], {
      windowsHide: true,
      timeout: 5000,
    });
    const trimmed = stdout.trim();
    if (!trimmed) return getJavaProcessesBasic();
    const parsed = JSON.parse(trimmed);
    if (!parsed) return getJavaProcessesBasic();
    const titles = await getWindowTitlesByPid();
    return (Array.isArray(parsed) ? parsed : [parsed]).map((item) => ({
      pid: Number(item.Id),
      processName: String(item.ProcessName || ""),
      startTime: parseProcessStartTime(item.StartTime),
      path: String(item.Path || ""),
      commandLine: String(item.CommandLine || ""),
      windowTitle: titles.get(Number(item.Id)) || "",
    })).filter((item) => Number.isInteger(item.pid));
  } catch {
    return getJavaProcessesBasic();
  }
}

async function getJavaProcessesBasic() {
  try {
    const command = "$ErrorActionPreference='SilentlyContinue'; Get-Process -Name java,javaw,EpicBot-NXT,EpicBot | Select-Object Id,ProcessName,StartTime,Path | ConvertTo-Json -Compress; exit 0";
    const { stdout } = await execFileAsync("powershell.exe", ["-NoProfile", "-Command", command], {
      windowsHide: true,
      timeout: 5000,
    });
    const trimmed = stdout.trim();
    if (!trimmed) return [];
    const parsed = JSON.parse(trimmed);
    if (!parsed) return [];
    const titles = await getWindowTitlesByPid();
    return (Array.isArray(parsed) ? parsed : [parsed]).map((item) => ({
      pid: Number(item.Id),
      processName: String(item.ProcessName || ""),
      startTime: parseProcessStartTime(item.StartTime),
      path: String(item.Path || ""),
      commandLine: "",
      windowTitle: titles.get(Number(item.Id)) || String(item.MainWindowTitle || ""),
    })).filter((item) => Number.isInteger(item.pid));
  } catch {
    return [];
  }
}

async function getWindowTitlesByPid() {
  if (process.platform !== "win32") return new Map();
  const now = Date.now();
  if (windowTitleCache.promise) return windowTitleCache.promise;
  if (now - windowTitleCache.at < 3500) return windowTitleCache.value;

  windowTitleCache.promise = queryWindowTitlesByPid()
    .then((value) => {
      windowTitleCache.at = Date.now();
      windowTitleCache.value = value;
      return value;
    })
    .finally(() => {
      windowTitleCache.promise = null;
    });

  return windowTitleCache.promise;
}

async function queryWindowTitlesByPid() {
  if (process.platform !== "win32") return new Map();
  try {
    const command = `
$ErrorActionPreference='SilentlyContinue'
Add-Type @"
using System;
using System.Text;
using System.Runtime.InteropServices;
public class NfcUser32 {
  public delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumWindowsProc lpEnumFunc, IntPtr lParam);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern int GetWindowText(IntPtr hWnd, StringBuilder text, int count);
  [DllImport("user32.dll")] public static extern int GetWindowTextLength(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out int processId);
}
"@
$items = New-Object System.Collections.Generic.List[object]
[NfcUser32]::EnumWindows({
  param($hWnd, $lParam)
  if ([NfcUser32]::IsWindowVisible($hWnd)) {
    $len = [NfcUser32]::GetWindowTextLength($hWnd)
    if ($len -gt 0) {
      $builder = New-Object System.Text.StringBuilder ($len + 1)
      [void][NfcUser32]::GetWindowText($hWnd, $builder, $builder.Capacity)
      $pid = 0
      [void][NfcUser32]::GetWindowThreadProcessId($hWnd, [ref]$pid)
      $title = $builder.ToString()
      if ($pid -and $title) { $items.Add([pscustomobject]@{ Pid = $pid; Title = $title }) }
    }
  }
  return $true
}, [IntPtr]::Zero) | Out-Null
$items | ConvertTo-Json -Compress
`;
    const { stdout } = await execFileAsync("powershell.exe", ["-NoProfile", "-Command", command], {
      windowsHide: true,
      timeout: 5000,
    });
    const trimmed = stdout.trim();
    if (!trimmed) return new Map();
    const parsed = JSON.parse(trimmed);
    const rows = Array.isArray(parsed) ? parsed : [parsed];
    const map = new Map();
    for (const row of rows) {
      const pid = Number(row.Pid);
      const title = String(row.Title || "");
      if (Number.isInteger(pid) && title) map.set(pid, title);
    }
    return map;
  } catch {
    return new Map();
  }
}

function parseProcessStartTime(value) {
  const raw = String(value || "");
  const dotNetDate = raw.match(/Date\((\d+)\)/);
  if (dotNetDate) return Number(dotNetDate[1]);
  const parsed = Date.parse(raw);
  return Number.isFinite(parsed) ? parsed : 0;
}

function isDreamBotClientProcess(processInfo) {
  return /[\\/]DreamBot[\\/]BotData[\\/]/i.test(processInfo.path)
    || /[\\/]DreamBot[\\/]BotData[\\/]/i.test(processInfo.commandLine || "")
    || /^DreamBot\b/i.test(processInfo.windowTitle || "");
}

function isEpicBotClientProcess(processInfo) {
  return /epicbot/i.test(processInfo?.processName || "")
    || /epicbot/i.test(processInfo?.path || "")
    || /epicbot/i.test(processInfo?.commandLine || "")
    || /^EpicBot\b/i.test(processInfo?.windowTitle || "");
}

function isTribotClientProcess(processInfo) {
  return /tribot/i.test(processInfo?.processName || "")
    || /tribot/i.test(processInfo?.path || "")
    || /tribot/i.test(processInfo?.commandLine || "")
    || /^TRiBot\b/i.test(processInfo?.windowTitle || "");
}

function isLaunchClientProcess(processInfo, launch = {}) {
  const botClient = normalizeBotClient(launch.botClient);
  if (botClient === "epicbot") return isEpicBotClientProcess(processInfo);
  if (botClient === "tribot") return isTribotClientProcess(processInfo);
  return isDreamBotClientProcess(processInfo);
}

function launchClientMatchScore(processInfo, launch) {
  const title = String(processInfo?.windowTitle || "");
  const commandLine = String(processInfo?.commandLine || "");
  const haystack = `${title}\n${commandLine}`.toLowerCase();
  let score = 0;
  const email = String(launch?.email || "");
  if (email && haystack.includes(email.toLowerCase())) score += 100;
  const accountNickname = String(launch?.accountNickname || "").trim();
  if (accountNickname && haystack.includes(accountNickname.toLowerCase())) score += 90;
  const jagexDisplayName = String(launch?.jagexDisplayName || "").trim();
  if (jagexDisplayName && haystack.includes(jagexDisplayName.toLowerCase())) score += 90;
  const scheduleName = String(launch?.scheduleName || "").trim();
  if (scheduleName && haystack.includes(scheduleName.toLowerCase())) score += 15;
  const scriptName = String(launch?.scriptName || "").trim();
  if (scriptName && haystack.includes(scriptName.toLowerCase())) score += 10;
  return score;
}

function processStronglyMatchesLaunch(processInfo, launch) {
  return launchClientMatchScore(processInfo, launch) >= 90;
}

function isLaunchActive(launch) {
  return launch?.status === "Running" || launch?.status === "Starting";
}

function parseCommandLineArgs(commandLine) {
  const args = [];
  const pattern = /"([^"\\]*(?:\\.[^"\\]*)*)"|(\S+)/g;
  let match;
  while ((match = pattern.exec(String(commandLine || "")))) {
    args.push((match[1] || match[2] || "").replace(/\\"/g, '"'));
  }
  return args;
}

function getArgValue(args, names) {
  const wanted = new Set(names.map((name) => name.toLowerCase()));
  for (let index = 0; index < args.length - 1; index += 1) {
    const current = String(args[index]);
    if (wanted.has(current.toLowerCase())) return args[index + 1];
    const inline = current.match(/^([^=]+)=(.+)$/);
    if (inline && wanted.has(inline[1].toLowerCase())) return inline[2];
  }
  return "";
}

function extractDreamBotIdentity(processInfo) {
  const args = parseCommandLineArgs(processInfo?.commandLine || "");
  const displayName = normalizePlayerName(getArgValue(args, ["-displayName", "--displayName", "-characterName", "--characterName", "-playerName", "--playerName"]));
  const characterId = String(getArgValue(args, ["-characterId", "--characterId"]) || "").trim();
  const accountUsername = String(getArgValue(args, ["-accountUsername", "--accountUsername", "-username", "--username"]) || "").trim();
  return { displayName, characterId, accountUsername };
}

function getCommandLineHint(commandLine) {
  const text = redactCommandLine(commandLine);
  const flagIndex = text.search(/-{1,2}(accountUsername|characterId|displayName|script|params|world)\b/i);
  if (flagIndex >= 0) return text.slice(Math.max(0, flagIndex - 120), flagIndex + 1800);
  return text.slice(-1800);
}

function redactCommandLine(commandLine) {
  const args = parseCommandLineArgs(commandLine);
  const sensitive = new Set([
    "-accountPassword",
    "-accountPass",
    "-accountTotp",
    "-proxyPass",
    "-proxyPassArg",
    "-sessionId",
    "-accessToken",
    "-refreshToken",
    "--jagex-password",
    "--jagex-totp",
    "--jagex-session-id",
    "--legacy-password",
    "--legacy-password-raw",
    "--legacy-totp-raw",
    "--proxy-password",
    "--proxy-password-raw",
  ].map((item) => item.toLowerCase()));
  return args.map((arg, index) => (sensitive.has(String(args[index - 1] || "").toLowerCase()) ? mask(String(arg)) : arg)).join(" ");
}

function latestStageFromText(text, status) {
  const matches = [...String(text || "").matchAll(/\[NeuraL Jagex Login\]\s+[^\n]*?\s+(.+)/g)];
  if (matches.length) return matches.at(-1)[1].trim();
  if (status === "Starting") return "Aguardando client DreamBot";
  return status === "Running" ? "Cliente online" : "Parado ou desconhecido";
}

function cleanDreamBotLogLine(line) {
  return String(line || "").replace(/^\d{1,2}:\d{2}:\d{2}\s*(AM|PM)?\s*/i, "").trim();
}

function extractRoutineCompletion(text, launch = {}) {
  const lines = String(text || "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);

  for (const line of lines.slice().reverse()) {
    if (/ALL SKILLS AT TARGET\s*&\s*NO QUESTS\s*-\s*STOPPING/i.test(line)) {
      return cleanDreamBotLogLine(line);
    }
    if (/\[SCRIPT\]\s+Script completed!/i.test(line)) {
      return cleanDreamBotLogLine(line);
    }
    if (/\[INFO\]\s+Stopped\s+.+/i.test(line)) {
      const scriptName = String(launch.scriptName || "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      if (!scriptName || new RegExp(`Stopped\\s+${scriptName}`, "i").test(line)) {
        return cleanDreamBotLogLine(line);
      }
    }
  }

  return "";
}

async function reconcileLaunches(launches, javaProcesses = []) {
  const usedClientPids = new Set();
  const sorted = launches
    .slice()
    .sort((a, b) => new Date(b.startedAt || 0).getTime() - new Date(a.startedAt || 0).getTime());
  const reconciledByPid = new Map();

  for (const launch of sorted) {
    const launchTime = new Date(launch.startedAt || 0).getTime();
    const savedClientPid = Number(launch.clientPid || 0);
    const clientProcesses = javaProcesses.filter((processInfo) => isLaunchClientProcess(processInfo, launch));
    const savedClient = clientProcesses.find((item) =>
      item.pid === savedClientPid &&
      !usedClientPids.has(item.pid) &&
      (!item.startTime || item.startTime >= launchTime - 15000)
    );
    const strongClient = clientProcesses
      .filter((item) => !usedClientPids.has(item.pid))
      .map((item) => ({ item, score: launchClientMatchScore(item, launch) }))
      .filter((match) => match.score >= 90)
      .sort((a, b) => b.score - a.score || Math.abs((a.item.startTime || launchTime) - launchTime) - Math.abs((b.item.startTime || launchTime) - launchTime))[0]?.item;
    const directRunning = isProcessRunning(launch.pid);
    const weakCandidates = clientProcesses
      .filter((item) => !usedClientPids.has(item.pid))
      .filter((item) => item.startTime >= launchTime - 15000)
      .map((item) => ({ item, score: launchClientMatchScore(item, launch) }))
      .filter((match) => match.score > 0)
      .sort((a, b) => b.score - a.score || Math.abs(a.item.startTime - launchTime) - Math.abs(b.item.startTime - launchTime));
    const weakClient = weakCandidates.length === 1 ? weakCandidates[0].item : null;
    const client = savedClient || strongClient || weakClient;

    if (client) usedClientPids.add(client.pid);
    const isFreshLaunch = Date.now() - launchTime < 5 * 60 * 1000;
    let status = client ? "Running" : directRunning && isFreshLaunch ? "Starting" : "StoppedOrUnknown";
    const stdout = await readTextTail(launch.stdout, 2500);
    const dreamBotLogPath = normalizeBotClient(launch.botClient) === "dreambot"
      ? await findLatestDreamBotLog(launch.email, launchTime - 5000)
      : "";
    const dreamBotLog = dreamBotLogPath ? await readTextTail(dreamBotLogPath, 12000) : "";
    const banReason = extractBanStatusFromText(`${stdout}\n${dreamBotLog}`);
    const completionReason = banReason
      ? `Conta banida: ${banReason}`
      : launch.completionReason || extractRoutineCompletion(`${stdout}\n${dreamBotLog}`, launch);
    const routineCompleted = Boolean(launch.routineCompleted || completionReason);
    const effectivePid = client?.pid || launch.pid;
    const completedAt = routineCompleted ? launch.completedAt || new Date().toISOString() : "";

    if (banReason && isLaunchActive({ status })) {
      for (const pid of [...new Set([client?.pid, launch.clientPid, launch.pid].map(Number).filter((pid) => Number.isInteger(pid) && pid > 0))]) {
        try {
          await stopProcess(pid);
        } catch {
          // The client may already have exited after DreamBot stopped the script.
        }
      }
      status = "StoppedOrUnknown";
    }

    reconciledByPid.set(launch.pid, {
      ...launch,
      clientPid: client?.pid || launch.clientPid || 0,
      effectivePid,
      status,
      stage: completionReason || latestStageFromText(stdout, status),
      routineCompleted,
      completionReason,
      banReason,
      banDetectedAt: banReason ? launch.banDetectedAt || completedAt || new Date().toISOString() : "",
      completedAt,
    });
  }

  return launches.map((launch) => reconciledByPid.get(launch.pid) || launch);
}

function compactLaunchesForRows(launches, rows) {
  const rowIndexes = new Set(rows.map((row) => Number(row.index)));
  const latestStoppedByIndex = new Map();
  const visible = [];

  for (const launch of launches) {
    const index = Number(launch.index);
    if (!rowIndexes.has(index)) continue;
    if (isLaunchActive(launch)) {
      visible.push(launch);
      continue;
    }

    const current = latestStoppedByIndex.get(index);
    if (!current || new Date(launch.startedAt || 0).getTime() > new Date(current.startedAt || 0).getTime()) {
      latestStoppedByIndex.set(index, launch);
    }
  }

  return visible
    .concat([...latestStoppedByIndex.values()])
    .sort((a, b) => new Date(b.startedAt || 0).getTime() - new Date(a.startedAt || 0).getTime());
}

function buildServerAccountActivities(rows, launches) {
  return rows.map((row) => {
    const index = Number(row.index);
    const related = launches
      .filter((launch) => Number(launch.index) === index)
      .sort((a, b) => new Date(b.startedAt || 0).getTime() - new Date(a.startedAt || 0).getTime());
    const active = related.find(isLaunchActive);
    const latest = active || related[0] || null;
    let health = "never";
    if (active?.status === "Running") health = "online";
    else if (active?.status === "Starting") health = "starting";
    else if (latest) health = "stopped";
    return {
      index,
      health,
      status: latest?.status || "",
      stage: latest?.stage || "",
      lastLaunchAt: latest?.startedAt || "",
      pid: latest?.effectivePid || latest?.clientPid || latest?.pid || "",
    };
  });
}

function launchNotificationKey(launch, type = "stopped") {
  return `${launch.index}:${launch.pid}:${launch.startedAt || ""}:${type}`;
}

function formatDurationMs(ms) {
  if (!Number.isFinite(ms) || ms < 0) return "-";
  const totalSeconds = Math.floor(ms / 1000);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  if (hours) return `${hours}h ${minutes}m`;
  if (minutes) return `${minutes}m ${seconds}s`;
  return `${seconds}s`;
}

async function getLaunchTailForNotification(launch, includeLogTail) {
  if (!includeLogTail) return "";
  const launchTime = new Date(launch.startedAt || 0).getTime();
  const dreamBotLogPath = await findLatestDreamBotLog(launch.email, launchTime - 5000);
  const dreamBotLog = dreamBotLogPath ? await readTextTail(dreamBotLogPath, 1600) : "";
  const stdout = await readTextTail(launch.stdout, 1600);
  const text = (dreamBotLog || stdout || "").trim();
  return text.length > 1400 ? text.slice(-1400) : text;
}

async function sendDiscordWebhook(config, payload) {
  const webhook = normalizeDiscordWebhookConfig(config);
  if (!webhook.enabled || !webhook.url) return false;

  const response = await fetch(webhook.url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });

  if (!response.ok) {
    throw new Error(`Discord webhook HTTP ${response.status}`);
  }
  return true;
}

async function notifyLaunchStopped({ config, rows, launch }) {
  const webhook = normalizeDiscordWebhookConfig(config);
  if (!webhook.notifyOnStop) return false;

  const row = rows.find((item) => Number(item.index) === Number(launch.index)) || {};
  const startedAt = Date.parse(launch.startedAt || "");
  const duration = formatDurationMs(Date.now() - startedAt);
  const logTail = await getLaunchTailForNotification(launch, webhook.includeLogTail);
  const fields = [
    { name: "Conta", value: String(launch.email || "-"), inline: true },
    { name: "Nick", value: String(row.charName || "aguardando"), inline: true },
    { name: "Categoria", value: String(row.category || "-"), inline: true },
    { name: "Script", value: String(launch.scheduleName || launch.scriptName || "-"), inline: true },
    { name: "Duração", value: duration, inline: true },
    { name: "Última etapa", value: String(launch.completionReason || launch.stage || "Parado").slice(0, 900), inline: false },
  ];

  if (logTail) {
    fields.push({
      name: "Final do log",
      value: `\`\`\`\n${logTail.replaceAll("`", "'").slice(-900)}\n\`\`\``,
      inline: false,
    });
  }

  return sendDiscordWebhook(config, {
    username: "NeuraL Farm Control",
    embeds: [{
      title: launch.routineCompleted ? "Rotina finalizada" : "Cliente encerrado",
      color: 0x58d68d,
      timestamp: new Date().toISOString(),
      fields,
    }],
  });
}

function hiscoreGoalValue(stats, skill) {
  if (skill === "combat") return Number(stats.combatLevel || 0);
  if (skill === "overall") return Number(stats.totalLevel || stats.skills?.overall?.level || 0);
  return Number(stats.skills?.[skill]?.level || 0);
}

async function moveAccountToCategory(index, category) {
  const target = normalizeCategory(category);
  if (!target) return false;
  const config = await readConfig();
  if (!Array.isArray(config.accounts)) config.accounts = [];
  config.categories = normalizeCategories(config).includes(target)
    ? normalizeCategories(config)
    : normalizeCategories({ ...config, categories: [...config.categories, target] });

  let changed = false;
  config.accounts = config.accounts.map((row) => {
    if (Number(row.index) !== Number(index)) return row;
    if (normalizeCategory(row.category) === target) return row;
    changed = true;
    return { ...row, category: target };
  });

  if (changed) await writeConfig(config);
  return changed;
}

async function closeCompletedLaunchClient(launch) {
  const pid = Number(launch.effectivePid || launch.clientPid || launch.pid || 0);
  if (!Number.isInteger(pid) || pid <= 0) {
    return { stopped: false, pid: 0, error: "pid invalido" };
  }
  try {
    await stopProcess(pid);
    return { stopped: true, pid, error: "" };
  } catch (error) {
    return { stopped: false, pid, error: error.message || String(error) };
  }
}

async function runTaskCompletionAction({ launch, rows, tasks }) {
  const task = tasks.find((item) => item.id && item.id === launch.taskId);
  if (!task) return { pending: false, detail: "" };

  const row = rows.find((item) => Number(item.index) === Number(launch.index));
  const skill = normalizeCompletionSkill(task.completionSkill);
  const targetLevel = Number(task.completionLevel || 0);

  if (skill && targetLevel > 0) {
    if (!row?.charName) {
      return { pending: true, detail: "sem nick salvo para consultar HiScores" };
    }
    const stats = await getHiscores({ player: row.charName, refresh: false });
    const currentLevel = hiscoreGoalValue(stats, skill);
    if (currentLevel < targetLevel) {
      return { pending: true, detail: `${skill} ${currentLevel}/${targetLevel}` };
    }
  }

  if (task.moveToCategoryOnComplete) {
    const moved = await moveAccountToCategory(launch.index, task.moveToCategoryOnComplete);
    const closeResult = await closeCompletedLaunchClient(launch);
    return {
      pending: false,
      detail: moved
        ? `movida para ${task.moveToCategoryOnComplete}; client ${closeResult.stopped ? `fechado pid ${closeResult.pid}` : `nao fechado: ${closeResult.error}`}`
        : `ja estava em ${task.moveToCategoryOnComplete}; client ${closeResult.stopped ? `fechado pid ${closeResult.pid}` : `nao fechado: ${closeResult.error}`}`,
      movedCategory: task.moveToCategoryOnComplete,
      stoppedPid: closeResult.stopped ? closeResult.pid : 0,
      stopError: closeResult.error || "",
    };
  }

  return { pending: false, detail: "" };
}

async function processLaunchNotifications({ config, appState, rows, tasks = [], reconciled }) {
  const webhook = normalizeDiscordWebhookConfig(config);

  const previousByPid = new Map((appState.launches || []).map((launch) => [Number(launch.pid), launch]));
  const notifications = appState.discordNotifications && typeof appState.discordNotifications === "object"
    ? appState.discordNotifications
    : {};
  let changed = false;

  for (const launch of reconciled) {
    if (launch.scriptName === nickCaptureScriptName) continue;
    const previous = previousByPid.get(Number(launch.pid));
    const completionKey = launchNotificationKey(launch, "completed");
    if (launch.routineCompleted && !notifications[completionKey]) {
      try {
        const action = await runTaskCompletionAction({ launch, rows, tasks });
        if (action.pending) continue;
        if (webhook.enabled && webhook.url && webhook.notifyOnStop) {
          await notifyLaunchStopped({ config, rows, launch });
        }
        notifications[completionKey] = {
          at: new Date().toISOString(),
          email: launch.email,
          index: launch.index,
          pid: launch.pid,
          type: "completed",
          reason: launch.completionReason || "",
          action: action.detail || "",
          movedCategory: action.movedCategory || "",
          stoppedPid: action.stoppedPid || 0,
          stopError: action.stopError || "",
        };
        changed = true;
      } catch (error) {
        notifications[completionKey] = {
          at: new Date().toISOString(),
          email: launch.email,
          index: launch.index,
          pid: launch.pid,
          type: "completed-error",
          error: error.message || String(error),
        };
        changed = true;
      }
    }

    if (isLaunchActive(previous) && !isLaunchActive(launch)) {
      const key = launchNotificationKey(launch, "stopped");
      if (notifications[completionKey]) continue;
      if (notifications[key]) continue;
      try {
        if (webhook.enabled && webhook.url && webhook.notifyOnStop) {
          await notifyLaunchStopped({ config, rows, launch });
        }
        notifications[key] = {
          at: new Date().toISOString(),
          email: launch.email,
          index: launch.index,
          pid: launch.pid,
          type: "stopped",
        };
        changed = true;
      } catch (error) {
        notifications[key] = {
          at: new Date().toISOString(),
          email: launch.email,
          index: launch.index,
          pid: launch.pid,
          type: "stopped-error",
          error: error.message || String(error),
        };
        changed = true;
      }
    }
  }

  appState.discordNotifications = notifications;
  return changed;
}

async function parseBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  if (!chunks.length) return {};
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

const aiAnalysisSchema = {
  type: "object",
  additionalProperties: false,
  required: ["summary", "severity", "confidence", "keyFindings", "suggestedActions", "affectedAccounts", "nextQuestion"],
  properties: {
    summary: { type: "string" },
    severity: { type: "string", enum: ["ok", "info", "warning", "critical"] },
    confidence: { type: "number", minimum: 0, maximum: 1 },
    keyFindings: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["title", "detail", "evidence"],
        properties: {
          title: { type: "string" },
          detail: { type: "string" },
          evidence: { type: "string" },
        },
      },
    },
    suggestedActions: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["label", "reason", "risk"],
        properties: {
          label: { type: "string" },
          reason: { type: "string" },
          risk: { type: "string", enum: ["low", "medium", "high"] },
        },
      },
    },
    affectedAccounts: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["index", "email", "charName", "status", "reason"],
        properties: {
          index: { type: "number" },
          email: { type: "string" },
          charName: { type: "string" },
          status: { type: "string" },
          reason: { type: "string" },
        },
      },
    },
    nextQuestion: { type: "string" },
  },
};

function compactRowForAi(row, accountsByIndex, activity, checkerResult) {
  const account = accountsByIndex.get(Number(row.index)) || {};
  return {
    index: Number(row.index),
    email: maskEmail(account.email || ""),
    charName: row.charName || row.accountNickname || row.jagexDisplayName || "",
    category: row.category || "default",
    enabled: row.enabled !== false,
    scriptName: row.scriptName || "",
    scheduleName: row.scheduleName || "",
    scriptParams: Array.isArray(row.scriptParams) ? row.scriptParams.join(" ") : String(row.scriptParams || ""),
    epicBotProfilePath: row.epicBotProfilePath || "",
    worldMode: row.worldMode || "fixed",
    world: row.world || "",
    botClient: normalizeBotClient(row.botClient),
    health: activity?.health || "unknown",
    lastLaunchAt: activity?.lastLaunchAt || "",
    checkerStatus: checkerResult?.status || "unchecked",
    checkerMessage: checkerResult?.message || "",
    totalLevel: checkerResult?.totalLevel || "",
  };
}

async function buildAiAnalysisContext(body = {}) {
  const config = await readConfig();
  const accounts = await readAccounts();
  const rows = normalizeConfigAccounts(config, accounts);
  const appState = await readAppState();
  const launches = await reconcileLaunches(appState.launches || [], await getJavaProcesses());
  const visibleLaunches = compactLaunchesForRows(launches, rows);
  const accountsByIndex = new Map(accounts.map((account) => [Number(account.index), account]));
  const selectedIndex = Number(body.index);
  const hasSelectedIndex = Number.isInteger(selectedIndex) && selectedIndex >= 0;
  const scope = String(body.scope || "panel").trim() || "panel";
  const filteredRows = hasSelectedIndex ? rows.filter((row) => Number(row.index) === selectedIndex) : rows;
  const activityByIndex = new Map(buildServerAccountActivities(rows, visibleLaunches).map((item) => [Number(item.index), item]));
  const checker = appState.checker && typeof appState.checker === "object" ? appState.checker : {};
  const compactRows = filteredRows.slice(0, hasSelectedIndex ? 1 : 80).map((row) =>
    compactRowForAi(row, accountsByIndex, activityByIndex.get(Number(row.index)), checker[row.index])
  );

  const activeLaunches = visibleLaunches
    .filter(isLaunchActive)
    .map((launch) => ({
      index: Number(launch.index),
      email: maskEmail(launch.email || ""),
      botClient: normalizeBotClient(launch.botClient),
      scriptName: launch.scriptName || "",
      scheduleName: launch.scheduleName || "",
      status: launch.status || "",
      stage: launch.stage || "",
      startedAt: launch.startedAt || "",
      pid: launch.effectivePid || launch.clientPid || launch.pid || "",
    }));

  const recentLaunches = visibleLaunches
    .filter((launch) => !hasSelectedIndex || Number(launch.index) === selectedIndex)
    .slice(0, 8)
    .map((launch) => ({
      index: Number(launch.index),
      email: maskEmail(launch.email || ""),
      botClient: normalizeBotClient(launch.botClient),
      scriptName: launch.scriptName || "",
      scheduleName: launch.scheduleName || "",
      status: launch.status || "",
      stage: launch.stage || "",
      startedAt: launch.startedAt || "",
      completedAt: launch.completedAt || "",
      completionReason: launch.completionReason || "",
      banReason: launch.banReason || "",
    }));

  const ai = normalizeAiConfig(config);
  const logSections = [];
  if (ai.includeCheckerLog) {
    logSections.push({
      name: "checker.log",
      text: redactSensitiveText(truncateText(await readTextTail(checkerLogPath, scope === "checker" ? 24000 : 14000), 24000)),
    });
  }
  if (ai.includeLaunchLogs) {
    for (const launch of visibleLaunches.filter((item) => !hasSelectedIndex || Number(item.index) === selectedIndex).slice(0, 4)) {
      const stdout = await readTextTail(launch.stdout, 3500);
      const stderr = await readTextTail(launch.stderr, 1800);
      const launchTime = new Date(launch.startedAt || 0).getTime();
      const dreamBotLogPath = normalizeBotClient(launch.botClient) === "dreambot"
        ? await findLatestDreamBotLog(launch.email, launchTime - 5000)
        : "";
      const dreamBotLog = dreamBotLogPath ? await readTextTail(dreamBotLogPath, 3500) : "";
      logSections.push({
        name: `launch index ${launch.index} pid ${launch.pid}`,
        text: redactSensitiveText(truncateText([stdout, stderr, dreamBotLog].filter(Boolean).join("\n\n"), 7000)),
      });
    }
  }

  return {
    scope,
    selectedIndex: hasSelectedIndex ? selectedIndex : null,
    generatedAt: new Date().toISOString(),
    overview: {
      totalAccounts: rows.length,
      visibleAccountsInContext: compactRows.length,
      activeLaunches: activeLaunches.length,
      checkerStatuses: Object.values(checker).reduce((acc, item) => {
        const key = item?.status || "unchecked";
        acc[key] = (acc[key] || 0) + 1;
        return acc;
      }, {}),
    },
    accounts: compactRows,
    activeLaunches,
    recentLaunches,
    logSections,
    userQuestion: redactSensitiveText(String(body.prompt || "").trim()),
  };
}

function extractResponseText(payload) {
  if (payload?.output_text) return String(payload.output_text);
  const pieces = [];
  for (const item of Array.isArray(payload?.output) ? payload.output : []) {
    for (const content of Array.isArray(item.content) ? item.content : []) {
      if (content.type === "output_text" && content.text) pieces.push(content.text);
    }
  }
  return pieces.join("\n").trim();
}

function normalizeAiAnalysisPayload(value) {
  const input = value && typeof value === "object" ? value : {};
  return {
    summary: String(input.summary || "Sem resumo retornado."),
    severity: ["ok", "info", "warning", "critical"].includes(input.severity) ? input.severity : "info",
    confidence: Math.max(0, Math.min(1, Number(input.confidence || 0))),
    keyFindings: Array.isArray(input.keyFindings) ? input.keyFindings.slice(0, 8).map((item) => ({
      title: String(item?.title || "Achado"),
      detail: String(item?.detail || ""),
      evidence: String(item?.evidence || ""),
    })) : [],
    suggestedActions: Array.isArray(input.suggestedActions) ? input.suggestedActions.slice(0, 8).map((item) => ({
      label: String(item?.label || "Revisar"),
      reason: String(item?.reason || ""),
      risk: ["low", "medium", "high"].includes(item?.risk) ? item.risk : "medium",
    })) : [],
    affectedAccounts: Array.isArray(input.affectedAccounts) ? input.affectedAccounts.slice(0, 12).map((item) => ({
      index: Number(item?.index || 0),
      email: String(item?.email || ""),
      charName: String(item?.charName || ""),
      status: String(item?.status || ""),
      reason: String(item?.reason || ""),
    })) : [],
    nextQuestion: String(input.nextQuestion || ""),
  };
}

async function analyzeWithAi(body = {}) {
  const config = await readConfig();
  const ai = normalizeAiConfig(config);
  if (!ai.enabled) throw new Error("AI Analyst está desativado. Ative na aba Config.");
  if (!ai.openAiApiKey) throw new Error("OpenAI API key não configurada. Preencha na aba Config.");
  if (!ai.model) throw new Error("Modelo de IA não configurado.");

  const context = await buildAiAnalysisContext(body);
  const prompt = [
    "Analise o contexto do NeuraL Farm Control abaixo.",
    "Responda em português do Brasil, seja direto e não invente ações que não aparecem no contexto.",
    "Se uma evidência estiver fraca, diga que é uma hipótese.",
    "Nunca sugira ação automática destrutiva; sugira confirmação manual quando houver risco.",
    "",
    JSON.stringify(context, null, 2),
  ].join("\n");

  const response = await fetch(openAiResponsesEndpoint, {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${ai.openAiApiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: ai.model,
      instructions: "Você é um analista de logs e operação do painel NeuraL Farm Control. Seu trabalho é explicar falhas, gargalos, sinais de ban/checker e próximos passos seguros.",
      input: prompt,
      max_output_tokens: 1800,
      text: {
        format: {
          type: "json_schema",
          name: "nfc_ai_log_analysis",
          strict: true,
          schema: aiAnalysisSchema,
        },
      },
    }),
  });

  const payloadText = await response.text();
  let payload = {};
  try {
    payload = payloadText ? JSON.parse(payloadText) : {};
  } catch {
    payload = { raw: payloadText };
  }
  if (!response.ok) {
    const message = payload?.error?.message || payloadText || `OpenAI HTTP ${response.status}`;
    throw new Error(`Falha na OpenAI: ${message}`);
  }

  const outputText = extractResponseText(payload);
  let parsed = {};
  try {
    parsed = JSON.parse(outputText);
  } catch {
    parsed = { summary: outputText || "A OpenAI respondeu sem JSON válido.", severity: "warning" };
  }

  return {
    ok: true,
    model: ai.model,
    createdAt: new Date().toISOString(),
    contextMeta: {
      scope: context.scope,
      selectedIndex: context.selectedIndex,
      accounts: context.accounts.length,
      logSections: context.logSections.length,
    },
    usage: payload?.usage || null,
    analysis: normalizeAiAnalysisPayload(parsed),
  };
}

async function findAvailablePort(startPort, { minPort = 51000, maxPort = 65535, attempts = 500 } = {}) {
  const min = Math.max(0, Math.floor(Number(minPort) || 0));
  const max = Math.min(65535, Math.floor(Number(maxPort) || 65535));
  const span = Math.max(1, max - min + 1);
  const normalizedStart = min + ((((Math.floor(Number(startPort) || min) - min) % span) + span) % span);

  for (let offset = 0; offset < Math.min(attempts, span); offset += 1) {
    const portToTry = min + (((normalizedStart - min) + offset) % span);
    const available = await new Promise((resolveAvailable) => {
      const server = createTcpServer();
      server.once("error", () => resolveAvailable(false));
      server.listen(portToTry, "127.0.0.1", () => {
        server.close(() => resolveAvailable(true));
      });
    });
    if (available) return portToTry;
  }
  throw new Error("Nao foi possivel encontrar uma porta livre para o browser Jagex.");
}

async function appendLaunchLog(filePath, message) {
  if (!filePath) return;
  await appendFile(filePath, `\n[NeuraL Jagex Login] ${new Date().toLocaleTimeString()} ${message}\n`);
}

async function appendCheckerLog(message, details = {}) {
  await mkdir(logsDir, { recursive: true });
  const extra = Object.entries(details)
    .filter(([, value]) => value !== undefined && value !== null && value !== "")
    .map(([key, value]) => `${key}=${String(value).replace(/\s+/g, " ")}`)
    .join(" ");
  await appendFile(checkerLogPath, `[${new Date().toLocaleString()}] ${message}${extra ? ` · ${extra}` : ""}\n`);
}

async function getCheckerLog() {
  return {
    path: checkerLogPath,
    text: await readTextTail(checkerLogPath, 30000),
  };
}

async function clearCheckerLog() {
  await mkdir(logsDir, { recursive: true });
  await writeFile(checkerLogPath, "");
  await appendCheckerLog("Log do checker limpo");
  return getCheckerLog();
}

async function addCheckerLog(body = {}) {
  await appendCheckerLog(String(body.message || "Evento do checker"), body.details || {});
  return getCheckerLog();
}

async function appendJagexDebugLog(message) {
  const stamp = new Date().toISOString().slice(0, 10);
  const filePath = join(logsDir, `jagex-debug-${stamp}.log`);
  await mkdir(logsDir, { recursive: true });
  await appendFile(filePath, `[${new Date().toISOString()}] ${message}\n`);
}

function sanitizeDebugValue(value) {
  if (value == null) return value;
  if (typeof value === "string") {
    if (value.length > 120) return `${value.slice(0, 24)}...${value.slice(-8)}`;
    return value;
  }
  if (Array.isArray(value)) return value.slice(0, 5).map(sanitizeDebugValue);
  if (typeof value === "object") {
    const safe = {};
    for (const [key, nested] of Object.entries(value).slice(0, 30)) {
      if (/token|secret|password|session|auth|cookie/i.test(key)) safe[key] = "[redacted]";
      else safe[key] = sanitizeDebugValue(nested);
    }
    return safe;
  }
  return value;
}

function collectDebugKeys(value, prefix = "", keys = []) {
  if (!value || typeof value !== "object" || keys.length > 80) return keys;
  for (const [key, nested] of Object.entries(value)) {
    const path = prefix ? `${prefix}.${key}` : key;
    keys.push(path);
    if (nested && typeof nested === "object") collectDebugKeys(nested, path, keys);
  }
  return keys;
}

function isLikelyRunescapeName(value) {
  const clean = normalizePlayerName(value);
  if (!clean) return false;
  if (clean.length < 1 || clean.length > 12) return false;
  if (/@|https?:|\.com/i.test(clean)) return false;
  if (!/^[a-z0-9 _-]+$/i.test(clean)) return false;
  if (!/[a-z0-9]/i.test(clean)) return false;
  if (/\b(username|password|account|jagex|runescape|email|login|continue|valid|required)\b/i.test(clean)) return false;
  return true;
}

function collectDisplayNameCandidates(value, candidates = []) {
  if (!value || typeof value !== "object") return candidates;
  for (const [key, nested] of Object.entries(value)) {
    if (typeof nested === "string" && /display.*name|character.*name|player.*name|name$/i.test(key)) {
      const clean = normalizePlayerName(nested);
      if (isLikelyRunescapeName(clean) && !candidates.includes(clean)) candidates.push(clean);
    } else if (nested && typeof nested === "object") {
      collectDisplayNameCandidates(nested, candidates);
    }
  }
  return candidates;
}

async function fetchJson(url, timeoutMs = 2000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, { signal: controller.signal });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return await response.json();
  } finally {
    clearTimeout(timer);
  }
}

async function waitForCdpTarget(portToWait, timeoutMs = 45000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    try {
      const targets = await fetchJson(`http://127.0.0.1:${portToWait}/json`, 1500);
      const page = targets.find((target) => target.type === "page" && target.webSocketDebuggerUrl) || targets[0];
      if (page?.webSocketDebuggerUrl) return page.webSocketDebuggerUrl;
    } catch {
      // The browser can take a few seconds to expose the debugging endpoint.
    }
    await sleep(1000);
  }
  throw new Error(`Browser Jagex nao abriu a porta de automacao ${portToWait}.`);
}

async function createCdpClient(webSocketUrl) {
  const socket = new WebSocket(webSocketUrl);
  const pending = new Map();
  const listeners = new Set();
  let nextId = 1;

  await new Promise((resolveOpen, rejectOpen) => {
    const timer = setTimeout(() => rejectOpen(new Error("Timeout ao conectar no browser Jagex.")), 8000);
    socket.addEventListener("open", () => {
      clearTimeout(timer);
      resolveOpen();
    }, { once: true });
    socket.addEventListener("error", () => {
      clearTimeout(timer);
      rejectOpen(new Error("Falha ao conectar no browser Jagex."));
    }, { once: true });
  });

  socket.addEventListener("message", (event) => {
    const payload = JSON.parse(event.data);
    if (!payload.id || !pending.has(payload.id)) {
      listeners.forEach((listener) => listener(payload));
      return;
    }
    const { resolveRequest, rejectRequest } = pending.get(payload.id);
    pending.delete(payload.id);
    if (payload.error) rejectRequest(new Error(payload.error.message || "Erro CDP."));
    else resolveRequest(payload.result);
  });

  return {
    send(method, params = {}) {
      const id = nextId++;
      socket.send(JSON.stringify({ id, method, params }));
      return new Promise((resolveRequest, rejectRequest) => {
        pending.set(id, { resolveRequest, rejectRequest });
        setTimeout(() => {
          if (!pending.has(id)) return;
          pending.delete(id);
          rejectRequest(new Error(`Timeout no comando CDP ${method}.`));
        }, 10000);
      });
    },
    close() {
      socket.close();
    },
    onMessage(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}

async function cdpEval(client, expression) {
  const result = await client.send("Runtime.evaluate", {
    expression,
    awaitPromise: true,
    returnByValue: true,
  });
  return result.result?.value;
}

async function waitForExpression(client, expression, timeoutMs = 30000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (await cdpEval(client, expression)) return true;
    await sleep(750);
  }
  return false;
}

function visibleInputExpression(selector) {
  return `(() => {
    const input = [...document.querySelectorAll(${JSON.stringify(selector)})]
      .find((el) => {
        const rect = el.getBoundingClientRect();
        return rect.width > 0 && rect.height > 0 && !el.disabled && !el.readOnly;
      });
    if (!input) return false;
    input.focus();
    input.value = "";
    input.dispatchEvent(new Event("input", { bubbles: true }));
    return true;
  })()`;
}

function fillVisibleInputExpression(selector, value) {
  return `(() => {
    const input = [...document.querySelectorAll(${JSON.stringify(selector)})]
      .find((el) => {
        const rect = el.getBoundingClientRect();
        return rect.width > 0 && rect.height > 0 && !el.disabled && !el.readOnly;
      });
    if (!input) return false;
    const value = ${JSON.stringify(value)};
    input.focus();
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")?.set;
    if (setter) setter.call(input, "");
    else input.value = "";
    input.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "deleteContentBackward", data: null }));
    if (setter) setter.call(input, value);
    else input.value = value;
    input.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText", data: value }));
    input.dispatchEvent(new Event("change", { bubbles: true }));
    input.dispatchEvent(new KeyboardEvent("keyup", { bubbles: true, key: value.slice(-1) || "0" }));
    return input.value === value;
  })()`;
}

async function typeIntoFocusedField(client, selector, value) {
  const focused = await waitForExpression(client, visibleInputExpression(selector), 30000);
  if (!focused) throw new Error(`Campo nao encontrado no login Jagex: ${selector}`);
  const filled = await cdpEval(client, fillVisibleInputExpression(selector, value));
  if (!filled) await client.send("Input.insertText", { text: value });
  await sleep(500);
}

async function clickJagexContinue(client) {
  const clicked = await waitForExpression(client, `(() => {
    const candidates = [...document.querySelectorAll("button,input[type=submit]")];
    const button = candidates.find((el) => {
      const rect = el.getBoundingClientRect();
      const text = (el.innerText || el.value || "").trim();
      return rect.width > 0 && rect.height > 0 && !el.disabled && /continue|log in|sign in|next/i.test(text);
    });
    if (!button) return false;
    button.click();
    return true;
  })()`, 10000);
  if (!clicked) {
    await cdpEval(client, `(() => {
      const form = document.querySelector("form");
      if (!form) return false;
      if (typeof form.requestSubmit === "function") form.requestSubmit();
      else form.submit();
      return true;
    })()`);
  }
  await sleep(1500);
}

async function clickJagexCookiePromptIfPresent(client, timeoutMs = 7000) {
  const started = Date.now();
  let lastResult = { clicked: false, reason: "not-present" };
  while (Date.now() - started < timeoutMs) {
    const result = await cdpEval(client, `(() => {
      const text = String(document.body?.innerText || "").replace(/\\s+/g, " ").trim();
      const looksLikeCookiePrompt = /Your Privacy|cookies|Cookie Policy|Manage Preferences/i.test(text);
      if (!looksLikeCookiePrompt) return { clicked: false, reason: "not-present" };

      const candidates = [...document.querySelectorAll("button,input[type=button],input[type=submit],a,[role=button]")];
      const buttons = candidates
        .map((el) => {
          const rect = el.getBoundingClientRect();
          const label = (el.innerText || el.value || el.getAttribute("aria-label") || el.textContent || "").replace(/\\s+/g, " ").trim();
          return { el, rect, label };
        })
        .filter(({ rect, label }) => rect.width > 0 && rect.height > 0 && label);

      const preferred = buttons.find(({ label }) => /use necessary cookies only|necessary cookies/i.test(label))
        || buttons.find(({ label }) => /allow all cookies|accept all cookies|accept all/i.test(label))
        || buttons.find(({ label }) => /continue|accept|allow/i.test(label));

      if (!preferred) return { clicked: false, reason: "button-not-found", text: text.slice(0, 180) };
      preferred.el.click();
      return { clicked: true, label: preferred.label };
    })()`);

    lastResult = result || lastResult;
    if (result?.clicked) {
      await sleep(1200);
      return result;
    }
    await sleep(500);
  }

  return lastResult;
}

async function fillJagexTotpAndContinue(client, code) {
  const selector = [
    "#totp-verify-form--input-code",
    'input[name="code"]',
    'input[inputmode="numeric"]',
    'input[autocomplete="one-time-code"]',
    'input[type="tel"]',
    'input[id*="code" i]',
    'input[aria-label*="code" i]',
    'input[type="text"]',
    "input:not([type])",
  ].join(", ");
  await typeIntoFocusedField(client, selector, code);
  await clickJagexContinue(client);
}

async function clickJagexConsentIfPresent(client) {
  const started = Date.now();
  while (Date.now() - started < 25000) {
    const result = await cdpEval(client, `(() => {
      const url = String(location.href || "");
      const text = String(document.body?.innerText || "").replace(/\\s+/g, " ").trim();
      const onConsent = /\\/consent\\b|consent_challenge|authorize|permissions|access/i.test(url + " " + text);
      const candidates = [...document.querySelectorAll("button,input[type=submit],a,[role=button]")];
      const match = candidates
        .map((el) => {
          const rect = el.getBoundingClientRect();
          const label = (el.innerText || el.value || el.getAttribute("aria-label") || "").replace(/\\s+/g, " ").trim();
          return { el, rect, label };
        })
        .filter(({ rect, label }) =>
          rect.width > 0 &&
          rect.height > 0 &&
          !/decline|deny|cancel|back|logout|log out/i.test(label) &&
          /accept|agree|allow|authorize|continue|confirm|yes|play|launch/i.test(label)
        )
        .sort((a, b) => (b.rect.width * b.rect.height) - (a.rect.width * a.rect.height))[0];
      if (match && (onConsent || /accept|allow|authorize|continue/i.test(match.label))) {
        match.el.click();
        return { clicked: true, label: match.label, url };
      }
      if (/secure\\.runescape\\.com|launcher-redirect|code=/.test(url)) {
        return { done: true, url };
      }
      return { clicked: false, done: false, url, text: text.slice(0, 120) };
    })()`);

    if (result?.done) return result;
    if (result?.clicked) {
      await sleep(2500);
      return result;
    }
    await sleep(1000);
  }
  return { clicked: false, done: false, timeout: true };
}

async function clickAuthenticatorOption(client) {
  const started = Date.now();
  while (Date.now() - started < 30000) {
    const alreadyOnTotp = await cdpEval(client, `Boolean(document.querySelector("#totp-verify-form--input-code, input[name='code'], input[inputmode='numeric']"))`);
    if (alreadyOnTotp) return "already-on-totp";

    const point = await cdpEval(client, `(() => {
      const elements = [...document.querySelectorAll("button,a,div,li,label,[role=button]")];
      const matches = elements
        .map((el) => {
          const rect = el.getBoundingClientRect();
          const text = (el.innerText || el.textContent || "").replace(/\\s+/g, " ").trim();
          return { el, rect, text };
        })
        .filter(({ rect, text }) =>
          rect.width > 80 &&
          rect.height > 20 &&
          rect.height < 180 &&
          /use your authenticator app|authenticator app/i.test(text)
        )
        .sort((a, b) => (a.rect.width * a.rect.height) - (b.rect.width * b.rect.height));
      const item = matches[0];
      if (!item) return null;
      return {
        x: Math.round(item.rect.left + item.rect.width / 2),
        y: Math.round(item.rect.top + item.rect.height / 2),
        text: item.text,
      };
    })()`);
    if (point?.x && point?.y) {
      await client.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: point.x, y: point.y });
      await client.send("Input.dispatchMouseEvent", { type: "mousePressed", x: point.x, y: point.y, button: "left", clickCount: 1 });
      await client.send("Input.dispatchMouseEvent", { type: "mouseReleased", x: point.x, y: point.y, button: "left", clickCount: 1 });
      await sleep(2000);
      const stillOnChoice = await cdpEval(client, `document.body.innerText.includes("Choose a way to verify")`);
      if (!stillOnChoice) return;
    }
    await sleep(750);
  }
  throw new Error("Opcao 'Use your authenticator app' nao foi acionada.");
}

async function attachJagexDebugMonitor(client, { account, index }) {
  const interesting = /account|character|profile|session|display|jagex|auth|user/i;
  const requestIds = new Map();
  await appendJagexDebugLog(`debug start account=${account.email} index=${index}`);
  await client.send("Network.enable");
  const off = client.onMessage(async (payload) => {
    try {
      if (payload.method === "Network.responseReceived") {
        const response = payload.params?.response || {};
        const url = response.url || "";
        if (!interesting.test(url)) return;
        const mime = response.mimeType || "";
        if (!/json/i.test(mime)) {
          await appendJagexDebugLog(`response status=${response.status} mime=${mime} url=${url}`);
          return;
        }
        requestIds.set(payload.params.requestId, { url, status: response.status, mime });
        await appendJagexDebugLog(`response status=${response.status} mime=${mime} url=${url}`);
      }

      if (payload.method === "Network.loadingFinished" && requestIds.has(payload.params?.requestId)) {
        const meta = requestIds.get(payload.params.requestId);
        requestIds.delete(payload.params.requestId);
        let bodyResult;
        try {
          bodyResult = await client.send("Network.getResponseBody", { requestId: payload.params.requestId });
        } catch (error) {
          await appendJagexDebugLog(`body unavailable url=${meta.url} error=${error.message}`);
          return;
        }
        const body = String(bodyResult?.body || "");
        if (!body || body.length > 250000) return;
        let parsed = null;
        try {
          parsed = JSON.parse(body);
        } catch {
          const textCandidates = [...body.matchAll(/"([^"]*(?:displayName|characterName|playerName|name)[^"]*)"\s*:\s*"([^"]+)"/gi)]
            .map((match) => normalizePlayerName(match[2]))
            .filter(isLikelyRunescapeName);
          if (textCandidates.length) {
            await appendJagexDebugLog(`text candidates url=${meta.url} candidates=${JSON.stringify(textCandidates)}`);
          }
          return;
        }
        const keys = collectDebugKeys(parsed).slice(0, 40);
        const candidates = collectDisplayNameCandidates(parsed);
        await appendJagexDebugLog(`json url=${meta.url} keys=${JSON.stringify(keys)} candidates=${JSON.stringify(candidates)} sample=${JSON.stringify(sanitizeDebugValue(parsed)).slice(0, 1200)}`);
        if (candidates.length) {
          const saved = await saveCharNameForAccount(index, candidates[0]);
          await appendJagexDebugLog(`candidate selected=${candidates[0]} saved=${saved}`);
        }
      }
    } catch (error) {
      await appendJagexDebugLog(`debug monitor error=${error.message}`);
    }
  });
  return off;
}

async function automateJagexLogin({ account, index, config, portToUse, stdoutPath }) {
  try {
    await appendLaunchLog(stdoutPath, `aguardando browser Jagex na porta ${portToUse}.`);
    if (config.jagexDebug) {
      await appendJagexDebugLog(`debug requested account=${account.email} index=${index} port=${portToUse}`);
    }
    const wsUrl = await waitForCdpTarget(portToUse);
    const client = await createCdpClient(wsUrl);
    try {
      await client.send("Runtime.enable");
      await client.send("Page.enable");
      const stopDebugMonitor = config.jagexDebug ? await attachJagexDebugMonitor(client, { account, index }) : null;
      const firstCookieResult = await clickJagexCookiePromptIfPresent(client, 7000);
      if (firstCookieResult.clicked) {
        await appendLaunchLog(stdoutPath, `cookies Jagex acionado: ${firstCookieResult.label || "botao"}.`);
      }
      await appendLaunchLog(stdoutPath, "preenchendo email.");
      await typeIntoFocusedField(client, 'input[type="email"], input[name*="email" i], input[autocomplete="email"], input[id*="email" i]', account.email);
      await clickJagexContinue(client);
      const emailCookieResult = await clickJagexCookiePromptIfPresent(client, 2500);
      if (emailCookieResult.clicked) {
        await appendLaunchLog(stdoutPath, `cookies Jagex acionado: ${emailCookieResult.label || "botao"}.`);
      }

      await appendLaunchLog(stdoutPath, "preenchendo senha.");
      await typeIntoFocusedField(client, 'input[type="password"], input[name*="password" i], input[autocomplete*="password" i]', account.password);
      await clickJagexContinue(client);
      const passwordCookieResult = await clickJagexCookiePromptIfPresent(client, 2500);
      if (passwordCookieResult.clicked) {
        await appendLaunchLog(stdoutPath, `cookies Jagex acionado: ${passwordCookieResult.label || "botao"}.`);
      }

      await appendLaunchLog(stdoutPath, "selecionando app autenticador.");
      const authenticatorStep = await clickAuthenticatorOption(client);
      if (authenticatorStep === "already-on-totp") {
        await appendLaunchLog(stdoutPath, "tela de TOTP ja estava aberta.");
      }

      await appendLaunchLog(stdoutPath, "preenchendo TOTP.");
      const totpCookieResult = await clickJagexCookiePromptIfPresent(client, 2500);
      if (totpCookieResult.clicked) {
        await appendLaunchLog(stdoutPath, `cookies Jagex acionado: ${totpCookieResult.label || "botao"}.`);
      }
      await fillJagexTotpAndContinue(client, getTotpCode(account.totpSecret));
      await appendLaunchLog(stdoutPath, "autenticacao enviada.");
      const consentResult = await clickJagexConsentIfPresent(client);
      if (consentResult.clicked) {
        await appendLaunchLog(stdoutPath, `consentimento Jagex acionado: ${consentResult.label || "botao"}.`);
      } else if (consentResult.done) {
        await appendLaunchLog(stdoutPath, "redirect Jagex detectado.");
      } else if (consentResult.timeout) {
        await appendLaunchLog(stdoutPath, "consentimento Jagex nao apareceu dentro do tempo.");
      }
      if (stopDebugMonitor) {
        await sleep(4000);
        stopDebugMonitor();
      }
    } finally {
      client.close();
    }
  } catch (error) {
    await appendLaunchLog(stdoutPath, `falha na automacao: ${error.message}`);
    if (config.jagexDebug) {
      await appendJagexDebugLog(`automation failed account=${account.email} index=${index} error=${error.message}`);
    }
  }
}

function enqueueJagexLoginAutomation(payload) {
  const run = async () => {
    await appendLaunchLog(payload.stdoutPath, "aguardando vez na fila de login Jagex.");
    await automateJagexLogin(payload);
    await appendLaunchLog(payload.stdoutPath, "fila de login Jagex liberada.");
  };

  const queued = jagexLoginQueue.then(run, run);
  jagexLoginQueue = queued.catch(() => {});
  return queued;
}

async function launchAccount(index, options = {}) {
  const config = await readConfig();
  const accounts = await readAccounts();
  const rows = normalizeConfigAccounts(config, accounts);
  const baseRow = rows.find((item) => item.index === index);
  let row = options.rowOverride ? { ...baseRow, ...options.rowOverride } : baseRow;
  const account = accounts[index];
  const botClient = normalizeBotClient(row?.botClient);
  let epicBotLaunchPlan = null;

  if (!row) throw new Error(`Account index ${index} is not configured in farm.json.`);
  if (!row.enabled && !options.allowDisabled) throw new Error(`Account index ${index} is not enabled in farm.json.`);
  if (!account) throw new Error(`Account index ${index} was not found in accounts.txt.`);
  if (botClient === "epicbot") {
    const storedSession = findEpicBotStoredSession(account, row);
    if (storedSession) row = { ...row, ...storedSession };
  }
  if (botClient === "tribot") {
    const tribotCliPath = resolveTribotCliPath(config);
    if (!tribotCliPath) throw new Error(`TRiBot CLI not found: ${config.tribotCliPath || "(vazio)"}`);
    config.tribotCliPath = tribotCliPath;
  } else if (botClient === "epicbot") {
    const hasStoredSession = Boolean(row.jagexSessionId && row.jagexCharacterId);
    epicBotLaunchPlan = buildEpicBotLaunchPlan(config, { preferRuntime: hasStoredSession });
    if (!epicBotLaunchPlan) throw new Error(formatMissingEpicBotPathMessage(config));
    if (epicBotLaunchPlan.mode === "launcher") config.epicBotPath = epicBotLaunchPlan.command;
  } else if (!existsSync(config.launcherPath)) {
    throw new Error(`DreamBot launcher not found: ${config.launcherPath}`);
  }

  const existingLaunches = await reconcileLaunches(await readState(), await getJavaProcesses());
  const existingLaunch = existingLaunches.find((item) => Number(item.index) === index && isLaunchActive(item));
  if (existingLaunch) throw new Error(`Account ${account.email} is already running.`);

  const nickCaptureReady = botClient === "dreambot" && !options.skipNickCapture && !row.charName
    ? await ensureNickCaptureJarInstalled()
    : false;

  if (!options.skipNickCapture && !row.charName && nickCaptureReady) {
    const helperRow = {
      ...row,
      scriptName: nickCaptureScriptName,
      scheduleName: "",
      scriptParams: [],
    };
    const helperResult = await launchAccount(index, {
      ...options,
      skipNickCapture: true,
      taskName: options.taskName ? `${options.taskName} · capturando nick` : "Capturando nick",
      rowOverride: helperRow,
    });
    launchRealAfterNickCapture({
      index,
      options,
      helperPid: helperResult.pid,
      helperStartedAt: helperResult.startedAt,
      helperStdoutPath: helperResult.stdout,
    });
    return {
      ...helperResult,
      capturingNick: true,
      message: "Conta sem nick: capturando nick antes do launch real.",
    };
  }
  if (botClient === "dreambot" && !options.skipNickCapture && !row.charName && !nickCaptureReady) {
    await mkdir(logsDir, { recursive: true });
    const safeEmail = account.email.replace(/[^a-zA-Z0-9._-]/g, "_");
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    await appendLaunchLog(
      join(logsDir, `${stamp}-${safeEmail}.out.log`),
      `helper de nick nao encontrado. Esperado em ${nickCaptureJarPath}. Origem do projeto: ${projectNickCaptureJarPath}.`,
    );
  }

  await mkdir(logsDir, { recursive: true });
  const safeEmail = account.email.replace(/[^a-zA-Z0-9._-]/g, "_");
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const stdoutPath = join(logsDir, `${stamp}-${safeEmail}.out.log`);
  const stderrPath = join(logsDir, `${stamp}-${safeEmail}.err.log`);
  const remoteDebuggingPort = botClient === "dreambot" && usesBrowserLogin(row, config)
    ? await findAvailablePort(51000 + (index * 100), { minPort: 51000, maxPort: 65499, attempts: 700 })
    : 0;
  const launchCommand = botClient === "tribot"
    ? resolveTribotCliPath(config)
    : botClient === "epicbot"
      ? epicBotLaunchPlan.command
      : "java";
  const launchArgs = botClient === "epicbot"
    ? [
      ...epicBotLaunchPlan.argsPrefix,
      ...buildEpicBotArgs({
        account,
        row,
        config,
        includeRuntimeOptions: epicBotLaunchPlan.mode !== "runtime",
      }),
    ]
    : buildArgs({ account, row, config, remoteDebuggingPort });
  const safeArgs = redactCommandArgs(launchArgs);
  const previewSafeArgs = botClient === "epicbot" && epicBotLaunchPlan?.mode === "runtime"
    ? safeArgs.map((arg, argIndex) => (safeArgs[argIndex - 1] === "-cp" ? "[EpicBot classpath]" : arg))
    : safeArgs;
  await appendLaunchLog(
    stdoutPath,
    `preparando launch ${botClient}${epicBotLaunchPlan ? ` (${epicBotLaunchPlan.mode}${row.jagexSessionId ? ", sessao salva" : ", login inicial"})` : ""}: ${botClient === "dreambot" && row.scheduleName ? `schedule=${row.scheduleName}` : `script=${row.scriptName || config.defaultScriptName || "-"}`}.`,
  );
  const child = spawn(launchCommand, launchArgs, {
    cwd: epicBotLaunchPlan?.cwd || rootDir,
    windowsHide: true,
    detached: true,
    stdio: ["ignore", "pipe", "pipe"],
  });

  const stdout = createWriteStream(stdoutPath, { flags: "a" });
  const stderr = createWriteStream(stderrPath, { flags: "a" });
  child.stdout?.pipe(stdout);
  child.stderr?.pipe(stderr);
  child.on("exit", () => {
    stdout.end();
    stderr.end();
  });
  child.unref();

  const state = await readState();
  state.push({
    email: account.email,
    index,
    taskId: options.taskId || "",
    taskName: options.taskName || "",
    scriptName: row.scriptName,
    botClient,
    scheduleName: row.scheduleName || "",
    scriptParams: row.scriptParams,
    accountNickname: row.accountNickname || "",
    jagexDisplayName: row.jagexDisplayName || "",
    world: resolveWorld(row, config),
    pid: child.pid,
    startedAt: new Date().toISOString(),
    commandPreview: formatCommandPreview([launchCommand, ...previewSafeArgs]),
    remoteDebuggingPort,
    stdout: stdoutPath,
    stderr: stderrPath,
  });
  await writeState(state);

  if (botClient === "dreambot" && remoteDebuggingPort) {
    enqueueJagexLoginAutomation({ account, index, config, portToUse: remoteDebuggingPort, stdoutPath });
  }
  if (botClient === "dreambot") {
    monitorDreamBotIdentity({
      index,
      account,
      launcherPid: child.pid,
      startedAt: new Date().toISOString(),
      stdoutPath,
    }).catch((error) => appendLaunchLog(stdoutPath, `falha no monitor de nick: ${error.message}`));
  }

  return { pid: child.pid, startedAt: state.at(-1)?.startedAt, stdout: stdoutPath };
}

async function stopProcess(pid) {
  const parsed = Number(pid);
  if (!Number.isInteger(parsed)) throw new Error("Invalid pid.");
  await terminateProcessTree(parsed);
  return { stopped: parsed };
}

async function terminateProcessTree(pid) {
  const parsed = Number(pid);
  if (!Number.isInteger(parsed) || parsed <= 0) return false;
  if (!isProcessRunning(parsed)) return false;
  if (process.platform === "win32") {
    try {
      await execFileAsync("taskkill.exe", ["/PID", String(parsed), "/T", "/F"], {
        windowsHide: true,
        timeout: 8000,
      });
      return true;
    } catch {
      // Fall back to Node's process.kill below.
    }
  }
  process.kill(parsed);
  return true;
}

async function stopActiveLaunchesForIndex(index, reason = "parado pelo checker") {
  const parsed = Number(index);
  if (!Number.isInteger(parsed)) return [];
  const appState = await readAppState();
  javaProcessCache.at = 0;
  const javaProcesses = await getJavaProcesses();
  const reconciled = await reconcileLaunches(appState.launches || [], javaProcesses);
  const accounts = await readAccounts();
  const account = accounts[parsed] || {};
  const stopped = [];
  const now = new Date().toISOString();
  const targetLaunches = reconciled.filter((launch) => Number(launch.index) === parsed);
  const targetPids = new Set();

  for (const launch of targetLaunches) {
    for (const pid of [launch.effectivePid, launch.clientPid, launch.pid].map(Number)) {
      if (Number.isInteger(pid) && pid > 0) targetPids.add(pid);
    }
    for (const processInfo of javaProcesses) {
      if (!isDreamBotClientProcess(processInfo)) continue;
      if (launchClientMatchScore(processInfo, launch) >= 90) targetPids.add(processInfo.pid);
    }
  }

  const email = String(account.email || targetLaunches[0]?.email || "").toLowerCase();
  if (email) {
    for (const processInfo of javaProcesses) {
      const haystack = `${processInfo.windowTitle || ""}\n${processInfo.commandLine || ""}`.toLowerCase();
      if (isDreamBotClientProcess(processInfo) && haystack.includes(email)) targetPids.add(processInfo.pid);
    }
  }

  for (const pid of targetPids) {
    try {
      if (await terminateProcessTree(pid)) stopped.push(pid);
    } catch {
      // The process may have already closed after DreamBot stopped the script.
    }
  }

  appState.launches = reconciled.map((launch) => {
    if (Number(launch.index) !== parsed) return launch;
    return {
      ...launch,
      status: "StoppedOrUnknown",
      stage: reason,
      completionReason: reason,
      routineCompleted: true,
      completedAt: launch.completedAt || now,
    };
  });

  await writeAppState(appState);
  return stopped;
}

async function stopCheckerLaunches(body = {}) {
  const index = Number(body.index);
  if (Number.isInteger(index)) {
    await appendCheckerLog("Stop manual solicitado para conta do checker", { index });
    const stopped = await stopActiveLaunchesForIndex(index, "Checker encerrado manualmente");
    await appendCheckerLog("Stop manual executado", { index, stopped: stopped.join(",") || "nenhum" });
    return { stopped, indexes: [index] };
  }

  await appendCheckerLog("Stop manual solicitado para todos os helpers do checker");
  const appState = await readAppState();
  const reconciled = await reconcileLaunches(appState.launches || [], await getJavaProcesses());
  const helperIndexes = [...new Set(reconciled
    .filter((launch) => launch.scriptName === nickCaptureScriptName && isLaunchActive(launch))
    .map((launch) => Number(launch.index))
    .filter((item) => Number.isInteger(item)))];
  const stopped = [];
  for (const helperIndex of helperIndexes) {
    stopped.push(...await stopActiveLaunchesForIndex(helperIndex, "Checker encerrado manualmente"));
  }
  await appendCheckerLog("Stop manual geral executado", { indexes: helperIndexes.join(",") || "nenhum", stopped: stopped.join(",") || "nenhum" });
  return { stopped, indexes: helperIndexes };
}

async function saveCheckerResult(index, result) {
  const parsed = Number(index);
  if (!Number.isInteger(parsed)) throw new Error("Invalid account index.");
  const state = await readAppState();
  state.checker = {
    ...(state.checker || {}),
    [parsed]: {
      index: parsed,
      checkedAt: new Date().toISOString(),
      ...result,
    },
  };
  await writeAppState(state);
  return state.checker[parsed];
}

async function saveCheckerHiscoresResult(index, charName, options = {}) {
  try {
    await appendCheckerLog("Consultando HiScores", { index, charName });
    const stats = await getHiscores({ player: charName, refresh: true });
    const result = await saveCheckerResult(index, {
      status: "ok",
      message: "Conta encontrada no HiScores.",
      charName,
      totalLevel: stats.totalLevel,
      combatLevel: stats.combatLevel,
    });
    await appendCheckerLog("Conta encontrada no HiScores", { index, charName, totalLevel: stats.totalLevel });
    if (options.closeClient) {
      const stopped = await stopActiveLaunchesForIndex(index, "Checker finalizado: conta encontrada no HiScores");
      if (options.stdoutPath && stopped.length) {
        await appendLaunchLog(options.stdoutPath, `checker fechou client apos conta encontrada: pid ${stopped.join(", ")}.`);
      }
      await appendCheckerLog("Client fechado apos conta encontrada", { index, stopped: stopped.join(",") || "nenhum" });
    }
    return result;
  } catch (error) {
    if (error.code === "HISCORES_NOT_FOUND") {
      await appendCheckerLog("Nick nao encontrado no HiScores", { index, charName });
      const result = await saveCheckerResult(index, {
        status: "banned",
        message: "Nick não encontrado no HiScores. Provável banida.",
        charName,
      });
      if (options.closeClient) {
        const stopped = await stopActiveLaunchesForIndex(index, "Checker finalizado: nick não encontrado no HiScores");
        if (options.stdoutPath && stopped.length) {
          await appendLaunchLog(options.stdoutPath, `checker fechou client apos nick nao encontrado: pid ${stopped.join(", ")}.`);
        }
        await appendCheckerLog("Client fechado apos nick nao encontrado", { index, stopped: stopped.join(",") || "nenhum" });
      }
      return result;
    }
    await appendCheckerLog("Erro ao consultar HiScores", { index, charName, error: error.message || String(error) });
    return saveCheckerResult(index, {
      status: "error",
      message: error.message || String(error),
      charName,
    });
  }
}

async function monitorCheckerNickCapture({ index, account, startedAt, stdoutPath, timeoutMs = 150000 }) {
  const startedMs = new Date(startedAt || Date.now()).getTime();
  const deadline = Date.now() + timeoutMs;
  const stalledDeadline = Date.now() + 90000;
  await appendCheckerLog("Monitor de captura iniciado", { index, email: account.email, timeoutMs });

  while (Date.now() < deadline) {
    const stdout = await readTextTail(stdoutPath, 8000);
    const dreamBotLogPath = await findLatestDreamBotLog(account.email, startedMs - 5000);
    const dreamBotLog = dreamBotLogPath ? await readTextTail(dreamBotLogPath, 12000) : "";
    const combined = `${stdout}\n${dreamBotLog}`;
    const banReason = extractBanStatusFromText(combined);
    const runtimeError = extractNickCaptureRuntimeError(combined);
    const blockedReason = extractNickCaptureBlockedReason(combined);

    if (runtimeError) {
      await appendLaunchLog(stdoutPath, `checker detectou erro do helper: ${runtimeError}`);
      await appendCheckerLog("Erro runtime detectado no helper", { index, error: runtimeError });
      const result = await saveCheckerResult(index, {
        status: "error",
        message: runtimeError,
        charName: "",
      });
      const stopped = await stopActiveLaunchesForIndex(index, runtimeError);
      if (stopped.length) {
        await appendLaunchLog(stdoutPath, `checker fechou client com erro: pid ${stopped.join(", ")}.`);
      }
      await appendCheckerLog("Stop apos erro runtime concluido", { index, stopped: stopped.join(",") || "nenhum" });
      return result;
    }

    if (blockedReason) {
      const reason = blockedReason;
      await appendLaunchLog(stdoutPath, `checker abortou captura: ${reason}`);
      await appendCheckerLog("Captura travada; abortando conta", { index, reason });
      const result = await saveCheckerResult(index, {
        status: "error",
        message: reason,
        charName: "",
      });
      const stopped = await stopActiveLaunchesForIndex(index, reason);
      await appendCheckerLog("Stop apos captura travada concluido", { index, stopped: stopped.join(",") || "nenhum" });
      return result;
    }

    if (banReason) {
      await appendLaunchLog(stdoutPath, `checker marcou conta como banida: ${banReason}.`);
      await appendCheckerLog("Ban detectado no DreamBot", { index, reason: banReason });
      const result = await saveCheckerResult(index, {
        status: "banned",
        message: `Ban detectado no DreamBot: ${banReason}.`,
        charName: "",
      });
      const stopped = await stopActiveLaunchesForIndex(index, `Conta banida: ${banReason}`);
      if (stopped.length) {
        await appendLaunchLog(stdoutPath, `checker fechou client banido: pid ${stopped.join(", ")}.`);
      }
      await appendCheckerLog("Stop apos ban concluido", { index, stopped: stopped.join(",") || "nenhum" });
      return result;
    }

    const charName = extractCharNameFromText(combined);
    if (isLikelyRunescapeName(charName)) {
      await saveCharNameForAccount(index, charName);
      await appendLaunchLog(stdoutPath, `checker capturou nick: ${charName}.`);
      await appendCheckerLog("Nick capturado pelo helper", { index, charName });
      return saveCheckerHiscoresResult(index, charName, { closeClient: true, stdoutPath });
    }

    if (Date.now() > stalledDeadline) {
      const reason = "Checker sem progresso na captura por 90s.";
      await appendLaunchLog(stdoutPath, `checker abortou captura: ${reason}`);
      await appendCheckerLog("Captura sem progresso; abortando conta", { index, reason });
      const result = await saveCheckerResult(index, {
        status: "error",
        message: reason,
        charName: "",
      });
      const stopped = await stopActiveLaunchesForIndex(index, reason);
      await appendCheckerLog("Stop apos captura sem progresso concluido", { index, stopped: stopped.join(",") || "nenhum" });
      return result;
    }

    await sleep(2000);
  }

  await appendLaunchLog(stdoutPath, "checker terminou sem capturar nick ou detectar ban.");
  await appendCheckerLog("Timeout do monitor de captura", { index });
  return saveCheckerResult(index, {
    status: "error",
    message: "Checker não conseguiu capturar nick ou ban dentro do tempo.",
    charName: "",
  });
}

async function checkAccountHiscores(body) {
  const index = Number(body.index);
  if (!Number.isInteger(index)) throw new Error("Invalid account index.");
  await appendCheckerLog("Checagem solicitada", { index });
  const config = await readConfig();
  const accounts = await readAccounts();
  const rows = normalizeConfigAccounts(config, accounts);
  const row = rows.find((item) => Number(item.index) === index);
  const account = accounts[index];
  if (!row || !account) throw new Error(`Conta ${index} não encontrada.`);
  await appendCheckerLog("Conta carregada para checker", { index, email: account.email, hasNick: row.charName ? "sim" : "nao" });

  if (!row.charName) {
    const alive = await reconcileLaunches(await readState(), await getJavaProcesses());
    const running = alive.find((launch) => Number(launch.index) === index && isLaunchActive(launch));
    let monitorTarget = running;
    if (!running) {
      await appendCheckerLog("Conta sem nick: preparando helper", { index });
      const nickCaptureReady = await ensureNickCaptureJarInstalled();
      if (!nickCaptureReady) {
        await appendCheckerLog("Helper de captura nao encontrado", { index });
        return saveCheckerResult(index, {
          status: "error",
          message: "Helper NeuraL Nick Capture não encontrado.",
          charName: "",
        });
      }
      const helperRow = {
        ...row,
        botClient: "dreambot",
        scriptName: nickCaptureScriptName,
        scheduleName: "",
          scriptParams: [],
        };
      monitorTarget = await launchAccount(index, {
        skipNickCapture: true,
        allowDisabled: true,
        taskName: "Checker · capturando nick",
        rowOverride: helperRow,
      });
      await appendCheckerLog("Helper de captura iniciado", { index, pid: monitorTarget.pid, stdout: monitorTarget.stdout });
    } else {
      await appendCheckerLog("Helper/launch ja estava ativo para a conta", { index, pid: running.pid, status: running.status });
    }
    const result = await saveCheckerResult(index, {
      status: "capturing",
      message: running
        ? "Conta sem nick. Captura de nick já está rodando."
        : "Conta sem nick. Captura de nick iniciada no DreamBot.",
      charName: "",
    });

    if (monitorTarget?.stdout) {
      monitorCheckerNickCapture({
        index,
        account,
        startedAt: monitorTarget.startedAt,
        stdoutPath: monitorTarget.stdout,
      }).catch((error) => {
        saveCheckerResult(index, {
          status: "error",
          message: error.message || String(error),
          charName: "",
        }).catch(() => {});
      });
    }
    return result;
  }

  return saveCheckerHiscoresResult(index, row.charName);
}

async function addAccount(body) {
  const email = String(body.email || "").trim();
  const password = String(body.password || "");
  const totpSecret = String(body.totpSecret || "").trim();
  const category = normalizeCategory(body.category);
  if (!email || !password || !totpSecret) throw new Error("Email, password and TOTP secret are required.");
  getTotpCode(totpSecret);

  const accounts = await readAccounts();
  accounts.push({ email, password, totpSecret });
  await writeAccounts(accounts);

  const config = await readConfig();
  if (!Array.isArray(config.accounts)) config.accounts = [];
  config.categories = normalizeCategories(config).includes(category)
    ? normalizeCategories(config)
    : normalizeCategories({ ...config, categories: [...config.categories, category] });
  config.accounts.push({
    index: accounts.length - 1,
    enabled: true,
    notes: "",
    charName: "",
    category,
    scriptName: config.defaultScriptName || "Teste",
    scheduleName: "",
    epicBotProfilePath: "",
    world: Number(config.defaultWorld || 301),
    worldMode: "fixed",
    scriptParams: [],
    proxyId: "",
    botClient: "dreambot",
  });
  await writeConfig(config);
  return { added: accounts.length - 1 };
}

async function bulkImportAccounts(body) {
  const parsed = parseBulkAccountLines(body.accountsText);
  const category = normalizeCategory(body.category);
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
    config.categories = normalizeCategories(config).includes(category)
      ? normalizeCategories(config)
      : normalizeCategories({ ...config, categories: [...config.categories, category] });
    added.forEach((account, offset) => {
      config.accounts.push({
        index: startIndex + offset,
        enabled: true,
        notes: "",
        charName: "",
        category,
        scriptName: config.defaultScriptName || "Teste",
        scheduleName: "",
        epicBotProfilePath: "",
        world: Number(config.defaultWorld || 301),
        worldMode: "fixed",
        scriptParams: [],
        proxyId: "",
        botClient: "dreambot",
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

async function exportAccountsTxt(body = {}) {
  const accounts = await readAccounts();
  const indexes = Array.isArray(body.indexes)
    ? body.indexes.map((index) => Number(index)).filter((index) => Number.isInteger(index) && index >= 0)
    : [];
  if (!indexes.length) throw new Error("Selecione ao menos uma conta para exportar.");
  const selected = new Set(indexes);
  const content = accounts
    .filter((_, index) => selected.has(index))
    .map((account) => `${account.email}:${account.password}:${account.totpSecret}`)
    .join("\n");
  return {
    filename: `neural-accounts-${new Date().toISOString().slice(0, 10)}.txt`,
    content: `${content}${content ? "\n" : ""}`,
    exported: selected.size,
  };
}

async function updateSettings(body) {
  const config = await readConfig();
  config.launcherPath = String(body.launcherPath || config.launcherPath || "");
  config.tribotCliPath = String(body.tribotCliPath || "").trim();
  config.epicBotPath = String(body.epicBotPath || "").trim();
  config.defaultScriptName = String(body.defaultScriptName || "");
  config.defaultWorld = Number(body.defaultWorld || 301);
  config.useGeneratedTotp = Boolean(body.useGeneratedTotp);
  config.useJagexBrowserLogin = body.useJagexBrowserLogin !== false;
  config.jagexDebug = Boolean(body.jagexDebug);
  config.useStoredGameAccount = body.useStoredGameAccount !== false;
  config.launchDelaySeconds = Number(body.launchDelaySeconds || 0);
  config.maxInstances = Number(body.maxInstances || 1);
  config.discordWebhook = {
    url: String(body.discordWebhookUrl || "").trim(),
    enabled: Boolean(body.discordWebhookEnabled),
    notifyOnStop: body.discordNotifyOnStop !== false,
    includeLogTail: body.discordIncludeLogTail !== false,
  };
  config.epicBot = {
    platform: String(body.epicBotPlatform || "").trim(),
    heap: normalizePositiveIntegerText(body.epicBotHeap),
    maxHeap: normalizePositiveIntegerText(body.epicBotMaxHeap),
    mouseProfile: String(body.epicBotMouseProfile || "").trim(),
    useSavedProxyName: Boolean(body.epicBotUseSavedProxyName),
  };
  const currentAi = normalizeAiConfig(config);
  const currentStoredAiKey = String(config.ai?.openAiApiKey || "").trim();
  const nextAiKey = String(body.aiOpenAiApiKey || "").trim();
  config.ai = {
    enabled: Boolean(body.aiEnabled),
    provider: "openai",
    openAiApiKey: body.aiClearOpenAiApiKey ? "" : nextAiKey || currentStoredAiKey,
    model: String(body.aiModel || currentAi.model || "gpt-5.6-luna").trim(),
    includeCheckerLog: body.aiIncludeCheckerLog !== false,
    includeLaunchLogs: body.aiIncludeLaunchLogs !== false,
  };
  await writeConfig(config);
  return { saved: true };
}

async function updateRow(body) {
  const index = Number(body.index);
  if (!Number.isInteger(index)) throw new Error("Invalid account index.");
  const rowCategory = normalizeCategory(body.category);

  const config = await readConfig();
  if (!Array.isArray(config.accounts)) config.accounts = [];
  config.categories = normalizeCategories(config).includes(rowCategory)
    ? normalizeCategories(config)
    : normalizeCategories({ ...config, categories: [...config.categories, rowCategory] });
  const existing = config.accounts.find((item) => Number(item.index) === index);
  const row = existing || { index };
  row.enabled = body.enabled !== false;
  if (body.accountNickname !== undefined) row.accountNickname = String(body.accountNickname || "").trim();
  if (body.jagexSessionId !== undefined) row.jagexSessionId = String(body.jagexSessionId || "").trim();
  if (body.jagexCharacterId !== undefined) row.jagexCharacterId = String(body.jagexCharacterId || "").trim();
  if (body.jagexDisplayName !== undefined) row.jagexDisplayName = String(body.jagexDisplayName || "").trim();
  if (body.jagexAccessToken !== undefined) row.jagexAccessToken = String(body.jagexAccessToken || "").trim();
  if (body.jagexRefreshToken !== undefined) row.jagexRefreshToken = String(body.jagexRefreshToken || "").trim();
  row.notes = String(body.notes || "").trim();
  row.charName = String(body.charName || "").trim();
  row.category = rowCategory;
  row.scriptName = String(body.scriptName || config.defaultScriptName || "");
  row.scheduleName = String(body.scheduleName || "").trim();
  row.epicBotProfilePath = String(body.epicBotProfilePath || "").trim();
  row.world = Number(body.world || config.defaultWorld || 301);
  row.worldMode = normalizeWorldMode(body.worldMode);
  row.scriptParams = parseScriptParams(body.scriptParams);
  row.proxyId = normalizeProxyId(body.proxyId);
  row.botClient = normalizeBotClient(body.botClient);

  if (!existing) config.accounts.push(row);
  await writeConfig(config);
  return { saved: true };
}

async function deleteAccount(body) {
  const index = Number(body.index);
  if (!Number.isInteger(index) || index < 0) throw new Error("Invalid account index.");

  const launches = await reconcileLaunches(await readState(), await getJavaProcesses());
  const running = launches.find((item) => Number(item.index) === index && isLaunchActive(item));
  if (running) throw new Error("Essa conta está rodando. Pare o processo antes de excluir.");

  const accounts = await readAccounts();
  if (!accounts[index]) throw new Error("Account not found.");
  const nextAccounts = accounts.filter((account) => account.index !== index);
  await writeAccounts(nextAccounts);

  const config = await readConfig();
  if (Array.isArray(config.accounts)) {
    config.accounts = config.accounts
      .filter((account) => Number(account.index) !== index)
      .map((account) => {
        const accountIndex = Number(account.index);
        return {
          ...account,
          index: accountIndex > index ? accountIndex - 1 : accountIndex,
        };
      });
  }
  await writeConfig(config);

  const appState = await readAppState();
  appState.launches = appState.launches
    .filter((launch) => Number(launch.index) !== index)
    .map((launch) => {
      const launchIndex = Number(launch.index);
      return {
        ...launch,
        index: launchIndex > index ? launchIndex - 1 : launchIndex,
      };
    });
  await writeAppState(appState);

  return { deleted: index };
}

async function readTextTail(filePath, maxChars = 8000) {
  if (!filePath || !existsSync(filePath)) return "";
  const raw = await readFile(filePath, "utf8");
  return raw.length > maxChars ? raw.slice(-maxChars) : raw;
}

function dreamBotLogFolderFor(email) {
  return String(email || "").replace(/[^a-zA-Z0-9]/g, "_");
}

async function findLatestDreamBotLogInfo(email, notBefore = 0) {
  const file = await findLatestDreamBotLog(email, notBefore);
  if (!file) return null;
  try {
    const info = await stat(file);
    return { file, mtimeMs: info.mtimeMs };
  } catch {
    return null;
  }
}

async function findLatestDreamBotLog(email, notBefore = 0) {
  const folder = join(dreamBotLogsDir, dreamBotLogFolderFor(email));
  if (!existsSync(folder)) return "";
  const files = await readdir(folder, { withFileTypes: true });
  const logs = files
    .filter((entry) => entry.isFile() && entry.name.toLowerCase().endsWith(".log"))
    .map((entry) => join(folder, entry.name));

  let latest = "";
  let latestTime = 0;
  for (const file of logs) {
    try {
      const { mtimeMs } = await stat(file);
      if (mtimeMs >= notBefore && mtimeMs > latestTime) {
        latest = file;
        latestTime = mtimeMs;
      }
    } catch {
      // Ignore log files that rotate while reading.
    }
  }
  return latest;
}

async function getLaunchLog(body) {
  const pid = Number(body.pid);
  if (!Number.isInteger(pid)) throw new Error("Invalid pid.");
  const launches = await reconcileLaunches(await readState(), await getJavaProcesses());
  const launch = launches.find((item) => Number(item.pid) === pid || Number(item.effectivePid) === pid);
  if (!launch) throw new Error("Launch not found.");
  const launchTime = new Date(launch.startedAt || 0).getTime();
  const dreamBotLogPath = await findLatestDreamBotLog(launch.email, launchTime - 5000);
  const dreamBotLog = dreamBotLogPath
    ? await readTextTail(dreamBotLogPath, 12000)
    : "Nenhum log novo do DreamBot foi criado para este launch. O launcher provavelmente fechou antes de abrir o cliente.";

  return {
    pid,
    email: launch.email,
    scriptName: launch.scriptName,
    scheduleName: launch.scheduleName || "",
    world: launch.world,
    status: launch.status,
    stage: launch.stage || "",
    commandPreview: launch.commandPreview || "",
    stdoutPath: launch.stdout,
    stderrPath: launch.stderr,
    dreamBotLogPath,
    stdout: await readTextTail(launch.stdout),
    stderr: await readTextTail(launch.stderr),
    dreamBotLog,
  };
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

async function addCategory(body) {
  const name = normalizeCategory(body.name);
  const config = await readConfig();
  const categories = normalizeCategories(config);
  if (categories.includes(name)) return { added: name };
  config.categories = normalizeCategories({ ...config, categories: [...categories, name] });
  await writeConfig(config);
  return { added: name };
}

async function deleteCategory(body) {
  const name = normalizeCategory(body.name);
  if (name === "default") throw new Error("A categoria default não pode ser removida.");

  const config = await readConfig();
  const accounts = await readAccounts();
  const rows = normalizeConfigAccounts(config, accounts);
  const tasks = normalizeTasks(config);
  if (rows.some((row) => row.category === name)) {
    throw new Error("Essa categoria ainda está sendo usada por contas.");
  }
  if (tasks.some((task) => task.category === name)) {
    throw new Error("Essa categoria ainda está sendo usada por tasks.");
  }

  config.categories = normalizeCategories(config).filter((category) => category !== name);
  await writeConfig(config);
  return { deleted: name };
}

async function saveContinuousSettings(body) {
  const config = await readConfig();
  config.continuous = normalizeContinuousConfig({
    continuous: {
      enabled: body.enabled,
      checkIntervalSeconds: body.checkIntervalSeconds,
    },
  });
  await writeConfig(config);
  return { saved: true };
}

async function saveContinuousTask(body) {
  const config = await readConfig();
  const task = normalizeTask(body, config);
  if (!task.name) throw new Error("Task name is required.");
  if (!task.category) throw new Error("Task category is required.");
  if (!task.scriptName && !task.scheduleName) throw new Error("Task script or schedule is required.");
  config.categories = normalizeCategories(config).includes(task.category)
    ? normalizeCategories(config)
    : normalizeCategories({ ...config, categories: [...config.categories, task.category] });
  if (task.moveToCategoryOnComplete && !normalizeCategories(config).includes(task.moveToCategoryOnComplete)) {
    config.categories = normalizeCategories({ ...config, categories: [...config.categories, task.moveToCategoryOnComplete] });
  }

  const tasks = normalizeTasks(config);
  const existingIndex = tasks.findIndex((item) => item.id === task.id);
  if (existingIndex >= 0) {
    tasks[existingIndex] = task;
  } else {
    tasks.push(task);
  }

  config.continuousTasks = tasks;
  await writeConfig(config);
  return { saved: task.id };
}

async function deleteContinuousTask(body) {
  const id = String(body.id || "").trim();
  if (!id) throw new Error("Invalid task id.");
  const config = await readConfig();
  config.continuousTasks = normalizeTasks(config).filter((task) => task.id !== id);
  await writeConfig(config);
  return { deleted: id };
}

async function setTaskEnabled(body) {
  const id = String(body.id || "").trim();
  if (!id) throw new Error("Invalid task id.");
  const config = await readConfig();
  const tasks = normalizeTasks(config);
  const task = tasks.find((item) => item.id === id);
  if (!task) throw new Error("Task not found.");
  task.enabled = body.enabled !== false;
  config.continuousTasks = tasks;
  await writeConfig(config);
  return { saved: id };
}

async function applyTaskToCategory(body) {
  const id = String(body.id || "").trim();
  if (!id) throw new Error("Invalid task id.");
  const config = await readConfig();
  const tasks = normalizeTasks(config);
  const task = tasks.find((item) => item.id === id);
  if (!task) throw new Error("Task not found.");
  if (!Array.isArray(config.accounts)) config.accounts = [];

  let updated = 0;
  config.accounts = config.accounts.map((row) => {
    const normalizedRow = {
      ...row,
      category: normalizeCategory(row.category),
      proxyId: normalizeProxyId(row.proxyId),
    };
    if (normalizedRow.category !== task.category) return row;
    updated += 1;
    return buildTaskRow(normalizedRow, task);
  });

  await writeConfig(config);
  return {
    updated,
    category: task.category,
    taskName: task.name,
  };
}

async function startContinuous() {
  const config = await readConfig();
  config.continuous = {
    ...normalizeContinuousConfig(config),
    enabled: true,
  };
  await writeConfig(config);

  const state = await readAppState();
  state.continuous = {
    ...normalizeContinuousState(state.continuous),
    running: true,
    nextCheckAt: new Date().toISOString(),
  };
  addContinuousLog(state, "Continuous iniciado.");
  await writeAppState(state);
  scheduleContinuousTick(0);
  return { running: true };
}

async function stopContinuous() {
  const config = await readConfig();
  config.continuous = {
    ...normalizeContinuousConfig(config),
    enabled: false,
  };
  await writeConfig(config);

  const state = await readAppState();
  state.continuous = {
    ...normalizeContinuousState(state.continuous),
    running: false,
    nextCheckAt: "",
  };
  addContinuousLog(state, "Continuous pausado.");
  await writeAppState(state);
  return { running: false };
}

async function stopAllProcesses() {
  const launches = await reconcileLaunches(await readState(), await getJavaProcesses());
  const stopped = [];
  for (const launch of launches) {
    if (!isLaunchActive(launch)) continue;
    try {
      await stopProcess(launch.effectivePid || launch.pid);
      stopped.push(launch.effectivePid || launch.pid);
    } catch {
      // Keep trying the remaining processes.
    }
  }
  return { stopped };
}

async function clearStoppedLaunches() {
  const appState = await readAppState();
  const before = appState.launches.length;
  const reconciled = await reconcileLaunches(appState.launches, await getJavaProcesses());
  appState.launches = reconciled.filter(isLaunchActive);
  await writeAppState(appState);
  return { cleared: before - appState.launches.length };
}

async function clearLaunchHistory() {
  const appState = await readAppState();
  const before = appState.launches.length;
  appState.launches = [];
  await writeAppState(appState);
  return { cleared: before };
}

function addContinuousLog(state, message) {
  const continuous = normalizeContinuousState(state.continuous);
  const at = new Date().toISOString();
  const last = continuous.logs.at(-1);
  if (last?.message === message) {
    last.at = at;
    last.count = Number(last.count || 1) + 1;
  } else {
    continuous.logs.push({ at, message, count: 1 });
  }
  continuous.logs = continuous.logs.slice(-50);
  state.continuous = continuous;
}

function taskCooldownKey(taskId, accountIndex) {
  return `${taskId}:${accountIndex}`;
}

function isCoolingDown(state, task, accountIndex, nowMs) {
  const until = state.continuous.cooldowns[taskCooldownKey(task.id, accountIndex)];
  return until && Date.parse(until) > nowMs;
}

function setCooldown(state, task, accountIndex, nowMs) {
  if (task.cooldownMinutes <= 0) return;
  state.continuous.cooldowns[taskCooldownKey(task.id, accountIndex)] = new Date(
    nowMs + task.cooldownMinutes * 60 * 1000,
  ).toISOString();
}

function clearExpiredCooldowns(state, nowMs) {
  for (const [key, value] of Object.entries(state.continuous.cooldowns)) {
    if (!value || Date.parse(value) <= nowMs) {
      delete state.continuous.cooldowns[key];
    }
  }
}

async function runContinuousCheck() {
  const config = await readConfig();
  const continuousConfig = normalizeContinuousConfig(config);
  const appState = await readAppState();
  appState.continuous = normalizeContinuousState(appState.continuous);
  if (!continuousConfig.enabled || !appState.continuous.running) return;

  const now = Date.now();
  appState.continuous.lastCheckAt = new Date(now).toISOString();
  clearExpiredCooldowns(appState, now);

  const accounts = await readAccounts();
  const rows = normalizeConfigAccounts(config, accounts);
  const proxies = normalizeProxies(config);
  const tasks = normalizeTasks(config).filter((task) => task.enabled);
  const alive = await reconcileLaunches(appState.launches, await getJavaProcesses());
  await processLaunchNotifications({ config, appState, rows, tasks, reconciled: alive });
  appState.launches = alive;

  if (!tasks.length) {
    addContinuousLog(appState, "Nenhuma task ativa.");
  }

  for (const task of tasks) {
    const runningForTask = alive.filter((launch) => launch.taskId === task.id && isLaunchActive(launch)).length;
    if (runningForTask >= task.maxInstances) {
      addContinuousLog(appState, `${task.name}: max instâncias atingido (${runningForTask}/${task.maxInstances}).`);
      continue;
    }

    if (task.proxyMode === "task") {
      const proxy = proxies.find((item) => item.id === task.proxyId);
      if (!proxy || !proxy.enabled) {
        addContinuousLog(appState, `${task.name}: proxy da task inativo ou ausente.`);
        continue;
      }
    }

    const candidates = rows.filter((row) => row.enabled && row.category === task.category);
    const runningIndexes = new Set(alive.filter(isLaunchActive).map((launch) => Number(launch.index)));
    let availableSlots = task.maxInstances - runningForTask;

    for (const row of candidates) {
      if (availableSlots <= 0) break;
      if (runningIndexes.has(row.index)) {
        addContinuousLog(appState, `${task.name}: conta ${row.index} pulada, já está rodando.`);
        continue;
      }
      if (isCoolingDown(appState, task, row.index, now)) {
        addContinuousLog(appState, `${task.name}: conta ${row.index} pulada, cooldown ativo.`);
        continue;
      }

      addContinuousLog(appState, `${task.name}: lançando conta ${row.index}.`);
      await writeAppState(appState);
      await launchAccount(row.index, {
        rowOverride: buildTaskRow(row, task),
        taskId: task.id,
        taskName: task.name,
      });
      const latestState = await readAppState();
      appState.launches = latestState.launches;
      setCooldown(appState, task, row.index, Date.now());
      runningIndexes.add(row.index);
      availableSlots -= 1;

      if (availableSlots > 0 && task.launchDelaySeconds > 0) {
        addContinuousLog(appState, `${task.name}: aguardando ${task.launchDelaySeconds}s para o próximo launch.`);
        await writeAppState(appState);
        await sleep(task.launchDelaySeconds * 1000);
      }
    }
  }

  const nextCheckAt = new Date(Date.now() + continuousConfig.checkIntervalSeconds * 1000).toISOString();
  appState.continuous.nextCheckAt = nextCheckAt;
  await writeAppState(appState);
}

let continuousTimer = null;
let continuousCheckRunning = false;

function scheduleContinuousTick(delayMs = 5000) {
  if (continuousTimer) clearTimeout(continuousTimer);
  continuousTimer = setTimeout(async () => {
    if (!continuousCheckRunning) {
      continuousCheckRunning = true;
      try {
        await runContinuousCheck();
      } catch (error) {
        const config = await readConfig();
        const continuous = normalizeContinuousConfig(config);
        const state = await readAppState();
        state.continuous = normalizeContinuousState(state.continuous);
        state.continuous.nextCheckAt = new Date(Date.now() + continuous.checkIntervalSeconds * 1000).toISOString();
        addContinuousLog(state, `Erro no continuous: ${error.message || String(error)}`);
        await writeAppState(state);
      } finally {
        continuousCheckRunning = false;
      }
    }

    const config = await readConfig();
    const state = await readAppState();
    const continuous = normalizeContinuousConfig(config);
    const stateContinuous = normalizeContinuousState(state.continuous);
    if (continuous.enabled && stateContinuous.running) {
      const nextAt = Date.parse(stateContinuous.nextCheckAt);
      const waitMs = Number.isFinite(nextAt) ? Math.max(1000, nextAt - Date.now()) : continuous.checkIntervalSeconds * 1000;
      scheduleContinuousTick(waitMs);
    }
  }, delayMs);
  continuousTimer.unref?.();
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
await mkdir(dataDir, { recursive: true });
await mkdir(logsDir, { recursive: true });
await open(statePath, "a").then((handle) => handle.close());

const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://${req.headers.host}`);

    if (url.pathname === "/api/state" && req.method === "GET") {
      json(res, 200, await getSnapshot());
      return;
    }

    if (url.pathname === "/api/shutdown" && req.method === "POST") {
      json(res, 200, { shuttingDown: true });
      setTimeout(() => {
        server.close(() => process.exit(0));
        setTimeout(() => process.exit(0), 1500).unref?.();
      }, 250).unref?.();
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

    if (url.pathname === "/api/accounts/export" && req.method === "POST") {
      json(res, 200, await exportAccountsTxt(await parseBody(req)));
      return;
    }

    if (url.pathname === "/api/account/delete" && req.method === "POST") {
      json(res, 200, await deleteAccount(await parseBody(req)));
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

    if (url.pathname === "/api/category" && req.method === "POST") {
      json(res, 200, await addCategory(await parseBody(req)));
      return;
    }

    if (url.pathname === "/api/category/delete" && req.method === "POST") {
      json(res, 200, await deleteCategory(await parseBody(req)));
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

    if (url.pathname === "/api/continuous/settings" && req.method === "POST") {
      json(res, 200, await saveContinuousSettings(await parseBody(req)));
      return;
    }

    if (url.pathname === "/api/continuous/task" && req.method === "POST") {
      json(res, 200, await saveContinuousTask(await parseBody(req)));
      return;
    }

    if (url.pathname === "/api/continuous/task/enabled" && req.method === "POST") {
      json(res, 200, await setTaskEnabled(await parseBody(req)));
      return;
    }

    if (url.pathname === "/api/continuous/task/apply" && req.method === "POST") {
      json(res, 200, await applyTaskToCategory(await parseBody(req)));
      return;
    }

    if (url.pathname === "/api/continuous/task/delete" && req.method === "POST") {
      json(res, 200, await deleteContinuousTask(await parseBody(req)));
      return;
    }

    if (url.pathname === "/api/continuous/start" && req.method === "POST") {
      json(res, 200, await startContinuous());
      return;
    }

    if (url.pathname === "/api/continuous/stop" && req.method === "POST") {
      json(res, 200, await stopContinuous());
      return;
    }

    if (url.pathname === "/api/stop-all" && req.method === "POST") {
      json(res, 200, await stopAllProcesses());
      return;
    }

    if (url.pathname === "/api/launches/clear-stopped" && req.method === "POST") {
      json(res, 200, await clearStoppedLaunches());
      return;
    }

    if (url.pathname === "/api/launches/clear" && req.method === "POST") {
      json(res, 200, await clearLaunchHistory());
      return;
    }

    if (url.pathname === "/api/launch/log" && req.method === "POST") {
      json(res, 200, await getLaunchLog(await parseBody(req)));
      return;
    }

    if (url.pathname === "/api/hiscores" && req.method === "POST") {
      json(res, 200, await getHiscores(await parseBody(req)));
      return;
    }

    if (url.pathname === "/api/checker/check" && req.method === "POST") {
      json(res, 200, await checkAccountHiscores(await parseBody(req)));
      return;
    }

    if (url.pathname === "/api/checker/log" && req.method === "GET") {
      json(res, 200, await getCheckerLog());
      return;
    }

    if (url.pathname === "/api/checker/log" && req.method === "POST") {
      json(res, 200, await addCheckerLog(await parseBody(req)));
      return;
    }

    if (url.pathname === "/api/checker/log/clear" && req.method === "POST") {
      json(res, 200, await clearCheckerLog());
      return;
    }

    if (url.pathname === "/api/checker/stop" && req.method === "POST") {
      json(res, 200, await stopCheckerLaunches(await parseBody(req)));
      return;
    }

    if (url.pathname === "/api/ai/analyze" && req.method === "POST") {
      json(res, 200, await analyzeWithAi(await parseBody(req)));
      return;
    }

    if (url.pathname === "/api/launch" && req.method === "POST") {
      const body = await parseBody(req);
      const config = await readConfig();
      json(res, 200, await launchAccount(Number(body.index), {
        rowOverride: normalizeLaunchOverride(body, config),
        allowDisabled: true,
      }));
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

const bootConfig = await readConfig();
const bootState = await readAppState();
if (normalizeContinuousConfig(bootConfig).enabled && normalizeContinuousState(bootState.continuous).running) {
  scheduleContinuousTick(1000);
}
