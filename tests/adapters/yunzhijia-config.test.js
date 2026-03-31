import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

test('Yunzhijia adapter start script loads env file and example URL is quoted', () => {
  const pkg = JSON.parse(fs.readFileSync(new URL('../../adapters/yunzhijia/package.json', import.meta.url), 'utf8'));
  const envExample = fs.readFileSync(new URL('../../adapters/yunzhijia/.env.example', import.meta.url), 'utf8');

  assert.equal(pkg.scripts.start, 'node --env-file=.env index.js');
  assert.match(envExample, /^YZJ_SEND_URL="https:\/\/www\.yunzhijia\.com\/gateway\/robot\/webhook\/send\?yzjtype=0&yzjtoken=YOUR_TOKEN"$/m);
});
