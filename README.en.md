# pi trail

[中文](README.md) · [English](README.en.md)

**Your AI work journal — written by itself.**

[![npm version](https://img.shields.io/npm/v/pi-trail.svg)](https://www.npmjs.com/package/pi-trail)
[![license](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![node](https://img.shields.io/badge/node-%3E%3D18-green.svg)]()

pi trail is a [pi](https://github.com/earendil-works/pi-coding-agent) package that quietly records **every input you type** into the AI coding assistant — and only yours: subagent briefs, API calls and extension-injected messages are filtered out. Everything lands in a local git repo and is served to a beautiful web UI where your work history organizes itself into conversations, projects, memos and reminders. An optional AI analysis reads your trail and tells you where each project actually stands.

It is not pi-only: through a universal recorder, **inputs from zcode, Claude Code and any other agent flow into the same trail** (see [Other agents](#other-agents-zcodeclaude-code--)), badged with ⚡ in the web UI.

![conversations view](https://raw.githubusercontent.com/Naoki326/pi-trail/main/docs/screenshot-conversations.png)

## Why

You talk to your coding agent dozens of times a day across many projects — then wonder *"what was I doing last week?"* and *"where did that project stop?"* pi trail answers that, automatically, without you writing a single line of a journal.

## Features

- 📝 **Captures your inputs only** — typed in TUI or pi-web. Skill invocations (`/skill:name`) are recorded as one line, never the expanded prompt body. Subagent sessions (in-memory or persisted with `type#hash` names) and extension-injected messages are excluded on both write and read paths.
- 🧭 **Five timeline views** — 💬 *Conversations* (flat, titled by session name or first input), 📅 *By day*, 🌲 *Tree* (machine → project → conversation), 🐟 *Fishbone*, 📊 *Analysis*.
- 🐟 **Fishbone timeline** — one spine per project folder, one bone per conversation, **evenly spaced in chronological order** (ordinal scale: exact times live on each bone's label, day boundaries are drawn as dashed separators, and the view opens scrolled to the newest end); every conversation gets a stable color shared by its bone, label, and expanded panel. Bone thickness and the label suffix encode input count. Click a bone to expand it: small spurs on the spine mark each input of that conversation (hover for time and content). Collapsible and keyboard-accessible.
- 🖥 **Multi-machine aware** — every entry carries a machine GUID + hostname; machines with duplicate hostnames never collide.
- 🔁 **Git-backed, multi-host sync** — data lives in its own git repo (`~/.pi/trail`). Point it at any remote and multiple machines append, rebase onto each other and push automatically. Append-only JSONL + `merge=union` means concurrent appends never conflict.
- 📌 **Memos & reminders** — pin any input as a memo, set due-date reminders; annotations are append-only events, so they sync safely too.
- 🤖 **AI project analysis** — one click per project: an LLM reads the project's full input history and reports its current stage, ongoing work, timeline and likely next steps. Strictly manual — no hidden API calls.
- 📋 **Daily reports** — every workday morning the server auto-analyzes the **previous workday** (Monday covers last Friday) and writes a short 2-3 point daily report; unconfirmed cards with badge reminders, missed days can be backfilled in one click, and results sync with the data repo via git.
- 🧠 **Reuses pi's model stack** — analysis and reports resolve models straight from pi's `models.json`/`auth.json` (any provider, e.g. `thriking-v1/deepseek-v4-flash`); pick from a dropdown in ⚙ or the 🤖 tab instead of typing. Config is read live on every call — nothing is written to disk, no key copies.
- 🛡 **Local-first** — no telemetry, no cloud. The web UI binds to your LAN (configurable), data never leaves your machine unless *you* configure a git remote.
- 🔌 **Zero-config server** — the extension auto-spawns and supervises a dependency-free Node server. It self-heals; you never manage a process.

![tree view](https://raw.githubusercontent.com/Naoki326/pi-trail/main/docs/screenshot-tree.png)

![fishbone view](https://raw.githubusercontent.com/Naoki326/pi-trail/main/docs/screenshot-fishbone.png)

## Install

```bash
pi install npm:pi-trail
# or from source
pi install git:github.com/Naoki326/pi-trail
```

Then restart pi (or `/reload`) and open **http://localhost:7799** — your first inputs appear within seconds. Recording starts at install time; entries are never back-dated.

## Other agents (zcode / Claude Code / …)

All agents share the same trail repo (`~/.pi/trail`) and the same viewer; entries carry an ⚡ badge per source, and AI analysis & daily reports cover every agent together.

### zcode

zcode integrates via [hooks](https://zcode.z.ai/cn/docs/hooks). Merge the `hooks` block from [`adapters/zcode/hooks.json`](adapters/zcode/hooks.json) into your **user-level** `~/.zcode/cli/config.json` (keep `hooks.enabled: true`; project-level hooks are currently ignored by zcode entirely) and point `<pi-trail path>` at your checkout:

```json
"hooks": {
  "enabled": true,
  "events": {
    "UserPromptSubmit": [
      { "hooks": [ { "type": "process", "command": "node",
        "args": ["C:/path/to/pi-trail/recorder.mjs", "--agent", "zcode"], "timeoutMs": 10000 } ] }
    ],
    "SessionStart": [
      { "matcher": "startup|resume|clear",
        "hooks": [ { "type": "process", "command": "node",
        "args": ["C:/path/to/pi-trail/recorder.mjs", "--agent", "zcode", "--ensure-server"], "timeoutMs": 10000 } ] }
    ]
  }
}
```

- Hook config is **snapshotted at session start** — start a new session after editing.
- Known limitation: the desktop's built-in agent was reported not to fire config hooks ([zai-org/feedback#32](https://github.com/zai-org/feedback/issues/32), P2, tracked); CLI sessions are unaffected.

### Claude Code

Merge the `hooks` block from [`adapters/claude-code/settings.json`](adapters/claude-code/settings.json) into `~/.claude/settings.json`:

```json
"hooks": {
  "UserPromptSubmit": [
    { "hooks": [ { "type": "command",
      "command": "node /path/to/pi-trail/recorder.mjs --agent claude-code" } ] }
  ]
}
```

### Any other agent

Anything that can run a command or make an HTTP request can join in:

```bash
# Option 1: the universal recorder (reads hook JSON from stdin: prompt / cwd / session_id)
echo '{"prompt":"hello","cwd":"/dev/acme"}' | node /path/to/pi-trail/recorder.mjs --agent myagent

# Option 2: POST straight to the viewer service
curl -X POST http://localhost:7799/api/record \
  -H "Content-Type: application/json" \
  -d '{"text":"hello","cwd":"/dev/acme","agent":"myagent"}'
```

The recorder applies the same rules as the pi extension: empty input is skipped; slash commands are recorded as skills (except common built-ins like `/clear`, `/compact`); if the service is down it is spawned automatically, and if that fails the recorder falls back to a direct file append — it never breaks the host agent.

## The data

One JSON line per input, in `~/.pi/trail/entries.jsonl`:

```json
{"id":"a1b2c3-mt5jb34h-7d8-7","ts":1787443343000,"host":"Aurora","machineId":"a1b2c3d4-…","cwd":"/dev/acme-api","sessionId":"…","sessionName":"acme-api 重构","source":"rpc","kind":"input","text":"…"}
```

| Field | Meaning |
|---|---|
| `id` | Unique, machine-prefixed (no cross-host collisions) |
| `ts` / `host` / `machineId` | When, which machine |
| `cwd` / `sessionId` / `sessionName` | Which project, which conversation |
| `agent` | Source agent: `pi` / `zcode` / `claude-code` / … (legacy rows without the field are pi) |
| `source` | `interactive` (TUI) / `rpc` (pi-web) / `hook` (other agents) / `backfill` |
| `kind` | `input` or `skill` |

Annotations (memos, reminders, soft-deletes) are append-only events in `meta.jsonl`, replayed by timestamp — safe under union merges.

## Multi-machine sync

Set a remote once — in the web UI (⚙) or `~/.pi/trail/config.json`:

```json
{ "remote": "git@github.com:you/pi-trail-data.git", "branch": "main", "syncIntervalSec": 120, "autoSync": true }
```

Each machine records locally; the server fetches, **rebases local commits onto `origin/main`** and pushes, retrying on races. Unrelated histories from fresh machines are adopted automatically. Auth is your normal git credentials (SSH / credential manager).

## AI workspace (🤖 AI tab)

Analysis and daily reports live together in the **🤖 AI** tab: daily reports on top, project analysis below.

### Project analysis

Every project is listed with its input volume and time range. Press **🤖 分析** — the model reads the project's input history and returns stage / ongoing work / timeline / next steps. Results are cached in `analysis.json` and versioned in the data repo. Analysis only ever runs on your explicit click.

### Daily reports

Every workday turns into a short report automatically (**2-3 key points + involved projects + follow-ups**):

- **Auto-generate** — while the server is running, at `08:30` on workdays (default; changeable via `reportTime` in ⚙ or `config.json`) it analyzes the **previous workday's** inputs (Monday → last Friday) and writes the report.
- **Confirm** — a fresh report is marked *unconfirmed* (tab badge shows the count); press **✓ 确认** to archive it, **🔄 重新生成** to re-run any day.
- **Backfill** — workdays you missed (machine was off, etc.) are listed at the top of the tab; **一键补齐** generates them one by one. You can also press **⚡ 生成昨日日报** manually.
- **Storage** — reports live in `reports.json` (`~/.pi/trail/reports.json`) and are versioned in the data repo.

### Models

Analysis and reports **reuse pi's own model stack**: model names use the `providerId/modelId` form (e.g. `thriking-v1/deepseek-v4-flash`, `zai-lite/glm-5.3-flash`), and both ⚙ and the 🤖 tab provide a **dropdown** listing every model from `~/.pi/agent/models.json` — no manual typing. On each call the server **reads pi's `models.json` / `auth.json` live** to resolve baseUrl / API key / API flavor (auth priority matches pi: `auth.json` > env var > inline `models.json` key) — nothing is written to disk, no key copies. Three API flavors are supported (`openai-completions` / `openai-responses` / `anthropic-messages`); model names without `/` fall back to OpenRouter (backwards compatible).

## Configuration

| Env / File | Default | Meaning |
|---|---|---|
| `PI_TRAIL_PORT` | `7799` | Web UI port |
| `PI_TRAIL_STORE` | `~/.pi/trail` | Data directory (also used for demo/testing) |
| `~/.pi/trail/config.json` | — | remote / branch / syncIntervalSec / autoSync / analysisModel / reportModel / reportTime |

Upgrading from the pre-release `~/.pi/input-log`? The data directory is migrated automatically on first start.

The UI listens on `0.0.0.0` so phones on your LAN can open it; allow Node through the firewall on first run. There is **no authentication** — treat it as trusted-LAN only.

## Uninstall

```bash
pi remove npm:pi-trail
```

Your data stays in `~/.pi/trail` (a normal git repo) — it's yours.

*(中文版见 [README.md](README.md)。)*

## License

[MIT](LICENSE)
