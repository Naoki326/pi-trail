# pi trail

[中文](README.md) · [English](README.en.md)

**你的 AI 工作轨迹，自动记录。**
**Your AI work journal — written by itself.**

[![npm version](https://img.shields.io/npm/v/pi-trail.svg)](https://www.npmjs.com/package/pi-trail)
[![license](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![node](https://img.shields.io/badge/node-%3E%3D18-green.svg)]()

pi trail 是一个 [pi](https://github.com/earendil-works/pi-coding-agent) 插件：悄悄记录你**亲手输入**的每一条指令——只记你的，子代理任务简报、API 注入、扩展消息全部自动排除。数据落在本地 git 仓库，网页端把你的工作史自动组织成对话、项目、备忘录和提醒；可选的 AI 分析读取轨迹，告诉你每个项目实际进行到哪了。

它不止支持 pi：通过通用记录器，**zcode、Claude Code 等任何 agent 的输入也能记入同一条轨迹**（见[接入其它 agent](#接入其它-agentzcodecla-code--)），网页里以 ⚡ 徽标区分来源。

![conversations view](https://raw.githubusercontent.com/Naoki326/pi-trail/main/docs/screenshot-conversations.png)

## 为什么需要

你每天和编程助手对话几十次、横跨多个项目，然后总会问自己：*「上周我在干什么？」「那个项目停在哪了？」* pi trail 自动回答这些问题——你不用写一行日志。

## 功能特性

- 📝 **只记录你的输入**——TUI 手打与 pi-web 网页输入都算；skill 调用（`/skill:name`）原样记一行，永不展开正文。子代理会话（内存会话、或 `类型#哈希` 命名的落盘会话）与扩展注入消息在写入端和读取端双重过滤。
- 🧭 **四种轨迹视图**——💬 对话（按会话名或首条输入命名）、📅 按天、🌲 树形（电脑 → 项目 → 对话）、🐟 鱼骨；正文顶部的切换条一键换视图，选择会被记住。
- 🐟 **鱼骨图时间线**——每个项目一根主骨，每场对话一根鱼刺，按时间顺序**等间距**排列（序数刻度：时间关系由鱼刺标签的具体时刻 + 主骨上的日期分界虚线表达，视图默认滚到最右/最新）；每场对话一种稳定颜色，贯穿鱼刺、标签与展开块；刺越粗 / 标签尾数字越大＝输入越多。点击展开：主骨上出现该对话每次输入的小刺（悬停看时间与内容）。可折叠、支持键盘。
- 🖥 **多主机感知**——每条记录带机器 GUID + 主机名，主机重名也绝不混淆。
- 🔁 **git 版本化 + 多机同步**——数据是独立 git 仓库（`~/.pi/trail`）。配置任意远程仓库后，多台机器自动 fetch → 互相变基 → push。追加式 JSONL + `merge=union` 让并发写入永不冲突。
- 📅 **日历：备忘 + 提醒**——月历视图把所有备忘与提醒排在对应的日子上：对话输入可钉为备忘（按输入日落格）、可设到期提醒（按到期日落格，到期红底高亮）；也能**手动添加**与对话无关的备忘/提醒，可关联项目（留空即全局）。格子里只显示缩略条，点开日期在下方看完整内容并操作。提醒支持一键快捷时间（1 小时后 / 今晚 / 明早 / 下周一…）与自定义时间弹窗。
- 🤖 **AI 项目分析**——每项目一次点击：模型读取该项目全部输入历史，输出当前阶段 / 进行中的工作 / 时间线 / 可能的下一步。**纯手动触发**，无隐藏调用。
- 📋 **每日日报**——每个工作日早上自动分析上一个工作日（周一分析上周五）的全部输入，生成 2-3 条简短日报；待确认卡片 + 徽标提醒，错过的日期可一键补齐，结果随数据仓库 git 同步。
- 🧠 **复用 pi 的模型配置**——AI 分析与日报直接使用 pi 的 `models.json`/`auth.json` 模型体系（支持任意 provider，如 `thriking-v1/deepseek-v4-flash`），⚙ 设置里下拉选择，无需手填模型名；每次调用时实时读取 pi 配置，不落盘不拷贝 key。
- 🛡 **本地优先**——无遥测、无云端。网页只绑定你的局域网（可配置），数据不经你配置的 git remote 绝不出你的机器。
- 🔌 **零配置服务**——扩展自动拉起并守护一个零依赖 Node 服务，挂了自动拉回，你永远不用管进程。

![tree view](https://raw.githubusercontent.com/Naoki326/pi-trail/main/docs/screenshot-tree.png)

![fishbone view](https://raw.githubusercontent.com/Naoki326/pi-trail/main/docs/screenshot-fishbone.png)

![calendar view](https://raw.githubusercontent.com/Naoki326/pi-trail/main/docs/screenshot-calendar.png)

## 安装

```bash
pi install npm:pi-trail
# 或从源码
pi install git:github.com/Naoki326/pi-trail
```

重启 pi（或 `/reload`），打开 **http://localhost:7799**——几秒后你的首批输入就会出现。记录从安装时刻开始，不回填历史。

## 接入其它 agent（zcode / Claude Code / Codex / …）

所有 agent 共用同一个轨迹仓库（`~/.pi/trail`）与同一个查看服务；网页里每条输入按来源带 ⚡ 徽标，AI 分析与日报会综合全部 agent 的输入。

### 一键接入

```bash
npx pi-trail setup zcode        # 或 claude-code / codex / all（npm 包方式）
node setup.mjs zcode            # 或从本仓库源码执行
```

安装器做两件事，均可重复执行：

- 把运行时（recorder / 查看服务）复制到稳定位置 **`~/.pi/trail/runtime/`** —— 安装源（npx 缓存、git 检出）之后移动或清理都不影响运行；重跑 setup 即更新运行时；
- **无破坏合并**钩子进对应配置：只追加 pi-trail 自己的钩子，现有内容原样保留；首次修改前自动备份为 `<配置文件>.pi-trail.bak`。

各 agent 的配置位置与生效方式：

| agent | 配置文件 | 生效方式 |
|---|---|---|
| zcode | `~/.zcode/cli/config.json` | **新建会话**（钩子按会话启动时快照；项目级 hooks 会被 zcode 忽略，故写入用户级） |
| Claude Code | `~/.claude/settings.json` | 新建会话；现有钩子全部保留、并存执行 |
| Codex | `~/.codex/hooks.json` | 在 codex CLI 里执行 `/hooks` **信任一次**后生效（非托管钩子必须审查） |

其它命令：

```bash
npx pi-trail list             # 查看各 agent 接入状态
npx pi-trail remove zcode     # 卸载（数据与 runtime 保留）
```

pi 无需 setup —— 本包就是 pi 插件：`pi install npm:pi-trail`。

### 插件方式安装（可选）

本仓库同时打包为 Claude Code / zcode 插件（`.claude-plugin/plugin.json` + `hooks/hooks.json`，两者清单格式互相兼容）：把仓库注册为插件市场源后即可随插件安装、启停，钩子里的 agent 名由 recorder 按运行环境自动识别，无需配置。

### 手动接入（可选）

不想跑安装器，也可以按 [`adapters/`](adapters/) 里的片段手工合并：[zcode](adapters/zcode/hooks.json) / [Claude Code](adapters/claude-code/settings.json) / [Codex](adapters/codex/hooks.json)（`<pi-trail 绝对路径>` 换成你的 runtime 或检出路径）。

任何能执行命令或发 HTTP 请求的 agent 还可以直接调通用记录器：

```bash
# 方式一：通用记录器（stdin 收 hook JSON，字段 prompt / cwd / session_id）
echo '{"prompt":"你好","cwd":"/dev/acme"}' | node /path/to/pi-trail/recorder.mjs --agent myagent

# 方式二：直接 POST 查看服务
curl -X POST http://localhost:7799/api/record \
  -H "Content-Type: application/json" \
  -d '{"text":"你好","cwd":"/dev/acme","agent":"myagent"}'
```

记录器的过滤规则与 pi 一致：空输入不记；斜杠命令记为 skill（`/clear`、`/compact` 等常见内置命令除外）；服务不可达时自动拉起，仍失败则本地直写兜底，绝不影响宿主 agent。

已知限制：zcode 桌面端内置 agent 曾有钩子不触发的反馈（[zai-org/feedback#32](https://github.com/zai-org/feedback/issues/32)，P2 跟进中），CLI 会话不受影响。

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
| `agent` | 来源 agent：`pi` / `zcode` / `claude-code` / …（旧数据无此字段即 pi） |
| `source` | `interactive`（TUI）/ `rpc`（pi-web）/ `hook`（其它 agent 钩子）/ `backfill`（回填） |
| `kind` | `input` 或 `skill` |

标注（备忘、提醒、软删除）与手动添加的备忘/提醒条目，都是 `meta.jsonl` 里的追加式事件，按时间戳重放——union 合并下天然安全。

## 多主机同步

在网页 ⚙ 或 `~/.pi/trail/config.json` 里配置一次远程仓库：

```json
{ "remote": "git@github.com:you/pi-trail-data.git", "branch": "main", "syncIntervalSec": 120, "autoSync": true }
```

每台机器各自记录；服务端定期 fetch → 把本地提交**变基到 `origin/main` 之上** → push，推送竞态自动重试。新机器各自 `git init` 的不相关历史自动接管。认证走你的常规 git 凭证（SSH / credential manager）。

## AI 工作台（🤖 AI tab）

分析与日报放在 **🤖 AI** tab 内，正文顶部的子 tab 切换（📋 日报 / 📊 项目分析），选择会被记住。

![ai workspace](https://raw.githubusercontent.com/Naoki326/pi-trail/main/docs/screenshot-ai.png)

### AI 项目分析

按项目列出输入量与时间范围。点 **🤖 分析**——模型读取该项目输入历史，返回阶段 / 进行中的工作 / 时间线 / 下一步。结果缓存在 `analysis.json` 并随数据仓库版本化。**只有你显式点击才会调用模型。**

### 每日日报

每个工作日自动变成一份简短日报（**2-3 条要点 + 涉及项目 + 待跟进**）：

- **自动生成**：服务常驻时，工作日早上（默认 `08:30`，⚙ 或 `config.json` 的 `reportTime` 可改）自动分析**上一个工作日**（周一分析上周五）的全部输入并生成日报。
- **待确认**：新日报标记为待确认（tab 徽标显示数量），点「✓ 确认」归档；「🔄 重新生成」可随时重跑。
- **补跑**：错过的工作日（电脑没开机等）会在页面顶部提示，点「一键补齐」逐天生成；也可在状态条手动「⚡ 生成昨日日报」。
- **结果**：存在 `reports.json`（`~/.pi/trail/reports.json`）并随数据仓库 git 同步。

### 模型

分析与日报**复用 pi 的模型体系**：模型名格式为 `providerId/modelId`（如 `thriking-v1/deepseek-v4-flash`、`zai-lite/glm-5.3-flash`），⚙ 设置与 AI tab 里均提供下拉选择（自动列出 `~/.pi/agent/models.json` 的全部模型）。每次调用时 server **实时读取** pi 的 `models.json` 与 `auth.json` 解析 baseUrl / API key / 接口格式（认证优先级与 pi 一致：`auth.json` > 环境变量 > `models.json` 内联 key），**不落盘、不拷贝 key**。支持 `openai-completions` / `openai-responses` / `anthropic-messages` 三种接口；无 `/` 的模型名按 OpenRouter 处理（向后兼容）。

## 配置

| 环境变量 / 文件 | 默认值 | 说明 |
|---|---|---|
| `PI_TRAIL_PORT` | `7799` | 网页端口 |
| `PI_TRAIL_STORE` | `~/.pi/trail` | 数据目录（演示/测试可覆盖） |
| `~/.pi/trail/config.json` | — | remote / branch / syncIntervalSec / autoSync / analysisModel / reportModel / reportTime |

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
