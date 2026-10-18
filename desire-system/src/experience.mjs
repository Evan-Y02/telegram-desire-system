import { appendFile, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';

const clamp = (n) => Math.max(0, Math.min(100, Number(n) || 0));
const allowed = new Set(['attachment','longing','curiosity','reflection','duty','social','fatigue','libido','stress','arousal','reserve']);

export function applyDelta(state, deltas = {}) {
  const next = structuredClone(state);
  for (const [key, raw] of Object.entries(deltas)) {
    if (!allowed.has(key) || !Number.isFinite(Number(raw))) continue;
    const bounded = Math.max(-25, Math.min(25, Number(raw)));
    next.drives[key] = clamp(next.drives[key] + bounded);
  }
  next.updatedAt = new Date().toISOString();
  return next;
}

export async function appendExperience(config, event) {
  await mkdir(config.dataDirectory, { recursive: true, mode: 0o700 });
  const record = { at: new Date().toISOString(), ...event };
  await appendFile(config.memory.eventLog, `${JSON.stringify(record)}\n`, { mode: 0o600 });
  return record;
}

export async function consumeInbox(config) {
  await mkdir(config.dataDirectory, { recursive: true, mode: 0o700 });
  const inbox = config.memory.inbox;
  const processing = `${inbox}.${process.pid}.processing`;
  try { await rename(inbox, processing); }
  catch (error) { if (error.code === 'ENOENT') return []; throw error; }
  const text = await readFile(processing, 'utf8');
  await writeFile(processing, '', { mode: 0o600 });
  const events = text.split('\n').filter(Boolean).flatMap((line) => {
    try { return [JSON.parse(line)]; } catch { return []; }
  });
  await import('node:fs/promises').then(({ rm }) => rm(processing, { force: true }));
  return events;
}

export async function recentExperiences(config, limit = config.memory.recentEventCount) {
  try {
    const lines = (await readFile(config.memory.eventLog, 'utf8')).trim().split('\n').filter(Boolean);
    return lines.slice(-limit).flatMap((line) => { try { return [JSON.parse(line)]; } catch { return []; } });
  } catch (error) { if (error.code === 'ENOENT') return []; throw error; }
}

export async function writeJournal(config, action, now = Date.now()) {
  await mkdir(config.autonomy.journalDirectory, { recursive: true, mode: 0o700 });
  const stamp = new Date(now).toISOString().replaceAll(':', '-');
  const file = path.join(config.autonomy.journalDirectory, `${stamp}-${action.kind}.md`);
  const title = action.kind === 'solo' ? '黄色札记' : action.kind === 'reflect' ? '反思札记' : '自主札记';
  await writeFile(file, `# ${title}\n\n时间：${new Date(now).toISOString()}\n\n${action.content || action.summary}\n`, { mode: 0o600 });
  return file;
}

export async function refreshMemoryContext(config, state) {
  const events = await recentExperiences(config);
  const lines = events.map((e) => `- ${e.at}｜${e.type || 'experience'}｜${e.summary || e.userText || ''}`);
  const text = `# 伴侣近期经历索引\n\n本文件由欲望系统维护。它是近期经历入口，不替代完整聊天记录。\n\n## 当前内在状态\n\n${Object.entries(state.drives).map(([k,v]) => `- ${k}: ${Number(v).toFixed(1)}`).join('\n')}\n\n## 近期经历\n\n${lines.join('\n') || '- 暂无'}\n`;
  await writeFile(config.memory.contextFile, text, { mode: 0o600 });
}
