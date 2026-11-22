#!/usr/bin/env node
// 语音转文字（STT）：QQ 语音(SILK/AMR/其他) → 16k 单声道 WAV → whisper → 文本
//
// 链路（按 2026-11-18 用户定的方案）：
//   1) 读文件头：含 #!SILK_V3 → silk-wasm 解成 16k 单声道 PCM → 自己包 WAV
//   2) 不是 SILK     → proot 里的 ffmpeg 转 16k 单声道 WAV
//   3) 喂引擎：whisper-cpp(本机 whisper-cli) / openai(云端) / custom(任意命令)
//
// 配置项（写 /sdcard/DeepSeekHarness/qq/another-me/config.json，顶层或 stt 段里都认）：
//   sttEnabled   true            总开关
//   sttEngine    "auto"          auto | openai | whisper-cpp | custom
//   sttCommand   ""              custom 引擎的命令模板，用 {wav} 占位
//   sttModel     "small"         ggml-<model>.bin 的 model 名，也可直接给 .bin 路径
//   sttTimeoutMs 60000           单次转写超时
//   sttLanguage  "zh"            识别语言（可选，默认 zh）
import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { createRequire } from 'node:module';

const DSH = '/sdcard/DeepSeekHarness';
const CFG_PATH = path.join(DSH, 'qq/another-me/config.json');
const TMP_DIR = path.join(DSH, 'qq/stt-tmp');
const PROOT = '/data/local/tmp/qq/run.sh';

// proot 里安装的位置（2026-11-18 装好）
const WHISPER_DIR = '/usr/local/whisper';
const WHISPER_BIN = WHISPER_DIR + '/whisper-cli';
const MODEL_DIR_PROOT = '/root/models';
const MODEL_HOST_CANDIDATES = [
  '/data/local/tmp/qq/ubuntu/root/models',
  path.join(DSH, 'tools/qq/models'),
];
const PROOT_TMP = '/data/local/tmp/qq/tmp';

// silk-wasm 有两份：proot 侧一份（shell 可读）、/sdcard 侧一份（App 也可读），谁在认谁
const SILK_MODULES = [
  '/sdcard/DeepSeekHarness/tools/qq/lib/silk-wasm/lib/index.cjs',
  '/data/local/tmp/qq/lib/silk-wasm/lib/index.cjs',
];

// 备胎引擎：proot 里的 sherpa-onnx + SenseVoice（2026-11-18 另一个会话装的）
const SHERPA_BIN = '/data/local/tmp/bin/sherpa-onnx-v1.12.33-linux-aarch64-static/bin/sherpa-onnx-offline';
const SHERPA_MODEL = '/sdcard/DeepSeekHarness/models/sherpa-onnx-sense-voice-zh-en-ja-ko-yue-2024-07-17';

const DEFAULTS = {
  sttEnabled: true,
  sttEngine: 'auto',
  sttCommand: '',
  sttModel: 'small',
  sttTimeoutMs: 60000,
  sttLanguage: 'zh',
  sttPrompt: '以下是普通话简体中文的聊天语音：',
  sttThreads: 6,
};

function log(...a) {
  try { console.log(new Date().toISOString().slice(11, 19), '[stt]', ...a); } catch {}
}

