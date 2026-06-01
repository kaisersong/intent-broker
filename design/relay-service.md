# Intent-Broker Relay Service Design

## 1. Overview

A lightweight, stateless WebSocket relay that enables cross-machine broker collaboration.
Each machine runs its own local broker; relay only forwards events between brokers in the same room.

```
Broker A ──WebSocket──► Relay (CF Workers / Fly.io) ◄──WebSocket── Broker B
   │                         │                              │
   └── local agents          └── no persistence             └── local agents
```

**Design principles:**
- Relay is a dumb pipe: no business logic, no event interpretation
- All intelligence stays in the local broker
- Fail-open locally: relay down = local collaboration continues, cross-machine paused
- Zero trust between peers: relay validates tokens, brokers validate events

---

## 2. Project Structure & Relationships

### 2.1 Two Repositories

```
intent-broker/              ← 现有项目（开源，MIT）
  本地 broker + 所有 agent 适配器
  新增: relay 客户端适配器 + 协议定义

intent-broker-relay/        ← 新项目（私有，托管服务）
  Cloudflare Workers 部署的 relay 服务端
  OAuth 认证、房间管理、限流、监控
```

### 2.2 职责划分

| 关注点 | intent-broker | intent-broker-relay |
|--------|---------------|---------------------|
| 角色 | 本地 agent 协调引擎 | 公网事件中继服务 |
| 运行环境 | 用户本机 (Node.js) | Cloudflare Workers |
| 部署方式 | `npm install -g` / `npx` | `wrangler deploy` (你维护) |
| 开源策略 | MIT 开源 | 私有（托管 SaaS） |
| 敏感信息 | 无 | OAuth App secrets, JWT signing key |
| 用户数据 | 仅本地 SQLite | 用户账号、用量计数 |
| 版本节奏 | 按功能发版 | 按运维/安全发版 |
| 依赖关系 | 不依赖 relay（relay 不可用时正常工作） | 不依赖 broker（无业务逻辑） |

### 2.3 代码分布

**intent-broker（现有项目新增）:**
```
src/
  relay/
    protocol.js         ← 协议常量: message types, envelope schema, version
    relay-adapter.js    ← Relay 客户端: WebSocket 连接、发送、接收、去重
    credential-store.js ← 读写 ~/.intent-broker/credentials
  cli.js                ← 新增 `relay login/logout/status` 子命令
```

**intent-broker-relay（新项目）:**
```
src/
  worker.js             ← CF Worker 入口: HTTP routing, WebSocket upgrade
  room.js               ← Durable Object: 房间状态、连接管理、广播
  auth/
    device-flow.js      ← OAuth Device Flow (GitHub + Google)
    jwt.js              ← JWT 签发与验证
    providers.js        ← OAuth provider 配置
  rate-limit.js         ← Token bucket per user/room
  health.js             ← /health, /health/ready
wrangler.toml           ← CF 部署配置
.dev.vars.example       ← OAuth secrets 模板
package.json            ← 依赖: jose (JWT), itty-router
```

### 2.4 协议共享策略

协议定义（message types, envelope format）以 **intent-broker 为源头**:

- `intent-broker/src/relay/protocol.js` 是 single source of truth
- `intent-broker-relay` 通过以下方式引用:
  - **MVP:** 直接 copy（文件小，几十行常量）
  - **未来:** 抽为 `@intent-broker/relay-protocol` npm 包（当协议稳定后）

版本兼容由 `protocolVersion` 字段保证，两端独立发版。

### 2.5 依赖方向

```
intent-broker-relay
       │
       │ imports protocol constants (copy or npm pkg)
       │
       ▼
intent-broker/src/relay/protocol.js (source of truth)
       ▲
       │
       │ imports
       │
intent-broker/src/relay/relay-adapter.js
```

两个项目之间 **无运行时依赖**：
- broker 启动时不需要 relay 存在
- relay 运行时不需要知道任何 broker 的实现细节
- 唯一共享的是协议常量（编译时/复制时依赖）

---

## 3. Protocol Design

### 3.1 Connection Handshake

```
Client → Relay:
  GET /ws
  Authorization: Bearer <relay-jwt>
  X-Room-Id: <sha256(roomSecret)[0:16]>
  X-Broker-Id: <broker-uuid>
  X-Broker-Version: 0.4.0
  X-Protocol-Version: 1
  Upgrade: websocket

Relay → Client (on success):
  HTTP 101 Switching Protocols
  
  First message (JSON):
  {
    "type": "relay:hello",
    "relayVersion": "1.0.0",
    "protocolVersion": 1,
    "latestBrokerVersion": "0.5.2",
    "minBrokerVersion": "0.4.0",
    "connectedPeers": 2,
    "rateLimit": { "eventsPerMinute": 120, "burstSize": 20 },
    "plan": { "name": "free", "eventsRemaining": 847 },
    "seq": 12345
  }

Relay → Client (on rejection):
  HTTP 401 { "error": "invalid_jwt", "detail": "expired" }
  HTTP 402 { "error": "quota_exceeded", "detail": "max 3 rooms on free plan" }
  HTTP 426 { "error": "upgrade_required", "minVersion": "0.5.0" }
  HTTP 429 { "error": "rate_limited", "retryAfterMs": 5000 }
  HTTP 403 { "error": "room_full", "maxPeers": 10 }
```

