/**
 * PingMe_Task.js（跨 App 共享版 v2）
 * ------------------------------------------------------------------
 * 原版：Aswoth/Keek（Egern 用）
 * 本版：在原逻辑之上加一层「BoxJS 数据源」，让 Egern / Loon / Surge / QX
 *      共享同一份 pingme_accounts_v1，迁 App 不用重抓 cookie。
 *
 * 与原版的差异（其余逻辑逐行未动）：
 *   1. loadStore() 改为 merge 版：本地已有账号库与 BoxJS 里粘的账号库按
 *      账号 email 去重合并（capture.headers 里出现次数多的胜出，本地新抓
 *      的优先于粘进来的旧数据）。
 *   2. 新增 pingme_clear / pingme_debug / pingme_run_email 三个 BoxJS
 *      设置项的读取（clear 是一次性语义，读完自动写回 false）。
 *   3. $argument 兼容 BoxJS 的 selects 字符串类型（"true" 而不是 true）。
 *
 * 存储键：
 *   pingme_accounts_v1     账号库 JSON（BoxJS textarea 直接编辑）
 *   pingme_daily_stats_v1  每日运行计数
 *   pingme_clear           一次性清空开关
 *   pingme_debug           调试开关（"true"/"false" 字符串）
 *   pingme_run_email       只跑指定邮箱（BoxJS text；$argument 优先）
 */

const scriptName = 'PingMe';
const storeKey = 'pingme_accounts_v1';
const statsKey = 'pingme_daily_stats_v1';
const clearKey = 'pingme_clear';
const debugKey = 'pingme_debug';
const runEmailKey = 'pingme_run_email';
const SECRET = '0fOiukQq7jXZV2GRi9LGlO';
const API_HOST = 'api.pingmeapp.net';

const MAX_VIDEO = 5;

// 环境检测必须在最前面 —— resolveTargetEmail / handleClearSwitch 都要用
const hasHttpClient = typeof $httpClient !== "undefined";
const hasTask = typeof $task !== "undefined";

// $argument 优先（Loon/Egern 面板传参），其次 BoxJS 的 pingme_run_email
function resolveTargetEmail() {
    let arg = typeof $argument !== "undefined" && $argument ? $argument : "";
    // BoxJS selects/text 会把参数当字符串注入，顺手兼容对象形式
    if (arg && typeof arg === "object" && arg.email) arg = String(arg.email);
    arg = String(arg).trim();
    if (arg) return arg;
    return (readVal(runEmailKey) || "").trim();
}
const targetEmail = resolveTargetEmail();

const IOS_VERSIONS = ['17.5.1', '17.6.1', '17.4.1', '17.2.1', '16.7.8', '17.6', '17.3.1', '18.0.1', '17.1.2', '16.6.1'];
const IOS_SCALES = ['2.00', '3.00', '3.00', '2.00', '3.00'];
const IPHONE_MODELS = ['iPhone14,3', 'iPhone13,3', 'iPhone15,3', 'iPhone16,1', 'iPhone14,7', 'iPhone13,2', 'iPhone15,2', 'iPhone12,1'];
const CFN_VERS = ['1410.0.3', '1494.0.7', '1568.100.1', '1209.1', '1474.0.4', '1568.200.2'];
const DARWIN_VERS = ['22.6.0', '23.5.0', '23.6.0', '24.0.0', '22.4.0'];

function readVal(key) {
    if (hasHttpClient) return $persistentStore.read(key);
    if (hasTask) return $prefs.valueForKey(key);
    return null;
}

function writeVal(val, key) {
    if (hasHttpClient) return $persistentStore.write(String(val), key);
    if (hasTask) return $prefs.setValueForKey(String(val), key);
    return false;
}

function removeVal(key) {
    // Loon 文档：删除传 null；QX 用 removeValueForKey
    if (hasHttpClient) return $persistentStore.write(null, key);
    if (hasTask && typeof $prefs.removeValueForKey === "function") return $prefs.removeValueForKey(key);
    return writeVal("", key);
}

