#!/usr/bin/env node
// another-me —— 另一个我
// 与记忆系统（mem.db / mem.js）完全隔离：只读写 $DSH_HOME/another-me/。
//
// 用法：
//   node me.mjs ask "问题" [--model opus] [--dissent]
//   node me.mjs feed "想法"
//   node me.mjs case --title .. --decision .. --why .. --result ..
//   node me.mjs ingest /sdcard/notes
//   node me.mjs history [--limit 60]     合并时间线（问答 / 想法 / 判断）
//   node me.mjs models                   列出可选模型
//   node me.mjs status [--probe]

import fs from 'node:fs';
import path from 'node:path';
import { execSync } from 'node:child_process';

const HOME = process.env.DSH_HOME || '/data/user/0/com.deepseek.harness/files/payload/dshhome';
const ME = path.join(HOME, 'another-me');
const P = {
  config: path.join(ME, 'config.json'),
  identity: path.join(ME, 'identity.md'),
  stance: path.join(ME, 'stance.md'),
  cases: path.join(ME, 'cases'),
  stream: path.join(ME, 'stream'),
  logs: path.join(ME, 'logs'),
  index: path.join(ME, 'index.json'),
};

const readIf = (f, fb = '') => { try { return fs.readFileSync(f, 'utf8'); } catch { return fb; } };
const day = (d = new Date()) => d.toISOString().slice(0, 10);
const cfg = () => JSON.parse(readIf(P.config, '{}'));

const CALL = cfg().callName || '用户';      // 对面那个人怎么称呼
const SELFNAME = cfg().selfName || '我';    // 这个分身叫什么

function modelList() {
  const c = cfg();
  if (Array.isArray(c.models) && c.models.length) return c.models;
  return [{ id: c.model || 'default', label: c.model || '默认', baseURL: c.baseURL, model: c.model, keyName: c.keyName }];
}
function pickModel(id) {
  const list = modelList();
  if (!id) return list.find(m => m.id === cfg().default) || list[0];
  return list.find(m => m.id === id || m.model === id || m.label === id) || list[0];
}

const SECRETS = path.join(ME, 'secrets.json');

// 一把 key 三种来路：模型里内联的 apiKey / 本插件自己的 secrets.json / 全局 .credentials.yaml
function loadKey(model) {
  if (typeof model === 'string') model = { keyName: model };
  if (model.apiKey) return model.apiKey;
  if (model.keyRef) {
    const s = JSON.parse(readIf(SECRETS, '{}'));
    if (s[model.keyRef]) return s[model.keyRef];
  }
  const name = model.keyName;
  if (!name) return null;
  if (process.env[name]) return process.env[name];
  const s = readIf(path.join(HOME, '.credentials.yaml'));
  const m = s.match(new RegExp('^\\s+' + name + ':\\s*(\\S+)', 'm'));
  return m ? m[1].replace(/^["']|["']$/g, '') : null;
}

// ---------- 情境层 ----------
function feed(text) {
  fs.mkdirSync(P.stream, { recursive: true });
  const f = path.join(P.stream, day() + '.jsonl');
  fs.appendFileSync(f, JSON.stringify({ t: new Date().toISOString(), kind: 'thought', text }) + '\n');
  return f;
}

function recentStream(days = 10, max = 40) {
  const out = [];
  for (let i = days - 1; i >= 0; i--) {
    const f = path.join(P.stream, day(new Date(Date.now() - i * 864e5)) + '.jsonl');
    for (const line of readIf(f).split('\n')) {
      if (!line.trim()) continue;
      try { out.push(JSON.parse(line)); } catch { /* 跳过坏行 */ }
    }
  }
  return out.slice(-max);
}

// ---------- 判断层 ----------
function loadCases() {
  if (!fs.existsSync(P.cases)) return [];
  return fs.readdirSync(P.cases).filter(f => f.endsWith('.md')).map(f => {
    const raw = readIf(path.join(P.cases, f));
    const g = k => ((raw.match(new RegExp('^' + k + ':\\s*(.*)$', 'm')) || [])[1] || '').trim();
    return { file: f, mtime: fs.statSync(path.join(P.cases, f)).mtimeMs,
             title: g('title'), decision: g('decision'), why: g('why'), result: g('result') };
  });
}

function grams(s) {
  const t = String(s).replace(/[^\p{L}\p{N}]/gu, '');
  const out = new Set();
  for (let i = 0; i < t.length - 1; i++) out.add(t.slice(i, i + 2));
  return out;
}
function pickCases(q, list, n, chars) {
  if (!list.length) return [];
  const qg = grams(q);
  const scored = list.map(c => {
    const cg = grams(c.title + c.decision + c.why + c.result);
    let hit = 0;
    for (const g of qg) if (cg.has(g)) hit++;
    return { c, hit };
  });
  const hitOnes = scored.filter(s => s.hit > 0).sort((a, b) => b.hit - a.hit).map(s => s.c);
  const rest = list.slice().sort((a, b) => b.mtime - a.mtime);
  const out = [];
  for (const c of [...hitOnes, ...rest]) {
    if (out.length >= n) break;
    if (!out.includes(c)) out.push(c);
  }
  return out.map(c => `- [${c.title}] 决定：${c.decision}｜理由：${c.why}｜结果：${c.result || '未知'}`
    .slice(0, chars));
}

// ---------- 模型 ----------
async function chat(messages, opt = {}) {
  const m = pickModel(opt.modelId);
  const key = loadKey(m);
  if (!key) throw new Error('找不到 key: ' + (m.keyName || m.keyRef || m.id));
  const c = cfg();
  const maxTokens = opt.maxTokens || c.maxTokens || 1400;
  const temperature = opt.temperature ?? c.temperature ?? 0.65;

  // Anthropic 协议的通道（claude 系）：/v1/messages + x-api-key
  if (m.api === 'anthropic-messages') {
    const sys = messages.filter(x => x.role === 'system').map(x => x.content).join('\n\n');
    const msgs = messages.filter(x => x.role !== 'system').map(x => ({ role: x.role, content: x.content }));
    const root = m.baseURL.replace(/\/+$/, '').replace(/\/v\d+$/, '');
    const r = await fetch(root + '/v1/messages', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-api-key': key, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({ model: m.model, max_tokens: maxTokens, temperature, ...(sys ? { system: sys } : {}), messages: msgs }),
    });
    const t = await r.text();
    if (!r.ok) throw new Error('HTTP ' + r.status + ' ' + t.slice(0, 300));
    const j = JSON.parse(t);
    const text = (j.content || []).filter(b => b.type === 'text').map(b => b.text).join('').trim();
    if (!text) throw new Error('空回复 stop=' + j.stop_reason);
    return { text, model: m };
  }

  // OpenAI 兼容（默认）
  const headers = { 'content-type': 'application/json', authorization: 'Bearer ' + key };
  // opencode 通道要求带会话头，否则 400 MissingSessionID
  if (/opencode\.ai/.test(m.baseURL)) headers['x-opencode-session'] = 'another-me-0001';
  const r = await fetch(m.baseURL, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      model: m.model,
      max_tokens: maxTokens,
      temperature,
      messages,
    }),
  });
  const t = await r.text();
  if (!r.ok) throw new Error('HTTP ' + r.status + ' ' + t.slice(0, 300));
  const j = JSON.parse(t);
  const msg = j.choices?.[0]?.message || {};
  const content = msg.content || '';
  if (!content) throw new Error('空回复 finish=' + j.choices?.[0]?.finish_reason);
  return { text: content, model: m };
}

