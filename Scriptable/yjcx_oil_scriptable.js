// 变量：桌面油价小组件 v3（Scriptable 独立版）
// 维护：mosen[https://github.com/mosenwoek],moyan[https://t.me/tgxiaoxizf_bot]
// 双源合并：
//   · qiyoujiage 城市页 → 地级市精确价格 + 下次调价预告
//   · eastmoney 数据中心 → 涨跌额 + 上次调价日 + 6 期历史（省级口径，涨跌全国统一）
// 用法：
//   1. 粘贴进 Scriptable 新建脚本
//   2. 桌面添加 Scriptable 小组件 → 长按 → 参数填地区
//      地级市：贵州-黔东南 / 广东-深圳    拼音：guizhou/qiandongnan
//      省级：贵州 / 广东 / 北京
//   3. 不填参数默认 贵州-黔东南
// 版本：3.0.0

const NAME = "油价";
const VERSION = "3.0.0";
const EM_API = "https://datacenter-web.eastmoney.com/api/data/v1/get";
const HTML_BASE = "http://m.qiyoujiage.com";
const CACHE_FILE = "oil_widget_cache_v3.json";
const REGION_FILE = "oil_widget_region_v3.txt";

// ────────── 中文地区 → qiyoujiage 拼音路径 ──────────
const CITY_MAP = {
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
  "贵州-毕节": "guizhou/bijie", "贵州-六盘水": "guizhou/liupanshui",
  "广西": "guangxi/nanning", "甘肃": "gansu/lanzhou",
  "青海": "qinghai/xining", "宁夏": "ningxia/yinchuan", "新疆": "xinjiang/wulumuqi",
  "西藏": "xizang/lasa", "内蒙古": "neimenggu/huhehaote",
};

// 拼音前缀 → 省份（东财用省份）
const PY2PROV = {
  beijing:"北京", shanghai:"上海", tianjin:"天津", chongqing:"重庆",
  guangdong:"广东", jiangsu:"江苏", zhejiang:"浙江", shandong:"山东",
  henan:"河南", hebei:"河北", sichuan:"四川", hubei:"湖北", hunan:"湖南",
  anhui:"安徽", fujian:"福建", jiangxi:"江西", liaoning:"辽宁",
  "shanxi-3":"陕西", "shanxi-1":"山西", hainan:"海南", jilin:"吉林",
  heilongjiang:"黑龙江", yunnan:"云南", guizhou:"贵州", guangxi:"广西",
  gansu:"甘肃", qinghai:"青海", ningxia:"宁夏", xinjiang:"新疆",
  xizang:"西藏", neimenggu:"内蒙古",
};
const PROVINCES = ["北京","天津","上海","重庆","河北","山西","辽宁","吉林","黑龙江","江苏","浙江","安徽","福建","江西","山东","河南","湖北","湖南","广东","海南","四川","贵州","云南","陕西","甘肃","青海","台湾","内蒙古","广西","西藏","宁夏","新疆"];

// ────────── 存储 ──────────
const fm = FileManager.local();
const docDir = fm.documentsDirectory();
const cachePath = fm.joinPath(docDir, CACHE_FILE);
const regionPath = fm.joinPath(docDir, REGION_FILE);

function loadCache() { try { if (fm.fileExists(cachePath)) return JSON.parse(fm.readString(cachePath)); } catch (_) {} return null; }
function saveCache(d) { try { fm.writeString(cachePath, JSON.stringify(d)); } catch (_) {} }
function loadRegion() { try { if (fm.fileExists(regionPath)) return fm.readString(regionPath).trim(); } catch (_) {} return ""; }
function saveRegion(r) { try { fm.writeString(regionPath, r); } catch (_) {} }

// ────────── 油品 ──────────
const FUELS = [
  { id: "92", label: "92号", hex: "#F97316" },
  { id: "95", label: "95号", hex: "#3B82F6" },
  { id: "98", label: "98号", hex: "#EF4444" },
  { id: "0",  label: "柴油", hex: "#10B981" },
];
const ORDER = ["92", "95", "98", "0"];

