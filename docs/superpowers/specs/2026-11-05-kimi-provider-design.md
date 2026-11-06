# CloudCLI 原生 Kimi Code Provider 设计与实施规格

## 1. 背景与目标

CloudCLI 当前内置 `claude`、`codex`、`cursor`、`opencode` 四类 Provider。本任务新增与 Claude Code、Codex 并列的原生 `kimi` Provider，让用户直接在现有 CloudCLI 界面中使用本机 Kimi Code CLI。

这里的“插件”是 CloudCLI 的内置 Provider，不是独立分发的 CloudCLI 插件包，也不是通过修改 `ANTHROPIC_BASE_URL` 让 Claude Code 调用 Kimi API。

第一版采用官方 `kimi acp` JSON-RPC 接口，覆盖主流程：

- 安装、版本与认证状态检测。
- Kimi OAuth device-code 登录。
- 模型、思考强度和权限模式选择。
- 新会话、连续会话、流式回复、工具调用和计划事件。
- 工具权限允许、拒绝、取消和待处理请求恢复。
- 中断生成。
- 图片输入。
- 原生 MCP 配置管理。
- 原生 Skills 发现与调用。
- 历史会话读取和 CloudCLI 会话索引同步。
- CloudCLI 后端重启后的会话恢复。

第一版不包含：

- 会话分叉。
- 从较早消息编辑并重建会话。
- CloudCLI 后台任务管理。
- 自定义 Kimi Provider/模型注册表的图形化编辑器。
- 远程环境管理。
- `kimi web` REST/WebSocket 服务集成。
- `kimi -p` JSONL 备用运行时。

## 2. 已确认的可行性与方案选择

本机 Kimi Code CLI 为 `2.5.0`，支持 `kimi acp`、`kimi web` 和 `kimi -p --output-format stream-json`。

选择 ACP 的原因：

- 官方面向 IDE 的双向 JSON-RPC 协议。
- 支持 `session/new`、`session/resume`、`session/load`、`session/list`、`session/close`。
- 支持 `session/prompt`、`session/cancel` 和流式 `session/update`。
- 支持 `session/request_permission`，可接 CloudCLI 现有权限弹窗。
- 支持图片、MCP 转发、模型/思考/模式配置。
- 不需要管理额外 HTTP 端口或 bearer token。

不采用 `kimi web`：需要额外管理服务进程、端口和令牌，与 CloudCLI 自身服务生命周期重复。

不采用 `kimi -p`：非交互模式不能提供完整的人工权限审批和计划审批体验。

官方资料：

- https://www.kimi.com/code/docs/en/kimi-code-cli/reference/kimi-command.html
- https://www.kimi.com/code/docs/en/kimi-code-cli/reference/kimi-acp.html
- https://www.kimi.com/code/docs/en/kimi-code-cli/guides/sessions.html
- https://www.kimi.com/code/docs/en/kimi-code-cli/configuration/config-files.html
- https://www.kimi.com/code/docs/en/kimi-code-cli/configuration/providers.html
- https://www.kimi.com/code/docs/en/kimi-code-cli/customization/mcp.html
- https://www.kimi.com/code/docs/en/kimi-code-cli/customization/skills.html

## 3. 与现有 Claude/Codex 实现的关系

Claude Provider 使用 `@anthropic-ai/claude-agent-sdk` 的 `query()`，由 SDK 管理 Claude CLI 进程；权限通过 `canUseTool` 回调进入 CloudCLI，中断通过 `interrupt()`。

Codex Provider 使用 `@openai/codex-sdk` 的 `startThread()`、`resumeThread()` 和 `thread.runStreamed()`；`codex app-server` 目前只补充分叉能力。

Kimi Provider 采用 ACP 作为主运行通道：

- 流式事件和取消方式类似现有 SDK 适配器。
- 权限回调采用 Claude 的交互方式。
- `kimi acp` 承担完整主流程，不像 Codex app-server 只承担分叉。

所有 Provider 都通过现有 `ProviderRuntimeWriter` 和标准化消息进入同一聊天界面，不新增 Kimi 专用聊天页面。

## 4. 总体架构

```text
CloudCLI 现有聊天 UI
  ↓ ProviderRuntimeService
KimiProvider
  ├─ KimiRuntime
  │    └─ KimiAcpClient ── spawn: kimi acp
  ├─ KimiProviderModels
  ├─ KimiProviderAuth / KimiLoginService
  ├─ KimiMcpProvider
  ├─ KimiSkillsProvider
  ├─ KimiSessionsProvider
  └─ KimiSessionSynchronizer
         ↓
CloudCLI sessionsDb / WebSocket / SSE / 权限弹窗
```

