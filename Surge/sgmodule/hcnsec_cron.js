/**
 * HCNSEC · JWT Token 模式签到 (Loon 专用)
 * @Updated: 2026-10-16 v4
 */

const $ = new Env("HCNSEC");
const TOKEN_KEY = "hcnsec_token";
const CLEAR_KEY = "hcnsec_clear";
const BASE_URL = "https://api.hcnsec.cn";
const UA = "Mozilla/5.0 (iPhone; CPU iPhone OS 18_5 like Mac OS X) AppleWebKit/605.1.15";

const isRequest = typeof $request !== "undefined";

if (isRequest) {
    getToken();
} else {
    run().catch((e) => $.msg($.name, "❌ 运行失败", e.message)).finally(() => $.done());
}

function getToken() {
    try {
        const headers = $request.headers || {};
        // 遍历所有 header key，不区分大小写找 authorization
        let auth = "";
        for (const key of Object.keys(headers)) {
            if (key.toLowerCase() === "authorization") {
                auth = headers[key];
                break;
            }
        }
        
        console.log("Headers: " + JSON.stringify(headers));
        console.log("Found auth: " + auth);
        
        if (!auth || !auth.startsWith("Bearer ")) {
            console.log("No Bearer token found");
            $done({});
            return;
        }
        
        const token = auth.substring(7);
        const oldToken = $persistentStore.read(TOKEN_KEY) || "";
        
        if (token && token !== oldToken) {
            $persistentStore.write(token, TOKEN_KEY);
            $notification.post($.name, "✅ Token 获取成功", "可以关闭网页了，之后会自动签到");
        } else {
            console.log("Token unchanged or empty");
        }
    } catch (e) {
        console.log("[ERROR] " + e.message);
    }
    $done({});
}

async function run() {
    console.log("[INFO] HCNSEC 签到 v4");
    
    const clear = $persistentStore.read(CLEAR_KEY);
    if (clear === "true" || clear === "1") {
        $persistentStore.write("", TOKEN_KEY);
        $persistentStore.write("false", CLEAR_KEY);
        $notification.post($.name, "✅ Token 已清除", "请重新打开网页登录获取");
        return;
    }
    
    const token = $persistentStore.read(TOKEN_KEY);
    if (!token) {
        $notification.post($.name, "🚫 未获取 Token", "请先打开 api.hcnsec.cn 网页登录");
        return;
    }
    
    // 检查 JWT 过期
    try {
        const payload = JSON.parse(atob(token.split(".")[1]));
        if (Date.now() > payload.exp * 1000) {
            $persistentStore.write("", TOKEN_KEY);
            $notification.post($.name, "❌ Token 已过期", "请重新打开网页登录获取");
            return;
        }
    } catch (_) {}
    
    let quotaUnit = null;
    try {
        const status = await httpGet("/api/status", {});
        if (status.success && status.data && status.data.quota_per_unit > 0) {
            quotaUnit = status.data.quota_per_unit;
        }
    } catch (_) {}
    
    const headers = {
        Authorization: `Bearer ${token}`,
        Accept: "application/json",
        "User-Agent": UA,
    };
    
    let userInfo;
    try {
        userInfo = await httpGet("/api/user/self", headers);
        if (!userInfo.success) {
            $persistentStore.write("", TOKEN_KEY);
            $notification.post($.name, "❌ Token 已失效", "请重新打开网页登录获取");
            return;
        }
    } catch (e) {
        $notification.post($.name, "❌ 请求失败", e.message);
        return;
    }
    
    const user = userInfo.data;
    const stats = [];
    if (quotaUnit) {
        stats.push(`💳 当前余额：$${(user.quota / quotaUnit).toFixed(2)}`);
        stats.push(`📉 累计消耗：$${(user.used_quota / quotaUnit).toFixed(2)}`);
    } else {
        stats.push(`💳 当前余额：${user.quota}`);
        stats.push(`📉 累计消耗：${user.used_quota}`);
    }
    if (typeof user.request_count === "number") {
        stats.push(`⚡ 累计调用：${user.request_count} 次`);
    }
    
    let checkinRecord = null;
    try {
        const logs = await httpGet("/api/log/self?p=1&page_size=20", headers);
        if (logs.success && logs.data && Array.isArray(logs.data.items)) {
            const start = new Date();
            start.setHours(0, 0, 0, 0);
            for (const item of logs.data.items) {
                if (item.type === 4 && item.content && item.content.includes("签到成功") && item.created_at * 1000 >= start.getTime()) {
                    checkinRecord = item;
                    break;
                }
            }
        }
    } catch (_) {}
    
    const username = user.username || user.email || "未知";
    const masked = username.split("@")[0].slice(0, 2) + "***";
    
    if (checkinRecord) {
        const time = new Date(checkinRecord.created_at * 1000);
        const clock = [time.getHours(), time.getMinutes(), time.getSeconds()].map(n => String(n).padStart(2, "0")).join(":");
        const match = checkinRecord.content.match(/\$\s*(\d+(?:\.\d+)?)/);
        const reward = match ? `$${match[1]}` : "未识别";
        $notification.post($.name, "✅ 今日已签到", `👤 账号：${masked}\n🎁 今日奖励：${reward}\n${stats.join("\n")}\n🕒 签到时间：${clock}`);
    } else {
        $notification.post($.name, "⚠️ 签到状态未确认", `👤 账号：${masked}\n${stats.join("\n")}\n请到网站核对签到记录`);
    }
}

function httpGet(path, headers) {
    return new Promise((resolve, reject) => {
        $httpClient.get({
            url: BASE_URL + path,
            headers: { "User-Agent": UA, Accept: "application/json", ...headers },
        }, (err, resp, data) => {
            if (err) return reject(new Error("网络错误"));
            try {
                resolve(JSON.parse(data));
            } catch (_) {
                reject(new Error("响应异常"));
            }
        });
    });
}

function Env(s) { this.name = s; }
