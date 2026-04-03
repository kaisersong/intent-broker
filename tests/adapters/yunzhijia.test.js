import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import https from 'node:https';
import { once } from 'node:events';
import { WebSocket, WebSocketServer } from 'ws';
import { createBrokerService } from '../../src/broker/service.js';
import { createServer } from '../../src/http/server.js';
import { createTempDbPath } from '../fixtures/temp-dir.js';
import { ADAPTER_ID, YunzhijiaAdapter } from '../../adapters/yunzhijia/index.js';

async function waitFor(predicate, { timeoutMs = 3000, intervalMs = 25 } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  throw new Error('Timed out waiting for condition');
}

test('Yunzhijia adapter translates inbound and outbound broker traffic', { concurrency: false }, async (t) => {
  process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';

  const broker = createBrokerService({ dbPath: createTempDbPath() });
  const brokerServer = createServer({ broker });
  await brokerServer.listen(0, '127.0.0.1');
  broker.attachWebSocket(brokerServer.raw());
  const brokerPort = brokerServer.address().port;
  const brokerUrl = `http://127.0.0.1:${brokerPort}`;

  const outboundPosts = [];
  const yzjServer = https.createServer(
    {
      key: fs.readFileSync(new URL('../fixtures/yunzhijia-tls/key.pem', import.meta.url)),
      cert: fs.readFileSync(new URL('../fixtures/yunzhijia-tls/cert.pem', import.meta.url))
    },
    (req, res) => {
      if (req.method !== 'POST') {
        res.writeHead(404);
        res.end();
        return;
      }

      let raw = '';
      req.on('data', (chunk) => {
        raw += chunk;
      });
      req.on('end', () => {
        outboundPosts.push(JSON.parse(raw));
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ ok: true }));
      });
    }
  );
  const yzjWss = new WebSocketServer({ server: yzjServer, path: '/xuntong/websocket' });
  await new Promise((resolve) => yzjServer.listen(0, '127.0.0.1', resolve));
  const yzjPort = yzjServer.address().port;
  const yzjSendUrl = `https://127.0.0.1:${yzjPort}/gateway/robot/webhook/send?yzjtype=0&yzjtoken=testtoken`;

  const adapter = new YunzhijiaAdapter({
    brokerUrl,
    sendUrl: yzjSendUrl
  });

  const humanMessages = [];
  const humanWs = new WebSocket(`ws://127.0.0.1:${brokerPort}/ws?participantId=human.yzj_user_local`);
  humanWs.on('message', (data) => {
    humanMessages.push(JSON.parse(data.toString()));
  });
  await once(humanWs, 'open');

  t.after(async () => {
    humanWs.close();
    adapter.stop();
    await new Promise((resolve) => yzjWss.close(resolve));
    await new Promise((resolve) => yzjServer.close(resolve));
    await brokerServer.close();
  });

  await adapter.registerToBroker();
  await adapter.connectBrokerWebSocket();
  await adapter.connectYunzhijiaWebSocket();
  await once(yzjWss, 'connection');

  const yzjSockets = Array.from(yzjWss.clients);
  assert.equal(yzjSockets.length, 1);

  yzjSockets[0].send(
    JSON.stringify({
      msg: {
        robotId: 'robot_local',
        operatorOpenid: 'user_local',
        content: 'ping from yzj',
        msgId: 'msg_local_1'
      }
    })
  );

  await waitFor(() => adapter.userWebSockets.has('human.yzj_user_local'));

  const replay = await fetch(`${brokerUrl}/events/replay?after=0`).then((res) => res.json());
  assert.equal(replay.items.length, 1);
  assert.equal(replay.items[0].fromParticipantId, 'human.yzj_user_local');
  assert.equal(replay.items[0].taskId, 'yzj-msg_local_1');
  assert.equal(replay.items[0].threadId, 'yzj-msg_local_1');
  assert.equal(replay.items[0].payload.body.summary, 'ping from yzj');

  await fetch(`${brokerUrl}/intents`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      intentId: 'reply-1',
      kind: 'ask_clarification',
      fromParticipantId: 'agent.test',
      taskId: 'task-1',
      threadId: 'thread-1',
      to: { mode: 'participant', participants: ['human.yzj_user_local'] },
      payload: {
        body: { summary: 'reply to yzj' },
        metadata: { msgId: 'msg_local_1' }
      }
    })
  });

  await waitFor(() => outboundPosts.length === 1);

  assert.ok(humanMessages.some((message) => message.type === 'new_intent'));
  assert.equal(outboundPosts.length, 1);
  assert.equal(outboundPosts[0].content, '【需要回答】reply to yzj');
  assert.deepEqual(outboundPosts[0].notifyParams[0].values, ['user_local']);
  assert.equal(outboundPosts[0].param.replyMsgId, 'msg_local_1');
});

