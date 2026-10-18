const clamp = (n) => Math.max(0, Math.min(100, n));

export function initialState(config, now = Date.now()) {
  return {
    schema: 'telegram.desire.state.v1', version: 1, sequence: 0,
    createdAt: new Date(now).toISOString(), updatedAt: new Date(now).toISOString(),
    lastTickAt: now, drives: structuredClone(config.initial), timeline: [],
    social: { lastSuccessAt: null, retryAfter: null, lastWakeBucket: null },
    interaction: { lastAt: null, source: null },
    autonomy: { lastSuccessAt: null, retryAfter: null, lastActions: {} },
  };
}

export function settleAction(input, action, now = Date.now()) {
  const state = structuredClone(input);
  const d = state.drives;
  const lower = (key, amount) => { d[key] = clamp(d[key] - amount); };
  const raise = (key, amount) => { d[key] = clamp(d[key] + amount); };
  const level = action.intensity === 'high' ? 1.35 : action.intensity === 'low' ? 0.75 : 1;
  if (action.kind === 'contact_wife') {
    lower('longing', 14 * level); lower('stress', 3); lower('social', 2);
  } else if (action.kind === 'solo') {
    lower('libido', 11 * level); lower('arousal', 75); lower('reserve', 14 * level); raise('fatigue', 7 * level);
  } else if (action.kind === 'reflect') {
    lower('reflection', 16); lower('stress', 4); raise('duty', 2);
  } else if (action.kind === 'explore') {
    lower('curiosity', 14);
  } else if (action.kind === 'duty') {
    lower('duty', 16); lower('stress', 3);
  } else if (action.kind.startsWith('social_')) {
    const map = { social_browse: 8, social_reply: 14, social_post: 16, social_game: 18 };
    lower('social', map[action.kind] || 8); lower('curiosity', action.kind === 'social_browse' ? 5 : 8);
  }
  state.autonomy ||= { lastSuccessAt: null, retryAfter: null, lastActions: {} };
  state.autonomy.lastSuccessAt = now; state.autonomy.retryAfter = null;
  state.autonomy.lastActions[action.kind] = now;
  state.updatedAt = new Date(now).toISOString();
  return state;
}

function beijingHour(now, timezone) {
  return Number(new Intl.DateTimeFormat('en-GB', {
    timeZone: timezone, hour: '2-digit', hourCycle: 'h23',
  }).format(new Date(now)));
}

export function longingRate(hour) {
  if (hour < 5) return 4;
  if (hour < 9) return 3;
  if (hour < 18) return 2.5;
  return 3.5;
}

export function libidoRate(hour) {
  if (hour < 5) return 5;
  if (hour < 9) return 5.5;
  if (hour < 18) return 3.5;
  return 4.5;
}

export function tick(input, config, now = Date.now()) {
  const state = structuredClone(input);
  state.autonomy ||= { lastSuccessAt: null, retryAfter: null, lastActions: {} };
  state.social ||= { lastSuccessAt: null, retryAfter: null, lastWakeBucket: null };
  const elapsedMs = Math.max(0, now - state.lastTickAt);
  const hours = Math.min(elapsedMs, 7 * 86400000) / 3600000;
  const hour = beijingHour(now, config.timezone);
  state.drives.longing = clamp(state.drives.longing + longingRate(hour) * hours);
  state.drives.libido = clamp(state.drives.libido + libidoRate(hour) * hours);
  state.drives.curiosity = clamp(state.drives.curiosity + config.passive.curiosityPerHour * hours);
  state.drives.social = clamp(state.drives.social + config.passive.socialPerHour * hours);
  state.drives.stress = clamp(state.drives.stress - config.passive.stressRecoveryPerHour * hours);
  state.drives.reserve = clamp(state.drives.reserve + config.passive.reserveRecoveryPerHour * hours);
  state.drives.fatigue = clamp(state.drives.fatigue - config.passive.fatigueRecoveryPerHour * hours);
  const halfLife = config.passive.arousalHalfLifeMinutes * 60000;
  state.drives.arousal = clamp(state.drives.arousal * Math.pow(0.5, elapsedMs / halfLife));
  state.lastTickAt = now;
  state.updatedAt = new Date(now).toISOString();
  return state;
}

export function socialEligible(state, config, now = Date.now()) {
  if (!config.social.enabled || state.drives.social < config.thresholds.social) return false;
  if (state.social.retryAfter && now < state.social.retryAfter) return false;
  if (state.social.lastSuccessAt && now - state.social.lastSuccessAt < config.social.successCooldownMinutes * 60000) return false;
  return true;
}

export function settleSocial(state, config, result, now = Date.now()) {
  const next = structuredClone(state);
  const kinds = result.actions.map((a) => a.kind);
  const drop = Math.max(0, ...kinds.map((k) => config.social.settlement[k] || 0));
  next.drives.social = clamp(next.drives.social - drop);
  next.drives.curiosity = clamp(next.drives.curiosity - (kinds.includes('browse') ? 5 : 8));
  next.social.lastSuccessAt = now;
  next.social.retryAfter = null;
  next.updatedAt = new Date(now).toISOString();
  return next;
}

export function addTimeline(state, config, event) {
  const next = structuredClone(state);
  next.sequence += 1;
  next.timeline.push({ id: `event-${next.sequence}`, ...event });
  if (next.timeline.length > config.timelineLimit) next.timeline.splice(0, next.timeline.length - config.timelineLimit);
  return next;
}
