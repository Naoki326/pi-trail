# pi trail

**Your AI work journal — written by itself.**
**自动记录的 AI 工作轨迹。**

[![npm version](https://img.shields.io/npm/v/pi-trail.svg)](https://www.npmjs.com/package/pi-trail)
[![license](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![node](https://img.shields.io/badge/node-%3E%3D18-green.svg)]()

pi trail is a [pi](https://github.com/earendil-works/pi-coding-agent) package that quietly records **every input you type** into the AI coding assistant — and only yours: subagent briefs, API calls and extension-injected messages are filtered out. Everything lands in a local git repo and is served to a beautiful web UI where your work history organizes itself into conversations, projects, memos and reminders. An optional AI analysis reads your trail and tells you where each project actually stands.

![conversations view](https://raw.githubusercontent.com/Naoki326/pi-trail/main/docs/screenshot-conversations.png)

## Why

You talk to your coding agent dozens of times a day across many projects — then wonder *"what was I doing last week?"* and *"where did that project stop?"* pi trail answers that, automatically, without you writing a single line of a journal.

## Features

- 📝 **Captures your inputs only** — typed in TUI or pi-web. Skill invocations (`/skill:name`) are recorded as one line, never the expanded prompt body. Subagent sessions (in-memory or persisted with `type#hash` names) and extension-injected messages are excluded on both write and read paths.
- 🧭 **Five timeline views** — 💬 *Conversations* (flat, titled by session name or first input), 📅 *By day*, 🌲 *Tree* (machine → project → conversation), 🐟 *Fishbone* (spine = the day, bones = conversations, colored by project), 📊 *Analysis*.
- 🖥 **Multi-machine aware** — every entry carries a machine GUID + hostname; machines with duplicate hostnames never collide.
- 🔁 **Git-backed, multi-host sync** — data lives in its own git repo (`~/.pi/trail`). Point it at any remote and multiple machines append, rebase onto each other and push automatically. Append-only JSONL + `merge=union` means concurrent appends never conflict.
- 📌 **Memos & reminders** — pin any input as a memo, set due-date reminders; annotations are append-only events, so they sync safely too.
- 🤖 **AI project analysis** — one click per project: an LLM reads the project's full input history and reports its current stage, ongoing work, timeline and likely next steps. Strictly manual — no hidden API calls. Uses your existing OpenRouter key from pi's `auth.json`.
- 🛡 **Local-first** — no telemetry, no cloud. The web UI binds to your LAN (configurable), data never leaves your machine unless *you* configure a git remote.
- 🔌 **Zero-config server** — the extension auto-spawns and supervises a dependency-free Node server. It self-heals; you never manage a process.

![tree view](https://raw.githubusercontent.com/Naoki326/pi-trail/main/docs/screenshot-tree.png)

## Install

```bash
pi install npm:pi-trail
# or from source
pi install git:github.com/Naoki326/pi-trail
```

Then restart pi (or `/reload`) and open **http://localhost:7799** — your first inputs appear within seconds.

To record history into an existing log (one-time, optional):

> Tip: entries are recorded from install-time forward. A backfill script example lives in the repo wiki/discussions if you want to import past session files.

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
| `source` | `interactive` (TUI) / `rpc` (pi-web) / `backfill` |
| `kind` | `input` or `skill` |

Annotations (memos, reminders, soft-deletes) are append-only events in `meta.jsonl`, replayed by timestamp — safe under union merges.

## Multi-machine sync

Set a remote once — in the web UI (⚙) or `~/.pi/trail/config.json`:

```json
{ "remote": "git@github.com:you/pi-trail-data.git", "branch": "main", "syncIntervalSec": 120, "autoSync": true }
```

Each machine records locally; the server fetches, **rebases local commits onto `origin/main`** and pushes, retrying on races. Unrelated histories from fresh machines are adopted automatically. Auth is your normal git credentials (SSH / credential manager).

## AI analysis

The 📊 view lists every project with its input volume and time range. Press **🤖 分析** — the model (default `stealth/ox-alpha`, changeable in ⚙) receives the project's input history and returns stage / ongoing work / timeline / next steps. Results are cached in `analysis.json` and versioned in the data repo. Analysis only ever runs on your explicit click.

## Configuration

| Env / File | Default | Meaning |
|---|---|---|
| `PI_TRAIL_PORT` | `7799` | Web UI port |
| `PI_TRAIL_STORE` | `~/.pi/trail` | Data directory (also used for demo/testing) |
| `~/.pi/trail/config.json` | — | remote / branch / syncIntervalSec / autoSync / analysisModel |

The UI listens on `0.0.0.0` so phones on your LAN can open it; allow Node through the firewall on first run. There is **no authentication** — treat it as trusted-LAN only.

## Uninstall

```bash
pi remove npm:pi-trail
```

Your data stays in `~/.pi/trail` (a normal git repo) — it's yours.

## 中文简介

**pi trail** 自动记录你在 pi 里亲手输入的每一条指令（TUI / pi-web 均可，子代理与注入消息自动排除），存为本地 git 仓库，并在网页里按 **对话 / 按天 / 树形（电脑→项目→对话）/ 鱼骨图 / AI 项目分析** 五种视图呈现。支持备忘录、到期提醒、多主机 git 同步（互相变基、并集合并）。AI 分析纯手动触发，使用你已有的 OpenRouter key。数据 100% 本地，卸载后数据仍是你的 git 仓库。

## License

[MIT](LICENSE)