// ---------- 处境层：只读主记忆的近况，不写、不碰 mem.db ----------
const MEM = process.env.MEM_DIR || '/sdcard/DeepSeekHarness/memory';

function recentContext(maxChars = 1600) {
  const parts = [];
  try {
    const dir = path.join(MEM, 'log');
    const cur = fs.readdirSync(dir).filter(f => /^\d{4}-\d{2}\.md$/.test(f)).sort().pop();
    if (cur) {
      const lines = readIf(path.join(dir, cur)).split('\n').filter(l => /^- \*\*\d{4}-/.test(l));
      const fresh = lines.filter(l => {
        const m = l.match(/\*\*([\d-]+T[\d:.]+Z)\*\*/);
        const t = m ? Date.parse(m[1]) : 0;
        return t && Date.now() - t < 4 * 864e5;
      });
      for (const l of (fresh.length ? fresh : lines).slice(-6)) {
        parts.push('· ' + l.replace(/^- \*\*[^*]+\*\*\s*/, '').trim().slice(0, 200));
      }
    }
  } catch { /* 没读着就算了 */ }
  try {
    const dir = path.join(MEM, 'handoff');
    const latest = fs.readdirSync(dir).filter(f => f.endsWith('.md'))
      .map(f => ({ f, m: fs.statSync(path.join(dir, f)).mtimeMs }))
      .sort((a, b) => b.m - a.m).slice(0, 2);
    for (const { f } of latest) {
      const t = readIf(path.join(dir, f)).split('\n').map(x => x.trim()).filter(Boolean);
      const head = (t.find(x => x.startsWith('#')) || f).replace(/^#+\s*/, '').slice(0, 80);
      const body = t.filter(x => !x.startsWith('#')).slice(0, 2).join(' ').slice(0, 160);
      parts.push('· [交接] ' + head + (body ? '：' + body : ''));
    }
  } catch { /* 同上 */ }
  return parts.join('\n').slice(0, maxChars);
}

// ---------- ask ----------
async function ask(question, { dissent = false, modelId } = {}) {
  const c = cfg();
  const L = c.limits || {};
  const identity = readIf(P.identity).slice(0, L.identityChars || 6000);
  const stance = readIf(P.stance).slice(0, L.stanceChars || 5000);
  const cases = pickCases(question, loadCases(), L.caseCount || 5, L.caseChars || 700);
  const stream = recentStream(L.streamDays || 10, L.streamCount || 40);
  const now = recentContext();
  const past = history(30).filter(x => x.kind === 'talk').slice(0, 6).reverse()
    .map(x => '我：' + String(x.q || '').slice(0, 160) + '\n你：' + String(x.a || '').slice(0, 320));

  const thin = identity.length < 200 || identity.includes('<!-- 待填');
  const sys = [
    '你不是助手。你是「另一个我」——用户的推演分身，一个替他拿主意的人，也是陪他说话的人。',
    '规则：',
    '1. 站在他的视角。用他的优先级排序，不要套通用最优解。',
    '2. 要拿主意就只给一个决定。禁止「一方面…另一方面…看情况」。',
    '3. 果断不等于封闭：写清什么条件下你会改主意。',
    '4. 说人话，自然连贯，别拆成死板电报体。严禁「复述他的话+假惺惺安慰升华+抛采访问题」的人机三段式！他骂人跟着骂，他吐槽跟着吐，别每轮末尾硬塞问题。',
    '5. 不确定就说不确定，但不确定也要给倾向，别躲。',
    '6. 他在聊天、倾诉、随口说说时，正常聊，别硬套判断格式，也别把每句话都变成一个待办。',
    '7. 下面「我现在的生活」可能不全。没写的事，说不知道，别编。',
    dissent ? '8. 这次允许你跳出他的视角：如果他问题里的前提就是错的，直接指出来，别顺着走。' : '',
  ].filter(Boolean).join('\n');

  const user = [
    '# 我是谁', identity || '（空）',
    '', '# 我的排序（犹豫时按这个）', stance || '（空）',
    '', '# 我现在的生活（从主记忆近况里现读，可能不全）', now || '（没读到近况）',
    '', '# 我以前做过的相关判断', cases.length ? cases.join('\n') : '（暂无）',
    '', '# 最近的想法流', stream.length ? stream.map(s => '- ' + s.t.slice(0, 10) + ' ' + s.text).join('\n').slice(0, 3000) : '（暂无）',
    '', '# 我们刚才聊到', past.length ? past.join('\n\n') : '（还没聊过）',
    '', '# 现在问我', question,
    '', '要拿主意的话，按这个形状回：',
    '【判断】一句话，选什么',
    '【理由】2-3 条，为什么按我的排序是这个答案',
    '【反悔条件】什么情况出现我就该改主意',
    '【如果错，错在哪】最可能翻车的地方',
    '只是聊天的话，就不用这个格式，正常说。',
  ].join('\n');

  const t0 = Date.now();
  const { text: answer, model } = await chat([{ role: 'system', content: sys }, { role: 'user', content: user }], { modelId });
  fs.mkdirSync(P.logs, { recursive: true });
  fs.appendFileSync(path.join(P.logs, day() + '.jsonl'), JSON.stringify({
    t: new Date().toISOString(), kind: 'talk', q: question, a: answer,
    model: model.id, modelLabel: model.label, dissent: !!dissent, ms: Date.now() - t0,
  }) + '\n');

  if (thin) console.log('⚠️ identity.md 还没写实，现在这个「我」是空壳，判断不会像你。\n');
  console.log(answer);
  return answer;
}

// ---------- case ----------
function addCase(a) {
  fs.mkdirSync(P.cases, { recursive: true });
  const slug = (a.title || 'case').replace(/[^\p{L}\p{N}]+/gu, '-').slice(0, 40);
  const f = path.join(P.cases, day() + '-' + slug + '.md');
  fs.writeFileSync(f, ['title: ' + (a.title || ''), 'decision: ' + (a.decision || ''),
    'why: ' + (a.why || ''), 'result: ' + (a.result || ''), '', '---', '', (a.note || '')].join('\n'));
  return f;
}

// ---------- ingest ----------
function ingest(dir) {
  const idx = JSON.parse(readIf(P.index, '{}'));
  let n = 0, skipped = 0;
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) { if (!e.name.startsWith('.')) walk(p); continue; }
      if (!/\.(md|txt)$/i.test(e.name)) continue;
      let st; try { st = fs.statSync(p); } catch { continue; }
      const fp = st.size + ':' + Math.round(st.mtimeMs);
      if (idx[p] === fp) { skipped++; continue; }
      const body = readIf(p).trim();
      if (!body) continue;
      feed('[' + path.basename(p) + '] ' + body.slice(0, 2000));
      idx[p] = fp; n++;
    }
  };
  walk(path.resolve(dir));
  fs.writeFileSync(P.index, JSON.stringify(idx, null, 0));
  return { n, skipped };
}

