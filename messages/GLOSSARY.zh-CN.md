# Simplified Chinese glossary (zh-CN)

Use these terms in `messages/zh-CN.json`. `tests/unit/i18n-parity.test.ts` rejects the
banned variants listed below.

| English | 简体中文 | Do not use |
| --- | --- | --- |
| agent | 智能体 | 代理, 代理人 |
| workspace | 工作区 | 工作空间 |
| company | 公司 | |
| inbox | 收件箱 | 收件匣 |
| approval | 审批 (approve: 批准) | |
| view | 视图 | |
| project | 项目 | |
| task | 任务 | |
| runtime host | 运行主机 | |
| artifact / file | 文件 | 工件 |
| knowledge | 知识库 | |
| pipeline | 流水线 | 管道 |
| routine | 例行任务 | 例程 |
| budget | 预算 | |
| run | 运行 | |
| tool call | 工具调用 | |
| pause all | 全部暂停 | |
| settings | 设置 | 设定 |
| members | 成员 | |
| module | 模块 | |
| customer / client | 客户 | 顾客 |
| timeline | 时间线 | |
| activity | 动态 | |
| Emperor, EmperorClaw | Emperor, EmperorClaw (never translated) | 皇帝, 帝王 |
| agency (business) | 代理机构 | |
| reverse proxy | 反向代理 | 代理 alone |

## Style

- Full-width punctuation in Chinese sentences: ，。：；？！（）“”——. No ASCII `, ; ? !` after a Chinese character.
- A space between Chinese and Latin words or numbers: `3 个智能体`, `SEO 负责人`, `v0.22.0`.
- Product, brand and runtime names stay as they are: Emperor, EmperorClaw, Hermes, OpenClaw, MCP.
- Address the reader as 你 (not 您), matching the plain, direct English copy.
- Keep ICU placeholders (`{count}`, `{name}`, `<strong>…</strong>`) exactly as in `en.json`. Chinese has no plural forms: use only the `other` branch (plus `=0` when the English has a special zero case).
- Agents never see these strings: MCP, agent instructions, webhooks and stored data stay English.
