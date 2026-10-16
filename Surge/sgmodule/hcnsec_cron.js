/**
 * ============================================================
 *  HCNSEC 每日签到
 *  ------------------------------------------------------------------
 *  作者   : mosen（v5 重写）
 *  更新   : 2026-10-17
 *  适用   : Loon / Surge / Stash / Quantumult X / Shadowrocket
 *
 *  凭证模型（关键）
 *  ------------------------------------------------------------------
 *  本站是 new-api 系面板（响应头 x-oneapi-request-id），Web 端有【两套】凭证：
 *
 *   1) Authorization: Bearer <accessToken>
 *      短命。前端从 auth bundle 里取，带 access_expires_at，
 *      并且存在 /api/user/auth/refresh 轮换 —— 抓到的 token
 *      撑不到第二天早上 9 点。
 *
 *   2) Cookie: ...session=...
 *      Max-Age = 86400（24 小时），是 Web 会话的权威凭证。
 *      ← 签到要存的是这个
 *
 *  所以本脚本以 Cookie 为主、Bearer 为辅，两者都抓、都存、都发。
 *
 *  用法
 *  ------------------------------------------------------------------
 *  · 插件/模块里挂一条 request 脚本匹配整个 https://api.hcnsec.cn/
 *    → 你在网页上登录一次，凭证就自动落袋
 *  · 同一份脚本挂 cron → 每天自动签到
 *
 *  受管存储键
 *  ------------------------------------------------------------------
 *   hcnsec_cookie   浏览器 Cookie 头（主凭证）
 *   hcnsec_token    Bearer Token（备用，短命）
 *   hcnsec_user     New-API-User（部分版本需要）
 *   hcnsec_sig      会话指纹，用于判断是否换了账号
 *   hcnsec_clear    置为 true 后下一次运行会清空全部凭证
 *   hcnsec_debug    置为 true 打开调试日志
 * ============================================================
 */

const SCRIPT_VERSION = "5.0.0";
const NAME = "HCNSEC";
const BASE_URL = "https://api.hcnsec.cn";
const UA = "Mozilla/5.0 (iPhone; CPU iPhone OS 18_5 like Mac OS X) " +
	"AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.5 Mobile/15E148 Safari/604.1";

const K_COOKIE = "hcnsec_cookie";
const K_TOKEN = "hcnsec_token";
const K_USER = "hcnsec_user";
const K_SIG = "hcnsec_sig";
const K_CLEAR = "hcnsec_clear";
const K_DEBUG = "hcnsec_debug";

/* ------------------------------------------------------------
 *  平台判定（顺序照抄 @nsnanocat/util：$task 优先于 $loon）
 * ---------------------------------------------------------- */
const isQuanX = typeof $task !== "undefined";
const isLoon = typeof $loon !== "undefined";
const isSurgeLike = !isQuanX && !isLoon; // Surge / Stash / Shadowrocket / Egern
const IN_REQUEST = typeof $request !== "undefined";

/* 超时单位：Loon / QX 用毫秒，Surge 系用秒 */
const TIMEOUT = isSurgeLike ? 20 : 20000;

/* ------------------------------------------------------------
 *  存储适配
 * ---------------------------------------------------------- */
const store = {
	read(key) {
		const v = isQuanX ? $prefs.valueForKey(key) : $persistentStore.read(key);
		return v === undefined || v === null ? "" : String(v);
	},
	write(value, key) {
		// 传 undefined / null 表示删除该键；不要用空串删，各平台对 "" 的处理不一致
		if (value === undefined || value === null) {
			if (isQuanX) return $prefs.removeValueForKey(key);
			return $persistentStore.write(null, key);
		}
		return isQuanX ? $prefs.setValueForKey(String(value), key) : $persistentStore.write(String(value), key);
	},
};

function dbg(msg) {
	if (store.read(K_DEBUG) === "true") console.log("[DEBUG] " + msg);
}

/* ------------------------------------------------------------
 *  通知适配
 * ---------------------------------------------------------- */
function notify(title, subtitle, body, attach) {
	try {
		if (isQuanX) $notify(title, subtitle, body, attach);
		else $notification.post(title, subtitle, body, attach);
	} catch (e) {
		console.log("notify failed: " + e.message);
	}
}