新增官方 `@agentclientprotocol/sdk` 1.x 依赖，使用该版本附带的 TypeScript 类型和客户端能力。不得凭空定义协议字段；以 SDK 类型、ACP 官方文档和实际 `kimi 2.5.0` 握手结果为准。

当前仓库 `package.json` 和 `package-lock.json` 已有未提交修改。实施时必须保留这些修改，在其基础上添加依赖，不得执行会丢弃现有改动的 checkout、restore 或硬重置。

## 5. ACP 客户端与进程生命周期

### 5.1 CLI 路径

- 默认命令为 `kimi`。
- 支持 `KIMI_CLI_PATH` 指定绝对路径。
- 路径解析由 Kimi ACP 客户端统一提供，认证检测和运行时不得各写一套。
- 使用 `probeCliVersion()` 实现安装和版本检测。
- `ENOENT` 显示“未安装或不在 PATH”，不得把它误报成“未登录”。
- 不在源码、日志或接口响应中输出认证令牌。

### 5.2 每轮一个 ACP 子进程

第一版每次用户发送一轮消息时创建一个 `kimi acp` 子进程：

1. `initialize`，声明 CloudCLI 客户端信息和必要能力。
2. 新 CloudCLI 会话调用 `session/new`，传入 `cwd`。
3. 已有 Kimi 会话调用 `session/resume`，避免重复回放历史。
4. 根据 `session/new` 返回的 `modes`、`configOptions[]` 设置模型、思考强度和权限模式。
5. 调用 `session/prompt`。
6. 处理 `session/update` 和反向请求，直到本轮完成。
7. 调用 `session/close`，关闭 stdin 并等待子进程退出。
8. 异常退出时终止本轮并清理资源；Kimi 已持久化的会话不得删除。

每轮一个进程是刻意选择：简化崩溃恢复和跨会话隔离，避免常驻子进程泄漏。不得为了“优化”在第一版擅自改成全局共享 ACP 进程。

同一 CloudCLI 会话同时只能有一个活跃 ACP turn；重复提交应复用现有运行锁或返回明确的 busy 错误。不同会话可以并行。

### 5.3 客户端能力边界

- 不 advertise 未实现的 `fs`、`terminal` 或 `elicitation.form` 能力。
- 文件和终端操作由 Kimi 在其工作目录中执行，通过 ACP 工具事件展示。
- 不 advertise `elicitation.form` 时，交互问题按 ACP 回退路径进入权限/选择请求。
- 不得把用户未确认的写入或命令自动改为允许。

### 5.4 中断与关闭

- `abort(sessionId)` 首先发送 `session/cancel`。
- 等待本轮正常收尾；超时后才终止子进程。
- 所有等待中的权限请求必须收到取消结果。
- 向现有 writer 发送 `permission_cancelled` 和 aborted complete，避免刷新后重新出现旧弹窗。
- CloudCLI 后端 SIGINT/SIGTERM 时，通过 Provider 模块公共 barrel 调用 Kimi runtime 的 `close()`，关闭所有活跃 ACP 子进程。
- 子进程的 stdin/stdout/stderr 错误都必须有监听器，不能让单个 Kimi 进程异常拖垮 CloudCLI。

## 6. 运行时事件与消息标准化

`KimiSessionsProvider.normalizeMessage()` 同时服务实时事件和 ACP 历史回放。

至少处理：

- `agent_message_chunk`：转换为 CloudCLI 流式文本事件。
- `tool_call` 及其进度/完成更新：使用 ACP tool-call id 作为稳定消息 id 来源。
- `plan`：转换为现有计划消息。
- `config_option_update`：更新当前模型、思考或模式状态。
- `available_commands_update`：可保留为原生事件；第一版不要求新增 UI。
- prompt 完成、失败和取消：转换为现有 complete/error 语义。

要求：

- 同一工具调用的开始、更新和结束必须更新同一界面条目，不能重复追加。
- 一个原始事件拆成多条消息时，消息 id 必须加稳定的 discriminator。
- 不把 ACP stderr 日志当作 assistant 文本。
- stderr 仅保留有界尾部用于错误诊断，不记录敏感环境变量。
- 新会话取得 Kimi session id 后调用 `writer.setSessionId()`，并发送 `session_created`。
- 所有 complete 都带 CloudCLI session id 和真实 Kimi session id 的既有映射字段。
- 已经产生明确协议错误时，不重复追加原始进程退出错误。

