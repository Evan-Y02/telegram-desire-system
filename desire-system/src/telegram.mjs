import { readFile } from 'node:fs/promises';
import path from 'node:path';

export async function sendTelegram(config, text) {
  const root = process.env.TELEGRAM_DESIRE_CONFIG_DIR || path.join(process.env.HOME, '.config/telegram-desire');
  const token = (await readFile(path.join(root, 'bot-token'), 'utf8')).trim();
  const binding = JSON.parse(await readFile(path.join(root, 'binding.json'), 'utf8'));
  const response = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ chat_id: binding.chat_id, text }), signal: AbortSignal.timeout(40000),
  });
  const data = await response.json();
  if (!response.ok || !data.ok) throw new Error('telegram_send_failed');
  return data.result;
}