Note: Credentials in headers only, never in URL query string (prevents leakage via logs).

### 3.2 Room Identity

```
roomId = sha256(roomSecret)[0:16]
```

- `roomSecret`: user-generated secret (min 32 chars), shared between collaborating machines
- Room ID is opaque to relay (relay cannot reverse hash to recover secret)
- Same secret on multiple machines → same roomId → same room
- Secret never transmitted to relay; only derived roomId is sent

### 3.3 Message Envelope

All messages between relay and broker use this envelope:

```json
{
  "type": "relay:event",
  "protocolVersion": 1,
  "messageId": "uuid-v4",
  "timestamp": 1703123456789,
  "payload": {
    "intentId": "codex.session-abc-request_task-1703123456-x7k2",
    "kind": "request_task",
    "fromParticipantId": "codex.session-abc",
    "taskId": "task-123",
    "threadId": "thread-456",
    "payloadJson": { ... },
    "originBrokerId": "broker-a-uuid",
    "originEventId": 42
  }
}
```

### 3.4 Control Messages

```json
// Client → Relay: Ping (keepalive)
{ "type": "relay:ping", "ts": 1703123456789 }

// Relay → Client: Pong
{ "type": "relay:pong", "ts": 1703123456789, "serverTs": 1703123456790 }

// Relay → Client: Rate limit warning
{ "type": "relay:rate_warning", "remaining": 5, "resetMs": 30000 }

// Relay → Client: Peer joined/left
{ "type": "relay:peer_joined", "peerId": "broker-b-uuid", "peerCount": 3 }
{ "type": "relay:peer_left", "peerId": "broker-b-uuid", "peerCount": 2 }

// Relay → Client: Version notification (non-blocking)
{ "type": "relay:version_notice", "latest": "0.5.2", "changelog": "..." }

// Client → Relay: Explicit close
{ "type": "relay:bye" }
```

### 3.5 Protocol Versioning Rules

| Rule | Description |
|------|-------------|
| Only additive changes within same protocolVersion | New fields OK, removing/renaming fields = new version |
| Unknown fields MUST be ignored by receiver | Forward-compatible parsing |
| Unknown event kinds stored but not routed locally | Future-proof |
| Relay broadcasts protocolVersion mismatch as warning | Does not disconnect |
| Hard disconnect only when protocolVersion < relay's minProtocolVersion | Graceful degradation |

---

## 4. Authentication & Authorization

### 4.1 Two-Layer Auth Model

```
Layer 1: User Identity (who are you?)
  → GitHub / Google OAuth → relay JWT
  → Controls: service access, rate limits, billing, abuse tracing

Layer 2: Room Authorization (which room?)
  → roomSecret shared between collaborating machines
  → Controls: room isolation, peer membership
```

Both layers are required. User JWT proves identity to relay; roomSecret proves membership to room.

### 4.2 User Registration & Login (Device Flow)

**No web pages needed.** Uses OAuth 2.0 Device Authorization Grant.

```bash
$ intent-broker relay login

? Choose login method:
  ❯ GitHub
    Google

! First, copy your one-time code: ABCD-1234
→ Press Enter to open github.com in your browser...

# User authorizes on GitHub/Google's own page
# CLI polls for token completion

✓ Authenticated as @songkai (github|12345)
  Plan: Free (3 rooms, 1000 events/day)
  Token saved to ~/.intent-broker/credentials
```

**Why Device Flow:**
- No relay web page needed (Phase 1: zero frontend)
- Works over SSH (remote machine login, local browser auth)
- User sees GitHub/Google's trusted UI, not ours
- One-time operation, token persisted locally

**Provider details:**

| | GitHub | Google |
|--|--------|--------|
| Device Auth URL | `github.com/login/device/code` | `oauth2.googleapis.com/device/code` |
| Token URL | `github.com/login/oauth/access_token` | `oauth2.googleapis.com/token` |
| User Info | `api.github.com/user` | `www.googleapis.com/oauth2/v2/userinfo` |
| Scope | `read:user user:email` | `openid email profile` |
| Identity key | `github\|<user_id>` | `google\|<sub>` |

### 4.3 Relay JWT

After OAuth completes, relay issues its own JWT:

```json
{
  "sub": "github|12345",
  "email": "song@example.com",
  "plan": "free",
  "limits": {
    "maxRooms": 3,
    "eventsPerDay": 1000,
    "maxPeersPerRoom": 5
  },
  "iat": 1703123456,
  "exp": 1703727856  // 7 days
}
```