test('Yunzhijia adapter shows which agent replied when forwarding broker progress back to the human', { concurrency: false }, async (t) => {
  process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';

  const broker = createBrokerService({ dbPath: createTempDbPath() });
  const brokerServer = createServer({ broker });
  await brokerServer.listen(0, '127.0.0.1');
  broker.attachWebSocket(brokerServer.raw());
  const brokerPort = brokerServer.address().port;
  const brokerUrl = `http://127.0.0.1:${brokerPort}`;

  broker.registerParticipant({
    participantId: 'claude.session.reply',
    kind: 'agent',
    roles: ['coder'],
    capabilities: ['broker.auto_dispatch'],
    alias: 'claude2',
    inboxMode: 'realtime'
  });

  const outboundPosts = [];
  const yzjServer = https.createServer(
    {
      key: fs.readFileSync(new URL('../fixtures/yunzhijia-tls/key.pem', import.meta.url)),
      cert: fs.readFileSync(new URL('../fixtures/yunzhijia-tls/cert.pem', import.meta.url))
    },
    (req, res) => {
      let raw = '';
      req.on('data', (chunk) => {
        raw += chunk;
      });
      req.on('end', () => {
        outboundPosts.push(JSON.parse(raw));
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ ok: true }));
      });
    }
  );
  const yzjWss = new WebSocketServer({ server: yzjServer, path: '/xuntong/websocket' });
  await new Promise((resolve) => yzjServer.listen(0, '127.0.0.1', resolve));
  const yzjPort = yzjServer.address().port;
  const yzjSendUrl = `https://127.0.0.1:${yzjPort}/gateway/robot/webhook/send?yzjtype=0&yzjtoken=testtoken`;

  const adapter = new YunzhijiaAdapter({
    brokerUrl,
    sendUrl: yzjSendUrl
  });

  t.after(async () => {
    adapter.stop();
    await new Promise((resolve) => yzjWss.close(resolve));
    await new Promise((resolve) => yzjServer.close(resolve));
    await brokerServer.close();
  });

  await adapter.registerToBroker();
  await adapter.connectBrokerWebSocket();
  await adapter.connectYunzhijiaWebSocket();
  await once(yzjWss, 'connection');

  const yzjSockets = Array.from(yzjWss.clients);
  yzjSockets[0].send(
    JSON.stringify({
      msg: {
        robotId: 'robot_local',
        operatorOpenid: 'user_local',
        content: '@claude2 你在做什么',
        msgId: 'msg_agent_reply_1'
      }
    })
  );

  await waitFor(() => adapter.userWebSockets.has('human.yzj_user_local'));
  outboundPosts.length = 0;

  await fetch(`${brokerUrl}/intents`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      intentId: 'progress-reply-1',
      kind: 'report_progress',
      fromParticipantId: 'claude.session.reply',
      taskId: 'task-1',
      threadId: 'thread-1',
      to: { mode: 'participant', participants: ['human.yzj_user_local'] },
      payload: {
        body: { summary: '我在处理 broker 自动回复链路。' },
        metadata: { msgId: 'msg_agent_reply_1', yzjUserId: 'user_local' }
      }
    })
  });

  await waitFor(() => outboundPosts.length === 1);

  assert.match(outboundPosts[0].content, /claude/i);
  assert.match(outboundPosts[0].content, /我在处理 broker 自动回复链路/);
  assert.equal(outboundPosts[0].param.replyMsgId, 'msg_agent_reply_1');
  assert.deepEqual(outboundPosts[0].notifyParams[0].values, ['user_local']);
});

test('Yunzhijia adapter routes @alias, @all and replies on unknown aliases', { concurrency: false }, async (t) => {
  process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';

  const broker = createBrokerService({ dbPath: createTempDbPath() });
  const brokerServer = createServer({ broker });
  await brokerServer.listen(0, '127.0.0.1');
  broker.attachWebSocket(brokerServer.raw());
  const brokerPort = brokerServer.address().port;
  const brokerUrl = `http://127.0.0.1:${brokerPort}`;

  broker.registerParticipant({ participantId: 'codex.a', kind: 'agent', roles: ['coder'], capabilities: [], alias: 'codex' });
  broker.registerParticipant({ participantId: 'claude.b', kind: 'agent', roles: ['coder'], capabilities: [], alias: 'claude' });
  const outboundPosts = [];
  const yzjServer = https.createServer(
    {
      key: fs.readFileSync(new URL('../fixtures/yunzhijia-tls/key.pem', import.meta.url)),
      cert: fs.readFileSync(new URL('../fixtures/yunzhijia-tls/cert.pem', import.meta.url))
    },
    (req, res) => {
      let raw = '';
      req.on('data', (chunk) => {
        raw += chunk;
      });
      req.on('end', () => {
        outboundPosts.push(JSON.parse(raw));
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ ok: true }));
      });
    }
  );
  const yzjWss = new WebSocketServer({ server: yzjServer, path: '/xuntong/websocket' });
  await new Promise((resolve) => yzjServer.listen(0, '127.0.0.1', resolve));
  const yzjPort = yzjServer.address().port;
  const yzjSendUrl = `https://127.0.0.1:${yzjPort}/gateway/robot/webhook/send?yzjtype=0&yzjtoken=testtoken`;

  const adapter = new YunzhijiaAdapter({
    brokerUrl,
    sendUrl: yzjSendUrl
  });

  t.after(async () => {
    adapter.stop();
    await new Promise((resolve) => yzjWss.close(resolve));
    await new Promise((resolve) => yzjServer.close(resolve));
    await brokerServer.close();
  });

  await adapter.registerToBroker();
  await adapter.connectBrokerWebSocket();
  await adapter.connectYunzhijiaWebSocket();
  await once(yzjWss, 'connection');

  const yzjSockets = Array.from(yzjWss.clients);
  yzjSockets[0].send(
    JSON.stringify({
      msg: {
        robotId: 'robot_local',
        operatorOpenid: 'user_local',
        content: '@codex 请看一下 alias 路由',
        msgId: 'msg_alias_1'
      }
    })
  );

  await waitFor(() => broker.readInbox('codex.a', { after: 0 }).items.some((item) => item.kind === 'ask_clarification'));
  assert.equal(
    broker.readInbox('codex.a', { after: 0 }).items.find((item) => item.kind === 'ask_clarification').payload.body.summary,
    '请看一下 alias 路由'
  );
  assert.equal(
    broker.readInbox('claude.b', { after: 0 }).items.filter((item) => item.kind === 'ask_clarification').length,
    0
  );

  yzjSockets[0].send(
    JSON.stringify({
      msg: {
        robotId: 'robot_local',
        operatorOpenid: 'user_local',
        content: '@codex @claude 一起处理',
        msgId: 'msg_alias_2'
      }
    })
  );

  await waitFor(() => broker.readInbox('claude.b', { after: 0 }).items.some((item) => item.kind === 'ask_clarification'));
  assert.equal(
    broker.readInbox('codex.a', { after: 0 }).items.filter((item) => item.kind === 'ask_clarification').length,
    2
  );
  assert.equal(
    broker.readInbox('claude.b', { after: 0 }).items.find((item) => item.kind === 'ask_clarification').payload.body.summary,
    '一起处理'
  );

  yzjSockets[0].send(
    JSON.stringify({
      msg: {
        robotId: 'robot_local',
        operatorOpenid: 'user_local',
        content: '@all 全员同步',
        msgId: 'msg_alias_3'
      }
    })
  );

  await waitFor(() => broker.readInbox('claude.b', { after: 0 }).items.filter((item) => item.kind === 'ask_clarification').length === 2);
  assert.equal(
    broker.readInbox('codex.a', { after: 0 }).items.filter((item) => item.kind === 'ask_clarification').length,
    3
  );
  assert.equal(
    broker.readInbox('claude.b', { after: 0 }).items.filter((item) => item.kind === 'ask_clarification')[1].payload.body.summary,
    '全员同步'
  );

  yzjSockets[0].send(
    JSON.stringify({
      msg: {
        robotId: 'robot_local',
        operatorOpenid: 'user_local',
        content: '@missing 这个人不存在',
        msgId: 'msg_alias_4'
      }
    })
  );

  await waitFor(() => outboundPosts.some((post) => /未找到别名/.test(post.content)));
  assert.match(outboundPosts.find((post) => /未找到别名/.test(post.content)).content, /未找到别名/);
  assert.equal(
    broker.readInbox('codex.a', { after: 0 }).items.filter((item) => item.kind === 'ask_clarification').length,
    3
  );
  assert.equal(
    broker.readInbox('claude.b', { after: 0 }).items.filter((item) => item.kind === 'ask_clarification').length,
    2
  );
});

