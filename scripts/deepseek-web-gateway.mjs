/*
 * deepseek-web-gateway.mjs
 * DeepSeek 网页版 → OpenAI 兼容 API 本地网关(零依赖,Node 18+)
 *
 * 完整协议(2026-08 实测自 deepseek-free-api 等开源实现):
 *   1. 登录   POST /api/v0/users/login
 *             body: {email, password, mobile:"", area_code:"", device_id:<32hex>, os:"web"}
 *             需要头 x-client-version: 2.0.2, x-client-platform: web
 *             token 在 data.biz_data.user.token
 *   2. 会话   POST /api/v0/chat_session/create → data.biz_data.chat_session.id
 *   3. PoW    POST /api/v0/chat/create_pow_challenge {target_path}
 *             解 sha3-256 挑战,base64 结果作为头 x-ds-pow-response
 *   4. 聊天   POST /api/v0/chat/completion
 *             body: {chat_session_id, parent_message_id:null, prompt:<多轮标记文本>,
 *                    ref_file_ids:[], thinking_enabled, search_enabled:false, model_type}
 *
 * 多账号:配置文件 gateway-credentials.json 支持单个账号或账号数组,
 *         请求按顺序轮换使用;某账号登录失败会自动尝试下一个。
 *
 * 免责声明:
 *  - 这不是 DeepSeek 官方 API,网页版接口随时可能变更或加风控。
 *  - 请只使用你本人合法注册、拥有使用权的账号。
 *  - 仅供个人学习/实验,请勿用于生产或高并发场景。
 */

import { createServer } from 'node:http';
import http from 'node:http';
import https from 'node:https';
import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash, randomBytes } from 'node:crypto';
import { buildToolPrompt, formatToolCallsForPrompt, parseToolCalls, cleanToolText, StreamSieve } from './tool-support.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));

// ─── 配置 ────────────────────────────────────────────────────────────────
const HOST = '127.0.0.1';
const PORT = Number(process.env.GATEWAY_PORT || 8787);
const DS_BASE = process.env.DEEPSEEK_WEB_BASE || 'https://chat.deepseek.com';
const CRED_FILE = join(__dirname, 'gateway-credentials.json');

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/134.0.0.0 Safari/537.36';
const CLIENT_VERSION = '2.0.2';
const CLIENT_PLATFORM = 'web';

// ─── 拟人化风控配置(均可用环境变量覆盖)──────────────────────────────
// 请求间随机延迟(毫秒):模拟真人两次提问之间的间隔
const HUMAN_DELAY_MIN = Number(process.env.HUMAN_DELAY_MIN ?? 1000);   // 最小 1 秒
const HUMAN_DELAY_MAX = Number(process.env.HUMAN_DELAY_MAX ?? 4000);   // 最大 4 秒
// 流式输出块间延迟(毫秒):模拟打字速度,数字越小输出越快
const STREAM_PAUSE_MIN = Number(process.env.STREAM_PAUSE_MIN ?? 60);   // 60ms
const STREAM_PAUSE_MAX = Number(process.env.STREAM_PAUSE_MAX ?? 220);  // 220ms
// 同一账号两次请求的最小冷却(毫秒):冷却期内换用其他账号
const ACCOUNT_COOLDOWN_MS = Number(process.env.ACCOUNT_COOLDOWN_MS ?? 15000); // 15 秒
// 是否启用拟人化(设为 0 可关闭,用于调试)
const HUMANIZE_ENABLED = (process.env.HUMANIZE ?? '1') !== '0';

const lastUseAt = new Map();          // email -> 该账号上次被使用的时刻
let lastGlobalRequestAt = 0;          // 全局上次请求时刻

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const randInt = (min, max) => Math.floor(min + Math.random() * (max - min + 1));

