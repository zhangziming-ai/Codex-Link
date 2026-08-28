# Codex Link

Codex Link 是为 Codex 用户构建的开源跨设备工作流工具。它可以在本机审计 Codex 工作环境，创建可验证的备份恢复点，并在 Windows 与 macOS 场景中辅助迁移和恢复会话、配置、Skills 与相关本地数据。

Codex Link 是独立开源项目，与 OpenAI 无从属关系，也未获得 OpenAI 背书。

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
