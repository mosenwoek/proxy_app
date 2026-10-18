/**
 * ============================================================
 *  HCNSEC 每日签到
 *  ------------------------------------------------------------------
 *  作者   : mosen[https://github.com/mosenwoek],moyan[https://t.me/tgxiaoxizf_bot]（v5.6 刷新凭证换 Bearer）
 *  更新   : 2026-10-17
 *  适用   : Loon / Surge / Stash / Quantumult X / Shadowrocket
 *
 *  v5.6 修了什么（真机日志实测）
 *  ------------------------------------------------------------------
 *  本站是 new-api 面板，真实签到流程是：
 *    ① 浏览器用 `new_api_refresh` cookie 调 POST /api/user/auth/refresh
 *       → 响应体里下发新 access_token（短命 JWT）
 *       → 响应 Set-Cookie 续签 new_api_refresh（24h）
 *    ② 用新 token 做 Authorization: Bearer 调业务接口
 *
 *  之前版本只抓 Authorization 头 —— 只有刷新瞬间才能抓到，9 点签到
 *  时早就过期。v5.6 签到前自己打一次 refresh，拿新鲜 token。
 *
 *  凭证模型
 *  ------------------------------------------------------------------
 *   · new_api_refresh=<uuid>.<sig>   刷新凭证（24h，签到用这个！）
 *   · new_api_has_session=1          登录标志位
 *   · Bearer <JWT>                   每次签到自己换，不长期存
 *   · server_name_session=...        nginx 匿名，签到不认
 * ============================================================
 */

const SCRIPT_VERSION = "5.6.0";
const NAME = "HCNSEC";
const BASE_URL = "https://api.hcnsec.cn";
const UA = "Mozilla/5.0 (iPhone; CPU iPhone OS 16_6 like Mac OS X) " +
	"AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.6 Mobile/15E148 Safari/604.1";

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
 * new_api_refresh 是刷新凭证，最核心。
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

function sessionSignature() {
	const jar = loadJar();
	const keys = Object.keys(jar).filter(isAuthCookieName).sort();
	return keys.length ? keys.map(k => k + "=" + jar[k]).join("; ") : "";
}
function hasAuthCookie() { return Object.keys(loadJar()).some(isAuthCookieName); }
function hasRefreshCookie() { return !!loadJar().new_api_refresh; }

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
function buildHeaders(explicitToken) {
	const h = { "Content-Type": "application/json", "Accept-Language": "zh-CN,zh;q=0.9" };
	const cookie = cookieHeader();
	const token = explicitToken || store.read(K_TOKEN);
	const uid = store.read(K_USER);
	if (cookie) h.Cookie = cookie;
	if (token) h.Authorization = "Bearer " + token;
	if (uid) h["New-API-User"] = String(uid);
	return h;
}

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

	if (!sigChanged) {
		if (!afterSig) dbg("只抓到匿名 cookie，不通知");
		else dbg("会话未变，静默更新");
		return;
	}

	notify(NAME + " · 凭证已更新", "✅ 捕获成功",
		"可以关闭网页了，之后会每天自动签到。\n来源：" + source + "\n时间：" + stamp());
}

/**
 * 用 new_api_refresh cookie 换取新的 access token。
 * 这是本站的核心流程 —— Bearer token 短命，必须每次签到前刷。
 * 返回新 token 字符串或 null。
 */
