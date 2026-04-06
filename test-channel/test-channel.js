#!/usr/bin/env node
/**
 * Test Channel - 模拟云之家 channel 进行闭环测试
 *
 * 功能：
 * 1. 模拟用户发送消息到 broker
 * 2. 监听 agent 回复
 * 3. 显示完整交互流程
 *
 * 用法：
 *   node test-channel.js <message>     发送消息
 *   node test-channel.js --watch       监听回复
 *   node test-channel.js --interactive 交互模式
 */

import WebSocket from 'ws';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { createInterface } from 'node:readline';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const BROKER_URL = process.env.BROKER_URL || 'http://127.0.0.1:4318';
const WS_URL = BROKER_URL.replace(/^http/, 'ws');
const TEST_USER_ID = 'test-user-001';
const TEST_PARTICIPANT_ID = `human.${TEST_USER_ID}`;

class TestChannel {
  constructor() {
    this.brokerUrl = BROKER_URL;
    this.wsUrl = WS_URL;
    this.userId = TEST_USER_ID;
    this.participantId = TEST_PARTICIPANT_ID;
    this.ws = null;
    this.msgCounter = 0;
    this.replyMap = new Map(); // threadId -> resolve function
  }

  async start() {
    console.log('🧪 Test Channel 启动');
    console.log(`   Broker: ${this.brokerUrl}`);
    console.log(`   User: ${this.participantId}`);
    console.log('');

    await this.registerUser();
    await this.connectWebSocket();
  }

