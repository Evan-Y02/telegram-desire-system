import { addTimeline, settleAction } from './engine.mjs';
import { applyDelta } from './experience.mjs';

const clone = (value) => structuredClone(value);

export function ingestOnly(input, config, event) {
  let state = applyDelta(clone(input), event.deltas || {});
  const interactionAt = Date.parse(event.at || '');
  if (Number.isFinite(interactionAt)) {
    state.interaction ||= { lastAt: null, source: null };
    if (!state.interaction.lastAt || interactionAt >= state.interaction.lastAt) {
      state.interaction = { lastAt: interactionAt, source: event.source || 'conversation' };
    }
  }
  return addTimeline(state, config, {
    at: event.at || new Date().toISOString(),
    type: 'conversation_stimulus',
    status: 'applied',
    reasons: event.signals || [],
    summary: event.summary || '对话刺激已写入。',
  });
}

export function beginWake(input, now, wakeId) {
  const state = clone(input);
  state.autonomy ||= {};
  state.autonomy.inFlight = {
    wakeId,
    startedAt: now,
    baseSequence: state.sequence || 0,
  };
  return { state, wake: clone(state.autonomy.inFlight) };
}

export function completeWake(input, config, wake, result, now, latestUserMessageAt = null) {
  let state = clone(input);
  if (state.autonomy?.inFlight?.wakeId !== wake.wakeId) {
    return { state, applied: false, reason: 'stale_wake', actions: [] };
  }

  let actions = (result.actions || [])
    .filter((action) => action.confirmed && action.kind !== 'rest');

  const newerUserMessage = Number.isFinite(Number(latestUserMessageAt))
    && Number(latestUserMessageAt) > Number(wake.startedAt);
  if (newerUserMessage) {
    actions = actions.filter((action) => action.kind !== 'contact_wife');
  }

  state.autonomy.lastAttemptAt = now;
  delete state.autonomy.inFlight;

  if (!actions.length) {
    state.autonomy.retryAfter = now + config.autonomy.restCooldownMinutes * 60000;
    state = addTimeline(state, config, {
      at: new Date(now).toISOString(),
      type: 'autonomous_wake',
      status: newerUserMessage ? 'superseded' : 'rested',
      reasons: result.reasons || [],
      summary: newerUserMessage
        ? '自主联系因新的用户消息到达而取消。'
        : (result.summary || '本轮选择休息；驱力未结算。'),
      actions: result.actions || [],
    });
    return { state, applied: true, reason: newerUserMessage ? 'new_user_message' : 'rest', actions: [] };
  }

  for (const action of actions) state = settleAction(state, action, now);
  state.autonomy.lastAttemptAt = now;
  delete state.autonomy.inFlight;
  state = addTimeline(state, config, {
    at: new Date(now).toISOString(),
    type: 'autonomous_wake',
    status: 'acted',
    reasons: result.reasons || [],
    summary: result.summary || '自主行动已完成。',
    actions,
  });
  return { state, applied: true, reason: 'acted', actions };
}

export function atomicDeliveryDecision(wakeStartedAt, latestUserMessageAt) {
  return !(Number.isFinite(Number(latestUserMessageAt))
    && Number(latestUserMessageAt) > Number(wakeStartedAt));
}