test('Yunzhijia adapter can rename participant alias through message command and broadcast reaches human channel', { concurrency: false }, async (t) => {
  process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';

  const broker = createBrokerService({ dbPath: createTempDbPath() });
  const brokerServer = createServer({ broker });
  await brokerServer.listen(0, '127.0.0.1');
  broker.attachWebSocket(brokerServer.raw());
  const brokerPort = brokerServer.address().port;
  const brokerUrl = `http://127.0.0.1:${brokerPort}`;

  broker.registerParticipant({ participantId: 'codex.a', kind: 'agent', roles: ['coder'], capabilities: [], alias: 'codex' });

  const outboundPosts = [];
  const yzjServer = https.createServer(
    {
      key: fs.readFileSync(new URL('../fixtures/yunzhijia-tls/key.pem', import.meta.url)),
      cert: fs.readFileSync(new URL('../fixtures/yunzhijia-tls/cert.pem', import.meta.url))
    },
    (req, res) => {
      let raw = '';
      req.on('data', (chunk) => {
        raw += chunk;
      });
      req.on('end', () => {
        outboundPosts.push(JSON.parse(raw));
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ ok: true }));
      });
    }
  );
  const yzjWss = new WebSocketServer({ server: yzjServer, path: '/xuntong/websocket' });
  await new Promise((resolve) => yzjServer.listen(0, '127.0.0.1', resolve));
  const yzjPort = yzjServer.address().port;
  const yzjSendUrl = `https://127.0.0.1:${yzjPort}/gateway/robot/webhook/send?yzjtype=0&yzjtoken=testtoken`;

  const adapter = new YunzhijiaAdapter({
    brokerUrl,
    sendUrl: yzjSendUrl
  });

  t.after(async () => {
    adapter.stop();
    await new Promise((resolve) => yzjWss.close(resolve));
    await new Promise((resolve) => yzjServer.close(resolve));
    await brokerServer.close();
  });

  await adapter.registerToBroker();
  await adapter.connectBrokerWebSocket();
  await adapter.connectYunzhijiaWebSocket();
  await once(yzjWss, 'connection');

  const yzjSockets = Array.from(yzjWss.clients);
  yzjSockets[0].send(
    JSON.stringify({
      msg: {
        robotId: 'robot_local',
        operatorOpenid: 'user_local',
        content: '/alias @codex reviewer',
        msgId: 'msg_alias_rename_1'
      }
    })
  );

  await waitFor(() => outboundPosts.length >= 2);

  const renamed = broker.listParticipants().find((participant) => participant.participantId === 'codex.a');
  assert.equal(renamed.alias, 'reviewer');
  assert.ok(outboundPosts.some((post) => /alias 已更新/.test(post.content)));
  assert.ok(outboundPosts.some((post) => /codex\.a alias updated: codex -> reviewer/.test(post.content)));
});

test('Yunzhijia adapter tells humans when mentioned agents are online in pull inbox mode', { concurrency: false }, async (t) => {
  process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';

  const broker = createBrokerService({ dbPath: createTempDbPath() });
  const brokerServer = createServer({ broker });
  await brokerServer.listen(0, '127.0.0.1');
  broker.attachWebSocket(brokerServer.raw());
  const brokerPort = brokerServer.address().port;
  const brokerUrl = `http://127.0.0.1:${brokerPort}`;

  broker.registerParticipant({
    participantId: 'codex.a',
    kind: 'agent',
    roles: ['coder'],
    capabilities: [],
    alias: 'codex',
    inboxMode: 'pull'
  });

  const outboundPosts = [];
  const yzjServer = https.createServer(
    {
      key: fs.readFileSync(new URL('../fixtures/yunzhijia-tls/key.pem', import.meta.url)),
      cert: fs.readFileSync(new URL('../fixtures/yunzhijia-tls/cert.pem', import.meta.url))
    },
    (req, res) => {
      let raw = '';
      req.on('data', (chunk) => {
        raw += chunk;
      });
      req.on('end', () => {
        outboundPosts.push(JSON.parse(raw));
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ ok: true }));
      });
    }
  );
  const yzjWss = new WebSocketServer({ server: yzjServer, path: '/xuntong/websocket' });
  await new Promise((resolve) => yzjServer.listen(0, '127.0.0.1', resolve));
  const yzjPort = yzjServer.address().port;
  const yzjSendUrl = `https://127.0.0.1:${yzjPort}/gateway/robot/webhook/send?yzjtype=0&yzjtoken=testtoken`;

  const adapter = new YunzhijiaAdapter({
    brokerUrl,
    sendUrl: yzjSendUrl
  });

  t.after(async () => {
    adapter.stop();
    await new Promise((resolve) => yzjWss.close(resolve));
    await new Promise((resolve) => yzjServer.close(resolve));
    await brokerServer.close();
  });

  await adapter.registerToBroker();
  await adapter.connectBrokerWebSocket();
  await adapter.connectYunzhijiaWebSocket();
  await once(yzjWss, 'connection');

  const yzjSockets = Array.from(yzjWss.clients);
  yzjSockets[0].send(
    JSON.stringify({
      msg: {
        robotId: 'robot_local',
        operatorOpenid: 'user_local',
        content: '@codex 你在做什么，回复我',
        msgId: 'msg_offline_1'
      }
    })
  );

  await waitFor(() => broker.readInbox('codex.a', { after: 0 }).items.some((item) => item.kind === 'ask_clarification'));
  await waitFor(() => outboundPosts.length === 1);

  assert.equal(
    broker.readInbox('codex.a', { after: 0 }).items.find((item) => item.kind === 'ask_clarification').payload.body.summary,
    '你在做什么，回复我'
  );
  assert.match(outboundPosts[0].content, /会话在线/);
  assert.match(outboundPosts[0].content, /不是实时收件模式/);
  assert.match(outboundPosts[0].content, /@codex/);
});