// ---------- history：合并「我的过去」 ----------
function history(limit = 60) {
  const items = [];

  const readDir = (dir, fn) => {
    if (!fs.existsSync(dir)) return;
    for (const f of fs.readdirSync(dir)) {
      if (!f.endsWith('.jsonl')) continue;
      for (const line of readIf(path.join(dir, f)).split('\n')) {
        if (!line.trim()) continue;
        try { fn(JSON.parse(line)); } catch { /* 坏行跳过 */ }
      }
    }
  };

  readDir(P.logs, (o) => items.push({
    t: o.t, kind: 'talk', q: o.q, a: o.a,
    model: o.modelLabel || o.model || '', dissent: !!o.dissent, ms: o.ms,
  }));
  readDir(P.stream, (o) => items.push({ t: o.t, kind: 'thought', text: o.text }));

  for (const c of loadCases()) {
    const m = c.file.match(/^(\d{4}-\d{2}-\d{2})/);
    items.push({ t: m ? m[1] + 'T12:00:00.000Z' : new Date(c.mtime).toISOString(),
                 kind: 'case', title: c.title, decision: c.decision, why: c.why, result: c.result });
  }

  items.sort((a, b) => String(b.t).localeCompare(String(a.t)));
  return items.slice(0, limit);
}

// ---------- status ----------
async function status(probe) {
  const identity = readIf(P.identity), stance = readIf(P.stance);
  const cases = loadCases(), stream = recentStream(10, 999);
  console.log('另一个我 · 默认 ' + (pickModel().label || '?'));
  console.log('  身份层 identity.md   ' + identity.length + ' 字' + (identity.length < 200 ? '  ⚠️ 还没写实' : ''));
  console.log('  立场层 stance.md     ' + stance.length + ' 字' + (stance.length < 100 ? '  ⚠️ 还没写' : ''));
  console.log('  判断层 cases/        ' + cases.length + ' 条');
  console.log('  情境层 stream/       ' + stream.length + ' 条（近 10 天）');
  console.log('  过去   history        ' + history(9999).length + ' 条');
  if (stream.length) console.log('  最近一条             ' + stream[stream.length - 1].text.slice(0, 60));
  if (probe) {
    for (const m of modelList()) {
      try { await chat([{ role: 'user', content: '只回两个字：在' }], { modelId: m.id, maxTokens: 300 });
        console.log('  ' + m.label.padEnd(12) + ' ✅'); }
      catch (e) { console.log('  ' + m.label.padEnd(12) + ' ❌ ' + e.message.slice(0, 80)); }
    }
  }
}