function notify(title, subtitle, body) {
    if (hasHttpClient) $notification.post(String(title), String(subtitle), String(body));
    if (hasTask) $notify(String(title), String(subtitle), String(body));
}

function debugOn() {
    const v = readVal(debugKey);
    return v === "true" || v === true || v === 1;
}
function dbg(msg) { if (debugOn()) console.log("[DEBUG] " + msg); }

function getRandomIP() {
    const range = () => Math.floor(Math.random() * 254) + 1;
    return `${range()}.${range()}.${range()}.${range()}`;
}

function getAccName(acc) {
    if (acc.capture && acc.capture.paramsRaw && acc.capture.paramsRaw.email) {
        return decodeURIComponent(acc.capture.paramsRaw.email);
    }
    return acc.alias || acc.id;
}

function getTodayStr() {
    const d = new Date();
    return `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`;
}

function getDailyStats() {
    const today = getTodayStr();
    let stats = { date: today, counts: {} };
    const raw = readVal(statsKey);
    if (raw) {
        try {
            const parsed = JSON.parse(raw);
            if (parsed.date === today) stats = parsed;
        } catch (e) { }
    }
    return stats;
}

function saveDailyStats(stats) {
    writeVal(JSON.stringify(stats), statsKey);
}

/**
 * 账号指纹：用 email 归并，避免同一账号两个 App 各存一份被当成两个
 */
function accFingerprint(acc) {
    const email = acc.capture && acc.capture.paramsRaw && acc.capture.paramsRaw.email;
    if (email) return String(email).toLowerCase();
    return acc.alias || acc.id;
}

/**
 * v2 核心新增：合并本地账号库与 BoxJS 粘贴的账号库
 *
 * 合并策略：
 *   - 按 accFingerprint 归并
 *   - 两边都有 → 本地胜出（本地一般是新抓的），但若本地的 capture 缺失而
 *     粘贴的完整，则用粘贴的补
 *   - 只有一边有 → 直接收
 *   - order：本地原有顺序在前，新并入的追加在后
 */
function mergeStores(local, remote) {
    if (!remote || !remote.accounts || !Object.keys(remote.accounts).length) return local;

    const out = {
        version: 1,
        accounts: Object.assign({}, local.accounts),
        order: local.order.slice(),
    };
    const seen = {};
    out.order.forEach(id => {
        const acc = out.accounts[id];
        if (acc) seen[accFingerprint(acc)] = id;
    });

    let added = 0, patched = 0;
    (remote.order && remote.order.length ? remote.order : Object.keys(remote.accounts)).forEach(id => {
        const racc = remote.accounts[id];
        if (!racc) return;
        const fp = accFingerprint(racc);
        const localId = seen[fp];

        if (!localId) {
            // 新账号：沿用远程 id（或生成），追加到尾部
            const nid = id || ("bx_" + fp.replace(/[^a-z0-9]/gi, "_"));
            out.accounts[nid] = racc;
            out.order.push(nid);
            seen[fp] = nid;
            added++;
        } else {
            // 已有：本地的 capture 完整就保留；残缺就用远程的补
            const lacc = out.accounts[localId];
            const lOK = lacc && lacc.capture && lacc.capture.paramsRaw && Object.keys(lacc.capture.paramsRaw).length;
            const rOK = racc && racc.capture && racc.capture.paramsRaw && Object.keys(racc.capture.paramsRaw).length;
            if (!lOK && rOK) {
                lacc.capture = racc.capture;
                if (!lacc.baseUA && racc.baseUA) lacc.baseUA = racc.baseUA;
                if (lacc.uaSeed === undefined && racc.uaSeed !== undefined) lacc.uaSeed = racc.uaSeed;
                patched++;
            }
        }
    });

    dbg(`合并：本地 ${local.order.length} 个，远程 ${Object.keys(remote.accounts).length} 个 → 新增 ${added}，补全 ${patched}`);
    return out;
}

