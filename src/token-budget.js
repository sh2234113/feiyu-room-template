// 每日 token 预算：额度怎么累计。
//
// 两种口径：
//   daily  —— 全天一次性给满 `dailyTokens`（旧行为）。
//   hourly —— 把 `dailyTokens` 平均切成 24 份，每个自然小时解锁一份；当前小时
//             的那一份从整点起就可用（不是按秒涓流），所以 00:00 就有 1/24，
//             01:00 有 2/24……23:00 有 24/24。前面没用完的份额不会消失，
//             累计额度一直保留到当天结束；当天总上限仍是 `dailyTokens`。
//
// 这样「一天一亿、平均到 24 小时、前面没用完可以往后累计、一天最多一亿」四个条件
// 可以同时满足：任何时刻可用额度 = min(日上限, 日上限 × 已解锁小时数 / 24)。
// 时区固定 Asia/Shanghai，和 token-usage.jsonl 的日界线一致。

export const BUDGET_ACCRUALS = Object.freeze(['daily', 'hourly']);

export function normalizeAccrual(value) {
  return String(value ?? '').trim().toLowerCase() === 'hourly' ? 'hourly' : 'daily';
}

const SHANGHAI_HOUR_FMT = new Intl.DateTimeFormat('en-GB', {
  timeZone: 'Asia/Shanghai',
  hour: '2-digit',
  hourCycle: 'h23'
});

/** 当前是上海时间的几点（0-23），用于小时额度分桶。 */
export function shanghaiHourOf(ts = Date.now()) {
  const hour = Number(SHANGHAI_HOUR_FMT.formatToParts(new Date(ts)).find((p) => p.type === 'hour')?.value);
  return Number.isFinite(hour) ? hour % 24 : 0;
}

/**
 * 计算某个时刻的累计可用额度。
 * @param {{limit:number, hourOfDay:number, accrual?:'daily'|'hourly'}} input
 * @returns {{accrued:number, buckets:number, hourlyTokens:number, accrual:'daily'|'hourly'}}
 */
export function computeAccrual({ limit, hourOfDay, accrual = 'daily' } = {}) {
  const daily = Math.max(0, Math.round(Number(limit) || 0));
  const hourlyTokens = Math.round(daily / 24);
  const mode = normalizeAccrual(accrual);
  if (mode === 'daily') return { accrued: daily, buckets: 24, hourlyTokens, accrual: mode };
  const hour = Math.min(23, Math.max(0, Math.floor(Number(hourOfDay) || 0)));
  const buckets = hour + 1; // 当前小时那一份从整点起就可用
  const accrued = Math.min(daily, Math.round((daily * buckets) / 24));
  return { accrued, buckets, hourlyTokens, accrual: mode };
}

/**
 * 预算视图：页面/状态接口/告警共用。
 * @param {{limit:number, used:number, hourOfDay:number, accrual?:'daily'|'hourly', enabled?:boolean}} input
 */
export function budgetView({ limit, used, hourOfDay, accrual = 'daily', enabled = true } = {}) {
  const daily = Math.max(0, Math.round(Number(limit) || 0));
  const spent = Math.max(0, Number(used) || 0);
  const mode = normalizeAccrual(accrual);
  const { accrued, buckets, hourlyTokens } = computeAccrual({ limit: daily, hourOfDay, accrual: mode });
  const on = enabled !== false && daily > 0;
  const available = on ? Math.max(0, accrued - spent) : null;
  return {
    enabled: on,
    limit: daily,
    used: spent,
    accrued: on ? accrued : 0,
    available,
    remaining: available,
    blocked: on && spent >= accrued,
    accrual: mode,
    hour: Math.min(23, Math.max(0, Math.floor(Number(hourOfDay) || 0))),
    buckets,
    hourlyTokens
  };
}


/**
 * 临时不限额窗口：`until` 是 ISO 8601 时间（建议带 +08:00）。now < until 时不执行预算。
 * 解析失败或空值一律视为不启用，避免写错一个字段就把预算永久关掉。
 */
export function isBudgetUnlimited(until, now = Date.now()) {
  if (!until) return false;
  const ms = Date.parse(String(until));
  return Number.isFinite(ms) && Number(now) < ms;
}
