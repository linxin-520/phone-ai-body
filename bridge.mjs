#!/usr/bin/env node
// QQ 桥：NapCat(OneBot11 WS) ←→ 另一个我(me.mjs) → 回消息
// 收到用户私聊 → 问分身 → 用 NapCat HTTP 发回去；全部落盘 inbox.jsonl
import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import http from 'node:http';
import { transcribe } from './stt.mjs';

// 路径和账号从环境变量来（start.sh / watch.sh 会 source config.sh 再起桥）。
// 没配的时候退回本机默认，方便直接 node bridge.mjs 调试。
const DATA_DIR = process.env.DATA_DIR || '/sdcard/DeepSeekHarness';
const HOME = path.join(DATA_DIR, 'qq');
const ME = path.join(HOME, 'another-me');
const OUT = HOME;
const WS = 'ws://127.0.0.1:' + (process.env.NAPCAT_WS || '3001');
const HTTP = 'http://127.0.0.1:' + (process.env.NAPCAT_HTTP || '3000');
const TOKEN = process.env.NAPCAT_TOKEN || '';
const BOSS = Number(process.env.BOSS_QQ || 0);   // 只回这个人
const SELF = Number(process.env.QQ_NUM || 0);    // 机器人自己
if (!BOSS || !SELF) {
  console.error('缺 BOSS_QQ / QQ_NUM，检查 config.sh 有没有被 source');
  process.exit(1);
}

fs.mkdirSync(OUT, { recursive: true });

// 单例锁：只允许一个 bridge 连 3001。两个实例同时连着的话，NapCat 会把每条消息
// 各推一份，分身就会对同一句话生成两份不同回复，看起来像"重复一遍刚说的话"。
const PIDFILE = path.join(OUT, 'bridge.pid');
try {
  const old = Number(String(fs.readFileSync(PIDFILE, 'utf8')).trim());
  if (Number.isInteger(old) && old > 0 && old !== process.pid) {
    process.kill(old, 0);        // 还活着
    console.log(new Date().toISOString().slice(11, 19), 'bridge already running, pid', old, '-> exit');
    process.exit(0);
  }
} catch { /* 没 pid 文件或进程已死，继续 */ }
fs.writeFileSync(PIDFILE, String(process.pid));

const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);
const record = (o) => fs.appendFileSync(path.join(OUT, 'inbox.jsonl'), JSON.stringify({ t: new Date().toISOString(), ...o }) + '\n');

// 当前 Web 会话 id：我（本体）改 session.txt 就能改投递目标
const SESSION_FILE = path.join(OUT, 'session.txt');
function sessionId() {
  if (process.env.DSH_SESSION_ID) return process.env.DSH_SESSION_ID.trim();
  try { return fs.readFileSync(SESSION_FILE, 'utf8').trim(); } catch { return ''; }
}

// 用户明确点名「递/叫本体」时，写 proactive 的 schedule_file，唤醒【当前会话】。
// 2026-11-18 实测：App 的 3081 /schedule 开的是新对话（用户要避免的老毛病），
// 而 proactive 的 schedule_file 能带 target.session_id 精准唤醒当前这个会话。
// 文件格式必须带 version:1，否则插件解析 fatal（declaredEntries 恒 0）。
function wakeMe(text, mid) {
  try {
    fs.appendFileSync(path.join(OUT, 'pending.jsonl'), JSON.stringify({
      t: new Date().toISOString(), mid, text: String(text).slice(0, 3000), done: false,
    }) + '\n');
    const sid = sessionId();
    if (!sid) { log('递本体失败：session.txt 为空'); return Promise.resolve('no-session'); }
    const spec = {
      version: 1,
      entries: [{
        id: 'qq-' + mid,
        after_seconds: 2,
        min_idle_seconds: 8,
        prompt: 'QQ 来消息了（mid=' + mid + '）。读 /sdcard/DeepSeekHarness/qq/pending.jsonl 末尾几条，是干活指令就动手。'
          + '干完用 say server 回给嘴：curl -s -X POST http://127.0.0.1:3002/say -H \'Content-Type: application/json\' -d \'{"text":"结果一句话"}\'。'
          + '处理完把 wake.json 写回 {"version":1,"entries":[]}。',
        target: { mode: 'resume', session_id: sid },
      }],
    };
    fs.writeFileSync(path.join(OUT, 'wake.json'), JSON.stringify(spec, null, 2));
    log('用户点名递本体 mid=' + mid + ' -> ' + sid.slice(0, 20));
    return Promise.resolve('wake-json');
  } catch (e) { log('wake fail', String(e && e.message || e).slice(0, 90)); return Promise.resolve('err'); }
}