export function loadConfig() {
  let raw = {};
  try { raw = JSON.parse(fs.readFileSync(CFG_PATH, 'utf8')); } catch {}
  const nested = raw.stt && typeof raw.stt === 'object' ? raw.stt : {};
  const cfg = { ...DEFAULTS };
  for (const k of Object.keys(DEFAULTS)) {
    if (nested[k] !== undefined) cfg[k] = nested[k];
    else if (raw[k] !== undefined) cfg[k] = raw[k];
  }
  // 环境变量兜底（方便临时试：STT_ENGINE=whisper-cpp）
  const envMap = {
    STT_ENABLED: 'sttEnabled', STT_ENGINE: 'sttEngine', STT_COMMAND: 'sttCommand',
    STT_MODEL: 'sttModel', STT_TIMEOUT_MS: 'sttTimeoutMs', STT_LANGUAGE: 'sttLanguage',
  };
  for (const [e, k] of Object.entries(envMap)) {
    if (process.env[e] !== undefined && process.env[e] !== '') {
      cfg[k] = k === 'sttEnabled' ? /^(1|true|on|yes)$/i.test(process.env[e]) : process.env[e];
    }
  }
  cfg.sttTimeoutMs = Number(cfg.sttTimeoutMs) || DEFAULTS.sttTimeoutMs;
  cfg.sttEnabled = cfg.sttEnabled !== false && String(cfg.sttEnabled) !== 'false';
  return cfg;
}

// ---------- 工具 ----------

function run(cmd, timeoutMs) {
  return new Promise((resolve) => {
    const env = { ...process.env };
    delete env.LD_LIBRARY_PATH;
    execFile(cmd[0], cmd.slice(1), { timeout: timeoutMs, maxBuffer: 4 * 1024 * 1024, env },
      (err, stdout, stderr) => resolve({
        ok: !err,
        killed: !!(err && err.killed),
        out: String(stdout || ''),
        err: String(stderr || (err && err.message) || ''),
      }));
  });
}

function prootRun(script, timeoutMs) {
  return run([PROOT, script], timeoutMs);
}

function esc(s) { return JSON.stringify(String(s)); }

function wavFromPcm(pcm, sampleRate = 16000, channels = 1, bits = 16) {
  const byteRate = sampleRate * channels * bits / 8;
  const blockAlign = channels * bits / 8;
  const h = Buffer.alloc(44);
  h.write('RIFF', 0);
  h.writeUInt32LE(36 + pcm.length, 4);
  h.write('WAVE', 8);
  h.write('fmt ', 12);
  h.writeUInt32LE(16, 16);
  h.writeUInt16LE(1, 20);            // PCM
  h.writeUInt16LE(channels, 22);
  h.writeUInt32LE(sampleRate, 24);
  h.writeUInt32LE(byteRate, 28);
  h.writeUInt16LE(blockAlign, 32);
  h.writeUInt16LE(bits, 34);
  h.write('data', 36);
  h.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([h, pcm]);
}

// pcm_s16le 任意采样率 → 16k 单声道（线性插值，够识别人声）
function resample16k(pcm, sr) {
  if (sr === 16000) return pcm;
  const n = Math.floor(pcm.length / 2);
  const ratio = sr / 16000;
  const outN = Math.max(1, Math.floor(n / ratio));
  const out = Buffer.alloc(outN * 2);
  for (let i = 0; i < outN; i++) {
    const x = i * ratio, i0 = Math.floor(x);
    const i1 = Math.min(i0 + 1, n - 1), f = x - i0;
    const s0 = pcm.readInt16LE(i0 * 2), s1 = pcm.readInt16LE(i1 * 2);
    out.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round(s0 + (s1 - s0) * f))), i * 2);
  }
  return out;
}

// SILK 头对得上就用 silk-wasm 解：QQ 语音实际采样率 8k/16k/24k 都有，
// 挨个试，挑「解出来的时长最接近 SILK 头里声明时长」的那个，再重采样到 16k。
async function silkToWav16k(buf, wavHost) {
  const silk = silkLib();
  if (typeof silk.isSilk === 'function' && !silk.isSilk(buf)) throw new Error('SILK 头对不上');
  const dur = typeof silk.getDuration === 'function' ? silk.getDuration(buf) : 0;
  let best = null;
  for (const sr of [24000, 16000, 8000]) {
    try {
      const r = await silk.decode(buf, sr);
      if (!r || !r.data || !r.data.length) continue;
      const ms = r.data.length / 2 / sr * 1000;
      const err = dur ? Math.abs(ms - dur) : 0;
      if (!best || err < best.err) best = { data: r.data, sr, err, ms };
    } catch {}
  }
  if (!best) throw new Error('silk 解不出来');
  const pcm = resample16k(Buffer.from(best.data), best.sr);
  fs.writeFileSync(wavHost, wavFromPcm(pcm, 16000));
  return { durMs: Math.round(best.ms), sr: best.sr };
}

