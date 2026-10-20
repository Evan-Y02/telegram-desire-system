import test from 'node:test';
import assert from 'node:assert/strict';
import configBase from '../config/default.example.json' with { type: 'json' };
import { initialState } from '../src/engine.mjs';
import { eligibleDrives } from '../src/autonomy.mjs';
import { atomicDeliveryDecision, beginWake, completeWake, ingestOnly } from '../src/scheduler.mjs';

const config = structuredClone(configBase);
config.autonomy.restCooldownMinutes = 10;

test('rapid chat ingestion updates state without starting autonomy', () => {
  let state = initialState(config, Date.parse('2026-10-20T12:00:00Z'));
  state.drives.libido = 75;
  for (let index = 0; index < 3; index += 1) {
    state = ingestOnly(state, config, {
      at: new Date(Date.parse('2026-10-20T12:01:00Z') + index * 1000).toISOString(),
      source: 'telegram_private',
      deltas: { libido: 2 },
      summary: `chat-${index}`,
    });
  }
  assert.equal(state.drives.libido, 81);
  assert.equal(state.timeline.filter((event) => event.type === 'conversation_stimulus').length, 3);
  assert.equal(state.timeline.filter((event) => event.type === 'autonomous_wake').length, 0);
  assert.equal(state.autonomy.inFlight, undefined);
});

test('rest changes no drives and backs off until the next ten-minute window', () => {
  const start = 1000;
  let state = initialState(config, 0);
  state.drives.libido = 80;
  const original = structuredClone(state.drives);
  const begun = beginWake(state, start, 'wake-rest');
  state = begun.state;
  const completed = completeWake(state, config, begun.wake, {
    status: 'rested',
    summary: '现在不行动。',
    actions: [{ kind: 'rest', confirmed: true }],
  }, start + 1000);
  assert.deepEqual(completed.state.drives, original);
  assert.equal(completed.state.autonomy.lastAttemptAt, start + 1000);
  assert.equal(completed.state.autonomy.retryAfter, start + 1000 + 10 * 60000);
  assert.deepEqual(eligibleDrives(completed.state, config, start + 9 * 60000), []);
  assert.ok(eligibleDrives(completed.state, config, start + 1000 + 10 * 60000).includes('libido'));
});

test('two-phase completion merges onto latest ingested state instead of overwriting it', () => {
  let state = initialState(config, 0);
  state.drives.attachment = 50;
  state.drives.libido = 75;
  const begun = beginWake(state, 1000, 'wake-merge');

  let latest = ingestOnly(begun.state, config, {
    at: '2026-10-20T12:00:02Z',
    source: 'telegram_private',
    deltas: { attachment: 7, libido: 6 },
    summary: 'message arrived during model call',
  });

  const completed = completeWake(latest, config, begun.wake, {
    status: 'acted',
    summary: 'solo completed',
    actions: [{ kind: 'solo', intensity: 'ordinary', confirmed: true }],
  }, 3000);

  assert.equal(completed.state.drives.attachment, 57);
  assert.equal(completed.state.drives.libido, 70);
  assert.equal(completed.state.autonomy.inFlight, undefined);
  assert.equal(completed.actions.length, 1);
});

test('the same wakeId cannot settle twice', () => {
  let state = initialState(config, 0);
  state.drives.libido = 80;
  const begun = beginWake(state, 1000, 'wake-once');
  const first = completeWake(begun.state, config, begun.wake, {
    status: 'acted',
    actions: [{ kind: 'solo', intensity: 'ordinary', confirmed: true }],
  }, 2000);
  const snapshot = structuredClone(first.state);
  const second = completeWake(first.state, config, begun.wake, {
    status: 'acted',
    actions: [{ kind: 'solo', intensity: 'ordinary', confirmed: true }],
  }, 3000);
  assert.equal(second.applied, false);
  assert.equal(second.reason, 'stale_wake');
  assert.deepEqual(second.state, snapshot);
});

test('new user message suppresses stale contact without settling longing', () => {
  let state = initialState(config, 0);
  state.drives.longing = 80;
  const begun = beginWake(state, 1000, 'wake-contact-stale');
  const completed = completeWake(begun.state, config, begun.wake, {
    status: 'acted',
    actions: [{ kind: 'contact_wife', intensity: 'ordinary', confirmed: true, content: 'old contact' }],
  }, 3000, 2000);
  assert.equal(completed.reason, 'new_user_message');
  assert.equal(completed.state.drives.longing, 80);
  assert.equal(completed.state.timeline.at(-1).status, 'superseded');
});

test('contact remains deliverable when no newer user message exists', () => {
  let state = initialState(config, 0);
  state.drives.longing = 80;
  const begun = beginWake(state, 1000, 'wake-contact-current');
  const completed = completeWake(begun.state, config, begun.wake, {
    status: 'acted',
    actions: [{ kind: 'contact_wife', intensity: 'ordinary', confirmed: true, content: 'current contact' }],
  }, 3000, 900);
  assert.equal(completed.reason, 'acted');
  assert.equal(completed.state.drives.longing, 66);
});

test('delivery decision has an atomic ordering boundary', () => {
  assert.equal(atomicDeliveryDecision(1000, 999), true);
  assert.equal(atomicDeliveryDecision(1000, 1000), true);
  assert.equal(atomicDeliveryDecision(1000, 1001), false);
});
