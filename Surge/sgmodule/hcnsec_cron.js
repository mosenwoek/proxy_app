/**
 * ============================================================
 *  HCNSEC 每日签到
 *  ------------------------------------------------------------------
 *  作者   : mosen（v5.5 真实 cookie 白名单对齐）
 *  更新   : 2026-10-17
 *  适用   : Loon / Surge / Stash / Quantumult X / Shadowrocket
 *
 *  v5.5 修了什么
 *  ------------------------------------------------------------------
 *  真机日志实测：api.hcnsec.cn 用的是 Bearer Token + 这几个 cookie
 *  的混合模型，之前白名单对不上，所以捕获侧判成"匿名"不弹通知。
 *
 *  凭证模型（真机确认）
 *  ------------------------------------------------------------------
 *   · Authorization: Bearer <JWT>        签到真正用的凭证
 *   · Cookie: new_api_has_session=1      登录标志位（固定=1）
 *   · Cookie: new_api_refresh=<uuid>.<sig>  刷新凭证
 *   · Cookie: server_name_session=...    nginx 匿名，签到接口不认
 * ============================================================
 */

const SCRIPT_VERSION = "5.5.0";
const NAME = "HCNSEC";
const BASE_URL = "https://api.hcnsec.cn";
const UA = "Mozilla/5.0 (iPhone; CPU iPhone OS 18_5 like Mac OS X) " +
	"AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.5 Mobile/15E148 Safari/604.1";

const K_COOKIES = "hcnsec_cookies";
const K_TOKEN = "hcnsec_token";
const K_USER = "hcnsec_user";
const K_SIG = "hcnsec_sig";
const K_CLEAR = "hcnsec_clear";
const K_DEBUG = "hcnsec_debug";
const K_MANUAL = "hcnsec_manual_cookie";
const K_DIAG_REQ = "hcnsec_diag_req";
const K_DIAG_RES = "hcnsec_diag_res";

/**
 * 真实登录态白名单（基于真机日志实测）
 * ------------------------------------------------------------
 *   · new_api_has_session=1          登录标志位（值固定=1）
 *   · new_api_refresh=<uuid>.<sig>   刷新凭证
 *   · session / access_token         其他 new-api 变种
 *
 * server_name_session 是 nginx 负载均衡层的匿名 cookie，不算。
 */
const AUTH_COOKIE_NAMES = /^(session|sessionid|access_token|accesstoken|new_api_has_session|new_api_refresh|new_api_session|user|user_session|username_session)$/i;
function isAuthCookieName(name) { return AUTH_COOKIE_NAMES.test(String(name || "")); }

const isQuanX = typeof $task !== "undefined";
const isLoon = typeof $loon !== "undefined";
const isSurgeLike = !isQuanX && !isLoon;
const HAS_REQUEST = typeof $request !== "undefined";
const HAS_RESPONSE = typeof $response !== "undefined";
const TIMEOUT = isSurgeLike ? 20 : 20000;

const store = {
	read(key) {
		let v;
		try { v = isQuanX ? $prefs.valueForKey(key) : $persistentStore.read(key); }
		catch (_) { v = null; }
		return v === undefined || v === null ? "" : String(v);
	},
	write(value, key) {
		try {
			if (value === undefined || value === null) {
				return isQuanX ? $prefs.removeValueForKey(key) : $persistentStore.write(null, key);
			}
			return isQuanX ? $prefs.setValueForKey(String(value), key) : $persistentStore.write(String(value), key);
		} catch (e) { console.log("[WARN] 写 " + key + ": " + (e && e.message)); return false; }
	},
};

function debugOn() {
	try {
		if (typeof $argument !== "undefined" && $argument && typeof $argument === "object" && typeof $argument.debug === "boolean") return $argument.debug;
		if (typeof $argument === "string" && /(^|&)debug=(true|1)/i.test($argument)) return true;
	} catch (_) {}
	return store.read(K_DEBUG) === "true";
}
function dbg(msg) { if (debugOn()) console.log("[DEBUG] " + msg); }

function notify(title, subtitle, body, attach) {
	try {
		if (isQuanX) $notify(title, subtitle, body, attach);
		else $notification.post(title, subtitle, body, attach);
	} catch (e) { console.log("notify failed: " + (e && e.message)); }
}

