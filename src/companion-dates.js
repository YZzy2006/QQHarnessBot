import { parseScheduledTime, cnNumber } from './time-parse.js';
import { bjDate } from './life-services.js';
const DAY = 86400000;
const lunarFormatter = new Intl.DateTimeFormat('en-u-ca-chinese', { timeZone: 'Asia/Shanghai', year: 'numeric', month: 'numeric', day: 'numeric' });
export function lunarParts(at) {
  const p = Object.fromEntries(lunarFormatter.formatToParts(new Date(at)).map((v) => [v.type, v.value]));
  return { year: Number(p.relatedYear), month: parseInt(p.month, 10), day: Number(p.day), leap: /bis/.test(p.month) };
}
export function companionTime(input, now = Date.now()) {
  const match = /^(?:一?个?)?([零〇一二两三四五六七八九十\d]+)?个?月后$/.exec(String(input).trim());
  if (match) {
    const count = match[1] ? cnNumber(match[1]) : 1;
    if (!Number.isInteger(count) || count < 1 || count > 60) throw new Error('胶囊月份须为1~60个月');
    const date = new Date(now + 8 * 3600000);
    const day = date.getUTCDate(); date.setUTCDate(1); date.setUTCMonth(date.getUTCMonth() + count);
    const last = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 0)).getUTCDate();
    date.setUTCDate(Math.min(day, last)); return date.getTime() - 8 * 3600000;
  }
  const result = parseScheduledTime(String(input), now);
  if (!result.ok || result.repeat || result.at <= now || result.at > now + 5 * 366 * DAY) throw new Error('请写明确的未来时间，如明天9点、30分钟后或一个月后（最长5年）');
  return result.at;
}
export function anniversarySpec(input) {
  const raw = String(input).trim();
  const lunar = /^(?:每年)?农历(闰)?(\d{1,2})月(\d{1,2})(?:日|号)?$/.exec(raw);
  if (lunar) {
    const month = Number(lunar[2]), day = Number(lunar[3]);
    if (month < 1 || month > 12 || day < 1 || day > 30) throw new Error('农历日期无效');
    return { calendar: 'lunar', month, day, leap: !!lunar[1], yearly: true, raw };
  }
  const m = /^(每年)?(?:(\d{4})[-年])?(\d{1,2})[-月](\d{1,2})(?:日|号)?$/.exec(raw);
  if (!m) throw new Error('日期请写2026-11-01、每年10-31或每年农历8月15日');
  const year = m[2] ? Number(m[2]) : null, month = Number(m[3]), day = Number(m[4]);
  const valid = new Date(Date.UTC(year || 2000, month - 1, day));
  if (valid.getUTCMonth() + 1 !== month || valid.getUTCDate() !== day || (year && (year < 1900 || year > 2199))) throw new Error('公历日期无效');
  return { calendar: 'solar', year, month, day, yearly: !!m[1] || !year, raw };
}
export function nextAnniversary(spec, now = Date.now()) {
  const year = Number(bjDate(now).slice(0, 4));
  if (spec.calendar === 'solar') {
    for (let y = spec.yearly ? year : spec.year; y <= (spec.yearly ? year + 8 : spec.year); y++) {
      const at = Date.UTC(y, spec.month - 1, spec.day, 1); // 北京09:00
      const d = new Date(at + 8 * 3600000);
      if (d.getUTCMonth() + 1 === spec.month && d.getUTCDate() === spec.day && at > now) return at;
    }
  } else {
    const start = Date.parse(`${bjDate(now)}T09:00:00+08:00`);
    // 农历闰月可能多年才出现；有界搜索20年，普通农历只需约一年。
    for (let i = 0; i <= (spec.leap ? 20 * 366 : 2 * 366); i++) {
      const at = start + i * DAY;
      if (at <= now) continue;
      const p = lunarParts(at);
      if (p.month === spec.month && p.day === spec.day && p.leap === spec.leap) return at;
    }
  }
  throw new Error('没有找到未来有效日期，请检查日期；已过去的单次纪念日须重新设置');
}