function visibleFuels(oil, limit) {
  const list = ORDER.map(id => FUELS.find(f => f.id === id))
    .filter(f => f && oil.data[f.id] && oil.data[f.id].price !== null && oil.data[f.id].price !== undefined);
  return limit ? list.slice(0, limit) : list;
}

// ────────── 主题 ──────────
function theme() {
  let dark = false;
  try { dark = Device.isUsingDarkAppearance(); } catch (_) {}
  return {
    dark,
    bg:   Color.dynamic(new Color("#FFFFFF"), new Color("#0E1116")),
    card: Color.dynamic(new Color("#F2F4F8"), new Color("#1A2230")),
    main: Color.dynamic(new Color("#0F172A"), new Color("#F8FAFC")),
    sub:  Color.dynamic(new Color("#64748B"), new Color("#93A1B5")),
    up:   Color.dynamic(new Color("#DC2626"), new Color("#F87171")),
    down: Color.dynamic(new Color("#059669"), new Color("#34D399")),
    flat: Color.dynamic(new Color("#94A3B8"), new Color("#64748B")),
    fail: Color.dynamic(new Color("#DC2626"), new Color("#F87171")),
  };
}

function tintGradient(hex, dark) {
  const g = new LinearGradient();
  g.colors = [new Color(hex, dark ? 0.22 : 0.14), new Color(hex, dark ? 0.04 : 0.02)];
  g.locations = [0, 1];
  g.startPoint = new Point(0, 0);
  g.endPoint = new Point(1, 0);
  return g;
}

// ────────── 尺寸 ──────────
function metrics(family) {
  let sw = 390;
  try { const s = Device.screenSize(); sw = Math.round(Math.min(s.width, s.height)); } catch (_) {}
  const table = [[430,364],[428,364],[414,360],[402,350],[393,338],[390,338],[375,329],[360,320],[320,292]];
  let mw = 329;
  for (const [s, w] of table) { if (sw >= s) { mw = w; break; } }
  if (family === "small") { const s = Math.round(mw * 0.467); return { w: s, h: s }; }
  if (family === "large") return { w: mw, h: Math.round(mw * 1.04) };
  return { w: mw, h: Math.round(mw * 0.47) };
}

// ────────── 地区解析 ──────────
function resolveRegion(raw) {
  const i = String(raw || "").trim();
  const out = { cityPath: "", province: "", label: i };
  if (!i) return out;

  // 中文地级市 / 省级
  if (CITY_MAP[i]) {
    out.cityPath = CITY_MAP[i];
    out.province = PY2PROV[out.cityPath.split("/")[0]] || "";
    return out;
  }
  // 拼音路径
  if (i.includes("/")) {
    out.cityPath = i;
    out.province = PY2PROV[i.split("/")[0]] || "";
    return out;
  }
  // 纯省份中文
  if (PROVINCES.includes(i)) { out.province = i; return out; }
  // 纯拼音省份
  const p = PY2PROV[i];
  if (p) { out.province = p; return out; }
  // 省份-城市 拆分
  const first = i.split("-")[0];
  if (PROVINCES.includes(first)) { out.province = first; return out; }
  return out;
}

// ────────── 源 1：东方财富（涨跌 + 上次调价 + 历史） ──────────
async function fetchEastMoney(province) {
  if (!province) throw new Error("无省份");
  const filter = encodeURIComponent(`(CITYNAME="${province}")`);
  const url = `${EM_API}?reportName=RPTA_WEB_YJ_JH&columns=ALL&filter=${filter}`
    + `&sortColumns=DIM_DATE&sortTypes=-1&pageNumber=1&pageSize=6&source=WEB&_=${Date.now()}`;
  const req = new Request(url);
  req.headers = { "Referer": "https://data.eastmoney.com/", "User-Agent": "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X)" };
  req.timeoutInterval = 15;
  const json = await req.loadJSON();
  const rows = json && json.result && json.result.data;
  if (!rows || !rows.length) throw new Error("东财无该省数据");

  const latest = rows[0];
  const out = { prices: {}, zde: {}, hist: {}, lastDate: (latest.DIM_DATE || "").slice(0, 10) };
  ["92", "95", "98", "0"].forEach(id => {
    const v = latest[`V${id}`];
    if (v !== null && v !== undefined) out.prices[id] = Number(v);
    const z = latest[`ZDE${id}`];
    if (z !== null && z !== undefined) out.zde[id] = Number(z);
    const h = rows.map(r => r[`V${id}`]).filter(x => x !== null && x !== undefined).map(Number).reverse();
    if (h.length) out.hist[id] = h;
  });
  return out;
}

