/**
 * ============================================================
 *  NodeSeek 每日签到
 *  ------------------------------------------------------------------
 *  功能   : 自动签到领鸡腿、查询余额、多账号、可抓 Cookie
 *  平台   : Loon / Surge / Stash / Quantumult X / Egern / Shadowrocket
 *  维护   : mosen[https://github.com/mosenwoek],moyan[https://t.me/tgxiaoxizf_bot]
 *
 *  抓取方式（首次使用）:
 *    1. 打开 Loon 插件里的「NodeSeek抓Cookie」开关
 *    2. 浏览器/App 打开 nodeseek.com → 点自己的头像进个人名片（会触发 getInfo 请求）
 *    3. 弹「账号已入库」即成功，之后可关掉抓取开关
 *    4. 多账号：退出登录 → 登录下一个号 → 再点一次头像
 *
 *  签到触发: cron 每天 08:30（时间在插件里改）
 * ============================================================
 */

const NAME = 'NodeSeek';
const KEY_ACCOUNTS = 'nodeseek_accounts_v1';

// ======================= 平台适配层 =======================
const isQuanX = typeof $task !== 'undefined';
const isLoon = typeof $loon !== 'undefined';
const isSurge = typeof $httpClient !== 'undefined' && !isLoon;
const isNode = typeof module !== 'undefined' && module.exports && typeof $httpClient === 'undefined';

// 插件参数（Loon/Surge [Argument] / QX 未提供时走 BoxJS）
const ARG = (() => {
  try {
    if (typeof $argument === 'string' && $argument.trim()) return JSON.parse($argument);
    if (typeof $argument === 'object' && $argument) return $argument;
  } catch (e) { /* 参数解析失败按空处理 */ }
  return {};
})();

function storeGet(key) {
  if (isNode) return process.env[key] ?? null;
  if (isQuanX) return $prefs.valueForKey(key) ?? null;
  return $persistentStore.read(key) ?? null;
}

function storeSet(value, key) {
  if (isNode) { process.env[key] = value; return true; }
  if (isQuanX) return $prefs.setValueForKey(value, key);
  return $persistentStore.write(value, key);
}

function truthy(v) {
  if (v === undefined || v === null) return false;
  if (typeof v === 'boolean') return v;
  const s = String(v).trim().toLowerCase();
  return s === 'true' || s === '1' || s === 'on' || s === 'yes';
}

// ======================= 配置读取 =======================
function pick(argName, storeKey, dflt) {
  if (ARG[argName] !== undefined && ARG[argName] !== '') return ARG[argName];
  const v = storeGet(storeKey);
  return v === null || v === '' ? dflt : v;
}

const CFG = {
  checkin:  truthy(pick('enable_checkin',  'nodeseek_checkin',  'true')),
  capture:  truthy(pick('enable_capture',  'nodeseek_capture',  'false')),
  random:   truthy(pick('random_gift',     'nodeseek_random',   'false')),
  notify:   truthy(pick('enable_notify',   'nodeseek_notify',   'true')),
  debug:    truthy(pick('enable_debug',    'nodeseek_debug',    'false')),
  clear:    truthy(storeGet('nodeseek_clear')),
};

const BASE = 'https://www.nodeseek.com';

function log(...args) {
  console.log(args.join(' ').trim());
}

function debug(...args) {
  if (CFG.debug) console.log('[debug]', ...args);
}

// ======================= 存储：账号库 =======================
function loadAccounts() {
  const raw = storeGet(KEY_ACCOUNTS);
  if (!raw) return [];
  try {
    const data = JSON.parse(raw);
    const list = Array.isArray(data) ? data : (Array.isArray(data.accounts) ? data.accounts : []);
    return list.filter(a => a && a.memberId && a.cookie);
  } catch (e) {
    log('⚠️ 账号库解析失败，已按空处理:', e.message);
    return [];
  }
}

function saveAccounts(list) {
  storeSet(JSON.stringify(list), KEY_ACCOUNTS);
}

// ======================= HTTP =======================
function timeoutValue() {
  // QX / Loon 用毫秒；Surge / Stash / Shadowrocket / Egern 用秒
  return (isQuanX || isLoon) ? 15000 : 15;
}

function request({ url, method = 'GET', headers = {}, body = null }) {
  const opt = { url, headers, timeout: timeoutValue() };
  if (body !== null && body !== undefined) opt.body = body;
  const timeoutMs = (isQuanX || isLoon) ? opt.timeout : opt.timeout * 1000;

  const runner = isQuanX
    ? (method === 'POST' ? $task.fetch({ ...opt, method: 'POST' }) : $task.fetch(opt))
    : new Promise((resolve, reject) => {
        const cb = (err, resp, data) => {
          if (err) return reject(new Error(String(err)));
          resolve({ status: resp.status || resp.statusCode, headers: resp.headers, body: data });
        };
        if (method === 'POST') $httpClient.post(opt, cb);
        else $httpClient.get(opt, cb);
      });

  const guard = new Promise((_, reject) =>
    setTimeout(() => reject(new Error('请求超时')), timeoutMs + 2000));

  return Promise.race([runner, guard]).then(res => {
    if (res && typeof res.body === 'string') {
      try { res.json = JSON.parse(res.body); } catch (e) { res.json = null; }
    } else if (res && !res.body && res.json === undefined) {
      res.json = null;
    }
    return res;
  });
}

function apiHeaders(cookie) {
  return {
    'accept': '*/*',
    'accept-language': 'zh-CN,zh-Hans;q=0.9',
    'origin': BASE,
    'referer': BASE + '/board',
    'sec-fetch-dest': 'empty',
    'sec-fetch-mode': 'cors',
    'sec-fetch-site': 'same-origin',
    'cookie': cookie,
  };
}

