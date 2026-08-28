# Codex Link

Codex Link 是为 Codex 本地环境迁移痛点而生的开源工具。换电脑、重装系统、跨 Windows 与 macOS 工作时，Codex 的对话、项目索引、规则、记忆和 Skills 往往分散在本地；直接复制目录又容易带来路径错乱、SQLite 状态风险和凭据安全问题。Codex Link 提供可预览、可校验、可回滚的备份与恢复流程。

Codex Link 是独立开源项目，与 OpenAI 无从属关系，也未获得 OpenAI 背书。

![Codex Link 真实界面截图](docs/assets/screenshots/overview.png)

先看痛点与真实界面案例：查看 [3 分钟图文上手](docs/QUICK_START.zh-CN.md)。

## 下载

- Windows: 在 GitHub Release 下载 `Codex-Link-Setup-1.0.0-x64.exe`。
- macOS Apple Silicon: 当前发布提供 `Codex-Link-1.0.0-mac-arm64-source.zip` 源码包，可在 Apple Silicon Mac 上按仓库说明构建。当前版本不提供已签名或公证的 macOS 安装器。
- 校验: Release 中提供 `SHA256SUMS.txt`，可用于核对下载文件完整性。

## 主要能力

- 扫描本机 Codex 主目录和备份目录。
- 创建包含对话、归档对话、任务索引、个人记忆、规则配置、全局规则和 Skills 的恢复点。
- 支持按项目记录和单项内容精细选择备份与恢复。
- 恢复前校验 SHA-256 清单，恢复失败时自动回滚。
- 在设置页查看回滚记录，并从备份管理页执行事务回滚点恢复。
- 识别 Windows、macOS、Linux 路径差异，辅助跨系统迁移。

## 开发运行

```bash
npm install
npm start
```

运行检查与测试：

```bash
npm run check
npm test
```

构建 Windows 安装器：

```bash
npm run build:win
```

生成 macOS Apple Silicon 源码包：

```bash
npm run package:mac:source
```

## 开源协作

- 英文说明: [README.md](README.md)
- 变更记录: [CHANGELOG.md](CHANGELOG.md)
- 贡献指南: [CONTRIBUTING.md](CONTRIBUTING.md)
- 安全策略: [SECURITY.md](SECURITY.md)
- 许可证: [Apache License 2.0](LICENSE)