// ────────── 源 2：qiyoujiage（地级市价格 + 下次调价） ──────────
async function fetchCityHtml(path) {
  if (!path) throw new Error("无城市路径");
  const url = HTML_BASE + "/" + path + ".shtml";
  const req = new Request(url);
  req.headers = { "Referer": HTML_BASE + "/", "User-Agent": "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X)" };
  req.timeoutInterval = 15;
  const html = await req.loadString();

  const out = { region: "", prices: {}, nextDate: "", nextText: "", nextRaw: "" };

  const tm = html.match(/<title>([^_]+)_/);
  if (tm) out.region = tm[1].trim().replace(/(油价|实时|今日|最新|查询|价格)/g, "").trim();

  const regPrice = /<dl>[\s\S]+?<dt>(.*油)<\/dt>[\s\S]+?<dd>(.*)\(元\)<\/dd>/gm;
  const nameMap = { "92": "92", "95": "95", "98": "98", "0 号": "0", "柴油": "0" };
  let m;
  while ((m = regPrice.exec(html)) !== null) {
    const val = parseFloat(m[2].trim());
    if (isNaN(val)) continue;
    const key = Object.keys(nameMap).find(k => m[1].includes(k));
    if (key) out.prices[nameMap[key]] = val;
  }
  if (!Object.keys(out.prices).length) throw new Error("页面价格解析失败");

  // 下次调价预告
  const block = html.match(/<div class="tishi">([\s\S]*?)<\/div>/);
  if (block) {
    const clean = block[1].replace(/<script[\s\S]*?<\/script>/gi, "");
    const span = (clean.match(/<span>([^<]+)<\/span>/) || [])[1] || "";
    const rest = clean.split(/<br\s*\/?>/i)[1] || "";
    const body = rest.replace(/<[^>]+>/g, "").replace(/\s+/g, " ").trim();
    out.nextRaw = (span.trim() + " " + body).trim();
    const parsed = parseNext(out.nextRaw);
    out.nextDate = parsed.date;
    out.nextText = parsed.text;
  }
  return out;
}

// 解析「下次油价10月15日24时调整 / 油价搁浅调整…」
function parseNext(raw) {
  const t = String(raw || "");
  if (!t) return { date: "", text: "" };
  const dm = t.match(/(\d{1,2})月(\d{1,2})日/);
  const date = dm ? `${+dm[1]}/${+dm[2]}` : "";
  let dir = "";
  if (/搁浅|不变|维持/.test(t)) dir = "搁浅";
  else if (/下调|下跌|降价/.test(t)) dir = "下调";
  else if (/上调|上涨|涨价/.test(t)) dir = "上调";
  let amt = "";
  const am = t.match(/(\d+(?:\.\d+)?)\s*[-~至]\s*(\d+(?:\.\d+)?)\s*元/);
  if (am) amt = `${am[1]}~${am[2]}`;
  else {
    const a2 = t.match(/(\d+(?:\.\d+)?)\s*元/);
    if (a2) amt = a2[1];
  }
  const text = [dir, amt].filter(Boolean).join(" ");
  return { date, text };
}

