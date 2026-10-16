/**
 * HCNSEC · JWT Token 模式签到
 *
 * @Author: mosen
 * @Updated: 2026-10-16
 */

const $ = new Env("HCNSEC");
const SCRIPT_VERSION = "2026-10-16.r3";

const TOKEN_KEY = "hcnsec_token";
const CLEAR_KEY = "hcnsec_clear";

const BASE_URL = "https://api.hcnsec.cn";
const UA = "Mozilla/5.0 (iPhone; CPU iPhone OS 18_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.5 Mobile/15E148 Safari/604.1";

const isRequest = typeof $request !== "undefined";

if (isRequest) {
    getToken();
} else {
    run().catch((e) => $.msg($.name, "❌ 运行失败", e.message)).finally(() => $.done());
}

function getToken() {
    try {
        const headers = $request.headers;
        // 兼容大小写
        const auth = headers["Authorization"] || headers["authorization"] || "";
        
        if (!auth.startsWith("Bearer ")) {
            $.done({});
            return;
        }
        
        const token = auth.substring(7); // 去掉 "Bearer "
        const oldToken = $.getdata(TOKEN_KEY) || "";
        
        if (token && token !== oldToken) {
            $.setdata(token, TOKEN_KEY);
            $.msg($.name, "✅ Token 获取成功", "可以关闭网页了，之后会自动签到");
        }
    } catch (e) {
        $.log(`[ERROR] 获取 Token 失败: ${e.message}`);
    }
    $.done({});
}

async function run() {
    $.log(`[INFO] 脚本版本 ${SCRIPT_VERSION}`);
    
    const clear = $.getdata(CLEAR_KEY);
    if (clear === "true" || clear === "1") {
        $.setdata("", TOKEN_KEY);
        $.setdata("false", CLEAR_KEY);
        $.msg($.name, "✅ Token 已清除", "请重新打开网页登录获取");
        return;
    }
    
    const token = $.getdata(TOKEN_KEY);
    if (!token) {
        $.msg($.name, "🚫 未获取 Token", "请先打开 api.hcnsec.cn 网页登录");
        return;
    }
    
    // 检查 JWT 是否过期
    try {
        const payload = JSON.parse(atob(token.split(".")[1]));
        const exp = payload.exp * 1000;
        if (Date.now() > exp) {
            $.setdata("", TOKEN_KEY);
            $.msg($.name, "❌ Token 已过期", "请重新打开网页登录获取");
            return;
        }
    } catch (_) {}
    
    let quotaUnit = null;
    try {
        const status = await request("GET", "/api/status", {}, "配置查询");
        if (status.success && status.data && status.data.display_in_currency && status.data.quota_per_unit > 0) {
            quotaUnit = status.data.quota_per_unit;
        }
    } catch (_) {}
    
    const headers = {
        "User-Agent": UA,
        Accept: "application/json",
        Authorization: `Bearer ${token}`,
        Referer: `${BASE_URL}/console`,
    };
    
    let userInfo;
    try {
        userInfo = await request("GET", "/api/user/self", headers, "用户查询");
        if (!userInfo.success) {
            $.setdata("", TOKEN_KEY);
            $.msg($.name, "❌ Token 已失效", "请重新打开网页登录获取");
            return;
        }
    } catch (e) {
        $.msg($.name, "❌ 请求失败", e.message);
        return;
    }
    
    const user = userInfo.data;
    const stats = [
        formatAmount("💳 当前余额", user.quota, quotaUnit),
        formatAmount("📉 累计消耗", user.used_quota, quotaUnit),
    ];
    if (typeof user.request_count === "number") {
        stats.push(`⚡ 累计调用：${user.request_count} 次`);
    }
    
    let checkinRecord = null;
    try {
        const logs = await request("GET", "/api/log/self?p=1&page_size=20", headers, "签到记录");
        if (logs.success && logs.data && Array.isArray(logs.data.items)) {
            checkinRecord = findTodayCheckin(logs.data.items);
        }
    } catch (_) {}
    
    const username = user.username || user.email || "未知";
    
    if (checkinRecord) {
        const time = new Date(checkinRecord.created_at * 1000);
        const clock = [time.getHours(), time.getMinutes(), time.getSeconds()].map(n => String(n).padStart(2, "0")).join(":");
        const reward = formatReward(checkinRecord.content);
        $.msg($.name, "✅ 今日已签到", `👤 账号：${maskAccount(username)}\n${reward}\n${stats.join("\n")}\n🕒 签到时间：${clock}`);
    } else {
        $.msg($.name, "⚠️ 签到状态未确认", `👤 账号：${maskAccount(username)}\n${stats.join("\n")}\n请到网站核对签到记录`);
    }
}

function request(method, path, headers, label) {
    return new Promise((resolve, reject) => {
        const options = {
            url: BASE_URL + path,
            headers: { "User-Agent": UA, Accept: "application/json", ...headers },
        };
        $.send(options, method, (err, resp, text) => {
            if (err) return reject(new Error(`${label}网络错误`));
            try {
                resolve(JSON.parse(text));
            } catch (_) {
                reject(new Error(`${label}响应异常`));
            }
        });
    });
}

function findTodayCheckin(items) {
    const start = new Date();
    start.setHours(0, 0, 0, 0);
    for (const item of items) {
        if (item.type === 4 && item.content && item.content.includes("签到成功") && item.created_at * 1000 >= start.getTime()) {
            return item;
        }
    }
    return null;
}

function formatAmount(label, value, quotaUnit) {
    if (typeof value !== "number") return `${label}：--`;
    return quotaUnit ? `${label}：$${(value / quotaUnit).toFixed(2)}` : `${label}：${value}`;
}

function formatReward(content) {
    const match = content.match(/\$\s*(\d+(?:\.\d+)?)/);
    return `🎁 今日奖励：${match ? "$" + match[1] : "未识别"}`;
}

function maskAccount(u) {
    const name = (u || "").split("@")[0];
    return name.length > 3 ? `${name.slice(0, 2)}***` : `${name}***`;
}

function Env(s) {
    this.name = s;
    this.isSurge = () => typeof $httpClient !== "undefined";
    this.isQuanX = () => typeof $task !== "undefined";
    this.isLoon = () => typeof $loon !== "undefined";
    this.log = (...a) => console.log(a.join("\n"));
    this.msg = (t, s, b) => {
        if (this.isSurge() || this.isLoon()) $notification.post(t, s, b);
        else if (this.isQuanX()) $notify(t, s, b);
        console.log(`====📣${t}====\n${s}\n${b}`);
    };
    this.getdata = (k) => {
        if (this.isSurge() || this.isLoon()) return $persistentStore.read(k);
        if (this.isQuanX()) return $prefs.valueForKey(k);
        return null;
    };
    this.setdata = (v, k) => {
        if (this.isSurge() || this.isLoon()) return $persistentStore.write(v, k);
        if (this.isQuanX()) return $prefs.setValueForKey(v, k);
        return false;
    };
    this.send = (req, method, cb) => {
        if (this.isSurge() || this.isLoon()) {
            const fn = method === "POST" ? $httpClient.post : $httpClient.get;
            fn(req, (err, resp, data) => cb(err, resp, data));
        } else if (this.isQuanX()) {
            req.method = method;
            $task.fetch(req).then(r => cb(null, r, r.body), e => cb(e));
        }
    };
    this.done = (v = {}) => { if (typeof $done !== "undefined") $done(v); };
}