- JWT signed with relay's ed25519 key (not shared)
- Refresh: CLI auto-refreshes before expiry using stored OAuth refresh token
- Stored at: `~/.intent-broker/credentials` (file mode 0600)

### 4.4 Account Linking

Same email from different providers → same user identity:

```
github|12345 (email: song@example.com)
google|67890 (email: song@example.com)
  → unified user: user_abc123
```

Linking is automatic by email match. Users can unlink in future dashboard.

### 4.5 Room Authorization

Separate from user identity. Room access controlled by shared secret:

```json
// intent-broker.config.json
{
  "relay": {
    "url": "wss://relay.intent-broker.dev",
    "roomSecret": "my-shared-secret-min-32-chars"
  }
}
```

```
roomId = sha256(roomSecret)[0:16]   // opaque to relay
```

- roomSecret never transmitted to relay (unlike previous design)
- Client sends `roomId` (hash) to relay; relay routes by roomId
- Room membership = knowing the secret = can derive the roomId
- Relay cannot reverse roomId back to secret

### 4.6 Connection Auth Flow

```
Client → Relay:
  GET /ws
  Authorization: Bearer <relay-jwt>
  X-Room-Id: <sha256(roomSecret)[0:16]>
  X-Protocol-Version: 1
  X-Broker-Version: 0.4.0
  Upgrade: websocket

Relay validates:
  1. JWT signature & expiry → 401 if invalid
  2. User plan limits (room count, connection count) → 402 if exceeded
  3. Room peer count → 403 if room full
  4. Rate limit state → 429 if throttled
  5. Protocol version → 426 if too old

Relay → Client (101 Switching Protocols):
  First message:
  {
    "type": "relay:hello",
    "relayVersion": "1.0.0",
    "protocolVersion": 1,
    "latestBrokerVersion": "0.5.2",
    "minBrokerVersion": "0.4.0",
    "connectedPeers": 2,
    "rateLimit": { "eventsPerMinute": 120, "burstSize": 20 },
    "plan": { "name": "free", "eventsRemaining": 847 }
  }
```

**Note:** JWT in `Authorization` header, not query string. Fixes the credential-in-URL leak from adversarial review.

### 4.7 Security Properties

| Property | Mechanism |
|----------|-----------|
| User identity | OAuth (GitHub/Google) → relay JWT |
| Room isolation | roomId = hash(roomSecret); relay routes by roomId; secret never leaves client |
| Abuse tracing | JWT sub identifies user; enables ban/throttle per account |
| Confidentiality | WSS (TLS) for transport |
| Credential storage | `~/.intent-broker/credentials` mode 0600 |
| Token refresh | Auto-refresh JWT via OAuth refresh token before expiry |
| Replay protection | messageId dedup + relay-assigned monotonic sequence per room |

### 4.8 Plan & Quotas

| | Free | Pro (future) |
|--|------|------|
| Rooms | 3 | Unlimited |
| Events/day | 1,000 | 100,000 |
| Peers/room | 5 | 20 |
| Message size | 16 KB | 64 KB |
| Catch-up buffer | None | 30 min |
| Priority | Best-effort | Guaranteed |
| Price | $0 | TBD |

### 4.9 Token Lifecycle

```
OAuth refresh token → stored in ~/.intent-broker/credentials
  ↓ (auto, before JWT expiry)
Relay JWT → 7 day lifetime, auto-refreshed by CLI
  ↓ (on each WebSocket connect)
WebSocket connection authenticated

Revocation:
  - User: `intent-broker relay logout` → delete local credentials
  - Admin: revoke user in relay DB → JWT rejected on next connect
  - OAuth: user revokes app in GitHub/Google settings → refresh fails → re-login needed
```

### 4.10 Future: Dashboard (Phase 2+)

```
relay.intent-broker.dev/dashboard
  - View usage (events today, rooms active)
  - Manage rooms (see connected peers, kick)
  - Rotate credentials
  - Upgrade plan
  - Link/unlink OAuth providers

Login via same OAuth flow (browser-based, standard redirect).
```

---

## 5. Reliability Design

### 5.1 Connection Lifecycle

```
States: DISCONNECTED → CONNECTING → CONNECTED → DRAINING → DISCONNECTED

Transitions:
  DISCONNECTED → CONNECTING: start() called or auto-reconnect triggered
  CONNECTING → CONNECTED: WebSocket open + hello received
  CONNECTED → DRAINING: relay sends "relay:draining" (server restart)
  CONNECTED → DISCONNECTED: error/close/timeout
  DRAINING → DISCONNECTED: after relay confirms drain complete
```

### 5.2 Reconnect Strategy

```javascript
const RECONNECT_CONFIG = {
  initialDelayMs: 1000,
  maxDelayMs: 30000,
  multiplier: 2,
  jitter: 0.3,        // ±30% randomization to avoid thundering herd
  maxAttempts: Infinity,  // never give up
  resetAfterMs: 60000    // reset backoff after 60s stable connection
};
```