// ────────── 合并 ──────────
function mergeData(city, prov, fallbackLabel) {
  const out = {
    region: (city && city.region) || (prov && prov.provinceLabel) || fallbackLabel || "",
    level: city ? "地级市" : "省级",
    lastDate: (prov && prov.lastDate) || "",
    nextDate: (city && city.nextDate) || "",
    nextText: (city && city.nextText) || "",
    data: {},
  };
  ["92", "95", "98", "0"].forEach(id => {
    const cp = city && city.prices ? city.prices[id] : undefined;
    const pp = prov && prov.prices ? prov.prices[id] : undefined;
    const price = (cp !== undefined) ? cp : (pp !== undefined ? pp : null);
    if (price === null) return;
    out.data[id] = {
      price,
      // 涨跌额全国统一，省级值可直接套地级市
      zde: (prov && prov.zde && prov.zde[id] !== undefined) ? prov.zde[id] : null,
      hist: (prov && prov.hist && prov.hist[id]) ? prov.hist[id] : [],
    };
  });
  return out;
}

// ────────── 小工具 ──────────
function fmtPrice(v) { return (v === null || v === undefined) ? "--" : Number(v).toFixed(2); }
function fmtDate(d) {
  if (!d) return "";
  const p = String(d).split("-");
  return p.length >= 3 ? `${+p[1]}/${+p[2]}` : String(d);
}
function changeText(z) {
  if (z === null || z === undefined) return "";
  const v = Number(z);
  if (Math.abs(v) < 0.005) return "持平";
  return (v > 0 ? "+" : "") + v.toFixed(2);
}

function changeMark(parent, zde, T, fs) {
  const s = parent.addStack();
  s.centerAlignContent();
  if (zde === null || zde === undefined) {
    const t = s.addText("--");
    t.font = Font.mediumRoundedSystemFont(fs);
    t.textColor = T.sub;
    return s;
  }
  const v = Number(zde);
  const flat = Math.abs(v) < 0.005;
  const col = flat ? T.flat : (v > 0 ? T.up : T.down);
  const t = s.addText(changeText(v));
  t.font = Font.semiboldRoundedSystemFont(fs);
  t.textColor = col;
  if (!flat) {
    s.addSpacer(2);
    const img = s.addImage(SFSymbol.named(v > 0 ? "arrow.up" : "arrow.down").image);
    img.imageSize = new Size(fs * 0.72, fs * 0.72);
    img.tintColor = col;
  }
  return s;
}

// ────────── 走势柱 ──────────
function sparkline(parent, hist, hex, height, barW, gapW) {
  const box = parent.addStack();
  box.layoutHorizontally();
  box.centerAlignContent();
  const arr = (hist && hist.length >= 2) ? hist.slice(-6) : [];
  if (!arr.length) {
    const ph = box.addText("—");
    ph.font = Font.systemFont(height * 0.5);
    ph.textColor = new Color(hex, 0.3);
    return box;
  }
  const min = Math.min(...arr), max = Math.max(...arr);
  const span = (max - min) || 1;
  arr.forEach((v, i) => {
    const h = Math.max(3, Math.round((0.32 + 0.68 * ((v - min) / span)) * height));
    const col = box.addStack();
    col.layoutVertically();
    col.size = new Size(barW, height);
    col.addSpacer();
    const bar = col.addStack();
    bar.size = new Size(barW, h);
    bar.cornerRadius = barW / 2;
    const isLast = i === arr.length - 1;
    bar.backgroundColor = new Color(hex, isLast ? 1 : 0.26 + 0.1 * (i / arr.length));
    if (i < arr.length - 1) box.addSpacer(gapW);
  });
  return box;
}

// ────────── 徽章 ──────────
function badge(parent, text, hex, size, T) {
  const b = parent.addStack();
  b.size = new Size(size, size);
  b.cornerRadius = size * 0.28;
  b.borderWidth = 2;
  b.borderColor = new Color(hex, 0.5);
  b.backgroundColor = new Color(hex, T.dark ? 0.16 : 0.09);
  b.centerAlignContent();
  const t = b.addText(text);
  t.font = Font.boldRoundedSystemFont(size * 0.46);
  t.textColor = new Color(hex);
  t.lineLimit = 1;
  t.minimumScaleFactor = 0.6;
  return b;
}

