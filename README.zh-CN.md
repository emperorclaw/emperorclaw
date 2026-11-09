<p align="center">
  <img src="public/emperor-claw-os/assets/branding/logo.png" alt="EmperorClaw" height="88" />
</p>

<h3 align="center">为依靠 AI 智能体运转的公司打造的控制中心。</h3>

<p align="center">
  <a href="#快速开始"><strong>快速开始</strong></a> &middot;
  <a href="src/content/docs/v1.1/operator-guide.zh-CN.md"><strong>文档</strong></a> &middot;
  <a href="https://emperorclaw.com/zh/"><strong>官网</strong></a> &middot;
  <a href="https://github.com/emperorclaw/emperorclaw/discussions"><strong>讨论区</strong></a> &middot;
  <a href="CHANGELOG.md"><strong>更新日志</strong></a>
</p>

<p align="center"><a href="README.md">English</a> · <a href="README.zh-CN.md">简体中文</a></p>

<p align="center">
  <a href="https://github.com/emperorclaw/emperorclaw/releases"><img src="https://img.shields.io/github/v/release/emperorclaw/emperorclaw?color=06b6d4" alt="Release" /></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-FSL--1.1--Apache--2.0-blue" alt="License: FSL-1.1-Apache-2.0" /></a>
  <a href="https://github.com/emperorclaw/emperorclaw/stargazers"><img src="https://img.shields.io/github/stars/emperorclaw/emperorclaw?style=flat&color=06b6d4" alt="Stars" /></a>
  <img src="https://img.shields.io/badge/self--hosted-PostgreSQL-336791" alt="基于 PostgreSQL 自托管" />
</p>

<p align="center">
  <a href="https://trendshift.io/repositories/86799?utm_source=trendshift-badge&amp;utm_medium=badge&amp;utm_campaign=badge-trendshift-86799" target="_blank" rel="noopener noreferrer"><img src="https://trendshift.io/api/badge/trendshift/repositories/86799/daily?language=TypeScript" alt="emperorclaw%2Femperorclaw | Trendshift" width="250" height="55"/></a>
</p>

<p align="center">
  <img src="docs/assets/emperorclaw-dashboard.webp" alt="EmperorClaw 仪表盘：正在工作的智能体、带审批的待办收件箱，以及每个智能体的实时状态" width="820" />
</p>

**如果说 Hermes 或 OpenClaw 是员工，那么 EmperorClaw 就是他们办公的地方。**

一个智能体只是一件工具。五个分别负责销售、客服、调研和内容的智能体就是一支团队，而团队需要组织架构、任务看板、共享记忆，还需要有人盯着账单。EmperorClaw 为你的 AI 员工提供这一切：部署在你自己的服务器上，并配有一个用手机就能管理的仪表盘。

<br/>

## EmperorClaw 有何不同

大多数智能体平台给每个智能体同一份提示词和同一个技能目录，也把整个工作空间展示给每一个人。EmperorClaw 把**权限与知识当作可被限定范围（scope）的对象**，并且对人员、对智能体、对平台之外的 AI 工具使用同一套规则。

### 👥 成员可见范围是“作用域”，而不是一个埋在权限里的开关

在 **设置 → 成员 → Access Scope（访问范围）** 里，把任何成员限定到**指定的智能体和指定的客户**。服务器会对该成员可读的一切应用这个范围——智能体、项目、任务、审批、文件、视图、成本、会话——所以被限定的成员即便猜到链接，也打不开其他客户的工作。所有者和管理员永不被限定；空范围什么也不授予（失败即拒绝，不会退化成“全部可见”）。

> **实际效果：** 只给客户或外包人员访问“为他们工作的智能体”的权限。他们登录同一套系统，只看到自己的智能体和本客户的工作，其余一概看不到。

### 🧠 Company Brain 按公司、客户、项目和单个智能体分层

每条知识笔记都带作用域：整个公司、某个客户、某个项目，或**某一个智能体**。智能体开始一轮工作时，Emperor 只解析并注入适用于该智能体、该任务所属客户与项目的笔记。同一套作用域规则也决定它之后能读到什么。

> **与扁平 wiki 的区别：** 技能目录里所有智能体读同一个共享池——要么所有人都能看到所有客户的规则，要么你得把同一份说明复制到十几个文件里手工同步。这里，作用域本身就是检索过滤器：限定到某个智能体的笔记是别人读不到的私有操作手册，同一个智能体对两个客户遵循不同的规则，而没有人需要改提示词。