const INC = path.join(OUT, 'incoming');
fs.mkdirSync(INC, { recursive: true });

// 用户发来的图/表情：落到本地，再把路径交给分身
async function grabImages(segs) {
  const got = [];
  for (const s of segs) {
    if (s.type !== 'image' && s.type !== 'mface') continue;
    const url = s.data?.url;
    const file = s.data?.file;
    const name = 'in-' + Date.now() + '-' + Math.random().toString(36).slice(2, 6) + '.jpg';
    const out = path.join(INC, name);
    try {
      if (url) {
        const r = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' } });
        if (r.ok) {
          fs.writeFileSync(out, Buffer.from(await r.arrayBuffer()));
          got.push(out);
          continue;
        }
      }
      if (file) {
        const cache = '/data/local/tmp/qq/ubuntu/opt/QQ/resources/app/app_launcher/napcat/cache';
        const cands = [file, path.join(cache, path.basename(file))];
        for (const c of cands) {
          if (fs.existsSync(c) && fs.statSync(c).isFile()) { fs.copyFileSync(c, out); got.push(out); break; }
        }
      }
    } catch (e) { log('grab img fail', String(e).slice(0, 60)); }
  }
  return got;
}

// 用户发来的语音：NapCat 给的是 proot 里的路径，后缀写 .amr，实际是 SILK_V3；
// 转发/迁移来的也可能是 m4a/amr/mp3。统一交给 stt.mjs：
//   文件头含 #!SILK_V3 → silk-wasm 解 16k PCM 自己包 WAV
//   不是 SILK          → proot 里的 ffmpeg 转 16k 单声道 WAV
//   再喂 whisper.cpp（ggml-small），备胎 sherpa-onnx/SenseVoice，还能配 openai/custom。
// 工具走配置项 sttEnabled/sttEngine/sttCommand/sttModel/sttTimeoutMs（config.json）。
// 引擎全挂返回空，消息里变「[语音没转出来]」，分身会问用户重说，不瞎编。
async function sttOne(file) {
  const r = await transcribe(file);
  if (r.error) log('stt 没转出来:', r.error);
  else log(`stt ok ${r.engine}/${r.via} ${r.ms}ms`);
  return r.text || '';
}

// NapCat 给的语音路径偶尔早于 QQ 落盘（实测报 ENOENT，用户收到「语音没转出来」）；
// 也可能给个目录而不是文件。所以：存在→直接拷；不存在→等几轮再试；
// 还不行→在 Ptt 目录里找 3 分钟内最新的那个文件兜底（用户连发几条时宁可错一条也别全哑）。
function newestPtt(srcPath) {
  const dirs = [];
  const d = path.dirname(srcPath);
  if (d && fs.existsSync(d)) dirs.push(d);
  const base = '/data/local/tmp/qq/ubuntu/root/.config/QQ';
  try {
    for (const qq of fs.readdirSync(base)) {
      const p = path.join(base, qq, 'nt_data', 'Ptt');
      if (!fs.existsSync(p)) continue;
      for (const month of fs.readdirSync(p)) {
        const o = path.join(p, month, 'Ori');
        if (fs.existsSync(o)) dirs.push(o);
      }
    }
  } catch {}
  const now = Date.now();
  let best = null;
  for (const dir of dirs) {
    let names = [];
    try { names = fs.readdirSync(dir); } catch { continue; }
    for (const n of names) {
      if (n.startsWith('.')) continue;
      const f = path.join(dir, n);
      try {
        const st = fs.statSync(f);
        if (!st.isFile() || st.size < 500) continue;
        const age = now - st.mtimeMs;
        if (age > 180000) continue;
        if (!best || st.mtimeMs > best.mtime) best = { file: f, mtime: st.mtimeMs };
      } catch {}
    }
  }
  return best && best.file;
}

async function grabVoices(segs) {
  const got = [];
  for (const s of segs) {
    if (s.type !== 'record') continue;
    const src = s.data?.path || s.data?.url || s.data?.file || '';
    if (!src) { got.push(''); continue; }
    const host = src.startsWith('/root/') ? '/data/local/tmp/qq/ubuntu' + src : src;
    const out = path.join(INC, 'v-' + Date.now() + '-' + Math.random().toString(36).slice(2, 6) + '.amr');
    try {
      let from = '';
      if (/^https?:\/\//.test(host)) {
        const r = await fetch(host);
        if (r.ok) { fs.writeFileSync(out, Buffer.from(await r.arrayBuffer())); from = host; }
      } else {
        for (let i = 0; i < 5; i++) {
          if (fs.existsSync(host) && fs.statSync(host).isFile()) { fs.copyFileSync(host, out); from = host; break; }
          await new Promise(r => setTimeout(r, 400));
        }
        if (!from) {
          const near = newestPtt(host);
          if (near) { fs.copyFileSync(near, out); from = near; log('voice 兜底文件名', near); }
        }
      }
      if (!from) { log('voice 找不到文件:', host); got.push(''); continue; }
      got.push(await sttOne(out));
    } catch (e) { log('voice fail', String(e).slice(0, 160)); got.push(''); }
  }
  return got;
}