// 请求间随机延迟(只作用于聊天请求,健康检查等不受影响)
async function humanRequestDelay() {
  if (!HUMANIZE_ENABLED) return;
  const now = Date.now();
  if (lastGlobalRequestAt > 0) {
    const wait = lastGlobalRequestAt + randInt(HUMAN_DELAY_MIN, HUMAN_DELAY_MAX) - now;
    if (wait > 0) await sleep(wait);
  }
  lastGlobalRequestAt = Date.now();
}

// 流式输出块间小停顿
async function humanStreamPause() {
  if (!HUMANIZE_ENABLED) return;
  await sleep(randInt(STREAM_PAUSE_MIN, STREAM_PAUSE_MAX));
}

// 模型名映射:OpenAI 名 → 网页版内部名
const MODEL_MAP = {
  'deepseek-chat': 'deepseek_chat',
  'deepseek-reasoner': 'deepseek_reasoner',
  'deepseek-reasoner-v3': 'deepseek_reasoner',
  'deepseek-chat-v3': 'deepseek_chat',
};

// ─── 登录态缓存(多账号轮换)────────────────────────────────────────────
let accounts = [];                    // [{email, password}, ...]
let rotationIndex = 0;                // 下一个优先使用的账号下标
const sessions = new Map();           // email -> { token, expiresAt, sessionId }
const mutedUntil = new Map();         // email -> 禁言到期时间戳(ms),过期自动解除
let loginInFlight = null;

// 账号级错误(禁言等),触发自动换号
class AccountError extends Error {
  constructor(message, email) {
    super(message);
    this.name = 'AccountError';
    this.accountEmail = email;
  }
}

function log(level, msg, extra = '') {
  const ts = new Date().toISOString().replace('T', ' ').slice(0, 19);
  console.log(`[${ts}] [${level}] ${msg}${extra ? ' ' + extra : ''}`);
}

// 账号来源:环境变量(单账号)> 配置文件(单对象或数组)
async function loadAccounts() {
  const envEmail = process.env.DEEPSEEK_WEB_EMAIL;
  const envPass = process.env.DEEPSEEK_WEB_PASSWORD;
  if (envEmail && envPass) return [{ email: envEmail, password: envPass }];
  if (existsSync(CRED_FILE)) {
    try {
      const raw = await readFile(CRED_FILE, 'utf8');
      const cfg = JSON.parse(raw);
      const list = Array.isArray(cfg) ? cfg : [cfg];
      return list.filter((a) => a && a.email && a.password);
    } catch (e) {
      log('WARN', `读取 ${CRED_FILE} 失败: ${e.message}`);
    }
  }
  return [];
}

// ─── WAF cookie 管理(网页版要求同一 cookie 会话完成挑战与聊天)──────────
let cookieStr = '';
function collectCookies(res) {
  let sc = [];
  try {
    if (typeof res.headers.getSetCookie === 'function') {
      sc = res.headers.getSetCookie();
    } else if (res.headers['set-cookie']) {
      sc = Array.isArray(res.headers['set-cookie']) ? res.headers['set-cookie'] : [res.headers['set-cookie']];
    }
  } catch { sc = []; }
  for (const c of sc) {
    const pair = c.split(';')[0];
    if (!pair) continue;
    const name = pair.split('=')[0];
    cookieStr = cookieStr.split(';').filter((p) => !p.trim().startsWith(name + '=')).join(';');
    cookieStr = (cookieStr ? cookieStr + '; ' : '') + pair;
  }
}

// 用 node:http/https 发送 POST(每次新连接,避免 undici 连接池被 WAF 标记)
function postStream(urlStr, headers, body, timeoutMs) {
  return new Promise((resolve, reject) => {
    const u = new URL(urlStr);
    const lib = u.protocol === 'https:' ? https : http;
    const req = lib.request({
      hostname: u.hostname,
      port: u.port || (u.protocol === 'https:' ? 443 : 80),
      path: u.pathname + u.search,
      method: 'POST',
      headers,
    }, (res) => resolve(res));
    req.setTimeout(timeoutMs, () => req.destroy(new Error('请求超时')));
    req.on('error', (e) => reject(e));
    req.end(body);
  });
}