// ======================= 抓取 Cookie =======================
function headerValue(headers, name) {
  if (!headers) return '';
  const want = name.toLowerCase();
  for (const k of Object.keys(headers)) {
    if (k.toLowerCase() === want) return headers[k];
  }
  return '';
}

async function capture() {
  const reqHeaders = (typeof $request !== 'undefined' && $request.headers) || {};
  const cookie = headerValue(reqHeaders, 'cookie');
  const bodyText = (typeof $response !== 'undefined' && $response.body) || '';
  if (!cookie) { log('❌ 抓取失败：请求里没有 Cookie'); return false; }
  if (!bodyText) { log('❌ 抓取失败：响应体为空（检查 requires-body）'); return false; }

  let detail = null;
  try {
    const parsed = JSON.parse(bodyText);
    detail = parsed.detail || parsed.data || parsed;
  } catch (e) {
    log('❌ 抓取失败：响应不是 JSON');
    return false;
  }

  const memberId = detail.member_id || detail.memberId;
  const memberName = detail.member_name || detail.memberName || String(memberId);
  if (!memberId) { log('❌ 抓取失败：响应里没有 member_id'); return false; }

  const accounts = loadAccounts();
  const idx = accounts.findIndex(a => String(a.memberId) === String(memberId));
  const record = {
    memberId: String(memberId),
    memberName,
    avatar: detail.avatar || '',
    cookie,
    updatedAt: new Date().toISOString(),
  };
  if (idx >= 0) accounts[idx] = record; else accounts.push(record);
  saveAccounts(accounts);

  log(`✅ ${memberName} 已入库（当前共 ${accounts.length} 个账号）`);
  if (CFG.notify) notifyMsg(`🎉 ${memberName} 抓取成功`, `当前共 ${accounts.length} 个账号`);
  return true;
}

// ======================= 业务 =======================
async function checkinAccount(acc) {
  const res = await request({
    url: `${BASE}/api/attendance?random=${CFG.random ? 'true' : 'false'}`,
    method: 'POST',
    headers: apiHeaders(acc.cookie),
  });

  const data = res.json || {};
  if (res.status === 404) return { ok: false, msg: 'Cookie 失效，请重新抓取' };
  if (res.status === 401 || res.status === 403) return { ok: false, msg: `鉴权失败(${res.status})` };

  const message = data.message || data.msg || `HTTP ${res.status}`;
  const gain = data.gain ?? data.coin ?? data.reward ?? 0;
  const already = /已签到|已领取|重复/.test(message);
  return {
    ok: res.status >= 200 && res.status < 300,
    already,
    gain,
    msg: already ? '今日已签到' : `${message}${gain ? ` +${gain} 鸡腿` : ''}`,
  };
}

async function fetchInfo(acc) {
  const res = await request({
    url: `${BASE}/api/account/getInfo/${acc.memberId}?readme=1`,
    headers: apiHeaders(acc.cookie),
  });
  const detail = (res.json && (res.json.detail || res.json.data)) || null;
  if (!detail) return null;
  return { coin: detail.coin, name: detail.member_name || acc.memberName };
}

async function run() {
  if (CFG.clear) {
    storeSet('', KEY_ACCOUNTS);
    storeSet('false', 'nodeseek_clear');
    log('🧹 账号库已清空');
    if (CFG.notify) notifyMsg('NodeSeek', '账号库已清空');
    return;
  }

  const accounts = loadAccounts();
  if (!accounts.length) {
    log('⚠️ 没有账号。打开插件的「抓 Cookie」开关后，去 nodeseek.com 点一下自己的头像。');
    if (CFG.notify) notifyMsg('NodeSeek', '没有可用账号，请先抓 Cookie');
    return;
  }

  log(`📋 共 ${accounts.length} 个账号`);
  const lines = [];
  for (const acc of accounts) {
    try {
      if (!CFG.checkin) { log(`- ${acc.memberName}: 签到开关关闭，跳过`); continue; }
      const r = await checkinAccount(acc);
      let extra = '';
      try {
        const info = await fetchInfo(acc);
        if (info && info.coin !== undefined) extra = `（余额 ${info.coin}）`;
      } catch (e) { debug('查询余额失败', e.message); }
      const line = `${r.ok ? (r.already ? '☑️' : '🍗') : '❌'} ${acc.memberName}: ${r.msg}${extra}`;
      log(line);
      lines.push(line);
    } catch (e) {
      const line = `❌ ${acc.memberName}: ${e.message}`;
      log(line);
      lines.push(line);
    }
  }

  if (CFG.notify && lines.length) {
    const title = lines.every(l => l.startsWith('❌')) ? 'NodeSeek 签到失败' : 'NodeSeek 签到完成';
    notifyMsg(title, lines.join('\n'));
  }
}

// ======================= 通知 =======================
function notifyMsg(title, body) {
  try {
    if (isQuanX) $notify(title, '', body);
    else $notification.post(title, '', body);
  } catch (e) { log('通知发送失败:', e.message); }
}

// ======================= 入口 =======================
!(async () => {
  if (typeof $response !== 'undefined' && typeof $request !== 'undefined') {
    if (!CFG.capture) { log('抓取开关未开启，忽略本次请求'); return; }
    await capture();
    return;
  }
  await run();
})()
  .catch(e => {
    log('❌ 运行异常:', e && e.message ? e.message : e);
    notifyMsg('NodeSeek 脚本异常', String((e && e.message) || e));
  })
  .finally(() => {
    if (typeof $done === 'function') $done({});
    else if (typeof module !== 'undefined' && module.exports) process.exit(0);
  });
