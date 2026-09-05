/**
 * agent-core — pi-trail 跨 agent 共享核心（零依赖，Node >= 18）
 *
 * 被 server.mjs（HTTP 记录端点）与 recorder.mjs（各 agent 的 hook 记录器）共用：
 * - 条目构建（id / 机器标识 / 斜杠命令过滤），agent 字段区分来源（pi / zcode / claude-code / …）
 * - 查看服务守护（ping → 拉起 → 兜底清僵尸）
 *
 * 数据落盘约定不变：~/.pi/trail/entries.jsonl（目录名是历史沿革，多 agent 共用同一仓库）。
 */
import { appendFileSync, existsSync, mkdirSync, openSync, readFileSync, writeFileSync } from "node:fs";
import { homedir, hostname } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync, spawn } from "node:child_process";

const CORE_DIR = dirname(fileURLToPath(import.meta.url));

export const DEFAULT_PORT = 7799;

export function resolvePort() {
  if (Number(process.env.PI_TRAIL_PORT || process.env.PI_INPUT_LOG_PORT))
    return Number(process.env.PI_TRAIL_PORT || process.env.PI_INPUT_LOG_PORT);
  return DEFAULT_PORT;
}

export function defaultStoreDir() {
  return process.env.PI_TRAIL_STORE || join(homedir(), ".pi", "trail");
}

// ---------- 机器标识（与扩展写入端同一套：GUID 优先，主机名兜底） ----------

export function getMachineId() {
  try {
    if (process.platform === "win32") {
      const out = execFileSync(
        "reg",
        ["query", "HKLM\\SOFTWARE\\Microsoft\\Cryptography", "/v", "MachineGuid"],
        { encoding: "utf8", windowsHide: true },
      );
      const m = out.match(/MachineGuid\s+REG_SZ\s+(\S+)/);
      if (m) return m[1].trim();
    } else if (process.platform === "darwin") {
      const out = execFileSync("ioreg", ["-rd1", "-c", "IOPlatformExpertDevice"], { encoding: "utf8" });
      const m = out.match(/"IOPlatformUUID"\s*=\s*"([^"]+)"/);
      if (m) return m[1].trim();
    } else {
      for (const p of ["/etc/machine-id", "/var/lib/dbus/machine-id"]) {
        try {
          const id = readFileSync(p, "utf8").trim();
          if (id) return id;
        } catch {
          /* 尝试下一个 */
        }
      }
    }
  } catch {
    /* 兜底走主机名 */
  }
  return hostname();
}

const MACHINE_ID = getMachineId();
const MACHINE_TAG = MACHINE_ID.replace(/-/g, "").slice(0, 6);
let seq = 0;

// ---------- 输入归类 ----------
// pi 语义（与扩展一致）：/skill: 记为 skill；其他斜杠命令跳过。
// 其他 agent 语义：斜杠命令多为 skill 调用（/code-review 等），记为 skill；
// 但常见内置命令（/clear /compact…）不是工作轨迹，跳过。

const BUILTIN_SLASH = new Set([
  "help", "clear", "compact", "model", "status", "cost", "usage", "context", "doctor",
  "init", "login", "logout", "config", "settings", "mcp", "memory", "resume", "export",
  "exit", "quit", "upgrade", "update", "release-notes", "bug", "vim", "terminal-setup",
  "permissions", "hooks", "ide", "todos", "output-style", "privacy-settings", "plugins",
  "skills", "agents", "add-dir", "bashes", "listen", "plan",
]);

// 返回 { record: boolean, kind: "input"|"skill" }
export function classifyInput(text, agent) {
  const t = text.trim();
  if (!t) return { record: false, kind: "input" };
  const isPiStyleSkill = /^\/skill:/i.test(t);
  if (t.startsWith("/")) {
    if (isPiStyleSkill) return { record: true, kind: "skill" };
    if (!agent || agent === "pi") return { record: false, kind: "input" }; // pi：斜杠命令不记
    const name = t.slice(1).split(/\s+/)[0].toLowerCase();
    if (BUILTIN_SLASH.has(name)) return { record: false, kind: "input" };
    return { record: true, kind: "skill" };
  }
  return { record: true, kind: "input" };
}