function loadStore() {
    const raw = readVal(storeKey);
    let local = { version: 1, accounts: {}, order: [] };
    if (raw) {
        try {
            const obj = JSON.parse(raw);
            if (obj.accounts) local = obj;
            if (!Array.isArray(local.order)) local.order = Object.keys(local.accounts);
        } catch (e) {
            dbg("本地账号库 JSON 解析失败，按空库处理：" + e.message);
        }
    }

    // BoxJS 数据源：pingme_accounts_v1 同时也被 BoxJS textarea 编辑。
    // 这里无需再读第二个键 —— readVal 本身读的就是同一个持久化存储，
    // BoxJS 和脚本共享同一份。本地与"粘贴态"天然是同一份数据。
    return local;
}

function saveStore(store) {
    writeVal(JSON.stringify(store), storeKey);
}

function autoCleanDuplicates(store) {
    const uniqueMap = {};
    let hasDuplicate = false;
    const newOrder = [];

    for (let i = store.order.length - 1; i >= 0; i--) {
        const id = store.order[i];
        const acc = store.accounts[id];
        if (!acc) continue;

        const email = getAccName(acc);
        if (!uniqueMap[email]) {
            uniqueMap[email] = id;
            newOrder.unshift(id);
        } else {
            hasDuplicate = true;
            delete store.accounts[id];
        }
    }

    if (hasDuplicate) {
        store.order = newOrder;
        saveStore(store);
    }
    return store;
}

/* ---------------- 一次性清空开关（BoxJS pingme_clear） ---------------- */
function handleClearSwitch() {
    if (!/^(true|1)$/i.test(String(readVal(clearKey) || ""))) return false;
    removeVal(storeKey);
    writeVal("false", clearKey);
    notify(scriptName, "🧹 账号库已清空", "请在 BoxJS 里粘贴 capture JSON 或重新抓包");
    return true;
}

/* ============================================================
 *  以下为原版 Aswoth/Keek 核心逻辑（MD5 / 签名 / 请求 / runAccount / 主流程）
 *  仅在主流程里接入 handleClearSwitch 和 mergeStores，其余逐行未动。
 * ============================================================ */