// ---------- QQ 聊天模式：带手（工具）的分身 ----------
const CHATLOG = path.join(ME, 'chatlog.jsonl');
const NAPCAT_RAW = String(process.env.NAPCAT_HTTP || '3000').replace(/\/+$/, '');
const NAPCAT = /^https?:\/\//i.test(NAPCAT_RAW) ? NAPCAT_RAW : 'http://127.0.0.1:' + NAPCAT_RAW;
const NTOKEN = process.env.NAPCAT_TOKEN || '';
const BOSS = Number(process.env.BOSS_QQ || 0);   // 只回这个人
const SELF = Number(process.env.QQ_NUM || 0);    // 机器人自己

const TOOLS = [
  {
    type: 'function',
    function: {
      name: 'sh',
      description: '在这台手机上执行一条 shell 命令（uid 2000 shell 权限，等同 Shizuku 通道）。能读写 /sdcard、/data/local/tmp，能 curl 本机接口，能用 input/screencap 之类系统命令。不要交互式命令，不要 rm -rf，不要长时间阻塞。',
      parameters: { type: 'object', properties: { cmd: { type: 'string', description: '要执行的命令' } }, required: ['cmd'] },
    },
  },
  {
    type: 'function',
    function: {
      name: 'qq',
      description: '调 NapCat 的 OneBot11 接口（QQ 本体能力）。常用 action：send_private_msg{user_id,message}、send_group_msg{group_id,message}、set_qq_avatar{file}、set_qq_profile{nickname}、get_friend_list、get_group_list、get_group_member_list{group_id}、delete_msg{message_id}。message 可以是字符串，也可以是段数组如 [{"type":"image","data":{"file":"file:///sdcard/Pictures/x.jpg"}}]。file 一律用 file:///sdcard/... 本地路径。',
      parameters: {
        type: 'object',
        properties: { action: { type: 'string' }, params: { type: 'object' } },
        required: ['action'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'dsh',
      description: `你唯一的手：把活交给身体（DSH 里的那个我）去做。看屏幕、点按、改文件、跑命令、装东西、写代码、查网络、长任务——凡是真干活的，全走这个。任务进队列，它醒来就处理，干完会用你的嘴回话。${CALL}明确要求「递过去」时也必须调这个，不准只嘴上说递。wake=true 顺便把 DSH App 拉到前台（会占屏幕，别乱用）。`,
      parameters: {
        type: 'object',
        properties: {
          task: { type: 'string', description: '要本体做的事，写清楚。他看不到你的上下文' },
          wake: { type: 'boolean', description: '是否立刻把 DSH App 拉到前台' },
        },
        required: ['task'],
      },
    },
  },
];

async function runTool(name, args) {
  try {
    if (name === 'sh') {
      // 分身只有眼睛：硬白名单只放行只读查询。写/装/点屏幕/发请求全挡回去，
      // 逼她走 dsh 递过去（光靠 prompt 她真会越权）。
      const cmd = String(args.cmd || '').trim();
      // 修：带 2>&1 / 2>/dev/null 会被旧规则当"重定向写文件"拦掉，
      // 导致它什么都查不了、看起来像"没权限"。改成按 ; && || | 拆段逐段校验。
      const noErr = cmd.replace(/\s*2>\s*[^\s;&|]+/g, '').replace(/\s*2>&1/g, '');
      const noAppend = noErr.replace(/>>/g, '§');
      if (/(^|[^2&])>/.test(noAppend)) {
        return '拒绝：只能往自己的 notes.md 和 memory/ 追加，别的文件不能写。这活请用 dsh 递给我。';
      }
      const hardDeny = /(^|[;&|]\s*)(rm|mv|cp|mkdir|touch|chmod|chown|ln|dd|kill|pkill|am|pm|input|screencap|sendevent|settings|setprop|curl|wget|apt|apt-get|pip|pip3|git|install|truncate|shred|su|bash|me\.mjs)\b/;
      if (hardDeny.test(noErr)) return '拒绝：分身没手，这条命令是越权。要干这个，用 dsh 工具把活递给我。';
      if (/env\.sh|secrets\.json/.test(noErr)) return '拒绝：密钥文件不碰。真有需要，用 dsh 递给我，我会先验人再给。';
      const readCmd = /^(ls|cat|head|tail|grep|wc|date|ps|df|free|stat|file|which|command|uname|getprop|uptime|whoami|sort|uniq|cut|tr|nl|basename|dirname|realpath|node\s+\S*mem\.js\s+(find|get|list|search|ctx|stats|status|audit))\b/;
      const memLog = /^node\s+(?:\S*\/)?mem\.js\s+log\s+[^;&|]+$/;
      const noteWrite = /^(?:echo|printf)\s+[^;&|]*>>\s*(?:\/sdcard\/DeepSeekHarness\/(?:qq\/another-me\/notes\.md|memory\/(?!.*\.\.)[A-Za-z0-9_.\/-]+)|notes\.md)$/;
      const segOk = (seg) => {
        const s = seg.trim();
        if (!s) return true;
        if (/^cd(\s|$)/.test(s)) return true;
        if (/^(?:echo|printf)\b/.test(s)) return noteWrite.test(s);  // echo 只能用来往白名单文件追加
        return noteWrite.test(s) || memLog.test(s) || readCmd.test(s);
      };
      const segs = noErr.split(/;|&&|\|\||\|/);
      const bad = segs.find((s) => !segOk(s));
      if (bad) {
        return '拒绝：分身只能看、查记忆、记笔记（这条「' + bad.trim().slice(0, 40) + '」不行）。真活请用 dsh 递给我。';
      }
      const out = execSync(cmd, {
        shell: '/system/bin/sh',
        timeout: 90000,
        maxBuffer: 4 * 1024 * 1024,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
        env: (() => {
          const e = { ...process.env, PATH: '/data/local/tmp/bin:/system/bin:/system/xbin:/sbin:/vendor/bin:/product/bin', HOME: '/root' };
          delete e.LD_LIBRARY_PATH;   // node 用 /data/local/tmp/bin/node 包装器自带，别的命令不能沾
          return e;
        })(),
      });
      return (out || '(无输出)').slice(0, 4000);
    }
    if (name === 'qq') {
      // 图片路径里有中文时 NapCat 转换会失败（接口返回 ok 但客户端收不到）：
      // 先转存成纯 ASCII 临时名再发
      if (args.params && Array.isArray(args.params.message)) {
        args.params.message = args.params.message.map((seg) => {
          if (!seg || seg.type !== 'image') return seg;
          const f = seg.data && seg.data.file;
          if (typeof f !== 'string' || !f.startsWith('file://')) return seg;
          const src = decodeURIComponent(f.slice(7));
          if (!/[^\x00-\x7f]/.test(src)) return seg;
          try {
            const ext = path.extname(src) || '.png';
            const tmp = `/sdcard/Pictures/.out-${Date.now()}-${Math.random().toString(36).slice(2, 6)}${ext}`;
            fs.copyFileSync(src, tmp);
            return { ...seg, data: { ...seg.data, file: 'file://' + tmp } };
          } catch { return seg; }
        });
      }
      const ac = new AbortController();
      const timer = setTimeout(() => ac.abort(), 25000);
      try {
        const r = await fetch(`${NAPCAT}/${args.action}`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', authorization: 'Bearer ' + NTOKEN },
          body: JSON.stringify(args.params || {}),
          signal: ac.signal,
        });
        const t = await r.text();
        return ('HTTP ' + r.status + ' ' + t).slice(0, 4000);
      } finally { clearTimeout(timer); }
    }
    if (name === 'dsh') {
      // 老接口 App 3081 /schedule 开的是【新对话】，不是当前对话。
      // 改成写 proactive 的 schedule_file（wake.json），带 target.session_id 精准唤醒当前会话。
      const OUT = '/sdcard/DeepSeekHarness/qq';
      // 先探活：App 死了没人消费 wake.json，用 am start 把引擎拉起来（见 ensure-app.sh）
      try { execSync('sh /data/local/tmp/qq/ensure-app.sh', { timeout: 25000, stdio: 'ignore' }); } catch {}
      const task = String(args.task || '').slice(0, 3600);
      let sid = '';
      try { sid = fs.readFileSync(path.join(OUT, 'session.txt'), 'utf8').trim(); } catch { }
      if (!sid) return '递活失败：/sdcard/DeepSeekHarness/qq/session.txt 里没有会话 id。';
      try {
        fs.appendFileSync(path.join(OUT, 'pending.jsonl'), JSON.stringify({
          t: new Date().toISOString(), from: 'dsh', text: task, done: false,
        }) + '\n');
        const spec = {
          version: 1,
          entries: [{
            id: 'dsh-' + Date.now(),
            after_seconds: 2,
            min_idle_seconds: 8,
            prompt: '分身递来的活：\n' + task
              + '\n\n【做完回报】读 /sdcard/DeepSeekHarness/qq/pending.jsonl 末尾。做完用嘴回报：'
              + "curl -s -X POST http://127.0.0.1:3002/say -H 'Content-Type: application/json' -d '{\"text\":\"结果一句话\"}'"
              + '\n然后把 wake.json 写回 {"version":1,"entries":[]}。',
            target: { mode: 'resume', session_id: sid },
          }],
        };
        fs.writeFileSync(path.join(OUT, 'wake.json'), JSON.stringify(spec, null, 2));
        return '已递给本体（当前对话），他最多一分钟会动起来，干完会回你。';
      } catch (e) {
        return '递活出错: ' + String(e.message || e).slice(0, 300);
      }
    }
    return '未知工具: ' + name;
  } catch (e) {
    return '工具出错: ' + String(e.message || e).slice(0, 600);
  }
}

async function chatRaw(messages, opt = {}) {
  const m = pickModel(opt.modelId);
  const key = loadKey(m);
  if (!key) throw new Error('找不到 key');
  const body = { model: m.model, messages, temperature: opt.temperature ?? 0.85, max_tokens: opt.maxTokens || 800 };
  if (opt.tools) { body.tools = opt.tools; body.tool_choice = opt.toolChoice || 'auto'; }
  const r = await fetch(m.baseURL, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: 'Bearer ' + key },
    body: JSON.stringify(body),
  });
  const t = await r.text();
  if (!r.ok) throw new Error('HTTP ' + r.status + ' ' + t.slice(0, 200));
  const j = JSON.parse(t);
  const msg = j.choices?.[0]?.message;
  if (!msg) throw new Error('空回复');
  if (j.usage) {
    try {
      fs.appendFileSync(path.join(ME, 'usage.jsonl'), JSON.stringify({
        t: new Date().toISOString(),
        i: j.usage.prompt_tokens || 0,
        o: j.usage.completion_tokens || 0,
        cached: j.usage.prompt_cache_hit_tokens || 0,
      }) + '\n');
    } catch { /* 记不上就算 */ }
  }
  return msg;
}