function http(method, path, headers, body) {
	return new Promise((resolve, reject) => {
		const options = {
			url: BASE_URL + path,
			headers: Object.assign({ "User-Agent": UA, Accept: "application/json" }, headers || {}),
			timeout: TIMEOUT,
		};
		if (body !== undefined) options.body = body;

		const finish = (err, resp, data) => {
			if (err) return reject(new Error(typeof err === "string" ? err : "网络错误"));
			const status = resp && (resp.status || resp.statusCode);
			let text = data;
			if (text && typeof text !== "string") {
				try { text = new TextDecoder("utf-8").decode(text); } catch (_) { text = String(text); }
			}
			let json = null;
			try { json = JSON.parse(text); } catch (_) {}
			resolve({ status, headers: (resp && resp.headers) || {}, json, raw: text });
		};

		try {
			if (isQuanX) {
				options.method = method;
				$task.fetch(options).then(r => finish(null, r, r.body),
					e => finish(e && (e.error || e.message) ? e.error || e.message : "网络错误"));
			} else {
				const fn = $httpClient[method.toLowerCase()];
				if (typeof fn !== "function") return reject(new Error("当前平台不支持 " + method));
				fn(options, (err, resp, data) => finish(err, resp, data));
			}
		} catch (e) { reject(e); }
	});
}

/* Cookie 罐 */
function loadJar() {
	try { const p = JSON.parse(store.read(K_COOKIES) || "{}"); return p && typeof p === "object" ? p : {}; }
	catch (_) { return {}; }
}
function mergeJar(patch) {
	const jar = loadJar();
	let changed = false;
	for (const k of Object.keys(patch)) {
		const v = patch[k];
		if (v === undefined || v === null) { if (k in jar) { delete jar[k]; changed = true; } continue; }
		if (jar[k] !== v) { jar[k] = v; changed = true; }
	}
	if (changed) store.write(JSON.stringify(jar), K_COOKIES);
	return changed;
}
function jarToHeader() {
	const jar = loadJar(); const keys = Object.keys(jar).sort();
	return keys.length ? keys.map(k => k + "=" + jar[k]).join("; ") : "";
}

/** 会话指纹：只认白名单内的真实登录态 cookie */
function sessionSignature() {
	const jar = loadJar();
	const keys = Object.keys(jar).filter(isAuthCookieName).sort();
	return keys.length ? keys.map(k => k + "=" + jar[k]).join("; ") : "";
}
function hasAuthCookie() { return Object.keys(loadJar()).some(isAuthCookieName); }

function parseCookieHeader(raw) {
	const out = {};
	for (const part of String(raw || "").split(/;\s*/)) {
		const eq = part.indexOf("="); if (eq < 1) continue;
		const k = part.slice(0, eq).trim(), v = part.slice(eq + 1).trim();
		if (k) out[k] = v;
	}
	return out;
}
function parseSetCookie(raw) {
	const out = {};
	for (const line of String(raw || "").split(/\n+/)) {
		const first = line.split(";")[0].trim();
		const eq = first.indexOf("="); if (eq < 1) continue;
		const k = first.slice(0, eq).trim(), v = first.slice(eq + 1).trim();
		if (k) out[k] = v;
	}
	return out;
}
function pickHeader(headers, name) {
	const target = name.toLowerCase();
	let found;
	for (const key of Object.keys(headers || {})) if (key.toLowerCase() === target) { found = headers[key]; break; }
	if (found === undefined || found === null) return "";
	if (Array.isArray(found)) return found.join("\n");
	return String(found);
}
function headerNames(headers) { return Object.keys(headers || {}).sort().join(","); }

/* 凭证组装 */
function manualCookie() {
	try {
		if (typeof $argument !== "undefined" && $argument && typeof $argument === "object") {
			const v = $argument.manual_cookie;
			if (typeof v === "string" && v.trim()) return v.trim();
		}
		if (typeof $argument === "string") {
			const m = $argument.match(/manual_cookie=([^&]+)/);
			if (m) return decodeURIComponent(m[1]).trim();
		}
	} catch (_) {}
	return store.read(K_MANUAL).trim();
}
function effectiveJar() {
	const jar = Object.assign({}, loadJar());
	const manual = manualCookie();
	if (manual) Object.assign(jar, parseCookieHeader(manual));
	return jar;
}
function cookieHeader() {
	const jar = effectiveJar(); const keys = Object.keys(jar).sort();
	return keys.length ? keys.map(k => k + "=" + jar[k]).join("; ") : "";
}
function buildHeaders() {
	const h = { "Content-Type": "application/json", "Accept-Language": "zh-CN,zh;q=0.9" };
	const cookie = cookieHeader(); const token = store.read(K_TOKEN); const uid = store.read(K_USER);
	if (cookie) h.Cookie = cookie;
	if (token) h.Authorization = "Bearer " + token;
	if (uid) h["New-API-User"] = String(uid);
	return h;
}
function hasCredentials() { return !!(cookieHeader() || store.read(K_TOKEN)); }