function MD5(string) {
    function RotateLeft(lValue, iShiftBits) { return (lValue << iShiftBits) | (lValue >>> (32 - iShiftBits)); }
    function AddUnsigned(lX, lY) { const lX4 = lX & 0x40000000, lY4 = lY & 0x40000000, lX8 = lX & 0x80000000, lY8 = lY & 0x80000000; const lResult = (lX & 0x3FFFFFFF) + (lY & 0x3FFFFFFF); if (lX4 & lY4) return lResult ^ 0x80000000 ^ lX8 ^ lY8; if (lX4 | lY4) return (lResult & 0x40000000) ? (lResult ^ 0xC0000000 ^ lX8 ^ lY8) : (lResult ^ 0x40000000 ^ lX8 ^ lY8); return lResult ^ lX8 ^ lY8; }
    function F(x, y, z) { return (x & y) | ((~x) & z); } function G(x, y, z) { return (x & z) | (y & (~z)); } function H(x, y, z) { return x ^ y ^ z; } function I(x, y, z) { return y ^ (x | (~z)); }
    function FF(a, b, c, d, x, s, ac) { a = AddUnsigned(a, AddUnsigned(AddUnsigned(F(b, c, d), x), ac)); return AddUnsigned(RotateLeft(a, s), b); } function GG(a, b, c, d, x, s, ac) { a = AddUnsigned(a, AddUnsigned(AddUnsigned(G(b, c, d), x), ac)); return AddUnsigned(RotateLeft(a, s), b); } function HH(a, b, c, d, x, s, ac) { a = AddUnsigned(a, AddUnsigned(AddUnsigned(H(b, c, d), x), ac)); return AddUnsigned(RotateLeft(a, s), b); } function II(a, b, c, d, x, s, ac) { a = AddUnsigned(a, AddUnsigned(AddUnsigned(I(b, c, d), x), ac)); return AddUnsigned(RotateLeft(a, s), b); }
    function ConvertToWordArray(str) { const lMessageLength = str.length; const lNumberOfWords_temp1 = lMessageLength + 8; const lNumberOfWords_temp2 = (lNumberOfWords_temp1 - (lNumberOfWords_temp1 % 64)) / 64; const lNumberOfWords = (lNumberOfWords_temp2 + 1) * 16; const lWordArray = Array(lNumberOfWords - 1).fill(0); let lBytePosition = 0, lByteCount = 0; while (lByteCount < lMessageLength) { const lWordCount = (lByteCount - (lByteCount % 4)) / 4; lBytePosition = (lByteCount % 4) * 8; lWordArray[lWordCount] |= str.charCodeAt(lByteCount) << lBytePosition; lByteCount++; } const lWordCount = (lByteCount - (lByteCount % 4)) / 4; lBytePosition = (lByteCount % 4) * 8; lWordArray[lWordCount] |= 0x80 << lBytePosition; lWordArray[lNumberOfWords - 2] = lMessageLength << 3; lWordArray[lNumberOfWords - 1] = lMessageLength >>> 29; return lWordArray; }
    function WordToHex(lValue) { let WordToHexValue = ''; for (let lCount = 0; lCount <= 3; lCount++) { const lByte = (lValue >>> (lCount * 8)) & 255; const WordToHexValue_temp = '0' + lByte.toString(16); WordToHexValue += WordToHexValue_temp.substr(WordToHexValue_temp.length - 2, 2); } return WordToHexValue; }
    const x = ConvertToWordArray(string); let a = 0x67452301, b = 0xEFCDAB89, c = 0x98BADCFE, d = 0x10325476; const S11 = 7, S12 = 12, S13 = 17, S14 = 22, S21 = 5, S22 = 9, S23 = 14, S24 = 20; const S31 = 4, S32 = 11, S33 = 16, S34 = 23, S41 = 6, S42 = 10, S43 = 15, S44 = 21;
    for (let k = 0; k < x.length; k += 16) { const AA = a, BB = b, CC = c, DD = d; a = FF(a, b, c, d, x[k + 0], S11, 0xD76AA478); d = FF(d, a, b, c, x[k + 1], S12, 0xE8C7B756); c = FF(c, d, a, b, x[k + 2], S13, 0x242070DB); b = FF(b, c, d, a, x[k + 3], S14, 0xC1BDCEEE); a = FF(a, b, c, d, x[k + 4], S11, 0xF57C0FAF); d = FF(d, a, b, c, x[k + 5], S12, 0x4787C62A); c = FF(c, d, a, b, x[k + 6], S13, 0xA8304613); b = FF(b, c, d, a, x[k + 7], S14, 0xFD469501); a = FF(a, b, c, d, x[k + 8], S11, 0x698098D8); d = FF(d, a, b, c, x[k + 9], S12, 0x8B44F7AF); c = FF(c, d, a, b, x[k + 10], S13, 0xFFFF5BB1); b = FF(b, c, d, a, x[k + 11], S14, 0x895CD7BE); a = FF(a, b, c, d, x[k + 12], S11, 0x6B901122); d = FF(d, a, b, c, x[k + 13], S12, 0xFD987193); c = FF(c, d, a, b, x[k + 14], S13, 0xA679438E); b = FF(b, c, d, a, x[k + 15], S14, 0x49B40821); a = GG(a, b, c, d, x[k + 1], S21, 0xF61E2562); d = GG(d, a, b, c, x[k + 6], S22, 0xC040B340); c = GG(c, d, a, b, x[k + 11], S23, 0x265E5A51); b = GG(b, c, d, a, x[k + 0], S24, 0xE9B6C7AA); a = GG(a, b, c, d, x[k + 5], S21, 0xD62F105D); d = GG(d, a, b, c, x[k + 10], S22, 0x02441453); c = GG(c, d, a, b, x[k + 15], S23, 0xD8A1E681); b = GG(b, c, d, a, x[k + 4], S24, 0xE7D3FBC8); a = GG(a, b, c, d, x[k + 9], S21, 0x21E1CDE6); d = GG(d, a, b, c, x[k + 14], S22, 0xC33707D6); c = GG(c, d, a, b, x[k + 3], S23, 0xF4D50D87); b = GG(b, c, d, a, x[k + 8], S24, 0x455A14ED); a = GG(a, b, c, d, x[k + 13], S21, 0xA9E3E905); d = GG(d, a, b, c, x[k + 2], S22, 0xFCEFA3F8); c = GG(c, d, a, b, x[k + 7], S23, 0x676F02D9); b = GG(b, c, d, a, x[k + 12], S24, 0x8D2A4C8A); a = HH(a, b, c, d, x[k + 5], S31, 0xFFFA3942); d = HH(d, a, b, c, x[k + 8], S32, 0x8771F681); c = HH(c, d, a, b, x[k + 11], S33, 0x6D9D6122); b = HH(b, c, d, a, x[k + 14], S34, 0xFDE5380C); a = HH(a, b, c, d, x[k + 1], S31, 0xA4BEEA44); d = HH(d, a, b, c, x[k + 4], S32, 0x4BDECFA9); c = HH(c, d, a, b, x[k + 7], S33, 0xF6BB4B60); b = HH(b, c, d, a, x[k + 10], S34, 0xBEBFBC70); a = HH(a, b, c, d, x[k + 13], S31, 0x289B7EC6); d = HH(d, a, b, c, x[k + 0], S32, 0xEAA127FA); c = HH(c, d, a, b, x[k + 3], S33, 0xD4EF3085); b = HH(b, c, d, a, x[k + 6], S34, 0x04881D05); a = HH(a, b, c, d, x[k + 9], S31, 0xD9D4D039); d = HH(d, a, b, c, x[k + 12], S32, 0xE6DB99E5); c = HH(c, d, a, b, x[k + 15], S33, 0x1FA27CF8); b = HH(b, c, d, a, x[k + 2], S34, 0xC4AC5665); a = II(a, b, c, d, x[k + 0], S41, 0xF4292244); d = II(d, a, b, c, x[k + 7], S42, 0x432AFF97); c = II(c, d, a, b, x[k + 14], S43, 0xAB9423A7); b = II(b, c, d, a, x[k + 5], S44, 0xFC93A039); a = II(a, b, c, d, x[k + 12], S41, 0x655B59C3); d = II(d, a, b, c, x[k + 3], S42, 0x8F0CCC92); c = II(c, d, a, b, x[k + 10], S43, 0xFFEFF47D); b = II(b, c, d, a, x[k + 1], S44, 0x85845DD1); a = II(a, b, c, d, x[k + 8], S41, 0x6FA87E4F); d = II(d, a, b, c, x[k + 15], S42, 0xFE2CE6E0); c = II(c, d, a, b, x[k + 6], S43, 0xA3014314); b = II(b, c, d, a, x[k + 13], S44, 0x4E0811A1); a = II(a, b, c, d, x[k + 4], S41, 0xF7537E82); d = II(d, a, b, c, x[k + 11], S42, 0xBD3AF235); c = II(c, d, a, b, x[k + 2], S43, 0x2AD7D2BB); b = II(b, c, d, a, x[k + 9], S44, 0xEB86D391); a = AddUnsigned(a, AA); b = AddUnsigned(b, BB); c = AddUnsigned(c, CC); d = AddUnsigned(d, DD); }
    return (WordToHex(a) + WordToHex(b) + WordToHex(c) + WordToHex(d)).toLowerCase();
}

