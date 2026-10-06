# 云服务器部署套件（deploy/）

> 形态：网站（BFF 服务端 + 浏览器访问）。三种部署路径按环境任选，均支持 SQLite/MySQL 双后端切换（见《docs/部署运维手册.md》第八章）。

## 路径 A：Docker（推荐，跨服务器迁移最省事）

```bash
# 服务器上（Ubuntu/Debian 示例）：安装 docker 与 compose 插件后——
cd medagent/deploy
docker compose up -d --build
curl http://127.0.0.1:8801/api/health     # 返回 ok 即成功
```

- 数据持久化在 `medagent-data` 卷（=容器内 `/app/data_server`：SQLite 库 + 密钥 config.json + 备份）；
- 换服务器迁移：`docker run --rm -v medagent-data:/data alpine tar czf - -C /data .` 导出 → 新机导入，或直接跑 `tools/backup_db.py` 迁 SQLite/MySQL；
- 启用 MySQL：取消 compose 中 mysql 段注释，`MEDAGENT_DB_BACKEND=mysql`，config.json 配 `db.mysql`；
- 公网访问：配 nginx（路径 C 的证书与反代段同样适用，proxy_pass 改 `http://medagent:8801`）。

## 路径 B：systemd 裸机（院内服务器最简）

```bash
# 1. 目录与账号
sudo useradd -r -s /usr/sbin/nologin medagent
sudo mkdir -p /opt/medagent && sudo chown medagent /opt/medagent
# 2. 拷贝项目（含 vendor/ data_records/ opd/ js/data.js 等真实数据文件）
sudo rsync -a --exclude '.git' --exclude 'deploy' <项目目录>/ /opt/medagent/
# 3. 服务
sudo cp deploy/medagent.service /etc/systemd/system/
sudo systemctl daemon-reload && sudo systemctl enable --now medagent
systemctl status medagent --no-pager
```

- 服务单元已内置安全加固（NoNewPrivileges / ProtectSystem，仅 data_server/ 可写）；
- 日志：`journalctl -u medagent -f`。

## 路径 C：公网上线（TLS + 访问控制，任何路径的上层）

> 麦克风权限要求安全上下文：**公网必须 HTTPS**（局域网 IP 访问可例外）。

```bash
# 证书（Let's Encrypt，域名已解析到本机）
sudo apt install certbot python3-certbot-nginx
sudo certbot --nginx -d <域名>
# 反代
sudo cp deploy/nginx.conf.example /etc/nginx/conf.d/medagent.conf
sudo vim /etc/nginx/conf.d/medagent.conf   # 填域名、证书路径、按需开启 basic auth / IP 白名单
nginx -t && systemctl reload nginx
```

## 上线检查单

- [ ] `GET /api/health` 返回 `ok:true`，`db.backend` 符合预期
- [ ] HTTPS 证书生效（公网时），浏览器地址栏无告警
- [ ] 录音页麦克风权限可授权（HTTPS 或 localhost）
- [ ] 归档一份测试病历 → 重启服务/容器 → 数据仍在（持久化生效）
- [ ] `python3 tools/backup_db.py` 手动跑通一次，`data_server/backups/` 出现备份文件
- [ ] 备份 crontab 已配置（每日 02:30，见运维手册第八章）
- [ ] 系统设置页"接入自检"全绿（BFF/数据库/ASR/大模型/数据层）
- [ ] 对外演示前：脱敏开关已开启；确认访问控制（白名单/认证）生效

## 服务器规格建议

| 用途 | 配置 | 说明 |
|---|---|---|
| 演示/试点 | 2C4G、40G 盘 | BFF + SQLite 足够 |
| 试点+MySQL | 2C8G | 容器同机跑 MySQL 时建议 8G |
| 大模型私有化（二期） | GPU 8×A100/H200 级 | 按方案 4.3.3，独立 GPU 服务器 |