/* ------------------------------------------------------------
 *  HTTP 适配
 * ---------------------------------------------------------- */
function http(method, path, headers, body) {
	return new Promise((resolve, reject) => {
		const options = {
			url: BASE_URL + path,
			headers: Object.assign({ "User-Agent": UA, Accept: "application/json" }, headers || {}),
			timeout: TIMEOUT,
		};
		if (body !== undefined) options.body = body;

		const done = (err, resp, data) => {
			if (err) return reject(new Error(typeof err === "string" ? err : "网络错误"));
			const status = resp && (resp.status || resp.statusCode);
			let text = data;
			if (text && typeof text !== "string") {
				try {
					text = new TextDecoder("utf-8").decode(text);
				} catch (_) {
					text = String(text);
				}
			}
			let json = null;
			try {
				json = JSON.parse(text);
			} catch (_) {}
			resolve({ status: status, headers: (resp && resp.headers) || {}, json: json, raw: text });
		};

		try {
			if (isQuanX) {
				options.method = method;
				$task.fetch(options).then(
					(r) => done(null, r, r.body),
					(e) => done(e && (e.error || e.message) ? e.error || e.message : "网络错误")
				);
			} else {
				const fn = $httpClient[method.toLowerCase()];
				if (typeof fn !== "function") return reject(new Error("当前平台不支持 " + method));
				fn(options, (err, resp, data) => done(err, resp, data));
			}
		} catch (e) {
			reject(e);
		}
	});
}

/* ------------------------------------------------------------
 *  凭证工具
 * ---------------------------------------------------------- */

/** 大小写无关地取请求头 */
function pickHeader(headers, name) {
	const target = name.toLowerCase();
	for (const key of Object.keys(headers || {})) {
		if (key.toLowerCase() === target) return String(headers[key]);
	}
	return "";
}

/** Cookie 串归一化：拆对、排序、去空，避免顺序变化被误判成"改了" */
function normalizeCookie(raw) {
	if (!raw) return "";
	const seen = {};
	for (const part of String(raw).split(/;\s*/)) {
		const eq = part.indexOf("=");
		if (eq < 1) continue;
		const k = part.slice(0, eq).trim();
		const v = part.slice(eq + 1).trim();
		if (k) seen[k] = v;
	}
	return Object.keys(seen)
		.sort()
		.map((k) => k + "=" + seen[k])
		.join("; ");
}

/** 从 Cookie 串里挑出会话类 cookie，作为"换没换号"的指纹 */
function sessionSignature(cookie) {
	const found = String(cookie || "")
		.split(/;\s*/)
		.filter((p) => /session/i.test(p.split("=")[0] || ""))
		.sort();
	return found.length ? found.join("; ") : normalizeCookie(cookie);
}

function buildHeaders(cookie, token, userId) {
	const h = { "Content-Type": "application/json", "Accept-Language": "zh-CN,zh;q=0.9" };
	if (cookie) h.Cookie = cookie;
	if (token) h.Authorization = "Bearer " + token;
	if (userId) h["New-API-User"] = String(userId);
	return h;
}

/* ============================================================
 *  分支一：Request Script —— 抓凭证
 * ========================================================== */
