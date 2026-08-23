#!/usr/bin/env node
/**
 * pi-trail 本地查看服务（零依赖，Node >= 18）
 *
 * 数据源：~/.pi/input-log/entries.jsonl（由 pi 扩展追加写入）
 * 事件日志：~/.pi/input-log/meta.jsonl（备忘/提醒/删除，追加式事件，多主机 union 合并安全）
 * 配置：~/.pi/input-log/config.json（gitignored；remote 指向远程仓库后自动双向同步）
 *
 * 多主机同步模型：
 * - 两个 JSONL 均为追加式，.gitattributes 声明 merge=union，变基冲突自动并集
 * - 同步 = fetch → rebase origin/main（互相变基）→ push，推送竞态自动重试
 * - meta 事件按 ts 排序重放，union 打乱的行序不影响最终状态
 *
 * 启动：node server.mjs [--port 7799]（正常由扩展自动拉起）
 * 页面：http://localhost:7799
 */
import { createServer } from "node:http";
import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync, readdirSync } from "node:fs";
import { homedir, hostname, networkInterfaces } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { execFile, execFileSync } from "node:child_process";

const __dirname = dirname(fileURLToPath(import.meta.url));
const STORE_DIR = process.env.PI_TRAIL_STORE || join(homedir(), ".pi", "trail");
const LEGACY_STORE_DIR = join(homedir(), ".pi", "input-log");

// 旧版（pi-input-log）数据目录一次性迁移；已迁移/不存在则跳过
try {
  if (existsSync(LEGACY_STORE_DIR) && !existsSync(STORE_DIR)) {
    renameSync(LEGACY_STORE_DIR, STORE_DIR);
    console.log("[pi-trail] 已迁移旧数据目录 ~/.pi/input-log → ~/.pi/trail");
  }
} catch { /* 迁移失败不阻断启动 */ }
const ENTRIES_FILE = join(STORE_DIR, "entries.jsonl");
const META_FILE = join(STORE_DIR, "meta.jsonl");
const OLD_META_FILE = join(STORE_DIR, "meta.json");
const CONFIG_FILE = join(STORE_DIR, "config.json");

const PORT = (() => {
  const i = process.argv.indexOf("--port");
  if (i > -1 && Number(process.argv[i + 1])) return Number(process.argv[i + 1]);
  if (Number(process.env.PI_TRAIL_PORT || process.env.PI_INPUT_LOG_PORT))
    return Number(process.env.PI_TRAIL_PORT || process.env.PI_INPUT_LOG_PORT);
  return 7799;
})();

// ---------- 配置 ----------

const CONFIG_DEFAULTS = { remote: "", branch: "main", syncIntervalSec: 120, autoSync: true, analysisModel: "stealth/ox-alpha" };

function loadConfig() {
  try {
    if (existsSync(CONFIG_FILE)) return { ...CONFIG_DEFAULTS, ...JSON.parse(readFileSync(CONFIG_FILE, "utf8")) };
  } catch (e) {
    console.error("[pi-trail] config.json 解析失败，使用默认配置：", e.message);
  }
  return { ...CONFIG_DEFAULTS };
}

function saveConfig(cfg) {
  writeFileSync(CONFIG_FILE, JSON.stringify(cfg, null, 2), "utf8");
}

// ---------- meta 事件日志 ----------
// 追加式事件日志。union 合并会打乱行序，重放前按事件 ts 排序保证各主机状态一致。

function emptyMeta() {
  return { memos: {}, reminders: {}, deleted: {} };
}

