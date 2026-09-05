const DIGITS = { 零: 0, 〇: 0, 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9 };
const UNITS = { 十: 10, 百: 100, 千: 1000 };

export const METRIC_FIELDS = [
  { key: "cutoff", label: "统计截止", type: "time", aliases: ["统计截止", "统计截至", "截止时间", "截至时间", "统计时间"] },
  { key: "impressions", label: "展现量", aliases: ["展现量", "展示量", "展现数", "展示数"] },
  { key: "spend", label: "花费", unit: "元", aliases: ["花费", "消费", "耗费"] },
  { key: "clickRate", label: "点击率", unit: "%", aliases: ["点击率", "点几率"] },
  { key: "averageClickCost", label: "平均点击花费", unit: "元", aliases: ["平均点击花费", "平均点击费用", "平均点击消费", "平均点击成本", "平均点几花费"] },
  { key: "salesAmount", label: "总成交金额", unit: "元", aliases: ["总成交金额", "成交金额", "总交易金额"] },
  { key: "salesCount", label: "总成交笔数", aliases: ["总成交笔数", "成交笔数", "成交单数", "总成交单数"] },
  { key: "conversionRate", label: "点击转化率", unit: "%", aliases: ["点击转化率", "点几转化率", "转化率"] },
  { key: "cartRate", label: "加购率", unit: "%", aliases: ["加购率", "家购率", "加沟率"] },
  { key: "roi", label: "投入产出比(ROI)", aliases: ["投入产出比", "投入产出比roi", "roi", "投产比"] },
  { key: "cartCost", label: "加购成本", unit: "元", aliases: ["加购成本", "家购成本", "加沟成本"] },
  { key: "cartCount", label: "总购物车数", aliases: ["总购物车数", "购物车数", "总加购数", "加购数"] }
];

const aliasEntries = METRIC_FIELDS.flatMap((field) => field.aliases.map((alias) => [alias.toLowerCase(), field]));
const aliasMap = new Map(aliasEntries);
const escapeRegExp = (value) => value.replace(/[.*+?^$()|[\]{}]/g, "\\$&");
const labelPattern = new RegExp(aliasEntries.map(([alias]) => alias).sort((a, b) => b.length - a.length).map(escapeRegExp).join("|"), "gi");

function chineseInteger(value) {
  if (!value) return null;
  if (!/[十百千万]/.test(value)) return Number([...value].map((char) => DIGITS[char]).join(""));
  const wan = value.indexOf("万");
  if (wan >= 0) return chineseInteger(value.slice(0, wan)) * 10000 + (chineseInteger(value.slice(wan + 1)) || 0);
  let total = 0;
  let digit = 0;
  for (const char of value) {
    if (Object.hasOwn(DIGITS, char)) digit = DIGITS[char];
    else if (UNITS[char]) { total += (digit || 1) * UNITS[char]; digit = 0; }
  }
  return total + digit;
}

function chineseNumber(value) {
  const [integer, decimal] = value.split("点");
  const whole = chineseInteger(integer);
  if (whole === null || Number.isNaN(whole)) return null;
  if (!decimal) return String(whole);
  const fraction = [...decimal].map((char) => DIGITS[char]).filter((digit) => digit !== undefined).join("");
  return fraction ? String(whole) + "." + fraction : String(whole);
}

function parseNumber(value) {
  const normalized = value.normalize("NFKC");
  const percentPrefix = normalized.indexOf("百分之");
  if (percentPrefix >= 0) return parseNumber(normalized.slice(percentPrefix + 3));
  const arabic = normalized.match(/\d[\d,]*(?:\.\d+)?/);
  if (arabic) return arabic[0].replaceAll(",", "");
  const chinese = normalized.match(/[零〇一二两三四五六七八九十百千万点]+/);
  return chinese ? chineseNumber(chinese[0]) : null;
}

function parseTime(value) {
  const normalized = value.normalize("NFKC");
  const arabic = normalized.match(/(\d{1,2})\s*[:点时]\s*(\d{1,2})?/);
  const chinese = normalized.match(/([零〇一二两三四五六七八九十百千万]+)\s*[点时](?:([零〇一二两三四五六七八九十]+)分?)?/);
  let hour = arabic ? Number(arabic[1]) : chinese ? Number(chineseInteger(chinese[1])) : NaN;
  let minute = arabic?.[2] ? Number(arabic[2]) : chinese?.[2] ? Number(chineseInteger(chinese[2])) : /半/.test(normalized) ? 30 : 0;
  if (/下午|晚上/.test(normalized) && hour < 12) hour += 12;
  if (/凌晨/.test(normalized) && hour === 12) hour = 0;
  return hour >= 0 && hour <= 23 && minute >= 0 && minute <= 59 ? String(hour).padStart(2, "0") + ":" + String(minute).padStart(2, "0") : null;
}

export function organizeMetrics(input) {
  const original = String(input || "").trim().normalize("NFKC");
  labelPattern.lastIndex = 0;
  const matches = [...original.matchAll(labelPattern)];
  const values = new Map();
  const invalid = [];
  matches.forEach((match, index) => {
    const field = aliasMap.get(match[0].toLowerCase());
    const segment = original.slice(match.index + match[0].length, matches[index + 1]?.index ?? original.length);
    const value = field.type === "time" ? parseTime(segment) : parseNumber(segment);
    if (value === null) invalid.push(field.label);
    else values.set(field.key, value);
  });
  const text = METRIC_FIELDS.filter((field) => values.has(field.key)).map((field) => field.label + "：" + values.get(field.key) + (field.unit || "")).join("\n");
  return {
    original,
    text: text || original,
    recognized: values.size,
    missing: METRIC_FIELDS.filter((field) => !values.has(field.key)).map((field) => field.label),
    invalid: [...new Set(invalid)]
  };
}
