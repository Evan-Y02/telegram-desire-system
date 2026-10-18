#!/usr/bin/env node
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { addTimeline, settleAction, tick } from '../src/engine.mjs';
import { loadConfig, loadState, saveState } from '../src/storage.mjs';
import { actionLimit, eligibleDrives, runAutonomy } from '../src/autonomy.mjs';
import { appendExperience, applyDelta, consumeInbox, recentExperiences, refreshMemoryContext, writeJournal } from '../src/experience.mjs';
import { sendTelegram } from '../src/telegram.mjs';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const config = await loadConfig(process.env.TELEGRAM_DESIRE_CONFIG || path.join(root, 'config/default.json'));
let state = tick(await loadState(config), config);

for (const event of await consumeInbox(config)) {
  state = applyDelta(state, event.deltas || {});
  const interactionAt = Date.parse(event.at || '');
  if (Number.isFinite(interactionAt)) {
    state.interaction ||= { lastAt: null, source: null };
    if (!state.interaction.lastAt || interactionAt >= state.interaction.lastAt) {
      state.interaction = { lastAt: interactionAt, source: event.source || 'conversation' };
    }
  }
  state = addTimeline(state, config, { at: event.at || new Date().toISOString(), type: 'conversation_stimulus',
    status: 'applied', reasons: event.signals || [], summary: event.summary || '对话刺激已写入。' });
  await appendExperience(config, { ...event, type: 'conversation' });
}

const eligible = eligibleDrives(state, config);
if (config.autonomy.enabled && eligible.length) {
  const at = new Date().toISOString();
  if (config.observeOnly) {
    state = addTimeline(state, config, { at, type: 'autonomy_eligible', status: 'observed',
      reasons: eligible, summary: '达到行动门槛；观察模式未执行。' });
  } else {
    try {
      const memories = await recentExperiences(config);
      const limit = Math.min(actionLimit(config), eligible.length, config.maxActionsPerWake);
      const result = await runAutonomy(config, state, memories, root, limit);
      const confirmed = result.actions.filter((action) => action.confirmed && action.kind !== 'rest').slice(0, limit);
      const records = [];
      for (const action of confirmed) {
        let journal = null;
        if (['solo','reflect','explore','duty'].includes(action.kind)) journal = await writeJournal(config, action);
        if (action.kind === 'contact_wife') await sendTelegram(config, action.content || action.summary);
        state = settleAction(state, action);
        const record = await appendExperience(config, { type: 'autonomous_action', kind: action.kind,
          summary: action.summary, content: action.content, intensity: action.intensity, journal });
        records.push({ ...action, journal, at: record.at });
      }
      state = addTimeline(state, config, { at, type: 'autonomous_wake', status: result.status,
        reasons: eligible, summary: result.summary, actions: records.length ? records : result.actions });
    } catch (error) {
      state.autonomy ||= { lastSuccessAt: null, retryAfter: null, lastActions: {} };
      state.autonomy.retryAfter = Date.now() + config.autonomy.failureBackoffMinutes * 60000;
      state = addTimeline(state, config, { at, type: 'autonomous_wake', status: 'failed',
        reasons: [error.message], summary: '自主行动未完成；数值未结算，心跳继续。' });
    }
  }
}

await saveState(config, state);
await refreshMemoryContext(config, state);
console.log(JSON.stringify({ ok: true, observeOnly: config.observeOnly, eligible,
  timelineCount: state.timeline.length }));
