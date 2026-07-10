# 故障排查

先运行不会修改系统的检查：

```bash
sudo agentdeckctl status
sudo agentdeckctl check
sudo agentdeckctl doctor
```

`check` 只验证配置与服务；`doctor` 输出诊断和建议命令。两者都不会安装 unit、修改目录属主或重启服务。

## unit 与部署

看到 unit 过期提示时，显式执行：

```bash
sudo agentdeckctl install-units
```

普通 `deploy` 不会自动覆盖 systemd unit。发布任务可用以下命令查看：

```bash
sudo agentdeckctl jobs
sudo agentdeckctl job <job-id>
```

Runtime 发布会进入 draining 并等待活动任务。只有确认可以中断任务时才使用 `--force`。

## 日志

```bash
sudo journalctl -u agentdeck-web.service -n 200 --no-pager
sudo journalctl -u agentdeck-runtime.service -n 200 --no-pager
```

公开日志前先检查账号、路径、域名和 Provider 输出。界面日志虽经过脱敏，原始 systemd 日志仍可能包含敏感上下文。

## 连接问题

确认访问地址包含在 `ALLOWED_ORIGINS` 中，并检查反向代理是否支持 WebSocket。页面能打开但任务状态不更新时，应同时检查 Web 与 Runtime 健康状态，而不是只刷新浏览器。