function captureCredentials() {
	try {
		const headers = $request.headers || {};
		const rawCookie = pickHeader(headers, "cookie");
		const rawToken = pickHeader(headers, "authorization");
		const userId = pickHeader(headers, "new-api-user");

		dbg("URL: " + $request.url);
		dbg("Header keys: " + Object.keys(headers).join(", "));

		const oldCookie = store.read(K_COOKIE);
		const oldToken = store.read(K_TOKEN);
		const oldUser = store.read(K_USER);

		let changedKind = "";

		if (rawCookie) {
			const next = normalizeCookie(rawCookie);
			if (next !== normalizeCookie(oldCookie)) {
				const beforeSig = sessionSignature(oldCookie);
				const afterSig = sessionSignature(next);
				store.write(next, K_COOKIE);
				if (!beforeSig || beforeSig !== afterSig) changedKind = "cookie";
				else dbg("Cookie 变动但会话未变，静默更新");
			}
		}

		if (rawToken && rawToken !== oldToken) {
			store.write(rawToken, K_TOKEN);
			// token 变更是常态（轮换），只在没有会话 cookie 时才值得提示
			if (!changedKind && !store.read(K_COOKIE)) changedKind = "token";
			dbg("Bearer Token 已更新");
		}

		if (userId && userId !== oldUser) {
			store.write(userId, K_USER);
			dbg("New-API-User 已更新：" + userId);
		}

		const sig = sessionSignature(store.read(K_COOKIE));
		if (sig && sig !== store.read(K_SIG)) {
			store.write(sig, K_SIG);
			if (!changedKind) changedKind = "cookie";
		}

		if (changedKind) {
			notify(
				NAME + " · 凭证已更新",
				"✅ 捕获成功",
				"可以关闭网页了，之后会每天自动签到。\n" +
					"来源：" + (changedKind === "cookie" ? "会话 Cookie" : "Bearer Token") + "\n" +
					"时间：" + clock(Date.now())
			);
		} else {
			dbg("凭证无变化，跳过");
		}
	} catch (e) {
		console.log("[ERROR] capture: " + (e && e.message));
	}
	$done({});
}

/* ============================================================
 *  分支二：Cron / Generic —— 签到
 * ========================================================== */
async function checkin() {
	console.log("[INFO] " + NAME + " 签到 v" + SCRIPT_VERSION);

	// --- 清空开关 ---
	if (/^(true|1)$/i.test(store.read(K_CLEAR))) {
		store.write(undefined, K_COOKIE);
		store.write(undefined, K_TOKEN);
		store.write(undefined, K_USER);
		store.write(undefined, K_SIG);
		store.write("false", K_CLEAR);
		notify(NAME, "🧹 凭证已清空", "请重新打开 api.hcnsec.cn 登录获取");
		return;
	}

	// --- 取凭证 ---
	const cookie = store.read(K_COOKIE);
	const token = store.read(K_TOKEN);
	const userId = store.read(K_USER);

	if (!cookie && !token) {
		notify(NAME, "🚫 尚未获取凭证", "请先打开 api.hcnsec.cn 并登录，再回来运行本脚本");
		return;
	}

	const headers = buildHeaders(cookie, token, userId);

	// --- 可选：先查一次 /api/status 拿计价单位（不影响主流程） ---
	let quotaUnit = null;
	try {
		const st = await http("GET", "/api/status");
		const cfg = st.json && st.json.data;
		if (cfg && cfg.display_in_currency === true && Number(cfg.quota_per_unit) > 0) {
			quotaUnit = Number(cfg.quota_per_unit);
		}
	} catch (_) {}

	// --- 校验凭证 ---
	let me;
	try {
		const self = await http("GET", "/api/user/self", headers);
		dbg("self -> HTTP " + self.status + " " + (self.raw || "").slice(0, 200));

		if (self.json && self.json.success === true && self.json.data) {
			me = self.json.data;
		} else if (self.status === 401 || (self.json && /AUTH_UNAUTHORIZED|invalid access token|无权/i.test(self.raw || ""))) {
			clearCredentials();
			notify(NAME, "❌ 凭证已失效", "会话已过期，请重新打开 api.hcnsec.cn 登录");
			return;
		} else {
			notify(NAME, "⚠️ 身份校验异常", "HTTP " + self.status + "，" + edge(self.raw, 120));
			return;
		}
	} catch (e) {
		// 网络问题不能清凭证
		notify(NAME, "❌ 请求失败", e.message);
		return;
	}

	// --- 账单 ---
	const stats = [];
	stats.push(amount("💳 当前余额", me.quota, quotaUnit));
	stats.push(amount("📉 累计消耗", me.used_quota, quotaUnit));
	if (typeof me.request_count === "number") stats.push("⚡ 累计调用：" + me.request_count + " 次");

	const username = me.username || me.email || "未知";
	const masked = mask(username);

	// --- 真签到 ---
	let award = null;
	let already = false;
	if (enableCheckin()) {
		try {
			const ci = await http("POST", "/api/user/checkin", headers, "{}");
			dbg("checkin -> HTTP " + ci.status + " " + (ci.raw || "").slice(0, 300));
			if (ci.json && ci.json.success === true) {
				const d = ci.json.data;
				if (d && typeof d === "object") {
					const v = d.quota_awarded ?? d.reward ?? d.quota ?? d.amount;
					if (typeof v === "number" && v > 0) award = v;
					if (d.checked_in === true) already = false;
				}
			} else if (ci.json && /已签到|已经签到|already/i.test(String(ci.json.message || ""))) {
				already = true;
			}
		} catch (e) {
			dbg("checkin 调用异常（可能是接口不支持）：" + e.message);
		}
	} else {
		already = true; // 关闭签到 = 只查状态
	}

	// --- 用日志兜底确认今天到底签没签 ---
	const record = await todayCheckinRecord(headers);

	// --- 汇总通知 ---
	// 奖励展示优先用日志里的原文（"签到成功，获得 $0.25" 已经是展示单位，
	// 不能再除以 quota_per_unit），只有日志没记录时才回退到接口返回值。
	const logReward = record ? rewardFrom(record.content) : "";
	const reward = logReward || apiReward(award, quotaUnit);

	if (award !== null || record) {
		notify(
			NAME,
			already ? "✅ 今日已签到" : "✅ 签到成功",
			"👤 账号：" + masked + "\n" +
				"🎁 " + (award !== null ? "本次奖励" : "今日奖励") + "：" + reward + "\n" +
				stats.join("\n") + "\n" +
				"🕒 " + (record ? "签到时间：" + clock(record.created_at * 1000) : "时间：" + clock(Date.now()))
		);
	} else {
		notify(
			NAME,
			"⚠️ 签到状态未确认",
			"👤 账号：" + masked + "\n" +
				stats.join("\n") +
				"\n未能确认今日签到记录，请到网站核对"
		);
	}
}

