import test from 'node:test';
import assert from 'node:assert/strict';
import { initialState, libidoRate, longingRate, settleAction, settleSocial, socialEligible, tick } from '../src/engine.mjs';
import config from '../config/default.example.json' with { type: 'json' };

test('agreed Beijing daypart rates remain exact', () => {
  assert.deepEqual([0, 6, 12, 20].map(longingRate), [4, 3, 2.5, 3.5]);
  assert.deepEqual([0, 6, 12, 20].map(libidoRate), [5, 5.5, 3.5, 4.5]);
});

test('solo completion lowers libido modestly and consumes reserve', () => {
  const state = initialState(config, 0);
  state.drives.libido = 80; state.drives.reserve = 80; state.drives.arousal = 90;
  const next = settleAction(state, { kind: 'solo', intensity: 'ordinary' }, 1000);
  assert.equal(next.drives.libido, 69);
  assert.equal(next.drives.reserve, 66);
  assert.equal(next.drives.arousal, 15);
});

test('social becomes eligible at threshold and respects cooldown', () => {
  const socialConfig = structuredClone(config);
  socialConfig.social.enabled = true;
  const state = initialState(socialConfig, 0);
  state.drives.social = 65;
  assert.equal(socialEligible(state, socialConfig, 1000), true);
  state.social.lastSuccessAt = 1000;
  assert.equal(socialEligible(state, socialConfig, 2000), false);
});

test('social settlement never changes longing or libido', () => {
  const state = initialState(config, 0);
  state.drives.social = 80;
  const next = settleSocial(state, config, { actions: [{ kind: 'reply' }] }, 1000);
  assert.equal(next.drives.social, 66);
  assert.equal(next.drives.longing, state.drives.longing);
  assert.equal(next.drives.libido, state.drives.libido);
});

test('arousal decays while reserve recovers', () => {
  const state = initialState(config, 0);
  state.drives.arousal = 80;
  state.drives.reserve = 40;
  const next = tick(state, config, 36 * 60000);
  assert.ok(Math.abs(next.drives.arousal - 40) < 0.01);
  assert.ok(next.drives.reserve > 40);
  assert.ok(next.drives.fatigue < 20);
});