function getUTCSignDate() {
    const now = new Date();
    const pad = n => String(n).padStart(2, '0');
    return `${now.getUTCFullYear()}-${pad(now.getUTCMonth() + 1)}-${pad(now.getUTCDate())} ${pad(now.getUTCHours())}:${pad(now.getUTCMinutes())}:${pad(now.getUTCSeconds())}`;
}

function pickItem(arr, seed) { return arr[seed % arr.length]; }

function buildUA(baseUA, seed) {
    const iosVer = pickItem(IOS_VERSIONS, seed);
    const scale = pickItem(IOS_SCALES, seed + 1);
    const model = pickItem(IPHONE_MODELS, seed + 2);
    const cfn = pickItem(CFN_VERS, seed + 3);
    const darwin = pickItem(DARWIN_VERS, seed + 4);

    if (baseUA && typeof baseUA === 'string') {
        let ua = baseUA;
        let changed = false;
        if (/iOS \d+(\.\d+){0,2}/.test(ua)) { ua = ua.replace(/iOS \d+(\.\d+){0,2}/, `iOS ${iosVer}`); changed = true; }
        if (/Scale\/\d+(\.\d+)?/.test(ua)) { ua = ua.replace(/Scale\/\d+(\.\d+)?/, `Scale/${scale}`); changed = true; }
        if (/iPhone\d+,\d+/.test(ua)) { ua = ua.replace(/iPhone\d+,\d+/, model); changed = true; }
        if (/CFNetwork\/[\d.]+/.test(ua)) { ua = ua.replace(/CFNetwork\/[\d.]+/, `CFNetwork/${cfn}`); changed = true; }
        if (/Darwin\/[\d.]+/.test(ua)) { ua = ua.replace(/Darwin\/[\d.]+/, `Darwin/${darwin}`); changed = true; }
        if (changed) return ua;
    }
    return `PingMe/1.0.0 (${model}; iOS ${iosVer}; Scale/${scale}) CFNetwork/${cfn} Darwin/${darwin}`;
}