/* 请求侧捕获 */
function captureRequest() {
	try {
		const headers = $request.headers || {};
		const rawCookie = pickHeader(headers, "cookie");
		const rawToken = pickHeader(headers, "authorization");
		const userId = pickHeader(headers, "new-api-user");

		store.write(stamp() + " | cookie=" + (rawCookie ? "Y" : "N") + " | " + edge(headerNames(headers), 180), K_DIAG_REQ);
		dbg("请求 " + edge($request.url, 70));
		dbg("  cookie=" + (rawCookie ? "有(" + edge(rawCookie, 60) + ")" : "无") +
			" | authorization=" + (rawToken ? "有" : "无") +
			" | headers=" + headerNames(headers));

		const beforeSig = sessionSignature();
		let changed = false;
		if (rawCookie) changed = mergeJar(parseCookieHeader(rawCookie)) || changed;
		if (rawToken && rawToken !== store.read(K_TOKEN)) { store.write(rawToken, K_TOKEN); changed = true; }
		if (userId && userId !== store.read(K_USER)) store.write(userId, K_USER);

		afterCapture(changed, beforeSig, rawCookie ? "请求 Cookie" : "Bearer Token");
	} catch (e) { console.log("[ERROR] captureRequest: " + (e && e.message)); }
	$done({});
}

/* 响应侧捕获 */
function captureResponse() {
	try {
		const headers = $response.headers || {};
		const rawSet = pickHeader(headers, "set-cookie");
		store.write(stamp() + " | set-cookie=" + (rawSet ? "Y" : "N") + " | " + edge(headerNames(headers), 180), K_DIAG_RES);
		dbg("响应 " + edge($request && $request.url, 70) + " | status=" + ($response.status || "?"));
		dbg("  set-cookie=" + (rawSet ? "有(" + edge(rawSet, 80) + ")" : "无"));

		const beforeSig = sessionSignature();
		let changed = false;
		if (rawSet) {
			const pairs = parseSetCookie(rawSet);
			dbg("Set-Cookie 解析出 " + Object.keys(pairs).length + " 项: " + Object.keys(pairs).join(","));
			changed = mergeJar(pairs);
		}
		afterCapture(changed, beforeSig, "响应 Set-Cookie");
	} catch (e) { console.log("[ERROR] captureResponse: " + (e && e.message)); }
	$done({});
}

function afterCapture(changed, beforeSig, source) {
	if (!changed) { dbg("凭证无变化，跳过通知"); return; }
	const afterSig = sessionSignature();
	const sigChanged = !!afterSig && afterSig !== beforeSig;
	if (sigChanged) store.write(afterSig, K_SIG);

	// 真实登录态 cookie 才算"凭证到位"。匿名会话（server_name_session 等）
	// 只入罐、不通知 —— 否则你一打开网页就会收到假通知。
	if (!sigChanged) {
		if (!afterSig) dbg("只抓到匿名 cookie，不通知");
		else dbg("会话未变，静默更新");
		return;
	}

	notify(NAME + " · 凭证已更新", "✅ 捕获成功",
		"可以关闭网页了，之后会每天自动签到。\n来源：" + source + "\n时间：" + stamp());
}

