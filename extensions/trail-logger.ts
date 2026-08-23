/**
 * pi-trail 扩展 — 记录用户在 pi 中的所有文本输入（只记输入，不记输出）。
 *
 * 数据落盘：~/.pi/input-log/entries.jsonl（每行：{id, ts, host, cwd, sessionId, source, text}）
 * 查看服务：包根目录 server.mjs（本扩展自动拉起并守护，页面 http://localhost:7799）
 *
 * 规则：
 * - 只记录本人的输入：TUI 手打（interactive）与 pi-web 网页输入（rpc）都算
 * - 记录 skill 调用（/skill:name 原样记录，不展开正文）
 * - 排除：其他斜杠命令；扩展注入（source=extension）；子代理任务简报（parentSession+类型#哈希名，或内存会话）
 * - 跳过空输入；任何记录失败静默忽略，绝不影响正常输入
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { appendFileSync, existsSync, mkdirSync, openSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir, hostname } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync, spawn } from "node:child_process";

const PACKAGE_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SERVER_SCRIPT = join(PACKAGE_ROOT, "server.mjs");
const PORT = Number(process.env.PI_TRAIL_PORT || process.env.PI_INPUT_LOG_PORT || 7799);

const STORE_DIR = join(homedir(), ".pi", "trail");
const LEGACY_STORE_DIR = join(homedir(), ".pi", "input-log");

// 旧版（pi-input-log）数据目录一次性迁移；已迁移/不存在则跳过
try {
  if (existsSync(LEGACY_STORE_DIR) && !existsSync(STORE_DIR)) renameSync(LEGACY_STORE_DIR, STORE_DIR);
} catch { /* 迁移失败不影响记录（写入时 mkdir 兜底） */ }
const ENTRIES_FILE = join(STORE_DIR, "entries.jsonl");
const SERVER_LOG = join(STORE_DIR, "server.log");
const PID_FILE = join(STORE_DIR, "server.pid");

// ---------- 机器标识 ----------
// 主机名会重名、会改；机器 GUID 装机生成、全局唯一、不随改名变化。

function getMachineId(): string {
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
const MACHINE_TAG = MACHINE_ID.replace(/-/g, "").slice(0, 6); // 跨机 ID 防碰撞前缀

// ---------- 查看服务守护 ----------

async function pingServer(): Promise<boolean> {
  try {
    const res = await fetch(`http://127.0.0.1:${PORT}/api/ping`, {
      signal: AbortSignal.timeout(1500),
    });
    return res.ok;
  } catch {
    return false;
  }
}

function spawnServer() {
  mkdirSync(STORE_DIR, { recursive: true });
  const log = openSync(SERVER_LOG, "a");
  const child = spawn(process.execPath, [SERVER_SCRIPT, "--port", String(PORT)], {
    detached: true,
    stdio: ["ignore", log, log],
    windowsHide: true,
  });
  child.unref();
  try {
    appendFileSync(PID_FILE, String(child.pid));
  } catch {
    /* pid 登记失败不影响运行 */
  }
}

function killStaleByPidFile() {
  try {
    const pid = Number(readFileSync(PID_FILE, "utf8").trim());
    if (!pid || !Number.isFinite(pid)) return;
    process.kill(pid); // 不存在会抛错，直接吞掉
  } catch {
    /* 进程已不在或无权限，无需处理 */
  }
  try {
    writeFileSync(PID_FILE, "");
  } catch {
    /* ignore */
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

let ensuring = false;
async function ensureServer() {
  if (ensuring) return;
  ensuring = true;
  try {
    if (await pingServer()) return;
    spawnServer();
    await sleep(2000);
    if (await pingServer()) return;
    // 端口可能被残留僵尸进程占着：清 pid 登记后重拉一次
    killStaleByPidFile();
    await sleep(500);
    spawnServer();
    await sleep(2000);
  } finally {
    ensuring = false;
  }
}

// ---------- 输入记录 ----------

// ---------- 会话信息（标题 / 子代理判别） ----------
// 子代理会话：文件头带 parentSession，且 session_info 名字是「类型#哈希」模式（如 code-reviewer#c03279cc）。
// fork 会话有 parentSession 但没有这种名字；本人会话两者皆无——据此区分。

function readSessionMeta(file: string | undefined): { parent: boolean; name?: string } {
  if (!file) return { parent: false };
  try {
    const text = readFileSync(file, "utf8").slice(0, 65536);
    const lines = text.split("\n").filter((s) => s.trim());
    if (!lines.length) return { parent: false };
    const header = JSON.parse(lines[0]);
    let name: string | undefined;
    for (const line of lines) {
      try {
        const e = JSON.parse(line);
        if (e.type === "session_info" && e.name) name = e.name;
      } catch {
        /* 跳过坏行 */
      }
    }
    return { parent: !!header.parentSession, name };
  } catch {
    return { parent: false };
  }
}

const SUBAGENT_NAME_RE = /^[^#\s]+#[0-9a-f]+$/i;

export default function (pi: ExtensionAPI) {
  let seq = 0;
  let sessionName: string | undefined;
  let sessionChecked = false;
  let sessionIsSubagent = false;

  try {
    mkdirSync(STORE_DIR, { recursive: true });
  } catch {
    /* 后续写入失败会静默忽略 */
  }

  pi.on("session_start", () => {
    void ensureServer(); // 每次会话启动时自愈：在跑就复用，没跑就拉起
  });

  pi.on("session_info_changed", (event) => {
    if (event.name) sessionName = event.name;
  });

  pi.on("input", async (event, ctx) => {
    void ensureServer(); // 兜底：session_start 之后服务挂了也能拉回

    try {
      const text = (event.text ?? "").trim();
      if (!text) return; // 空输入不记
      const isSkill = /^\/skill:/i.test(text);
      if (text.startsWith("/") && !isSkill) return; // 斜杠命令不记，但 skill 调用要记（原始文本，不展开正文）
      if (event.source === "extension") return; // 扩展注入的不是本人输入
      try {
        // 子代理在内存会话中运行（session 不落盘）；本人会话（TUI / pi-web）均为持久会话
        if (ctx.sessionManager?.isPersisted && !ctx.sessionManager.isPersisted()) return;
      } catch {
        /* 判别失败保守记录 */
      }

      // 首次输入时检查所属会话：落盘的子代理会话（parentSession + 名字模式）不记录
      if (!sessionChecked) {
        sessionChecked = true;
        const meta = readSessionMeta(ctx.sessionManager?.getSessionFile?.());
        if (meta.name && !sessionName) sessionName = meta.name;
        if (meta.parent && meta.name && SUBAGENT_NAME_RE.test(meta.name)) sessionIsSubagent = true;
      }
      if (sessionIsSubagent) return; // 子代理任务简报，不是本人输入

      const id = `${MACHINE_TAG}-${Date.now().toString(36)}-${process.pid.toString(36)}-${(seq++).toString(36)}`;
      const line =
        JSON.stringify({
          id,
          ts: Date.now(),
          host: hostname(),
          machineId: MACHINE_ID,
          cwd: ctx.cwd,
          sessionId: ctx.sessionManager?.getSessionId?.() ?? undefined,
          sessionName,
          source: event.source ?? "interactive",
          kind: isSkill ? "skill" : "input",
          text,
        }) + "\n";

      appendFileSync(ENTRIES_FILE, line, "utf8");
    } catch {
      // 记录失败绝不能影响输入
    }
    return { action: "continue" };
  });
}