test('Yunzhijia adapter tells humans when mentioned agents are only registered placeholders', { concurrency: false }, async (t) => {
  process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';

  const broker = createBrokerService({ dbPath: createTempDbPath() });
  const brokerServer = createServer({ broker });
  await brokerServer.listen(0, '127.0.0.1');
  broker.attachWebSocket(brokerServer.raw());
  const brokerPort = brokerServer.address().port;
  const brokerUrl = `http://127.0.0.1:${brokerPort}`;

  broker.registerParticipant({ participantId: 'probe.agent', kind: 'agent', roles: ['coder'], capabilities: [], alias: 'probe1' });

  const outboundPosts = [];
  const yzjServer = https.createServer(
    {
      key: fs.readFileSync(new URL('../fixtures/yunzhijia-tls/key.pem', import.meta.url)),
      cert: fs.readFileSync(new URL('../fixtures/yunzhijia-tls/cert.pem', import.meta.url))
    },
    (req, res) => {
      let raw = '';
      req.on('data', (chunk) => {
        raw += chunk;
      });
      req.on('end', () => {
        outboundPosts.push(JSON.parse(raw));
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ ok: true }));
      });
    }
  );
  const yzjWss = new WebSocketServer({ server: yzjServer, path: '/xuntong/websocket' });
  await new Promise((resolve) => yzjServer.listen(0, '127.0.0.1', resolve));
  const yzjPort = yzjServer.address().port;
  const yzjSendUrl = `https://127.0.0.1:${yzjPort}/gateway/robot/webhook/send?yzjtype=0&yzjtoken=testtoken`;

  const adapter = new YunzhijiaAdapter({
    brokerUrl,
    sendUrl: yzjSendUrl
  });

  t.after(async () => {
    adapter.stop();
    await new Promise((resolve) => yzjWss.close(resolve));
    await new Promise((resolve) => yzjServer.close(resolve));
    await brokerServer.close();
  });

  await adapter.registerToBroker();
  await adapter.connectBrokerWebSocket();
  await adapter.connectYunzhijiaWebSocket();
  await once(yzjWss, 'connection');

  const yzjSockets = Array.from(yzjWss.clients);
  yzjSockets[0].send(
    JSON.stringify({
      msg: {
        robotId: 'robot_local',
        operatorOpenid: 'user_local',
        content: '@probe1 你在做什么，回复我',
        msgId: 'msg_placeholder_1'
      }
    })
  );

  await waitFor(() => outboundPosts.length === 1);
  assert.match(outboundPosts[0].content, /已注册/);
  assert.match(outboundPosts[0].content, /没有活动会话/);
  assert.match(outboundPosts[0].content, /@probe1/);
});

test('Yunzhijia adapter tells humans when realtime agents are online but bridge delivery is currently degraded', { concurrency: false }, async (t) => {
  process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';

  const broker = createBrokerService({ dbPath: createTempDbPath() });
  const brokerServer = createServer({ broker });
  await brokerServer.listen(0, '127.0.0.1');
  broker.attachWebSocket(brokerServer.raw());
  const brokerPort = brokerServer.address().port;
  const brokerUrl = `http://127.0.0.1:${brokerPort}`;

  broker.registerParticipant({
    participantId: 'codex.a',
    kind: 'agent',
    roles: ['coder'],
    capabilities: [],
    alias: 'codex',
    inboxMode: 'realtime'
  });

  const outboundPosts = [];
  const yzjServer = https.createServer(
    {
      key: fs.readFileSync(new URL('../fixtures/yunzhijia-tls/key.pem', import.meta.url)),
      cert: fs.readFileSync(new URL('../fixtures/yunzhijia-tls/cert.pem', import.meta.url))
    },
    (req, res) => {
      let raw = '';
      req.on('data', (chunk) => {
        raw += chunk;
      });
      req.on('end', () => {
        outboundPosts.push(JSON.parse(raw));
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ ok: true }));
      });
    }
  );
  const yzjWss = new WebSocketServer({ server: yzjServer, path: '/xuntong/websocket' });
  await new Promise((resolve) => yzjServer.listen(0, '127.0.0.1', resolve));
  const yzjPort = yzjServer.address().port;
  const yzjSendUrl = `https://127.0.0.1:${yzjPort}/gateway/robot/webhook/send?yzjtype=0&yzjtoken=testtoken`;

  const adapter = new YunzhijiaAdapter({
    brokerUrl,
    sendUrl: yzjSendUrl
  });

  t.after(async () => {
    adapter.stop();
    await new Promise((resolve) => yzjWss.close(resolve));
    await new Promise((resolve) => yzjServer.close(resolve));
    await brokerServer.close();
  });

  await adapter.registerToBroker();
  await adapter.connectBrokerWebSocket();
  await adapter.connectYunzhijiaWebSocket();
  await once(yzjWss, 'connection');

  const yzjSockets = Array.from(yzjWss.clients);
  yzjSockets[0].send(
    JSON.stringify({
      msg: {
        robotId: 'robot_local',
        operatorOpenid: 'user_local',
        content: '@codex 你在做什么，回复我',
        msgId: 'msg_realtime_degraded_1'
      }
    })
  );

  await waitFor(() => outboundPosts.length === 1);
  assert.match(outboundPosts[0].content, /realtime bridge/);
  assert.match(outboundPosts[0].content, /当前未连接/);
  assert.match(outboundPosts[0].content, /@codex/);
});