// 文件头判定：Tencent 的 SILK 常在前面多一个 0x02，所以在前 16 字节里找标记
function hasSilkHeader(buf) {
  if (!buf || buf.length < 9) return false;
  const head = buf.subarray(0, 16).toString('latin1');
  return head.includes('#!SILK_V3');
}

let _silk = null;
function silkLib() {
  if (_silk) return _silk;
  let lastErr = null;
  for (const m of SILK_MODULES) {
    try {
      if (!fs.existsSync(m)) continue;
      const require = createRequire(m);
      _silk = require(m);
      return _silk;
    } catch (e) { lastErr = e; }
  }
  throw new Error('silk-wasm 没找到: ' + (lastErr ? lastErr.message : SILK_MODULES.join(' | ')));
}

function resolveModel(cfg) {
  const m = String(cfg.sttModel || 'small');
  if (m.endsWith('.bin')) {
    // 直接给路径：host 路径原样用；proot 里 /root/... 路径反推 host
    if (fs.existsSync(m)) return { host: m, proot: m };
    const alt = '/data/local/tmp/qq/ubuntu' + m;
    if (fs.existsSync(alt)) return { host: alt, proot: m };
    return null;
  }
  for (const dir of MODEL_HOST_CANDIDATES) {
    const host = path.join(dir, `ggml-${m}.bin`);
    if (fs.existsSync(host)) {
      const proot = dir.startsWith('/data/local/tmp/qq/ubuntu')
        ? dir.slice('/data/local/tmp/qq/ubuntu'.length) + `/ggml-${m}.bin`
        : `${MODEL_DIR_PROOT}/ggml-${m}.bin`;
      return { host, proot };
    }
  }
  return null;
}

async function whisperAvailable() {
  const r = await prootRun(`test -x ${WHISPER_BIN} && echo ok`, 15000);
  return r.out.includes('ok');
}

async function sherpaAvailable() {
  const r = await prootRun(`test -x ${SHERPA_BIN} && test -f ${SHERPA_MODEL}/model.onnx && echo ok`, 15000);
  return r.out.includes('ok');
}

// ---------- 三步走 ----------

// 1) 任意语音 → 16k 单声道 wav（返回 host 路径）
export async function toWav(inputPath, cfg, tag = 'stt') {
  fs.mkdirSync(TMP_DIR, { recursive: true });
  const base = `${tag}-${Date.now()}-${process.pid}-${Math.random().toString(36).slice(2, 6)}`;
  const wavHost = path.join(TMP_DIR, base + '.wav');

  let buf;
  try { buf = fs.readFileSync(inputPath); } catch (e) { throw new Error('读不到语音文件: ' + inputPath); }

  if (hasSilkHeader(buf)) {
    const r = await silkToWav16k(buf, wavHost);
    return { wav: wavHost, durMs: r.durMs, via: 'silk' };
  }

  // 不是 SILK：ffmpeg 转 16k 单声道 WAV。
  // 2026-11-18 补：装了主机静态版 /data/local/tmp/bin/ffmpeg（proot 里没装 ffmpeg），
  // 非 SILK 的 m4a/mp3/转发语音不再直接哑掉。没有主机版才退回 proot。
  const HOST_FFMPEG = '/data/local/tmp/bin/ffmpeg';
  let r;
  if (fs.existsSync(HOST_FFMPEG)) {
    r = await run([HOST_FFMPEG, '-y', '-hide_banner', '-loglevel', 'error',
      '-i', inputPath, '-ar', '16000', '-ac', '1', '-f', 'wav', wavHost], cfg.sttTimeoutMs);
  } else {
    r = await prootRun(
      `ffmpeg -y -hide_banner -loglevel error -i ${esc(inputPath)} -ar 16000 -ac 1 -f wav ${esc(wavHost)} 2>&1`,
      cfg.sttTimeoutMs
    );
  }
  if (!fs.existsSync(wavHost) || fs.statSync(wavHost).size < 44) {
    throw new Error('ffmpeg 转 wav 失败: ' + (r.err || r.out || '').slice(-200));
  }
  return { wav: wavHost, durMs: 0, via: 'ffmpeg' };
}

