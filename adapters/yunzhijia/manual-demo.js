#!/usr/bin/env node
/**
 * 手动演示云之家 Adapter webhook 示例
 */

// 模拟云之家发送的消息
const testYZJMessage = {
  robotId: 'robot_123',
  operatorOpenid: 'user_456',
  content: '你好，这是测试消息',
  msgId: 'msg_789',
  operatorName: '测试用户',
  robotName: '测试机器人',
  groupType: 1,
  time: Date.now()
};

console.log('📤 模拟云之家发送消息到 webhook:');
console.log(JSON.stringify(testYZJMessage, null, 2));

// 发送到本地 webhook
fetch('http://localhost:3000/webhook', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(testYZJMessage)
})
  .then(res => res.json())
  .then(data => {
    console.log('✅ Webhook 响应:', data);
  })
  .catch(err => {
    console.error('❌ 错误:', err.message);
  });
