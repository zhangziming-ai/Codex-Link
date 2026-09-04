# Changelog

## v1.2 - 2026-09-04

### 恢复界面

- 恢复内容按项目名称分组，每个项目可独立展开或收起，并显示所属对话。
- 每个项目增加“全选本项目 / 清空本项目”，同时支持逐条选择对话。
- 修复一级菜单点击后只有箭头变化、内容不可见的问题。
- 修复项目选择和单条对话选择后列表跳回顶部的问题，保持页面及内部滚动位置。
- 左侧选择区与右侧恢复摘要采用一致的“项目 → 对话”层级。

### 备份与数量

- 统一项目数、对话数和归档对话数的统计口径。
- 修复全量包含对话时仍显示“对话 0”的误导信息。
- 备份覆盖 Codex 数据目录中记录的全部本地项目及其对话关联；项目代码和素材目录本身不进入备份。

### 新设备恢复

- 支持直接选择恢复点、restore-points 根目录或其上级备份目录，并自动解析最新有效恢复点。
- 支持清理路径两侧引号，外部同步盘或新设备无需预先存在本机备份管理记录。
- 恢复项目关联、对话、归档、任务索引、规则、记忆和 Skills；API 密钥与站点登录状态仍需重新授权。

### 验证

- 新增打包后 Electron 应用端到端验证，覆盖 34 个项目分组、连续展开、项目全选/清空、滚动保持、SHA-256 校验、真实恢复与回滚。
- 自动化测试共 52 项通过。

## v1.1.5 - 2026-09-04

- 每个恢复项目增加明确的“全选本项目 / 清空本项目”按钮，并保留逐条对话选择。
- 项目全选、项目复选框和单条对话选择后保持页面及项目列表滚动位置，避免跳回顶部。

## v1.1.4 - 2026-09-04

- 取消恢复选择区父容器的固定高度裁剪，避免所有一级菜单仅改变箭头却不显示内容。
- 展开状态使用明确的强制可见规则，确保项目名称和对话卡片实际参与页面布局。
- 打包验证新增真实文字可见性和相邻菜单不重叠检查。

## v1.1.3 - 2026-09-04

- 修复恢复内容一级菜单在数量文字或箭头区域点击时偶发无法再次展开的问题。
- 展开/收起改为原位更新 DOM，不再因整块重绘造成点击丢失和滚动位置跳动。
- 禁止菜单标题文字被拖选，整行统一为可靠点击区域。

## v1.1.2 - 2026-09-04

### Fixed

- Kept large project restore groups visible and independently scrollable when a restore point contains dozens of projects.
- Clarified the visual hierarchy between restore categories, project rows and conversation rows.
- Corrected backup summary counts so fully included conversations are never displayed as zero.

## v1.1.1 - 2026-09-04

### Fixed

- Replaced restore accordions with explicit visibility controls verified in the packaged Electron application.
- Grouped the restore summary by project name before showing each project's conversations.
- Added a distinct patch version so Windows installations can be identified and upgraded reliably.
- Backup result cards now show actual backed-up projects, conversations and Skills instead of reporting zero manually selected conversations when conversations are already included in full.

## v1.1.0 - 2026-09-04

### Changed

- Restore content is grouped by project name, with independent project expansion and selection.
- Restore counts now distinguish project totals from conversation totals and identify the selected restore point as their source.
- Project-name clicks no longer conflict with whole-project selection checkboxes.
- New devices can browse an external or synced backup folder directly, without requiring a local backup-management entry.
- Restore selection and summary accordions now use explicit button-controlled visibility instead of native details elements.

### Fixed

- Fixed project entries that could not be reliably expanded from the restore screen.
- Fixed inconsistent backup and restore count labels caused by displaying conversation totals as project totals.
- Fixed quoted pasted paths and backup-root paths being rejected as unreadable restore points.

## v1.0.0 - 2026-08-28

Initial open source release of Codex Link.

### Added

- Local Codex environment scanning for conversations, archived sessions, task index data, memories, rules, configuration, and Skills.
- Backup plan preview and verified restore-point creation.
- Fine-grained project record selection for backup and restore workflows.
- Transaction-safe restore execution with SHA-256 manifest verification and automatic rollback protection.
- Rollback record access from Settings and rollback execution through Backup Management.
- Windows x64 installer build workflow.
- macOS Apple Silicon source package workflow for local build verification.

### Notes

- The Windows installer is currently unsigned.
- The macOS artifact in this release is a source package, not a signed or notarized installer.
- Codex Link is an independent open-source project and is not affiliated with or endorsed by OpenAI.
