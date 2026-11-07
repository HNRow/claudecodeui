# Repository Guidelines

## 项目结构与模块组织

CloudCLI 是 React + TypeScript 前端、Express 后端的 CLI 管理界面，当前使用 SQLite。

- `src/modules/<feature>/`：前端功能模块；`src/shared/`：共享 UI、Hooks、类型与 API。
- `server/modules/<feature>/`：后端模块；`server/shared/`：共享基础设施。
- `shared/`：前后端共用代码；`public/`：静态资源；`electron/`：桌面入口。
- 测试通常位于模块的 `tests/`；`docs/` 保存设计和实施文档；`dist/`、`dist-server/` 为构建输出。

## 构建、测试与开发命令

使用 Node.js 22（见 `.nvmrc`），安装并配置需要接入的代理 CLI。

- `npm install`：安装依赖并配置 Husky。
- `npm run dev`：同时启动后端与 Vite 前端。
- `npm run build`：构建前端及后端生产产物。
- `npm run server`：运行已构建的后端。
- `npm run typecheck`：检查前后端 TypeScript 类型。
- `npm run lint`：运行 Oxlint；`npm run lint:fix` 自动修复可修复项。
- `npm test`：运行后端测试；`npm run test:client`：运行前端测试。

## 代码风格与命名

沿用相邻文件的两空格缩进、单引号及分号风格。React 组件使用 `PascalCase`，Hooks 使用 `useXxx`，函数和变量使用 `camelCase`，固定常量使用 `UPPER_SNAKE_CASE`。

前端应用导入使用 `@/`；跨模块访问通过 `index.ts` 公共入口。前端类型使用 `type` 和 `import type`。修改前阅读 `.agents/skills/` 中对应的前后端模块规范。

每个新增或修改的函数必须有描述性注释。设计遵循 Mat Ryer 风格，保持依赖明确、职责集中；将必需的行为、配置和验证说明写入文档。

## 测试指南

后端采用 Node.js 测试运行器，经 `tsx` 执行；文件命名为 `*.test.ts` 或 `*.test.js`。前端采用 Vitest、jsdom 和 Testing Library，文件命名为 `*.test.ts` 或 `*.test.tsx`。

修复缺陷时优先补充可复现问题的回归测试，验证用户行为与边界条件。当前未配置覆盖率门槛。提交前运行相关测试、类型检查、Lint 和构建。

## 提交与 Pull Request

使用 Conventional Commits，与历史保持一致，例如 `feat(providers): add Kimi Code provider`、`fix(chat): handle empty sessions`。Husky 和 commitlint 检查提交格式。

PR 保持单一主题，说明变更原因、行为及验证结果，并关联相关 Issue。UI 变更附截图或录屏；缺陷修复写明复现步骤。新功能先通过 Issue 讨论；遵循 `CONTRIBUTING.md`。

## 安全与配置

参考 `.env.example` 配置本地环境，默认后端端口为 `3001`、前端为 `5173`。不要提交 `.env`、访问令牌、会话数据或本地数据库。修改认证、CLI 调用或 WebSocket 行为时，检查输入校验及敏感信息日志。