## 7. 权限模式与审批

### 7.1 模式映射

| CloudCLI | Kimi |
| --- | --- |
| `default` | `manual` |
| `acceptEdits` | `yolo` |
| `bypassPermissions` / `skipPermissions` | `auto` |
| `plan` | 仅使用 ACP 实际 advertised 的 plan 模式；不可用时明确提示，不得降级为 auto |

实际 mode id 以 `session/new` 返回的 `modes` 和 SDK 类型为准，不硬编码未验证的 id。

### 7.2 单次审批

收到 `session/request_permission` 后：

1. 从 ACP tool call 中提取工具名、输入和标题。
2. 创建 CloudCLI request id。
3. 发送标准 `permission_request`，provider 为 `kimi`。
4. 等待 `runtime.permissions.resolve()`。
5. 根据 ACP 请求实际提供的选项选择允许或拒绝 option；根据 option 的 kind 选择，不猜固定 option id。
6. 发送 `permission_resolved` 或 `permission_cancelled`。
7. 将所选 option id 返回给 Kimi。

允许、拒绝、修改输入和取消语义必须与现有 Provider 权限网关一致。超时或进程崩溃必须拒绝未决请求，不能默认允许。

### 7.3 记住选择与工具规则

- 遵守 CloudCLI 当前会话的 `allowedTools`、`disallowedTools` 和 `rememberEntry`。
- 明确禁止的规则直接拒绝；明确允许的规则可选择对应允许项。
- 因第一版每轮重启 ACP 进程，CloudCLI 需要按应用 session id 保存本轮 provider 的会话级允许规则缓存，并在后续 turn 重建。
- 不写 Kimi 全局 `config.toml` 权限规则来模拟“仅本次会话允许”。
- 缓存随 CloudCLI 会话删除或后端重启而失效；后端重启后重新询问是可接受行为。

权限等待和恢复逻辑优先复用现有 Provider 网关。若提取 Claude 私有工具匹配逻辑为共享函数，必须保持 Claude 原测试通过，并按后端共享工具规范补充文档和测试；否则在 Kimi 模块内实现其单一用途匹配逻辑。

## 8. 模型与思考强度

`KimiProviderModels` 读取 `$KIMI_CODE_HOME/config.toml`，默认目录为 `~/.kimi-code/`：

- `default_model` 作为当前模型。
- `models` 表生成 `ProviderModelsDefinition.OPTIONS`。
- 使用 alias、`display_name`、`max_context_size`、`support_efforts`、`default_effort` 和 `capabilities`。
- 缺少可选字段时使用现有 CloudCLI 默认行为，不虚构模型能力。
- 配置不存在或损坏时返回可诊断的空/默认状态，而不是让路由崩溃。
- 只返回模型元数据，绝不返回 `providers` 中的 `api_key` 或 env 内容。

运行时通过 ACP `session/set_config_option` 或对应 `session/set_model` 扩展切换模型；思考和模式使用 `session/new` 返回的配置项。用户恢复旧会话时，遵循现有 `resolveResumeModel()` 语义，不无条件用当前默认模型覆盖旧会话模型。

第一版不提供 CloudCLI 内的 Kimi Provider 注册表编辑器；用户仍可用原生 `kimi provider` 管理自定义平台。

## 9. 认证与登录

### 9.1 状态检测

- 安装检测使用统一 Kimi CLI 路径。
- 认证检测通过短时 ACP 握手完成，不读取或复制 Kimi token 文件。
- `initialize` 未要求认证时视为已有可用配置。
- 声明 managed `login` 时，用官方 `authenticate` 检查现有认证。
- `authRequired` 返回 `authenticated: false`，不是安装失败。
- 协议、超时和进程错误保留真实错误，不统一伪装成未安装。

### 9.2 登录流程

新增 Kimi 登录服务，业务与子进程管理放在 service/provider 层，route 只负责参数和响应：

- 启动 `kimi login`。
- 从 stderr 捕获官方 device-code verification URL 和用户代码。
- 在 `ProviderLoginModal` 中展示 URL 和代码，并提供复制/打开链接。
- 登录进程轮询期间，前端轮询现有认证状态。
- 成功、取消、超时和重复启动都有明确状态。
- 同一用户同时只允许一个 Kimi 登录进程；新请求不得不断产生孤立进程。
- CloudCLI 不保存 device code 之外的 OAuth 内容；token 完全由 Kimi CLI 管理。