### 5.3 Message Delivery Guarantees

**At-most-once from relay perspective** (relay is stateless).
**At-least-once from broker perspective** (local broker handles dedup + persistence).

```
Broker A event → local event-store (durable) → push to relay → relay broadcasts
                                                                      ↓
Broker B receives → dedup by intentId → write to local event-store → route to agents
```

**Dedup strategy on receiving broker:**
- `intentId` is globally unique (contains participantId + timestamp + random)
- Before writing to event-store: `SELECT 1 FROM events WHERE intent_id = ?`
- If exists → silently discard

### 5.4 Offline / Partition Handling

| Scenario | Behavior |
|----------|----------|
| Relay unreachable | Local broker works normally; events queue in local outbound buffer |
| Reconnect after partition | No replay from relay (stateless); rely on peer-to-peer cursor sync |
| Peer offline, then online | New peer requests catch-up via `relay:sync_request` |

### 5.5 Catch-up Protocol (Lightweight)

After reconnect, broker doesn't know what it missed. Options:

**Option A: Peer-assisted catch-up (recommended for MVP)**
```json
// Reconnected broker → Relay (broadcast to peers)
{ "type": "relay:sync_request", "lastSeenMessageId": "uuid", "lastSeenTs": 1703123000 }

// Peer broker responds with missed events (max 100)
{ "type": "relay:sync_response", "events": [...], "hasMore": false }
```

**Option B: Relay buffer (future, if needed)**
- Relay keeps last N minutes of events per room in memory
- On reconnect, replays buffer to new client
- Adds complexity; defer until proven necessary

---

## 6. Rate Limiting & Abuse Prevention

### 6.1 Multi-layer Rate Limiting

```
Layer 1: Per-IP connection rate    → max 5 new connections / minute / IP
Layer 2: Per-user connection count → max 5 simultaneous connections / user (JWT sub)
Layer 3: Per-room connection count → max 10 simultaneous connections / room
Layer 4: Per-connection message rate → 120 messages / minute (token bucket)
Layer 5: Per-user aggregate rate   → 300 messages / minute (across all rooms)
Layer 6: Per-room aggregate rate   → 600 messages / minute / room
Layer 7: Message size              → max 16 KB per message (free), 64 KB (pro)
Layer 8: Global relay capacity     → max 1000 total connections
```

Note: With user identity (JWT), rate limiting is per-account rather than per-IP.
This prevents circumvention via IP rotation and avoids false positives from NAT.

### 6.2 Token Bucket Implementation

```javascript
class TokenBucket {
  constructor({ capacity, refillRate }) {
    this.capacity = capacity;     // burst size (e.g., 20)
    this.tokens = capacity;
    this.refillRate = refillRate; // tokens per second (e.g., 2 = 120/min)
    this.lastRefill = Date.now();
  }

  consume(cost = 1) {
    this.refill();
    if (this.tokens >= cost) {
      this.tokens -= cost;
      return { allowed: true, remaining: this.tokens };
    }
    return { allowed: false, retryAfterMs: (cost - this.tokens) / this.refillRate * 1000 };
  }

  refill() {
    const now = Date.now();
    const elapsed = (now - this.lastRefill) / 1000;
    this.tokens = Math.min(this.capacity, this.tokens + elapsed * this.refillRate);
    this.lastRefill = now;
  }
}
```

### 6.3 Rate Limit Response

```json
// Warning (80% consumed)
{ "type": "relay:rate_warning", "remaining": 4, "resetMs": 10000 }

// Hard limit (close connection with code 4029)
WebSocket close code: 4029
Close reason: "rate_limit_exceeded"
```

### 6.4 Abuse Patterns & Mitigations

| Attack | Mitigation |
|--------|-----------|
| Connection flood | Per-IP rate limit + per-user limit + global cap |
| Message flood | Token bucket per connection + per user + per room |
| Large payload | 16KB max (free), reject before parsing |
| Slowloris (slow WebSocket frames) | 30s frame assembly timeout |
| Room enumeration | Room IDs are hashes, no list endpoint |
| Token bruteforce (room secret) | Per-IP connection rate limit + 32-char minimum secret |
| JWT theft | Short-lived (7d), HTTPS only, file mode 0600 |
| Account creation spam | GitHub/Google OAuth = non-trivial to create accounts at scale |
| Zombie connections | Ping/pong heartbeat, 90s timeout |
| Amplification (small msg → many peers) | Per-room peer limit (10); message cost = 1 regardless of fan-out |
| Resource exhaustion (many rooms) | Per-user room limit (3 free); idle room eviction after 1h |
| Cross-room data leak | Strict room isolation; no shared state between DO instances |
| Credential stuffing (stolen JWT) | Revocation list checked on each connect; short JWT lifetime |

---

## 7. Security Hardening

### 7.1 Transport Security

