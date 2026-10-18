/**
 * ⛽ 全国实时油价查询（Loon 版 v2 · 插件适配）
 * ------------------------------------------------------------------
 * 数据源：http://m.qiyoujiage.com/
 * 原始脚本：Egern Oil_Widget（IBL3ND/module）
 * Loon 适配：mosen
 *
 * ⚠️ Loon 没有「脚本小组件」运行时（Egern 的 ctx.widget / WidgetKit
 *    是 Egern 独有），所以本脚本用【通知】展示油价。
 *    想要真桌面小组件 → Scriptable / Widgy。
 *
 * ─────────────────────────────────────────────────────────────
 * 用法（插件版）
 * ─────────────────────────────────────────────────────────────
 * 装上 oil.lpx 后，插件设置里有：
 *   · 地区          中文（"北京" / "广东-深圳"）或拼音（beijing / guangdong/shenzhen）
 *   · 显示调价趋势  switch
 *   · 推送通知      switch
 *   · 定时          Cron 表达式（默认 0 8,20 * * *）
 *
 * 参数三级优先：插件 [Argument] > persistentStore oil_region > 默认 beijing
 *
 * ─────────────────────────────────────────────────────────────
 * 存储
 * ─────────────────────────────────────────────────────────────
 *   oil_cache       最近一次油价 JSON（断网时回退用）
 *   oil_region      手动填的地区（BoxJS / 旧配置兼容）
 *   oil_debug       "true" 打开调试日志
 */

const SCRIPT_VERSION = "2.0.0";
const NAME = "油价查询";
const K_REGION = "oil_region";
const K_CACHE = "oil_cache";
const K_DEBUG = "oil_debug";
const BASE_URL = "http://m.qiyoujiage.com";

const isQuanX = typeof $task !== "undefined";
const isLoon = typeof $loon !== "undefined";
const TIMEOUT = (isLoon || isQuanX) ? 15000 : 15;

/* 插件 [Argument]（对象）或字符串参数 */
const PLUGIN = (typeof $argument !== "undefined" && $argument && typeof $argument === "object") ? $argument : {};
if (typeof $argument === "string" && $argument.trim()) {
    // 字符串参数 key=value&key=value 解析（支持中文值）
    $argument.split("&").forEach(kv => {
        const i = kv.indexOf("=");
        if (i > 0) {
            const k = kv.slice(0, i).trim();
            let v = kv.slice(i + 1).trim();
            try { v = decodeURIComponent(v); } catch (_) {}
            if (k) PLUGIN[k] = v;
        } else {
            // 整串就是一个地区名（如直接填"贵州-黔东南"）
            PLUGIN.region = kv.trim();
        }
    });
}

/* 中文 → 拼音映射 */
const REGION_MAP = {
    "北京": "beijing", "上海": "shanghai", "天津": "tianjin", "重庆": "chongqing",
    "广东-深圳": "guangdong/shenzhen", "广东-广州": "guangdong/guangzhou",
    "广东-珠海": "guangdong/zhuhai", "广东-佛山": "guangdong/foshan",
    "广东-东莞": "guangdong/dongguan", "广东-中山": "guangdong/zhongshan",
    "广东-惠州": "guangdong/huizhou", "广东-汕头": "guangdong/shantou",
    "江苏": "jiangsu/nanjing", "浙江": "zhejiang/hangzhou", "山东": "shandong/jinan",
    "河南": "henan/zhengzhou", "河北": "hebei/shijiazhuang", "四川": "sichuan/chengdu",
    "湖北": "hubei/wuhan", "湖南": "hunan/changsha", "安徽": "anhui/hefei",
    "福建": "fujian/fuzhou", "江西": "jiangxi/nanchang", "辽宁": "liaoning/shenyang",
    "陕西": "shanxi-3/xian", "海南": "hainan/haikou", "山西": "shanxi-1/taiyuan",
    "吉林": "jilin/changchun", "黑龙江": "heilongjiang/haerbin", "云南": "yunnan/kunming",
    "贵州": "guizhou/guiyang", "贵州-黔东南": "guizhou/qiandongnan",
    "贵州-黔南": "guizhou/qiannan", "贵州-黔西南": "guizhou/qianxinan",
    "贵州-遵义": "guizhou/zunyi", "贵州-安顺": "guizhou/anshun",
    "贵州-毕节": "guizhou/bijie", "贵州-六盘水": "guizhou/liupanshui", "广西": "guangxi/nanning", "甘肃": "gansu/lanzhou",
    "青海": "qinghai/xining", "宁夏": "ningxia/yinchuan", "新疆": "xinjiang/wulumuqi",
    "西藏": "xizang/lasa", "内蒙古": "neimenggu/huhehaote",
};

