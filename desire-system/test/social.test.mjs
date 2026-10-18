import test from 'node:test';
import assert from 'node:assert/strict';
import config from '../config/default.example.json' with { type: 'json' };
import { initialState } from '../src/engine.mjs';
import { socialPrompt } from '../src/social.mjs';

test('social prompt contains hard permission boundaries', () => {
  const prompt = socialPrompt(config, initialState(config));
  for (const text of ['禁止私聊陌生人', '消费', '修改账号资料', '透露用户隐私', '不得转化为私人 libido/arousal']) {
    assert.match(prompt, new RegExp(text));
  }
});

test('runtime switches are explicit and dangerous permissions stay closed', () => {
  assert.equal(typeof config.observeOnly, 'boolean');
  assert.equal(typeof config.social.externalWritesEnabled, 'boolean');
  assert.equal(config.social.permissions.directMessages, false);
  assert.equal(config.social.permissions.spending, false);
  assert.equal(config.social.permissions.accountChanges, false);
  assert.equal(config.social.permissions.privateDisclosure, false);
});
