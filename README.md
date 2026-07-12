# b8im-web

b8im 普通用户 Web 客户端。界面沿用 `b8im-ui/b8im/web` 的绿色 IM 设计，运行时使用真实 Server API 和 IM WebSocket，不包含 mock 数据、mock API 或远程 JavaScript 模块加载。

## 本机运行

要求 Node.js 20.19+、pnpm 11.5.1。

```bash
cp .env.example .env
pnpm install --frozen-lockfile
pnpm dev
```

默认地址为 `http://127.0.0.1:16988`。生产构建：

```bash
pnpm build
pnpm preview
```

`dist/` 是本地产物，不提交 Git。部署时需要把 `/announcements` 等直接 URL 回退到 `index.html`；客户端本身同时支持 `#/announcements`。

## 租户发现契约

发现服务由 `VITE_DISCOVERY_BASE_URL` 配置，只调用 `GET /saimulti/appInfo`：

- 域名模式：`?mode=domain&domain=<当前 hostname>`
- 企业码模式：`?enterprise_code=<企业码>`

`VITE_PLATFORM_DEFAULT_HOSTS` 配置平台默认入口域名（逗号分隔）。命中的 host 不执行域名租户发现，而是展示企业码输入入口；URL 中的 `enterprise_code` 优先于本地缓存。客户端只在 `appInfo` 响应完成结构、线路版本和 Ed25519 签名校验后缓存企业码，后续再次访问同一平台 host 时自动加载；明确失败、非法或未验签的响应不会写入缓存。

发现请求不发送 cookie、token 或 `App-Id`。响应必须是 `{code: 200, data: appInfo}`，其中 `appInfo` 至少包含：

```json
{
  "organization": 1,
  "deployment_id": "b8im-local",
  "enterprise_code": "acme",
  "config_version": 1,
  "updated_at": "2026-07-10T10:00:00+08:00",
  "site_name": "ACME IM",
  "logo": "https://example.com/logo.png",
  "favicon": "https://example.com/favicon.ico",
  "server_info": {
    "api_server_url": "https://api.example.com",
    "im_server_url": "wss://im.example.com/ws",
    "upload_server_url": "https://upload.example.com",
    "web_server_url": "https://im.example.com"
  }
}
```

客户端会校验 `organization`、`deployment_id`、URL scheme、host 和 URL 凭据。生产目标只接受 HTTPS/WSS，本机回环地址允许 HTTP/WS。发现失败或响应非法时失败关闭，不使用默认 organization、旧字段或缓存配置继续进入业务链路。

发现成功后，所有业务 HTTP 请求只发往 `server_info.api_server_url`，自动携带：

```text
App-Id: <appInfo.organization>
Authorization: Bearer <目标 API 签发的 access token>
```

请求明确使用 `credentials: omit`，不会把发现服务的 cookie/token 转发到目标 API。IM 只连接 `server_info.im_server_url`，AUTH 使用目标 API 签发的短期 IM token。登录会话按当前浏览器窗口和 `organization` 隔离；登录后 UI 不能切换机构。

## 客户端配置与固定模块

登录后调用：

```text
GET /saimulti/client/config?client_family=web
App-Id: <organization>
Authorization: Bearer <access token>
```

唯一支持的响应结构为：

```json
{
  "version": 1,
  "organization": 1,
  "deployment_id": "b8im-local",
  "features": { "announcement": true },
  "modules": [
    {
      "module_key": "announcement",
      "version": "1.0.0",
      "available": true,
      "capabilities": ["announcement.web.page"],
      "permissions": ["saimulti:web:announcement:index"]
    }
  ],
  "tabbar": [{ "module_key": "announcement", "title": "公告" }]
}
```

本地固定注册表位于 `src/services/clientModules.ts`。公告入口只有在 `available=true`、包含 `announcement.web.page`，且可选 `features.announcement` 未关闭时才显示。未知 `module_key` 和 tabbar 类型会记录告警并忽略；服务端不能下发组件路径、脚本或任意动作供客户端执行。

直接访问 `/announcements` 或 `#/announcements` 会先执行同一模块守卫。模块不可用时显示无权限状态，不渲染页面。Server 仍需在每个公告 API 上执行 organization、登录用户、模块和权限校验，前端隐藏入口不是授权依据。

## 公告 API

路径统一定义在 `src/config/apiPaths.ts`：

- `GET /saimulti/web/announcement/index?page=1&limit=50`
  - `data={list:[{id,title,summary,published_at}],total}`
- `GET /saimulti/web/announcement/read?id=<id>`
  - `data={id,title,summary,content,published_at}`

公告正文按纯文本展示，不执行服务端 HTML。接口返回 401/403 时页面显示无权限状态；网络错误、空列表和详情错误都有独立状态及重试入口。

## 验证

```bash
pnpm typecheck
pnpm build
git diff --check
```

真实联调还需启动 `b8im-server` 与 IM 进程，确认 appInfo、client/config、登录、公告列表/详情和 WebSocket AUTH/SYNC/SEND 全链路可用。