async function collectBody(res) {
  const chunks = [];
  for await (const c of res) chunks.push(c);
  return Buffer.concat(chunks).toString('utf8');
}
async function ensureCookies() {
  if (cookieStr) return;
  try {
    const res = await fetch(`${DS_BASE}/`, { headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(15000) });
    collectCookies(res);
    log('INFO', `已获取 WAF cookie(${cookieStr.split(';').length} 项)`);
  } catch (e) {
    log('WARN', `获取首页 cookie 失败(继续尝试): ${e.message}`);
  }
}

function baseHeaders(extra = {}) {
  return {
    'Content-Type': 'application/json',
    'Origin': DS_BASE,
    'Referer': `${DS_BASE}/`,
    'User-Agent': UA,
    'x-client-version': CLIENT_VERSION,
    'x-client-platform': CLIENT_PLATFORM,
    ...(cookieStr ? { Cookie: cookieStr } : {}),
    ...extra,
  };
}

async function readJson(res) {
  collectCookies(res);
  const text = await res.text();
  try { return { json: JSON.parse(text), text }; } catch { return { json: null, text }; }
}

// 登录单个账号,返回 { token, expiresAt }
async function doLogin(account) {
  log('INFO', `正在登录 ${account.email} ...`);
  await ensureCookies();
  const deviceId = randomBytes(16).toString('hex');
  const payload = {
    email: account.email,
    password: account.password,
    mobile: '',
    area_code: '',
    device_id: deviceId,
    os: 'web',
  };

  const res = await fetch(`${DS_BASE}/api/v0/users/login`, {
    method: 'POST',
    headers: baseHeaders(),
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(25000),
  });

  // WAF 拦截(202 + x-amzn-waf-action)
  if (res.status === 202 && res.headers.get('x-amzn-waf-action')) {
    throw new Error('登录被 AWS WAF 拦截(HTTP 202),IP 触发了人机验证,请稍后再试或换网络');
  }

  const { json, text } = await readJson(res);
  if (!res.ok || !json) {
    throw new Error(`登录失败 HTTP ${res.status}: ${text.slice(0, 300)}`);
  }
  const biz = json.data?.biz_data || {};
  // 兼容新旧字段
  const token = biz.user?.token || biz.token || json.data?.token || json.data?.user_token;
  if (!token) {
    const msg = biz.biz_msg || json.msg || text.slice(0, 200);
    throw new Error(`登录失败: ${msg}`);
  }
  log('SUCCESS', `登录成功 ${account.email}`);
  return { token, expiresAt: Date.now() + 30 * 60 * 1000 };
}

// 创建聊天会话,返回 session_id(失败返回空串)
async function createSession(token) {
  try {
    const res = await fetch(`${DS_BASE}/api/v0/chat_session/create`, {
      method: 'POST',
      headers: baseHeaders({ Authorization: `Bearer ${token}` }),
      body: JSON.stringify({}),
      signal: AbortSignal.timeout(15000),
    });
    const { json } = await readJson(res);
    const biz = json?.data?.biz_data || {};
    const sid = biz.chat_session?.id || biz.id || '';
    if (sid) log('INFO', `会话创建成功 id=${sid.slice(0, 8)}...`);
    return sid;
  } catch (e) {
    log('WARN', `创建会话失败(继续尝试): ${e.message}`);
    return '';
  }
}

// ─── WASM PoW 求解(官方算法,与网页版校验一致)────────────────────────────
let wasmInstance = null;

async function initWasm() {
  if (wasmInstance) return wasmInstance;
  const wasmPath = join(__dirname, 'sha3_wasm_bg.wasm');
  const wasmBuffer = await readFile(wasmPath);
  const module = await WebAssembly.compile(wasmBuffer);
  wasmInstance = await WebAssembly.instantiate(module, {});
  log('INFO', 'WASM PoW 求解器加载成功');
  return wasmInstance;
}