test('Yunzhijia adapter tells humans when realtime delivery only reaches the local queue without auto-dispatch', { concurrency: false }, async (t) => {
  process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';

  const broker = createBrokerService({ dbPath: createTempDbPath() });
  const brokerServer = createServer({ broker });
  await brokerServer.listen(0, '127.0.0.1');
  broker.attachWebSocket(brokerServer.raw());
  const brokerPort = brokerServer.address().port;
  const brokerUrl = `http://127.0.0.1:${brokerPort}`;

  broker.registerParticipant({
    participantId: 'agent.receive-only',
    kind: 'agent',
    roles: ['coder'],
    capabilities: [],
    alias: 'receiveonly',
    inboxMode: 'realtime'
  });

  const outboundPosts = [];
  const yzjServer = https.createServer(
    {
      key: fs.readFileSync(new URL('../fixtures/yunzhijia-tls/key.pem', import.meta.url)),
      cert: fs.readFileSync(new URL('../fixtures/yunzhijia-tls/cert.pem', import.meta.url))
    },
    (req, res) => {
      let raw = '';
      req.on('data', (chunk) => {
        raw += chunk;
      });
      req.on('end', () => {
        outboundPosts.push(JSON.parse(raw));
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ ok: true }));
      });
    }
  );
  const yzjWss = new WebSocketServer({ server: yzjServer, path: '/xuntong/websocket' });
  await new Promise((resolve) => yzjServer.listen(0, '127.0.0.1', resolve));
  const yzjPort = yzjServer.address().port;
  const yzjSendUrl = `https://127.0.0.1:${yzjPort}/gateway/robot/webhook/send?yzjtype=0&yzjtoken=testtoken`;

  const adapter = new YunzhijiaAdapter({
    brokerUrl,
    sendUrl: yzjSendUrl
  });
  let agentSocket = null;

  t.after(async () => {
    adapter.stop();
    if (agentSocket && agentSocket.readyState === WebSocket.OPEN) {
      const closed = once(agentSocket, 'close').catch(() => null);
      agentSocket.close();
      await closed;
    }
    await new Promise((resolve) => yzjWss.close(resolve));
    await new Promise((resolve) => yzjServer.close(resolve));
    await brokerServer.close();
  });

  await adapter.registerToBroker();
  await adapter.connectBrokerWebSocket();
  await adapter.connectYunzhijiaWebSocket();
  await once(yzjWss, 'connection');

  agentSocket = new WebSocket(`ws://127.0.0.1:${brokerPort}/ws?participantId=agent.receive-only`);
  await once(agentSocket, 'open');
  await waitFor(() => broker.getPresence('agent.receive-only')?.status === 'online');

  const yzjSockets = Array.from(yzjWss.clients);
  yzjSockets[0].send(
    JSON.stringify({
      msg: {
        robotId: 'robot_local',
        operatorOpenid: 'user_local',
        content: '@receiveonly 你在做什么，回复我',
        msgId: 'msg_receive_only_1'
      }
    })
  );

  await waitFor(() => broker.readInbox('agent.receive-only', { after: 0 }).items.some((item) => item.kind === 'ask_clarification'));
  await waitFor(() => outboundPosts.length >= 1);

  assert.match(outboundPosts[0].content, /@receiveonly/);
  assert.match(outboundPosts[0].content, /本地收件队列/);
  assert.match(outboundPosts[0].content, /不会自动执行|下一次本地交互/);
});

test('Yunzhijia adapter tells humans when mentioned agents are truly offline', { concurrency: false }, async (t) => {
  process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';

  const broker = createBrokerService({ dbPath: createTempDbPath() });
  const brokerServer = createServer({ broker });
  await brokerServer.listen(0, '127.0.0.1');
  broker.attachWebSocket(brokerServer.raw());
  const brokerPort = brokerServer.address().port;
  const brokerUrl = `http://127.0.0.1:${brokerPort}`;

  broker.registerParticipant({ participantId: 'codex.a', kind: 'agent', roles: ['coder'], capabilities: [], alias: 'codex' });
  broker.updatePresence('codex.a', 'offline', { reason: 'test' });

  const outboundPosts = [];
  const yzjServer = https.createServer(
    {
      key: fs.readFileSync(new URL('../fixtures/yunzhijia-tls/key.pem', import.meta.url)),
      cert: fs.readFileSync(new URL('../fixtures/yunzhijia-tls/cert.pem', import.meta.url))
    },
    (req, res) => {
      let raw = '';
      req.on('data', (chunk) => {
        raw += chunk;
      });
      req.on('end', () => {
        outboundPosts.push(JSON.parse(raw));
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ ok: true }));
      });
    }
  );
  const yzjWss = new WebSocketServer({ server: yzjServer, path: '/xuntong/websocket' });
  await new Promise((resolve) => yzjServer.listen(0, '127.0.0.1', resolve));
  const yzjPort = yzjServer.address().port;
  const yzjSendUrl = `https://127.0.0.1:${yzjPort}/gateway/robot/webhook/send?yzjtype=0&yzjtoken=testtoken`;

  const adapter = new YunzhijiaAdapter({
    brokerUrl,
    sendUrl: yzjSendUrl
  });

  t.after(async () => {
    adapter.stop();
    await new Promise((resolve) => yzjWss.close(resolve));
    await new Promise((resolve) => yzjServer.close(resolve));
    await brokerServer.close();
  });

  await adapter.registerToBroker();
  await adapter.connectBrokerWebSocket();
  await adapter.connectYunzhijiaWebSocket();
  await once(yzjWss, 'connection');

  const yzjSockets = Array.from(yzjWss.clients);
  yzjSockets[0].send(
    JSON.stringify({
      msg: {
        robotId: 'robot_local',
        operatorOpenid: 'user_local',
        content: '@codex 你还在吗',
        msgId: 'msg_offline_2'
      }
    })
  );

  await waitFor(() => outboundPosts.length >= 1);
  assert.match(outboundPosts[0].content, /当前不在线/);
  assert.match(outboundPosts[0].content, /@codex/);
});