/* ────────────────── 存储适配 ────────────────── */
function readKey(k) {
    const v = isQuanX ? $prefs.valueForKey(k) : $persistentStore.read(k);
    return v === undefined || v === null ? "" : String(v);
}
function writeKey(v, k) {
    if (v === undefined || v === null) {
        if (isQuanX) return $prefs.removeValueForKey(k);
        return $persistentStore.write(null, k);
    }
    return isQuanX ? $prefs.setValueForKey(String(v), k) : $persistentStore.write(String(v), k);
}
function debugOn() {
    if (typeof PLUGIN.debug === "boolean") return PLUGIN.debug;
    if (typeof PLUGIN.debug === "string") return /^(true|1)$/i.test(PLUGIN.debug);
    return readKey(K_DEBUG) === "true";
}
function dbg(m) { if (debugOn()) console.log("[DEBUG] " + m); }

/* ────────────────── 通知 ────────────────── */
function notify(title, body, opts) {
    if (typeof PLUGIN.notify === "boolean" && !PLUGIN.notify) return;
    if (typeof PLUGIN.notify === "string" && /^(false|0)$/i.test(PLUGIN.notify)) return;
    try {
        if (isQuanX) {
            // QX: $notify(title, subtitle, body, opts) — subtitle 放 title 里，opts 用 open-url
            const qxOpts = opts && opts.openUrl ? { "open-url": opts.openUrl } : undefined;
            $notify(NAME, title, body, qxOpts);
        } else {
            // Loon/Surge: $notification.post(title, subtitle, body, attach)
            $notification.post(NAME, title, body, opts);
        }
    } catch (e) {
        console.log("notify failed: " + (e && e.message));
    }
}

/* ────────────────── HTTP ────────────────── */
function httpGet(url) {
    return new Promise((resolve, reject) => {
        const opts = {
            url,
            headers: { referer: BASE_URL + "/", "user-agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64)" },
            timeout: TIMEOUT,
        };
        const cb = (err, resp, data) => {
            if (err) {
                const detail = typeof err === "string" ? err : ((err && (err.message || err.error)) || "unknown");
                dbg("httpGet err: " + detail);
                return reject(new Error("网络请求失败" + (debugOn() ? "（" + detail + "）" : "")));
            }
            const status = resp && (resp.status || resp.statusCode);
            let text = data;
            if (text && typeof text !== "string") {
                try { text = new TextDecoder("utf-8").decode(text); } catch (_) { text = String(text); }
            }
            resolve({ status, text });
        };
        if (isQuanX) {
            opts.method = "GET";
            $task.fetch(opts).then(r => cb(null, r, r.body), e => cb(e && (e.error || e) || e));
        } else {
            $httpClient.get(opts, cb);
        }
    });
}

/* ────────────────── 地区解析 ────────────────── */
function resolveRegion(input) {
    const i = String(input || "").trim();
    if (!i) return "";
    if (REGION_MAP[i]) return REGION_MAP[i];
    return i; // 拼音直传
}

