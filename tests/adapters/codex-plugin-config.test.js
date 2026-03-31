import test from 'node:test';
import assert from 'node:assert/strict';

import { enableCodexHooksFeature } from '../../adapters/codex-plugin/install.js';

test('enableCodexHooksFeature adds a features table when missing', () => {
  const updated = enableCodexHooksFeature('model = "gpt-5.4"\n');

  assert.match(updated, /\[features\]/);
  assert.match(updated, /codex_hooks = true/);
});

test('enableCodexHooksFeature preserves existing features and adds codex_hooks', () => {
  const updated = enableCodexHooksFeature('[features]\nmulti_agent = true\n');

  assert.match(updated, /\[features\]/);
  assert.match(updated, /multi_agent = true/);
  assert.match(updated, /codex_hooks = true/);
});

test('enableCodexHooksFeature does not duplicate codex_hooks when already enabled', () => {
  const updated = enableCodexHooksFeature('[features]\ncodex_hooks = true\nmulti_agent = true\n');

  assert.equal(updated.match(/codex_hooks = true/g).length, 1);
});
