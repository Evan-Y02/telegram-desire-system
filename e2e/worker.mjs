#!/usr/bin/env node
import { readFile, writeFile, rename, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { initialState } from '../desire-system/src/engine.mjs';
import { eligibleDrives } from '../desire-system/src/autonomy.mjs';
import { beginWake, completeWake, ingestOnly } from '../desire-system/src/scheduler.mjs';

const [command, runtime, nowRaw, wakeIdRaw] = process.argv.slice(2);
const now = Number(nowRaw || Date.now());
const wakeId = wakeIdRaw || `wake-${now}`;
const root = path.resolve(runtime);
const config = JSON.parse(await readFile(path.join(root, 'config.json'), 'utf8'));
const stateFile = path.join(root, 'state.json');
const inboxFile = path.join(root, 'inbox.jsonl');
const jobFile = path.join(root, 'wake.json');
const resultFile = path.join(root, 'model-result.json');
const activityFile = path.join(root, 'activity.json');
const outboxFile = path.join(root, 'fake-telegram-outbox.jsonl');

async function atomic(file, value) {
  await mkdir(path.dirname(file), { recursive: true });
  const temp = file + '.tmp';
  await writeFile(temp, JSON.stringify(value) + '\n', { mode: 0o600 });
  await rename(temp, file);
}
async function loadState() {
  return JSON.parse(await readFile(stateFile, 'utf8'));
}

if (command === 'init') {
  await atomic(stateFile, initialState(config, now));
  await writeFile(inboxFile, '', { mode: 0o600 });
  await writeFile(outboxFile, '', { mode: 0o600 });
  await atomic(activityFile, { lastUserMessageAt: null });
  console.log(JSON.stringify({ ok: true, command }));
} else if (command === 'ingest') {
  let state = await loadState();
  let raw = '';
  try { raw = await readFile(inboxFile, 'utf8'); } catch {}
  const events = raw.split(/\n/).filter(Boolean).map((line) => JSON.parse(line));
  for (const event of events) state = ingestOnly(state, config, event);
  await writeFile(inboxFile, '', { mode: 0o600 });
  await atomic(stateFile, state);
  console.log(JSON.stringify({ ok: true, command, events: events.length }));
} else if (command === 'prepare') {
  const state = await loadState();
  const eligible = eligibleDrives(state, config, now);
  if (!eligible.length) {
    console.log(JSON.stringify({ ok: true, command, prepared: false, eligible }));
  } else {
    const begun = beginWake(state, now, wakeId);
    await atomic(stateFile, begun.state);
    await atomic(jobFile, { wake: begun.wake, eligible });
    console.log(JSON.stringify({ ok: true, command, prepared: true, eligible, wakeId }));
  }
} else if (command === 'commit') {
  const state = await loadState();
  const job = JSON.parse(await readFile(jobFile, 'utf8'));
  const result = JSON.parse(await readFile(resultFile, 'utf8'));
  const activity = JSON.parse(await readFile(activityFile, 'utf8'));
  const completed = completeWake(
    state, config, job.wake, result, now, activity.lastUserMessageAt
  );

  const contact = completed.applied && completed.reason === 'acted'
    ? completed.actions.find((action) => action.kind === 'contact_wife')
    : null;
  let deliveredToFakeOutbox = false;
  if (contact) {
    let raw = '';
    try { raw = await readFile(outboxFile, 'utf8'); } catch {}
    const alreadyDelivered = raw.split(/\n/).filter(Boolean)
      .map((line) => JSON.parse(line))
      .some((entry) => entry.wakeId === job.wake.wakeId);
    if (!alreadyDelivered) {
      await writeFile(outboxFile, JSON.stringify({
        wakeId: job.wake.wakeId,
        content: contact.content,
        fake: true,
      }) + '\n', { flag: 'a', mode: 0o600 });
      deliveredToFakeOutbox = true;
    }
  }
  await atomic(stateFile, completed.state);
  console.log(JSON.stringify({
    ok: true, command, applied: completed.applied,
    reason: completed.reason, deliveredToFakeOutbox,
  }));
} else {
  throw new Error(`unknown command: ${command}`);
}