// 解挑战,返回 answer 整数;无解返回 null
async function wasmSolve(challenge) {
  const instance = await initWasm();
  const mem = instance.exports.memory;
  const writeString = (str) => {
    const encoded = Buffer.from(str, 'utf-8');
    const ptr = instance.exports.__wbindgen_export_0(encoded.length, 1);
    const view = new Uint8Array(mem.buffer);
    for (let i = 0; i < encoded.length; i++) view[ptr + i] = encoded[i];
    return { ptr, length: encoded.length };
  };
  const prefix = `${challenge.salt}_${challenge.expire_at}_`;
  const retptr = instance.exports.__wbindgen_add_to_stack_pointer(-16);
  try {
    const chInfo = writeString(challenge.challenge);
    const pfInfo = writeString(prefix);
    instance.exports.wasm_solve(retptr, chInfo.ptr, chInfo.length, pfInfo.ptr, pfInfo.length, challenge.difficulty);
    const view = new Int32Array(mem.buffer);
    const status = view[retptr / 4];
    if (status === 0) return null;
    const floatView = new Float64Array(mem.buffer);
    return Math.floor(floatView[(retptr + 8) / 8]);
  } finally {
    instance.exports.__wbindgen_add_to_stack_pointer(16);
  }
}

// 求解 PoW 挑战,返回 x-ds-pow-response 头值(失败返回 null)
async function solvePow(token, sessionId, targetPath = '/api/v0/chat/completion') {
  try {
    const headers = baseHeaders({
      Authorization: `Bearer ${token}`,
      Referer: sessionId ? `${DS_BASE}/a/chat/s/${sessionId}` : `${DS_BASE}/`,
    });
    const res = await fetch(`${DS_BASE}/api/v0/chat/create_pow_challenge`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ target_path: targetPath }),
      signal: AbortSignal.timeout(15000),
    });
    const { json } = await readJson(res);
    const challenge = json?.data?.biz_data?.challenge;
    if (!challenge || !challenge.challenge || !challenge.salt || !challenge.difficulty) {
      log('INFO', '无 PoW 挑战(可能已放宽)');
      return null;
    }
    const start = Date.now();
    const answer = await wasmSolve(challenge);
    if (answer === null) {
      log('WARN', 'PoW 无解');
      return null;
    }
    log('INFO', `PoW 解出 answer=${answer}(用时 ${Date.now() - start}ms)`);
    const resp = Buffer.from(JSON.stringify({
      algorithm: challenge.algorithm,
      challenge: challenge.challenge,
      salt: challenge.salt,
      answer,
      signature: challenge.signature,
      target_path: challenge.target_path,
    })).toString('base64');
    return resp;
  } catch (e) {
    log('WARN', `PoW 获取失败(继续尝试): ${e.message}`);
    return null;
  }
}

// 获取一个可用 token + sessionId:按顺序轮换,账号失败自动跳过
async function getReadySession() {
  if (accounts.length === 0) {
    accounts = await loadAccounts();
    if (accounts.length === 0) {
      throw new Error('未配置账号:请填写 gateway-credentials.json 或设置 DEEPSEEK_WEB_EMAIL / DEEPSEEK_WEB_PASSWORD');
    }
    log('INFO', `加载到 ${accounts.length} 个账号,开始轮换使用`);
  }
  if (loginInFlight) return loginInFlight;
  loginInFlight = (async () => {
    const n = accounts.length;
    for (let i = 0; i < n; i++) {
      const acc = accounts[(rotationIndex + i) % n];
      // 跳过仍在禁言期内的账号
      const muteUntil = mutedUntil.get(acc.email) || 0;
      if (muteUntil > Date.now()) {
        log('INFO', `账号 ${acc.email} 禁言中,跳过`);
        continue;
      }
      if (muteUntil > 0 && muteUntil <= Date.now()) mutedUntil.delete(acc.email);
      // 拟人化:跳过冷却期内的账号(同一账号不能连续用太频繁)
      const lastUse = lastUseAt.get(acc.email) || 0;
      if (HUMANIZE_ENABLED && lastUse > 0 && Date.now() - lastUse < ACCOUNT_COOLDOWN_MS) {
        continue;
      }
      const cached = sessions.get(acc.email);
      if (cached && Date.now() < cached.expiresAt) {
        lastUseAt.set(acc.email, Date.now());
        rotationIndex = (rotationIndex + i + 1) % n;
        return cached;
      }
      try {
        const s = await doLogin(acc);
        const sid = await createSession(s.token);
        const ready = { ...s, sessionId: sid };
        sessions.set(acc.email, ready);
        lastUseAt.set(acc.email, Date.now());
        rotationIndex = (rotationIndex + i + 1) % n;
        return ready;
      } catch (e) {
        log('ERROR', `账号 ${acc.email} 登录失败: ${e.message}`);
        continue;
      }
    }
    throw new Error('所有账号当前均不可用(禁言/冷却中/登录失败),请稍后再试');
  })();
  try {
    return await loginInFlight;
  } finally {
    loginInFlight = null;
  }
}

