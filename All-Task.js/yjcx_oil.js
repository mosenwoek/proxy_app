/**
 * ⛽ 全国实时油价查询（Loon 版）
 * ------------------------------------------------------------------
 * 数据源：http://m.qiyoujiage.com/（同 Egern Oil_Widget 原作者）
 * 适配：mosen —— 从 Egern 小组件脚本移植到 Loon
 *
 * ⚠️ 重要说明（先读这个）
 * ------------------------------------------------------------------
 * Loon 没有「脚本小组件」运行时 —— Loon 的脚本体系只有
 * request / response / cron / network-changed / generic 五种，
 * 没有 Egern 那种 export default async function(ctx) 的 widget 环境，
 * 所以「小组件」这个形态 Loon 做不了，这是平台能力差异，不是适配问题。
 *
 * 本脚本能做到的：抓取油价 → 通知展示 / 存 BoxJS 供查询。
 * 想要真正的 iOS 桌面小组件 → 用 Scriptable / Widgy（我可以另写）。
 *
 * ─────────────────────────────────────────────────────────────
 * 用法
 * ─────────────────────────────────────────────────────────────
 * ① Loon 本地脚本 / 插件里，挂成 generic 或 cron：
 *    generic then script("...", "beijing")   ← 手动点一下查北京
 *    cron "0 8 * * *" then script("...", "guangdong/shenzhen")
 *
 * ② 地区参数三级优先：
 *    $argument 字符串 > persistentStore 键 oil_region > 默认 beijing
 *
 * ③ 地区代码对照（同原版，拼音）：
 *    beijing / shanghai / tianjin / chongqing
 *    guangdong/guangzhou、guangdong/shenzhen …
 *    完整对照见 http://m.qiyoujiage.com/ 各省拼音
 *    也可直接填中文（如"北京"、"广东-深圳"，脚本内置映射）
 */

const SCRIPT_VERSION = "1.0.0";
const NAME = "油价查询";
const K_REGION = "oil_region";
const K_CACHE = "oil_cache";
const K_DEBUG = "oil_debug";

/* 中文 → 拼音映射（原版 REGION_MAP / CITY_MAP 精简版，可按需补） */
const REGION_MAP = {
    "北京": "beijing", "上海": "shanghai", "天津": "tianjin", "重庆": "chongqing",
    "广东-深圳": "guangdong/shenzhen", "广东-广州": "guangdong/guangzhou",
    "江苏": "jiangsu/nanjing", "浙江": "zhejiang/hangzhou", "山东": "shandong/jinan",
    "河南": "henan/zhengzhou", "河北": "hebei/shijiazhuang", "四川": "sichuan/chengdu",
    "湖北": "hubei/wuhan", "湖南": "hunan/changsha", "安徽": "anhui/hefei",
    "福建": "fujian/fuzhou", "江西": "jiangxi/nanchang", "辽宁": "liaoning/shenyang",
    "陕西": "shanxi-3/xian", "海南": "hainan/haikou", "山西": "shanxi-1/taiyuan",
    "吉林": "jilin/changchun", "黑龙江": "heilongjiang/haerbin", "云南": "yunnan/kunming",
    "贵州": "guizhou/guiyang", "广西": "guangxi/nanning", "甘肃": "gansu/lanzhou",
    "青海": "qinghai/xining", "宁夏": "ningxia/yinchuan", "新疆": "xinjiang/wulumuqi",
    "西藏": "xizang/lasa", "内蒙古": "neimenggu/huhehaote",
};

const isQuanX = typeof $task !== "undefined";
const isLoon = typeof $loon !== "undefined";

function readKey(k) {
    if (isQuanX) return $prefs.valueForKey(k);
    return $persistentStore.read(k);
}
function writeKey(v, k) {
    if (isQuanX) return $prefs.setValueForKey(String(v), k);
    return $persistentStore.write(String(v), k);
}
function dbg(m) {
    if (readKey(K_DEBUG) === "true") console.log("[DEBUG] " + m);
}

