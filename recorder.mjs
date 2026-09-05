#!/usr/bin/env node
/**
 * pi-trail 通用记录器 — 让任何 agent（zcode / claude-code / …）的 hook 都能记入同一条轨迹。
 *
 * 用法（由 agent 的 UserPromptSubmit 之类 hook 调用，事件 JSON 走 stdin）：
 *   node recorder.mjs --agent zcode
 *   echo '{"prompt":"你好","cwd":"/dev/acme","session_id":"s1"}' | node recorder.mjs --agent zcode
 *   node recorder.mjs --agent zcode --text "手动记录一条"
 *   node recorder.mjs --ensure-server   # 只拉起查看服务，不记录
 *
 * 行为：
 * - stdin 解析失败视为无输入，安静退出（hook 协议要求 stdout 干净）
 * - 过滤规则与 pi 扩展一致：空输入不记；斜杠命令按 classifyInput 归类
 * - 记录路径：POST /api/record（服务负责构建条目）；服务不可达则拉起后重试；
 *   仍失败则本地直写 entries.jsonl 兜底，绝不丢记录
 * - 任何失败都静默退出 0，绝不影响宿主 agent
 */
import {
  appendEntryDirect,
  buildEntry,
  classifyInput,
  defaultStoreDir,
  ensureServer,
  resolvePort,
} from "./agent-core.mjs";

function argOf(flag) {
  const i = process.argv.indexOf(flag);
  return i > -1 ? process.argv[i + 1] : undefined;
}

const DEBUG = process.env.PI_TRAIL_DEBUG === "1";
const debug = (msg) => {
  if (DEBUG) process.stderr.write(`[pi-trail] ${msg}\n`);
};

function readStdin() {
  // 事件式读取；Windows 上对 stdin 用 for-await + process.exit 会触发 libuv 断言崩溃
  return new Promise((resolve) => {
    if (process.stdin.isTTY) return resolve("");
    let raw = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (c) => (raw += c));
    process.stdin.on("end", () => resolve(raw.trim()));
    process.stdin.on("error", () => resolve(raw.trim()));
  });
}

async function postRecord(port, payload) {
  const res = await fetch(`http://127.0.0.1:${port}/api/record`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(5000),
  });
  return res.ok ? res.json() : null;
}

async function main() {
  const agent = argOf("--agent") || process.env.PI_TRAIL_AGENT || undefined;
  const storeDir = argOf("--store") || defaultStoreDir();
  const port = Number(argOf("--port")) || resolvePort();
  const manualText = argOf("--text");
  const ensureOnly = process.argv.includes("--ensure-server");

  let text = manualText;
  let cwd = process.cwd();
  let sessionId;
  let sessionName;

  // 始终排干 stdin（hook 协议总会写入事件 JSON）；ensure-server 模式读后即弃
  const raw = await readStdin();

  if (!ensureOnly) {
    if (raw) {
      try {
        const input = JSON.parse(raw);
        text = text ?? input.prompt ?? input.text ?? "";
        cwd = input.cwd || cwd;
        sessionId = input.session_id || input.sessionId || undefined;
        sessionName = input.session_name || input.sessionName || undefined;
      } catch {
        debug("stdin 不是 JSON，忽略");
        return;
      }
    }
  }

  if (!ensureOnly) {
    const t = String(text || "").trim();
    const cls = classifyInput(t, agent);
    if (!cls.record) {
      debug(cls.kind === "input" && t ? "斜杠命令/空输入，跳过" : "空输入，跳过");
      return;
    }

    const payload = {
      text: t,
      cwd,
      sessionId,
      sessionName,
      agent,
      source: "hook",
      kind: cls.kind,
    };

    // 先尝试现有服务；不在则拉起再试；都不行就直写兜底
    let ok = false;
    try {
      const r = await postRecord(port, payload);
      ok = !!(r && r.ok);
      if (r && r.skipped) {
        debug(`服务端跳过：${r.skipped}`);
        return;
      }
    } catch {
      /* 服务未响应 */
    }
    if (!ok) {
      debug("服务不可达，尝试拉起…");
      try {
        await ensureServer({ port, storeDir });
        const r = await postRecord(port, payload);
        ok = !!(r && r.ok);
      } catch {
        /* 拉起失败，走直写 */
      }
    }
    if (!ok) {
      const entry = buildEntry(payload);
      ok = appendEntryDirect(entry, storeDir);
      debug(ok ? "已直写兜底" : "直写也失败，本条丢失");
    } else {
      debug("已记录");
    }
    return;
  }

  await ensureServer({ port, storeDir });
}

main().catch((e) => {
  debug(`失败：${(e && e.message) || e}`);
  // hook 场景绝不报错：不调用 process.exit（Windows 上会触发 libuv 断言），让进程自然退出
});
