---
name: workbuddy-skillhub-publish
description: workbuddy SkillHub skill 自动发布：通过 Easy WebBridge 复用已登录浏览器，把本地 Skill 校验、打包、上传图标和资料并提交到 SkillHub。用户说“发布 SkillHub、上传 Skill、提交 SkillHub”或需要批量重复这些操作时使用；不需要第三方 API Key，但需要用户已登录并完成平台实名认证。
---

# workbuddy SkillHub skill 自动发布

把一个本地 Skill 目录快速送到 SkillHub。它只处理发布动作，不修改 Skill 的业务内容，也不绕过登录、实名认证、验证码、风控或平台审核。

## 先确认

- 本地目录必须有 `SKILL.md`、`manifest.yaml`、`LICENSE` 和清单 `icon` 指向的 512×512 PNG（未填写时依次识别根目录或 `assets/icon-512.png`）。
- Easy WebBridge 已启动在 `http://127.0.0.1:17777`，并能列出目标浏览器。
- 必须明确指定 `browserId` 或浏览器显示名；多个环境在线时不能猜账号。
- SkillHub 账号必须已登录且已完成实名认证。实名状态、验证码、身份确认和最终提交失败时，停在 `needs_user_action`。
- 发布前先展示 Skill 名称、版本、ZIP 路径、目标浏览器和将要填写的字段，得到本次明确提交意图后再执行 `--submit`。

## 常用命令

在 Skill 目录外运行也可以，路径使用绝对路径：

```bash
node scripts/skillhub-publish.mjs validate /绝对路径/skill-dir
node scripts/skillhub-publish.mjs plan /绝对路径/skill-dir
node scripts/skillhub-publish.mjs package /绝对路径/skill-dir
node scripts/skillhub-publish.mjs preflight
node scripts/skillhub-publish.mjs publish /绝对路径/skill-dir --browser-id <browserId>
node scripts/skillhub-publish.mjs publish /绝对路径/skill-dir --display-name "自媒体" --submit
node scripts/skillhub-publish.mjs publish /绝对路径/skill-dir --display-name "自媒体" --update --submit
```

`--display-name` 是 EasyBR 浏览器显示名；需要覆盖 SkillHub 表单里的 Skill 名称时使用 `--skill-name "表单名称"`，更新说明使用 `--changelog "本次更新内容"`。

`publish` 不带 `--submit` 时只完成上传和字段填写，停在提交前；带 `--submit` 才点击“提交审核”。命令会优先复用已打开的 SkillHub Dashboard 标签，避免新标签拿不到登录态。新开的标签会保留在浏览器中，方便人工检查；不会关闭用户原有标签。

更新已发布 Skill 时必须加 `--update`。脚本会在“我的 Skills”中按 slug 翻页定位原条目，进入“更新 Skill”表单后重新上传 ZIP 和图标；不要把已有 slug 当成新 Skill 再走发布表单。

## 标准流程

1. `validate` 检查清单、版本、图标和尺寸。
2. `package` 使用系统 `zip` 生成 `dist/<slug>-<version>.zip`，排除 `.git`、`.factory`、`.playwright-cli`、`output`、图标设计源、旧 `dist`、`.gitignore` 和 SkillHub 当前拒绝的 `LICENSE`；本地仓库仍必须保留并校验 `LICENSE`。
3. `preflight` 列出在线浏览器；发布时锁定一个明确 `browserId`。
4. 复用已登录 SkillHub 标签，进入“发布 Skill · 最快上架”。
5. 上传 ZIP 和 512px 图标，填写 slug、显示名称、中文简介、版本和更新说明。
6. 重新读取页面确认上传状态。提交后只接受“提交成功 / 待审核 / 审核中”等平台文案，不能把点击结果当作成功。
7. 若平台没有弹出成功提示，则回到 Dashboard 核对 slug 和版本；目标版本已存在时返回 `already_current` 或 `listed`，不再重复上传。
8. 输出脱敏回执：Skill、版本、浏览器、ZIP、图标 URL（如平台返回）和平台状态。

## 结果状态

- `validated`：本地文件和格式通过。
- `packaged`：ZIP 已生成并检查内容。
- `awaiting_confirmation`：资料已填写，等待用户决定是否提交。
- `submitted` / `审核中`：页面出现平台确认文案。
- `already_current` / `listed`：Dashboard 已存在目标版本；无需重复提交，或提交后已回读到目标版本。
- `needs_user_action`：登录、实名、验证码、风控、表单变化或平台拒绝，需要用户处理。
- `failed`：本地校验、打包或网络命令失败，可修复后重试。

## 安全边界

- 不打印或保存 WebBridge Token、Cookie、实名资料和完整页面隐私内容。
- 不绕过验证码、风控、实名认证或平台审核。
- 不把“审核中”写成“审核通过”，不把“已上传”写成“已发布”。
- 同一浏览器的操作串行执行；任务结束只关闭本 Skill 创建的标签组，不关闭用户原有标签。

字段选择器和 SkillHub 页面变化记录在 [references/skillhub-form.md](references/skillhub-form.md)。
遇到登录、表单、图标、文件类型、重复提交或审核状态问题时，先读 [references/troubleshooting.md](references/troubleshooting.md)，按现象处理，不要重复盲点页面。

## 自测

```bash
node scripts/skillhub-publish.mjs self-test
```