// 2) 挑引擎：auto = whisper.cpp(本机) → sherpa(本机备胎) → openai(云端) → custom
async function pickEngine(cfg) {
  const want = String(cfg.sttEngine || 'auto').toLowerCase();
  if (want === 'auto') {
    if (resolveModel(cfg) && await whisperAvailable()) return 'whisper-cpp';
    if (await sherpaAvailable()) return 'sherpa';
    if (process.env.OPENAI_API_KEY) return 'openai';
    if (cfg.sttCommand) return 'custom';
    return null;
  }
  return want;
}

// 3) 跑引擎
export async function runEngine(engine, wavHost, cfg) {
  if (engine === 'whisper-cpp') {
    const model = resolveModel(cfg);
    if (!model) throw new Error(`找不到模型 ggml-${cfg.sttModel}.bin`);
    const lang = String(cfg.sttLanguage || 'zh');
    const threads = Number(cfg.sttThreads) || 6;
    // 加个简体中文的 prompt，不然 small 模型时不时吐繁体（实测用户的语音会）
    const prompt = String(cfg.sttPrompt || '').trim();
    const promptArg = prompt ? ` --prompt ${esc(prompt)}` : '';
    const r = await prootRun(
      `cd ${WHISPER_DIR} && LD_LIBRARY_PATH=${WHISPER_DIR} ./whisper-cli ` +
      `-m ${esc(model.proot)} -f ${esc(wavHost)} -l ${lang} -nt -t ${threads} -np${promptArg} 2>/dev/null`,
      cfg.sttTimeoutMs
    );
    if (r.killed) throw new Error(`whisper-cli 超时(${cfg.sttTimeoutMs}ms)`);
    if (!r.ok && !r.out.trim()) throw new Error('whisper-cli 失败: ' + (r.err || '').slice(-200));
    return cleanWhisper(r.out);
  }

  if (engine === 'sherpa') {
    const r = await prootRun(
      `${SHERPA_BIN} --tokens=${esc(SHERPA_MODEL + '/tokens.txt')} ` +
      `--sense-voice-model=${esc(SHERPA_MODEL + '/model.onnx')} ` +
      `--sense-voice-use-itn=true --num-threads=2 ${esc(wavHost)} 2>&1`,
      cfg.sttTimeoutMs
    );
    const all = r.out + '\n' + r.err;
    const m = all.match(/"text"\s*:\s*"([^"]*)"/);
    if (!m) throw new Error('sherpa 没出字: ' + all.replace(/\s+/g, ' ').slice(-200));
    const text = m[1]
      .replace(/<\|[^|]*\|>/g, '')      // SenseVoice 会带 <|zh|> 这类标签
      .replace(/<\/?[a-z]+>/gi, '')
      .replace(/\s+/g, ' ')
      .trim();
    if (!text) throw new Error('sherpa 转出来是空的');
    return text;
  }

  if (engine === 'openai') {
    const key = process.env.OPENAI_API_KEY;
    if (!key) throw new Error('没配 OPENAI_API_KEY');
    const fd = new FormData();
    fd.append('file', new Blob([fs.readFileSync(wavHost)], { type: 'audio/wav' }), 'a.wav');
    fd.append('model', 'whisper-1');
    if (cfg.sttLanguage) fd.append('language', String(cfg.sttLanguage));
    const r = await fetch('https://api.openai.com/v1/audio/transcriptions', {
      method: 'POST', headers: { Authorization: 'Bearer ' + key }, body: fd,
      signal: AbortSignal.timeout(cfg.sttTimeoutMs),
    });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error('openai 转写失败: ' + JSON.stringify(j).slice(0, 160));
    return String(j.text || '').trim();
  }

  if (engine === 'custom') {
    const tpl = String(cfg.sttCommand || '');
    if (!tpl) throw new Error('没配 sttCommand');
    const cmd = tpl.replace(/\{wav\}/g, esc(wavHost)).replace(/\{file\}/g, esc(wavHost));
    const r = await run(['/system/bin/sh', '-c', cmd], cfg.sttTimeoutMs);
    if (!r.ok && !r.out.trim()) throw new Error('自定义命令失败: ' + (r.err || '').slice(-200));
    return r.out.trim().split('\n').filter(Boolean).pop().trim();
  }

  throw new Error('未知引擎: ' + engine);
}