async function refreshAccessToken() {
	const jar = loadJar();
	if (!jar.new_api_refresh) { dbg("刷新：罐里没有 new_api_refresh，跳过"); return null; }

	const cookieStr = Object.keys(jar).sort().map(k => k + "=" + jar[k]).join("; ");
	try {
		const r = await http("POST", "/api/user/auth/refresh", {
			Cookie: cookieStr,
			Origin: BASE_URL,
			Referer: BASE_URL + "/",
		}, "{}");

		dbg("refresh -> HTTP " + r.status + " " + edge(r.raw, 300));

		if (r.status !== 200 || !r.json) {
			if (r.status === 401) dbg("刷新凭证已过期");
			return null;
		}

		const d = r.json.data || r.json;
		const token = d && (d.access_token || d.accessToken || d.token || d.jwt_token);
		if (!token || typeof token !== "string") {
			dbg("刷新：响应里没找到 token，payload keys=" + Object.keys(d || {}).join(","));
			return null;
		}

		// 响应 Set-Cookie 续签 new_api_refresh，入罐
		const setCookie = pickHeader(r.headers, "set-cookie");
		if (setCookie) {
			const pairs = parseSetCookie(setCookie);
			if (Object.keys(pairs).length) {
				mergeJar(pairs);
				dbg("刷新：续签 cookie " + Object.keys(pairs).join(","));
			}
		}

		store.write(token, K_TOKEN);
		dbg("刷新成功，拿到新 token (长度 " + token.length + ")");
		return token;
	} catch (e) {
		dbg("刷新异常：" + e.message);
		return null;
	}
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

	if (!hasAuthCookie() && !store.read(K_TOKEN) && !manualCookie()) {
		notify(NAME, "🚫 尚未获取凭证",
			"请先打开 api.hcnsec.cn 并登录，再回来运行本脚本\n\n" + diagnose());
		return;
	}

	// 核心：有 new_api_refresh 就先刷一次拿新鲜 token
	let token = null;
	if (hasRefreshCookie()) {
		dbg("检测到 new_api_refresh，先调 refresh 换新 token");
		token = await refreshAccessToken();
		if (!token) {
			clearCredentials();
			notify(NAME, "❌ 刷新凭证已失效",
				"24 小时内未登录，或 cookie 被服务器拉黑。\n请重新打开 api.hcnsec.cn 登录\n\n" + diagnose());
			return;
		}
	} else if (!store.read(K_TOKEN) && !manualCookie()) {
		notify(NAME, "⚠️ 缺少刷新凭证",
			"罐里没有 new_api_refresh，需要重新登录一次让服务器下发\n\n" + diagnose());
		return;
	}

	const headers = buildHeaders(token);
	dbg("送出 Cookie: " + edge(cookieHeader(), 120));
	dbg("送出 Bearer: " + (headers.Authorization ? "有(长度 " + (headers.Authorization.length - 7) + ")" : "无"));

	// 计价单位
	let quotaUnit = null;
	try {
		const st = await http("GET", "/api/status");
		const cfg = st.json && st.json.data;
		if (cfg && cfg.display_in_currency === true && Number(cfg.quota_per_unit) > 0)
			quotaUnit = Number(cfg.quota_per_unit);
	} catch (_) {}

	// 校验身份
	let me;
	try {
		const self = await http("GET", "/api/user/self", headers);
		dbg("self -> HTTP " + self.status + " " + edge(self.raw, 200));
		if (self.json && self.json.success === true && self.json.data) {
			me = self.json.data;
		} else if (self.status === 401 || /AUTH_UNAUTHORIZED|access token/i.test(self.raw || "")) {
			clearCredentials();
			notify(NAME, "❌ Token 校验失败",
				"刚拿到的 token 调 self 就 401，服务器可能临时拉黑或刷新接口响应结构变化。\n" +
				"响应：" + edge(self.raw, 100) + "\n请重新登录试试");
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
	lines.push("其中登录态：" + (authKeys.length ? authKeys.join(",") : "无"));
	lines.push("有刷新凭证：" + (hasRefreshCookie() ? "是" : "否 ← 关键！没它就签不了"));
	lines.push("手动 Cookie：" + (manualCookie() ? "已填" : "未填"));
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

/* 入口 */
if (HAS_RESPONSE) captureResponse();
else if (HAS_REQUEST) captureRequest();
else checkin().catch(e => notify(NAME, "❌ 运行失败", (e && e.message) || String(e))).then(() => $done());