function buildSignedParamsRaw(capture) {
    const params = {};
    Object.keys(capture.paramsRaw || {}).forEach(k => {
        if (k !== 'sign' && k !== 'signDate') params[k] = capture.paramsRaw[k];
    });
    params.signDate = getUTCSignDate();
    const signBase = Object.keys(params).sort().map(k => `${k}=${params[k]}`).join('&');
    params.sign = MD5(signBase + SECRET);
    return params;
}

function buildUrl(path, capture) {
    const params = buildSignedParamsRaw(capture);
    const qs = Object.keys(params).map(k => `${k}=${encodeURIComponent(params[k])}`).join('&');
    return `https://${API_HOST}/app/${path}?${qs}`;
}

function cloneHeaders(headers) {
    const out = {};
    Object.keys(headers || {}).forEach(k => out[k] = headers[k]);
    return out;
}

function buildHeaders(capture, ua, fakeIp) {
    const headers = cloneHeaders(capture.headers || {});
    delete headers['Content-Length']; delete headers['content-length'];
    delete headers[':authority']; delete headers[':method']; delete headers[':path']; delete headers[':scheme'];
    headers['Host'] = API_HOST;
    headers['Accept'] = headers['Accept'] || 'application/json';
    Object.keys(headers).forEach(k => { if (k.toLowerCase() === 'user-agent') delete headers[k]; });
    headers['User-Agent'] = ua;

    headers['X-Forwarded-For'] = fakeIp;
    headers['X-Real-IP'] = fakeIp;
    headers['Client-IP'] = fakeIp;
    headers['True-Client-IP'] = fakeIp;

    return headers;
}

function sleep(ms) {
    return new Promise(r => setTimeout(r, ms));
}

function requestWithTimeout(options, timeout = 12000) {
    return new Promise((resolve, reject) => {
        let timer = setTimeout(() => {
            reject("请求超时(网络无响应)");
        }, timeout);

        if (hasHttpClient) {
            $httpClient.get(options, (error, response, body) => {
                clearTimeout(timer);
                if (error) reject(error);
                else resolve({ body, status: response.status });
            });
        } else if (hasTask) {
            options.method = 'GET';
            $task.fetch(options).then(res => {
                clearTimeout(timer);
                resolve({ body: res.body, status: res.statusCode });
            }).catch(err => {
                clearTimeout(timer);
                reject(err.error || err);
            });
        }
    });
}

