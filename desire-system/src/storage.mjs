import { mkdir, open, readFile, rename } from 'node:fs/promises';
import path from 'node:path';
import { initialState } from './engine.mjs';

export async function loadConfig(file) {
  return JSON.parse(await readFile(file, 'utf8'));
}

export async function loadState(config) {
  await mkdir(config.dataDirectory, { recursive: true, mode: 0o700 });
  const file = path.join(config.dataDirectory, 'state.json');
  try { return JSON.parse(await readFile(file, 'utf8')); }
  catch (error) {
    if (error.code !== 'ENOENT') throw error;
    const state = initialState(config);
    await saveState(config, state);
    return state;
  }
}

export async function saveState(config, state) {
  await mkdir(config.dataDirectory, { recursive: true, mode: 0o700 });
  const file = path.join(config.dataDirectory, 'state.json');
  const temp = `${file}.${process.pid}.tmp`;
  const handle = await open(temp, 'w', 0o600);
  try { await handle.writeFile(`${JSON.stringify(state, null, 2)}\n`); await handle.sync(); }
  finally { await handle.close(); }
  await rename(temp, file);
}
