#!/usr/bin/env node
/**
 * pi-trail 通用接入安装器 — 让 pi-trail 被 pi 之外的 agent（zcode / Claude Code / Codex）开箱接入。
 *
 * 用法：
 *   node setup.mjs <agent>       # 安装/更新，agent ∈ zcode | claude-code | codex | all
 *   node setup.mjs remove <agent>
 *   node setup.mjs list
 *
 * 原理：
 * 1. 把运行时文件（recorder/agent-core/server/public）复制到稳定位置 ~/.pi/trail/runtime/，
 *    钩子里固定指向该路径 —— 安装源（npx 缓存、git 检出）之后移动或清理都不影响运行；
 *    重新执行 setup 即更新运行时。
 * 2. 无破坏合并各 agent 的配置：只追加/移除带本运行时路径标记的钩子，其余内容原样保留；
 *    首次修改前把原文件备份为 <config>.pi-trail.bak。
 * 3. pi 本身无需 setup（本包就是 pi 插件，`pi install npm:pi-trail` 即可），仅打印指引。
 *
 * 卸载某个 agent：node setup.mjs remove <agent>（数据与 runtime 保留）。
 */
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const SRC = dirname(fileURLToPath(import.meta.url));
const HOME = homedir();
const RUNTIME_DIR = process.env.PI_TRAIL_RUNTIME_DIR || join(HOME, ".pi", "trail", "runtime");
const RECORDER = join(RUNTIME_DIR, "recorder.mjs").replace(/\\/g, "/");

const RUNTIME_FILES = ["recorder.mjs", "agent-core.mjs", "server.mjs", "LICENSE", "README.md"];
const RUNTIME_DIRS = ["public"];

// ---------- 通用工具 ----------

const log = (msg) => console.log(`[pi-trail] ${msg}`);
const warn = (msg) => console.warn(`[pi-trail] ${msg}`);

function readJsonIfExists(p) {
  try {
    if (!existsSync(p)) return null;
    return JSON.parse(readFileSync(p, "utf8"));
  } catch (e) {
    throw new Error(`${p} 不是合法 JSON（${e.message}）；请手工检查后再试`);
  }
}

function writeJson(p, obj) {
  mkdirSync(dirname(p), { recursive: true });
  if (existsSync(p) && !existsSync(p + ".pi-trail.bak")) {
    copyFileSync(p, p + ".pi-trail.bak"); // 首次修改前备份原文件
  }
  writeFileSync(p, JSON.stringify(obj, null, 2) + "\n", "utf8");
}

function stageRuntime() {
  mkdirSync(RUNTIME_DIR, { recursive: true });
  for (const f of RUNTIME_FILES) {
    const src = join(SRC, f);
    if (existsSync(src)) copyFileSync(src, join(RUNTIME_DIR, f));
  }
  for (const d of RUNTIME_DIRS) {
    const src = join(SRC, d);
    if (!existsSync(src)) continue;
    const dst = join(RUNTIME_DIR, d);
    rmSync(dst, { recursive: true, force: true });
    mkdirSync(dst, { recursive: true });
    for (const f of readdirSync(src)) {
      if (!statSync(join(src, f)).isFile()) continue;
      copyFileSync(join(src, f), join(dst, f));
    }
  }
  if (!existsSync(RECORDER)) throw new Error(`runtime 暂存失败：${RECORDER} 不存在`);
  return RECORDER;
}

// 在 hook 描述（command 字符串或 args 数组）里找我们的运行时标记
const isOurs = (h) => JSON.stringify(h && (h.args || h.command || "")).includes("recorder.mjs");

// ---------- zcode（~/.zcode/cli/config.json，项目级 hooks 会被 zcode 忽略，必须用户级） ----------

function zcodeConfigPath() {
  return join(HOME, ".zcode", "cli", "config.json");
}

function hookGroups(events, name) {
  if (!Array.isArray(events[name])) events[name] = [];
  return events[name];
}

