# 安装与升级

AgentDeck 适合运行在本机、可信局域网或 VPN 后面。不要把没有额外访问控制的实例直接暴露到公网。

## 安装档位

安装时通过 `AGENTDECK_INSTALL_PROFILE` 选择权限基线：

```bash
sudo AGENTDECK_INSTALL_PROFILE=personal ./install.sh
sudo AGENTDECK_INSTALL_PROFILE=standard ./install.sh
sudo AGENTDECK_INSTALL_PROFILE=hardened ./install.sh
```

- `personal`：面向可信的单用户环境，默认沿用现有运行用户，并允许 Codex 自动执行工作区操作。
- `standard`：推荐的新安装默认值，使用独立的 `agentdeck` 系统用户、`on-request` 审批和 `workspace-write` 沙箱。
- `hardened`：更严格的只读基线，适合熟悉 Linux、systemd 和 Provider 权限差异的维护者。

升级不会静默改变既有运行用户、数据目录、端口或权限档位。

安装器只在配置文件缺失时生成 `web.env`、`runtime.env` 和 app-server env，并使用同一组解析后的用户、HOME 与 DATA_DIR；升级不会覆盖维护者已有的键值。`agentdeckctl check` 会拒绝 Web/Runtime 数据根不一致、服务用户与 HOME 不一致、Provider 用户不存在或配置的二进制不可执行。

首次启动前必须替换 `ADMIN_PASSWORD` 和 `COOKIE_SECRET` 的 `change-me` 默认值，否则 Web 会拒绝启动。HTTPS 保持 `COOKIE_SECURE=true`。仅 loopback HTTP 可设为 `COOKIE_SECURE=false`；明确接受可信内网 HTTP 风险时，还需同时设置 `ALLOW_INSECURE_TRUSTED_LAN=1`。公网或不可信网络不得使用该组合。

Web 与 Runtime 使用独立的 `current-web` 和 `current-runtime` 发布指针。首次升级会从旧的 `current` 指针自动初始化两者；之后 web-only 发布不会改变 Runtime 重启时使用的版本，runtime-only 发布同理。

## 自定义目录与用户

```bash
sudo AGENTDECK_INSTALL_PROFILE=standard \
  AGENTDECK_RUN_USER=agentdeck \
  AGENTDECK_RUN_GROUP=agentdeck \
  AGENTDECK_HOME=/var/lib/agentdeck \
  AGENTDECK_DATA_DIR=/opt/data/agentdeck \
  AGENTDECK_CURRENT_DIR=/opt/stacks/agentdeck/current \
  AGENTDECK_ENV_DIR=/etc/agentdeck \
  ./install.sh
```

安装脚本会渲染 systemd unit。修改模板后需显式运行 `sudo agentdeckctl install-units`；普通部署不会偷偷覆盖系统 unit。

## 升级

```bash
git pull --ff-only
sudo agentdeckctl deploy all
```

只改前端时可执行 `sudo agentdeckctl deploy web`。发布会先运行检查并保留可回滚版本；Runtime 发布会等待活动任务结束。

### 服务重启与已有安装

`install-units` 和 `agentdeckctl` 的 unit 检查共用服务身份解析：显式的 `AGENTDECK_RUN_USER`、`AGENTDECK_RUN_GROUP`、`AGENTDECK_HOME` 优先，其次读取现有 `runtime.env` 中的 `AGENTDECK_SERVICE_USER`、`CODEX_APP_SERVER_GROUP`、`HOME`，新安装才使用 profile 默认值。现有环境文件不会被当作 shell 脚本执行，也不会被覆盖。迁移服务用户时需同时更新环境文件及数据权限。

Runtime 使用 `RuntimeDirectory=agentdeck`，由 systemd 在每次启动时以服务用户创建 `/run/agentdeck`，避免主机重启后锁目录丢失或不可写。更新后执行 `systemctl daemon-reload`，重启服务并检查 `/healthz`、`/api/status` 和外部 HTTPS。