let seqFor = () => seq++;
export function buildEntry({ text, cwd, sessionId, sessionName, agent, source, kind, ts }) {
  return {
    id: `${MACHINE_TAG}-${Date.now().toString(36)}-${process.pid.toString(36)}-${seqFor().toString(36)}`,
    ts: ts || Date.now(),
    host: hostname(),
    machineId: MACHINE_ID,
    cwd: cwd || "",
    sessionId: sessionId || undefined,
    sessionName: sessionName || undefined,
    agent: agent || undefined,
    source: source || "hook",
    kind: kind || "input",
    text,
  };
}

// ---------- 查看服务守护（扩展里同一套逻辑的共享版） ----------

export async function pingServer(port) {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/api/ping`, { signal: AbortSignal.timeout(1500) });
    return res.ok;
  } catch {
    return false;
  }
}

export function spawnServer(opts = {}) {
  const storeDir = opts.storeDir || defaultStoreDir();
  const port = opts.port || resolvePort();
  const serverScript = join(CORE_DIR, "server.mjs");
  mkdirSync(storeDir, { recursive: true });
  const log = openSync(join(storeDir, "server.log"), "a");
  const child = spawn(process.execPath, [serverScript, "--port", String(port)], {
    detached: true,
    stdio: ["ignore", log, log],
    windowsHide: true,
    env: { ...process.env, PI_TRAIL_STORE: storeDir }, // 子服务必须与调用方使用同一数据目录
  });
  child.unref();
  try {
    appendFileSync(join(storeDir, "server.pid"), String(child.pid));
  } catch {
    /* pid 登记失败不影响运行 */
  }
}

export function killStaleByPidFile(storeDir) {
  const dir = storeDir || defaultStoreDir();
  try {
    const pid = Number(readFileSync(join(dir, "server.pid"), "utf8").trim());
    if (!pid || !Number.isFinite(pid)) return;
    process.kill(pid);
  } catch {
    /* 进程已不在或无权限 */
  }
  try {
    writeFileSync(join(dir, "server.pid"), "");
  } catch {
    /* ignore */
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// 冷启动轮询：Windows 下 spawn + 模块加载偶发超过 2s，固定等待会误判失败
async function waitPing(port, tries, intervalMs) {
  for (let i = 0; i < tries; i++) {
    await sleep(intervalMs);
    if (await pingServer(port)) return true;
  }
  return false;
}

let ensuring = false;
export async function ensureServer(opts = {}) {
  const port = opts.port || resolvePort();
  if (ensuring) return pingServer(port);
  ensuring = true;
  try {
    if (await pingServer(port)) return true;
    spawnServer(opts);
    if (await waitPing(port, 8, 500)) return true;
    killStaleByPidFile(opts.storeDir);
    await sleep(500);
    spawnServer(opts);
    return waitPing(port, 8, 500);
  } finally {
    ensuring = false;
  }
}

// ---------- 兜底直写（服务起不来时也不丢记录） ----------

export function appendEntryDirect(entry, storeDir) {
  const dir = storeDir || defaultStoreDir();
  try {
    mkdirSync(dir, { recursive: true });
    appendFileSync(join(dir, "entries.jsonl"), JSON.stringify(entry) + "\n", "utf8");
    return true;
  } catch {
    return false;
  }
}

export function entryExists(id, storeDir) {
  try {
    const p = join(storeDir || defaultStoreDir(), "entries.jsonl");
    if (!existsSync(p)) return false;
    const text = readFileSync(p, "utf8");
    return text.includes(`"${id}"`);
  } catch {
    return false;
  }
}