/* ────────────────── HTML 解析 ────────────────── */
function parseOil(html) {
    const out = { p92: null, p95: null, p98: null, diesel: null, regionName: "", trendInfo: "" };

    const titleMatch = html.match(/<title>([^_]+)_/);
    if (titleMatch && titleMatch[1]) {
        out.regionName = titleMatch[1].trim().replace(/(油价|实时|今日|最新|查询|价格)/g, "").trim();
    }

    const regPrice = /<dl>[\s\S]+?<dt>(.*油)<\/dt>[\s\S]+?<dd>(.*)\(元\)<\/dd>/gm;
    const nameMap = { "92": "p92", "95": "p95", "98": "p98", "0 号": "diesel", "柴油": "diesel" };
    let m;
    while ((m = regPrice.exec(html)) !== null) {
        const name = m[1].trim();
        const val = parseFloat(m[2].trim());
        if (isNaN(val)) continue;
        const key = Object.keys(nameMap).find(k => name.includes(k));
        if (key) out[nameMap[key]] = val;
    }

    const regTrend = /<div class="tishi">[\s\S]*?<span>([^<]+)<\/span>[\s\S]*?<br\/>([\s\S]+?)<br\/>/;
    const tm = html.match(regTrend);
    if (tm) {
        const span = tm[1].replace(/<[^>]+>/g, "").trim();
        const body = tm[2].replace(/<[^>]+>/g, "").replace(/\s+/g, " ").trim();
        out.trendInfo = `${span} ${body}`.trim();
    }
    return out;
}

/* ────────────────── 主流程 ────────────────── */
async function main() {
    console.log(`[INFO] ${NAME} v${SCRIPT_VERSION}`);

    // 地区三级优先：插件 > oil_region 键 > beijing
    let region = resolveRegion(String((PLUGIN.region !== undefined && PLUGIN.region !== null) ? PLUGIN.region : "").trim());
    if (!region) region = resolveRegion(readKey(K_REGION));
    if (!region) region = "beijing";
    dbg("region = " + region);

    // 趋势开关
    let showTrend = true;
    if (typeof PLUGIN.show_trend === "boolean") showTrend = PLUGIN.show_trend;
    else if (typeof PLUGIN.show_trend === "string") showTrend = !/^(false|0)$/i.test(PLUGIN.show_trend);
    else if (readKey("oil_show_trend") === "false") showTrend = false;

    const url = BASE_URL + "/" + region + ".shtml";
    const cache = (() => { try { return JSON.parse(readKey(K_CACHE) || "null"); } catch (_) { return null; } })();

    let oil;
    let fromCache = false;
    try {
        const resp = await httpGet(url);
        if (resp.status !== 200) throw new Error(`HTTP ${resp.status}`);
        oil = parseOil(resp.text);
        if (oil.p92 === null && oil.p95 === null && oil.diesel === null) throw new Error("页面解析失败");
        writeKey(JSON.stringify({ ...oil, region, ts: Date.now() }), K_CACHE);
        dbg("抓取成功");
    } catch (e) {
        dbg("抓取失败: " + e.message);
        if (cache && (cache.p92 !== null || cache.p95 !== null)) {
            oil = cache;
            fromCache = true;
            dbg("使用缓存（" + new Date(cache.ts).toLocaleString() + "）");
        } else {
            notify("❌ 油价查询失败", e.message + "\n请检查地区拼写或稍后重试");
            return;
        }
    }

    // 组装通知正文：压到 3 行内（iOS 折叠只显示约 4 行，超了会被截断）
    const lines = [];
    const f2 = v => (v === null || v === undefined) ? "--" : v.toFixed(2);
    lines.push("🟠92 " + f2(oil.p92) + "  🟡95 " + f2(oil.p95));
    lines.push("🔴98 " + f2(oil.p98) + "  🟢柴 " + f2(oil.diesel));
    if (showTrend && oil.trendInfo) {
        lines.push("📈 " + oil.trendInfo.replace(/油价|调整，|，维持目前价格不变。?/g, "").trim().slice(0, 40));
    } else if (fromCache) {
        lines.push("⚠️ 数据来自缓存");
    }

    // 点击通知打开原网页，能看到完整信息
    const openUrl = BASE_URL + "/" + region + ".shtml";

    // 数据同时写进 Loon 脚本日志（点脚本记录能看到）
    console.log(`[DATA] ${oil.regionName || region}  92=${f2(oil.p92)}  95=${f2(oil.p95)}  98=${f2(oil.p98)}  柴油=${f2(oil.diesel)}`);
    if (oil.trendInfo) console.log("[DATA] " + oil.trendInfo);

    notify((oil.regionName || region) + " 今日油价", lines.join("\n"), { openUrl: openUrl });
}

main()
    .catch(e => notify("❌ " + NAME, (e && e.message) || String(e)))
    .then(() => $done());
