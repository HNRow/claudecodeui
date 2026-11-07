# 插件用量与界面语言

## 已安装插件

源代码与构建产物位于 `~/.claude-code-ui/plugins/`，宿主自动发现各目录的
`manifest.json`；新增插件无需虚构远程仓库地址。刷新 CloudCLI 后可见插件标签。

| 插件目录 | 功能与数据来源 |
| --- | --- |
| `cloudcli-cron` | Scheduled Prompt：工作区定时提示、执行设置、运行记录与全局看板。 |
| `cloudcli-plugin-token-cost-calculator` | 手动估算或读取本地 Claude Code token，按用户配置的单价计算费用，支持会话／项目／全部历史／日期模式。结果不是服务商账单。 |
| `cloudcli-plugin-deepseek-usage` | 官方账户余额与本地近 30 个 UTC 日的 DeepSeek token 活动。余额与本地统计分别标明来源。 |
| `cloudcli-plugin-kimi-usage` | 官方 Kimi Code 配额及重置时间，以及本地近 30 个 UTC 日可识别的请求级 token 增量。 |
| `cloudcli-plugin-claude-usage` | Claude 订阅窗口配额及本地历史；兼容默认目录的 macOS Keychain 登录与文件凭据。 |

GLM Usage 原有插件显示智谱／z.ai Coding Plan 的窗口配额、重置时间、MCP
调用量，以及本机 Claude Code 记录中的 GLM token 历史；本次未修改它。

## 语言与加载契约

宿主通过 `api.context.locale` 传递当前有效语言，通过 `api.onContextChange`
推送语言、主题和工作区变化。这四个插件支持中文及英文；`zh-*` 使用简体中文，
未知语言或旧宿主未提供语言时回退英文。

仅切换语言时保留表单草稿、价格、token 数量与当前模式，不额外请求用量数据。
插件自己的状态、标签和已知错误提示翻译，模型名、命令、路径、提示词及命令输出
保留原值。Scheduled Prompt 的日期包含时区，计划日期使用计划时区。

宿主将认证后的入口脚本导入为 Blob URL，因此浏览器入口必须自包含。Scheduled
Prompt 与 Token Cost Calculator 使用前端 bundle；新用量插件编译后无运行时相对
导入。测试包括不透明 data URL 导入，防止直接从磁盘导入通过、实际宿主加载失败。

## 凭据与数据范围

DeepSeek 在插件中配置 API Key，或使用受支持的宿主 Secret／环境变量。后端仅向
`https://api.deepseek.com/user/balance` 查询余额，金额保留官方精确字符串；不调用
聊天接口、不推算官方账单。本地统计只覆盖本机保留的 DeepSeek Claude Code 记录，
按会话和消息去重，兼容子代理。

Kimi 优先使用插件配置，也支持宿主 Secret、环境变量及官方 CLI 的可用凭据。
短期 access token 到期不代表 CLI 登录失效；仍可续期时委托官方 CLI 的本地服务更新
访问令牌，并按官方跨进程锁正常保存凭据。插件不自行发送 OAuth 刷新请求。只有官方
确认拒绝认证才提示更新登录；keyring 不可读取时提示配置 API key。仅允许官方
`api.kimi.com`／`api.kimi.ai` Coding 端点；不访问第三方代理。界面只呈现接口实际
返回的配额窗口，不补造缺失窗口。

Claude 智能体设置与 Claude Usage 读取相同的文件／macOS Keychain 登录；短期访问
令牌到期但刷新凭据仍有效时，登录仍然有效。配额查询必须使用新访问令牌，插件会在
需要时启动官方 `claude`，只发送 SDK 初始化控制消息，不发送提示词或模型请求。
官方 CLI 自行续期和保存后，插件重新读取凭据。助手使用临时工作目录，关闭 hooks、
项目集成、MCP 和会话持久化；20 秒超时，并发合并，失败退避一分钟。无法完成续期
与确实需要重新登录分别提示；插件不直接交换或写入刷新令牌。

插件保存的密钥文件为 `config.local.json`、权限 `0600`；响应不返回明文密钥。
本地会话和 CLI 配置不被改写；凭据仅由官方 CLI 在正常续期时更新。Kimi 当前统计官方新版 `usage.record` 请求增量，
排除上下文占用；旧 Python CLI 记录不纳入，缓存字段缺失时总量显示未知。

## 开发验证

各插件 README 列出 `npm run build` 与 `npm test` 的用法；本机验证复用宿主已有的
TypeScript、esbuild、jsdom，无需新增运行时服务。测试使用临时目录和模拟 API，
不执行真实定时任务、不发起付费模型调用。

宿主验证命令：`npm run test:client`、`npm run lint`、`npm run typecheck`、
`npm run build`。用量接口经认证的 `/api/plugins/<name>/rpc/*` 代理访问。