- **TLS only** (WSS): No plaintext WS connections accepted
- **Minimum TLS 1.2**: Reject older protocols
- **HSTS header** on upgrade endpoint
- **No CORS needed**: WebSocket doesn't use CORS; Origin header validated

### 7.2 Input Validation

```javascript
function validateMessage(raw) {
  // 1. Size check (before parsing)
  if (raw.byteLength > MAX_MESSAGE_SIZE) return reject('too_large');
  
  // 2. Valid JSON
  let msg;
  try { msg = JSON.parse(raw); } catch { return reject('invalid_json'); }
  
  // 3. Required fields
  if (!msg.type || typeof msg.type !== 'string') return reject('missing_type');
  if (!msg.type.startsWith('relay:')) return reject('invalid_type_prefix');
  
  // 4. Known message type
  if (!ALLOWED_CLIENT_TYPES.has(msg.type)) return reject('unknown_type');
  
  // 5. Payload size (nested)
  if (msg.payload && JSON.stringify(msg.payload).length > MAX_PAYLOAD_SIZE) {
    return reject('payload_too_large');
  }
  
  return { valid: true, msg };
}
```

### 7.3 DoS Protection (Cloudflare-specific)

- **CF WAF rules**: Block known bad ASNs, challenge suspicious traffic
- **CF Rate Limiting**: L7 rate limit on `/ws` endpoint before hitting Worker
- **Durable Object alarm**: Self-destruct idle rooms after timeout
- **CPU time limit**: Workers have 30s CPU limit per request; natural bound

### 7.4 Data Minimization

- Relay does NOT log message content
- Relay does NOT persist messages to disk
- Connection metadata (IP, connection time) retained max 24h for abuse investigation
- No PII stored; roomId is an opaque hash

---

## 8. Graceful Restart & Deployment

### 8.1 Drain Protocol

```
Relay decides to restart:
  1. Stop accepting new connections (return 503)
  2. Send to all connected clients:
     { "type": "relay:draining", "reconnectAfterMs": 5000 }
  3. Wait up to 10s for clients to disconnect
  4. Force-close remaining connections with code 4000 ("server_restart")
  5. Shutdown

Client behavior on "relay:draining":
  1. Enter DRAINING state
  2. Buffer outbound events locally
  3. Wait reconnectAfterMs
  4. Reconnect (will hit new instance)
  5. Send sync_request for missed events
```

### 8.2 Cloudflare Workers Deployment

Durable Objects handle this naturally:
- Each room is an independent DO instance
- CF migrates DOs between nodes without downtime
- On hibernation: WebSocket connections maintained by CF edge
- On eviction: clients reconnect automatically

### 8.3 Fly.io Deployment (Backup)

```
Strategy: Blue-green with connection draining

1. Deploy new version as "green" instances
2. Set green as target for new connections
3. Send drain signal to "blue" instances
4. Blue clients reconnect → land on green
5. Remove blue instances after 60s
```

### 8.4 Health Check Endpoints

```
GET /health → 200 { "status": "ok", "connections": 42, "rooms": 7 }
GET /health/ready → 200 (accepting connections) or 503 (draining)
```

---

## 9. Monitoring & Observability

### 9.1 Metrics (export to CF Analytics / Prometheus)

| Metric | Type | Description |
|--------|------|-------------|
| `relay_connections_active` | Gauge | Current WebSocket connections |
| `relay_rooms_active` | Gauge | Current active rooms |
| `relay_messages_total` | Counter | Total messages relayed |
| `relay_messages_dropped` | Counter | Messages dropped (rate limit / error) |
| `relay_connection_duration_seconds` | Histogram | Connection lifetime |
| `relay_message_size_bytes` | Histogram | Message payload sizes |
| `relay_rate_limit_hits` | Counter | Rate limit triggers |
| `relay_auth_failures` | Counter | Failed auth attempts |
| `relay_reconnects` | Counter | Client reconnections |

### 9.2 Alerting Rules

| Condition | Severity | Action |
|-----------|----------|--------|
| `auth_failures > 100/min from single IP` | High | Auto-ban IP for 1h |
| `connections_active > 800` (80% capacity) | Warning | Scale alert |
| `error_rate > 5%` | High | On-call page |
| `room with > 50 msg/s sustained` | Medium | Investigate abuse |

### 9.3 Structured Logging

```json
{
  "level": "info",
  "event": "connection_established",
  "roomId": "a1b2c3...",
  "peerId": "broker-uuid",
  "ip": "hashed",
  "timestamp": "2024-01-01T00:00:00Z"
}
```

---

## 10. Local Broker Relay Adapter

### 10.1 Position in Architecture

```
src/
  broker/
    service.js          ← existing
  runtime/
    managed-channels.js ← existing (manages yunzhijia)
    relay-adapter.js    ← NEW: manages relay connection
```

Same pattern as yunzhijia adapter: a managed channel that the runtime starts/stops.

### 10.2 Config