// ─── 多轮消息 → DeepSeek 原生标记 prompt(支持工具调用)────────────────────
const BOS = '<｜begin▁of▁sentence｜>';
const SYS = '<｜System｜>';
const USER = '<｜User｜>';
const ASST = '<｜Assistant｜>';
const TOOL = '<｜Tool｜>';
const EOS = '<｜end▁of▁sentence｜>';
const SYS_END = '<｜end▁of▁instructions｜>';
const TOOL_END = '<｜end▁of▁toolresults｜>';

function convertMessages(msgs, tools) {
  const parts = [BOS];
  let hasSystem = false;
  for (const m of msgs || []) {
    const role = m.role;
    let content = m.content;
    if (Array.isArray(content)) {
      content = content.filter((p) => p?.type === 'text').map((p) => p.text).join(' ');
    }
    if (role === 'system') {
      hasSystem = true;
      let text = content || '';
      if (tools && tools.length) {
        const tp = buildToolPrompt(tools);
        if (tp) text = text.trim() ? text + '\n\n' + tp : tp;
      }
      if (text.trim()) parts.push(SYS + text + SYS_END);
    } else if (role === 'user') {
      parts.push(USER + (typeof content === 'string' ? content : ''));
    } else if (role === 'assistant') {
      const segs = [];
      if (content && String(content).trim()) segs.push(String(content).trim());
      if (m.tool_calls) {
        const dsml = formatToolCallsForPrompt(m.tool_calls);
        if (dsml) segs.push(dsml);
      }
      if (segs.length) parts.push(ASST + segs.join('\n\n') + EOS);
    } else if (role === 'tool') {
      let result = String(content ?? '');
      if (result) {
        try {
          const rd = JSON.parse(result);
          if (rd && typeof rd === 'object') {
            const extracted = [];
            for (const k of ['output', 'error', 'result', 'content']) {
              const v = rd[k];
              if (v !== null && v !== undefined && String(v).trim()) extracted.push(String(v).trim());
            }
            if (extracted.length) result = extracted.join('\n');
          }
        } catch { /* keep raw */ }
        parts.push(TOOL + result.slice(0, 2000) + TOOL_END);
      }
    }
  }
  // 没有 system 消息但有工具:把工具说明作为 system 插入
  if (tools && tools.length && !hasSystem) {
    const tp = buildToolPrompt(tools);
    if (tp) parts.splice(1, 0, SYS + tp + SYS_END);
  }
  return parts.join('');
}

// 提取工具名列表
function getToolNames(tools) {
  const names = [];
  for (const tool of tools || []) {
    const fn = tool.function || tool;
    const name = fn.name || tool.name;
    if (name) names.push(String(name));
  }
  return names;
}