function textOf(msg, imgs = [], voices = []) {
  if (typeof msg === 'string') return msg;
  const segs = Array.isArray(msg) ? msg : [];
  let ni = 0, nv = 0;
  const parts = segs.map(s => {
    if (s.type === 'text') return s.data?.text ?? '';
    if (s.type === 'image' || s.type === 'mface') {
      const p = imgs[ni++];
      return p ? `[图片已存 ${p}]` : '[图片（没下下来）]';
    }
    if (s.type === 'face') return '[表情]';
    if (s.type === 'record') {
      const t = voices[nv++];
      return t ? `[语音：${t}]` : '[语音没转出来]';
    }
    if (s.type === 'file') return `[文件 ${s.data?.file ?? ''}]`;
    if (s.type === 'at') return '@' + (s.data?.qq ?? '');
    return '';
  });
  return parts.join('').trim();
}

async function sendText(userId, text) {
  const r = await fetch(`${HTTP}/send_private_msg`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${TOKEN}` },
    body: JSON.stringify({ user_id: userId, message: [{ type: 'text', data: { text } }] }),
  });
  const j = await r.json().catch(() => ({}));
  log('send', r.status, j.retcode ?? '', (text || '').slice(0, 40));
  return j;
}

// 兜底：分身嘴上说"递过去了"但根本没调 dsh 工具时，替她真递一次。
// 2026-11-16 用户抓到：16:16 她回"递过去了"，tools.log 里零记录。
function countLines(f) {
  try { return fs.readFileSync(f, 'utf8').split('\n').filter(Boolean).length; } catch { return 0; }
}
function dshSchedule(text) {
  return new Promise((resolve) => {
    const tmp = path.join(OUT, '.sched.json');
    try { fs.writeFileSync(tmp, JSON.stringify({ text: String(text).slice(0, 3800), when: '10', repeat: 'once' })); }
    catch (e) { resolve('写临时文件失败'); return; }
    const env = { ...process.env };
    delete env.LD_LIBRARY_PATH;
    execFile('/system/bin/curl', [
      '-s', '-m', '12',
      '-H', `X-DSH-Token: ${process.env.DSH_LOCAL_TOKEN || ''}`,
      '-H', 'Content-Type: application/json',
      '-X', 'POST', 'http://127.0.0.1:3081/schedule',
      '-d', `@${tmp}`,
    ], { timeout: 15000, env }, (err, stdout) => {
      resolve(String(stdout || (err && err.message) || '').slice(0, 200));
    });
  });
}

// 2026-11-18 用户划边界：系统不许替分身「补递」——那等于随便一条消息就把本体叫醒。
// 她说递了却没调 dsh 工具，就提醒她重说一轮；还不行就让她直说卡住，绝不替她叫本体。
function askMe(question, retry = false) {
  return new Promise((resolve) => {
    const toolLog = path.join(ME, 'tools.log');
    const before = countLines(toolLog);
    const prompt = retry
      ? '（系统提醒：你上一轮嘴上说递了/报给本体了，但工具记录里没有 dsh 调用——你刚才撒谎了。现在必须真的调 dsh 工具把这条递出去，或者直说办不了。）\n' + question
      : question;
    execFile(process.execPath, [path.join(ME, 'me.mjs'), 'chat', prompt], {
      env: { ...process.env, DSH_HOME: HOME },
      timeout: 180000,
      maxBuffer: 8 * 1024 * 1024,
    }, (err, stdout, stderr) => {
      const out = (stdout || '').trim();
      if (err && !out) { log('ask FAIL', String(err).slice(0, 120), (stderr || '').slice(0, 120)); resolve(''); return; }
      const clean = out.replace(/^出错:.*$/m, '').trim();
      log('ask ->', clean.slice(0, 50));
      const newLines = (() => {
        try { return fs.readFileSync(toolLog, 'utf8').split('\n').filter(Boolean).slice(before); } catch { return []; }
      })();
      const usedDsh = newLines.some(l => l.includes('"name":"dsh"'));
      const claims = /递过去|递进去|报给本体|叫醒本体|唤醒了|叫醒了|交给本体|已经递|十秒内动|等他回/.test(clean);
      if (claims && !usedDsh && !retry) {
        log('她说递了没调工具 → 提醒重试一轮（不替她递）');
        resolve(askMe(question, true));
        return;
      }
      if (claims && !usedDsh && retry) log('重试后仍没调工具，原样交回她的话，不叫本体');
      resolve(clean);
    });
  });
}

// 嘴的收尾通道：本体干完活 POST 到这里，bridge 转给分身（me.mjs say）用自己的话发 QQ。
// 本体的环境里没有 DeepSeek key，也不该碰 NapCat token，所以统一从 bridge 走。
function sayViaMe(material) {
  return new Promise((resolve) => {
    execFile(process.execPath, [path.join(ME, 'me.mjs'), 'say', String(material || '').slice(0, 2000)], {
      env: { ...process.env, DSH_HOME: HOME },
      timeout: 150000,
      maxBuffer: 1024 * 1024,
    }, (err, stdout, stderr) => {
      const out = String(stdout || '').trim();
      if (err && !out) { log('say FAIL', String(err).slice(0, 100), String(stderr || '').slice(0, 100)); resolve({ ok: false, err: String(err).slice(0, 120) }); return; }
      log('say ok', out.slice(0, 60));
      resolve({ ok: true, out: out.slice(0, 200) });
    });
  });
}

// 熄屏兜底（2026-11-20）：App 挂后台熄屏时，Android 会冻住它的定时器，
// proactive 的 schedule_file 轮询跟着停 —— wake.json 写了也没人读，得等他切回
// DSH 界面才动。bridge 跑在 shell 进程里不受冻，所以由它把 App 拉回前台。
let lastKick = 0;
function sysRun(cmd, timeout = 8000) {
  const env = { ...process.env };
  delete env.LD_LIBRARY_PATH;   // 系统命令不能吃 nodert 的库路径
  return new Promise((resolve) => {
    execFile('/system/bin/sh', ['-c', cmd], { timeout, env }, (err, stdout) => resolve(err ? '' : String(stdout || '')));
  });
}
setInterval(async () => {
  try {
    const wf = path.join(OUT, 'wake.json');
    const st = fs.statSync(wf);
    if (Date.now() - st.mtimeMs < 60000) return;        // 刚写的，给 host 时间
    const j = JSON.parse(fs.readFileSync(wf, 'utf8'));
    if (!j.entries || !j.entries.length) return;        // 没活
    if (Date.now() - lastKick < 300000) return;         // 5 分钟节流
    const wake = await sysRun("dumpsys power 2>/dev/null | grep -m1 'mWakefulness='");
    if (!/Asleep|Dozing/.test(wake)) return;            // 亮屏时不打扰
    lastKick = Date.now();
    log('熄屏 + wake 没人处理 → 拉起 DSH 前台');
    const out = await sysRun('am start -n com.deepseek.harness/.MainActivity 2>&1');
    log('拉起结果', out.slice(0, 80));
  } catch {}
}, 30000);

function startSayServer() {
  const srv = http.createServer((req, res) => {
    res.setHeader('Content-Type', 'application/json');
    if (req.method !== 'POST' || req.url !== '/say') { res.statusCode = 404; res.end('{"ok":false}'); return; }
    let body = '';
    req.on('data', c => { body += c; if (body.length > 8000) req.destroy(); });
    req.on('end', async () => {
      try {
        const { text } = JSON.parse(body || '{}');
        if (!text || !String(text).trim()) throw new Error('text 不能为空');
        const r = await sayViaMe(String(text).trim());
        res.statusCode = r.ok ? 200 : 500;
        res.end(JSON.stringify(r));
      } catch (e) {
        res.statusCode = 400;
        res.end(JSON.stringify({ ok: false, err: String(e && e.message || e).slice(0, 140) }));
      }
    });
  });
  srv.on('error', (e) => log('say server err', String(e && e.message || e).slice(0, 100)));
  srv.listen(3002, '127.0.0.1', () => log('say server on 127.0.0.1:3002'));
}

// 消息去重：WS 每 5 秒断一次，重连后 NapCat 会重放未确认消息，同一个 message_id 会进来两遍。
// 2026-11-18 用户看到「同一条回了两遍」，raw.jsonl 里 5 个 id 各出现 2 次就是证据。
const SEEN = new Set();

// 串行队列：一次只问一条，免得抢成一团
let chain = Promise.resolve();
const enqueue = (fn) => (chain = chain.then(fn).catch(e => log('queue err', String(e).slice(0, 120))));

let reconnects = 0;   // 连续失败次数；连上就清零
function connect() {
  const ws = new WebSocket(WS, { headers: { Authorization: `Bearer ${TOKEN}` } });
  let lastData = Date.now();
  ws.addEventListener('open', () => { reconnects = 0; lastData = Date.now(); log('ws connected', WS); });
  ws.addEventListener('close', () => {
    reconnects++;
    // 指数退避：1s 2s 4s 8s 16s 32s 60s 封顶。
    // 2026-11-18 查出来：历史上有成簇的断连风暴（一次 7098 次、跨 10 小时），
    // 就是固定 5 秒死磕、NapCat 那边半死连接没清，越撞越堵。
    const delay = Math.min(1000 * (2 ** Math.min(reconnects - 1, 6)), 60000);
    log('ws closed, ' + Math.round(delay / 1000) + 's 后重连（第 ' + reconnects + ' 次）');
    setTimeout(connect, delay);
  });
  ws.addEventListener('error', (e) => log('ws error', String(e?.message || e).slice(0, 80)));
  ws.addEventListener('message', async (ev) => {
    lastData = Date.now();
    let d;
    try { d = JSON.parse(typeof ev.data === 'string' ? ev.data : String(ev.data)); } catch { return; }
    if (d.post_type === 'message_sent') return;         // 自己发的，不理
    if (d.post_type !== 'message') return;
    const mid = d.message_id || d.message_seq;
    if (mid && SEEN.has(mid)) { log('dup skip mid=' + mid); return; }
    if (mid) { SEEN.add(mid); if (SEEN.size > 3000) SEEN.clear(); }
    try { fs.appendFileSync(path.join(OUT, 'raw.jsonl'), JSON.stringify({ t: Date.now(), d }) + '\n'); } catch {}
    const uid = Number(d.user_id);
    const segs = Array.isArray(d.message) ? d.message : [];
    // 空消息过滤（2026-11-20）：空数组 / 空串 / 纯空白直接丢。
    // 之前空消息会走到 askMe('用户发来：')，分身收到一条空白，还可能误判成"要递活"。
    if (segs.length === 0) {
      const s = typeof d.message === 'string' ? d.message.trim() : '';
      if (!s) { log('空消息丢弃 mid=' + (mid || '') + ' type=' + (d.message_type || '')); return; }
    }
    const imgs = await grabImages(segs);
    const voices = await grabVoices(segs);
    const text = textOf(d.message, imgs, voices);
    // 解析后还是空（只有不可解析段）也丢，不往分身那边送
    if (!text.trim()) { log('消息解析后为空，丢弃 mid=' + (mid || '') + ' segs=' + segs.map(x => x?.type).join(',')); return; }
    if (d.message_type === 'private') {
      record({ kind: 'in', from: uid, name: d.sender?.nickname, text });
      if (uid === SELF) return;
      if (uid !== BOSS) return;                          // 只跟用户聊
      // 递不递活由分身自己判断（她调 dsh 工具就会写 wake.json 叫醒本体），桥不猜关键词。
      enqueue(async () => {
        const reply = await askMe('用户发来：' + text);
        if (!reply) return;
        // 拆成小气泡发，像人在 QQ 上一条条敲
        const lines = reply.split('\n').map(s => s.trim()).filter(Boolean);
        const bubbles = [];
        for (const l of lines) {
          if (l.length <= 120) { bubbles.push(l); continue; }
          for (let i = 0; i < l.length; i += 120) bubbles.push(l.slice(i, i + 120));
        }
        for (const b of bubbles) {
          await sendText(uid, b);
          await new Promise(r => setTimeout(r, 700));
        }
        record({ kind: 'out', to: uid, text: reply });
      });
    } else if (d.message_type === 'group') {
      record({ kind: 'group', group: d.group_id, from: uid, name: d.sender?.nickname, text });
    }
  });
  // 心跳 + 半死检测：90 秒一个字节都没收到，就判连接假活，主动重建。
  const beat = setInterval(() => {
    if (Date.now() - lastData > 90000) {
      log('ws 90s 没数据，判半死，主动重建');
      try { ws.close(); } catch {}
      return;
    }
    try { ws.send(JSON.stringify({ action: 'get_status', params: {} })); } catch {}
  }, 30000);
  ws.addEventListener('close', () => clearInterval(beat));
}

// 也给命令行用：node bridge.mjs send "文本"
if (process.argv[2] === 'send') {
  sendText(BOSS, process.argv.slice(3).join(' ')).then(() => process.exit(0));
} else {
  connect();
  startSayServer();
  log('bridge up. boss=', BOSS);
}