## 10. MCP

`KimiMcpProvider` 扩展现有 `McpProvider`，使用原生 JSON 格式：

- 用户级：`$KIMI_CODE_HOME/mcp.json`，默认 `~/.kimi-code/mcp.json`。
- 项目级：`<workspace>/.kimi-code/mcp.json`。
- scopes：`user`、`project`。
- transports：`stdio`、`http`、`sse`。
- 根结构为 `{ "mcpServers": ... }`。
- stdio 使用 `command`；HTTP 使用 `url`；SSE 使用 `transport: "sse"`。
- 保留未知字段，包括 `env`、`headers`、`bearerTokenEnvVar`、超时、工具开关等。
- 项目配置覆盖同名用户配置。
- 写入采用项目现有原子写/备份惯例，不覆盖其他服务器配置。
- API 和日志不得泄露 headers、env 或 token 值；按现有 MCP 脱敏方式处理。

运行时直接使用 Kimi 原生 MCP 配置，不在 `session/new` 再转发同一批服务器，避免重复连接。

项目 MCP 的工作区信任仍由 Kimi 管理。不得默认设置 `KIMI_CODE_TRUST_WORKSPACE=1`，也不得关闭全局 trust 要求。

## 11. Skills

`KimiSkillsProvider` 使用以下原生来源：

- 用户：`$KIMI_CODE_HOME/skills/`、`~/.agents/skills/`。
- 项目：项目根 `.kimi-code/skills/`、`.agents/skills/`。
- 额外目录：`config.toml` 的 `extra_skill_dirs`。
- 调用前缀：`/skill:`，最终形式如 `/skill:review-pr`。

要求：

- 支持目录形式 `<name>/SKILL.md`。
- 支持顶层平铺 `<name>.md`。
- 两者同名时目录形式优先。
- 重名优先级与 Kimi 一致：Project > User > Extra > Built-in。
- 对重叠目录去重。
- 项目根按 Kimi 规则向上查找最近的 `.git`，不是一律使用 CloudCLI 后端 cwd。
- 第一版只索引用户、项目和 extra Skills；无需把 Kimi 内建产品说明 Skills 全量显示在 CloudCLI。
- Skills 的实际加载仍由 Kimi CLI 完成，CloudCLI 不自行注入另一份 skill 内容。

如现有 `SkillsProvider` 只支持 `SKILL.md`，应以向后兼容方式扩展平铺 Markdown 支持，并补充所有受影响 Provider 的回归测试；不得改变 Claude/Codex 现有调用前缀。

## 12. 会话历史与同步

### 12.1 原生数据位置

- `$KIMI_CODE_HOME/sessions/`，默认 `~/.kimi-code/sessions/`。
- `state.json` 保存会话元数据。
- `agents/*/wire.jsonl` 保存事件流。
- `session_index.jsonl` 可辅助标题查找。

不得手工修改这些文件。

### 12.2 历史读取

历史消息优先通过短时 ACP `session/load` 获取官方历史回放，再用同一 `normalizeMessage()` 转换，避免把私有 `wire.jsonl` 格式当作稳定 API。

要求：

- 历史读取不调用模型、不产生新 turn。
- 回放过程中不弹出权限请求。
- `limit: null` 表示完整历史；`limit: 0` 返回空页。
- 返回正确的 `total`、`hasMore`、`offset`、`limit`。
- 会话 id 在参与文件路径前必须验证/消毒。

### 12.3 CloudCLI 索引同步

`KimiSessionSynchronizer` 只负责扫描原生文件并 upsert CloudCLI 会话元数据：

- 从 `state.json` 和会话索引读取标题、cwd、创建/更新时间。
- 容忍文件不存在、半写入、坏 JSON 和字段缺失。
- 不解析完整历史到同步服务中。
- `synchronizeFile()` 支持 watcher 单文件更新。
- 只有扫描成功才允许外层推进全局扫描水位。
- 删除 CloudCLI 会话时，沿用现有 provider 删除边界；不得因索引文件变化误删其他会话。

## 13. 前端集成

复用现有聊天、模型选择、权限弹窗、MCP、Skills、历史和设置 UI。

需要接入：

