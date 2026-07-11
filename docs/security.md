# 安全边界

AgentDeck 能执行命令和修改代码，应只部署在本机、可信局域网、VPN、Tailscale、Headscale、WireGuard，或带访问控制的反向代理后面。不要直接暴露到公网。

## 权限档位

- `personal` 追求可信单用户环境下的流畅体验。
- `standard` 使用独立系统用户和较保守的工作区写入策略，推荐新安装采用。
- `hardened` 从只读基线开始，需要维护者显式开放能力。

升级不会自动改变既有运行用户、数据目录、端口、沙箱或审批策略。

## 浏览器与网络

修改状态的 HTTP 请求会校验 `Origin` 或 `Referer`；WebSocket 需要有效会话和合法来源。生产环境建议明确配置：

```bash
ALLOWED_ORIGINS=https://agentdeck.example.internal,http://100.64.0.10:3842
```

浏览器 Cookie 只保存随机会话令牌，服务端保存令牌哈希。修改 `ADMIN_PASSWORD` 会撤销已有会话。

`ADMIN_PASSWORD` 与 `COOKIE_SECRET` 使用示例默认值会导致生产启动和检查失败。Cookie 默认启用 Secure；仅 localhost HTTP 可直接配置 `COOKIE_SECURE=false`，可信内网 HTTP 还必须显式设置 `ALLOW_INSECURE_TRUSTED_LAN=1`。反向代理应终止 HTTPS，并保持 Secure Cookie。

## 凭据与日志

Provider 凭据保存在 `DATA_DIR` 下的受限文件或专用状态中，不应写入 Git、普通日志或浏览器事件。诊断与安装日志在进入界面前会脱敏。

普通备份不包含 Token、OAuth 状态、API Key 和账号密钥。`backup --include-secrets` 生成的迁移包应按密码库同等级保护。

只在可信环境临时启用 `AGENTDECK_ENABLE_VERBOSE_DIAGNOSTICS=1`，排查结束后立即关闭。
