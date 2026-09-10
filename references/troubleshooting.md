# SkillHub 常见问题

这份清单记录已实际遇到过的故障和固定处理方式。先看现象，再按“自动处理”或“用户处理”执行。

## 快速判断

| 现象 | 原因 | 自动处理 | 仍需用户处理 |
|---|---|---|---|
| 找不到浏览器或打开了错误账号 | 没有明确环境，或 `browserId` 已离线 | `preflight` 列出在线环境；`publish` 必须指定 `--browser-id` 或精确的 `--display-name` | 选择正确 EasyBR 环境并确认 SkillHub 已登录 |
| 页面快照报 `Frame with ID ... was removed` | SkillHub 切页时旧 frame 已失效 | 脚本自动重试快照并等待页面稳定 | 连续超时才刷新目标标签，不要新开多个重复窗口 |
| 点击“自定义”没切到图标页 | 页面同时有 tablist 和 tab，普通文本匹配点错容器 | 脚本只点击真正的 tab，并先滚动到视口中央 | 页面改版时检查“自定义”是否仍是 tab |
| 点击上传图片后没有文件框 | 弹窗异步创建，点击后立即查询会读到旧页面 | 脚本等待真实 `input[type=file][accept*=image]` 出现，再上传 | 等待超时就查看弹窗是否被浏览器拦截 |
| 图标上传成功但没有远程图标地址 | CDN 写入尚未完成，或读到了隐藏预览图 | 脚本等待可见面板的远程图片 URL；没有 URL 不提交 | 网络异常时重试图标上传 |
| 提交返回“不允许的文件类型: LICENSE” | SkillHub 当前拒绝归档内的 `LICENSE` | 本地仍校验 `LICENSE`，上传 ZIP 自动排除它；自测会拦截回归 | 不要手动把 `LICENSE` 加回上传 ZIP |
| 页面只有名称，描述为空或旧描述 | React 表单异步更新失败，或误把 SKILL.md 建议当成已填写 | 脚本填写 `#skill-summaryZh` 后回读名称、描述、版本等字段；回读不一致直接停止 | 修正表单后再提交，不要把“已上传”当成“描述已保存” |
| 提交失败、Slug 重复、已有版本审核中 | 同一 slug 已有审核记录，或平台返回业务拒绝 | 脚本保留页面并报告 `needs_user_action`，不伪报成功 | 到“我的 Skills”查看现有记录；更新时提升版本号，重复作品改唯一 slug |
| 要求登录、实名认证、验证码或风控 | 平台账号状态或风险控制拦截 | 脚本立即停止，不绕过验证 | 在同一个 EasyBR 环境完成平台要求，再重新运行 |
| 显示“提交成功”但列表是“安全审核中” | 提交接收和安全审核是两个状态 | 以列表/API 的 `reviewStatus=pending` 为准 | 只能说“已提交/审核中”，审核通过前不要说已公开 |

## 固定检查顺序

1. `node scripts/skillhub-publish.mjs validate <skill-dir>`：确认 `SKILL.md`、`manifest.yaml`、`LICENSE`、512×512 PNG 和名称/描述存在。
2. `node scripts/skillhub-publish.mjs package <skill-dir>`：确认 ZIP 含 `SKILL.md`、`manifest.yaml`、图标，且不含 `LICENSE`、`.env`、证书、旧 `dist`。
3. `node scripts/skillhub-publish.mjs preflight`：确认 Easy WebBridge 在 `127.0.0.1:17777`，并选定唯一在线 `browserId`。
4. `publish` 填写后先回读字段和图标远程 URL，再按 `--submit` 决定是否提交。
5. 提交后检查“我的 Skills”：`安全审核中`/`待审核`表示已接收，不等于审核通过；出现拒绝原因时记录原文再修复。

## 不要重复犯的错误

- 不使用已废弃的 Kimi WebBridge 或 `127.0.0.1:10086`。
- 不用普通文本点击代替真实 tab/按钮定位，不在页面切换期间复用旧快照。
- 不把本地 ZIP 生成成功、图标上传成功或“提交成功” toast 单独当作公开发布完成。
- 不打印 WebBridge token、Cookie、实名资料或完整页面隐私内容。
