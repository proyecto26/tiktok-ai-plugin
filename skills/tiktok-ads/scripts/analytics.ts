import { deepFind, historySeries, INSIGHTS, insight, num, REWARD_ANALYTICS, sum, unavailable } from './studio.ts';
import type { StudioCapture, Unavailable } from './studio.ts';

const r2 = (n: number) => Math.round(n * 100) / 100;

/** Studio history keys, the name this report gives them, and whether the daily values add up or are a running level. */
const HISTORY: { key: string; name: string; kind: 'sum' | 'level' }[] = [
    { key: 'vv_history', name: 'views', kind: 'sum' },
    { key: 'pv_history', name: 'profile_views', kind: 'sum' },
    { key: 'like_history', name: 'likes', kind: 'sum' },
    { key: 'comment_history', name: 'comments', kind: 'sum' },
    { key: 'share_history', name: 'shares', kind: 'sum' },
    // Read as a running follower count (one value per day), so it is summarised by its last value and change.
    { key: 'follower_num_history', name: 'follower_growth', kind: 'level' },
    { key: 'reached_audience_history', name: 'reached_audience', kind: 'sum' },
];

function period(values: number[], kind: 'sum' | 'level') {
    if (kind === 'sum') return { points: values.length, total: sum(values) };
    return { points: values.length, first: values[0], last: values[values.length - 1], change: values.length ? values[values.length - 1] - values[0] : 0 };
}
const headline = (p: any, kind: 'sum' | 'level'): number => (kind === 'sum' ? p.total : p.change);
function delta(cur: number, prev: number) {
    return { abs: r2(cur - prev), pct: prev === 0 ? null : r2(((cur - prev) / Math.abs(prev)) * 100) };
}

export interface AnalyticsReport {
    ok?: true;
    command?: string;
    capturedAt: string;
    metrics: Record<string, any>;
    traffic_sources: any;
    search_terms: any;
    unique_viewers: any;
    followers: any;
    incentive_views: any;
    rewards: any;
    reward_analytics: any;
    unrecognized_insights: { insight_type: unknown; keys: string[] }[];
    per_post: Unavailable;
    status_values: number[];
}

export function analytics(cap: StudioCapture): AnalyticsReport {
    const statuses = new Set<number>();
    const metrics: Record<string, any> = {};
    for (const h of HISTORY) {
        const s = historySeries(cap, h.key);
        if (!s) {
            metrics[h.name] = unavailable(`not requested in this capture (no ${h.key} answer; capture TikTok Studio's analytics page)`);
            continue;
        }
        s.statuses.forEach((x) => statuses.add(x));
        const cur = period(s.current, h.kind);
        const entry: Record<string, any> = { source: h.key, kind: h.kind, days: s.days ?? null, end_days: s.end_days ?? null, current: cur };
        if (s.previous) {
            const prev = period(s.previous, h.kind);
            entry.previous = prev;
            entry.change = delta(headline(cur, h.kind), headline(prev, h.kind));
        } else {
            entry.previous = unavailable(`the series has ${s.current.length} points${s.days !== undefined ? ` for a ${s.days}-day request` : ''}: one period, no previous period to compare`);
            entry.change = unavailable('no previous period');
        }
        metrics[h.name] = entry;
    }

    const traffic = insight(cap, 'vv_traffic_source');
    let traffic_sources: any = unavailable('not requested in this capture (no vv_traffic_source answer)');
    if (traffic && Array.isArray(traffic.value?.value)) {
        const rows = (traffic.value.value as any[]).filter((x) => num(x?.value) !== undefined);
        const total = sum(rows.map((x) => x.value));
        traffic_sources = {
            days: num(traffic.request?.days) ?? null,
            total,
            items: rows.map((x) => ({ key: String(x.key ?? ''), label: String(x.str_value || x.key || ''), value: x.value as number, share: total ? x.value / total : null })).sort((a, b) => b.value - a.value),
        };
    }
    const terms = insight(cap, 'user_search_terms');
    let search_terms: any = unavailable('not requested in this capture (no user_search_terms answer)');
    if (terms && Array.isArray(terms.value?.value)) {
        search_terms = {
            range: num(terms.request?.range) ?? null,
            items: (terms.value.value as any[]).filter((x) => num(x?.value) !== undefined).map((x) => ({ term: String(x.str_value || x.key || ''), value: x.value as number })).sort((a, b) => b.value - a.value),
        };
    }
    const scalar = (key: string): any => {
        const f = insight(cap, key);
        if (!f) return unavailable(`not requested in this capture (no ${key} answer)`);
        const v = num(f.value?.value);
        return v === undefined ? unavailable(`${key} answered without a value`) : { value: v, range: num(f.request?.range) ?? null };
    };
    const inc = insight(cap, 'incentive_vv');
    let incentive_views: any = unavailable('not requested in this capture (no incentive_vv answer)');
    if (inc) {
        const v = num(inc.value?.value);
        incentive_views = v !== undefined ? { value: v } : unavailable(`answered with a status only (status ${inc.value?.status ?? 'n/a'}): the account is not eligible for incentive views, or has none this cycle`);
    }

    // Rewards overview (insight_type 82). Any other insight type is listed, not parsed.
    let rewards: any = unavailable('no /tiktok/v1/analytics/insights/ answer with rewards in this capture');
    const unrecognized: { insight_type: unknown; keys: string[] }[] = [];
    for (const resp of cap.responses) {
        if (!INSIGHTS.test(resp.path)) continue;
        const o = deepFind(resp.body, 'analytics_overview_rewards');
        if (o && typeof o === 'object') {
            const t = o.total ?? {};
            const amount = Number(t.amount);
            rewards = {
                total: { amount: Number.isFinite(amount) ? amount : null, currency: t.currency_code ?? null, symbol: t.currency_symbol ?? null },
                percent_change: num(o.percent_change?.value) ?? null,
                delta_change: o.delta_change && Number.isFinite(Number(o.delta_change.amount)) ? Number(o.delta_change.amount) : null,
                daily: (Array.isArray(o.list) ? o.list : []).map((x: any) => ({ name: String(x?.name ?? ''), amount: Number(x?.value?.amount) })).filter((x: any) => Number.isFinite(x.amount)),
            };
            rewards.daily_total = r2(sum(rewards.daily.map((x: any) => x.amount)));
        } else {
            const keys = Object.keys(resp.body).filter((k) => k !== 'status_code' && k !== 'status_msg');
            const types = Array.isArray(resp.typeRequests) ? (resp.typeRequests as any[]).map((x) => x?.insight_type ?? x?.insigh_type) : [undefined];
            for (const t of types) unrecognized.push({ insight_type: t ?? null, keys });
        }
    }
    const ra = cap.responses.filter((r) => REWARD_ANALYTICS.test(r.path)).pop();
    const reward_analytics: any = ra
        ? { present: true, keys: Object.keys(ra.body).filter((k) => k !== 'status_code' && k !== 'status_msg'), note: 'the shape of this answer was not recorded; its fields are not interpreted' }
        : unavailable('no reward_analytics answer in this capture');

    return {
        capturedAt: cap.capturedAt,
        metrics,
        traffic_sources,
        search_terms,
        unique_viewers: scalar('unique_viewer_num'),
        followers: scalar('follower_num'),
        incentive_views,
        rewards,
        reward_analytics,
        unrecognized_insights: unrecognized,
        per_post: unavailable('Studio per-post analytics were not seen in the recon; public per-post counts come from `tiktok videos --capture` and the tiktok-audit skill'),
        status_values: [...statuses].sort((a, b) => a - b),
    };
}