function setupZcode() {
  const p = zcodeConfigPath();
  const cfg = readJsonIfExists(p) || {};
  cfg.hooks = cfg.hooks || {};
  cfg.hooks.enabled = true; // 配置文件钩子默认关闭，必须显式打开
  cfg.hooks.events = cfg.hooks.events || {};

  const up = hookGroups(cfg.hooks.events, "UserPromptSubmit");
  const group = up.find((g) => Array.isArray(g.hooks) && g.hooks.some(isOurs)) || (() => { const g = { hooks: [] }; up.push(g); return g; })();
  group.hooks = group.hooks.filter((h) => !isOurs(h));
  group.hooks.push({ type: "process", command: "node", args: [RECORDER, "--agent", "zcode"], timeoutMs: 10000 });

  const ss = hookGroups(cfg.hooks.events, "SessionStart");
  const ssGroup = ss.find((g) => Array.isArray(g.hooks) && g.hooks.some(isOurs)) || (() => { const g = { matcher: "startup|resume|clear", hooks: [] }; ss.push(g); return g; })();
  ssGroup.hooks = ssGroup.hooks.filter((h) => !isOurs(h));
  ssGroup.hooks.push({ type: "process", command: "node", args: [RECORDER, "--agent", "zcode", "--ensure-server"], timeoutMs: 10000 });

  writeJson(p, cfg);
  log(`zcode：已写入 ${p}`);
  log("zcode：钩子在会话启动时快照 —— 请新建会话生效；桌面内置 agent 若不触发见 README 已知限制。");
}

function removeZcode() {
  const p = zcodeConfigPath();
  const cfg = readJsonIfExists(p);
  if (!cfg?.hooks?.events) return log(`zcode：${p} 中没有钩子，跳过`);
  for (const name of Object.keys(cfg.hooks.events)) {
    cfg.hooks.events[name] = (cfg.hooks.events[name] || [])
      .map((g) => ({ ...g, hooks: (g.hooks || []).filter((h) => !isOurs(h)) }))
      .filter((g) => (g.hooks || []).length > 0);
    if (!cfg.hooks.events[name].length) delete cfg.hooks.events[name];
  }
  if (!Object.keys(cfg.hooks.events).length) delete cfg.hooks.events;
  // 只剩 enabled 开关没有实际钩子时，把整个 hooks 块清掉
  if (!Object.keys(cfg.hooks).filter((k) => k !== "enabled").length) delete cfg.hooks;
  writeJson(p, cfg);
  log(`zcode：已从 ${p} 移除（请新建会话生效）`);
}

// ---------- Claude Code（~/.claude/settings.json） ----------

function claudeConfigPath() {
  return join(HOME, ".claude", "settings.json");
}

function setupClaudeCode() {
  const p = claudeConfigPath();
  const cfg = readJsonIfExists(p) || {};
  cfg.hooks = cfg.hooks || {};
  if (!Array.isArray(cfg.hooks.UserPromptSubmit)) cfg.hooks.UserPromptSubmit = [];
  const groups = cfg.hooks.UserPromptSubmit;
  const group = groups.find((g) => Array.isArray(g.hooks) && g.hooks.some(isOurs)) || (() => { const g = { hooks: [] }; groups.push(g); return g; })();
  group.hooks = group.hooks.filter((h) => !isOurs(h));
  group.hooks.push({ type: "command", command: `node "${RECORDER}" --agent claude-code`, timeout: 10 });
  writeJson(p, cfg);
  log(`claude-code：已合并进 ${p}（现有钩子全部保留，与 Nebula 等并存）`);
}

function removeClaudeCode() {
  const p = claudeConfigPath();
  const cfg = readJsonIfExists(p);
  if (!cfg?.hooks?.UserPromptSubmit) return log(`claude-code：${p} 中没有钩子，跳过`);
  cfg.hooks.UserPromptSubmit = cfg.hooks.UserPromptSubmit
    .map((g) => ({ ...g, hooks: (g.hooks || []).filter((h) => !isOurs(h)) }))
    .filter((g) => (g.hooks || []).length > 0);
  if (!cfg.hooks.UserPromptSubmit.length) delete cfg.hooks.UserPromptSubmit;
  if (!Object.keys(cfg.hooks).length) delete cfg.hooks;
  writeJson(p, cfg);
  log(`claude-code：已从 ${p} 移除`);
}

// ---------- Codex（~/.codex/hooks.json；非托管钩子需在 CLI 里 /hooks 信任一次） ----------

function codexConfigPath() {
  return join(HOME, ".codex", "hooks.json");
}

