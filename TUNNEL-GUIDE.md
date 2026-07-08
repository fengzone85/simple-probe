# 隐藏源站 IP：Cloudflare Tunnel / Tailscale 接入指南

本项目即便**不上 Cloudflare 的 CDN/WAF（"CF 盾"）**也已具备基本安全（源站 8080 仅绑回环、TLS、强 admin token、CSP、独立 agent token）。

但不用 CF 有一个真实缺口：**VPS 公网 IP 直接暴露**，会被全网扫描/弱口令爆破直打 Nginx，也无托管 WAF 兜底。

本指南提供两种**让 VPS 完全不开放入站端口**的方案，从源头消除"源站暴露"问题。两者任选其一（也可组合）。无论哪种，都**不替代认证**：admin token 仍需强随机。

> 前置：服务端请用 `server/docker-compose.yml`（8080 绑 `127.0.0.1`），并已在本地 Nginx 配好 TLS + 限流（见 `nginx/monitor.conf.example`）。下面两种方案都让外部流量"经隧道到达本机 Nginx"，Nginx 的限流/HSTS/CSP 全部保留。

---

## 方案 1：Cloudflare Tunnel（推荐，免费，无需公网 IP）

原理：在 VPS 上跑 `cloudflared`，它**主动出站**连到 Cloudflare 边缘，由 CF 把你的域名流量经隧道转发回本机 Nginx。VPS 无需任何入站端口（80/443 可全部关闭）。

### 1. 安装 cloudflared
```bash
# Debian/Ubuntu
curl -fsSL https://pkg.cloudflare.com/cloudflared-ascii.gpg | sudo tee /usr/share/keyrings/cloudflared.gpg >/dev/null
echo "deb [signed-by=/usr/share/keyrings/cloudflared.gpg] https://pkg.cloudflare.com/cloudflared any main" | sudo tee /etc/apt/sources.list.d/cloudflared.list
sudo apt update && sudo apt install cloudflared
```

### 2. 登录并创建隧道
```bash
cloudflared tunnel login        # 浏览器里选你的域名授权
cloudflared tunnel create monitor
```

### 3. 写配置 `~/.cloudflared/config.yml`
指向**本机 Nginx 的 443**（保留 Nginx 的限流/HSTS/CSP）：
```yaml
tunnel: monitor
credentials-file: /root/.cloudflared/<上一步的 uuid>.json
ingress:
  - hostname: monitor.yourdomain.com
    service: https://localhost:443
  - service: http_status:404
```

### 4. 设为系统服务并启动
```bash
sudo cloudflared service install
sudo systemctl enable --now cloudflared
```

### 5. 收紧紧防火墙（关键）
```bash
# 仅保留 SSH（或仅 Tailscale 管理端口），关闭 80/443 入站
sudo ufw default deny incoming
sudo ufw allow 22/tcp          # 仅 SSH；若用 Tailscale 管理可去掉
sudo ufw enable
```
此时外部已无法直接触达 80/443，流量只走 CF 隧道。

### ⚠️ 证书（ACME）注意事项
- 关闭 80 入站后，`certbot --nginx`（HTTP-01 校验）会失败。请改用 **DNS-01** 校验，证书申请/续期都不依赖入站端口：
  ```bash
  sudo certbot certonly --dns-cloudflare \
    --dns-cloudflare-credentials /root/.secrets/cloudflare.ini \
    -d monitor.yourdomain.com
  ```
  （`cloudflare.ini` 用 CF 的 **Zone DNS 编辑** API Token 即可，非全局 API Key。）
- 或者：首次用 HTTP-01 开 80 申请证书，**成功后续期改用 DNS-01**，再关 80。

### ⚠️ 与 `auth.js` 的兼容
`auth.js` 要求 `X-Forwarded-Proto: https` 才放行 admin 操作。Cloudflare 隧道会在转发时自动带上该头，Nginx 又原样 `proxy_set_header X-Forwarded-Proto $scheme` 传给后端，**无需改代码**。

---

## 方案 2：Tailscale（零信任组网，完全不出公网）

原理：所有设备加入同一个 Tailscale 虚拟网络，通过**内网 IP / Magic DNS** 互访。VPS 可**关闭全部入站端口**，外部互联网根本找不到它。适合"只有你自己/少数设备访问"的场景。

### 1. 各设备安装 Tailscale 并加入同一 tailnet
- VPS：`curl -fsSL https://tailscale.com/install.sh | sh` 然后 `sudo tailscale up`
- 你的电脑 / 受控端同样安装并登录同一账号。

### 2. 收紧 VPS 防火墙
```bash
sudo ufw default deny incoming     # 入站全关；Tailscale 走 UDP 出站打洞，不需要开放入站
sudo ufw enable
```
Tailscale 流量经其 DERP 中继或 P2P，依赖**出站** UDP（及到 `derp.tailscale.com` 的出站），不占用入站端口。

### 3. 访问与上报都走 Tailscale 地址
- 仪表盘：浏览器打开 `http://<vps-magic-dns>:8080`（如 `http://vps-monitor.tailnet-name.ts.net:8080`）。
- 受控端 agent：把上报地址从公网域名改成 Tailscale 地址（例如 `http://vps-monitor.tailnet-name.ts.net:8080`）。
  - 若仍想用 Nginx + TLS，让 Nginx 监听 Tailscale 接口（或 `0.0.0.0`，但因无公网路由，仅 tailnet 可达），agent 用 `https://...ts.net`。
- admin token、agent token 照常填，认证逻辑不变。

### 优点 / 注意
- **源站零暴露**，连 CF 都不需要，最干净。
- 缺点：访问设备和受控端**都必须装 Tailscale 并联网**；若某台机器不在 tailnet 内就无法上报/查看。

---

## 选型速览

| 维度 | Cloudflare Tunnel | Tailscale |
|------|-------------------|-----------|
| 源站暴露 | 完全隐藏（仅出站） | 完全隐藏（仅出站 UDP） |
| 外部可访问性 | 任何能上 CF 的人（配合 token 鉴权） | 仅 tailnet 内设备 |
| 是否需要域名 | 需要 | 不需要（用 Magic DNS） |
| 适合场景 | 想用自定义域名、可能多人/多网络访问 | 纯个人、强隔离、零信任 |
| 额外依赖 | Cloudflare 账号 | Tailscale 账号（免费版够用） |

**无论选哪个，都请保留**：强 admin token、agent 独立 token、Nginx 限流、TLS。隧道只是"藏起源站 IP"，认证与授权仍是你自己兜底。