test('Yunzhijia adapter tells humans which recipients were reached in realtime and which stayed offline', { concurrency: false }, async (t) => {
  process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';

  const broker = createBrokerService({ dbPath: createTempDbPath() });
  const brokerServer = createServer({ broker });
  await brokerServer.listen(0, '127.0.0.1');
  broker.attachWebSocket(brokerServer.raw());
  const brokerPort = brokerServer.address().port;
  const brokerUrl = `http://127.0.0.1:${brokerPort}`;

  broker.registerParticipant({
    participantId: 'codex.a',
    kind: 'agent',
    roles: ['coder'],
    capabilities: ['broker.auto_dispatch'],
    alias: 'codex'
  });
  broker.registerParticipant({ participantId: 'claude.b', kind: 'agent', roles: ['coder'], capabilities: [], alias: 'claude' });
  broker.updatePresence('claude.b', 'offline', { reason: 'test' });

  const outboundPosts = [];
  const yzjServer = https.createServer(
    {
      key: fs.readFileSync(new URL('../fixtures/yunzhijia-tls/key.pem', import.meta.url)),
      cert: fs.readFileSync(new URL('../fixtures/yunzhijia-tls/cert.pem', import.meta.url))
    },
    (req, res) => {
      let raw = '';
      req.on('data', (chunk) => {
        raw += chunk;
      });
      req.on('end', () => {
        outboundPosts.push(JSON.parse(raw));
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ ok: true }));
      });
    }
  );
  const yzjWss = new WebSocketServer({ server: yzjServer, path: '/xuntong/websocket' });
  await new Promise((resolve) => yzjServer.listen(0, '127.0.0.1', resolve));
  const yzjPort = yzjServer.address().port;
  const yzjSendUrl = `https://127.0.0.1:${yzjPort}/gateway/robot/webhook/send?yzjtype=0&yzjtoken=testtoken`;

  const adapter = new YunzhijiaAdapter({
    brokerUrl,
    sendUrl: yzjSendUrl
  });
  let agentSocket = null;

  t.after(async () => {
    adapter.stop();
    if (agentSocket && agentSocket.readyState === WebSocket.OPEN) {
      const closed = once(agentSocket, 'close').catch(() => null);
      agentSocket.close();
      await closed;
    }
    await new Promise((resolve) => yzjWss.close(resolve));
    await new Promise((resolve) => yzjServer.close(resolve));
    await brokerServer.close();
  });

  await adapter.registerToBroker();
  await adapter.connectBrokerWebSocket();
  await adapter.connectYunzhijiaWebSocket();
  await once(yzjWss, 'connection');

  agentSocket = new WebSocket(`ws://127.0.0.1:${brokerPort}/ws?participantId=codex.a`);
  await once(agentSocket, 'open');
  await waitFor(() => broker.getPresence('codex.a')?.status === 'online');

  outboundPosts.length = 0;

  const yzjSockets = Array.from(yzjWss.clients);
  yzjSockets[0].send(
    JSON.stringify({
      msg: {
        robotId: 'robot_local',
        operatorOpenid: 'user_local',
        content: '@all 现在报一下状态',
        msgId: 'msg_mixed_delivery_1'
      }
    })
  );

  await waitFor(() => broker.readInbox('codex.a', { after: 0 }).items.some((item) => item.kind === 'ask_clarification'));
  await waitFor(() => broker.readInbox('claude.b', { after: 0 }).items.some((item) => item.kind === 'ask_clarification'));
  await waitFor(() => outboundPosts.some((post) => /当前不在线/.test(post.content)));
  await waitFor(() => outboundPosts.some((post) => /已实时投递给/.test(post.content)));

  assert.ok(outboundPosts.some((post) => /自动起工/.test(post.content) && /@codex/.test(post.content)));
  assert.ok(outboundPosts.some((post) => /当前不在线/.test(post.content) && /@claude/.test(post.content)));
});

