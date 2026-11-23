import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import path from 'node:path';

import { analytics } from '../../skills/tiktok-ads/scripts/analytics.ts';
import { eligibility } from '../../skills/tiktok-ads/scripts/eligibility.ts';
import { monetization } from '../../skills/tiktok-ads/scripts/monetization.ts';
import { AdsError, mergeStudio, parseStudio } from '../../skills/tiktok-ads/scripts/studio.ts';

const FIX = path.resolve(import.meta.dir, '../fixtures/tiktok');
const text = (n: string) => readFileSync(path.join(FIX, n), 'utf8');
const json = (n: string) => JSON.parse(text(n));
const A = () => parseStudio(text('studio-capture-analytics.synthetic.json'));
const M = () => parseStudio(text('studio-capture-monetization.synthetic.json'));
const PROFILE = () => json('profile-read.synthetic.json');
const sum = (xs: number[]) => xs.reduce((a, b) => a + b, 0);
// The fixture's vv_history: 122 points = previous period (61) then current period (61), oldest first.
const vv = (): number[] => json('studio-capture-analytics.synthetic.json').responses[0].body.vv_history.map((p: { value: number }) => p.value);

describe('parseStudio', () => {
    test('reads a tt.studio-capture.v1 file', () => {
        expect(A().responses.length).toBe(4);
    });
    test('refuses another schema, another origin, a rate limit and a challenge', () => {
        const base = json('studio-capture-analytics.synthetic.json');
        const bad = (o: object) => () => parseStudio(JSON.stringify({ ...base, ...o }));
        expect(bad({ schema: 'tt.capture.v1' })).toThrow(AdsError);
        expect(bad({ url: 'https://example.com/tiktokstudio/analytics' })).toThrow(/www\.tiktok\.com/);
        expect(bad({ rateLimited: true })).toThrow(/rate_limited|too many/i);
        expect(bad({ challenge: true })).toThrow(/captcha|verification/i);
        expect(() => parseStudio('not json')).toThrow(AdsError);
    });
    test('merging two captures concatenates their answers', () => {
        expect(mergeStudio([A(), M()]).responses.length).toBe(6);
    });
});

describe('analytics', () => {
    const r = analytics(A());
    test('views: current vs previous period from a 2N+2 series', () => {
        const v = r.metrics.views as any;
        const prev = sum(vv().slice(0, 61));
        const cur = sum(vv().slice(61));
        expect(v.days).toBe(60);
        expect(v.current.total).toBe(cur);
        expect(v.previous.total).toBe(prev);
        expect(v.current.points).toBe(61);
        expect(v.change.abs).toBe(cur - prev);
        expect(v.change.pct).toBeCloseTo(((cur - prev) / prev) * 100, 2);
        expect(v.source).toBe('vv_history');
    });
    test('followers are a level: last value and change, not a sum', () => {
        const f = r.metrics.follower_growth as any;
        expect(f.kind).toBe('level');
        expect(f.current.last).toBe(11000 + 121 * 20);
        expect(f.current.change).toBe(60 * 20);
    });
    test('every history metric is reported', () => {
        for (const k of ['views', 'profile_views', 'likes', 'comments', 'shares', 'follower_growth', 'reached_audience']) expect((r.metrics as any)[k].current).toBeDefined();
        expect((r.metrics.comments as any).change.abs).toBeLessThan(0);
    });
    test('traffic sources with shares, search terms, unique viewers and followers', () => {
        expect(r.traffic_sources.total).toBe(10000);
        expect(r.traffic_sources.items[0]).toMatchObject({ label: 'For You', value: 7000 });
        expect(r.traffic_sources.items[0].share).toBeCloseTo(0.7, 6);
        expect(r.search_terms.items.map((x: any) => x.term)).toEqual(['SYNTH: term one', 'SYNTH: term two']);
        expect((r.unique_viewers as any).value).toBe(61200);
        expect((r.followers as any).value).toBe(12400);
    });
    test('rewards: total with currency, percent change and the daily list', () => {
        const w = r.rewards as any;
        expect(w.total).toEqual({ amount: 12.34, currency: 'USD', symbol: '$' });
        expect(w.percent_change).toBe(9.8);
        expect(w.daily.length).toBe(60);
        expect(w.daily_total).toBeGreaterThan(0);
    });
    test('incentive views answered with a status only: unavailable with the reason', () => {
        expect((r.incentive_views as any).unavailable).toBe(true);
        expect((r.incentive_views as any).reason).toMatch(/not eligible|status only/i);
    });
    test('per-post metrics are unavailable with a reason', () => {
        expect((r.per_post as any).unavailable).toBe(true);
        expect((r.per_post as any).reason).toMatch(/videos/);
    });
    test('a series that is not a whole number of periods has no previous period', () => {
        const cap = json('studio-capture-analytics.synthetic.json');
        cap.responses[0].body.vv_history = cap.responses[0].body.vv_history.slice(0, 61);
        const v = analytics(parseStudio(JSON.stringify(cap))).metrics.views as any;
        expect(v.current.points).toBe(61);
        expect(v.previous.unavailable).toBe(true);
        expect(v.change.unavailable).toBe(true);
    });
    test('previous total of zero gives no percentage', () => {
        const cap = json('studio-capture-analytics.synthetic.json');
        cap.responses[0].body.share_history = cap.responses[0].body.share_history.map((p: any, i: number) => (i <= 60 ? { status: 0, value: 0 } : p));
        const v = analytics(parseStudio(JSON.stringify(cap))).metrics.shares as any;
        expect(v.change.pct).toBeNull();
    });
    test('metrics that were not requested are unavailable, not zero', () => {
        const r2 = analytics(M());
        expect((r2.metrics.views as any).unavailable).toBe(true);
        expect((r2.metrics.views as any).reason).toMatch(/not (in|requested)/i);
        expect((r2.rewards as any).unavailable).toBe(true);
        expect(r2.traffic_sources.unavailable).toBe(true);
    });
    test('unrecognised rewards insight types are listed, not parsed', () => {
        const cap = json('studio-capture-analytics.synthetic.json');
        cap.responses.push({ path: '/tiktok/v1/analytics/insights/', typeRequests: [{ insight_type: 126, data_date_range: 1 }], body: { status_code: 0, something: { total: 1 } } });
        expect(analytics(parseStudio(JSON.stringify(cap))).unrecognized_insights).toEqual([{ insight_type: 126, keys: ['something'] }]);
    });
});

