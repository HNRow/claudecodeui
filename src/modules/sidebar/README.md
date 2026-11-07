# Sidebar

## 项目操作

项目标题栏在编辑、删除图标旁提供“＋”新建会话按钮，桌面和窄屏布局均可使用，点击下拉图标展开后显示新建、编辑、删除操作，收起后隐藏。按钮保留本地化提示、无障碍标签及键盘操作，点击不会切换项目展开状态。重命名期间显示保存、取消操作。

`SidebarProjectItem.tsx` 负责标题栏及新建回调；`SidebarProjectSessions.tsx` 负责会话列表、批量选择与加载更多。

## 验证

运行 `npx vitest run src/modules/sidebar/tests/`。`projectNewSession.test.tsx` 覆盖两种布局下的操作显隐、新建行为与事件隔离。