// ────────── 信息条：上次 / 下次调价 ──────────
function scheduleLine(parent, oil, T, fs, showLast) {
  const row = parent.addStack();
  row.centerAlignContent();
  const parts = [];
  if (showLast && oil.lastDate) parts.push("上次 " + fmtDate(oil.lastDate));
  if (oil.nextDate) parts.push("下次 " + oil.nextDate + (oil.nextText ? " " + oil.nextText : ""));
  const txt = parts.length ? parts.join("  ·  ") : "调价日历待公布";
  const t = row.addText(txt);
  t.font = Font.mediumRoundedSystemFont(fs);
  t.textColor = T.sub;
  t.lineLimit = 1;
  t.minimumScaleFactor = 0.7;
  return row;
}

// ────────── 渲染：小 ──────────
function renderSmall(oil, T) {
  const w = new ListWidget();
  w.backgroundColor = T.bg;
  w.setPadding(11, 12, 11, 12);

  const f = visibleFuels(oil)[0] || FUELS[0];
  const d = oil.data[f.id] || { price: null, zde: null, hist: [] };

  const head = w.addStack();
  head.centerAlignContent();
  const hT = head.addText(oil.region);
  hT.font = Font.boldRoundedSystemFont(12.5);
  hT.textColor = T.main;
  hT.lineLimit = 1;
  hT.minimumScaleFactor = 0.65;
  head.addSpacer();
  const lv = head.addText(oil.lastDate ? fmtDate(oil.lastDate) : (oil.level === "地级市" ? "市" : "省"));
  lv.font = Font.mediumRoundedSystemFont(8.5);
  lv.textColor = T.sub;

  w.addSpacer(4);

  const priceRow = w.addStack();
  priceRow.bottomAlignContent();
  const pv = priceRow.addText(fmtPrice(d.price));
  pv.font = Font.boldRoundedSystemFont(31);
  pv.textColor = new Color(f.hex);
  pv.lineLimit = 1;
  pv.minimumScaleFactor = 0.6;
  priceRow.addSpacer();
  const lbl = priceRow.addText(f.label);
  lbl.font = Font.semiboldRoundedSystemFont(10);
  lbl.textColor = T.sub;

  w.addSpacer(1);
  changeMark(w, d.zde, T, 10);

  w.addSpacer(5);
  const sp = w.addStack();
  sp.centerAlignContent();
  sparkline(sp, d.hist, f.hex, 20, 3.5, 2.5);
  sp.addSpacer();

  w.addSpacer();

  // 另外两种油品
  const rest = visibleFuels(oil).filter(x => x.id !== f.id).slice(0, 2);
  rest.forEach((rf, i) => {
    const rd = oil.data[rf.id] || {};
    const line = w.addStack();
    line.centerAlignContent();
    const dot = line.addText("●");
    dot.font = Font.systemFont(6);
    dot.textColor = new Color(rf.hex);
    line.addSpacer(3);
    const lb = line.addText(rf.label);
    lb.font = Font.mediumRoundedSystemFont(9.5);
    lb.textColor = T.sub;
    line.addSpacer(3);
    const p2 = line.addText(fmtPrice(rd.price));
    p2.font = Font.semiboldRoundedSystemFont(11.5);
    p2.textColor = T.main;
    line.addSpacer();
    changeMark(line, rd.zde, T, 8);
    if (i < rest.length - 1) w.addSpacer(2);
  });

  w.addSpacer(4);
  scheduleLine(w, oil, T, 8.5, false);

  return w;
}