// ─── 网页版流式聊天(支持工具调用)────────────────────────────────────────
async function* streamChat(messages, model, signal, tools) {
  const s = await getReadySession();
  const tk = s.token;
  const sid = s.sessionId;
  const isReasoner = /reasoner/.test(model);
  const pow = await solvePow(tk, sid);

  const headers = baseHeaders({
    Authorization: `Bearer ${tk}`,
    Referer: sid ? `${DS_BASE}/a/chat/s/${sid}` : `${DS_BASE}/`,
  });
  if (pow) headers['x-ds-pow-response'] = pow;

  const body = {
    chat_session_id: sid,
    parent_message_id: null,
    prompt: convertMessages(messages, tools),
    ref_file_ids: [],
    thinking_enabled: isReasoner,
    search_enabled: false,
    model_type: 'default',
  };

  // 用 node:http 发送(新连接),避免 undici 连接池问题
  const res = await postStream(`${DS_BASE}/api/v0/chat/completion`, headers, JSON.stringify(body), 120000);
  collectCookies(res);

  if (res.statusCode === 401) {
    // token 过期:清掉缓存,让下一次请求重新登录
    sessions.delete(findEmailByToken(tk));
    throw new Error('token 已过期,请重试');
  }
  if (res.statusCode !== 200) {
    const errText = await collectBody(res).catch(() => '');
    log('ERROR', `聊天 HTTP ${res.statusCode}: ${errText.slice(0, 300)}`);
    throw new Error(`网页版接口 HTTP ${res.statusCode}: ${errText.slice(0, 300)}`);
  }

  const ct = (res.headers['content-type'] || '').toLowerCase();
  // 非流式 JSON 响应:可能是错误/禁言/风控
  if (ct.includes('application/json') && !ct.includes('text/event-stream')) {
    const text = await collectBody(res).catch(() => '');
    let j = null;
    try { j = JSON.parse(text); } catch { /* ignore */ }
    const biz = j?.data || {};
    const bizMsg = biz.biz_msg || j?.msg || '';
    // 禁言
    if (bizMsg.includes('muted') || biz.biz_code === 5) {
      const until = (biz.biz_data?.mute_until || 0) * 1000;
      mutedUntil.set(findEmailByToken(tk), until || (Date.now() + 30 * 60 * 1000));
      log('ERROR', `账号 ${findEmailByToken(tk)} 被禁言,已标记跳过`);
      throw new AccountError(`账号被禁言: ${bizMsg}`, findEmailByToken(tk));
    }
    throw new Error(`网页版接口返回: ${text.slice(0, 300)}`);
  }
  if (!ct.includes('text/event-stream') && !ct.includes('application/json')) {
    throw new Error(`网页版返回非流式内容(Content-Type: ${ct}),可能被风控拦截`);
  }

  const decoder = new TextDecoder();
  let buf = '';
  let fragmentType = null; // 'THINK' | 'RESPONSE' | null(旧格式)
  const toolNames = getToolNames(tools);
  const sieve = new StreamSieve(toolNames, tools);

  // 把文本喂给筛分器,输出筛分后的事件(text / toolCalls)
  function* feedText(textChunk) {
    for (const ev of sieve.feed(textChunk)) {
      if (ev.type === 'text') yield { type: 'text', text: ev.text };
      else if (ev.type === 'toolCalls') yield { type: 'toolCalls', calls: ev.calls };
    }
  }

  for await (const chunk of res) {
    buf += decoder.decode(chunk, { stream: true });

    let idx;
    while ((idx = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, idx).trim();
      buf = buf.slice(idx + 1);
      if (!line.startsWith('data:')) continue;
      const payload = line.slice(5).trim();
      if (payload === '[DONE]') break;
      let evt;
      try { evt = JSON.parse(payload); } catch { continue; }
      const obj = evt;
      // 新格式:{"p":"response/fragments","o":"APPEND","v":[...]} 等
      const p = obj.p || '';
      const val = obj.v;
      if (p === 'response/fragments' && Array.isArray(val) && val.length) {
        const frag = val[val.length - 1];
        if (frag?.type) fragmentType = frag.type;
        const fc = frag?.content;
        if (typeof fc === 'string' && fc) {
          if (fragmentType === 'THINK') yield { type: 'reasoning', text: fc };
          else yield* feedText(fc);
        }
        continue;
      }
      if (p === 'response/fragments/-1/content') {
        if (typeof val === 'string' && val) {
          if (fragmentType === 'THINK') yield { type: 'reasoning', text: val };
          else yield* feedText(val);
        }
        continue;
      }
      // 旧格式
      if (p === 'response/content') {
        if (typeof val === 'string' && val) yield* feedText(val);
        continue;
      }
      if (p === 'response/thinking_content') {
        if (typeof val === 'string' && val) yield { type: 'reasoning', text: val };
        continue;
      }
      // 无路径的纯内容行
      if (!p && typeof val === 'string' && val) {
        if (fragmentType === 'THINK') yield { type: 'reasoning', text: val };
        else yield* feedText(val);
      }
    }
  }
  // 流结束:flush 残留文本/工具块
  for (const ev of sieve.flush()) {
    if (ev.type === 'text') yield { type: 'text', text: ev.text };
    else if (ev.type === 'toolCalls') yield { type: 'toolCalls', calls: ev.calls };
  }
}

