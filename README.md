# workbuddy SkillHub skill 自动发布

通过 Easy WebBridge 复用已登录浏览器，把本地 Skill 校验、打包、上传图标和资料并提交到 SkillHub。免费使用，不需要第三方 API Key。

## 需要什么

- Node.js 20+
- 已安装并运行 [Easy WebBridge](https://github.com/xxjrq/easy-webbridge)，备用地址：[Gitee](https://gitee.com/xxjrq/easy-webbridge)
- SkillHub 已登录并完成实名认证的浏览器环境

## 用法

```bash
node scripts/skillhub-publish.mjs validate /绝对路径/skill-dir
node scripts/skillhub-publish.mjs plan /绝对路径/skill-dir
node scripts/skillhub-publish.mjs preflight
node scripts/skillhub-publish.mjs publish /绝对路径/skill-dir --browser-id <browserId>
node scripts/skillhub-publish.mjs publish /绝对路径/skill-dir --display-name "自媒体" --submit
```

`--display-name` 指浏览器环境显示名；表单名称和更新说明可分别用 `--skill-name`、`--changelog` 覆盖。

默认停在提交前；`--submit` 才点击“提交审核”。遇到登录、实名、验证码、风控或平台拒绝会明确停下，不伪报成功。
新开的 SkillHub 标签默认保留，便于检查填写结果；需要清理时追加 `--close-tab`，不会关闭用户原有标签。