// ────────── 渲染：行 ──────────
function fuelRow(parent, fuel, d, T, o) {
  const card = parent.addStack();
  card.centerAlignContent();
  card.setPadding(5, 9, 5, 9);
  if (o.rowW) card.size = new Size(o.rowW, o.cardH);
  card.cornerRadius = 12;
  card.backgroundGradient = tintGradient(fuel.hex, T.dark);

  badge(card, fuel.id, fuel.hex, o.badgeSize, T);
  card.addSpacer(7);

  const priceCol = card.addStack();
  priceCol.layoutVertically();
  priceCol.addSpacer();
  const pl = priceCol.addText(fuel.label);
  pl.font = Font.mediumRoundedSystemFont(8.5);
  pl.textColor = T.sub;
  priceCol.addSpacer(1);
  const pv = priceCol.addText(fmtPrice(d.price));
  pv.font = Font.boldRoundedSystemFont(o.priceFs);
  pv.textColor = T.main;
  pv.lineLimit = 1;
  pv.minimumScaleFactor = 0.6;
  priceCol.addSpacer();

  card.addSpacer(7);

  const spCol = card.addStack();
  spCol.layoutVertically();
  spCol.addSpacer();
  sparkline(spCol, d.hist, fuel.hex, o.barH, o.barW, o.gapW);
  spCol.addSpacer();

  card.addSpacer();
  changeMark(card, d.zde, T, o.changeFs);
  return card;
}

// ────────── 渲染：中 ──────────
function renderMedium(oil, T) {
  const M = metrics("medium");
  const w = new ListWidget();
  w.backgroundColor = T.bg;
  w.setPadding(10, 13, 10, 13);

  const head = w.addStack();
  head.centerAlignContent();
  const hT = head.addText(oil.region);
  hT.font = Font.boldRoundedSystemFont(13.5);
  hT.textColor = T.main;
  hT.lineLimit = 1;
  head.addSpacer();
  if (oil.lastDate) {
    const lt = head.addText("上次 " + fmtDate(oil.lastDate));
    lt.font = Font.mediumRoundedSystemFont(9);
    lt.textColor = T.sub;
  }

  w.addSpacer(5);

  const list = visibleFuels(oil, 3);
  list.forEach((fuel, i) => {
    const d = oil.data[fuel.id] || {};
    fuelRow(w, fuel, d, T, {
      cardH: 32, rowW: M.w - 26, badgeSize: 22, priceFs: 14,
      barH: 15, barW: 3, gapW: 2, changeFs: 10.5,
    });
    if (i < list.length - 1) w.addSpacer(4);
  });

  w.addSpacer();
  scheduleLine(w, oil, T, 9, false);

  return w;
}

// ────────── 渲染：大 ──────────
function renderLarge(oil, T) {
  const M = metrics("large");
  const w = new ListWidget();
  w.backgroundColor = T.bg;
  w.setPadding(13, 13, 13, 13);

  const head = w.addStack();
  head.centerAlignContent();
  const hT = head.addText(oil.region);
  hT.font = Font.boldRoundedSystemFont(17);
  hT.textColor = T.main;
  hT.lineLimit = 1;
  head.addSpacer();
  const lv = head.addText(oil.level + "口径");
  lv.font = Font.mediumRoundedSystemFont(9);
  lv.textColor = T.sub;

  w.addSpacer(9);

  const list = visibleFuels(oil, 4);
  const compact = list.length >= 4;
  const cardH = compact ? 54 : 64;
  const badgeSize = compact ? 30 : 36;
  const priceFs = compact ? 19 : 22;
  const barH = compact ? 24 : 30;

  list.forEach((fuel, i) => {
    const d = oil.data[fuel.id] || {};
    fuelRow(w, fuel, d, T, {
      cardH, rowW: M.w - 26, badgeSize, priceFs,
      barH, barW: 4.5, gapW: 2.5, changeFs: 11.5,
    });
    if (i < list.length - 1) w.addSpacer(6);
  });

  // 调价日程卡
  const box = w.addStack();
  box.layoutVertically();
  box.setPadding(10, 12, 10, 12);
  box.cornerRadius = 12;
  box.backgroundColor = T.card;

  const l1 = box.addStack();
  l1.centerAlignContent();
  const t1 = l1.addText("上次调价");
  t1.font = Font.mediumRoundedSystemFont(9.5);
  t1.textColor = T.sub;
  l1.addSpacer();
  const v1 = l1.addText(oil.lastDate ? fmtDate(oil.lastDate) : "--");
  v1.font = Font.semiboldRoundedSystemFont(10.5);
  v1.textColor = T.main;

  box.addSpacer(5);

  const l2 = box.addStack();
  l2.centerAlignContent();
  const t2 = l2.addText("下次调价");
  t2.font = Font.mediumRoundedSystemFont(9.5);
  t2.textColor = T.sub;
  l2.addSpacer();
  const v2 = l2.addText(oil.nextDate ? oil.nextDate + (oil.nextText ? " " + oil.nextText : "") : "待公布");
  v2.font = Font.semiboldRoundedSystemFont(10.5);
  v2.textColor = T.main;
  v2.lineLimit = 1;
  v2.minimumScaleFactor = 0.7;

  return w;
}