function setupCodex() {
  const p = codexConfigPath();
  const cfg = readJsonIfExists(p) || {};
  cfg.hooks = cfg.hooks || {};
  if (!Array.isArray(cfg.hooks.UserPromptSubmit)) cfg.hooks.UserPromptSubmit = [];
  const groups = cfg.hooks.UserPromptSubmit;
  const group = groups.find((g) => Array.isArray(g.hooks) && g.hooks.some(isOurs)) || (() => { const g = { hooks: [] }; groups.push(g); return g; })();
  group.hooks = group.hooks.filter((h) => !isOurs(h));
  group.hooks.push({ type: "command", command: `node "${RECORDER}" --agent codex`, async: true, timeout: 10 });
  writeJson(p, cfg);
  log(`codex：已写入 ${p}`);
  log("codex：非托管钩子需要信任 —— 在 codex CLI 里执行 /hooks，审阅并 trust 本钩子后生效。");
}

function removeCodex() {
  const p = codexConfigPath();
  const cfg = readJsonIfExists(p);
  if (!cfg?.hooks?.UserPromptSubmit) return log(`codex：${p} 中没有钩子，跳过`);
  cfg.hooks.UserPromptSubmit = cfg.hooks.UserPromptSubmit
    .map((g) => ({ ...g, hooks: (g.hooks || []).filter((h) => !isOurs(h)) }))
    .filter((g) => (g.hooks || []).length > 0);
  if (!cfg.hooks.UserPromptSubmit.length) delete cfg.hooks.UserPromptSubmit;
  if (!Object.keys(cfg.hooks).length) delete cfg.hooks;
  writeJson(p, cfg);
  log(`codex：已从 ${p} 移除`);
}

// ---------- pi（本身就是 pi 插件，无需 setup） ----------

function setupPi() {
  log("pi：无需 setup —— 本包即 pi 插件：");
  log("  pi install npm:pi-trail");
  log("  # 或从本目录源码安装：pi install " + SRC.replace(/\\/g, "/"));
}

// ---------- 子命令 ----------

const INSTALLERS = { zcode: setupZcode, "claude-code": setupClaudeCode, codex: setupCodex, pi: setupPi };
const REMOVERS = { zcode: removeZcode, "claude-code": removeClaudeCode, codex: removeCodex };

function list() {
  const checks = [
    ["zcode", zcodeConfigPath()],
    ["claude-code", claudeConfigPath()],
    ["codex", codexConfigPath()],
  ];
  log(`runtime：${existsSync(RECORDER) ? "已安装" : "未安装"} → ${RUNTIME_DIR}`);
  for (const [name, p] of checks) {
    let state = "未配置（配置文件不存在）";
    try {
      const cfg = readJsonIfExists(p);
      const flat = JSON.stringify(cfg?.hooks || {});
      state = flat.includes("recorder.mjs") ? "已接入" : cfg ? "已配置文件，未接入 pi-trail" : state;
    } catch (e) {
      state = `配置读取失败：${e.message}`;
    }
    log(`${name.padEnd(12)} ${state}  (${p})`);
  }
  log("pi           本包即 pi 插件，pi install npm:pi-trail 即可");
}

function usage() {
  log("pi-trail 多 agent 接入安装器");
  console.log(`
用法：
  node setup.mjs <agent>          安装/更新（agent = zcode | claude-code | codex | all）
  node setup.mjs remove <agent>   卸载（agent = zcode | claude-code | codex）
  node setup.mjs list             查看各 agent 接入状态

说明：
  - 运行时安装在 ${RUNTIME_DIR}，重新执行 setup 即更新
  - 修改任何配置前都会先备份为 <配置文件>.pi-trail.bak
  - pi 无需 setup：本包即 pi 插件（pi install npm:pi-trail）
  - 数据统一落在 ~/.pi/trail，网页 http://localhost:7799`);
}

function main() {
  const [cmd, agent] = process.argv.slice(2);
  if (!cmd || cmd === "-h" || cmd === "--help" || cmd === "help") return usage();

  if (cmd === "list") return list();

  if (cmd === "remove") {
    const fn = REMOVERS[agent];
    if (!fn) return warn(`未知 agent：${agent}（可选：${Object.keys(REMOVERS).join(" | ")}）`);
    return fn();
  }

  const targets = cmd === "all" ? ["zcode", "claude-code", "codex"] : [cmd];
  for (const t of targets) {
    const fn = INSTALLERS[t];
    if (!fn) return warn(`未知 agent：${t}（可选：${Object.keys(INSTALLERS).join(" | ")} | all）`);
    if (t !== "pi") stageRuntime();
    fn();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}

export { stageRuntime };