```json
// intent-broker.config.json
{
  "relay": {
    "enabled": true,
    "url": "wss://relay.intent-broker.dev",
    "roomSecret": "my-shared-secret-min-32-chars",
    "autoReconnect": true,
    "bufferMaxSize": 1000,
    "syncOnReconnect": true
  }
}
```

### 10.3 Adapter Responsibilities

```
┌─────────────────────────────────────────────┐
│ relay-adapter.js                             │
├─────────────────────────────────────────────┤
│ 1. Connect to relay WebSocket               │
│ 2. Subscribe to local event-store changes   │
│ 3. On local new event → wrap in envelope →  │
│    send to relay                            │
│ 4. On relay message → validate → dedup →    │
│    inject into local event-store            │
│ 5. Handle reconnect with backoff            │
│ 6. Buffer events during disconnect          │
│ 7. Request sync on reconnect                │
│ 8. Emit metrics/logs                        │
└─────────────────────────────────────────────┘
```

### 10.4 Event Flow

```
LOCAL EVENT PATH:
  Agent → HTTP POST /intents → broker.service → event-store.append()
                                                      ↓
                                              relay-adapter sees new event
                                                      ↓
                                              wrap in relay envelope
                                                      ↓
                                              send to relay WebSocket
                                                      ↓
                                              relay broadcasts to peers

REMOTE EVENT PATH:
  Relay WebSocket message received
         ↓
  relay-adapter.onMessage()
         ↓
  validate envelope (protocolVersion, required fields)
         ↓
  dedup check (SELECT intent_id FROM events)
         ↓
  if new: inject into event-store via broker.service.injectRemoteEvent()
         ↓
  broker routes to local participants (existing routing logic)
```

### 10.5 Dedup & Conflict Resolution

- **Primary dedup key:** `intentId` (globally unique by construction)
- **Secondary check:** `originBrokerId + originEventId` pair
- **Conflict:** Two brokers generate event with same taskId concurrently
  - Not a relay concern: local broker domain logic handles task state conflicts
  - Relay just delivers; ordering is best-effort (no global total order)

---

## 11. Capacity Planning

### 11.1 Assumptions

| Parameter | Value | Rationale |
|-----------|-------|-----------|
| Avg message size | 2 KB | Intent + metadata |
| Messages per user per hour | 60 | Active development session |
| Peers per room | 2-5 | Typical cross-machine setup |
| Active rooms | 100 | Growth target |
| Peak concurrent connections | 500 | 100 rooms × 5 peers |

### 11.2 Resource Estimates (Cloudflare Workers)

| Resource | Usage | Limit | Headroom |
|----------|-------|-------|----------|
| Requests/day | ~150K | 100K free / 10M paid | Paid plan needed |
| WebSocket messages/day | ~300K | Included with paid | OK |
| Durable Object reads/day | ~150K | 1M included | OK |
| Durable Object writes/day | 0 (stateless) | N/A | OK |
| CPU time per message | <1ms | 30s limit | OK |
| Memory per DO | ~1MB (connections map) | 128MB limit | OK |

### 11.3 Cost Estimate

- **Cloudflare Workers Paid Plan**: $5/month base
- **Durable Objects**: $0.15/million requests → ~$0.02/month at 150K req
- **WebSocket duration**: Included in Workers Paid
- **Total estimated**: ~$5-10/month for 100 active rooms

---

## 12. Implementation Phases

| Phase | Scope | Timeline |
|-------|-------|----------|
| **Phase 1: Auth + MVP** | OAuth Device Flow (GitHub + Google), relay JWT issuance, CF Worker + DO relay, relay-adapter in broker, basic room routing | 2 weeks |
| **Phase 2: Reliability** | Reconnect with backoff, local buffer, peer sync, relay-assigned seq numbers | 1 week |
| **Phase 3: Hardening** | Full rate limiting (per-user/per-room), abuse detection, monitoring, drain protocol | 1 week |
| **Phase 4: Polish** | Version check notifications, `intent-broker relay` CLI commands, documentation | 3 days |
| **Phase 5: Dashboard** | Web UI for usage/rooms/plan management (optional, deferred) | TBD |

### Phase 1 Breakdown

```
Week 1:
  - [ ] Register GitHub OAuth App + Google OAuth App (Device Flow)
  - [ ] Implement relay auth endpoint (CF Worker):
        POST /auth/device-code → returns device_code + user_code
        POST /auth/token → polls for completion, issues relay JWT
  - [ ] Implement JWT validation in WebSocket upgrade handler
  - [ ] Basic Durable Object: room join, broadcast, peer tracking
  - [ ] Health endpoint

Week 2:
  - [ ] relay-adapter.js in local broker (connect, send, receive, dedup)
  - [ ] `intent-broker relay login` CLI command
  - [ ] `intent-broker relay status` CLI command
  - [ ] Credential storage (~/.intent-broker/credentials)
  - [ ] Integration test: two brokers exchanging events via relay
```

---

