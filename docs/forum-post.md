# 哪吒漏洞之后，自己搓了个探针 simple-probe，分享下思路

各位大佬好，

之前发过一篇[哪吒漏洞攻击全记录](https://www.nodeseek.com/post-786371-1)，复盘了从入侵到清理的过程。清理完十几台 VPS 之后一直在想一个问题：我只是想看个 CPU、内存、流量，为什么受控端要有远程命令执行的能力？

哪吒被攻破的路径是 Dashboard 漏洞直接向所有 Agent 下发命令，Agent 跑着 root 权限，一条指令下去机器就不是你的了。后来又看了一圈其他探针项目，发现也都有指令通道——WebSocket 下行、gRPC 双向、任务队列，形式不同但本质一样：服务端能控制 Agent。

我个人比较在意这个点，所以自己写了个简单的：**simple-probe**。

## 思路

受控端 Docker 跑着，只往外发 HTTPS 数据，不开入站端口，服务端只收数据不做控制。

```
[受控VPS] docker agent ──HTTPS+Token──→ [专用VPS: 仪表盘+告警]
```

没有 WebSocket，没有 gRPC 双向，没有任务下发。服务端没有任何机制能影响 Agent 行为，代码里不存在下行通道。

## 安全方面的一些考虑

- **受控端零入站** —— 不开端口，不暴露公网，NAT/内网也能用
- **无指令通道** —— Agent 只往服务端 POST 数据，不存在从服务端到 Agent 的通信路径
- **不采指纹** —— 只采 CPU/内存/硬盘/负载/流量/温度/Swap/开机时长，不碰内核版本、GPU、公网 IP 这些
- **Agent 之间互不可知** —— 每个 Agent 只知道自己的 Server 地址和 Token，不存在节点间通信

比较在意的一点是：**攻击者无论打穿服务端还是任意一台被控端，都不会影响到其他小鸡。**

- 服务端被打穿 → 只能看到一堆 CPU 百分比，拿不到机器指纹，没法下发命令
- 单台被控端被打穿 → 其他节点不受影响，因为 Agent 之间没有任何通信

哪吒的问题是服务端是"指挥中心"，打穿一个全灭。simple-probe 服务端只是个收数据的，被打穿了也就丢点监控数据。当然这不代表 simple-probe 就安全了，只是把攻击面尽量缩小了。

## 功能

比较基础，够自己用：

- 仪表盘：在线/离线概览、CPU/内存/负载/流量图表（ECharts，本地化无 CDN）
- 客户端卡片：状态、商家、到期倒计时、月流量配额、备注
- 网络质量自测：本机 ping 运营商 DNS + 8.8.8.8 的延迟（目标写死在本地配置）
- 告警：离线、CPU/内存超阈值推 QQ 邮箱 + Telegram
- TOTP 两步验证、只读 Token、Prometheus /metrics 导出
- 公开状态页（可开关）、可插拔主题皮肤
- Linux Docker + Windows 原生双受控端
- 一键安装脚本

## 技术栈

服务端 Node.js + SQLite + ECharts，受控端 Python，全程 Docker。依赖不多，256MB 内存的小鸡也能跑。

## 部署

```bash
curl -fsSL https://raw.githubusercontent.com/fengzone85/diting/master/install.sh -o install.sh
chmod +x install.sh
sudo ./install.sh
```

按菜单走，服务端配好 Nginx + TLS，受控端填 Token 启动。

## 地址

项目仓库：https://github.com/fengzone85/diting

## 最后

初衷就是自己用，哪吒出事之后不想再装带远程命令通道的探针了。代码水平一般，安全方面也只是在能力范围内做了些处理，可能还有没考虑到的地方。

发出来是觉得可能有朋友有同样的顾虑，可以参考下思路。有问题或建议欢迎提 issue 或回帖，都很欢迎。

比较想听几个方面的意见：
1. 安全设计上有没有遗漏的场景
2. UI 还有哪些可以改进的
3. 还缺哪些不破坏安全边界但比较实用的功能

感谢各位大佬的时间。