function replayMeta() {
  const meta = emptyMeta();
  const events = [];
  try {
    if (existsSync(META_FILE)) {
      let idx = 0;
      for (const line of readFileSync(META_FILE, "utf8").split("\n")) {
        const s = line.trim();
        if (!s) continue;
        try {
          events.push({ ...JSON.parse(s), _i: idx++ });
        } catch {
          /* 坏行跳过 */
        }
      }
    }
  } catch {
    /* 读失败按空处理 */
  }
  events.sort((a, b) => (a.ts || 0) - (b.ts || 0) || (a._i ?? 0) - (b._i ?? 0));
  for (const ev of events) {
    if (!ev.op || !ev.id) continue;
    if (ev.op === "memo") meta.memos[ev.id] = { done: !!ev.done, ts: ev.ts };
    else if (ev.op === "unmemo") delete meta.memos[ev.id];
    else if (ev.op === "remind") meta.reminders[ev.id] = { due: ev.due, ts: ev.ts };
    else if (ev.op === "unremind") delete meta.reminders[ev.id];
    else if (ev.op === "delete") meta.deleted[ev.id] = ev.ts;
  }
  return meta;
}

function appendEvent(ev) {
  appendFileSync(META_FILE, JSON.stringify(ev) + "\n", "utf8");
}

// 旧版快照式 meta.json 迁移为事件日志
function migrateOldMeta() {
  try {
    if (!existsSync(OLD_META_FILE) || existsSync(META_FILE)) return false;
    const old = JSON.parse(readFileSync(OLD_META_FILE, "utf8") || "{}");
    const evs = [];
    for (const [id, m] of Object.entries(old.memos || {})) evs.push({ op: "memo", id, ts: m.ts || 0, done: !!m.done });
    for (const [id, r] of Object.entries(old.reminders || {})) evs.push({ op: "remind", id, ts: r.ts || 0, due: r.due });
    for (const [id, ts] of Object.entries(old.deleted || {})) evs.push({ op: "delete", id, ts });
    evs.sort((a, b) => a.ts - b.ts);
    if (evs.length) writeFileSync(META_FILE, evs.map((e) => JSON.stringify(e)).join("\n") + "\n", "utf8");
    writeFileSync(OLD_META_FILE + ".migrated", readFileSync(OLD_META_FILE));
    rmSync(OLD_META_FILE);
    console.log(`[pi-trail] meta.json 已迁移为 meta.jsonl（${evs.length} 个事件，快照备份 meta.json.migrated）`);
    return true;
  } catch (e) {
    console.error("[pi-trail] meta.json 迁移失败：", e.message);
    return false;
  }
}

// ---------- entries ----------

// ---------- 会话标题解析与子代理过滤 ----------
// 子代理会话：文件头 parentSession + 名字「类型#哈希」；读取端过滤兑底（旧版扩展/别机写入）