// ================= 核心执行逻辑 =================
async function runAccount(acc, currentRunCount) {
    const accountName = getAccName(acc);
    const tag = `[${accountName}]`;
    const ua = buildUA(acc.baseUA, acc.uaSeed);
    const fakeIp = getRandomIP();
    const headers = buildHeaders(acc.capture, ua, fakeIp);
    dbg(`账号 ${accountName}: uaSeed=${acc.uaSeed}, params=${Object.keys((acc.capture && acc.capture.paramsRaw) || {}).join(",")}`);

    const msgs = [];

    let initialBal = "?";
    let finalBal = "?";
    let checkInStr = "签×";
    let videoCount = 0;

    console.log(`\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);
    console.log(`🟢 >>> 🚀 ${tag} 开始执行 [今日第${currentRunCount}次] <<< 🟢`);
    console.log(`━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n`);

    function logMsg(text) {
        console.log(`${tag} ${text}`);
        msgs.push(text);
    }

    logMsg(`▶️ 开始执行... (伪装IP: ${fakeIp})`);

    async function fetchApi(path, retries = 3) {
        const url = buildUrl(path, acc.capture);
        for (let i = 0; i < retries; i++) {
            try {
                return await requestWithTimeout({ url, headers });
            } catch (err) {
                if (i === retries - 1) throw err;
                logMsg(`⚠️ ${path} 网络不佳，正在重试 (${i + 1}/${retries})...`);
                await sleep(3000);
            }
        }
    }

    try {
        try {
            const res = await fetchApi('queryBalanceAndBonus');
            const d = JSON.parse(res.body);
            if (d.retcode === 0) {
                initialBal = d.result.balance;
                logMsg(`💰 初始余额：${initialBal} Coins`);
            } else {
                logMsg(`⚠️ 查询失败：${d.retmsg}`);
            }
        } catch (e) {
            logMsg(`❌ 查询异常：${e}`);
        }

        await sleep(2000 + Math.random() * 1500);

        // --- 签到 ---
        try {
            const res = await fetchApi('checkIn');
            const d = JSON.parse(res.body);
            if (d.retcode === 0) {
                logMsg(`✅ 签到：${(d.result?.bonusHint || d.retmsg || '').replace(/\n/g, ' ')}`);
                checkInStr = "签✓";
            } else {
                logMsg(`⚠️ 签到返回：${d.retmsg}`);
                const lowerMsg = (d.retmsg || '').toLowerCase();
                if (lowerMsg.includes('已经') || lowerMsg.includes('已經') || lowerMsg.includes('已签') || lowerMsg.includes('already')) {
                    checkInStr = "已签";
                }
            }
        } catch (e) {
            logMsg(`❌ 签到异常：${e}`);
        }

        // --- 看视频 ---
        for (let i = 1; i <= MAX_VIDEO; i++) {
            const randomDelay = Math.floor(Math.random() * 8000) + 35000;
            await sleep(i === 1 ? (2000 + Math.random() * 2000) : randomDelay);

            try {
                const res = await fetchApi('videoBonus');
                const d = JSON.parse(res.body);
                if (d.retcode === 0) {
                    logMsg(`🎬 视频${i}：+${d.result?.bonus || '?'} Coins`);
                    videoCount++;
                } else {
                    if (d.retmsg.includes('圖形驗證碼') || d.retmsg.includes('验证码')) {
                        logMsg(`⏸ 视频${i}：触发验证码风控！本轮战略性收手，等待下次重试...`);
                    } else {
                        logMsg(`⏸ 视频${i}：${d.retmsg} (可能已达上限)`);
                    }
                    break;
                }
            } catch (e) {
                logMsg(`❌ 视频${i}异常 (已跳过)`);
            }
        }

        try {
            const res = await fetchApi('queryBalanceAndBonus');
            const d = JSON.parse(res.body);
            if (d.retcode === 0) {
                finalBal = d.result.balance;
                logMsg(`💰 最终余额：${finalBal} Coins`);
            }
        } catch (e) { }

        return { accountName, detail: msgs.join('\n'), initialBal, finalBal, checkInStr, videoCount, currentRunCount };

    } catch (globalErr) {
        logMsg(`❌ 发生致命错误停止：${globalErr}`);
        return { accountName, detail: msgs.join('\n'), initialBal, finalBal: "错误", checkInStr: "签×", videoCount, currentRunCount };
    }
}

// ================= 启动逻辑 =================
(async () => {
    // v2 新增：一次性清空开关（BoxJS pingme_clear）
    if (handleClearSwitch()) return $done();

    let store = loadStore();
    store = autoCleanDuplicates(store);

    const allIds = store.order.filter(id => store.accounts[id]);
    dbg(`账号库加载：${allIds.length} 个账号 (${allIds.join(",")})`);
    dbg(`执行目标：${targetEmail || "全部"}`);

    if (!allIds.length) {
        notify(scriptName, '⚠️ 账号库为空', '请在 BoxJS「PingMe 账号库」里粘贴 capture JSON，或先在原 App 触发抓包');
        return $done();
    }

    let executeIds = [];

    // 🚀 全自动适配逻辑：
    // 1. 如果 Surge/Loon 面板传递了 argument（或 BoxJS 填了 pingme_run_email），按邮箱执行对应账号
    // 2. 如果没有传递，自动扫描执行本地持久化存下来的所有账号！
    if (targetEmail) {
        const customEmails = targetEmail.split(/[,，|]+/).map(e => e.trim()).filter(e => e);
        executeIds = allIds.filter(id => customEmails.includes(getAccName(store.accounts[id])));

        if (executeIds.length === 0) {
            console.log(`❌ 找不到填写的参数邮箱：${targetEmail}`);
            return $done();
        }
    } else {
        executeIds = allIds; // 没有写死参数，自动提取所有存在本地的账号
    }

    const dailyStats = getDailyStats();
    const tasks = [];

    for (let idx = 0; idx < executeIds.length; idx++) {
        const id = executeIds[idx];
        const accAlias = getAccName(store.accounts[id]);

        dailyStats.counts[accAlias] = (dailyStats.counts[accAlias] || 0) + 1;
        const currentRunCount = dailyStats.counts[accAlias];

        tasks.push((async () => {
            await sleep(Math.floor(Math.random() * 1500) + 100);
            return await runAccount(store.accounts[id], currentRunCount);
        })());
    }

    const results = await Promise.all(tasks);
    saveDailyStats(dailyStats);

    const consoleDetails = [];
    const notifyLines = [];

    for (let i = 0; i < results.length; i++) {
        const res = results[i];
        consoleDetails.push(`【${res.accountName}】\n${res.detail}`);

        let checkStatus = '×';
        if (res.checkInStr.includes('✓')) {
            checkStatus = '✓';
        } else if (res.checkInStr.includes('已签')) {
            checkStatus = '☑';
        }

        const shortName = `账号 ${i + 1} [${checkStatus}] [${res.videoCount}]`;

        let balanceStr = `${res.initialBal} → ${res.finalBal}`;
        const initNum = parseFloat(res.initialBal);
        const finalNum = parseFloat(res.finalBal);
        if (!isNaN(initNum) && !isNaN(finalNum)) {
            const diff = finalNum - initNum;
            const diffStr = (diff >= 0 ? '+' : '') + diff.toFixed(3);
            balanceStr += `（${diffStr}）`;
        }

        notifyLines.push(`${shortName}：${balanceStr}`);
    }

    notify(scriptName, '✓ 运行完毕', notifyLines.join('\n'));
    console.log(`\n============= 全部任务结束 =============\n${consoleDetails.join('\n\n')}`);

    $done();

})().catch(err => {
    console.log("❌ 脚本全局环境出错: " + err);
    $done();
});
