# Intent Broker Relay 部署指南（Computer Use 步骤）

## 前置条件

- 已登录 GitHub（浏览器）
- 已登录 Google Cloud Console（浏览器）
- 终端已安装 wrangler：`cd ~/projects/intent-broker-relay && npm install`
- 已登录 Cloudflare：`npx wrangler login`（如未登录）

---

## Step 1: 注册 GitHub OAuth App

### 1.1 打开浏览器
URL: `https://github.com/settings/developers`

### 1.2 点击 "OAuth Apps" 标签页

### 1.3 点击 "New OAuth App" 按钮（或 "Register a new application"）

### 1.4 填写表单
| 字段 | 值 |
|------|-----|
| Application name | `Intent Broker Relay` |
| Homepage URL | `https://github.com/kaisersong/intent-broker` |
| Application description | （可选）`Cross-machine relay service for intent-broker` |
| Authorization callback URL | `https://github.com/login/device` |

### 1.5 点击 "Register application"

### 1.6 记录 Client ID
页面顶部会显示 **Client ID**（类似 `Iv1.abc123def456`）。
→ 保存为 `GITHUB_CLIENT_ID`

### 1.7 生成 Client Secret
点击 "Generate a new client secret" 按钮。
→ 保存为 `GITHUB_CLIENT_SECRET`（只显示一次！）

### 1.8 启用 Device Flow
在同一个 App 设置页面，找到 "Device Flow" 选项：
- 勾选 ☑ **"Enable Device Flow"**
- 点击 "Update application" 保存

---

## Step 2: 注册 Google OAuth App

### 2.1 打开浏览器
URL: `https://console.cloud.google.com/apis/credentials`

### 2.2 选择或创建项目
- 如果顶部项目选择器中没有合适项目，点击 "New Project"
- 项目名：`intent-broker-relay`
- 点击 "Create"
- 等待创建完成，选中该项目

### 2.3 配置 OAuth consent screen（如未配置）
- 左侧菜单点击 "OAuth consent screen"
- User type: 选择 **External**
- 点击 "Create"
- 填写：
  - App name: `Intent Broker Relay`
  - User support email: 选择你的邮箱
  - Developer contact email: 填你的邮箱
- 点击 "Save and Continue" 直到完成（Scopes 和 Test users 可跳过）

### 2.4 创建 OAuth 凭证
- 左侧菜单点击 "Credentials"
- 顶部点击 "+ CREATE CREDENTIALS" → "OAuth client ID"
- Application type: **TVs and Limited Input devices**
- Name: `Intent Broker Relay`
- 点击 "Create"

### 2.5 记录凭证
弹窗会显示：
→ 保存 **Client ID** 为 `GOOGLE_CLIENT_ID`
→ 保存 **Client secret** 为 `GOOGLE_CLIENT_SECRET`

---

## Step 3: 生成 JWT Signing Key

在终端执行：

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

→ 保存输出为 `JWT_SIGNING_KEY`（64字符十六进制字符串）

---

## Step 4: 配置 Wrangler Secrets

在终端中逐一执行（每次会提示输入 secret 值）：

```bash
cd ~/projects/intent-broker-relay

# 输入 Step 3 生成的 64 字符 hex 字符串
npx wrangler secret put JWT_SIGNING_KEY

# 输入 Step 1.6 的值
npx wrangler secret put GITHUB_CLIENT_ID

# 输入 Step 1.7 的值
npx wrangler secret put GITHUB_CLIENT_SECRET

# 输入 Step 2.5 的 Client ID
npx wrangler secret put GOOGLE_CLIENT_ID

# 输入 Step 2.5 的 Client Secret
npx wrangler secret put GOOGLE_CLIENT_SECRET
```

注意：如果 wrangler 提示选择账号或项目，选择你的 Cloudflare 账号。

---

## Step 5: 部署

```bash
cd ~/projects/intent-broker-relay
npx wrangler deploy
```

成功后会输出类似：
```
Published intent-broker-relay (x.xx sec)
  https://intent-broker-relay.<your-subdomain>.workers.dev
```

记录这个 URL，这就是 relay 服务地址。

---

## Step 6: 验证部署

```bash
# 健康检查
curl https://intent-broker-relay.<your-subdomain>.workers.dev/health
```

预期返回：
```json
{"status":"ok","version":"0.1.0","timestamp":"..."}
```

---

## Step 7: 配置本地 Broker 使用 Relay

编辑 `~/projects/intent-broker/intent-broker.local.json`，添加：

```json
{
  "relay": {
    "enabled": true,
    "url": "wss://intent-broker-relay.<your-subdomain>.workers.dev/ws",
    "roomSecret": "<至少32字符的随机字符串，两台电脑共享同一个>"
  }
}
```

生成 roomSecret：
```bash
node -e "console.log(require('crypto').randomBytes(24).toString('base64url'))"
```

---

## 汇总：需要保存的值

| 变量 | 来源 | 用途 |
|------|------|------|
| `GITHUB_CLIENT_ID` | Step 1.6 | wrangler secret |
| `GITHUB_CLIENT_SECRET` | Step 1.7 | wrangler secret |
| `GOOGLE_CLIENT_ID` | Step 2.5 | wrangler secret |
| `GOOGLE_CLIENT_SECRET` | Step 2.5 | wrangler secret |
| `JWT_SIGNING_KEY` | Step 3 | wrangler secret |
| Relay URL | Step 5 输出 | broker config |
| Room Secret | Step 7 生成 | broker config（共享） |

---

## 注意事项

- GitHub Device Flow 必须在 OAuth App 设置中勾选启用，否则 Device Code 请求会返回 404
- Google "TVs and Limited Input devices" 类型天然支持 Device Flow，无需额外配置
- `wrangler secret put` 是交互式的，每次只输入一个值然后回车
- 如果 wrangler 报错 "no account"，先运行 `npx wrangler login` 在浏览器授权
- 部署后如需更新代码，再次运行 `npx wrangler deploy` 即可