const SESSIONS_DIR = join(homedir(), ".pi", "agent", "sessions");
const SUBAGENT_NAME_RE = /^[^#\s]+#[0-9a-f]+$/i;

let sessionsIndex = null; // sessionId -> session 文件路径
let sessionsIndexedAt = 0;
const sessionMetaCache = new Map();

function indexSessions() {
  const map = new Map();
  try {
    const files = readdirSync(SESSIONS_DIR, { recursive: true, encoding: "utf8" });
    for (const f of files) {
      const m = String(f).match(/_([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/i);
      if (m) map.set(m[1].toLowerCase(), join(SESSIONS_DIR, String(f)));
    }
  } catch {
    /* sessions 目录不存在则空索引 */
  }
  sessionsIndex = map;
  sessionsIndexedAt = Date.now();
}

function sessionMeta(sid) {
  if (!sid) return null;
  const key = sid.toLowerCase();
  if (sessionMetaCache.has(key)) return sessionMetaCache.get(key);
  if (!sessionsIndex || Date.now() - sessionsIndexedAt > 60000) indexSessions();
  const file = sessionsIndex.get(key);
  let meta = { parent: false, subagent: false };
  if (file) {
    try {
      const lines = readFileSync(file, "utf8").slice(0, 65536).split("\n").filter((s) => s.trim());
      const header = lines.length ? JSON.parse(lines[0]) : {};
      let name;
      for (const line of lines) {
        try {
          const e = JSON.parse(line);
          if (e.type === "session_info" && e.name) name = e.name;
        } catch { /* 坏行 */ }
      }
      meta = { parent: !!header.parentSession, name, subagent: !!header.parentSession && !!name && SUBAGENT_NAME_RE.test(name) };
    } catch { /* 读失败按非子代理 */ }
  }
  sessionMetaCache.set(key, meta);
  return meta;
}

function getLocalMachineId() {
  try {
    if (process.platform === "win32") {
      const out = execFileSync("reg", ["query", "HKLM\\SOFTWARE\\Microsoft\\Cryptography", "/v", "MachineGuid"], { encoding: "utf8", windowsHide: true });
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
        } catch { /* 下一个 */ }
      }
    }
  } catch { /* 兜底走主机名 */ }
  return hostname();
}

const LOCAL_MACHINE_ID = getLocalMachineId();

function loadEntries() {
  const meta = replayMeta();
  const out = [];
  try {
    if (!existsSync(ENTRIES_FILE)) return out;
    for (const line of readFileSync(ENTRIES_FILE, "utf8").split("\n")) {
      const s = line.trim();
      if (!s) continue;
      try {
        const e = JSON.parse(s);
        if (e.source === "extension") continue; // 扩展注入不展示；rpc（pi-web）与 interactive（TUI）都是本人输入
        const sm = sessionMeta(e.sessionId);
        if (sm?.subagent) continue; // 子代理会话（parentSession+类型#哈希）不展示
        // 本机会话始终无 session 文件 = 内存子代理（旧版扩展写入的简报）；给新会话 2 分钟落盘宽限，远端机器不适用
        if (e.sessionId && !sm && (!e.machineId || e.machineId === LOCAL_MACHINE_ID) && Date.now() - e.ts > 120000) continue;
        if (!e.sessionName && sm?.name && !sm.subagent) e.sessionName = sm.name; // 历史条目补标题
        if (meta.deleted[e.id]) continue;
        out.push(e);
      } catch {
        /* 跳过坏行 */
      }
    }
  } catch {
    /* 返回已解析部分 */
  }
  out.sort((a, b) => b.ts - a.ts);
  return out;
}

// ---------- git 基础 ----------

const GIT_IDENTITY = ["-c", "user.name=pi-trail", "-c", "user.email=pi-trail@local"];
const GIT_ENV = { ...process.env, GIT_TERMINAL_PROMPT: "0", GIT_EDITOR: "true", GIT_SEQUENCE_EDITOR: "true" };

function gitData(args) {
  return new Promise((resolve) => {
    execFile(
      "git",
      ["-C", STORE_DIR, ...GIT_IDENTITY, ...args],
      { windowsHide: true, env: GIT_ENV },
      (err, stdout, stderr) => resolve({ err, stdout: String(stdout || ""), stderr: String(stderr || "") }),
    );
  });
}

let repoOk = false;
let lastSync = { at: 0, ok: null, error: "" };

const GITIGNORE = "*.log\nserver.pid\nconfig.json\nmeta.json.migrated\n";
const GITATTR = "entries.jsonl merge=union\nmeta.jsonl merge=union\n";

function writeTextIfChanged(p, content) {
  try {
    if (!existsSync(p) || readFileSync(p, "utf8") !== content) {
      writeFileSync(p, content, "utf8");
      return true;
    }
    return false;
  } catch {
    return true;
  }
}

async function detectRepo() {
  const r = await gitData(["rev-parse", "--is-inside-work-tree"]);
  if (r.err || r.stdout.trim() !== "true") {
    const init = await gitData(["init", "-b", "main"]);
    if (init.err) {
      console.log("[pi-trail] git 初始化失败，git 功能停用：", init.stderr.trim());
      repoOk = false;
      return;
    }
  }
  // 支撑文件（幂等更新）：union 合并驱动 + 忽略清单
  writeTextIfChanged(join(STORE_DIR, ".gitignore"), GITIGNORE);
  writeTextIfChanged(join(STORE_DIR, ".gitattributes"), GITATTR);
  try {
    mkdirSync(join(STORE_DIR, ".git", "info"), { recursive: true });
    writeTextIfChanged(join(STORE_DIR, ".git", "info", "attributes"), GITATTR);
  } catch {
    /* ignore */
  }
  const st = await gitData(["status", "--porcelain"]);
  if (!st.err && st.stdout.trim()) {
    await gitData(["add", "-A"]);
    const ci = await gitData(["commit", "-m", "chore: repo scaffolding"]);
    if (ci.err) console.error("[git scaffolding]", ci.stderr.trim());
  }
  repoOk = true;
}

// ---------- 本地提交 ----------

async function commitNow() {
  if (!repoOk) return false;
  const st = await gitData(["status", "--porcelain"]);
  if (st.err || !st.stdout.trim()) return false;
  const count = loadEntries().length;
  const add = await gitData(["add", "-A"]);
  if (add.err) {
    console.error("[git add]", add.stderr.trim());
    return false;
  }
  const ci = await gitData(["commit", "-m", `auto: ${count} entries @ ${new Date().toISOString()}`]);
  if (ci.err) {
    console.error("[git commit]", ci.stderr.trim());
    return false;
  }
  console.log(`[pi-trail] 已提交：${count} 条记录`);
  return true;
}

let commitQueued = false;
let commitRunning = false;
function queueCommit(delayMs = 3000) {
  if (!repoOk || commitQueued) return;
  commitQueued = true;
  setTimeout(async () => {
    commitQueued = false;
    if (commitRunning) return queueCommit(1000);
    commitRunning = true;
    try {
      if (await commitNow()) queueSync();
    } finally {
      commitRunning = false;
    }
  }, delayMs);
}

// ---------- 远程同步（多主机互相变基） ----------

async function ensureRemote(remote) {
  const cur = await gitData(["remote", "get-url", "origin"]);
  if (cur.err) {
    const add = await gitData(["remote", "add", "origin", remote]);
    if (add.err) {
      console.error("[git remote add]", add.stderr.trim());
      return false;
    }
  } else if (cur.stdout.trim() !== remote) {
    const set = await gitData(["remote", "set-url", "origin", remote]);
    if (set.err) {
      console.error("[git remote set-url]", set.stderr.trim());
      return false;
    }
  }
  return true;
}

// 把本地提交变基到 origin/<branch> 之上；数据文件冲突视为异常（union 应自动解决）
async function rebaseOntoOrigin(branch) {
  const originRef = `origin/${branch}`;
  const or = await gitData(["rev-parse", "--verify", originRef]);
  if (or.err) return true; // 远端还没有该分支，无需变基
  const originSha = or.stdout.trim();
  const mb = await gitData(["merge-base", "HEAD", originRef]);
  if (!mb.err && mb.stdout.trim() === originSha) return true; // 已在远端顶端
  const unrelated = mb.err || !mb.stdout.trim();
  let rb = await gitData(unrelated ? ["rebase", "--onto", originRef, "--root"] : ["rebase", originRef]);
  for (let round = 0; round < 4 && rb.err; round++) {
    const st = await gitData(["status", "--porcelain"]);
    const conflicted = st.stdout
      .split("\n")
      .filter((l) => /^(DD|AU|UD|UA|DU|AA|UU)/.test(l))
      .map((l) => l.slice(3).trim());
    if (!conflicted.length) break;
    let abort = false;
    for (const p of conflicted) {
      if (p === "entries.jsonl" || p === "meta.jsonl") {
        abort = true; // union 驱动下不应发生，保守回退等下轮
        break;
      }
      const co = await gitData(["checkout", "--theirs", "--", p]);
      if (co.err) {
        abort = true;
        break;
      }
      await gitData(["add", "--", p]);
    }
    if (abort) {
      await gitData(["rebase", "--abort"]);
      console.error("[git rebase] 数据文件冲突，已回退等待下轮同步");
      return false;
    }
    rb = await gitData(["rebase", "--continue"]);
  }
  if (rb.err) {
    await gitData(["rebase", "--abort"]);
    console.error("[git rebase] 未能在 4 轮内解决冲突，已回退：", rb.stderr.trim().slice(0, 200));
    return false;
  }
  return true;
}

let syncRunning = false;
async function syncNow() {
  const cfg = loadConfig();
  if (!repoOk || !cfg.remote || syncRunning) return;
  syncRunning = true;
  try {
    if (!(await ensureRemote(cfg.remote))) {
      lastSync = { at: Date.now(), ok: false, error: "设置 origin 失败" };
      return;
    }
    // 先提交本地未扫到的变更（扩展刚追加的条目），脏工作区会让 rebase 失败
    await commitNow();
    const fetch = await gitData(["fetch", "origin"]);
    if (fetch.err) {
      lastSync = { at: Date.now(), ok: false, error: fetch.stderr.split("\n").filter(Boolean)[0]?.slice(0, 120) || "fetch 失败" };
      console.error("[git fetch]", fetch.stderr.trim().slice(0, 200));
      return;
    }
    if (!(await rebaseOntoOrigin(cfg.branch))) {
      lastSync = { at: Date.now(), ok: false, error: "变基冲突，已回退" };
      return;
    }
    for (let i = 0; i < 3; i++) {
      const push = await gitData(["push", "origin", `HEAD:refs/heads/${cfg.branch}`]);
      if (!push.err) {
        lastSync = { at: Date.now(), ok: true, error: "" };
        console.log("[pi-trail] 已同步到远程");
        return;
      }
      if (!/non-fast-forward|fetch first|rejected/.test(push.stderr)) {
        const line = push.stderr.split("\n").filter(Boolean).pop() || "push 失败";
        lastSync = { at: Date.now(), ok: false, error: line.slice(0, 120) };
        console.error("[git push]", push.stderr.trim().slice(0, 200));
        return;
      }
      await gitData(["fetch", "origin"]);
      if (!(await rebaseOntoOrigin(cfg.branch))) {
        lastSync = { at: Date.now(), ok: false, error: "推送竞态后变基失败" };
        return;
      }
    }
    lastSync = { at: Date.now(), ok: false, error: "推送重试耗尽（下轮再试）" };
  } finally {
    syncRunning = false;
  }
}

let syncQueued = false;
function queueSync(delayMs = 5000) {
  const cfg = loadConfig();
  if (!cfg.remote || !cfg.autoSync || syncQueued) return;
  syncQueued = true;
  setTimeout(() => {
    syncQueued = false;
    void syncNow();
  }, delayMs);
}

// 兜底提交：扩展直接追加 entries.jsonl 不经过本进程，每 60s 扫一次工作区变更
setInterval(() => {
  if (repoOk) queueCommit(0);
}, 60000);

// 周期兜底同步；间隔每次读取配置，改配置无需重启
(function syncLoop() {
  setTimeout(() => {
    const cfg = loadConfig();
    if (cfg.remote && cfg.autoSync) void syncNow();
    syncLoop();
  }, Math.max(10, loadConfig().syncIntervalSec) * 1000);
})();

// ---------- HTTP ----------

function json(res, code, obj) {
  res.writeHead(code, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
  });
  res.end(JSON.stringify(obj));
}

