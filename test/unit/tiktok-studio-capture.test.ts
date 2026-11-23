import { afterEach, describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import path from 'node:path';

// Runs scripts/browser/studio-capture.js against a fake window, like tiktok-capture-hook.test.ts does for capture.js.
const SRC = readFileSync(path.resolve(import.meta.dir, '../../skills/tiktok/scripts/browser/studio-capture.js'), 'utf8');
const g = globalThis as Record<string, unknown>;
const saved = { location: g.location, window: g.window, fetch: g.fetch, XMLHttpRequest: g.XMLHttpRequest, document: g.document };
afterEach(() => {
    Object.assign(g, saved);
    delete g.__ttStudio;
});

const INSIGHT = '/aweme/v2/data/insight/';
const PROGRAMS = '/tiktok/v1/creator/m10n_center/all_programs';
const qs = (reqs: unknown) => `?type_requests=${encodeURIComponent(JSON.stringify(reqs))}&aid=1988&msToken=SECRETTOKEN&X-Bogus=SECRETBOGUS&device_id=999`;

function page(answers: Record<string, [number, string]>, pathname = '/tiktokstudio/analytics') {
    g.location = { origin: 'https://www.tiktok.com', href: 'https://www.tiktok.com' + pathname + '?lang=en', pathname };
    g.window = globalThis;
    delete g.__ttStudio;
    g.fetch = async (u: string) => new Response(answers[u][1], { status: answers[u][0] });
    g.XMLHttpRequest = function () {};
    (g.XMLHttpRequest as { prototype: Record<string, unknown> }).prototype.open = function () {};
    g.document = { getElementById: () => null, querySelector: () => null };
    const run = () => (0, eval)(SRC);
    const call = async (u: string) => {
        await (g.fetch as (u: string) => Promise<Response>)(u);
        await new Promise((r) => setTimeout(r, 20));
    };
    return { run, call };
}

const insightBody = {
    status_code: 0,
    status_msg: 'success',
    extra: { now: 1, logid: 'LOGID123' },
    log_pb: { impr_id: 'IMPR456' },
    vv_history: [{ status: 0, value: 10 }, { status: 0, value: 12 }],
    vv_traffic_source: { status: 0, value: [{ key: 'for_you', str_value: 'For You', value: 70 }] },
    unique_viewer_num: { status: 0, value: 55 },
    video_like_history_7d: {},
    incentive_vv: { status: 1 },
};

describe('studio-capture.js', () => {
    test('refuses a page that is not www.tiktok.com', () => {
        const p = page({});
        (g.location as { origin: string }).origin = 'https://example.com';
        expect(p.run()).toMatchObject({ error: expect.any(String) });
    });

    test('keeps the allowlisted paths and ignores every other path', async () => {
        const kept = [
            INSIGHT,
            '/tiktok/v1/analytics/insights/',
            '/tiktok/v1/creator/m10n_center/all_programs',
            '/tiktok/v1/creator/m10n_center/settings',
            '/tiktok/v1/creator/m10n_center/reward_analytics',
        ];
        const ignored = ['/api/post/item_list/', '/tiktok/v1/creator/m10n_center/academy_web', '/aweme/v2/data/insight/x/', '/passport/web/account/info/'];
        const answers: Record<string, [number, string]> = {};
        for (const k of [...kept, ...ignored]) answers[k + '?a=1'] = [200, '{"status_code":0,"x":{"status":0,"value":1}}'];
        const p = page(answers);
        p.run();
        for (const k of [...kept, ...ignored]) await p.call(k + '?a=1');
        const r = JSON.parse(p.run());
        expect(r.schema).toBe('tt.studio-capture.v1');
        expect(r.responses.map((x: { path: string }) => x.path).sort()).toEqual([...kept].sort());
    });

    test('projection keeps metric fields, records type_requests, strips logid, impr_id and signing params', async () => {
        const reqs = [{ insigh_type: 'vv_history', days: 60, end_days: 1 }, { insigh_type: 'vv_traffic_source', days: 7 }];
        const u = INSIGHT + qs(reqs);
        const p = page({ [u]: [200, JSON.stringify(insightBody)] });
        p.run();
        await p.call(u);
        const text = p.run() as string;
        const r = JSON.parse(text);
        const e = r.responses[0];
        expect(e.typeRequests).toEqual(reqs);
        expect(e.route).toBe('/tiktokstudio/analytics');
        expect(e.body.vv_history).toEqual([{ status: 0, value: 10 }, { status: 0, value: 12 }]);
        expect(e.body.vv_traffic_source.value[0]).toEqual({ key: 'for_you', str_value: 'For You', value: 70 });
        expect(e.body.unique_viewer_num).toEqual({ status: 0, value: 55 });
        expect(e.body.incentive_vv).toEqual({ status: 1 });
        expect(e.body.status_code).toBe(0);
        expect(e.body.extra).toBeUndefined();
        expect(e.body.log_pb).toBeUndefined();
        for (const bad of ['LOGID123', 'IMPR456', 'SECRETTOKEN', 'SECRETBOGUS', 'msToken', 'X-Bogus', 'device_id', 'lang=en', '?']) expect(text).not.toContain(bad);
        expect(r.url).toBe('https://www.tiktok.com/tiktokstudio/analytics');
    });

    test('reward analytics keep amounts and currency, drop urls and icon fields', async () => {
        const body = {
            status_code: 0,
            analytics_overview_rewards: {
                total: { amount: '12.50', currency_code: 'USD', currency_symbol: '$', message: { data_source: 'x', status: 0, timestamp: 5 } },
                percent_change: { value: 1.5, message: 'up' },
                list: [{ name: 'Day 1', value: { amount: '0.50', currency_code: 'USD' }, icon_url: 'https://cdn.example/x.png', message: 'm' }],
                help_url: 'https://www.tiktok.com/help?x=1',
            },
        };
        const u = '/tiktok/v1/analytics/insights/' + qs([{ insight_type: 82, data_date_range: 1 }]);
        const p = page({ [u]: [200, JSON.stringify(body)] });
        p.run();
        await p.call(u);
        const text = p.run() as string;
        const e = JSON.parse(text).responses[0];
        expect(e.typeRequests).toEqual([{ insight_type: 82, data_date_range: 1 }]);
        expect(e.body.analytics_overview_rewards.total.amount).toBe('12.50');
        expect(e.body.analytics_overview_rewards.total.currency_code).toBe('USD');
        expect(e.body.analytics_overview_rewards.list[0].value.amount).toBe('0.50');
        expect(JSON.stringify(JSON.parse(text).responses)).not.toContain('http');
    });

    test('all_programs keeps program fields and list membership, drops urls', async () => {
        const prog = (name: string, extra: Record<string, unknown> = {}) => ({
            name,
            description: 'SYNTH: ' + name + ' text',
            m10n_project: 7,
            requirements_met: 1,
            total_requirements: 3,
            access_restriction_info: { is_access_restricted: true, access_restriction_url: 'https://www.tiktok.com/r?token=abc' },
            apply_url: 'https://www.tiktok.com/apply?x=1',
            program_url: 'https://www.tiktok.com/p?x=1',
            icon: { url_list: ['https://cdn.example/i.png'] },
            program_cta_text: 'Apply',
            show_red_dot: false,
            web_page_info: { button_text: 'Go', schema: 'https://x/y?z=1', status: 1 },
            ...extra,
        });
        const body = {
            status_code: 0,
            active_m10n_programs: [prog('Program A', { m10n_tooltip: [{ text: 'tip' }] })],
            eligible_to_apply_m10n_programs: [prog('Program B', { m10n_badge: [{ badge_label: 'New', badge_icon: 'https://cdn/x.png' }] })],
            ineligible_to_apply_m10n_programs: [prog('Program C')],
        };
        const u = PROGRAMS + '?aid=1988&msToken=SECRETTOKEN';
        const p = page({ [u]: [200, JSON.stringify(body)] }, '/tiktokstudio/monetization');
        p.run();
        await p.call(u);
        const text = p.run() as string;
        const b = JSON.parse(text).responses[0].body;
        expect(b.active_m10n_programs).toHaveLength(1);
        const a = b.eligible_to_apply_m10n_programs[0];
        expect(a).toMatchObject({ name: 'Program B', m10n_project: 7, requirements_met: 1, total_requirements: 3, program_cta_text: 'Apply' });
        expect(a.access_restriction_info).toEqual({ is_access_restricted: true });
        expect(a.m10n_badge).toEqual([{ badge_label: 'New' }]);
        expect(b.ineligible_to_apply_m10n_programs[0].name).toBe('Program C');
        expect(JSON.stringify(JSON.parse(text).responses)).not.toContain('http');
        expect(text).not.toContain('SECRETTOKEN');
    });

    test('settings keep the selected currency', async () => {
        const u = '/tiktok/v1/creator/m10n_center/settings?aid=1';
        const p = page({ [u]: [200, JSON.stringify({ status_code: 0, all_currencies: [{ code: 'USD', display_name: 'US Dollar', symbol: '$' }], selected_currency: { code: 'USD' }, show_creator_spotlight: false })] });
        p.run();
        await p.call(u);
        const b = JSON.parse(p.run()).responses[0].body;
        expect(b.selected_currency).toEqual({ code: 'USD' });
    });

    test('an identical request is kept once (the latest answer)', async () => {
        const u = INSIGHT + qs([{ insigh_type: 'vv_history', days: 7 }]);
        const p = page({ [u]: [200, JSON.stringify(insightBody)] });
        p.run();
        await p.call(u);
        await p.call(u);
        expect(JSON.parse(p.run()).responses).toHaveLength(1);
    });

    test('installing twice does not hook twice', async () => {
        const u = INSIGHT + qs([{ insigh_type: 'vv_history', days: 7 }]);
        const p = page({ [u]: [200, JSON.stringify(insightBody)] });
        p.run();
        p.run();
        await p.call(u);
        expect(JSON.parse(p.run()).responses).toHaveLength(1);
    });

    describe('stop conditions', () => {
        test('HTTP 429 marks rateLimited', async () => {
            const u = INSIGHT + '?a=1';
            const p = page({ [u]: [429, '{"status_code":0}'] });
            p.run();
            await p.call(u);
            expect(JSON.parse(p.run())).toMatchObject({ rateLimited: true });
        });
        test('"too many attempts" in a JSON error message (HTTP 200) marks rateLimited and is not kept', async () => {
            const u = INSIGHT + '?a=1';
            const p = page({ [u]: [200, '{"status_code":1,"status_msg":"Too many attempts. Try again later."}'] });
            p.run();
            await p.call(u);
            const r = JSON.parse(p.run());
            expect(r.rateLimited).toBe(true);
            expect(r.responses).toHaveLength(0);
        });
        test('a metric answer whose text mentions "too many attempts" is kept (message-scoped)', async () => {
            const u = '/tiktok/v1/creator/m10n_center/all_programs?a=1';
            const body = { status_code: 0, active_m10n_programs: [{ name: 'SYNTH: too many attempts', description: 'too many requests', m10n_project: 1 }] };
            const p = page({ [u]: [200, JSON.stringify(body)] });
            p.run();
            await p.call(u);
            const r = JSON.parse(p.run());
            expect(r).toMatchObject({ rateLimited: false, challenge: false });
            expect(r.responses).toHaveLength(1);
        });
        test('an empty 403 and an HTML answer mark challenge', async () => {
            const u1 = INSIGHT + '?a=1';
            const u2 = '/tiktok/v1/creator/m10n_center/settings?a=1';
            const p = page({ [u1]: [403, ''], [u2]: [200, '<html>captcha</html>'] });
            p.run();
            await p.call(u1);
            expect(JSON.parse(p.run())).toMatchObject({ challenge: true });
            await p.call(u2);
            expect(JSON.parse(p.run()).responses).toHaveLength(0);
        });
    });

    test('has no scrolling or clicking API: a read-only hook', () => {
        const p = page({});
        p.run();
        expect(Object.keys(g.__ttStudio as object).sort()).toEqual(['state']);
        expect(SRC).not.toMatch(/\.click\(|scrollTo|dispatchEvent|\.submit\(/);
    });
});
