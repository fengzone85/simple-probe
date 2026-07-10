---
title: TOTP 2FA
description: 启用与管理双因素认证
---

# TOTP 双因素认证

Simple Probe 支持 TOTP（Time-based One-Time Password，RFC 6238），兼容所有标准 TOTP 应用。

## 兼容的应用

| 应用 | 平台 |
|---|---|
| Google Authenticator | iOS / Android |
| Microsoft Authenticator | iOS / Android |
| 1Password | 全平台 |
| Authy | iOS / Android |
| KeePassXC | 桌面 |

## 启用 2FA

1. 登录管理面板
2. 进入 **设置 → 安全**
3. 点击「启用 2FA」
4. 用 TOTP 应用扫描二维码
   - 或手动输入 Base32 密钥
5. 输入应用显示的 6 位验证码确认

启用后，每次登录需同时输入 Token 和动态验证码。

## 登录流程

```
用户输入 Token + 6位动态码
        │
        ▼
   恒定时间比较 Token
        │
        ├── 失败 → 退避 600 秒
        │
        ▼
   验证 TOTP 动态码 (RFC 6238)
        │
        ├── 失败 → 退避 600 秒
        │
        ▼
   签发 HttpOnly Session Cookie
```

## 丢失 2FA 设备

启用 2FA 时会生成一次性重置 Token。使用该 Token 可以绕过 2FA 登录一次：

1. 使用 Token + 重置 Token 登录
2. 立即重新设置 2FA
3. 旧重置 Token 作废，生成新的

> ⚠️ **重置 Token 请离线保存**（如打印、密码管理器）。丢失后只能通过数据库直接操作。

## 强制 2FA

Simple Probe 默认推荐但非强制 2FA。如需强制：

1. 在设置中开启「强制 2FA」
2. 所有管理员登录必须提供动态码
3. 无法绕过（除非使用重置 Token）