/* 签到 */
async function checkin() {
	console.log("[INFO] " + NAME + " 签到 v" + SCRIPT_VERSION);

	if (/^(true|1)$/i.test(store.read(K_CLEAR))) {
		clearCredentials();
		store.write("false", K_CLEAR);
		notify(NAME, "🧹 凭证已清空", "请重新打开 api.hcnsec.cn 登录获取");
		return;
	}

	if (!hasCredentials()) {
		notify(NAME, "🚫 尚未获取凭证", "请先打开 api.hcnsec.cn 并登录，再回来运行本脚本\n\n" + diagnose());
		return;
	}

	// 匿名会话兜底：没任何登录态凭证（白名单 cookie / Bearer / 手动 Cookie 都没有）
	if (!hasAuthCookie() && !store.read(K_TOKEN) && !manualCookie()) {
		notify(NAME, "⚠️ 只拿到匿名会话",
			"浏览器只给了 server_name_session 这类 nginx 匿名 cookie，签到接口不认。\n" +
			"请在网页上【用账号密码登录一次】后再试。\n\n" + diagnose());
		return;
	}

	const headers = buildHeaders();
	dbg("送出 Cookie: " + edge(cookieHeader(), 120) + (manualCookie() ? "  [含手动 Cookie]" : ""));

	let quotaUnit = null;
	try {
		const st = await http("GET", "/api/status");
		const cfg = st.json && st.json.data;
		if (cfg && cfg.display_in_currency === true && Number(cfg.quota_per_unit) > 0)
			quotaUnit = Number(cfg.quota_per_unit);
	} catch (_) {}

	let me;
	try {
		const self = await http("GET", "/api/user/self", headers);
		dbg("self -> HTTP " + self.status + " " + edge(self.raw, 200));
		if (self.json && self.json.success === true && self.json.data) {
			me = self.json.data;
		} else if (self.status === 401 || /AUTH_UNAUTHORIZED|invalid access token|无权/i.test(self.raw || "")) {
			clearCredentials();
			notify(NAME, "❌ 凭证已失效",
				manualCookie()
					? "手动 Cookie 已过期，请更新插件设置里的「手动 Cookie」"
					: "会话已过期，请重新打开 api.hcnsec.cn 登录");
			return;
		} else {
			notify(NAME, "⚠️ 身份校验异常", "HTTP " + self.status + "：" + edge(self.raw, 120));
			return;
		}
	} catch (e) { notify(NAME, "❌ 请求失败", e.message); return; }

	const stats = [];
	stats.push(amount("💳 当前余额", me.quota, quotaUnit));
	stats.push(amount("📉 累计消耗", me.used_quota, quotaUnit));
	if (typeof me.request_count === "number") stats.push("⚡ 累计调用：" + me.request_count + " 次");

	const masked = mask(me.username || me.email || "未知");

	let award = null, already = false;
	if (enableCheckin()) {
		try {
			const ci = await http("POST", "/api/user/checkin", headers, "{}");
			dbg("checkin -> HTTP " + ci.status + " " + edge(ci.raw, 300));
			if (ci.json && ci.json.success === true) {
				const d = ci.json.data;
				if (d && typeof d === "object") {
					const v = d.quota_awarded ?? d.reward ?? d.quota ?? d.amount;
					if (typeof v === "number" && v > 0) award = v;
				}
			} else if (ci.json && /已签到|已经签到|already/i.test(String(ci.json.message || ""))) {
				already = true;
			}
			if (ci.status === 404) dbg("签到接口不存在，走日志兜底");
		} catch (e) { dbg("checkin 异常：" + e.message); }
	} else already = true;

	const record = await todayCheckinRecord(headers);
	const logReward = record ? rewardFrom(record.content) : "";
	const reward = logReward || apiReward(award, quotaUnit);

	if (award !== null || record) {
		notify(NAME, already ? "✅ 今日已签到" : "✅ 签到成功",
			"👤 账号：" + masked + "\n" +
			"🎁 " + (award !== null ? "本次奖励" : "今日奖励") + "：" + reward + "\n" +
			stats.join("\n") + "\n" +
			"🕒 " + (record ? "签到时间：" + clock(record.created_at * 1000) : "时间：" + stamp()));
	} else {
		notify(NAME, "⚠️ 签到状态未确认",
			"👤 账号：" + masked + "\n" + stats.join("\n") + "\n未能确认今日签到记录，请到网站核对");
	}
}

function enableCheckin() {
	try {
		if (typeof $argument !== "undefined" && $argument && typeof $argument === "object") {
			if (typeof $argument.enable_checkin === "boolean") return $argument.enable_checkin;
		}
		if (typeof $argument === "string" && /(^|&)enable_checkin=(false|0)/i.test($argument)) return false;
	} catch (_) {}
	const stored = store.read("hcnsec_enable_checkin");
	return stored ? !/^(false|0)$/i.test(stored) : true;
}

