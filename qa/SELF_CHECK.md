# Codex Link 产品自检

## 使用方式

正式发布前运行：

```powershell
npm run self-check
```

当前开发阶段运行：

```powershell
npm run self-check:stage
```

加入人工验收结果：

```powershell
npm run manual:init -- --reviewer QA-01
# 由独立验收人填写 qa\manual-review.json 后执行
npm run manual:validate
node scripts\codex-link-self-check.js --profile release --manual qa\manual-review.json
```

人工材料必须包含独立验收确认、至少 5 位首次使用者（其中至少 3 位目标用户）、证据附件和每个维度的实际观察。未修改的模板说明不能作为证据。

报告输出到：

- `qa/reports/self-check-latest.md`
- `qa/reports/self-check-latest.json`

## 判定规则

- `PASS`：P0 硬门槛全部通过、人工项目全部完成、总分不少于 90。
- `CONDITIONAL`：没有 P0 失败，人工项目完成，总分 80-89；可以内测，不建议正式发布。
- `INCOMPLETE`：自动检查完成，但人工验收或 Apple Silicon 实机报告尚未补齐。
- `FAIL`：任一 P0 硬门槛失败，分数不能抵消。

正式发布的 P0 门槛包括：真实备份、真实恢复执行、恢复前回滚保护、敏感凭据默认排除、恢复点路径隔离和备份完整性验证。

第 12 项还有一个不计分但不可绕过的外部门禁：`qa/reports/macos-arm64-release-latest.json` 必须证明最终 DMG/ZIP 来自 macOS arm64、DMG 可验证挂载、ZIP 可解压，且 ZIP 中的应用持续启动至少 8 秒。公开发布模式还必须证明签名、hardened runtime 与公证票据。

阶段模式允许“真实恢复执行”暂未完成，但会继续作为明确缺口显示，不能据此宣称产品已经发布完成。

## 八个测评维度

| 维度 | 权重 |
|---|---:|
| 核心任务可靠性 | 25 |
| 信任与安全 | 20 |
| 易用性 | 15 |
| 产品价值 | 10 |
| 信息架构 | 10 |
| UI 与视觉体验 | 10 |
| 性能与工程质量 | 5 |
| 用户满意度 | 5 |

自动程序只对可由代码、接口、文件和截图证明的内容打分。用户理解、任务体验、视觉还原度和恢复信任必须由人工测试提供证据。