官方参考：[DeepSeek 余额](https://api-docs.deepseek.com/api/get-user-balance/)、
[Kimi Code CLI](https://github.com/MoonshotAI/kimi-code)、
[Kimi 会员权益](https://www.kimi.com/code/docs/en/kimi-code/membership.html)。

## 本次验证记录（2026-11-06）

- Claude Usage 后续访问令牌到期问题已复现：官方 CLI 仍为已登录，可续期凭据有效，
  旧访问令牌查询配额返回 401。官方 CLI 无提示初始化后访问令牌恢复可用；插件现自动
  委托该正常续期路径。50 项插件测试和构建通过，包括续期、未更新存储的退避、
  并发、超时、错误脱敏及非法 URL 保护。重载插件后，真实认证接口与配额接口均为
  HTTP 200，前者 `authenticated: true`，后者 Claude Pro 两条配额且 `error: null`。
  未发送模型请求，未终止用户 CLI。侧栏操作随展开显隐的修正通过前端 914 项测试与
  前端构建；全量类型检查仍仅受已知测试夹具缺少 `backgroundSessionIds` 阻挡。

- Scheduled Prompt：93/93 测试通过，构建通过。覆盖即时切换、草稿保留、无额外 RPC、
  已存成功横幅双向翻译、验证反馈、状态与全局摘要；独立审查发现的横幅问题已先复现再修复。
- Token Cost Calculator：10/10 通过，TypeScript 与单文件 bundle 构建通过；
  前端入口从不透明 URL 导入的回归测试已先失败再修复。测试依赖均已声明为开发依赖。
- DeepSeek Usage：20/20 通过，构建通过；覆盖余额错误、超时、缓存、隔离配置、
  模型与会话去重、真实子进程 ready 协议及宿主入口导入。独立审查未发现重要问题。
- Kimi Usage：12/12 通过，构建通过；覆盖文件 OAuth、过期与 keyring、Secret、
  官方域名限制、部分统计、Blob 入口、草稿与清理；换密钥后的迟到响应覆盖问题已回归修复。
- 宿主前端最终 126 个文件、910/910 测试通过，Lint 和完整构建通过。首次全量运行中
  认证刷新测试偶发失败，相关文件单独复跑以及最终全量复跑均通过，未修改认证实现。
- 全量类型检查仍受既有 `recentConversationTitleSync.test.ts:50` 缺少
  `backgroundSessionIds` 的夹具问题阻挡；未修改该无关文件。
- 使用真实认证接口获取四个已启用插件的入口（HTTP 200），按宿主相同的不透明模块
  方式挂载，调用实际只读 RPC，验证中英文切换及语言变化零额外请求。此为实际服务与
  DOM 集成验证，没有冒充真实浏览器视觉验收。
- DeepSeek 本地统计可用；官方余额缺少 API Key，正确显示配置提示。
- 后续用户反馈证实：Kimi 初版把短期 access token 到期误报成 CLI 登录过期。已区分
  `refreshable` 登录与不可续期访问令牌，官方 CLI 正常续期后真实配额查询成功，返回
  5 小时及每周窗口。无需用户重新登录；没有发起模型请求。
- Kimi 每日活动图补齐 UTC 日期范围、日期轴、纵轴刻度与网格；零值日期保留槽位但
  不画伪柱。悬浮或键盘聚焦可查看完整日期和精确 Token；统计分组紧凑显示，完整值仍可
  查询。小屏图表默认显示最近日期，手动滚动位置在语言切换时保留。已用隔离浏览器检查
  桌面深浅主题和真实 390px 视口，不接触用户浏览器、真实凭据或付费接口。
- 此轮 Kimi 修复共 23 项测试通过（包括原生 CLI 助手、续期判定、缓存、图表交互与
  小屏滚动），构建、Lint 通过；真实认证 RPC 返回 `configured: true`、`status: ready`，
  配额 `status: ok`，宿主模块挂载及语言切换无额外请求。
- 未提交 Git，未清理其他工作区修改，未改写 CLI 源文件或会话，未执行真实定时任务或模型对话。
- Claude Usage 的 `RPC error 404` 已定位为插件只读取文件、遗漏 macOS Keychain。
  现兼容默认钥匙串服务，保留文件支持；凭据错误按业务状态返回并显示具体说明，真正
  不存在的路由仍返回 404。本地历史保持独立。38 项测试及构建通过，真实认证接口返回
  HTTP 200、Claude Pro 的 session/weekly 配额；没有写入或刷新 Claude 凭据。
- Sessions 插件的列表 500 已定位为无条件扫描 Linux `/proc`。现使用 Linux/macOS
  进程适配器；macOS 通过 `ps`、`lsof` 读取 PID、用户、运行时长及工作目录，使用
  会话记录的 busy/idle，无法判断时显示 UNKNOWN。清理判断使用可移植活性探测，
  不再因缺少 `/proc` 把活进程误判为残留。6 项测试及构建通过；真实认证列表连续两次
  HTTP 200，显示 5 个 Claude 会话。验证未终止、恢复或清理用户会话。

- 智能体设置中的 Claude 未认证误报来自宿主认证实现，同样遗漏 macOS Keychain，
  与插件是独立读取路径。现已补上只读回退并复用 OAuth 到期/可续期判断；保留环境
  凭据优先级及 API Key 覆盖订阅提示，`CLAUDE_CONFIG_DIR` 的文件与设置保持隔离。
  23 项认证回归测试通过；认证及 CLI 相关测试 48 项通过，构建、Lint 和后端类型
  检查通过。全量后端测试仅有已知的 2 项 Provider Skills 断言失败，全量类型检查
  仍受侧栏测试夹具缺少 `backgroundSessionIds` 阻挡，均未修改无关实现。
  已重启实际 CloudCLI 服务，认证接口由未认证恢复为 `authenticated: true`、
  `method: keychain`；未写入或刷新 Claude 凭据。重启后 Sessions 列表再次连续两次
  返回 HTTP 200，显示 4 个当时存活的 Claude 会话。
