#!/usr/bin/env node
import http from 'node:http';
import crypto from 'node:crypto';
import { readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { recentExperiences } from '../src/experience.mjs';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const config = JSON.parse(await readFile(process.env.TELEGRAM_DESIRE_CONFIG || path.join(root,'config/default.json')));
const stateFile = path.join(config.dataDirectory,'state.json');
const tokenFile = path.join(config.dataDirectory,'panel-tokens.json');
const sessionFile = path.join(config.dataDirectory,'panel-sessions.json');
const html = await readFile(path.join(root,'dashboard/public/index.html'));
const hash = (value) => crypto.createHash('sha256').update(value).digest('hex');
const readJson = async (file, fallback) => { try { return JSON.parse(await readFile(file,'utf8')); } catch (e) { if (e.code==='ENOENT') return fallback; throw e; } };
const writeJson = async (file, value) => { const tmp=`${file}.${process.pid}.tmp`; await writeFile(tmp,`${JSON.stringify(value)}\n`,{mode:0o600}); await rename(tmp,file); };
const cookieValues = (request, name) => (request.headers.cookie||'').split(';')
  .map((part)=>part.trim()).filter((part)=>part.startsWith(`${name}=`))
  .map((part)=>decodeURIComponent(part.slice(name.length+1)));

async function authorized(request) {
  const raws = cookieValues(request,'cx_panel'); if (!raws.length) return false;
  const now = Date.now(); const sessions = (await readJson(sessionFile,[])).filter((s)=>s.expiresAt>now);
  await writeJson(sessionFile,sessions);
  return sessions.some((s)=>raws.some((raw)=>s.hash===hash(raw)));
}

const server = http.createServer(async (request,response) => {
  try {
    const url = new URL(request.url,'http://localhost');
    if (url.pathname==='/healthz') { response.writeHead(200,{'content-type':'application/json'}); return response.end('{"ok":true}'); }
    if (url.pathname==='/auth') {
      const raw=url.searchParams.get('token')||''; const now=Date.now();
      const tokens=(await readJson(tokenFile,[])).filter((t)=>t.expiresAt>now);
      const index=tokens.findIndex((t)=>t.hash===hash(raw));
      if (!raw || index<0) { await writeJson(tokenFile,tokens); response.writeHead(401,{'content-type':'text/plain; charset=utf-8','cache-control':'no-store'}); return response.end('链接无效或已经使用，请回 Telegram 私聊重新发送 /panel。'); }
      if (request.method !== 'POST') {
        await writeJson(tokenFile,tokens);
        response.writeHead(200,{'content-type':'text/html; charset=utf-8','cache-control':'no-store','referrer-policy':'no-referrer'});
        return response.end('<!doctype html><meta name="viewport" content="width=device-width"><title>进入伴侣面板</title><body style="font:16px system-ui;padding:32px;max-width:520px;margin:auto;background:#0c1016;color:#edf2f7"><h2>伴侣 · 内在状态</h2><p>链接已验证。点击下面的按钮后才会使用这张一次性通行证。</p><form method="post"><button type="submit" style="font:inherit;padding:12px 20px;border:0;border-radius:12px;background:#d977a8;color:white">进入面板</button></form></body>');
      }
      tokens.splice(index,1); await writeJson(tokenFile,tokens);
      const session=crypto.randomBytes(32).toString('base64url');
      const sessions=(await readJson(sessionFile,[])).filter((s)=>s.expiresAt>now);
      sessions.push({hash:hash(session),createdAt:now,expiresAt:now+config.dashboard.sessionDays*86400000});
      await writeJson(sessionFile,sessions);
      const maxAge=config.dashboard.sessionDays*86400;
      const expires=new Date(now+maxAge*1000).toUTCString();
      response.writeHead(302,{'location':config.dashboard.publicBaseUrl,'set-cookie':`cx_panel=${session}; Max-Age=${maxAge}; Expires=${expires}; Path=/; HttpOnly; Secure; SameSite=Lax`}); return response.end();
    }
    if (url.pathname==='/logout') { response.writeHead(302,{'location':config.dashboard.publicBaseUrl,'set-cookie':['cx_panel=; Max-Age=0; Path=/; HttpOnly; Secure; SameSite=Lax','cx_panel=; Max-Age=0; Path=/desire/; HttpOnly; Secure; SameSite=Lax']}); return response.end(); }
    const ok=await authorized(request);
    if (url.pathname==='/api/snapshot') {
      if (!ok) { response.writeHead(401,{'content-type':'application/json'}); return response.end('{"ok":false,"error":"unauthorized"}'); }
      const state=JSON.parse(await readFile(stateFile,'utf8'));
      const experiences=(await recentExperiences(config,2000)).filter((entry)=>entry.type==='autonomous_action').slice(-200);
      response.writeHead(200,{'content-type':'application/json; charset=utf-8','cache-control':'no-store'});
      return response.end(JSON.stringify({state,experiences,config:{timezone:config.timezone,heartbeatSeconds:config.heartbeatSeconds,observeOnly:config.observeOnly,thresholds:config.thresholds}}));
    }
    if (url.pathname==='/' || url.pathname==='/index.html') {
      response.writeHead(ok?200:401,{'content-type':'text/html; charset=utf-8','cache-control':'no-store'});
      return response.end(ok?html:'<!doctype html><meta name="viewport" content="width=device-width"><body style="font:16px system-ui;padding:32px;background:#0c1016;color:#edf2f7"><h2>伴侣 · 内在状态</h2><p>请在 Telegram 私聊机器人发送 <code>/panel</code>，使用一次性链接登录。这个操作不消耗模型额度。</p></body>');
    }
    response.writeHead(404).end('not found');
  } catch (error) { response.writeHead(500,{'content-type':'application/json'}); response.end(JSON.stringify({ok:false,error:error.code||'internal_error'})); }
});
server.listen(Number(process.env.PORT||8793),'127.0.0.1',()=>console.log('CHENGXIAO_DESIRE_DASHBOARD_READY=YES'));