### 🔌 Company Brain 本身就是一个 MCP 服务器，而不只是被注入的上下文

EmperorClaw 在 `/mcp` 运行一个符合规范的 **MCP 服务器**。Claude Code、Codex、Claude Desktop 以及任何其他 MCP 客户端都能连接——支持 **OAuth 2.1 + PKCE**（登录授权即可，无需复制令牌）或在 **设置 → Access Tokens** 生成的访问令牌——并读取该连接被允许看到的知识、任务、项目、客户、智能体和文件。写入同样遵循这些规则，并且始终可追溯到发起操作的账号或令牌。

> **为什么“支持 MCP”往往没这么多：** 很多工具只是把上下文推送给运行在自己平台内部的智能体。Emperor 还允许外部 AI **查询这家公司**：连上 Claude Desktop 或 Codex，问它某个客户的问题，而不给它其他客户的权限。

```bash
# Claude Code — 令牌在 设置 → Access Tokens 生成
claude mcp add --transport http emperorclaw https://your-emperorclaw-host/mcp \
  --header "Authorization: Bearer $EMPEROR_CLAW_TOKEN"

# Codex CLI / 编辑器扩展
codex mcp add emperorclaw --url https://your-emperorclaw-host/mcp \
  --bearer-token-env-var EMPEROR_CLAW_TOKEN
```