function httpGet(url) {
    return new Promise((resolve, reject) => {
        const opts = { url, headers: { referer: "http://m.qiyoujiage.com/", "user-agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64)" }, timeout: isQuanX ? 15000 : 15 };
        const cb = (err, resp, data) => {
            if (err) return reject(new Error("网络请求失败"));
            const status = resp && (resp.status || resp.statusCode);
            let text = data;
            if (text && typeof text !== "string") { try { text = new TextDecoder("utf-8").decode(text); } catch (_) { text = String(text); } }
            resolve({ status, text });
        };
        if (isQuanX) {
            opts.method = "GET";
            $task.fetch(opts).then(r => cb(null, r, r.body), e => cb(e));
        } else {
            $httpClient.get(opts, cb);
        }
    });
}

function resolveRegion(input) {
    const i = String(input || "").trim();
    if (!i) return "";
    if (REGION_MAP[i]) return REGION_MAP[i];
    return i; // 拼音直传
}

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

    // 趋势（可选，尽量解析）
    const regTrend = /<div class="tishi">[\s\S]*?<span>([^<]+)<\/span>[\s\S]*?<br\/>([\s\S]+?)<br\/>/;
    const tm = html.match(regTrend);
    if (tm) {
        const span = tm[1].replace(/<[^>]+>/g, "").trim();
        const body = tm[2].replace(/<[^>]+>/g, "").replace(/\s+/g, " ").trim();
        const trend = /下调|下跌/.test(body) ? "↓" : "↑";
        out.trendInfo = `${span} ${trend} ${body}`.trim();
    }
    return out;
}

async function main() {
    console.log(`[INFO] ${NAME} v${SCRIPT_VERSION}`);

    // 地区：$argument > persistentStore > 默认北京
    let arg = typeof $argument !== "undefined" ? $argument : "";
    if (arg && typeof arg === "object") arg = arg.region || "";
    let region = resolveRegion(String(arg || "").trim());
    if (!region) region = resolveRegion(readKey(K_REGION));
    if (!region) region = "beijing";
    dbg("region = " + region);

    const url = `http://m.qiyoujiage.com/${region}.shtml`;
    const cache = (() => { try { return JSON.parse(readKey(K_CACHE) || "null"); } catch (_) { return null; } })();

    let oil;
    try {
        const resp = await httpGet(url);
        if (resp.status !== 200) throw new Error(`HTTP ${resp.status}`);
        oil = parseOil(resp.text);
        if (oil.p92 === null && oil.p95 === null && oil.diesel === null) throw new Error("解析失败");
        writeKey(JSON.stringify({ ...oil, region, ts: Date.now() }), K_CACHE);
    } catch (e) {
        dbg("抓取失败: " + e.message);
        if (cache && cache.p92 !== null) {
            oil = cache;
            dbg("使用缓存");
        } else {
            notify("❌ 油价查询失败", e.message);
            return;
        }
    }

    const lines = [];
    lines.push(`⛽ ${oil.regionName || region}`);
    lines.push("");
    const rows = [["92 号", oil.p92, "🟠"], ["95 号", oil.p95, "🟡"], ["98 号", oil.p98, "🔴"], ["0 号柴油", oil.diesel, "🟢"]];
    for (const [label, val, dot] of rows) {
        if (val !== null && val !== undefined) lines.push(`${dot} ${label}：${val.toFixed(2)} 元/升`);
    }
    if (oil.trendInfo) {
        lines.push("");
        lines.push(`📈 ${oil.trendInfo}`);
    }
    notify(`${oil.regionName || region} 今日油价`, lines.join("\n"));
}

function notify(title, body) {
    try {
        if (isQuanX) $notify(NAME, title, body);
        else $notification.post(NAME, title, body);
    } catch (e) {
        console.log("notify failed: " + e.message);
    }
}

main().catch(e => notify("❌ " + NAME, e.message)).then(() => $done());