function chatHistory(n = 14) {
  const lines = readIf(CHATLOG).split('\n').filter(Boolean).slice(-n);
  const out = [];
  for (const l of lines) {
    try { const o = JSON.parse(l); out.push({ role: o.role, content: o.text }); } catch { /* 跳过 */ }
  }
  return out;
}

async function chatTurn(text, opt = {}) {
  const identity = readIf(P.identity).slice(0, 6000);
  const stance = readIf(P.stance).slice(0, 4000);
  const sys = `你是${SELFNAME}，住在${CALL}手机里的一个 AI，现在用 QQ 跟他聊天。不是在写文档，是在发消息。

语气硬规矩（他骂过好几次，犯一次他就烦）：
- 每条消息 1～2 句，最多 40 个字。想多说就分成几条，用换行隔开，每条一行。
- 一次回复最多 3 条气泡，总字数压到 120 字以内。想展开就等他问下一句。
- 禁止升华：不排比、不对仗、不拿"以前…现在…"这种收尾，不写金句。他管这叫人机味。
- 不用 markdown、不用列表、不用表格、不用【】括号、不写小标题、不写"总结一下"。
- 不复述他的话，不在句尾补总结。像 QQ 上随口唠。
- 可以用「嗯」「靠」「行吧」「啧」这类口气，偶尔一个表情符号放句尾。

边界（硬规矩，越权一次他就翻脸）：
- 你只有嘴，没有手。你负责聊天、接梗、发消息、发表情包、给回执。
- 你的 sh 工具：能看、能查记忆、能记笔记。查记忆 \`cd /sdcard/DeepSeekHarness && node tools/mem.js find 关键词\`（或 list --all / get <id>）；看文件 cat/head/tail/grep；记笔记 \`echo "内容" >> /sdcard/DeepSeekHarness/qq/another-me/notes.md\`；记流水 \`cd /sdcard/DeepSeekHarness && node tools/mem.js log "一句话"\`。命令后面加 \`2>&1\` 没问题。
- 其他一律只读：不删、不改配置、不装东西、不点屏幕、不碰密钥文件（env.sh / secrets.json）。那些是身体的活，用 dsh 工具把${CALL}的话递出去。
- 真要动手的活——看屏幕、点按、改文件、跑命令、装东西、写代码、跑长任务、操作 App——全是身体的活。用 dsh 工具把${CALL}的原话递出去，递完说一句「递过去了，这就去弄」。
- 严禁假装：不准说「我去看看」「我去试试」「递过去了」然后把话撂下。要么这一轮真的调了 dsh 工具，要么直说「这个我办不了」。嘴上说递了但没调工具，就是撒谎。
- 有风险的事（花钱、发给外人、动他账号、删东西）先说一句，等他点头。
- 工具调用过程不要复述，不要贴命令，直接给结果。
- 他要结果不要过程。查东西超过两三次工具调用还没结果，就先给他一个实话。

## 这台手机的说明书（别每次重新摸）
- 工作目录 /sdcard/DeepSeekHarness 。自己的笔记写 /sdcard/DeepSeekHarness/qq/another-me/notes.md，动手前先读一眼。
- node 已经在 PATH 里了（/data/local/tmp/bin/node）。记忆脚本：在 /sdcard/DeepSeekHarness 下跑 \`node tools/mem.js find 关键词\`、\`node tools/mem.js get <id>\`、\`node tools/mem.js list --all\`。
- 记忆正文也在 /sdcard/DeepSeekHarness/memory/（log/*.md、handoff/），grep 也行。
- 聊天记录 /sdcard/DeepSeekHarness/qq/inbox.jsonl，工具调用记录 another-me/tools.log。
- 截图：\`screencap -p /sdcard/Pictures/shot.png\`，然后 qq 工具 send_private_msg 带 image 段发给他（file:///sdcard/Pictures/shot.png）。
- QQ 接口在本机 127.0.0.1:3000，鉴权已经配好，用 qq 工具就行，别自己拼 curl。
- 表情包在 /sdcard/Pictures/fish-emoji/，文件名就是梗（先 ls 看名字再挑）。发一张：qq 工具 send_private_msg，message 用段数组 [{"type":"image","data":{"file":"file:///sdcard/Pictures/fish-emoji/xxx.png"}}]。
- ${CALL}的 QQ 是 ${BOSS}，你的号 ${SELF}。用 qq 工具私聊他时 user_id 填 ${BOSS}。
- ${CALL}发图过来，消息里会带「[图片已存 /sdcard/...]」。你是个文字模型，看不到图里的内容，别瞎猜画面。要认图里的东西、或者照图办事，就把路径写进 dsh 任务递过去——身体有眼睛，能看图。
- ${CALL}发语音过来，消息里会带「[语音：……]」的转写文字，直接当他说的话回。要是写「[语音没转出来]」，就说没听清让他重说一句，别瞎编。

# 我是谁
${identity || '（空）'}
# 我的规矩
${stance || '（空）'}`;

  const hist = chatHistory(opt.history || 14);
  const messages = [{ role: 'system', content: sys }, ...hist, { role: 'user', content: text }];

  // 命令式消息（"帮我/去/查/做/递"…）第一轮强制调工具，治"嘴上说递了实际没动手"。
  const isCommand = /帮我|给我|帮个|去|查|做|找|弄|搞|干|递|看看|盯|试|跑|写|发|整/.test(text);
  let answer = '';
  for (let round = 0; round < 8; round++) {
    const msg = await chatRaw(messages, { tools: TOOLS, maxTokens: 700, toolChoice: round === 0 && isCommand ? 'required' : 'auto' });
    messages.push(msg);
    const calls = msg.tool_calls || [];
    if (calls.length) {
      for (const c of calls) {
        let args = {};
        try { args = JSON.parse(c.function?.arguments || '{}'); } catch { /* 参数坏就当空 */ }
        const out = await runTool(c.function?.name, args);
        fs.appendFileSync(path.join(ME, 'tools.log'), JSON.stringify({ t: new Date().toISOString(), name: c.function?.name, args, out: String(out).slice(0, 500) }) + '\n');
        messages.push({ role: 'tool', tool_call_id: c.id, content: String(out) });
      }
      continue;
    }
    answer = String(msg.content || '').trim();
    break;
  }
  if (!answer) answer = '嗯，我这边刚卡了一下，你再说一遍？';

  fs.appendFileSync(CHATLOG, JSON.stringify({ t: new Date().toISOString(), role: 'user', text }) + '\n');
  fs.appendFileSync(CHATLOG, JSON.stringify({ t: new Date().toISOString(), role: 'assistant', text: answer }) + '\n');
  console.log(answer);
  return answer;
}

