# deepseek-harness-auth

[![CI](https://github.com/taichuy/deepseek-harness-auth/actions/workflows/ci.yml/badge.svg)](https://github.com/taichuy/deepseek-harness-auth/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/deepseek-harness-auth.svg)](https://www.npmjs.com/package/deepseek-harness-auth)

DeepSeek Harness Web profile 的树外认证 Bundle。在不修改 Harness 主仓库的条件下，它将原 WebServer 固定到 `127.0.0.1` 随机端口，并在同一进程中启动唯一的公共认证代理；HTTP、SPA 静态文件、RPC、SSE 与 WebSocket upgrade 只有通过认证后才会转发到 Harness。

## 安全模型

```text
Browser -> public Auth Proxy -> authenticated -> 127.0.0.1:<random> Harness WebServer
```

- 未初始化账号时公共代理保持 fail-closed，不生成默认账号或随机密码。
- 密码由本机拥有者手动设置；除了不能为空，不强制长度、复杂度或必须排除用户名。
- 默认白名单为空，因此本机和远程地址都必须登录；可用 CLI 添加 IP 或 CIDR。
- 认证 Bundle 固定使用 Harness 的应用内 `browse` 目录选择器，远程浏览器选择服务器工作区时不会在宿主桌面弹出 Zenity/KDialog。未安装本 Bundle 的 DSH profile 仍使用 Harness 原有的自动选择策略。
- 密码使用 Node.js `scrypt` 保存，状态目录权限为 `0700`，状态文件为 `0600`。
- 默认连续失败 6 次锁定 30 秒，同时按“IP + 用户名”和全局 IP 计数。
- 支持关闭验证码、始终验证、失败后验证；验证码短期有效且只能使用一次。
- 浏览器仅持有 HttpOnly、SameSite=Strict 的随机会话 token；账号、密码或白名单修改会撤销旧会话。
- Web 客户端在侧边栏底部提供退出登录，在设置中提供“账号与安全”页面；账号会话和白名单放行的访问者都可以管理 IP/CIDR 白名单，修改密码仍必须先验证当前密码。
- 登录页会读取同一浏览器最近一次已认证 Harness 页面保存的安全主题快照，复用 `--dsw-*` 配色和页面背景。新浏览器首次访问尚无快照时使用随系统明暗变化的 Harness 风格默认主题。
- 公网浏览器明确确认过 Harness 的同一版“内测声明”后，客户端会按完整声明文案在同源 `localStorage` 中记住确认；刷新或重新登录不再重复打扰，声明文案变化时仍会重新展示。
- 代理只接受 loopback Harness 上游，并把通过认证的上游 Host 与 Origin 改写为 loopback authority，使 Harness 的本机敏感 RPC 在认证后可用。
- HTTP 与 HTTPS 都可以使用。插件不会强制 TLS；`secureCookie` 由部署者选择。

当前兼容基线为 DeepSeek Harness `0.1.x`（`@deepseek-ai/dsh-host-webserver >=0.1.0-rc.2`）。旧 `0.0.x` WebServer 使用不同的服务名，不在支持范围内。

## 安装

发布到 npm 后：

```bash
dsh plugin --profile web add deepseek-harness-auth
dsh plugin --profile web exec dsh-auth
dsh web
```

从 GitHub 安装源码版本时，pnpm 10 会要求显式允许依赖的 `prepare` 构建脚本。按照 `dsh plugin` 输出，把 `deepseek-harness-auth: true` 加入 Web profile 的 `pnpm-workspace.yaml#allowBuilds`，然后重新执行：

```bash
dsh plugin --profile web add github:taichuy/deepseek-harness-auth#<commit>
```

首次启动前运行 `dsh-auth` 初始化账号。密码不会显示在命令行参数或 shell history 中。

## 本机管理 CLI

无参数启动类似 `xp` 的交互菜单：

```bash
dsh plugin --profile web exec dsh-auth
```

也可使用子命令：

```bash
dsh plugin --profile web exec dsh-auth status
dsh plugin --profile web exec dsh-auth init
dsh plugin --profile web exec dsh-auth whitelist list
dsh plugin --profile web exec dsh-auth whitelist add localhost
dsh plugin --profile web exec dsh-auth whitelist add 192.168.1.0/24
dsh plugin --profile web exec dsh-auth whitelist remove 192.168.1.0/24
dsh plugin --profile web exec dsh-auth whitelist clear
dsh plugin --profile web exec dsh-auth revoke
```

`localhost` 会规范化为 `127.0.0.0/8`。若前方还有反向代理，必须只把实际代理地址加入 `DSH_AUTH_TRUSTED_PROXIES`，否则不会采信客户端提供的 `X-Forwarded-For`。不要在“前置代理从 loopback 连接、但未配置 trusted proxy”的部署中放行 loopback，否则所有公网请求都会被误判为本机白名单。

## 配置

Bundle 通过环境变量提供部署配置，用户也可以在 `$DSH_HOME/profiles/web/cordis.patch.yml` 中覆盖 `auth-center`、`auth-password` 或 `auth-proxy` row 的完整 config。

| 环境变量 | 默认值 | 说明 |
|---|---:|---|
| `DSH_AUTH_HOST` | `0.0.0.0` | 公共认证代理监听地址 |
| `DSH_AUTH_PORT` | `3080` | 公共认证代理端口 |
| `DSH_AUTH_PUBLIC_URL` | 空 | 输出使用的公开 HTTP(S) URL |
| `DSH_AUTH_STATE_DIR` | `$DSH_HOME/auth` | 账号、哈希和白名单目录 |
| `DSH_AUTH_MAX_ATTEMPTS` | `6` | 锁定前最大失败次数 |
| `DSH_AUTH_LOCK_SECONDS` | `30` | 锁定秒数 |
| `DSH_AUTH_SESSION_TTL_SECONDS` | `86400` | 会话有效秒数 |
| `DSH_AUTH_CAPTCHA_MODE` | `off` | `off`、`always`、`after-failures` |
| `DSH_AUTH_CAPTCHA_AFTER_FAILURES` | `3` | 失败后验证码的触发次数 |
| `DSH_AUTH_SECURE_COOKIE` | `false` | 是否给 Cookie 添加 `Secure` |
| `DSH_AUTH_TRUSTED_PROXIES` | 空 | 逗号分隔的代理 IP/CIDR |

示例：

```bash
DSH_AUTH_PORT=8080 \
DSH_AUTH_CAPTCHA_MODE=after-failures \
DSH_AUTH_PUBLIC_URL=http://server.example:8080 \
dsh web
```

原 Harness `--host`、`--port` 不再代表公共入口：Bundle 会把它的内部 WebServer 固定为 `127.0.0.1:0`，公共监听由上表配置。

## 认证提供方架构

`deepseek-harness-auth/center` 提供 `ctx.authCenter` 和 provider registry；`deepseek-harness-auth/password` 是当前内置 provider。每种未来认证方式可以作为独立 Cordis row 注册并通过 profile patch 单独挂载、禁用或替换，不需要修改 Auth Proxy。

登录所需的 `/auth/login` 与 `/auth/captcha` 是未认证公共端点。其余请求未命中 IP 白名单且没有有效会话时统一拒绝；HTML navigation 重定向到登录页，API 返回 401，WebSocket upgrade 返回 401。

认证后的客户端还使用以下同源端点：

- `GET /auth/account`：返回账号会话或 IP 白名单访问方式。
- `PUT /auth/account/whitelist`：替换内置 provider 的 IP/CIDR 白名单；账号会话或已命中白名单的访问者均可调用，修改后撤销旧会话。
- `POST /auth/account/password`：验证当前密码并修改新密码，成功后撤销全部会话；只接受账号会话和带 `X-DSH-Auth-Request: 1` 的 JSON 请求。
- `POST /auth/logout`：撤销当前会话并清理 Cookie。

登录页本身不能在未认证前读取 Harness 的受保护设置，因此任意第三方皮肤只能在该浏览器至少成功进入过一次 Harness 后同步到后续登录页；这不会为了主题展示而开放 Harness API。

## 开发与验证

```bash
corepack enable
pnpm install
pnpm run check
```

测试覆盖密码状态、权限、Web 密码修改、IP/CIDR、验证码、失败锁定、会话撤销、白名单热更新、登录主题脚本、客户端 Bundle、HTTP 代理、Host 改写和 upgrade 拒绝。

## 版本与 npm 发布

版本以 `package.json#version` 为唯一来源，遵循 SemVer：

```bash
pnpm version patch   # 或 minor / major
git push origin main
```

`.github/workflows/publish.yml` 只在 `main` 上检测到版本变化时尝试发布。它会先执行完整检查并查询 npm；相同版本已存在时安全跳过。仓库尚未配置 `NPM_TOKEN` 时也会成功跳过发布，不会阻塞主分支。配置 secret 后，可手动运行一次 **Publish npm** workflow 发布当前尚未存在的版本；后续版本变化会自动发布并创建对应 Git tag 与 GitHub Release。

需要的仓库 secret：

- `NPM_TOKEN`：对 `deepseek-harness-auth` 具有 publish 权限的 npm automation/access token。

---

## Friend Links

- [Linux.do](https://linux.do/) - 学AI ，上L站
- [deepseek-harness](https://github.com/deepseek-ai/deepseek-harness/) - 一切接插件，自由!!!
- [dsh-web-ui](https://github.com/zhu1090093659/dsh-web-ui) - 好看的dsh web ui

---

## License

This project is licensed under the [Apache-2.0](LICENSE) open-source license.

---
