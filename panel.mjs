#!/usr/bin/env node
// 手机跑 NapCat · 控制面板（零依赖，单文件）
// 起法：node panel.mjs  然后手机浏览器打开 http://127.0.0.1:3099
// 做什么：看状态、启动/停止/重启、看日志、看配置。不碰 NapCat 内部，只调现成脚本。

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';

const DATA = process.env.DATA_DIR || '/sdcard/DeepSeekHarness';
const QQ_HOME = process.env.QQ_HOME || '/data/local/tmp/qq';
const PORT = Number(process.env.PANEL_PORT || 3099);
const CFG = path.join(QQ_HOME, 'config.sh');

function cfgValue(key) {
  try {
    const t = fs.readFileSync(CFG, 'utf8');
    const m = t.match(new RegExp('^' + key + '=(.*)$', 'm'));
    return m ? m[1].trim() : '';
  } catch { return ''; }
}

const NAPCAT_HTTP = cfgValue('NAPCAT_HTTP') || '3000';
const TOKEN = cfgValue('NAPCAT_TOKEN') || '';
const SAY_PORT = cfgValue('SAY_PORT') || '3002';

function sh(cmd, ms = 20000) {
  return new Promise((res) => {
    execFile('sh', ['-c', cmd], { timeout: ms, maxBuffer: 2 << 20 },
      (e, so, se) => res({ ok: !e, out: String(so || '').trim(), err: String(se || (e && e.message) || '').trim() }));
  });
}

async function napcatInfo() {
  try {
    const ac = new AbortController();
    const t = setTimeout(() => ac.abort(), 3000);
    const r = await fetch(`http://127.0.0.1:${NAPCAT_HTTP}/get_login_info`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'Bearer ' + TOKEN },
      body: '{}', signal: ac.signal,
    });
    clearTimeout(t);
    const j = await r.json();
    if (j && j.data && j.data.user_id) return { online: true, qq: String(j.data.user_id), nick: j.data.nickname || '' };
    return { online: false };
  } catch { return { online: false }; }
}

async function procs() {
  const r = await sh("ps -A -o PID,NAME,ARGS 2>/dev/null");
  const lines = r.out.split('\n');
  const has = (re) => lines.some(l => re.test(l));
  return {
    qq: has(/^\s*\d+\s+qq\s/),
    proot: has(/^\s*\d+\s+proot\s/),
    bridge: has(/bridge\.mjs/),
    watch: has(/watch\.sh/),
  };
}

async function statusPayload() {
  const [n, p] = await Promise.all([napcatInfo(), procs()]);
  let st = '';
  try { st = fs.readFileSync(path.join(DATA, 'qq', 'status.txt'), 'utf8').trim(); } catch {}
  return {
    online: n.online,
    qq: n.qq || cfgValue('QQ_NUM'),
    nick: n.nick,
    boss: cfgValue('BOSS_QQ'),
    bridge: p.bridge,
    watch: p.watch,
    stack: p.qq && p.proot,
    status: st,
    uptime: new Date().toISOString(),
  };
}

function tail(file, n = 60) {
  try {
    const t = fs.readFileSync(file, 'utf8').split('\n');
    return t.slice(Math.max(0, t.length - n)).join('\n');
  } catch { return '(读不到 ' + file + ')'; }
}

async function action(name) {
  const map = {
    start: `sh "${QQ_HOME}/start.sh"`,
    stop: `sh "${QQ_HOME}/stop.sh"`,
    restart: `sh "${QQ_HOME}/relogin.sh"`,
  };
  if (!map[name]) return { ok: false, err: 'unknown action' };
  const r = await sh(map[name], 60000);
  return { ok: r.ok, out: r.out.slice(-800), err: r.err.slice(-800) };
}