function cleanWhisper(out) {
  return String(out)
    .split('\n')
    .map(s => s.replace(/\[\d\d:\d\d[.:]\d\d[^\]]*\]/g, '').trim())   // 去掉时间戳
    .filter(s => s && !/^(whisper_|ggml_|system_info|main:|load_|encode:|decode:)/.test(s))
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim();
}

// ---------- 对外 ----------

/**
 * 转写一个语音文件。失败返回 ''，不抛异常（桥那头只关心有没有文字）。
 * @returns {{text:string, engine:string, via:string, ms:number, error?:string}}
 */
export async function transcribe(inputPath, opt = {}) {
  const t0 = Date.now();
  const cfg = { ...loadConfig(), ...opt };
  if (!cfg.sttEnabled) return { text: '', engine: '', via: '', ms: 0, error: 'sttEnabled=false' };
  if (!inputPath || !fs.existsSync(inputPath)) return { text: '', engine: '', via: '', ms: 0, error: '语音文件不存在' };

  let via = '', wav = '';
  try {
    const w = await toWav(inputPath, cfg);
    wav = w.wav; via = w.via;

    const engine = opt.engine || await pickEngine(cfg);
    if (!engine) return { text: '', engine: '', via, ms: Date.now() - t0, error: '没有可用引擎（whisper-cli/OPENAI/custom 都没配）' };

    // 主引擎挂了（比如长语音超时）自动退到备胎 sherpa，别让一句都转不出来
    const chain = [engine];
    if (!opt.engine && engine !== 'sherpa' && await sherpaAvailable()) chain.push('sherpa');

    let lastErr = '';
    for (const eng of chain) {
      try {
        const text = await runEngine(eng, wav, cfg);
        const ms = Date.now() - t0;
        log(`ok engine=${eng} via=${via} ${ms}ms "${String(text).slice(0, 40)}"`);
        return { text: String(text || '').trim(), engine: eng, via, ms };
      } catch (e) {
        lastErr = String(e && e.message || e).slice(0, 300);
        log(`engine=${eng} 失败: ${lastErr}`);
      }
    }
    return { text: '', engine: engine, via, ms: Date.now() - t0, error: lastErr || '引擎都没出字' };
  } catch (e) {
    const msg = String(e && e.message || e).slice(0, 300);
    log('fail', msg);
    return { text: '', engine: '', via, ms: Date.now() - t0, error: msg };
  } finally {
    try { if (wav) fs.unlinkSync(wav); } catch {}
  }
}

// 命令行自测：node stt.mjs /path/to/voice.amr
if (process.argv[1] && process.argv[1].endsWith('stt.mjs')) {
  const f = process.argv[2];
  if (!f) { console.log('用法: node stt.mjs <语音文件>'); process.exit(1); }
  transcribe(f).then(r => {
    console.log(JSON.stringify(r, null, 2));
    process.exit(r.text ? 0 : 1);
  });
}

export default { transcribe, toWav, runEngine, loadConfig };