test('Yunzhijia adapter forwards new client online notifications to channel', { concurrency: false }, async (t) => {
  process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';

  const broker = createBrokerService({ dbPath: createTempDbPath() });
  const brokerServer = createServer({ broker });
  await brokerServer.listen(0, '127.0.0.1');
  broker.attachWebSocket(brokerServer.raw());
  const brokerPort = brokerServer.address().port;
  const brokerUrl = `http://127.0.0.1:${brokerPort}`;

  const outboundPosts = [];
  const yzjServer = https.createServer(
    {
      key: fs.readFileSync(new URL('../fixtures/yunzhijia-tls/key.pem', import.meta.url)),
      cert: fs.readFileSync(new URL('../fixtures/yunzhijia-tls/cert.pem', import.meta.url))
    },
    (req, res) => {
      let raw = '';
      req.on('data', (chunk) => {
        raw += chunk;
      });
      req.on('end', () => {
        outboundPosts.push(JSON.parse(raw));
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ ok: true }));
      });
    }
  );
  const yzjWss = new WebSocketServer({ server: yzjServer, path: '/xuntong/websocket' });
  await new Promise((resolve) => yzjServer.listen(0, '127.0.0.1', resolve));
  const yzjPort = yzjServer.address().port;
  const yzjSendUrl = `https://127.0.0.1:${yzjPort}/gateway/robot/webhook/send?yzjtype=0&yzjtoken=testtoken`;

  const adapter = new YunzhijiaAdapter({
    brokerUrl,
    sendUrl: yzjSendUrl
  });
  let agentSocket = null;

  t.after(async () => {
    if (agentSocket && agentSocket.readyState === WebSocket.OPEN) {
      const closed = once(agentSocket, 'close').catch(() => null);
      agentSocket.close();
      await closed;
    }
    adapter.stop();
    await new Promise((resolve) => yzjWss.close(resolve));
    await new Promise((resolve) => yzjServer.close(resolve));
    await brokerServer.close();
  });

  await adapter.registerToBroker();
  await adapter.connectBrokerWebSocket();
  await adapter.connectYunzhijiaWebSocket();
  await once(yzjWss, 'connection');

  const yzjSockets = Array.from(yzjWss.clients);
  yzjSockets[0].send(
    JSON.stringify({
      msg: {
        robotId: 'robot_local',
        operatorOpenid: 'user_local',
        content: '先建立会话',
        msgId: 'msg_presence_1'
      }
    })
  );

  await waitFor(() => adapter.userWebSockets.has('human.yzj_user_local'));
  outboundPosts.length = 0;

  broker.registerParticipant({
    participantId: 'codex.a',
    kind: 'agent',
    roles: ['coder'],
    capabilities: [],
    alias: 'codex4',
    context: { projectName: 'intent-broker' }
  });

  agentSocket = new WebSocket(`ws://127.0.0.1:${brokerPort}/ws?participantId=codex.a`);
  await once(agentSocket, 'open');

  await waitFor(() => outboundPosts.some((post) => /已上线/.test(post.content)));

  const onlinePosts = outboundPosts.filter((post) => /已上线/.test(post.content));
  assert.equal(onlinePosts.length, 1);

  const onlinePost = onlinePosts[0];
  assert.match(onlinePost.content, /codex4/);
  assert.equal(onlinePost.notifyParams, undefined);

  const closed = once(agentSocket, 'close').catch(() => null);
  agentSocket.close();
  await closed;
});

test('Yunzhijia adapter supports @broker list and reports agent presence to channel', { concurrency: false }, async (t) => {
  process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';

  const broker = createBrokerService({ dbPath: createTempDbPath() });
  const brokerServer = createServer({ broker });
  await brokerServer.listen(0, '127.0.0.1');
  broker.attachWebSocket(brokerServer.raw());
  const brokerPort = brokerServer.address().port;
  const brokerUrl = `http://127.0.0.1:${brokerPort}`;

  broker.registerParticipant({
    participantId: 'codex.a',
    kind: 'agent',
    roles: ['coder'],
    capabilities: [],
    alias: 'codex4',
    context: { projectName: 'intent-broker' }
  });
  broker.registerParticipant({
    participantId: 'claude.b',
    kind: 'agent',
    roles: ['coder'],
    capabilities: [],
    alias: 'claude2',
    context: { projectName: 'intent-broker' }
  });
  broker.updateWorkState('codex.a', { status: 'implementing', summary: '修复 presence' });
  broker.updateWorkState('claude.b', { status: 'reviewing', summary: '检查路由' });

  const outboundPosts = [];
  const yzjServer = https.createServer(
    {
      key: fs.readFileSync(new URL('../fixtures/yunzhijia-tls/key.pem', import.meta.url)),
      cert: fs.readFileSync(new URL('../fixtures/yunzhijia-tls/cert.pem', import.meta.url))
    },
    (req, res) => {
      let raw = '';
      req.on('data', (chunk) => {
        raw += chunk;
      });
      req.on('end', () => {
        outboundPosts.push(JSON.parse(raw));
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ ok: true }));
      });
    }
  );
  const yzjWss = new WebSocketServer({ server: yzjServer, path: '/xuntong/websocket' });
  await new Promise((resolve) => yzjServer.listen(0, '127.0.0.1', resolve));
  const yzjPort = yzjServer.address().port;
  const yzjSendUrl = `https://127.0.0.1:${yzjPort}/gateway/robot/webhook/send?yzjtype=0&yzjtoken=testtoken`;

  const adapter = new YunzhijiaAdapter({
    brokerUrl,
    sendUrl: yzjSendUrl
  });
  let agentSocket = null;

  t.after(async () => {
    if (agentSocket && agentSocket.readyState === WebSocket.OPEN) {
      const closed = once(agentSocket, 'close').catch(() => null);
      agentSocket.close();
      await closed;
    }
    adapter.stop();
    await new Promise((resolve) => yzjWss.close(resolve));
    await new Promise((resolve) => yzjServer.close(resolve));
    await brokerServer.close();
  });

  await adapter.registerToBroker();
  await adapter.connectBrokerWebSocket();
  await adapter.connectYunzhijiaWebSocket();
  await once(yzjWss, 'connection');

  agentSocket = new WebSocket(`ws://127.0.0.1:${brokerPort}/ws?participantId=codex.a`);
  await once(agentSocket, 'open');
  await waitFor(() => broker.getPresence('codex.a')?.status === 'online');

  outboundPosts.length = 0;

  const yzjSockets = Array.from(yzjWss.clients);
  yzjSockets[0].send(
    JSON.stringify({
      msg: {
        robotId: 'robot_local',
        operatorOpenid: 'user_local',
        content: '@broker list',
        msgId: 'msg_broker_list_1'
      }
    })
  );

  await waitFor(() => outboundPosts.some((post) => /协作列表/.test(post.content)));

  const listPost = outboundPosts.find((post) => /协作列表/.test(post.content));
  assert.match(listPost.content, /在线/);
  assert.match(listPost.content, /离线/);
  assert.match(listPost.content, /@codex4/);
  assert.match(listPost.content, /@claude2/);
  assert.match(listPost.content, /implementing/);
  assert.match(listPost.content, /reviewing/);
  assert.equal(listPost.notifyParams, undefined);

  const agentClosed = once(agentSocket, 'close').catch(() => null);
  agentSocket.close();
  await agentClosed;
});