const PAGE = `<!doctype html><html lang="zh"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>NapCat 面板</title>
<style>
*{box-sizing:border-box;margin:0;padding:0}
body{background:#0f1216;color:#e8edf3;font:16px/1.5 -apple-system,"PingFang SC",sans-serif;padding:16px;max-width:680px;margin:0 auto}
h1{font-size:19px;font-weight:600;margin-bottom:4px}
.sub{color:#7d8794;font-size:13px;margin-bottom:18px}
.card{background:#171c22;border:1px solid #232a33;border-radius:14px;padding:16px;margin-bottom:14px}
.row{display:flex;justify-content:space-between;align-items:center;padding:9px 0;border-bottom:1px solid #1e252d;font-size:15px}
.row:last-child{border:0}
.k{color:#8b96a3}
.dot{width:9px;height:9px;border-radius:50%;display:inline-block;margin-right:8px;vertical-align:middle}
.on{background:#35c46a;box-shadow:0 0 8px #35c46a88}
.off{background:#e05555}
.btns{display:grid;grid-template-columns:1fr 1fr 1fr;gap:10px;margin-bottom:14px}
button{background:#1d242c;color:#e8edf3;border:1px solid #2b343e;border-radius:12px;padding:14px 0;font-size:15px;font-weight:500}
button:active{background:#2a333d}
button.p{background:#1f4d33;border-color:#2a6b47}
button.d{background:#43222a;border-color:#5c2f39}
pre{background:#0b0e12;border:1px solid #1c232b;border-radius:10px;padding:12px;font-size:12px;line-height:1.45;overflow:auto;max-height:260px;color:#9fb0c0;white-space:pre-wrap;word-break:break-all}
.tabs{display:flex;gap:6px;margin-bottom:10px}
.tab{padding:7px 14px;border-radius:9px;background:#171c22;border:1px solid #232a33;font-size:13px}
.tab.a{background:#233040;border-color:#35506b}
#toast{position:fixed;left:50%;bottom:28px;transform:translateX(-50%);background:#233040;border:1px solid #35506b;padding:11px 20px;border-radius:11px;font-size:14px;opacity:0;transition:.25s;pointer-events:none}
#toast.s{opacity:1}
</style></head><body>
<h1>🐟 NapCat 面板</h1>
<div class="sub" id="sub">读状态中…</div>

<div class="card" id="st"></div>

<div class="btns">
  <button class="p" onclick="act('start')">启动</button>
  <button onclick="act('restart')">重启</button>
  <button class="d" onclick="act('stop')">停止</button>
</div>

<div class="tabs">
  <div class="tab a" data-t="napcat" onclick="tab(this)">QQ 日志</div>
  <div class="tab" data-t="bridge" onclick="tab(this)">桥日志</div>
  <div class="tab" data-t="status" onclick="tab(this)">状态</div>
</div>
<pre id="log">加载中…</pre>

<div id="toast"></div>

<script>
let cur='napcat';
const $=id=>document.getElementById(id);
function toast(m){const t=$('toast');t.textContent=m;t.classList.add('s');setTimeout(()=>t.classList.remove('s'),1800);}
function dot(v){return '<span class="dot '+(v?'on':'off')+'"></span>';}
async function refresh(){
  try{
    const s=await (await fetch('/api/status')).json();
    $('sub').textContent=(s.online?'在线 · ':'离线 · ')+'账号 '+(s.qq||'?');
    $('st').innerHTML=
      '<div class="row"><span class="k">QQ 在线</span><span>'+dot(s.online)+(s.online?'已登录':'未登录')+'</span></div>'+
      '<div class="row"><span class="k">QQ 栈</span><span>'+dot(s.stack)+(s.stack?'运行中':'停了')+'</span></div>'+
      '<div class="row"><span class="k">桥</span><span>'+dot(s.bridge)+(s.bridge?'在跑':'没跑')+'</span></div>'+
      '<div class="row"><span class="k">看门狗</span><span>'+dot(s.watch)+(s.watch?'在跑':'没跑')+'</span></div>'+
      '<div class="row"><span class="k">账号 / 用户</span><span>'+(s.qq||'?')+' / '+(s.boss||'?')+'</span></div>'+
      '<div class="row"><span class="k">最近状态</span><span style="font-size:13px;color:#8b96a3">'+(s.status||'-')+'</span></div>';
  }catch(e){$('sub').textContent='面板连不上后台';}
}
async function loadLog(){
  try{const r=await (await fetch('/api/log?t='+cur)).json();$('log').textContent=r.text||'';}catch(e){$('log').textContent='读不到';}
}
function tab(el){document.querySelectorAll('.tab').forEach(x=>x.classList.remove('a'));el.classList.add('a');cur=el.dataset.t;loadLog();}
async function act(a){
  if(a==='stop'&&!confirm('确定停掉整个 QQ 栈？'))return;
  toast('执行中…');
  try{const r=await (await fetch('/api/'+a,{method:'POST'})).json();toast(r.ok?'搞定':'出错了：'+(r.err||'').slice(0,60));}catch(e){toast('请求失败');}
  setTimeout(()=>{refresh();loadLog();},1500);
}
refresh();loadLog();setInterval(refresh,8000);setInterval(loadLog,8000);
</script></body></html>`;

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://127.0.0.1');
  res.setHeader('cache-control', 'no-store');

  if (url.pathname === '/') {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    return res.end(PAGE);
  }
  if (url.pathname === '/api/status') {
    res.writeHead(200, { 'content-type': 'application/json' });
    return res.end(JSON.stringify(await statusPayload()));
  }
  if (url.pathname === '/api/log') {
    const t = url.searchParams.get('t') || 'napcat';
    const file = t === 'bridge' ? path.join(DATA, 'qq', 'bridge.log')
      : t === 'status' ? path.join(DATA, 'qq', 'status.txt') : path.join(DATA, 'napcat.log');
    res.writeHead(200, { 'content-type': 'application/json' });
    return res.end(JSON.stringify({ text: tail(file, 60) }));
  }
  if (req.method === 'POST' && /^\/api\/(start|stop|restart)$/.test(url.pathname)) {
    const r = await action(url.pathname.slice(5));
    res.writeHead(200, { 'content-type': 'application/json' });
    return res.end(JSON.stringify(r));
  }
  res.writeHead(404); res.end('not found');
});

server.listen(PORT, '127.0.0.1', () => {
  console.log('panel on http://127.0.0.1:' + PORT);
});
