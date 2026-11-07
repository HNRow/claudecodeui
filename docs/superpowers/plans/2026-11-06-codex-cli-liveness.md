# External Codex CLI Liveness Implementation Plan

**目标与规格：** 实施本次用户提供的外部 Codex CLI 状态识别需求，保持前端和用户 Codex 文件不变，不提交 Git，不清理无关修改。

**架构：** providers 服务扫描至多 256 个有效 thread 锁，以一次无 shell 的 `execFile(lsof)` 调用检查存活持有者；复用 Codex 历史的数据库优先 rollout 定位规则。按路径、mtime、size 缓存生命周期，追加时增量读取，其他变化重读；只有最新 `task_started` 且锁仍有持有者才报告 busy。

**技术：** TypeScript、Node.js 文件流/子进程、现有 SQLite sessionsDb、Node test runner。

## 实施步骤

- [x] 新增隔离锁持有子进程夹具和检测测试；更新 sessions service 测试，先观察失败。
- [x] 实现 `listBusyCodexCliSessions()`，复用 rollout 定位，覆盖缺失/损坏数据、无工具、缓存和活性重查。
- [x] 接入运行列表；验证 app ID 映射、未知会话跳过、自有运行与后台任务优先。
- [x] 运行指定的相关测试、全量后端/前端测试、Lint、后端类型检查、全量类型检查及构建。
- [x] 重启实际 CloudCLI 服务，使用认证接口验证真实 busy/idle 与状态文案；未终止用户 Codex 进程。
- [x] 更新 providers 文档，记录验证结果及已知无关失败。

## 重点检查

空锁文件与持锁 daemon 不能单独代表 busy；退出的测试进程必须使缓存 busy 失效。异常文件名、符号链接、损坏/半写入 JSONL、同尺寸改写和文件截断必须保守处理。外部状态不得覆盖任务及中断能力。所有 Codex 源文件仅只读访问。

## 审查与验证结果

### 后续恢复线程的写锁冲突

- 真实反馈 `already has an active writer` 已确认：外部 Codex daemon 仍持有线程锁，
  且线程状态为 active、最新生命周期为 `task_started`；运行列表已正确识别。
- 新增运行前的单线程持锁检查，复用无 shell 的 lsof/PID 校验与锁文件验证。存在实时
  writer 时不启动第二个 exec；闲置但仍持锁的线程同样不可被第二个进程恢复，仍不将其
  误报为运行中。锁残留且无持有者不阻止执行。
- 检查后的竞争错误也转换为原客户端继续／关闭原会话释放占用／显式分叉的提示；
  不删除锁、不停止外部进程、不自动分叉或重发命令。旧取消记录按 AbortController
  隔离，不会吞掉后续被占用请求的错误与完成事件。
- 三组相关测试最终 50/50 通过；构建、Lint、后端类型检查通过。真实线程的隔离探针
  确认 `execAttempts: 0`、命中持锁保护；SDK 调用另加替身防护，验证不发送模型请求。
- 全量后端测试 884 项，877 通过、3 失败、4 跳过：2 项是已知 Provider Skills；
  Claude 定时测试 `stopping the last outstanding task releases the held process`
  单独复跑所在文件 6/6 通过。未修改无关实现。
- 已重启实际 CloudCLI 服务；外部 Codex daemon 仍存活并持锁，认证运行接口继续返回
  HTTP 200 并识别该会话。当前受占用的线程仍须在原客户端继续或由用户显式分叉。

### 初版运行状态识别

- 独立审查复现增长重写的旧 busy 缓存误报；回归测试先失败，再以完整旧前缀 SHA-256 校验修复。追加时只解析新 JSONL，但会流式读取旧前缀校验，避免任意前部改写被遗漏。
- 同时补测并修复 macOS lsof 的部分匹配：有残留锁时 exit 1 仍可能包含其他锁的有效持有者。仅无诊断的正常部分匹配可用；工具不可用、超时及实际错误仍保守跳过。
- 指定两个文件：34/34 通过；加上 `claude-runtime-hold.test.ts` 的最终复跑：40/40 通过。
- 最终 `npm test`：873 个测试，866 通过、3 失败、4 跳过。2 个失败是已知 Provider Skills（Codex skill source、OpenCode compatibility skill scope）；1 个是 Claude 定时测试 `stopping the last outstanding task releases the held process`，已单独复跑通过。未改无关实现。
- Node.js 22 前端 Vitest：125 个文件、909/909 测试通过。
- `npm run lint`、后端 `tsc --noEmit`、`npm run build` 均退出 0；Lint 保留既有警告，本次新增代码没有诊断。
- `npm run typecheck` 仍因既有 `recentConversationTitleSync.test.ts:50` 夹具缺少 `backgroundSessionIds` 失败，未修改该文件。
- 最新构建已重启并通过真实认证接口（HTTP 200）核验：1 个仍持锁且最新 `task_started` 的 Codex 会话出现在运行列表，文案 `Running in the Codex CLI`、`canInterrupt: false`；2 个仍持锁但最新 `task_complete` 的真实会话均不在列表。
- 浏览器导航与 CloudCLI 桌面观察工具未获访问许可，因此没有直接验证列表的视觉状态。前端无修改；既有运行状态轮询会消费同一接口。
- 仅修改本次实现、测试和文档；未提交 Git，未修改 Codex 锁、rollout、配置或源数据库。
