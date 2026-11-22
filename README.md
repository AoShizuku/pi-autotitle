# pi-autotitle

给 pi 自动生成 session 标题：新会话第一轮 agent run 结束后，用 user prompt + assistant 实际输出 + 本轮状态生成一个短标题，写入 pi 的 session name。

默认 **tool-first**：标题模型通过 `submit_session_title` 工具返回标题，tool 模式不解析自由文本。需要对比或遇到模型 tool calling 不稳定时，可以切到 `text` 模式。

## 安装

安装：

```bash
pi install npm:@aoshizuku/pi-autotitle                # 从 npm 安装
pi install git:github.com/AoShizuku/pi-autotitle     # 或从 GitHub 安装
pi install ./pi-autotitle
```

只试一次：

```bash
pi -e ./pi-autotitle/src/index.ts
```

## 行为

- **触发时机**：第一个 `agent_settled` 后。此时 assistant 输出已经持久化，标题可以利用实际工作内容，而不是只看 user message。
- **interrupt**：`agent_settled.aborted` 或 assistant `stopReason === "aborted"` 时，partial assistant output 仍会放进 prompt，并带 `<turn_status>interrupted</turn_status>`。第一轮按 Esc 后不会直接 fallback 成 user prompt 前 50 字。
- **tool 模式**：只接受合法的 `submit_session_title` tool call。模型只回 text 会被视为 invalid，重试一次（附带「必须调用工具」的纠正语）后走 fallback title。不会把 text 当作 tool 的兜底。provider 报错后的重试不带纠正语。
- **text 模式**：不发送 tools，解析纯文本。兼容引号、Markdown、`Title:` 前缀、代码块、模型主动输出的 JSON。
- **手动命名优先**：`/name`、`pi.setSessionName()` 或其他插件设置的 name 不会被覆盖。生成中的请求会 abort。
- **幂等**：有 name 就不再自动生成；内存 `pending` / `attempted` 防重复；不往 session tree 写 marker。
- **恢复**：启动/恢复时，如果 session 没有 name，且只有一条 user message（或最后一轮是 aborted/error），会补一次标题。多轮老 session 不批量补。
- **fallback**：模型两次都失败后，默认用 user prompt 的第一条有效行做 fallback title。可通过 `PI_AUTOTITLE_FALLBACK=0` 关闭。
- **无副作用**：标题请求不带 tools（text 模式）或只带一个标题工具（tool 模式），不碰 MCP/权限/文件；不写入 transcript，也不计入 session 的 token/cost 统计。插件自己累计标题调用的 token 和 cost，`/autotitle status` 可查。
- **设置落盘**：`/autotitle on|off|tool|text|model` 和 `/shizuku` 设置面板改的值写进 `~/.pi/agent/pi-autotitle.json`，重启后保持。计数挂在进程全局上，跨 `/new`、`/resume`、`/fork`、`/reload` 保留，直到 pi 退出。

## 配置

优先级：环境变量 > `~/.pi/agent/pi-autotitle.json` > 默认值。设了环境变量的项由它决定，命令和设置面板都改不了（面板里显示为锁定）；没设的项用配置文件，字段名为 `enabled`、`format`、`fallback`、`maxChars`、`timeoutMs`、`scope`、`modelSpec`，`/shizuku` 面板可以直接改。

| 变量 | 默认 | 说明 |
|---|---|---|
| `PI_AUTOTITLE` | on | `0` / `false` / `off` 关闭 |
| `PI_AUTOTITLE_FORMAT` | tool | `tool` 或 `text` |
| `PI_AUTOTITLE_FALLBACK` | on | `0` / `false` / `off` 关闭 fallback title |
| `PI_AUTOTITLE_MAX_CHARS` | 50 | 标题最大 Unicode 字符数，10–100 |
| `PI_AUTOTITLE_TIMEOUT_MS` | 12000 | 单次标题请求超时，1s–60s |
| `PI_AUTOTITLE_SCOPE` | tui | `tui` 只交互模式生成；`all` 放开 print/json/rpc |
| `PI_AUTOTITLE_MODEL` | 当前模型 | `provider/model`，例如 `deepseek/deepseek-chat` |

## 命令

```text
/autotitle                 显示状态
/autotitle on|off          开关（写入配置文件）
/autotitle tool|text       切换标题输出通道（写入配置文件）
/autotitle retry           重新生成（已有 name 且不是本插件写的则拒绝）
/autotitle retry force     强制覆盖当前 name
/autotitle preview         生成并显示标题，但不写入 session name
/autotitle preview text    用 text 模式预览一次
/autotitle preview tool    用 tool 模式预览一次
/autotitle model <p/m>     指定标题模型（写入配置文件）
/autotitle model default   恢复当前模型（写入配置文件）
```

`/autotitle status` 例：

```text
pi-autotitle: on | mode=tool | scope=tui | fallback=on
model: deepseek/deepseek-chat (current)
session: 修复登录 500 [auto] | pending: no
runs 12 | tool 10 | text 0 | fallback 2 | failed 0 | cancelled 1
retries 3 | invalid 2 | provider errors 0 | timeouts 0 | avg 1.2s
tokens in 41230 | out 1180 | cost $0.0123
mode runs: tool 12 | text 0
last: success source=tool 1.1s attempts=1 status=completed mode=tool
```

`source` 会显示实际生效的通道：`tool`、`text` 或 `fallback`。`mode runs` 用来对比两种模式的调用量。计数、token 与 cost 是当前 pi 进程的累计值（含 preview），cost 取 provider 返回的 `usage.cost.total`。

## 开发

```bash
cd pi-autotitle
npm install
npm run typecheck
npm test
```

要求 pi `1.5.2` 及以上（已在 v1.5.2 上验证通过）。pi 用 jiti 直接加载 TypeScript，不需要 build。

---

本插件属于 Shizuku 系列 pi 插件（[pi-shizuku](https://github.com/AoShizuku/pi-shizuku)）：共用的左栏、设计语言与跨插件约定见总仓库。贡献方式见 [CONTRIBUTING.md](CONTRIBUTING.md)。
