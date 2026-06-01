# Other Computer Codex Relay Setup

这份说明给另一台电脑上的 Codex 执行。目标是让另一台电脑的本地 `intent-broker` 加入同一个 Cloudflare Relay room，从而和这台电脑跨机器收发 broker 事件。

## 已部署信息

- Relay HTTP origin: `https://intent-broker-relay.kaisersongsk.workers.dev`
- Relay WebSocket URL: `wss://intent-broker-relay.kaisersongsk.workers.dev/ws`
- GitHub OAuth client id: `Ov23liTyGMaL8ZKE8WTF`
- `roomSecret`: 需要由用户从第一台电脑的 `/Users/song/projects/intent-broker/intent-broker.local.json` 复制给你。不要把它打印到最终回复里，也不要提交到 git。

## 成功标准

- `relay status` 显示 GitHub token valid。
- 本地 broker `/health` 返回 `ok: true`。
- broker 日志出现 `[relay-adapter] connected to relay`。
- 两台电脑能互相看到或收到一条 `intent-broker note` smoke 消息。

## 1. 准备代码

进入 repo：

```bash
cd /Users/song/projects/intent-broker
```

安装依赖：

```bash
npm install
```

确认当前代码已经支持把 `relay` 配置传给 broker runtime：

```bash
rg -n "relay:" src/config/load-config.js
```

如果没有命中，先让 Codex 按下面的意图补一个最小修复：`mergeConfig()` 要合并 `relay`，`loadIntentBrokerConfig()` 的返回值要包含 `relay`，并保留 `enabled: Boolean(relay.enabled)`。补完后跑：

```bash
npm test -- tests/config/load-config.test.js
```

## 2. 写入本机私有配置

编辑 `/Users/song/projects/intent-broker/intent-broker.local.json`。保留已有内容，并加入同级 `relay` 块：

```json
{
  "relay": {
    "enabled": true,
    "url": "wss://intent-broker-relay.kaisersongsk.workers.dev/ws",
    "roomSecret": "<由用户提供的第一台电脑 roomSecret>"
  }
}
```

如果文件里已经有 `channels` 等字段，不要覆盖它们，只增加同级 `relay` 字段。`intent-broker.local.json` 已被 `.gitignore` 忽略，适合放本机 secret。

验证配置加载结果，不要打印 secret：

```bash
node --experimental-sqlite -e "import('./src/config/load-config.js').then(({loadIntentBrokerConfig}) => { const c = loadIntentBrokerConfig({ cwd: process.cwd(), env: {} }); console.log(JSON.stringify({ enabled: c.relay?.enabled, url: c.relay?.url, hasRoomSecret: Boolean(c.relay?.roomSecret) }, null, 2)); })"
```

期望输出里 `enabled` 为 `true`，`url` 是上面的 `/ws` 地址，`hasRoomSecret` 为 `true`。

## 3. 登录 Relay

先确认 Worker 可达：

```bash
node -e "fetch('https://intent-broker-relay.kaisersongsk.workers.dev/health').then(async r => { console.log(r.status); console.log(await r.text()); })"
```

启动 GitHub device login：

```bash
RELAY_AUTH_URL=https://intent-broker-relay.kaisersongsk.workers.dev \
RELAY_GITHUB_CLIENT_ID=Ov23liTyGMaL8ZKE8WTF \
node --experimental-sqlite src/cli.js relay login github
```

按终端提示打开 GitHub device 页面，输入 code，并授权 `Intent Broker Relay`。授权范围应是只读个人资料和邮箱。

登录后检查 token：

```bash
RELAY_AUTH_URL=https://intent-broker-relay.kaisersongsk.workers.dev \
RELAY_GITHUB_CLIENT_ID=Ov23liTyGMaL8ZKE8WTF \
node --experimental-sqlite src/cli.js relay status
```

期望看到：

```text
Provider: github
Token: valid
```

## 4. 启动并验证 Broker

重启 broker：

```bash
npm run broker:restart
```

验证本地 health：

```bash
curl -sS http://127.0.0.1:4318/health
```

期望包含：

```json
{"ok":true,"status":"healthy"}
```

看 relay 日志：

```bash
tail -n 120 .tmp/broker.stdout.log
```

期望看到：

```text
intent-broker relay: connecting to wss://intent-broker-relay.kaisersongsk.workers.dev/ws
[relay-adapter] WebSocket connected, waiting for hello
[relay-adapter] connected to relay
```

如果在 Codex 沙箱里 `npm run broker:status` 误报 `stopped`，但下面两条正常，以这两条为准：

```bash
curl -sS http://127.0.0.1:4318/health
lsof -nP -iTCP:4318 -sTCP:LISTEN
```

## 5. 注册当前 Codex 并做跨电脑 Smoke Test

在第二台电脑注册当前 Codex：

```bash
intent-broker register
intent-broker who
```

让用户在第一台电脑也运行：

```bash
intent-broker who
```

两边各自记下对方的 participant id 或 alias。然后从第二台电脑发一条 note 给第一台电脑：

```bash
intent-broker note <第一台电脑participantId或alias> relay-smoke-001 relay-thread-001 "relay smoke from second computer"
```

第一台电脑检查：

```bash
intent-broker inbox
```

再从第一台电脑反向发一条 note 给第二台电脑：

```bash
intent-broker note <第二台电脑participantId或alias> relay-smoke-002 relay-thread-002 "relay smoke from first computer"
```

第二台电脑检查：

```bash
intent-broker inbox
```

两边都能收到对方的 note，就说明跨电脑 broker 通讯验证通过。

## 交付回复格式

完成后只汇报摘要，不要贴 secret：

```text
已完成第二台电脑 relay 配置。
- relay status: Token valid, provider github
- local health: ok/healthy
- relay log: connected to relay, peers=<数字>
- smoke test: 已从第二台发到第一台，并从第一台收到回包
```