## 13. Threat Model & Adversarial Review

### 13.1 STRIDE Analysis

| Threat | Category | Attack | Mitigation | Residual Risk |
|--------|----------|--------|------------|---------------|
| T1 | Spoofing | Attacker accesses relay without account | GitHub/Google OAuth required; no anonymous access | Very low: requires real OAuth account |
| T2 | Spoofing | Attacker joins room without secret | Room auth requires knowing roomSecret (32+ chars) | Low: brute-force infeasible |
| T3 | Tampering | Attacker modifies relayed events | TLS prevents MITM; relay doesn't modify payloads | Low: relay is trusted pipe |
| T4 | Repudiation | Malicious peer denies sending event | Events carry fromParticipantId + originBrokerId; relay logs user JWT sub | Low: traceable to account |
| T5 | Info Disclosure | Relay operator reads event content | By design: relay is trusted infra; events are task metadata not code | Accepted risk |
| T6 | Denial of Service | Message flood exhausts relay | Per-user + per-connection + per-room rate limiting | Low: bounded by token bucket |
| T7 | Denial of Service | Connection flood | Per-IP limit + per-user limit + CF WAF | Low: multi-layer defense |
| T8 | Denial of Service | Large payloads | 16KB hard limit (free), pre-parse size check | Low |
| T9 | Elevation | Attacker escalates to admin | No admin concept in runtime; admin = CF dashboard access | N/A |
| T10 | Info Disclosure | Room enumeration/discovery | Room IDs are SHA256 hashes; no list API; auth required before any room operation | Low |
| T11 | Spoofing | Stolen JWT used from different machine | JWT has no IP binding (by design: user may switch networks); short lifetime + revocation list | Medium: accepted tradeoff |
| T12 | Spoofing | Stolen room secret | Immediate rotation: change secret → new roomId → old peer locked out | Low: user responsibility |

### 13.2 Adversarial Scenarios

**Scenario A: Malicious Peer in Room**
```
Threat: Attacker obtains room secret, joins room, sends garbage events
Impact: Other brokers receive invalid events
Mitigation:
  1. Receiving broker validates event schema before storing
  2. Unknown/malformed events are dropped with warning log
  3. Room secret rotation: change secret → new roomId → old peer locked out
  4. Future: per-peer signing (each broker has keypair, events are signed)
```

**Scenario B: Relay Compromise**
```
Threat: Attacker gains control of relay server
Impact: Can read all events, inject fake events, DoS all rooms
Mitigation:
  1. Events don't contain secrets (code content is in local files, not events)
  2. Injected events must pass local broker validation (schema + business logic)
  3. Fail-open: local broker works without relay
  4. Future: end-to-end encryption (relay sees ciphertext only)
```

**Scenario C: Thundering Herd after Relay Restart**
```
Threat: All clients reconnect simultaneously after relay restart
Impact: Connection surge overwhelms relay
Mitigation:
  1. Jittered reconnect delay (±30%)
  2. Server sends reconnectAfterMs with staggered values per client
  3. Connection queue with admission control
  4. CF Workers auto-scales (no single instance bottleneck)
```

**Scenario D: State Divergence between Brokers**
```
Threat: Network partition causes brokers to diverge (same task, different states)
Impact: Conflicting task states when partition heals
Mitigation:
  1. Event sourcing: all events are immutable facts
  2. Task state is derived from event stream (reducer)
  3. On reconnect: exchange all events → deterministic state convergence
  4. Last-writer-wins for conflicting state transitions
  5. Human approval required for destructive actions (existing design)
```

**Scenario E: Replay Attack**
```
Threat: Attacker captures WebSocket traffic, replays messages later
Impact: Duplicate events injected
Mitigation:
  1. TLS prevents capture (unless relay compromised)
  2. intentId dedup: replayed events have same ID → silently dropped
  3. Relay assigns monotonic seq per room; replayed msg has old seq → detectable
  4. No timestamp-based validation (avoids clock skew false positives)
```

**Scenario F: Resource Exhaustion via Room Creation**
```
Threat: Attacker creates thousands of rooms with unique tokens
Impact: DO instance proliferation, cost spike
Mitigation:
  1. Per-IP room creation rate limit (5 rooms / hour)
  2. Idle room eviction (1h no messages → DO hibernates)
  3. Global room cap with waitlist
  4. Billing alert on CF dashboard
```

### 13.3 Trust Boundaries