function errorWidget(msg, T) {
  const w = new ListWidget();
  w.backgroundColor = T.bg;
  w.setPadding(14, 14, 14, 14);
  const t = w.addText("⛽ 油价");
  t.font = Font.boldRoundedSystemFont(13);
  t.textColor = T.main;
  w.addSpacer(6);
  const m = w.addText(String(msg || "未知错误"));
  m.font = Font.systemFont(10);
  m.textColor = T.fail;
  m.lineLimit = 4;
  return w;
}

// ────────── App 内设置 ──────────
async function pickRegion(current) {
  const alert = new Alert();
  alert.title = "油价小组件 v3";
  alert.message = "当前：" + (current || "贵州-黔东南") + "\n地级市：贵州-黔东南 / 广东-深圳\n省级：贵州 / 北京";
  alert.addTextField("地区", current || "");
  alert.addAction("保存并预览");
  alert.addAction("仅预览");
  alert.addCancelAction("取消");
  const choice = await alert.present();
  if (choice === 2) return null;
  const input = alert.getTextFieldValue(0).trim();
  if (choice === 0 && input) saveRegion(input);
  return input || current;
}

// ────────── 主流程 ──────────
(async () => {
  const T = theme();
  const cache = loadCache();
  const param = (args.widgetParameter || "").trim();
  let raw = param || loadRegion() || "贵州-黔东南";

  if (config.runsInApp) {
    const picked = await pickRegion(raw);
    if (!picked) { Script.complete(); return; }
    raw = picked;
  }

  const R = resolveRegion(raw);
  const province = R.province || "贵州";
  const cityPath = R.cityPath || "";

  // 双源并发，各自容错
  const [cityRes, provRes] = await Promise.all([
    cityPath ? fetchCityHtml(cityPath).catch(() => null) : Promise.resolve(null),
    fetchEastMoney(province).catch(() => null),
  ]);

  let oil = null, fromCache = false;
  if (provRes) provRes.provinceLabel = province;

  if (cityRes || provRes) {
    oil = mergeData(cityRes, provRes, raw);
    saveCache(oil);
  } else if (cache && cache.data && Object.keys(cache.data).length) {
    oil = cache;
    fromCache = true;
  } else {
    const w = errorWidget("获取失败\n地区：" + raw + "\n请检查网络或地区名", T);
    if (config.runsInApp) await w.presentSmall(); else Script.setWidget(w);
    Script.complete();
    return;
  }

  // 缓存补全：城市数据挂了但省级在 → 价格用省级
  if (!Object.keys(oil.data).length) {
    oil = cache;
    fromCache = true;
  }

  const family = (typeof config !== "undefined" && config.widgetFamily) || "small";
  let w;
  try {
    if (family === "medium") w = renderMedium(oil, T);
    else if (family === "large") w = renderLarge(oil, T);
    else w = renderSmall(oil, T);
  } catch (e) {
    w = errorWidget("渲染失败：" + (e.message || e), T);
  }

  w.refreshAfterDate = new Date(Date.now() + 1000 * 60 * 60);
  if (config.runsInApp) await w.presentSmall();
  else Script.setWidget(w);
  Script.complete();
})();