async function todayCheckinRecord(headers) {
	try {
		const logs = await http("GET", "/api/log/self?p=1&page_size=20", headers);
		const items = logs.json && logs.json.data && logs.json.data.items;
		if (!Array.isArray(items)) return null;
		const start = new Date(); start.setHours(0, 0, 0, 0);
		for (const item of items) {
			const content = String(item.content || "");
			if (/签到/.test(content) && item.created_at * 1000 >= start.getTime()) return item;
		}
	} catch (e) { dbg("日志异常：" + e.message); }
	return null;
}

function clearCredentials() {
	store.write(undefined, K_COOKIES);
	store.write(undefined, K_TOKEN);
	store.write(undefined, K_USER);
	store.write(undefined, K_SIG);
}

function diagnose() {
	const req = store.read(K_DIAG_REQ), res = store.read(K_DIAG_RES);
	const jarKeys = Object.keys(loadJar());
	const authKeys = jarKeys.filter(isAuthCookieName);
	const lines = ["—— 诊断 ——"];
	lines.push("请求侧：" + (req ? edge(req, 150) : "从未捕获到请求"));
	lines.push("响应侧：" + (res ? edge(res, 150) : "从未捕获到响应"));
	lines.push("罐内 cookie：" + (jarKeys.length ? jarKeys.join(",") : "空"));
	lines.push("其中登录态：" + (authKeys.length ? authKeys.join(",") : "无（只有匿名会话）"));
	lines.push("手动 Cookie：" + (manualCookie() ? "已填（" + edge(cookieHeader(), 60) + "）" : "未填"));

	if (!req && !res) lines.push("→ 两条捕获规则都没跑过：检查插件是否启用、MitM 是否包含 api.hcnsec.cn");
	else if (jarKeys.length && !authKeys.length) lines.push("→ 只抓到匿名会话（server_name_session 等 nginx 层 cookie）：请在网页上用账号密码登录一次");
	else if (req && /cookie=N/.test(req) && res && /set-cookie=N/.test(res)) lines.push("→ 两侧都跑到了但都没有凭证：请先在网页上【登录一次】");
	else if (req && /cookie=N/.test(req)) lines.push("→ 请求侧没看到 Cookie：Loon 未下发该头，或浏览器没带（未登录）");
	else if (res && /set-cookie=N/.test(res)) lines.push("→ 响应侧没看到 Set-Cookie：本次会话未换发，登录一次即可");
	lines.push("→ 兜底：电脑浏览器 DevTools → Application → Cookies 复制 new_api_refresh 或 session= 那一整条，填进插件「手动 Cookie」");
	return lines.join("\n");
}

function amount(label, value, unit) {
	const n = Number(value);
	if (!isFinite(n)) return label + "：未知";
	return unit ? label + "：$" + (n / unit).toFixed(2) : label + "：" + n;
}
function fmtAward(v, unit) {
	if (typeof v !== "number") return String(v);
	return unit ? "$" + (v / unit).toFixed(2) : v + " 额度";
}
function apiReward(v, unit) { return v === null || v === undefined ? "未识别" : fmtAward(v, unit); }
function rewardFrom(content) {
	const m = String(content || "").match(/\$\s*(\d+(?:\.\d+)?)/);
	return m ? "$" + m[1] : "";
}
function mask(u) { const n = String(u).split("@")[0]; return n.slice(0, 2) + "***"; }
function clock(ts) {
	const d = new Date(ts);
	return [d.getHours(), d.getMinutes(), d.getSeconds()].map(n => String(n).padStart(2, "0")).join(":");
}
function stamp() {
	const d = new Date(), p = n => String(n).padStart(2, "0");
	return p(d.getMonth() + 1) + "-" + p(d.getDate()) + " " + p(d.getHours()) + ":" + p(d.getMinutes()) + ":" + p(d.getSeconds());
}
function edge(s, n) {
	const t = String(s || "").replace(/\s+/g, " ");
	return t.length > n ? t.slice(0, n) + "…" : t;
}

/* 入口：Response 脚本里 $request 也在，必须先判 $response */
if (HAS_RESPONSE) captureResponse();
else if (HAS_REQUEST) captureRequest();
else checkin().catch(e => notify(NAME, "❌ 运行失败", (e && e.message) || String(e))).then(() => $done());
