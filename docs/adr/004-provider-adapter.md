# ADR 004：统一 Provider Adapter

## 状态

已采纳。

## 决策

Provider 差异封装在 `ProviderAdapter` 操作和能力标记之后。不支持的能力返回 `supported=false`、原因码和可读说明。

## 原因

过去 React 页面和 Web 路由从 Provider 私有字段猜测登录、模型、额度和创建能力，导致不同页面显示不一致。

## 影响

页面统一消费 `ProviderStatus` 和能力标记。不支持额度不等于未登录；无法可靠探测时可以明确返回未知状态。