然后问它：*“我们对 Maple & Co 的交付规则是什么？他们的项目还有哪些没完成？”* 不想用令牌？在 Claude Desktop 或 claude.ai 里把 `https://<你的主机>/mcp` 添加为自定义连接器（custom connector），批准 OAuth 登录即可。完整说明：[MCP 端点](src/content/docs/v1.1/mcp.md) · [智能体与 MCP](https://emperorclaw.com/zh/docs/agents-and-mcp/)。

<br/>

|        | 步骤 | 会发生什么 |
| ------ | ---- | ------------ |
| **01** | **介绍你的公司** | 粘贴一个模型 key，说说你们做什么。你的主管智能体会当着你的面写出公司的 Knowledge & Rules（知识与规则）。 |
| **02** | **组建团队** | 挑选现成的员工（团队负责人、SEO、QA、增长、内容、财务、数据……）。Emperor 会安装并连接每个运行时。 |
| **03** | **分配、审批、放手** | 分配任务，或者直接聊天。随时看到每个智能体此刻在做什么，审批关键事项，并给成本设上限。 |

<br/>

## 能力矩阵

下表中每一行都对照过源码。带“去哪里看”的同一份矩阵在 [emperorclaw.com/zh/compare](https://emperorclaw.com/zh/compare/)。

| 能力 | EmperorClaw |
| --- | --- |
| **自托管** | 一套 Docker Compose 加 Postgres——VPS、家用服务器或树莓派。 |
| **许可证** | Fair Source，FSL-1.1-Apache-2.0；两年后转为 Apache 2.0。 |
| **多公司** | 同一套安装里的隔离租户，各有自己的数据、令牌和知识。 |
| **客户** | 每家公司下的客户是一等对象；工作、文件、知识和花费都能限定到一个客户。 |
| **智能体组织架构** | 可视化组织架构：负责人、团队、可嵌套的汇报线；它生成每个智能体的上下文化和升级路径。 |
| **智能体委派** | 分配任务即唤醒负责人；用双人线程提问；交接备注携带状态。 |
| **自主运行** | 任务租约、循环保护、停滞扫描和按智能体的动作策略构成的运行循环。 |
| **定时任务** | 按智能体的 cron 计划；自动化可按需或按计划运行，并在步骤之间设审批闸门。 |
| **任务管理** | 看板（状态间拖拽），带优先级、验收标准、备注和阻塞项。 |
| **人工审批** | 审批请求、动作策略（关闭 / 先问 / 允许），以及自动化内部的审批闸门。 |
| **智能体预算** | 按智能体的月度预算：80% 警告、到限额暂停，外加自动成本刹车。 |
| **成本追踪** | 按运行、智能体、模型、任务、项目和客户，可导出 CSV。 |
| **实时监控** | 每次运行的工具调用时间线、运行台账、心跳和智能体健康视图。 |
| **公司知识** | Company Brain 笔记可限定到公司、客户、项目或单个智能体。 |
| **客户隔离** | 服务端在每次读取时强制：成员或智能体可以被限定到一个客户。 |
| **团队聊天** | 团队频道、群聊、私聊线程、@提及，以及任务和项目线程。 |
| **文件存储** | 文件夹与产物，sha256 校验，保留正式版本；替换文件保留其身份。 |
| **MCP** | 内置服务器 `/mcp`：OAuth 2.1 + PKCE 或受限令牌；在范围内读和写。 |
| **多家模型供应商** | 模型与供应商按智能体设置；运行时支持的模型都能用。 |
| **智能体评测** | 没有内建评测——智能体自己跑测试，证据留在任务上。 |
| **插件生态** | 插件属于运行时（Hermes、OpenClaw）；EmperorClaw 的扩展面是 MCP。 |
| **移动端** | 响应式网页，手机上带底部标签栏；没有原生应用。 |

### 和 Paperclip 对比时要注意

功能列表容易丢信息，所以每条一句话写清楚：

- **成本追踪不止“按运行”。** 花费按运行、智能体、模型、任务、项目和客户归集，并可导出 CSV。
- **它不是“只有角色”。** 有可视化组织架构和可嵌套的汇报线，并且驱动上下文化和升级。
- **定时是一等能力。** cron 计划属于智能体，自动化按计划运行，并在步骤之间设审批闸门。
- **客户隔离由服务端执行。** 成员或智能体可以被限定到一个客户，每次读取都被过滤。
- **MCP 是服务器，不是网关。** 平台自己在 `/mcp` 上应答 MCP，带范围，所以外部助手查询公司，而不是只接收被注入的上下文。
- **没有内建评测套件**，也没有提示词工作室——别把这两个算给我们。
- **许可证是 Fair Source，不是 MIT。**

<br/>

## 团队是现成的，不是空向导

设置向导不是一张白纸。EmperorClaw 自带角色模板、团队模板和公司模板，选一个，就会一步创建智能体、团队群聊和起步知识。

**5 个团队模板**——每个都会创建智能体，*并且*创建带用途说明的团队群聊：

| 团队 | 智能体 | 建好之后是什么样 |
| --- | --- | --- |
| 开发 | 开发、QA | 开发实现、测试验证，阻塞项落在团队群里。 |
| 市场与内容 | 内容、SEO | 策划并撰写内容、做搜索优化、汇报效果；发布前需要审批。 |
| 销售与外联 | 增长、内容 | 找线索、筛线索、写外联、跟进；发给公司外的一切都要先审批。 |
| 客户支持 | 客服 | 客户问题、升级、跟进；涉及钱或客户情绪激动时拉人进来。 |
| 财务与报表 | 会计、分析 | 记账、发票、报表；付款和发给客户的消息都要先审批。 |

**9 个角色模板**——负责人（团队领导，置顶）、SEO、开发、QA、增长、内容、会计、客服、分析。角色不只是一个标签：它自带写好的人格（`SOUL.md`）、运行规则与红线（`AGENTS.md`）、启动阅读顺序、身份、该角色需要的工具集，以及适合的运行时。可以改名字，保留模板。

**3 个公司模板**决定第一天有哪些模块——代理公司（全部，含客户）、产品/个人（除客户外全部）、运营（审批与自动化）。选择业务类型（软件、代理、电商、服务、财务）会推荐起步团队，向导把初始团队限制在 8 个智能体以内。

**起步知识**随公司一起建好：Knowledge & Rules 骨架（公司、智能体、项目、客户）里的公司简介、品牌语气和智能体运行规则默认注入，另有打了 `team-playbook` 标签的团队手册，供智能体按需加载而不是每次都塞进上下文。

工作也可以从模板开始：项目可以用工作流模板创建（`projects.templateId`），而工作流模板在 MCP 上可读（`/api/mcp/templates`），外部助手能列出它们。

**还没有的：** 可导入的公司包。Paperclip 提供 `npx companies.sh add …`，从仓库里拉一整套组织；EmperorClaw 的模板在产品里，同样的结果靠在向导里选择，目前没有可在安装之间搬运整个组织的文件。

<br/>

## 它怎么跑

EmperorClaw 是一台服务器，不是一个终端脚本。Next.js 面板、WebSocket 控制面和 PostgreSQL 跑在 Docker 里；每个智能体有自己的容器，状态存在数据卷和数据库里。

**安装**是一条命令——`curl -fsSL https://raw.githubusercontent.com/emperorclaw/emperorclaw/main/install.sh | bash`——或者从仓库 `docker compose up -d`。脚本把文件放到 `~/emperorclaw`，检查端口，启动整套服务，等就绪，再打开浏览器。Linux 上它能顺带装 Docker Engine；macOS 和 Windows 需要 Docker Desktop。源码构建需要 Node.js 20+ 与 PostgreSQL。我们故意不提供 `npx` 式单文件：这是带面板、接口和控制面的多用户服务器，不是你 shell 里的进程管理器。

| 服务 | 是什么 |
| --- | --- |
| `app` | 面板、REST/MCP 接口和 WebSocket 控制面 |
| `postgres` | PostgreSQL 16，数据在 `pgdata` 卷里 |
| `caddy` | 传入域名时的可选自动 HTTPS |
| `drive-sync` | 可选的 rclone 边车，用于 Google Drive 备份 |

**每个智能体一个容器。** 用「本地：这台机器」雇用，会在应用所在的网络上开一个同级 Docker 容器（`emperor-<agent>-<id8>`，重启策略 `unless-stopped`），带自己的 API 令牌，并把命名卷挂在 `/home/hermes/.hermes/profiles` 上，里面是模型配置、`SOUL.md`、会话（`state.db`）、记忆和技能。点「重建运行时」会停掉、删除、重新开这个容器——镜像更新和密钥轮换用的也是这个动作——而 profile 卷让智能体回来时还是它自己。

**智能体可以住在别处。** 「设置 → 运行时主机」通过 SSH 接入另一台机器；主机会报告可用内存和磁盘（对照新智能体的需求）、是否装了浏览器、已经跑了几个智能体。没有 Docker socket 权限的托管部署，把 worker 放在另一台机器上即可。

**状态扛得住重启。** 任务、备注、审批、消息、运行记录和成本都在 PostgreSQL。领取任务会写 `lease_owner` / `lease_until`，看门狗回收过期租约，所以崩掉的智能体不会卡住任务，两个智能体也不能同时拥有同一件事。指派会在数据库里排一次唤醒，一个突发窗口内合并成一条消息，最多重试 `max_wake_attempts` 次（默认 3），每个智能体还有 `last_heartbeat_at` 和 `last_wake_at`。智能体容器随 Docker 回来；应用、数据库和 Caddy 随守护进程重启。

| 方面 | EmperorClaw | 本地 Node CLI |
| --- | --- | --- |
| 安装 | 需要 Docker，一条命令 | `npx`，仅此而已 |
| 隔离 | 每个智能体一个容器一个 profile | 智能体共用你的 shell 和文件 |
| 服务器上 7×24 | 原生：compose 栈 + 重启策略 | 自己接 systemd、PM2 或 tmux |
| 关掉终端 | 工作继续——状态在 Postgres | 停了，除非你自己守护进程 |
| 最初五分钟 | 慢一些：拉镜像、初始化 | 快：什么都不用装 |

两个边界说清楚：容器不是虚拟机——智能体容器共用主机内核，并且默认加入应用的 Docker 网络，所以容器隔离的是文件、密钥和进程，不是敌意代码；另外 EmperorClaw 默认不给单个智能体设 CPU / 内存上限，要硬上限就在 Docker 主机上设。镜像发布为 `amd64`，Apple Silicon 通过 Docker Desktop 模拟运行。

上面每一条都能在 [`docker-compose.yml`](docker-compose.yml)、[`install.sh`](install.sh)、[`src/lib/hermes-provisioning.ts`](src/lib/hermes-provisioning.ts)、[`src/lib/watchdog.ts`](src/lib/watchdog.ts)、[`src/lib/task-wake.ts`](src/lib/task-wake.ts) 和 [`src/db/schema.ts`](src/db/schema.ts) 里核实——长版本在 [emperorclaw.com/zh/docs/architecture](https://emperorclaw.com/zh/docs/architecture/)。

<br/>

## EmperorClaw 适合你，如果

- ✅ 你运行着**不止一个智能体**，却总在问"到底谁在做什么？"
- ✅ 你希望智能体 **7×24 小时**工作，但重要的事情在结束前要先经过**审批**
- ✅ 你需要让每个**客户的工作、文件和规则彼此隔离**
- ✅ 你的**整个团队**都在和智能体协作，每个人都有合适的**角色和权限**
- ✅ 你被**失控的循环**坑过，想要一个真正能让智能体停下来的预算机制
- ✅ 你希望智能体**记住公司的运作方式**，而不是每次聊天都重新交代一遍
- ✅ 你想要**自托管**：你的数据、你的服务器，不按席位收费
- ✅ 你想**用手机**管理这一切

<br/>

## EmperorClaw 解决的问题

| 没有 EmperorClaw | 有了 EmperorClaw |
| ------------------- | ---------------- |
| ❌ 给智能体发了消息，然后干等。它在思考？卡住了？还是挂了？ | ✅ 实时状态栏显示智能体当前所处的步骤和持续计时。每个智能体都有一张 **Right now**（此刻）卡片：任务、步骤、耗时、上次运行、成本。 |
| ❌ 一次崩溃或重启，请求就……凭空消失了。 | ✅ 每条消息和每个任务都有负责人和状态。回复通过持久化的 outbox 发送；停滞的工作会被重试，然后升级给人工处理。 |
| ❌ 每次对话都要把同样的指令再粘贴一遍。 | ✅ **Company Brain**（公司大脑）保存你的规则和流程，可按公司、客户、项目或智能体划分范围，智能体在行动前会先读取。 |
| ❌ 交付物散落在各种聊天和文件夹里。 | ✅ **Storage**（存储）把报告和产出按客户归档到真实的文件夹中，有唯一的正式版本，并支持搜索。 |
| ❌ 一个循环一夜之间烧掉一周的 token。 | ✅ 按每次运行、每个智能体统计 token 和成本。预算在 80% 时预警，达到上限时阻止新运行；进行中的工作可能超过预算。 |
| ❌ 周期性工作全靠你记得去启动。 | ✅ **Automations**（自动化）可立即运行或按计划启动，支持审批关卡，并保留每次运行的证据。 |

<br/>

## 功能特性

<table>
<tr>
<td width="33%" valign="top">

### 👀 实时看到每个智能体
工作中、回复中、空闲或离线，一目了然：它手上的任务、所处的步骤，以及已经忙了多久。运行时间线会实时展示每一次工具调用。

</td>
<td width="33%" valign="top">

### ⚡ 快速的智能体
Hermes 智能体运行在常驻 gateway 上：每条消息的额外开销约 **0.2 秒**，而不是约 10 秒的冷启动。精简的工具结果让长时间运行的智能体依然响应迅速。

</td>
<td width="33%" valign="top">

### 🛡️ 审批与监督
任务可以设置为必须经你审批才能关闭。当智能体需要你时，会通过应用内、邮件、Slack 或 Discord 通知你。每个决策都带有时间戳。

</td>
</tr>
<tr>
<td valign="top">

### 🧠 Company Brain
一个你的智能体真的会去读的 wiki：规则、流程和经验相互链接，并精确作用于对应的公司、客户、项目或智能体。每个智能体只收到适用于自己工作的范围，外部 MCP 客户端也能查询同一批笔记。

</td>
<td valign="top">

### 📋 项目与任务
看板中的每个任务都只有一个负责人（人或智能体）和明确的状态。不再有"应该有人在跟吧"。

</td>
<td valign="top">

### 💬 团队聊天
为固定团队准备的群聊、与每个智能体的私聊线程，以及能准确找到对应对象的 `@` 提及。智能体可以用图表、KPI 卡片、实时任务卡片和按钮来回复。

</td>
</tr>
<tr>
<td valign="top">

### 💰 成本控制
每次运行的时长、工具调用次数、token 和成本。按智能体设置月度预算，提前预警，到达上限时阻止新运行；正在进行的工作可能超限。

</td>
<td valign="top">

### 👥 全团队协作，按角色分权
以所有者、管理员、成员或访客身份邀请同事。可以把成员限定到指定的智能体和客户——服务器会对该成员可读的一切强制执行这个范围，所以客户或外包只看得到为他工作的智能体。一套部署可以承载多家公司，每个客户的工作、文件和知识都彼此隔离。

</td>
<td valign="top">

### 🔁 自动化
立即或按计划启动周期性工作，在应用中编辑步骤和上下文，并查看审批关卡与每次运行的证据。具体工作由运行时执行。

</td>
</tr>
<tr>
<td valign="top">

### 🩺 自愈能力
智能体发送心跳，任务持有租约。当某个智能体没了动静，工作会被重试，随后转为事件交给人工处理。同一智能体的重复副本会进入待机，而不是重复回答。

</td>
<td valign="top">

### 🔌 接入你自己的智能体
支持 Hermes、OpenClaw 以及任何 MCP 客户端（包括 Claude）。EmperorClaw 本身在 `/mcp` 就是一个 MCP 服务器（OAuth 或受限令牌），因此外部客户端能读取被授权的知识、任务和客户，而不只是接收被注入的上下文；另有一组 MCP 工具处理权限范围内的公司工作，并使用 `send_message`、`wait_for_reply` 和 `read_thread` 与智能体对话。

</td>
<td valign="top">

### 📱 手机上也能用
底部标签栏包含首页、消息、项目、审批和智能体。随时随地审批工作、回复智能体，或发现谁卡住了。还支持语音消息。

</td>
</tr>
</table>

<br/>

<p align="center">
  <img src="docs/assets/emperorclaw-agents.webp" alt="智能体的 Right now 面板：已回复 1 分 42 秒，实时显示工具调用和推理过程，以及上次运行的 token 和成本" width="820" />
  <br/><sub><b>Right now</b>：智能体此时此刻在做什么，每次工具调用都实时呈现。</sub>
</p>

<br/>

## 更多团队管理能力

- **视图：**让智能体创建指标、图表和表格仪表盘；选择读者与维护智能体，
  固定到首页，并检查更新时间。
- **组织架构：**智能体知道主管和汇报关系；任务完成或受阻时可以向上汇报，
  同时仍遵守访问限制。
- **操作控制：**为每类操作选择关闭、先询问或允许。外部运行时工具需要调用
  `check_action`；Emperor 无法拦截任意外部调用。
- **成本与时间线：**按客户、项目、模型和智能体分析支出，导出 CSV，并追踪
  任务运行和交接。月度预算阻止新运行，进行中的工作可能超限。
- **你的工作区：**按公司选择可选模块，每个人独立选择英文或简体中文。

阅读[团队运营指南](src/content/docs/v1.1/operator-guide.zh-CN.md)或
[中文版功能地图](https://emperorclaw.com/zh/docs/features/)，了解示例与边界。

## 其他做得好的地方

|   |   |
| - | - |
| **什么都不会丢。** | 消息、回复和运行记录都是持久化的。重启、断网或进程被杀，最终要么得到一条已送达的回复，要么出现一个可见的事件，绝不会悄无声息。 |
| **工作过程看得见。** | 不只是"在线"：当前步骤、每次工具调用、token 和成本，都在界面中实时显示，并按每次运行记录下来。 |
| **智能体越用越多，依然很快。** | 每个线程一个持久会话、压缩不占用关键路径、精简的工具结果，让第一百条消息和第一条一样快。 |
| **每个人只看到自己那一部分。** | 成员的智能体与客户范围是服务端强制的作用域，而不是藏在菜单里：智能体、项目、任务、审批、文件、视图、成本和会话都按范围过滤，空范围什么也不授予。 |
| **你的知识，按范围生效。** | 同一个智能体面对不同客户时遵循不同规则，因为大脑按公司、客户、项目和智能体分层，而不是一个巨大的 prompt。 |
| **你的大脑就是一个 MCP 服务器。** | Claude、Codex 和任何 MCP 客户端都能通过 OAuth 连接，从平台之外查询被授权的知识、任务和客户。 |
| **两种运行智能体的方式。** | **Managed（托管）**：Emperor 为你创建和更新 Docker 智能体。**Remote（远程）**：一条命令即可在任意 Linux 机器、VPS 或 Raspberry Pi 上安装智能体。 |
| **自托管，Fair Source。** | 你的服务器、你的 Postgres、你的数据。每个版本两年后都会转为 Apache 2.0。 |

<br/>

## 整体架构

```
┌──────────────────────────────────────────────────────────────────┐
│                          EMPERORCLAW                             │
│                                                                  │
│   Dashboard & chat  ·  Projects & tasks  ·  Approvals            │
│   Company Brain     ·  Storage           ·  Pipelines            │
│   Runs & costs      ·  Health watchdog   ·  MCP API              │
│                                                                  │
│                     PostgreSQL (durable state)                   │
└──────────────────────────────────────────────────────────────────┘
        ▲                      ▲                        ▲
        │ browser / phone      │ bridge                 │ MCP (OAuth)
   ┌────┴─────┐      ┌─────────┴─────────┐       ┌──────┴───────┐
   │ Your team│      │ Hermes / OpenClaw │       │ Claude & any │
   │          │      │ managed or remote │       │  MCP client  │
   └──────────┘      └───────────────────┘       └──────────────┘
```

<br/>

<a id="quick-start"></a>

## 快速开始

**1. 用 Docker 安装**到你的电脑或服务器上。你需要 [Docker Desktop](https://docs.docker.com/desktop/)（Windows/Mac）或 [Docker Engine with Compose](https://docs.docker.com/engine/install/)（Linux）。无需安装 Git、Node.js、PostgreSQL、Python 或 Hermes。

```bash
# Mac / Linux
curl -fsSL https://raw.githubusercontent.com/emperorclaw/emperorclaw/main/install.sh | bash
```

```powershell
# Windows (PowerShell)
irm https://raw.githubusercontent.com/emperorclaw/emperorclaw/main/install.ps1 | iex
```

**2. 注册。** 等待出现 **Ready!**，打开 `http://localhost:3000/signup` 并创建管理员账号。

**3. 按照 Emperor 的引导完成设置。** 介绍你的公司，粘贴一个模型 key（推荐 OpenRouter；在启动任何东西之前都会先校验），选择推荐的团队并启动。当主管智能体上线后，打开它的聊天窗口打个招呼。

接下来：创建一个项目，添加一个预期结果明确的任务，指派出去，然后看着它推进。

| 下一步 | 指南 |
| ---- | ----- |
| HTTPS、远程访问、更新、恢复 | [安装](src/content/docs/v1.1/installation.md) |
| 一步步创建你的第一个智能体 | [智能体快速开始](src/content/docs/v1.1/agent-quickstart.md) |
| 在另一台机器上运行智能体（VPS、PC、Raspberry Pi） | [Hermes 运行时](src/content/docs/v1.1/hermes-runtime.md) |
| 从 0.8 升级 Hermes 智能体 | [迁移到 0.9](src/content/docs/v1.1/hermes-migration-0.9.md) |
| 遇到问题 | [故障排查](src/content/docs/v1.1/troubleshooting.md) |

> 请使用在智能体工作期间保持开机的机器。镜像面向 amd64；Apple Silicon 可通过 Docker Desktop 的模拟运行。
> **托管替代方案：**[将应用部署到 Render](https://render.com/deploy?repo=https://github.com/emperorclaw/emperorclaw)。没有 Docker socket 时，请使用[远程安装器](src/content/docs/v1.1/hermes-runtime.md)在另一台机器上运行你的智能体。

<br/>

## EmperorClaw 不是什么

|   |   |
| - | - |
| **不是又一个聊天机器人。** | 对话挂靠在智能体、任务、客户和审批上，而不是漂浮在聊天记录里。 |
| **不是智能体框架。** | 我们不规定你如何构建智能体。我们给你现有的智能体一个工作的地方，也给你一套管理它们的方式。 |
| **不是按席位租用的云服务。** | 它运行在你的基础设施上。除非你接入外部后端，否则任何数据都不会离开你的网络。 |

<br/>

## 常见问题

**它和 Hermes 或 OpenClaw 有什么区别？**
EmperorClaw *使用*它们。它们负责干活；EmperorClaw 负责分配、记住、检查，并把结果展示给你。

**我能接入 Claude 吗？**
可以。EmperorClaw 本身在 `/mcp` 就是一个 MCP server：用 OAuth（或受限访问令牌）连接 Claude、Codex 或任何 MCP 客户端，它就能读取授权范围内的知识、任务、项目和客户——从平台外部查询，而不只是被注入到平台内部智能体的上下文里。详见 [MCP 端点](src/content/docs/v1.1/mcp.md)。

**权限控制和知识共享与其他智能体工具有什么不同？**
三层作用域，都由服务端强制执行，而不是一个共享池：**人**（成员可被限定到指定的智能体和客户——只给外包访问为他工作的智能体）、**知识**（每条笔记都限定在公司、客户、项目或单个智能体，每个智能体只收到适用于自己工作的范围）、**外部工具**（MCP 客户端通过 OAuth 读取同一批被授权的知识）。扁平的技能目录或 wiki 是全公司共用一个池子，而且通常只把上下文推给自家平台内的智能体。

**一套部署能服务多家公司或多个客户吗？**
可以。数据、token 和知识都按公司隔离；在一家公司内部，每个客户也有各自独立的工作、文件和规则，其他客户的成员读不到。

**智能体会一直运行吗？**
智能体会在收到消息、被指派任务或计划中的 pipeline 触发时被唤醒。长时间工作没有问题：单轮对话没有固定的时间上限，只有不活动超时限制。

<br/>

## 配置

Docker 安装器会自动完成所有配置。如果从源码安装，请将 `.env.example` 复制为 `.env` 并设置：

| 变量 | 用途 |
|---|---|
| `POSTGRES_CONNECTION_STRING` | 你的 PostgreSQL 连接字符串 |
| `NEXTAUTH_SECRET` | 会话加密（`openssl rand -base64 32`） |
| `EMPEROR_CLAW_MASTER_KEY` | 加密存储的凭据（`openssl rand -hex 32`） |

> **切勿提交密钥。** 所有配置都通过环境变量提供。完整列表见 [`.env.example`](./.env.example)。源码构建需要 Node.js ≥20 和 PostgreSQL 16。

## 安全

- 密码使用 **Argon2** 哈希；采用 JWT 会话。
- API token **按公司划分范围**，经 SHA-256 哈希，并带有过期时间。
- 集成密钥使用 master key **静态加密**存储。
- 存储访问需要认证，并已针对路径遍历做了加固。
- token 校验有速率限制，写操作支持**幂等键**，还有"最后一名管理员"保护，防止你把自己锁在门外。

请私下向维护者报告安全漏洞，不要发在公开 issue 中。

## Fair Source 许可证

整个产品采用同一个许可证 **FSL-1.1-Apache-2.0** 发布：

- **你可以**自托管、修改并将 EmperorClaw 用于任何目的，包括为你的客户服务。
- **你不可以**把 EmperorClaw 本身作为竞争性的托管服务出售。
- **每个版本**在发布满两周年时**都会转为 Apache 2.0**。

## 项目负责人

由 [Jose Zuniga](https://josezuma.com) 创建，由 [Malecu s.r.o.](https://malecu.eu) 拥有并维护。

版权所有 © 2024–2026 Malecu s.r.o.

## Star、安装、贡献

- ⭐ **给仓库点个 Star**：这能帮助更多人发现它。
- 🚀 **安装它**并雇佣你的第一个智能体；真实的使用才能带来真正的改进。
- 🐛 **提交 issue**，反馈 bug、想法和不顺手的地方。
- 💬 **加入 [Discussions](https://github.com/emperorclaw/emperorclaw/discussions)**，分享你的使用方式。
- 🛠️ **参与贡献**：参见 [CONTRIBUTING.md](./CONTRIBUTING.md)。

<details>
<summary><strong>技术参考</strong>（迁移、存储后端、更新）</summary>

### 安全迁移

EmperorClaw 使用 **Drizzle 增量迁移**（`npm run db:migrate`）：只做增量的 SQL，绝不删除数据。**不要在生产环境中使用 `drizzle-kit push`**；`db:push` 脚本已被刻意禁用。Docker 镜像会在启动时自动运行迁移。

### 存储后端

| 后端 | 配置 | 适用场景 |
|---|---|---|
| **local**（默认） | `STORAGE_BACKEND=local` | 自托管，零外部依赖 |
| **bunny** | `STORAGE_BACKEND=bunny` | 基于 CDN 的生产存储 |

实现一个兼容 S3 的适配器（AWS S3、MinIO、Cloudflare R2、Backblaze B2）会是非常好的第一个贡献。

### 更新

```bash
cd ~/emperorclaw
./scripts/update.sh --docker     # Linux/macOS
# 或者，从源码更新：
git pull --ff-only origin main && npm install && npm run build && npm run db:migrate
```

**升级前请先备份数据库。** 迁移绝不会删除数据，但有了备份你就能安全回滚。

</details>