- `src/shared/types.ts`：增加 `kimi`。
- `src/shared/selectedProvider.ts`：加入合法 Provider 列表，不改变默认 `claude`。
- `src/shared/ui/LLMProviderLogo.tsx`：增加 Kimi 标识。
- 新增 `src/shared/ui/KimiLogo.tsx`，风格与现有 Provider Logo 一致。
- `src/modules/chat/hooks/useChatProviderState.ts`：启用主流程能力，不启用 fork/edit/background 能力。
- `src/modules/chat/transcript/ProviderSelectionEmptyState.tsx`：支持 Kimi 初始选择。
- `src/modules/provider-auth/ProviderLoginModal.tsx`：接入 device-code 登录。
- `src/modules/onboarding/AgentConnectionsStep.tsx`：显示 Kimi 安装/连接状态。
- `src/components/mcp/constants.ts` 或当前实际对应位置：加入 Kimi MCP。
- 相关 i18n 文件：复用现有 key；必须新增的文案按项目现有语言回退惯例处理，不在 UI 中硬编码中文。

不新增独立 Kimi 页面，不复制聊天状态管理逻辑。

## 14. 后端注册与文件落点

新增目录：

```text
server/modules/providers/list/kimi/
  kimi.provider.ts
  kimi-acp.client.ts
  kimi-runtime.provider.ts
  kimi-auth.provider.ts
  kimi-login.service.ts
  kimi-models.provider.ts
  kimi-mcp.provider.ts
  kimi-skills.provider.ts
  kimi-sessions.provider.ts
  kimi-session-synchronizer.provider.ts
```

`KimiProvider` 继承 `AbstractProvider`，调用 `super('kimi')`，实现 runtime、models、auth、mcp、skills、sessions、sessionSynchronizer 七项契约；不声明第一版不支持的 fork。

需要修改的现有位置：

- `server/shared/types.ts`：`LLMProvider` 增加 `'kimi'`。
- `server/modules/providers/provider.registry.ts`：注册 `KimiProvider`。
- `server/modules/providers/provider.routes.ts`：允许解析 `kimi`，添加认证登录所需 routes。
- `server/modules/providers/index.ts`：仅导出外部消费者需要的公共 API，包括后端关闭所需入口。
- `server/modules/agent/agent.routes.ts`：若该入口允许启动 Provider，则加入 `kimi`。
- `server/index.ts`：后端关闭时调用 Provider 公共入口清理 Kimi ACP 进程。
- `public/api-docs.html`：在 `PROVIDER_ORDER` 加入 Kimi。
- `server/modules/providers/README.md`：更新 Provider 列表、MCP、Skills 和 session 同步说明。

测试放在 `server/modules/providers/tests/`，使用 `kimi-*.test.ts` 命名。

遵守仓库后端规范：

- 新后端文件全部使用 TypeScript。
- 跨 feature module 导入必须走 `index.ts` barrel。
- route 不包含进程、文件或协议业务逻辑。
- 单一用途类型/工具留在使用文件中；跨位置共享类型/工具才移到 `server/shared/`。
- 不为假想未来功能预留 fork/background 空实现。

## 15. 错误处理与安全边界

必须区分：

- CLI 未安装或路径不可执行。
- CLI 已安装但未认证。
- 配置无效。
- ACP 握手失败或协议版本不兼容。
- 会话不存在或恢复失败。
- 用户主动取消。
- 权限拒绝。
- 模型/API 请求失败。
- 子进程异常退出。

安全要求：

- 默认 `manual`，不得因为 headless 集成而改成自动批准。
- 不记录 `KIMI_CLI_PATH` 之外的完整敏感环境；严禁输出 API key、OAuth token、MCP secret。
- 不读取无关凭据文件。
- 不把 ACP stdout 非 JSON 内容当协议事件；stderr 仅用于有界诊断。
- 所有 RPC 请求都有超时；所有 pending request 在关闭时被拒绝。
- 所有子进程、readline/stream、timer 和权限等待都可清理。
- 不使用 `--dangerous-bypass-auth`，因为本方案不启动 `kimi web`。
- 不修改用户的全局 Kimi 权限、模型或 MCP 配置，除非用户通过对应 CloudCLI 设置界面明确操作。

## 16. 测试设计

### 16.1 ACP 客户端单元测试

使用 fake ACP child process，不依赖真实模型：