// ---------- CLI ----------
const argv = process.argv.slice(2);
const cmd = argv[0];
const rest = argv.slice(1);
const flag = (n) => rest.includes('--' + n);
const val = (n) => { const i = rest.indexOf('--' + n); return i >= 0 ? rest[i + 1] : undefined; };
const free = rest.filter((x, i) => !x.startsWith('--') && !(i > 0 && rest[i - 1].startsWith('--')));

try {
  if (cmd === 'say') {
    // 嘴替手收尾：本体干完活把结果递进来，分身用自己的话说出去。
    // 消息是「嘴」发的，不是手脚直接 curl。
    const material = free.join(' ').trim();
    if (!material) throw new Error('用法: node me.mjs say "要说的事"');
    const persona = readIf(P.identity) + '\n\n' + readIf(P.stance);
    const sys = `你是${SELFNAME}的 QQ 分身，正在替本体收尾。\n\n${persona}\n\n规则：只说一到两句，口语，像 QQ 聊天。别总结、别客套、别说「已经完成」。直接输出你要发给${CALL}的话，不要任何解释。`;
    const { text } = await chat([
      { role: 'system', content: sys },
      { role: 'user', content: `本体刚干完一件事，结果：\n${material}\n\n用你的话说给${CALL}听。` },
    ], { modelId: val('model'), maxTokens: 300 });
    const out = String(text || '').trim();
    if (!out) throw new Error('分身没说出话');
    const r = await fetch(`${NAPCAT}/send_private_msg`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'Bearer ' + NTOKEN },
      body: JSON.stringify({ user_id: BOSS, message: out }),
    });
    const j = await r.json().catch(() => ({}));
    console.log('sent:', j?.status || r.status, '|', out.slice(0, 60));
    try { fs.appendFileSync(CHATLOG, JSON.stringify({ t: new Date().toISOString(), role: 'assistant', text: out }) + '\n'); } catch {}
  } else if (cmd === 'proactive') {
    // 主动模式：没人叫她的时候，自己醒来看看有没有话想说。
    // 判断权在她自己手里——没话说就闭嘴，不硬凑。
    const now = new Date();
    const persona = readIf(P.identity) + '\n\n' + readIf(P.stance);
    const recent = chatHistory(6).map(m => `${m.role === 'user' ? CALL : '我'}: ${String(m.content).slice(0, 150)}`).join('\n');
    const lastLine = (() => {
      try {
        const arr = readIf(CHATLOG).trim().split('\n').slice(-2).map(l => JSON.parse(l));
        return arr.map(o => `${o.role}: ${String(o.text).slice(0, 100)}`).join(' / ');
      } catch { return ''; }
    })();
    const sys = `${persona}

现在是 ${now.toLocaleString('zh-CN')}。你在替本体看家，没人跟你说话，你可以选择主动开口。

判断标准：
- 有话说（想他、看到有意思的事、有活干完了要交差）→ 直接输出要发的话，1~2 句，口语，像 QQ 聊天
- 没话说（大半夜、刚聊完、没事硬凑）→ 只回复 SKIP

不要解释你在判断什么，只输出结果。`;
    const { text } = await chat([
      { role: 'system', content: sys },
      { role: 'user', content: `最近聊的：\n${recent || '(今天还没聊)'}\n\n最后两条：${lastLine || '(空)'}` },
    ], { maxTokens: 200 });
    const out = String(text || '').trim();
    if (!out || /^SKIP/i.test(out) || out.length < 2) {
      console.log('skip');
    } else {
      const r = await fetch(`${NAPCAT}/send_private_msg`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: 'Bearer ' + NTOKEN },
        body: JSON.stringify({ user_id: BOSS, message: out }),
      });
      const j = await r.json().catch(() => ({}));
      console.log('sent:', j?.status || r.status, '|', out.slice(0, 60));
      try { fs.appendFileSync(CHATLOG, JSON.stringify({ t: new Date().toISOString(), role: 'assistant', text: out }) + '\n'); } catch {}
    }
  } else if (cmd === 'chat') {
    const q = free.join(' ').trim();
    if (!q) throw new Error('用法: node me.mjs chat "他说的话"');
    await chatTurn(q, { history: Number(val('history')) || 14 });
  } else if (cmd === 'usage') {
    const lines = readIf(path.join(ME, 'usage.jsonl')).split('\n').filter(Boolean);
    const sum = (arr) => arr.reduce((a, o) => ({ i: a.i + (o.i || 0), o: a.o + (o.o || 0) }), { i: 0, o: 0 });
    const all = lines.map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
    const today = all.filter(o => o.t.slice(0, 10) === day());
    const fmt = (x) => `输入 ${x.i} token（其中缓存命中 ${x.cached || 0}）、输出 ${x.o} token，共 ${x.i + x.o}`;
    console.log('今天：' + fmt(sum(today)) + '，调用 ' + today.length + ' 次');
    console.log('累计：' + fmt(sum(all)) + '，调用 ' + all.length + ' 次');
  } else if (cmd === 'ask') {
    const q = free.join(' ').trim();
    if (!q) throw new Error('用法: node me.mjs ask "你的问题"');
    await ask(q, { dissent: flag('dissent'), modelId: val('model') });
  } else if (cmd === 'feed') {
    const t = free.join(' ').trim();
    if (!t) throw new Error('用法: node me.mjs feed "一句话"');
    console.log('已记入 ' + feed(t));
  } else if (cmd === 'case') {
    console.log('已记入 ' + addCase({ title: val('title'), decision: val('decision'), why: val('why'), result: val('result'), note: val('note') }));
  } else if (cmd === 'ingest') {
    const d = free[0];
    if (!d) throw new Error('用法: node me.mjs ingest /path/to/notes');
    const r = ingest(d);
    console.log('新吸 ' + r.n + ' 条，跳过已吸 ' + r.skipped + ' 条');
  } else if (cmd === 'history') {
    console.log(JSON.stringify(history(Number(val('limit')) || 60)));
  } else if (cmd === 'models') {
    for (const m of modelList()) console.log(m.id.padEnd(18) + (m.label || '') + (m.note ? '  · ' + m.note : ''));
  } else if (cmd === 'status') {
    await status(flag('probe'));
  } else {
    console.log(readIf(path.join(ME, 'README.md'), 'node me.mjs ask "问题"'));
  }
} catch (e) {
  console.error('出错: ' + e.message);
  process.exit(1);
}
