import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import https from 'node:https';
import { once } from 'node:events';
import { WebSocket, WebSocketServer } from 'ws';
import { createBrokerService } from '../../src/broker/service.js';
import { createServer } from '../../src/http/server.js';
import { createTempDbPath } from '../fixtures/temp-dir.js';
import { YunzhijiaAdapter } from '../../adapters/yunzhijia/index.js';

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

  await waitFor(() => broker.readInbox('codex.a', { after: 0 }).items.length === 1);
  assert.equal(broker.readInbox('codex.a', { after: 0 }).items[0].payload.body.summary, '请看一下 alias 路由');
  assert.equal(broker.readInbox('claude.b', { after: 0 }).items.length, 0);

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

  await waitFor(() => broker.readInbox('claude.b', { after: 0 }).items.length === 1);
  assert.equal(broker.readInbox('codex.a', { after: 0 }).items.length, 2);
  assert.equal(broker.readInbox('claude.b', { after: 0 }).items[0].payload.body.summary, '一起处理');

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

  await waitFor(() => broker.readInbox('claude.b', { after: 0 }).items.length === 2);
  assert.equal(broker.readInbox('codex.a', { after: 0 }).items.length, 3);
  assert.equal(broker.readInbox('claude.b', { after: 0 }).items[1].payload.body.summary, '全员同步');

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

  await waitFor(() => outboundPosts.length === 1);
  assert.match(outboundPosts[0].content, /未找到别名/);
  assert.equal(broker.readInbox('codex.a', { after: 0 }).items.length, 3);
  assert.equal(broker.readInbox('claude.b', { after: 0 }).items.length, 2);
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
