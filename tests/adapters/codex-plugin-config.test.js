import test from 'node:test';
import assert from 'node:assert/strict';

import { enableHooksFeature } from '../../adapters/codex-plugin/install.js';

test('enableHooksFeature adds a features table when missing', () => {
  const updated = enableHooksFeature('model = "gpt-5.4"\n');

  assert.match(updated, /\[features\]/);
  assert.match(updated, /hooks = true/);
  assert.doesNotMatch(updated, /codex_hooks = true/);
});

test('enableHooksFeature preserves existing features and adds hooks', () => {
  const updated = enableHooksFeature('[features]\nmulti_agent = true\n');

  assert.match(updated, /\[features\]/);
  assert.match(updated, /multi_agent = true/);
  assert.match(updated, /hooks = true/);
  assert.doesNotMatch(updated, /codex_hooks = true/);
});

test('enableHooksFeature does not duplicate hooks when already enabled', () => {
  const updated = enableHooksFeature('[features]\nhooks = true\nmulti_agent = true\n');

  assert.equal(updated.match(/hooks = true/g).length, 1);
  assert.doesNotMatch(updated, /codex_hooks = true/);
});

test('enableHooksFeature migrates deprecated codex_hooks to hooks', () => {
  const updated = enableHooksFeature('[features]\ncodex_hooks = true\nmulti_agent = true\n');

  assert.match(updated, /\[features\]/);
  assert.match(updated, /hooks = true/);
  assert.match(updated, /multi_agent = true/);
  assert.doesNotMatch(updated, /codex_hooks = true/);
});

test('enableHooksFeature removes deprecated codex_hooks when hooks is already enabled', () => {
  const updated = enableHooksFeature('[features]\ncodex_hooks = true\nmulti_agent = true\nhooks = true\n');

  assert.equal(updated.match(/hooks = true/g).length, 1);
  assert.match(updated, /multi_agent = true/);
  assert.doesNotMatch(updated, /codex_hooks = true/);
});
