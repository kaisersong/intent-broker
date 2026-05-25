import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  YunzhijiaAdapter,
  extractYunzhijiaMedia
} from '../../adapters/yunzhijia/index.js';

function okJson(body) {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' }
  });
}

test('extractYunzhijiaMedia removes MEDIA directives and markdown images while preserving text', () => {
  const extracted = extractYunzhijiaMedia([
    '报告已生成',
    'MEDIA:/tmp/chart.png',
    '请看趋势图 ![趋势图](https://example.com/trend.png)'
  ].join('\n'));

  assert.equal(extracted.text, '报告已生成\n请看趋势图');
  assert.deepEqual(extracted.media, [
    {
      source: '/tmp/chart.png',
      caption: '',
      kind: 'image'
    },
    {
      source: 'https://example.com/trend.png',
      caption: '趋势图',
      kind: 'image'
    }
  ]);
});

test('Yunzhijia adapter uploads images and files through the App API before sending native media messages', async () => {
  const rootDir = await mkdtemp(join(tmpdir(), 'yzj-media-'));
  const imagePath = join(rootDir, 'chart.png');
  const filePath = join(rootDir, 'report.pdf');
  await writeFile(imagePath, Buffer.from([0x89, 0x50, 0x4e, 0x47]));
  await writeFile(filePath, Buffer.from('%PDF-1.7'));

  const requests = [];
  const fetchImpl = async (url, options = {}) => {
    requests.push({ url: String(url), options });

    if (String(url).endsWith('/api/oauth2_v12/auth/getAppAccessToken')) {
      return okJson({ data: { accessToken: 'access-token-1', expireIn: 7200 } });
    }

    if (String(url).endsWith('/gateway/docrest/doc/file/uploadfileOpen')) {
      const uploadCount = requests.filter((request) => request.url.endsWith('/gateway/docrest/doc/file/uploadfileOpen')).length;
      return okJson({ data: { fileId: `file-${uploadCount}` } });
    }

    if (String(url).endsWith('/gateway/xtinterface/message/send')) {
      return okJson({ success: true });
    }

    throw new Error(`unexpected URL: ${url}`);
  };

  const adapter = new YunzhijiaAdapter({
    brokerUrl: 'http://127.0.0.1:4318',
    sendUrl: 'https://legacy.example/gateway/robot/webhook/send?yzjtoken=legacy-token',
    appId: 'app-1',
    appSecret: 'secret-1',
    endpoint: 'https://yzj.example',
    fetchImpl
  });

  try {
    await adapter.sendToYunzhijia(
      'user-1',
      `报告已生成\nMEDIA:${imagePath}\nMEDIA:${filePath}`,
      'reply-msg-1'
    );

    const tokenRequest = requests.find((request) => request.url.endsWith('/api/oauth2_v12/auth/getAppAccessToken'));
    assert.ok(tokenRequest);
    assert.deepEqual(JSON.parse(tokenRequest.options.body), {
      appId: 'app-1',
      secret: 'secret-1',
      timestamp: JSON.parse(tokenRequest.options.body).timestamp
    });

    const uploadRequests = requests.filter((request) => request.url.endsWith('/gateway/docrest/doc/file/uploadfileOpen'));
    assert.equal(uploadRequests.length, 2);
    assert.equal(uploadRequests[0].options.headers.Authorization, 'Bearer access-token-1');
    assert.equal(uploadRequests[1].options.headers.Authorization, 'Bearer access-token-1');

    const messageBodies = requests
      .filter((request) => request.url.endsWith('/gateway/xtinterface/message/send'))
      .map((request) => JSON.parse(request.options.body));

    assert.equal(messageBodies.length, 3);
    assert.deepEqual(messageBodies[0], {
      msgType: 2,
      clientMsgId: messageBodies[0].clientMsgId,
      content: '报告已生成',
      toOpenId: 'user-1',
      replyMsgId: 'reply-msg-1'
    });
    assert.equal(messageBodies[1].msgType, 23);
    assert.equal(messageBodies[1].toOpenId, 'user-1');
    assert.deepEqual(messageBodies[1].param, {
      fileId: 'file-1',
      fileName: 'chart.png',
      fileType: 'img'
    });
    assert.equal(messageBodies[2].msgType, 23);
    assert.equal(messageBodies[2].toOpenId, 'user-1');
    assert.deepEqual(messageBodies[2].param, {
      fileId: 'file-2',
      fileName: 'report.pdf',
      fileType: 'file'
    });
  } finally {
    await rm(rootDir, { recursive: true, force: true });
  }
});

test('Yunzhijia adapter falls back to readable text when legacy webhook mode receives media references', async () => {
  const requests = [];
  const fetchImpl = async (url, options = {}) => {
    requests.push({ url: String(url), options });
    return okJson({ ok: true });
  };
  const adapter = new YunzhijiaAdapter({
    brokerUrl: 'http://127.0.0.1:4318',
    sendUrl: 'https://legacy.example/gateway/robot/webhook/send?yzjtoken=legacy-token',
    fetchImpl
  });

  await adapter.sendToYunzhijia(
    'user-1',
    '报告已生成\nMEDIA:https://example.com/report.pdf',
    'reply-msg-1'
  );

  assert.equal(requests.length, 1);
  const payload = JSON.parse(requests[0].options.body);
  assert.equal(payload.content, '报告已生成\nhttps://example.com/report.pdf');
  assert.equal(payload.param.replyMsgId, 'reply-msg-1');
  assert.deepEqual(payload.notifyParams[0].values, ['user-1']);
});

test('Yunzhijia adapter sends media references as text when App API upload fails', async (t) => {
  t.mock.method(console, 'error', () => {});

  const requests = [];
  const fetchImpl = async (url, options = {}) => {
    requests.push({ url: String(url), options });

    if (String(url).endsWith('/api/oauth2_v12/auth/getAppAccessToken')) {
      return okJson({ data: { accessToken: 'access-token-1', expireIn: 7200 } });
    }

    if (String(url) === 'https://example.com/chart.png') {
      return new Response(Buffer.from([0x89, 0x50, 0x4e, 0x47]), {
        status: 200,
        headers: { 'content-type': 'image/png' }
      });
    }

    if (String(url).endsWith('/gateway/docrest/doc/file/uploadfileOpen')) {
      return new Response(JSON.stringify({ error: 'upload failed' }), { status: 500 });
    }

    if (String(url).endsWith('/gateway/xtinterface/message/send')) {
      return okJson({ success: true });
    }

    throw new Error(`unexpected URL: ${url}`);
  };

  const adapter = new YunzhijiaAdapter({
    brokerUrl: 'http://127.0.0.1:4318',
    appId: 'app-1',
    appSecret: 'secret-1',
    endpoint: 'https://yzj.example',
    fetchImpl
  });

  await adapter.sendToYunzhijia(
    'user-1',
    '报告已生成\nMEDIA:https://example.com/chart.png',
    'reply-msg-1'
  );

  const messageBodies = requests
    .filter((request) => request.url.endsWith('/gateway/xtinterface/message/send'))
    .map((request) => JSON.parse(request.options.body));

  assert.equal(messageBodies.length, 2);
  assert.equal(messageBodies[0].content, '报告已生成');
  assert.equal(messageBodies[1].msgType, 2);
  assert.equal(messageBodies[1].content, 'https://example.com/chart.png');
  assert.equal(messageBodies[1].toOpenId, 'user-1');
});