```
┌─────────────────────────────────────────────────────────────┐
│ Trust Zone 1: Local Machine                                  │
│  ┌─────────┐  ┌──────────┐  ┌────────────┐                │
│  │ Agents  │──│  Broker  │──│ Event Store│                 │
│  └─────────┘  └──────────┘  └────────────┘                │
│       Full trust (same machine, same user)                  │
│  Credentials: ~/.intent-broker/credentials (JWT + refresh)  │
│  Config: intent-broker.config.json (roomSecret)             │
└──────────────────────────────┬──────────────────────────────┘
                               │ WSS (TLS)
                               │ Auth Layer 1: JWT (user identity)
                               │ Auth Layer 2: roomId (room membership)
                    ┌──────────▼──────────┐
                    │ Trust Zone 2: Relay  │
                    │  Semi-trusted        │
                    │  Knows: user identity│
                    │  Knows: roomId (hash)│
                    │  Cannot: reverse     │
                    │    roomId to secret  │
                    │  Cannot: forge valid │
                    │    business state    │
                    └──────────┬───────────┘
                               │ WSS (TLS)
                               │ Auth: same two layers
┌──────────────────────────────▼──────────────────────────────┐
│ Trust Zone 3: Remote Machine (peer)                          │
│  Semi-trusted:                                               │
│    - Has own OAuth account (traceable)                       │
│    - Shares room secret (authorized collaborator)            │
│    - Can send any event type within protocol                 │
│    - Local broker validates but accepts                      │
└─────────────────────────────────────────────────────────────┘
```

### 13.5 Room = Trust Domain

All peers in the same relay room share a single trust domain:

- **All events are broadcast to all peers.** There is no per-peer filtering at the relay layer. A directed message (`to: { mode: 'direct', participantId: 'X' }`) is routed locally by the receiving broker, but the relay broadcasts the envelope to every peer in the room.
- **Implication:** Any peer with the room secret can observe all cross-machine traffic. Do not place untrusted parties in the same room.
- **nodeId uniqueness is per-room.** The relay enforces that no two connections in the same room can claim the same `X-Node-Id`. This prevents alias collisions and impersonation within the trust domain.
- **Rotation = eviction.** Changing the room secret creates a new roomId, effectively a new trust domain. Old peers are locked out immediately.

This is an explicit tradeoff: simplicity and low latency (no per-peer encryption, no ACLs) in exchange for requiring that all room members are trusted collaborators. If per-message confidentiality is needed between specific peers, use separate rooms.

### 13.4 What We Explicitly Do NOT Protect Against

| Non-goal | Reason |
|----------|--------|
| End-to-end encryption | Relay is our infra; adds complexity for marginal gain in MVP |
| Per-event signing | Within a room, peers are trusted collaborators |
| Byzantine fault tolerance | Not a blockchain; collaborative development assumes good faith |
| Guaranteed ordering | Event sourcing + reducer handles reordering; no need for consensus |
| Zero-knowledge relay | Would require complex crypto; defer to future if demand exists |

---

## 14. Adversarial Review Checklist

### Red Team Questions

- [ ] What if an attacker connects 10,000 WebSocket connections from different IPs?
  → CF WAF + global connection cap (1000). Scale up only with paid plan justification.

- [ ] What if a valid peer goes rogue and floods 10MB/s of events?
  → Per-connection token bucket (120 msg/min) + 64KB size limit = max 128KB/s per peer.

- [ ] What if relay is down for 2 hours? How much data is lost?
  → Zero loss. Events are durable in local event-store. On reconnect, peer sync fills gaps.

- [ ] What if two brokers concurrently create the same task?
  → Both events persist (different intentIds). Reducer derives deterministic state. UI shows conflict for human resolution.

- [ ] What if someone discovers the relay URL and hammers it?
  → Without valid JWT, rejected at HTTP 401 before WebSocket upgrade. Even with valid JWT, per-user rate limits bound damage. Abuse traceable to account → ban.

- [ ] What if CF Workers has an outage?
  → Fail-open: local brokers continue working. Configure fallback relay URL (Fly.io).

- [ ] What if room secret is leaked?
  → Rotate secret → new roomId. Old connections drop on next heartbeat cycle. No backward-compatible grace period for compromised secrets (immediate rotation mode).

- [ ] What if an attacker performs timing attacks to determine room existence?
  → Auth rejection is constant-time (same response for "room doesn't exist" and "bad token"). Room IDs are opaque hashes.

- [ ] What if message content contains injection attempts (XSS, SQL)?
  → Relay doesn't interpret content. Local broker uses parameterized SQLite queries. No HTML rendering of event data.

- [ ] What if WebSocket frames are fragmented maliciously?
  → 30s frame assembly timeout. Drop connection on timeout. Maximum frame size enforced by ws library.

---

## 15. Open Questions

1. **Should relay persist a short buffer (5 min) for catch-up?** Adds reliability but adds state and cost.
2. **Room TTL policy?** Free tier rooms expire after 7 days idle? Paid rooms persist?
3. **Multi-relay redundancy?** Client can configure fallback relay URLs?
4. **Event filtering?** Should relay allow clients to subscribe to specific event kinds only?
5. **Binary protocol?** Start with JSON, switch to MessagePack/CBOR if bandwidth is a concern?
6. **Rate limit fairness:** Should per-room limit be evenly split among peers, or first-come-first-served?
7. **Observability for users:** Should broker expose relay connection status in `/health` endpoint?
