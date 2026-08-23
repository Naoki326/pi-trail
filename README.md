# pi trail

[中文](README.md) · [English](README.en.md)

**你的 AI 工作轨迹，自动记录。**
**Your AI work journal — written by itself.**

[![npm version](https://img.shields.io/npm/v/pi-trail.svg)](https://www.npmjs.com/package/pi-trail)
[![license](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![node](https://img.shields.io/badge/node-%3E%3D18-green.svg)]()

pi trail 是一个 [pi](https://github.com/earendil-works/pi-coding-agent) 插件：悄悄记录你**亲手输入**的每一条指令——只记你的，子代理任务简报、API 注入、扩展消息全部自动排除。数据落在本地 git 仓库，网页端把你的工作史自动组织成对话、项目、备忘录和提醒；可选的 AI 分析读取轨迹，告诉你每个项目实际进行到哪了。

![conversations view](https://raw.githubusercontent.com/Naoki326/pi-trail/main/docs/screenshot-conversations.png)

## 为什么需要

你每天和编程助手对话几十次、横跨多个项目，然后总会问自己：*「上周我在干什么？」「那个项目停在哪了？」* pi trail 自动回答这些问题——你不用写一行日志。

## 功能特性

- 📝 **只记录你的输入**——TUI 手打与 pi-web 网页输入都算；skill 调用（`/skill:name`）原样记一行，永不展开正文。子代理会话（内存会话、或 `类型#哈希` 命名的落盘会话）与扩展注入消息在写入端和读取端双重过滤。
- 🧭 **五种轨迹视图**——💬 对话（扁平列表，按会话名或首条输入命名）、📅 按天、🌲 树形（电脑 → 项目 → 对话）、🐟 鱼骨、📊 分析。
- 🐟 **鱼骨图时间线**——每个项目一根主骨，每场对话一根鱼刺，**锚定在对话结束时刻**（收尾在哪，刺就立在哪）；每场对话一种稳定颜色，贯穿鱼刺、标签与展开块；刺越粗 / 标签尾数字越大＝输入越多。点击展开：主骨上出现**小刺标记该对话每次输入的时间点**（悬停看内容），跨度线连回鱼刺根部。可折叠、支持键盘，密集区自动分层防重叠。
- 🖥 **多主机感知**——每条记录带机器 GUID + 主机名，主机重名也绝不混淆。
- 🔁 **git 版本化 + 多机同步**——数据是独立 git 仓库（`~/.pi/trail`）。配置任意远程仓库后，多台机器自动 fetch → 互相变基 → push。追加式 JSONL + `merge=union` 让并发写入永不冲突。
- 📌 **备忘录与提醒**——任意输入可钉为备忘、设到期提醒；标注是追加式事件，同步安全。
- 🤖 **AI 项目分析**——每项目一次点击：模型读取该项目全部输入历史，输出当前阶段 / 进行中的工作 / 时间线 / 可能的下一步。**纯手动触发**，无隐藏调用；复用 pi `auth.json` 里已有的 OpenRouter key。
- 🛡 **本地优先**——无遥测、无云端。网页只绑定你的局域网（可配置），数据不经你配置的 git remote 绝不出你的机器。
- 🔌 **零配置服务**——扩展自动拉起并守护一个零依赖 Node 服务，挂了自动拉回，你永远不用管进程。

![tree view](https://raw.githubusercontent.com/Naoki326/pi-trail/main/docs/screenshot-tree.png)

![fishbone view](https://raw.githubusercontent.com/Naoki326/pi-trail/main/docs/screenshot-fishbone.png)

## 安装

```bash
pi install npm:pi-trail
# 或从源码
pi install git:github.com/Naoki326/pi-trail
```

重启 pi（或 `/reload`），打开 **http://localhost:7799**——几秒后你的首批输入就会出现。记录从安装时刻开始，不回填历史。

## 数据

每条输入一行 JSON，存于 `~/.pi/trail/entries.jsonl`：

```json
{"id":"a1b2c3-mt5jb34h-7d8-7","ts":1787443343000,"host":"Aurora","machineId":"a1b2c3d4-…","cwd":"/dev/acme-api","sessionId":"…","sessionName":"acme-api 重构","source":"rpc","kind":"input","text":"…"}
```

| 字段 | 含义 |
|---|---|
| `id` | 全局唯一，机器前缀防跨机碰撞 |
| `ts` / `host` / `machineId` | 何时、哪台机器 |
| `cwd` / `sessionId` / `sessionName` | 哪个项目、哪场对话 |
| `source` | `interactive`（TUI）/ `rpc`（pi-web）/ `backfill`（回填） |
| `kind` | `input` 或 `skill` |

标注（备忘、提醒、软删除）是 `meta.jsonl` 里的追加式事件，按时间戳重放——union 合并下天然安全。

## 多主机同步

在网页 ⚙ 或 `~/.pi/trail/config.json` 里配置一次远程仓库：

```json
{ "remote": "git@github.com:you/pi-trail-data.git", "branch": "main", "syncIntervalSec": 120, "autoSync": true }
```

每台机器各自记录；服务端定期 fetch → 把本地提交**变基到 `origin/main` 之上** → push，推送竞态自动重试。新机器各自 `git init` 的不相关历史自动接管。认证走你的常规 git 凭证（SSH / credential manager）。

## AI 项目分析

📊 视图按项目列出输入量与时间范围。点 **🤖 分析**——模型（默认 `stealth/ox-alpha`，⚙ 里可换）读取该项目输入历史，返回阶段 / 进行中的工作 / 时间线 / 下一步。结果缓存在 `analysis.json` 并随数据仓库版本化。**只有你显式点击才会调用模型。**

## 配置

| 环境变量 / 文件 | 默认值 | 说明 |
|---|---|---|
| `PI_TRAIL_PORT` | `7799` | 网页端口 |
| `PI_TRAIL_STORE` | `~/.pi/trail` | 数据目录（演示/测试可覆盖） |
| `~/.pi/trail/config.json` | — | remote / branch / syncIntervalSec / autoSync / analysisModel |

服务监听 `0.0.0.0`，局域网内手机可直接访问；首次运行放行防火墙即可。**无鉴权**——仅限可信内网使用。

从预发布版 `~/.pi/input-log` 升级？数据目录会在首次启动时自动迁移。

## 卸载

```bash
pi remove npm:pi-trail
```

数据保留在 `~/.pi/trail`（一个普通 git 仓库）——它是你的。

*(English version: [README.en.md](README.en.md).)*

## License

[MIT](LICENSE)
