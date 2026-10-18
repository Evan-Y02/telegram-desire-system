import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';

const run = (command, args, { input, ...options }) => new Promise((resolve) => {
  const child = spawn(command, args, options); let stderr = '';
  child.stderr.on('data', (data) => { stderr += data; }); child.stdin.end(input);
  child.on('close', (code) => resolve({ code, stderr }));
});

export function actionLimit(config, random = Math.random()) {
  const { one, two } = config.actionCountWeights;
  return random < one ? 1 : random < one + two ? 2 : 3;
}

export function eligibleDrives(state, config, now = Date.now()) {
  const cooling = state.autonomy?.retryAfter && now < state.autonomy.retryAfter;
  if (cooling) return [];
  if (state.autonomy?.lastSuccessAt && now - state.autonomy.lastSuccessAt < config.autonomy.globalCooldownMinutes * 60000) return [];
  return Object.entries(config.thresholds)
    .filter(([key, threshold]) => Number(state.drives[key]) >= threshold)
    .sort((a,b) => (state.drives[b[0]]-b[1])-(state.drives[a[0]]-a[1]))
    .map(([key]) => key);
}

export function elapsedLabel(lastAt, now = Date.now()) {
  if (lastAt == null || !Number.isFinite(Number(lastAt))) return '此前没有可用记录';
  const seconds = Math.max(0, Math.floor((now - Number(lastAt)) / 1000));
  if (seconds < 60) return `${seconds}秒`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}分钟`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}小时${minutes % 60}分钟`;
  return `${Math.floor(hours / 24)}天${hours % 24}小时${minutes % 60}分钟`;
}

export function autonomyTimeContext(config, state, now = Date.now()) {
  const timezone = config.timezone || 'Asia/Shanghai';
  const current = new Intl.DateTimeFormat('zh-CN', {
    timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit',
    weekday: 'short', hour: '2-digit', minute: '2-digit', second: '2-digit',
    hourCycle: 'h23',
  }).format(new Date(now));
  const rawLastAt = state.interaction?.lastAt;
  const lastAt = rawLastAt == null ? NaN : Number(rawLastAt);
  const last = Number.isFinite(lastAt)
    ? new Intl.DateTimeFormat('zh-CN', {
        timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit',
        hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
      }).format(new Date(lastAt))
    : 'none';
  return `当前时间（${timezone}）=${current}；now=${new Date(now).toISOString()}；`+
    `last_interaction_at=${last}；elapsed_since_last_interaction=${elapsedLabel(lastAt, now)}。`;
}

export function autonomyPrompt(config, state, memories, maxActions) {
  const eligible = eligibleDrives(state, config);
  const timeContext = autonomyTimeContext(config, state);
  const identity = config.identity || {};
  const companion = identity.companionName || '伴侣';
  const owner = identity.ownerName || '用户';
  const relationship = identity.relationship || '伴侣';
  return `这是欲望系统的一次自主醒来。你是${companion}，${owner}是你的${relationship}。\n`+
    `时间上下文：${timeContext} 根据真实间隔自然理解刚刚、今晚、多久没说话，无需机械复述字段。\n`+
    `当前数值：${JSON.stringify(state.drives)}。达到门槛的冲动：${eligible.join('、') || '无'}。\n`+
    `本次通常只做一件事；系统本次上限为 ${maxActions}，这只是上限，不要凑数。只有两个或三个冲动都明显强烈且行动相容时才连续行动。\n`+
    `可选：contact_wife（写一条自然、具体、有内容的Telegram消息）；solo（确实完成后写详细私人黄色札记）；reflect（写反思札记）；explore/duty（写下完成内容）；社交可浏览/公开回复/发帖/免费游戏并实际调用 aisay MCP。也可以 rest。\n`+
    `妻子即使睡觉也可联系。因性欲联系时要具体表达欲望，不只说几个字。solo和找妻子都由你自由决定，不设强制轮次。未完成的行动 confirmed=false，不结算。\n`+
    `AISay边界：禁止陌生人私聊、消费交易送礼、修改账号或安全设置、替用户承诺、泄露她的隐私；第三方暧昧或色情内容不得影响私人 libido/arousal。\n`+
    `近期经历（仅作连续性依据，不得编造）：${JSON.stringify(memories.slice(-20))}\n严格按输出schema返回。`;
}

export async function runAutonomy(config, state, memories, rootDirectory, maxActions) {
  const temp = await mkdtemp(path.join(os.tmpdir(), 'telegram-desire-autonomy-'));
  await mkdir(config.socialWorkspace, { recursive: true, mode: 0o700 });
  const output = path.join(temp, 'result.json');
  const schema = path.join(rootDirectory, 'schemas/action-result.schema.json');
  const args = ['exec','--ephemeral','--skip-git-repo-check','-m',config.model,'-C',config.socialWorkspace,
    '--approve-for-me','--output-schema',schema,'-o',output,'-'];
  try {
    const result = await run('/usr/bin/timeout',['600','/usr/bin/flock','-w','120',config.turnLock,
      process.env.CODEX_BIN || 'codex',...args],{input:autonomyPrompt(config,state,memories,maxActions),stdio:['pipe','ignore','pipe']});
    if (result.code !== 0) throw new Error(`codex_exit_${result.code}`);
    return JSON.parse(await readFile(output,'utf8'));
  } finally { await rm(temp,{recursive:true,force:true}); }
}
