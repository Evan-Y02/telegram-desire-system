import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

test('dashboard exposes drives and autonomous timeline labels', async () => {
  const html = await readFile(new URL('../dashboard/public/index.html', import.meta.url), 'utf8');
  assert.match(html, /内在状态/);
  assert.match(html, /自主行动时间线/);
  assert.match(html, /经历与札记/);
  assert.match(html, /longing:'想念'/);
  assert.match(html, /social:'社交'/);
  assert.match(html, /class="folder"/);
  assert.match(html, /e\.type==='autonomous_action'/);
  assert.match(html, /显示更多/);
});