  async registerUser() {
    const res = await fetch(`${this.brokerUrl}/participants/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        participantId: this.participantId,
        kind: 'human',
        roles: ['approver']
      })
    });
    if (!res.ok) throw new Error('Failed to register user');
    console.log('✓ 用户已注册到 broker');
  }

  async connectWebSocket() {
    return new Promise((resolve, reject) => {
      const wsUrl = `${this.wsUrl}/ws?participantId=${encodeURIComponent(this.participantId)}`;
      this.ws = new WebSocket(wsUrl);

      this.ws.on('open', () => {
        console.log('✓ WebSocket 已连接');
        console.log('');
        resolve();
      });

      this.ws.on('message', (data) => {
        const message = JSON.parse(data.toString());
        this.handleBrokerMessage(message);
      });

      this.ws.on('error', (err) => {
        console.error('WebSocket 错误:', err.message);
        reject(err);
      });

      this.ws.on('close', () => {
        console.log('⚠ WebSocket 已断开，尝试重连...');
        setTimeout(() => this.connectWebSocket().catch(console.error), 3000);
      });
    });
  }

  handleBrokerMessage(message) {
    if (message.type !== 'new_intent' || !message.event) {
      return;
    }

    const event = message.event;
    const kind = event.kind;
    const from = event.fromAlias || event.fromParticipantId;
    const summary = event.payload?.body?.summary;

    console.log(`\n📨 收到来自 @${from} 的消息:`);
    console.log(`   类型：${kind}`);
    console.log(`   内容：${summary}`);

    if (event.taskId && event.threadId) {
      console.log(`   任务：${event.taskId}`);
      console.log(`   线程：${event.threadId}`);
    }

    // 通知等待回复的调用者
    const threadKey = `${event.taskId}:${event.threadId}`;
    const resolver = this.replyMap.get(threadKey);
    if (resolver) {
      resolver(event);
      this.replyMap.delete(threadKey);
    }
  }

  async sendMessage(text, targetAlias = '@all') {
    const msgId = `test-msg-${Date.now()}-${this.msgCounter++}`;
    const taskId = `test-${msgId}`;
    const threadId = `test-${msgId}`;

    console.log(`\n📤 发送消息：${text}`);
    console.log(`   目标：${targetAlias}`);

    // 解析 @mentions
    const routing = this.parseRouting(text, targetAlias);

    const res = await fetch(`${this.brokerUrl}/intents`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        intentId: `test-${msgId}`,
        kind: 'ask_clarification',
        fromParticipantId: this.participantId,
        taskId,
        threadId,
        to: routing.to,
        payload: {
          body: { summary: routing.summary },
          metadata: { msgId, userId: this.userId }
        }
      })
    });

    const result = await res.json();
    console.log(`   Event ID: ${result.eventId}`);
    console.log(`   在线接收：${result.onlineRecipients?.length || 0}`);
    console.log(`   离线接收：${result.offlineRecipients?.length || 0}`);

    return { taskId, threadId, eventId: result.eventId };
  }

  parseRouting(text, targetAlias) {
    const mentions = [];
    let hasAll = false;
    let summary = text;

    if (targetAlias === '@all') {
      hasAll = true;
    }

    const mentionMatch = text.match(/@(\w+)/g);
    if (mentionMatch) {
      mentionMatch.forEach(m => {
        const alias = m.slice(1);
        if (alias.toLowerCase() === 'all') {
          hasAll = true;
        } else if (!mentions.includes(alias)) {
          mentions.push(alias);
        }
      });
    }

    return { mentions, hasAll, summary: text };
  }

  waitForReply(taskId, threadId, timeoutMs = 30000) {
    return new Promise((resolve, reject) => {
      const threadKey = `${taskId}:${threadId}`;

      const timer = setTimeout(() => {
        this.replyMap.delete(threadKey);
        resolve(null); // timeout
      }, timeoutMs);

      this.replyMap.set(threadKey, (event) => {
        clearTimeout(timer);
        resolve(event);
      });
    });
  }

  async runInteractiveTest() {
    console.log('\n=== 交互模式 ===');
    console.log('输入消息发送给 agent，输入 /quit 退出\n');

    const rl = createInterface({
      input: process.stdin,
      output: process.stdout
    });

    const prompt = () => {
      rl.question('你：', async (input) => {
        if (input.trim() === '/quit') {
          rl.close();
          this.ws?.close();
          console.log('👋 再见！');
          return;
        }

        if (input.trim()) {
          const { taskId, threadId } = await this.sendMessage(input);
          console.log('\n⏳ 等待回复... (30 秒超时)');

          const reply = await this.waitForReply(taskId, threadId);
          if (reply) {
            console.log(`\n✅ 收到回复：${reply.payload?.body?.summary}`);
          } else {
            console.log('\n⏰ 超时：未收到回复');
          }
        }

        console.log('');
        prompt();
      });
    };

    prompt();
  }

  async runScenarioTest() {
    console.log('\n=== 场景测试 ===\n');

    // 场景 1: @all 广播
    console.log('【场景 1】广播消息 @all');
    const r1 = await this.sendMessage('@all 请回复 1+1=?');
    let reply1 = await this.waitForReply(r1.taskId, r1.threadId, 15000);
    console.log(reply1 ? `✅ 收到：${reply1.payload?.body?.summary}` : '⏰ 无回复');

    // 等待一下
    await new Promise(r => setTimeout(r, 1000));

    // 场景 2: 定向消息 @codex
    console.log('\n【场景 2】定向消息 @codex');
    const r2 = await this.sendMessage('@codex 请计算 5*6=? 只回复数字');
    let reply2 = await this.waitForReply(r2.taskId, r2.threadId, 15000);
    console.log(reply2 ? `✅ 收到：${reply2.payload?.body?.summary}` : '⏰ 无回复');

    // 等待一下
    await new Promise(r => setTimeout(r, 1000));

    // 场景 3: 多轮对话
    console.log('\n【场景 3】多轮对话');
    const r3a = await this.sendMessage('@xiaok 你好');
    let reply3a = await this.waitForReply(r3a.taskId, r3a.threadId, 10000);
    console.log(reply3a ? `✅ 第一轮：${reply3a.payload?.body?.summary}` : '⏰ 无回复');

    if (reply3a) {
      const r3b = await this.sendMessage('继续上题，2+8=?');
      let reply3b = await this.waitForReply(r3b.taskId, r3b.threadId, 10000);
      console.log(reply3b ? `✅ 第二轮：${reply3b.payload?.body?.summary}` : '⏰ 无回复');
    }

    console.log('\n=== 测试完成 ===\n');
  }

  async listParticipants() {
    const res = await fetch(`${this.brokerUrl}/participants`);
    const data = await res.json();
    return data.participants || [];
  }

  async checkPresence() {
    const res = await fetch(`${this.brokerUrl}/presence`);
    const data = await res.json();
    return data.participants || [];
  }
}

// 主程序
async function main() {
  const args = process.argv.slice(2);
  const channel = new TestChannel();

  try {
    await channel.start();

    // 显示在线参与者
    console.log('📋 当前在线参与者:');
    const presence = await channel.checkPresence();
    const agents = presence.filter(p => p.status === 'online' && p.participantId.includes('session'));
    agents.forEach(p => {
      console.log(`   - ${p.participantId}`);
    });
    console.log('');

    if (args.includes('--interactive')) {
      await channel.runInteractiveTest();
    } else if (args.includes('--scenario')) {
      await channel.runScenarioTest();
    } else if (args[0]) {
      // 发送单条消息
      const message = args.join(' ');
      await channel.sendMessage(message);
      console.log('\n⏳ 等待回复... (按 Ctrl+C 退出)');

      // 保持运行等待回复
      await new Promise(() => {});
    } else {
      // 默认：场景测试
      await channel.runScenarioTest();
      console.log('\n提示：使用 --interactive 进入交互模式');
    }

  } catch (error) {
    console.error('错误:', error.message);
    process.exit(1);
  }
}

main();
