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
  // Loon 走 h2，nodeseek 的 WAF 对 h1 无 UA 请求会 403
  if (isLoon) opt.alpn = 'h2';
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
    'user-agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1',
    'accept': '*/*',
    'accept-language': 'zh-CN,zh-Hans;q=0.9',
    'accept-encoding': 'gzip, deflate, br',
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
  // nodeseek 业务错误也走 HTTP 500（如「今日已签到」），以响应体为准
  const message = data.message || data.msg || `HTTP ${res.status}`;
  if (/需要登录|未登录|请先登录/.test(message) || res.status === 404) {
    return { ok: false, msg: 'Cookie 失效，请重新抓取' };
  }
  const already = /已签到|已领取|重复/.test(message);
  const gain = data.gain ?? data.coin ?? data.reward ?? 0;
  return {
    ok: data.success === true || already,
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
  return {
    coin: detail.coin,
    stardust: detail.stardust,
    rank: detail.rank,
    posts: detail.nPost,
    comments: detail.nComment,
    name: detail.member_name || acc.memberName,
  };
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
  let totalGain = 0;
  let lastBalance = null;

  for (const acc of accounts) {
    try {
      if (!CFG.checkin) {
        const info = await fetchInfo(acc).catch(() => null);
        if (info && info.coin !== undefined) {
          const line = `⏸ ${acc.memberName}: 签到开关已关闭，仅查询`;
          const detail = `   余额 ${info.coin} 鸡腿 · 等级 Lv${info.rank ?? '-'}`;
          log(line); log(detail);
          lines.push(line, detail);
          lastBalance = info.coin;
        } else {
          log(`- ${acc.memberName}: 签到开关关闭，跳过`);
        }
        continue;
      }

      // 签到前余额
      const before = await fetchInfo(acc).catch(() => null);
      const coinBefore = before && before.coin !== undefined ? before.coin : null;

      const r = await checkinAccount(acc);

      // 签到后余额
      const after = await fetchInfo(acc).catch(() => null);
      const coinAfter = after && after.coin !== undefined ? after.coin : null;
      if (coinAfter !== null) lastBalance = coinAfter;

      const delta = (coinBefore !== null && coinAfter !== null) ? coinAfter - coinBefore : (r.gain || 0);
      if (delta > 0) totalGain += delta;

      let line, detail;
      if (!r.ok) {
        line = `❌ ${acc.memberName}: ${r.msg}`;
        detail = coinAfter !== null ? `   余额 ${coinAfter} 鸡腿` : '';
      } else if (r.already) {
        line = `☑️ ${acc.memberName}: 今日已签到过了，明日再来哦`;
        detail = coinAfter !== null
          ? `   余额 ${coinAfter} 鸡腿 · 等级 Lv${after.rank ?? '-'} · 明日再来哦`
          : '';
      } else {
        const gainText = delta > 0 ? `+${delta}` : (r.gain ? `+${r.gain}` : '已到账');
        line = `🍗 ${acc.memberName}: 签到成功 ${gainText} 鸡腿`;
        const parts = [];
        if (coinBefore !== null && coinAfter !== null) parts.push(`余额 ${coinBefore} → ${coinAfter}（${delta >= 0 ? '+' : ''}${delta}）`);
        else if (coinAfter !== null) parts.push(`余额 ${coinAfter} 鸡腿`);
        if (after && after.rank !== undefined) parts.push(`等级 Lv${after.rank}`);
        if (after && after.posts !== undefined) parts.push(`帖 ${after.posts} · 评 ${after.comments}`);
        detail = parts.length ? `   ${parts.join(' · ')}` : '';
      }
      log(line); if (detail) log(detail);
      lines.push(line); if (detail) lines.push(detail);
    } catch (e) {
      const line = `❌ ${acc.memberName}: ${e.message}`;
      log(line);
      lines.push(line);
    }
  }

  if (CFG.notify && lines.length) {
    const failed = lines.filter(l => l.startsWith('❌')).length;
    const okCount = lines.filter(l => l.startsWith('🍗')).length;
    const alreadyCount = lines.filter(l => l.startsWith('☑️')).length;
    let title;
    if (failed && !okCount && !alreadyCount) title = '❌ NodeSeek 签到失败';
    else if (okCount) title = `🍗 NodeSeek 签到成功 +${totalGain} 鸡腿`;
    else if (alreadyCount) title = '☑️ NodeSeek 今日已签到';
    else title = 'NodeSeek 运行完成';

    const footer = [];
    if (okCount) footer.push(`成功 ${okCount}`);
    if (alreadyCount) footer.push(`已签 ${alreadyCount}`);
    if (failed) footer.push(`失败 ${failed}`);
    const summary = `合计 +${totalGain} 鸡腿${lastBalance !== null ? ` · 当前余额 ${lastBalance}` : ''}（${footer.join(' / ')}）`;
    lines.push('', summary);

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