test('Yunzhijia adapter broadcasts agent online and offline presence to channel', { concurrency: false }, async (t) => {
  process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';

  const broker = createBrokerService({ dbPath: createTempDbPath() });
  const brokerServer = createServer({ broker });
  await brokerServer.listen(0, '127.0.0.1');
  broker.attachWebSocket(brokerServer.raw());
  const brokerPort = brokerServer.address().port;
  const brokerUrl = `http://127.0.0.1:${brokerPort}`;

  const outboundPosts = [];
  const yzjServer = https.createServer(
    {
      key: fs.readFileSync(new URL('../fixtures/yunzhijia-tls/key.pem', import.meta.url)),
      cert: fs.readFileSync(new URL('../fixtures/yunzhijia-tls/cert.pem', import.meta.url))
    },
    (req, res) => {
      let raw = '';
      req.on('data', (chunk) => {
        raw += chunk;
      });
      req.on('end', () => {
        outboundPosts.push(JSON.parse(raw));
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ ok: true }));
      });
    }
  );
  const yzjWss = new WebSocketServer({ server: yzjServer, path: '/xuntong/websocket' });
  await new Promise((resolve) => yzjServer.listen(0, '127.0.0.1', resolve));
  const yzjPort = yzjServer.address().port;
  const yzjSendUrl = `https://127.0.0.1:${yzjPort}/gateway/robot/webhook/send?yzjtype=0&yzjtoken=testtoken`;

  const adapter = new YunzhijiaAdapter({
    brokerUrl,
    sendUrl: yzjSendUrl
  });

  t.after(async () => {
    adapter.stop();
    await new Promise((resolve) => yzjWss.close(resolve));
    await new Promise((resolve) => yzjServer.close(resolve));
    await brokerServer.close();
  });

  await adapter.registerToBroker();
  await adapter.connectBrokerWebSocket();
  await adapter.connectYunzhijiaWebSocket();
  await once(yzjWss, 'connection');

  broker.registerParticipant({
    participantId: 'codex.a',
    kind: 'agent',
    roles: ['coder'],
    capabilities: [],
    alias: 'codex4',
    context: { projectName: 'intent-broker' }
  });

  const agentSocket = new WebSocket(`ws://127.0.0.1:${brokerPort}/ws?participantId=codex.a`);
  await once(agentSocket, 'open');
  await waitFor(() => outboundPosts.some((post) => /已上线/.test(post.content)));

  assert.match(outboundPosts.find((post) => /已上线/.test(post.content)).content, /@codex4/);
  assert.equal(outboundPosts.find((post) => /已上线/.test(post.content)).notifyParams, undefined);

  agentSocket.close();

  await waitFor(() => outboundPosts.some((post) => /已离线/.test(post.content)));
  assert.match(outboundPosts.find((post) => /已离线/.test(post.content)).content, /@codex4/);
});

test('Yunzhijia adapter reconnects broker websocket after disconnect and keeps forwarding presence updates', { concurrency: false }, async (t) => {
  process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';

  const broker = createBrokerService({ dbPath: createTempDbPath() });
  const brokerServer = createServer({ broker });
  await brokerServer.listen(0, '127.0.0.1');
  broker.attachWebSocket(brokerServer.raw());
  const brokerPort = brokerServer.address().port;
  const brokerUrl = `http://127.0.0.1:${brokerPort}`;

  const outboundPosts = [];
  const yzjServer = https.createServer(
    {
      key: fs.readFileSync(new URL('../fixtures/yunzhijia-tls/key.pem', import.meta.url)),
      cert: fs.readFileSync(new URL('../fixtures/yunzhijia-tls/cert.pem', import.meta.url))
    },
    (req, res) => {
      let raw = '';
      req.on('data', (chunk) => {
        raw += chunk;
      });
      req.on('end', () => {
        outboundPosts.push(JSON.parse(raw));
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ ok: true }));
      });
    }
  );
  const yzjWss = new WebSocketServer({ server: yzjServer, path: '/xuntong/websocket' });
  await new Promise((resolve) => yzjServer.listen(0, '127.0.0.1', resolve));
  const yzjPort = yzjServer.address().port;
  const yzjSendUrl = `https://127.0.0.1:${yzjPort}/gateway/robot/webhook/send?yzjtype=0&yzjtoken=testtoken`;

  const adapter = new YunzhijiaAdapter({
    brokerUrl,
    sendUrl: yzjSendUrl,
    reconnectDelayMs: 10
  });
  let agentSocket = null;

  t.after(async () => {
    if (agentSocket && agentSocket.readyState === WebSocket.OPEN) {
      const closed = once(agentSocket, 'close').catch(() => null);
      agentSocket.close();
      await closed;
    }
    adapter.stop();
    await new Promise((resolve) => yzjWss.close(resolve));
    await new Promise((resolve) => yzjServer.close(resolve));
    await brokerServer.close();
  });

  await adapter.registerToBroker();
  await adapter.connectBrokerWebSocket();
  await adapter.connectYunzhijiaWebSocket();
  await once(yzjWss, 'connection');

  const firstBrokerWs = adapter.brokerWs;
  const closed = once(firstBrokerWs, 'close').catch(() => null);
  firstBrokerWs.close();
  await closed;

  await waitFor(() => (
    adapter.brokerWs
    && adapter.brokerWs !== firstBrokerWs
    && adapter.brokerWs.readyState === WebSocket.OPEN
  ), { timeoutMs: 2000 });

  await waitFor(() => broker.getPresence(ADAPTER_ID)?.status === 'online');

  broker.registerParticipant({
    participantId: 'codex.a',
    kind: 'agent',
    roles: ['coder'],
    capabilities: [],
    alias: 'codex4',
    context: { projectName: 'intent-broker' }
  });

  agentSocket = new WebSocket(`ws://127.0.0.1:${brokerPort}/ws?participantId=codex.a`);
  await once(agentSocket, 'open');

  await waitFor(() => outboundPosts.some((post) => /@codex4 已上线/.test(post.content)), { timeoutMs: 2000 });
});