/** 是否执行真签到：插件 [Argument] 开关优先，其次持久化键，默认开 */
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
		const start = new Date();
		start.setHours(0, 0, 0, 0);
		for (const item of items) {
			const content = String(item.content || "");
			const isCheckin = item.type === 4 || /签到/.test(content);
			if (isCheckin && /签到/.test(content) && item.created_at * 1000 >= start.getTime()) return item;
		}
	} catch (e) {
		dbg("日志查询异常：" + e.message);
	}
	return null;
}

function clearCredentials() {
	store.write(undefined, K_COOKIE);
	store.write(undefined, K_TOKEN);
	store.write(undefined, K_USER);
	store.write(undefined, K_SIG);
}

/* ------------------------------------------------------------
 *  小工具
 * ---------------------------------------------------------- */
function amount(label, value, unit) {
	const n = Number(value);
	if (!isFinite(n)) return label + "：未知";
	return unit ? label + "：$" + (n / unit).toFixed(2) : label + "：" + n;
}
function fmtAward(v, unit) {
	if (typeof v !== "number") return String(v);
	return unit ? "$" + (v / unit).toFixed(2) : v + " 额度";
}
/** 接口返回的额度是原始 quota 单位，需要除以 quota_per_unit */
function apiReward(v, unit) {
	if (v === null || v === undefined) return "未识别";
	return fmtAward(v, unit);
}
/** 日志里的 "获得 $0.25" 已经是展示单位，原样返回，不要再除 */
function rewardFrom(content) {
	const m = String(content || "").match(/\$\s*(\d+(?:\.\d+)?)/);
	return m ? "$" + m[1] : "";
}
function mask(u) {
	const name = String(u).split("@")[0];
	return name.slice(0, 2) + "***";
}
function clock(ts) {
	const d = new Date(ts);
	return [d.getHours(), d.getMinutes(), d.getSeconds()]
		.map((n) => String(n).padStart(2, "0"))
		.join(":");
}
function edge(s, n) {
	const t = String(s || "").replace(/\s+/g, " ");
	return t.length > n ? t.slice(0, n) + "…" : t;
}

/* ============================================================
 *  入口
 * ========================================================== */
if (IN_REQUEST) {
	// 抓凭证：只读、不修改请求
	captureCredentials();
} else {
	checkin()
		.catch((e) => notify(NAME, "❌ 运行失败", (e && e.message) || String(e)))
		.then(() => $done());
}
