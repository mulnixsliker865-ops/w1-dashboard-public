# 2026 年线索多维分析看板

这是给 GitHub Pages 发布使用的公开静态看板包。

## 数据更新

- 页面是静态 HTML。
- `dashboard-data.js` 由 GitHub Actions 每天北京时间 12:00 自动从飞书多维表重建。
- Actions 使用 GitHub Secrets 保存飞书应用凭证，不把密钥写入仓库。

## GitHub Secrets

仓库需要配置：

- `FEISHU_APP_ID`
- `FEISHU_APP_SECRET`

## 数据源

- 飞书多维表：`LROebpuy6akvMSsfAlDcKx3Kn2c`
- 线索表：`tbl2HIr7jiHY4PXz`（2026年线索表新）
- 派单表：`tbl3yc7EZT05fczy`

## 隐私

公开页面只包含聚合数据，不包含客户姓名、手机号和记录 ID。