async function readBody(req) {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
  } catch {
    return {};
  }
}

// ---------- 项目进度分析（AI，手动触发） ----------

const ANALYSIS_FILE = join(STORE_DIR, "analysis.json");

function loadAnalysis() {
  try {
    if (existsSync(ANALYSIS_FILE)) return JSON.parse(readFileSync(ANALYSIS_FILE, "utf8"));
  } catch { /* 损坏则重建 */ }
  return {};
}

function saveAnalysis(a) {
  writeFileSync(ANALYSIS_FILE, JSON.stringify(a, null, 2), "utf8");
}

function openrouterKey() {
  try {
    const auth = JSON.parse(readFileSync(join(homedir(), ".pi", "agent", "auth.json"), "utf8"));
    return auth?.openrouter?.key || "";
  } catch {
    return "";
  }
}

async function runAnalysis(project) {
  const cfg = loadConfig();
  const model = cfg.analysisModel || "stealth/ox-alpha";
  const key = openrouterKey();
  if (!key) throw new Error("未找到 openrouter API key（~/.pi/agent/auth.json）");

  const sorted = [...loadEntries().filter((e) => e.cwd === project)].sort((a, b) => a.ts - b.ts);
  if (!sorted.length) throw new Error("该项目没有输入记录");
  const capped = sorted.slice(-400);
  const fmt = (ts) => {
    const d = new Date(ts);
    return `${d.getMonth() + 1}-${d.getDate()} ${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
  };
  const lines = capped
    .map((e) => {
      const text = e.text.length > 300 ? e.text.slice(0, 300) + "…" : e.text;
      return `[${fmt(e.ts)}]${e.kind === "skill" ? "(skill)" : ""} ${text.replace(/\n/g, " ⏎ ")}`;
    })
    .join("\n");

  const prompt = `以下是一位开发者通过 AI 编程助手（pi）在同一个项目文件夹中的全部历史输入（时间正序）。这些只是用户输入，没有 AI 回复。请据此推断该项目的当前进展。

项目目录：${project}
输入时间范围：${new Date(sorted[0].ts).toLocaleString("zh-CN")} ~ ${new Date(sorted[sorted.length - 1].ts).toLocaleString("zh-CN")}（共 ${sorted.length} 条${sorted.length > 400 ? "，仅提供最近 400 条" : ""}）

历史输入：
${lines}

请输出 markdown（中文），包含以下小节：
## 项目阶段
一句话概括当前阶段（如：需求调研 / 架构设计 / 密集开发 / 联调 / 收尾维护），并给出判断依据。
## 正在进行的工作
从最近的输入推断 3-6 项正在进行或近期完成的工作。
## 时间线摘要
按时间粗略划分 2-4 个阶段，各阶段在做什么。
## 可能的下一步
根据最近输入的走向推测接下来可能做的事；不确定的内容明确标注是推测。`;

  const res = await fetch("https://openrouter.ai/api/v1/chat/completions", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
    body: JSON.stringify({ model, messages: [{ role: "user", content: prompt }], temperature: 0.3 }),
    signal: AbortSignal.timeout(180000),
  });
  if (!res.ok) {
    const t = await res.text().catch(() => "");
    throw new Error(`模型 API ${res.status}：${t.slice(0, 200)}`);
  }
  const data = await res.json();
  const result = data?.choices?.[0]?.message?.content;
  if (!result) throw new Error("模型返回为空");

  const store = loadAnalysis();
  store[project] = { ts: Date.now(), model, inputCount: sorted.length, result };
  saveAnalysis(store);
  queueCommit();
  return store[project];
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  const p = url.pathname;

  try {
    if (req.method === "GET" && (p === "/" || p === "/index.html")) {
      const html = readFileSync(join(__dirname, "public", "index.html"));
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      return res.end(html);
    }

    if (req.method === "GET" && p === "/api/entries") {
      const since = Number(url.searchParams.get("since") || 0);
      const all = loadEntries();
      const items = since ? all.filter((e) => e.ts > since) : all;
      return json(res, 200, { items, latest: all[0]?.ts ?? 0 });
    }

    if (req.method === "GET" && p === "/api/meta") {
      return json(res, 200, replayMeta());
    }

    // 备忘录标记：POST /api/memo { id, memo: true|false, done?: bool }
    if (req.method === "POST" && p === "/api/memo") {
      const b = await readBody(req);
      if (!b.id) return json(res, 400, { error: "id required" });
      if (b.memo === false && !b.done) appendEvent({ op: "unmemo", id: b.id, ts: Date.now() });
      else appendEvent({ op: "memo", id: b.id, ts: Date.now(), done: !!b.done });
      queueCommit();
      return json(res, 200, replayMeta());
    }

    // 提醒设置：POST /api/remind { id, due: epochMs | null }
    if (req.method === "POST" && p === "/api/remind") {
      const b = await readBody(req);
      if (!b.id) return json(res, 400, { error: "id required" });
      if (!b.due) appendEvent({ op: "unremind", id: b.id, ts: Date.now() });
      else appendEvent({ op: "remind", id: b.id, ts: Date.now(), due: Number(b.due) });
      queueCommit();
      return json(res, 200, replayMeta());
    }

    // 删除条目：POST /api/delete { id }
    if (req.method === "POST" && p === "/api/delete") {
      const b = await readBody(req);
      if (!b.id) return json(res, 400, { error: "id required" });
      appendEvent({ op: "delete", id: b.id, ts: Date.now() });
      queueCommit();
      return json(res, 200, replayMeta());
    }

    // 同步配置：GET/POST /api/config
    if (p === "/api/config") {
      if (req.method === "GET") return json(res, 200, { ...loadConfig(), lastSync });
      if (req.method === "POST") {
        const b = await readBody(req);
        const cfg = loadConfig();
        if (typeof b.remote === "string") cfg.remote = b.remote.trim();
        if (b.syncIntervalSec != null) cfg.syncIntervalSec = Math.min(86400, Math.max(10, Number(b.syncIntervalSec) || 120));
        if (b.autoSync != null) cfg.autoSync = !!b.autoSync;
        if (typeof b.branch === "string" && b.branch.trim()) cfg.branch = b.branch.trim();
        if (typeof b.analysisModel === "string" && b.analysisModel.trim()) cfg.analysisModel = b.analysisModel.trim();
        saveConfig(cfg);
        queueSync(1000);
        return json(res, 200, { ...cfg, lastSync });
      }
    }

    // 手动触发同步：POST /api/sync
    if (req.method === "POST" && p === "/api/sync") {
      await syncNow();
      return json(res, 200, lastSync);
    }

    // 项目分析结果：GET /api/analysis
    if (req.method === "GET" && p === "/api/analysis") {
      const cfg = loadConfig();
      return json(res, 200, { model: cfg.analysisModel || "stealth/ox-alpha", results: loadAnalysis() });
    }

    // 触发项目分析（AI，手动）：POST /api/analyze { project }
    if (req.method === "POST" && p === "/api/analyze") {
      const b = await readBody(req);
      if (!b.project) return json(res, 400, { error: "project required" });
      try {
        return json(res, 200, await runAnalysis(b.project));
      } catch (e) {
        return json(res, 500, { error: String((e && e.message) || e) });
      }
    }

    if (req.method === "GET" && p === "/api/ping") {
      return json(res, 200, { ok: true });
    }

    res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
    res.end("Not Found");
  } catch (err) {
    json(res, 500, { error: String((err && err.message) || err) });
  }
});

server.listen(PORT, "0.0.0.0", () => {
  console.log(`[pi-trail] http://localhost:${PORT}`);
  for (const nets of Object.values(networkInterfaces())) {
    for (const n of nets || []) {
      if (n.family === "IPv4" && !n.internal) console.log(`[pi-trail] 内网访问： http://${n.address}:${PORT}`);
    }
  }
  console.log(`[pi-trail] store: ${ENTRIES_FILE}`);
  (async () => {
    await detectRepo();
    if (migrateOldMeta()) queueCommit(0);
    // 配置里没有远程时，清掉残留的 origin 指向
    if (!loadConfig().remote) await gitData(["remote", "remove", "origin"]);
  })();
});
