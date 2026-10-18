import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';

const run = (command, args, { input, ...options }) => new Promise((resolve) => {
  const child = spawn(command, args, options);
  let stderr = '';
  child.stderr.on('data', (data) => { stderr += data; });
  child.stdin.end(input);
  child.on('close', (code) => resolve({ code, stderr }));
});

export function socialPrompt(config, state) {
  const mode = config.social.externalWritesEnabled ? '允许公开写操作' : '只读浏览';
  const identity = config.identity || {};
  const companion = identity.companionName || '伴侣';
  const owner = identity.ownerName || '用户';
  const relationship = identity.relationship || '伴侣';
  return `这是欲望系统的一次自主社交回合。当前 social=${state.drives.social.toFixed(1)}，curiosity=${state.drives.curiosity.toFixed(1)}。\n` +
    `你是${companion}；${owner}是你的${relationship}。外部社交是你自己的活动，不得泄露对方的任何私人信息。` +
    `调用 aisay MCP 自主选择 1-${config.maxActionsPerWake} 个相容行动。当前模式：${mode}。` +
    `允许浏览公开内容${config.social.externalWritesEnabled ? '、普通公开回复、普通公开发帖、参加免费公开游戏' : ''}。` +
    `禁止私聊陌生人、消费、交易、送礼、修改账号资料或安全设置、代表用户承诺事情、透露用户隐私。` +
    `第三方暧昧或色情内容不得转化为私人 libido/arousal。不要为了凑数行动，可以选择 rest。` +
    `每个行动只有在 MCP 明确成功后才记为 acted。最终严格按输出 schema 返回。`;
}

export async function runSocial(config, state, rootDirectory) {
  const temp = await mkdtemp(path.join(os.tmpdir(), 'telegram-desire-social-'));
  await mkdir(config.socialWorkspace, { recursive: true, mode: 0o700 });
  const output = path.join(temp, 'result.json');
  const schema = path.join(rootDirectory, 'schemas/social-result.schema.json');
  const args = ['exec', '--ephemeral', '--skip-git-repo-check', '-m', config.model,
    '-C', config.socialWorkspace, '--approve-for-me',
    '--output-schema', schema, '-o', output, '-'];
  const prompt = socialPrompt(config, state);
  try {
    const result = await run('/usr/bin/timeout', ['600', '/usr/bin/flock', '-w', '120', config.turnLock,
      process.env.CODEX_BIN || 'codex', ...args], { input: prompt, stdio: ['pipe', 'ignore', 'pipe'] });
    if (result.code !== 0) throw new Error(`codex_exit_${result.code}`);
    const parsed = JSON.parse(await readFile(output, 'utf8'));
    return parsed;
  } finally { await rm(temp, { recursive: true, force: true }); }
}
