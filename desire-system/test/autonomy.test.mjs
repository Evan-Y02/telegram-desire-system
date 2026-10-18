import test from 'node:test';
import assert from 'node:assert/strict';
import config from '../config/default.example.json' with { type: 'json' };
import { actionLimit, autonomyPrompt, autonomyTimeContext, elapsedLabel } from '../src/autonomy.mjs';
import { initialState } from '../src/engine.mjs';

test('action count is one by default, two occasionally, three rarely', () => {
  assert.equal(actionLimit(config, 0.5), 1);
  assert.equal(actionLimit(config, 0.9), 2);
  assert.equal(actionLimit(config, 0.999), 3);
});

test('autonomy prompt forbids action padding and preserves privacy boundaries', () => {
  const prompt = autonomyPrompt(config, initialState(config), [], 2);
  assert.match(prompt, /不要凑数/);
  assert.match(prompt, /禁止陌生人私聊/);
  assert.match(prompt, /solo和找妻子都由你自由决定/);
  assert.match(prompt, /elapsed_since_last_interaction/);
});

test('autonomy receives Beijing time and elapsed interaction duration', () => {
  const now = Date.UTC(2026, 9, 18, 10, 12, 0);
  const state = initialState(config, now);
  state.interaction = { lastAt: now - 7260000, source: 'telegram_private' };
  const context = autonomyTimeContext(config, state, now);
  assert.match(context, /2026\/10\/18/);
  assert.match(context, /18:12:00/);
  assert.match(context, /2小时1分钟/);
  assert.equal(elapsedLabel(null, now), '此前没有可用记录');
});