describe('monetization', () => {
    test('programs grouped active / eligible / ineligible with requirements and restriction', () => {
        const r = monetization(M());
        expect(r.counts).toEqual({ active: 1, eligible: 3, ineligible: 3 });
        const sub = r.programs.ineligible.find((p: any) => p.name === 'SYNTH Subscription')!;
        expect(sub).toMatchObject({ requirements_met: 0, total_requirements: 4, restricted: true });
        const art = r.programs.eligible.find((p: any) => p.name === 'SYNTH Artists program')!;
        expect(art.badges).toEqual(['New']);
        expect(r.currency).toEqual({ code: 'USD', symbol: '$' });
    });
    test('without an all_programs answer the page is unavailable', () => {
        const r = monetization(A());
        expect((r.programs as any).unavailable).toBe(true);
        expect((r.programs as any).reason).toMatch(/monetization page/);
    });
});

describe('eligibility (Creator Rewards)', () => {
    const o = (r: ReturnType<typeof eligibility>, id: string) => r.criteria.find((c) => c.id === id)!;
    test('followers from the profile read (wrapped or bare), 30-day views from the last 30 days of vv_history', () => {
        const r = eligibility(PROFILE(), A(), {});
        expect(o(r, 'followers')).toMatchObject({ status: 'met', actual: 12400, required: 10000 });
        expect(o(r, 'followers').source).toMatch(/profile/);
        const v30 = sum(vv().slice(-30));
        expect(o(r, 'views_30d')).toMatchObject({ actual: v30, required: 100000 });
        expect(o(r, 'views_30d').status).toBe(v30 >= 100000 ? 'met' : 'not_met');
        expect(o(r, 'views_30d').source).toMatch(/vv_history/);
        expect(eligibility(PROFILE().data, A(), {}).criteria.length).toBe(4);
    });
    test('age and region are unknown unless stated', () => {
        const r = eligibility(PROFILE(), A(), {});
        expect(o(r, 'age').status).toBe('unknown');
        expect(o(r, 'region').status).toBe('unknown');
        expect(eligibility(PROFILE(), A(), { age: 21, region: 'us' }).criteria.filter((c) => c.status === 'met').map((c) => c.id)).toEqual(expect.arrayContaining(['age', 'region']));
        expect(o(eligibility(PROFILE(), A(), { age: 16 }), 'age').status).toBe('not_met');
        // A region outside the dated list is unknown, never a hard no: the list changes often.
        expect(o(eligibility(PROFILE(), A(), { region: 'zz' }), 'region').status).toBe('unknown');
    });
    test('no Studio capture: views are unknown with the reason', () => {
        const r = eligibility(PROFILE(), undefined, {});
        expect(o(r, 'views_30d').status).toBe('unknown');
        expect(o(r, 'views_30d').note).toMatch(/Studio/);
    });
    test('a series shorter than 30 days is unknown', () => {
        const cap = json('studio-capture-analytics.synthetic.json');
        cap.responses[0].typeRequests[0].days = 7;
        cap.responses[0].body.vv_history = cap.responses[0].body.vv_history.slice(0, 9);
        expect(o(eligibility(PROFILE(), parseStudio(JSON.stringify(cap)), {}), 'views_30d').status).toBe('unknown');
    });
    test('followers below the bar is not met, with the gap', () => {
        const p = PROFILE();
        p.data.followers = 1057;
        const c = o(eligibility(p, A(), {}), 'followers');
        expect(c.status).toBe('not_met');
        expect(c.note).toMatch(/8943/);
    });
    test('program absent from every list: unavailable, not offered to this account or region', () => {
        const r = eligibility(PROFILE(), mergeStudio([A(), M()]), {});
        expect((r.program as any).unavailable).toBe(true);
        expect((r.program as any).reason).toBe('not offered to this account or region');
        expect(r.verdict).toBe('unavailable');
    });
    test('no all_programs answer: the program is unavailable because the page was not captured', () => {
        expect((eligibility(PROFILE(), A(), {}).program as any).reason).toMatch(/not captured/);
    });
    test('program listed: its list and requirements are reported', () => {
        const cap = json('studio-capture-monetization.synthetic.json');
        cap.responses[1].body.eligible_to_apply_m10n_programs.push({ name: 'Creator Rewards Program', m10n_project: 1, requirements_met: 2, total_requirements: 4, access_restriction_info: { is_access_restricted: false } });
        const r = eligibility(PROFILE(), mergeStudio([A(), parseStudio(JSON.stringify(cap))]), {});
        expect(r.program).toMatchObject({ listed: true, list: 'eligible', requirements_met: 2, total_requirements: 4 });
        expect(r.verdict).not.toBe('unavailable');
    });
    test('the output is dated and points at the references', () => {
        const r = eligibility(PROFILE(), A(), {});
        expect(r.policy.as_of).toMatch(/^\d{4}-\d{2}-\d{2}$/);
        expect(r.policy.note).toMatch(/verify/i);
    });
});