function findEmailByToken(tk) {
  for (const [email, s] of sessions) {
    if (s.token === tk) return email;
  }
  return null;
}

// ─── OpenAI 兼容层 ───────────────────────────────────────────────────────
function sendJson(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Content-Length': Buffer.byteLength(body),
    'Access-Control-Allow-Origin': '*',
  });
  res.end(body);
}

function openaiError(status, message, type = 'api_error') {
  return { error: { message, type, param: null, code: null } };
}

async function handleChatCompletions(req, res) {
  let raw = '';
  for await (const chunk of req) raw += chunk.toString();
  let body;
  try {
    body = JSON.parse(raw || '{}');
  } catch {
    return sendJson(res, 400, openaiError(400, '请求体不是合法 JSON', 'invalid_request_error'));
  }

  const model = typeof body.model === 'string' && body.model ? body.model : 'deepseek-chat';
  const wantStream = !!body.stream;
  const messages = (body.messages || []).filter((m) => m && (typeof m.content === 'string' || Array.isArray(m.content)));
  const tools = Array.isArray(body.tools) ? body.tools : undefined;
  if (messages.length === 0) {
    return sendJson(res, 400, openaiError(400, 'messages 不能为空', 'invalid_request_error'));
  }

  const created = Math.floor(Date.now() / 1000);
  const id = `chatcmpl-${Date.now()}`;

  try {
    // 拟人化:请求间随机延迟,避免机器式爆发请求触发风控
    await humanRequestDelay();

    // 自动换号重试:账号被禁言/不可用时换下一个账号,最多尝试全部账号
    const maxAttempts = Math.max(accounts.length || 10, 1);
    for (let attempt = 0; ; attempt++) {
      let streamStarted = false;
      try {
        const gen = streamChat(messages, model, req.signal, tools);

        if (wantStream) {
          res.writeHead(200, {
            'Content-Type': 'text/event-stream; charset=utf-8',
            'Cache-Control': 'no-cache',
            'Connection': 'keep-alive',
            'Access-Control-Allow-Origin': '*',
            'X-Accel-Buffering': 'no',
          });
          streamStarted = true;
          const send = (obj) => res.write(`data: ${JSON.stringify(obj)}\n\n`);
          let toolIndex = 0;
          for await (const evt of gen) {
            if (evt.type === 'text') {
              send({ id, object: 'chat.completion.chunk', created, model, choices: [{ index: 0, delta: { content: evt.text }, finish_reason: null }] });
              await humanStreamPause();
            } else if (evt.type === 'reasoning') {
              send({ id, object: 'chat.completion.chunk', created, model, choices: [{ index: 0, delta: { reasoning_content: evt.text }, finish_reason: null }] });
              await humanStreamPause();
            } else if (evt.type === 'toolCalls') {
              // 输出 OpenAI 流式 tool_calls delta
              for (const tc of evt.calls) {
                const fn = tc.function || {};
                send({
                  id, object: 'chat.completion.chunk', created, model,
                  choices: [{ index: 0, delta: { tool_calls: [{ index: toolIndex++, id: tc.id, type: 'function', function: { name: fn.name, arguments: fn.arguments || '' } }] }, finish_reason: null }],
                });
              }
            }
          }
          send({ id, object: 'chat.completion.chunk', created, model, choices: [{ index: 0, delta: {}, finish_reason: toolIndex > 0 ? 'tool_calls' : 'stop' }] });
          res.write('data: [DONE]\n\n');
          res.end();
        } else {
          let content = '';
          const toolCalls = [];
          for await (const evt of gen) {
            if (evt.type === 'text') content += evt.text;
            else if (evt.type === 'toolCalls') toolCalls.push(...evt.calls);
          }
          const msg = { role: 'assistant', content };
          if (toolCalls.length) msg.tool_calls = toolCalls;
          sendJson(res, 200, {
            id, object: 'chat.completion', created, model,
            choices: [{ index: 0, message: msg, finish_reason: toolCalls.length ? 'tool_calls' : 'stop' }],
            usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
          });
        }
        return;
      } catch (e) {
        if (e instanceof AccountError && !streamStarted && attempt + 1 < maxAttempts) {
          log('WARN', `账号 ${e.accountEmail} 被禁言,自动换号重试(${attempt + 1}/${maxAttempts})`);
          continue;
        }
        throw e;
      }
    }
  } catch (e) {
    log('ERROR', `请求失败: ${e.message} (${e.name}) ${e.stack ? '| ' + e.stack.split('\n').slice(0, 4).join(' | ') : ''}`);
    if (!res.headersSent) {
      return sendJson(res, 502, openaiError(502, `网关错误: ${e.message}`));
    }
    try { res.end(); } catch { /* ignore */ }
  }
}