- initialize/new/resume/prompt/close 顺序。
- 流式 assistant、tool、plan 和 config 更新。
- 同工具 id 的开始/更新/完成归并。
- 权限允许、拒绝、取消、超时和进程崩溃。
- abort 先发 cancel，超时后才 kill。
- malformed JSON、stderr 噪声、EPIPE、子进程异常退出。
- 所有 pending RPC 在退出时 settle。
- 同会话重复 run 被拒绝，不同会话可并行。
- 后端 close 清理所有子进程。

### 16.2 Provider 单元测试

- CLI 默认路径与 `KIMI_CLI_PATH` 覆盖。
- installed/authenticated/authRequired/协议错误状态。
- 模型和 effort 映射，配置缺失/坏 TOML。
- 登录 URL/code 提取及重复登录清理。
- MCP user/project 读写、SSE、未知字段保留和敏感信息脱敏。
- Skills 两种文件形式、优先级、去重、`extra_skill_dirs`。
- 历史分页，包括 `limit: 0` 和 `limit: null`。
- 同步半写入/坏文件、安全路径和 watcher 单文件更新。
- Provider registry/routes 接受 `kimi`，未知 provider 仍被拒绝。

### 16.3 前端测试

- Provider 列表、Logo、默认 Provider 不变。
- Kimi 主流程能力开关正确，fork/edit/background 不显示。
- 权限弹窗能处理 Kimi request 并防止已解决请求复活。
- 登录 modal 展示 URL/code、成功和失败状态。
- 现有 Claude/Codex 测试保持通过。

## 17. 实施顺序

1. 保存当前工作区状态，确认不覆盖现有 `package.json` 和 lockfile 修改。
2. 添加 ACP SDK 依赖和 `kimi` 类型/registry/UI 最小注册。
3. 实现 CLI 路径、安装认证检测和模型读取。
4. 用 fake ACP 测试先行实现客户端、流式事件、权限、abort 和 close。
5. 接入 runtime 与现有 ProviderRuntimeService。
6. 实现会话 load/resume 和历史同步。
7. 实现 MCP 与 Skills。
8. 接入登录 modal、Provider 选择、Logo、onboarding 和 API 文档。
9. 更新 Provider README。
10. 完成单元、前端、构建和真实 Kimi 验收。

每一步只引入该步骤需要的改动；不顺便重构 Claude/Codex runtime。

## 18. 验证命令

先运行窄测试，再运行项目完整检查：

```bash
npx tsx --tsconfig server/tsconfig.json --test server/modules/providers/tests/kimi-*.test.ts
npm run test:client
npm run typecheck
npm run lint
npm run build
npm test
```

如命令因仓库现有无关失败而无法全绿，必须区分并报告既有失败，不得删除测试或通过收窄检查隐藏 Kimi 失败。

## 19. 真实端到端验收

在已安装并登录的 Kimi Code CLI 上，通过 CloudCLI 实际界面完成：

1. 设置页显示 Kimi 已安装、版本和已认证。
2. 选择 Kimi，新建会话，发送“只回复 OK”，收到真实回复。
3. 第二轮询问第一轮中的随机标记，验证上下文连续。
4. 触发一次只读工具，弹窗允许后能看到工具进度和结果。
5. 触发一次测试写入并拒绝，确认文件未创建。
6. 长回复中点击中断，界面结束且无遗留 `kimi acp` 进程。
7. 切换模型和支持的思考强度，下一轮实际使用新设置。
8. 发送一张测试图片并确认识别结果。
9. 配置一个本地测试 MCP，确认工具可见且可调用；项目 MCP trust 不被绕过。
10. 创建一个临时 Skill，确认能在 CloudCLI 发现并以 `/skill:` 调用。
11. 刷新页面，历史完整且权限弹窗不复活。
12. 重启 CloudCLI 后端，恢复同一会话并继续对话。
13. Claude Code 和 Codex 各完成一次真实短对话，确认无回归。
14. 检查日志无 token、API key 或 MCP secret。

验收不能只以 `/health`、import 成功或 TypeScript 编译通过代替真实生成。

## 20. 完成定义

只有同时满足以下条件才算完成：

- 主流程范围内功能均可通过 CloudCLI 使用。
- 窄测试、前端测试、typecheck、lint、build 和完整测试已运行并报告真实结果。
- 真实 Kimi 新会话、续聊、权限、中断、图片和重启恢复通过。
- Claude/Codex 回归通过。
- 无遗留 ACP/login 子进程，无敏感信息日志。
- Provider 文档与实际行为一致。
- 明确记录未实现的 fork、历史编辑和后台任务能力，不以空按钮或假成功掩盖。