// ─── HTTP 服务器 ─────────────────────────────────────────────────────────
const server = createServer(async (req, res) => {
  const u = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const path = u.pathname;

  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'POST, GET, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    });
    return res.end();
  }

  try {
    if (req.method === 'GET' && path === '/health') {
      const accs = await loadAccounts();
      return sendJson(res, 200, { status: 'ok', accountCount: accs.length, tokenReady: sessions.size > 0 });
    }

    if (req.method === 'GET' && path === '/v1/models') {
      return sendJson(res, 200, {
        object: 'list',
        data: [
          { id: 'deepseek-chat', object: 'model', owned_by: 'deepseek-web' },
          { id: 'deepseek-reasoner', object: 'model', owned_by: 'deepseek-web' },
        ],
      });
    }

    if (req.method === 'POST' && path === '/v1/chat/completions') {
      return handleChatCompletions(req, res);
    }

    return sendJson(res, 404, openaiError(404, `Not Found: ${path}`, 'invalid_request_error'));
  } catch (e) {
    log('ERROR', `未处理异常: ${e.message}`);
    if (!res.headersSent) return sendJson(res, 500, openaiError(500, e.message));
    try { res.end(); } catch { /* ignore */ }
  }
});

server.listen(PORT, HOST, () => {
  log('INFO', `✅ DeepSeek 网页版网关已启动(多账号轮换版 · 协议 2026-08)`);
  log('INFO', `   本地 OpenAI 兼容端点: http://${HOST}:${PORT}/v1/chat/completions`);
  log('INFO', `   模型列表: deepseek-chat, deepseek-reasoner`);
  log('INFO', `   账号来源: 环境变量 DEEPSEEK_WEB_EMAIL/DEEPSEEK_WEB_PASSWORD 或 ${CRED_FILE}(支持多账号数组)`);
});
