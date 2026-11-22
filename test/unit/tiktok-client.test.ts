import { afterEach, describe, expect, test } from 'bun:test';
import { spawnSync, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';

import { classifyResponse, TtClient } from '../../skills/tiktok/scripts/client.ts';
import { writeCookieMapToDisk } from '../../skills/tiktok/scripts/cookie-store.ts';
import { resolveCookiePath } from '../../skills/tiktok/scripts/paths.ts';
import { clearSignal, readSignal, writeSignal } from '../../skills/tiktok/scripts/signal.ts';

const FIX = path.join(import.meta.dir, '../fixtures/tiktok');
const fx = (name: string) => readFileSync(path.join(FIX, name), 'utf8');
const SCRIPTS = path.resolve(import.meta.dir, '../../skills/tiktok/scripts').replace(/\\/g, '/');

type Call = { url: string; headers: Record<string, string>; redirect?: string };
function fakeFetch(responses: (Response | (() => Response))[]) {
    const calls: Call[] = [];
    const impl = (async (input: string | URL, init?: RequestInit) => {
        calls.push({ url: String(input), headers: (() => { const o: Record<string, string> = {}; new Headers(init?.headers).forEach((v, k) => (o[k] = v)); return o; })(), redirect: init?.redirect });
        const r = responses.shift();
        if (!r) throw new Error('no more fake responses');
        return typeof r === 'function' ? r() : r;
    }) as unknown as typeof fetch;
    return { impl, calls };
}
const html = (body: string, status = 200, headers: Record<string, string> = {}) =>
    new Response(body, { status, headers: { 'content-type': 'text/html', ...headers } });

afterEach(async () => {
    await clearSignal();
    process.env.TIKTOK_MIN_GAP_MS = '0';
});

describe('classifyResponse', () => {
    test('429 is rate_limited', () => expect(classifyResponse(429, 'https://www.tiktok.com/@x', '')).toBe('rate_limited'));
    test('captcha page served with 200 is a challenge', () =>
        expect(classifyResponse(200, 'https://www.tiktok.com/@x', fx('captcha.synthetic.html'))).toBe('challenge'));
    test('JSON verify body is a challenge', () =>
        expect(classifyResponse(200, 'https://www.tiktok.com/api/x', fx('verify.synthetic.json'))).toBe('challenge'));
    test('"too many attempts" is a challenge', () =>
        expect(classifyResponse(200, 'https://www.tiktok.com/api/x', fx('too-many-attempts.synthetic.json'))).toBe('challenge'));
    test('a usable JSON answer that only quotes "too many attempts" in content is not a stop', () =>
        expect(classifyResponse(200, 'https://www.tiktok.com/api/x', JSON.stringify({ statusCode: 0, itemList: [{ desc: 'SYNTH: too many attempts' }] }))).toBeNull());
    test('a redirect to /login is auth', () =>
        expect(classifyResponse(302, 'https://www.tiktok.com/@x', '', '/login?redirect_url=x')).toBe('auth'));
    test('"user not exist" status is not_found', () =>
        expect(classifyResponse(200, 'https://www.tiktok.com/api/x', fx('user-not-exist.synthetic.json'))).toBe('not_found'));
    test('the WAF "Please wait" interstitial is a challenge', () =>
        expect(classifyResponse(200, 'https://www.tiktok.com/@x', fx('waf-challenge.redacted.html'))).toBe('challenge'));
    test('a normal page is null', () => expect(classifyResponse(200, 'https://www.tiktok.com/@x', '<html>ok</html>')).toBeNull());
});

describe('TtClient transport guards', () => {
    test('foreign host throws before fetch', async () => {
        const f = fakeFetch([]);
        await expect(new TtClient({ fetchImpl: f.impl, cookies: { sessionid: 'a' } }).getText('https://example.com/')).rejects.toThrow();
        expect(f.calls.length).toBe(0);
    });

    test('redirects are manual; a login Location is auth with no second request, and writes the signal', async () => {
        const f = fakeFetch([html('', 302, { location: '/login?redirect_url=%2F%40x' })]);
        await expect(new TtClient({ fetchImpl: f.impl, cookies: { sessionid: 'a' } }).getText('https://www.tiktok.com/@x')).rejects.toMatchObject({ kind: 'auth' });
        expect(f.calls.length).toBe(1);
        expect(f.calls[0].redirect).toBe('manual');
        expect((await readSignal())?.kind).toBe('auth');
    });

    test('a redirect to a foreign host fails before following', async () => {
        const f = fakeFetch([html('', 302, { location: 'https://evil.example/' })]);
        await expect(new TtClient({ fetchImpl: f.impl, cookies: { sessionid: 'a' } }).getText('https://www.tiktok.com/@x')).rejects.toThrow(/host/i);
        expect(f.calls.length).toBe(1);
    });

    test('a chain of 4 hops inside tiktok.com fails', async () => {
        const hop = (n: number) => html('', 302, { location: `/hop${n}` });
        const f = fakeFetch([hop(1), hop(2), hop(3), hop(4), html('ok')]);
        await expect(new TtClient({ fetchImpl: f.impl, cookies: { sessionid: 'a' } }).getText('https://www.tiktok.com/a')).rejects.toThrow(/redirect/i);
        expect(f.calls.length).toBe(4);
    });

    test('a challenge writes the signal; later calls are blocked without fetch, also in another process', async () => {
        const f = fakeFetch([html(fx('captcha.synthetic.html'))]);
        await expect(new TtClient({ fetchImpl: f.impl, cookies: { sessionid: 'a' } }).getText('https://www.tiktok.com/@x')).rejects.toMatchObject({ kind: 'challenge' });
        const g = fakeFetch([html('ok')]);
        await expect(new TtClient({ fetchImpl: g.impl, cookies: { sessionid: 'a' } }).getText('https://www.tiktok.com/@x')).rejects.toMatchObject({ code: 'blocked_by_signal' });
        expect(g.calls.length).toBe(0);
        const child = spawnSync(process.execPath, ['-e', `import('${SCRIPTS}/client.ts').then(m => new m.TtClient({ cookies: { sessionid: 'a' }, fetchImpl: () => { process.exit(4) } }).getText('https://www.tiktok.com/')).then(() => process.exit(0), e => process.exit(e.code === 'blocked_by_signal' ? 3 : 1))`], { env: process.env });
        expect(child.status).toBe(3);
        await clearSignal();
        const h = fakeFetch([html('ok')]);
        expect((await new TtClient({ fetchImpl: h.impl, cookies: { sessionid: 'a' } }).getText('https://www.tiktok.com/@x')).text).toBe('ok');
    });

    test('a request waiting its turn is refused when another process writes the signal', async () => {
        process.env.TIKTOK_MIN_GAP_MS = '600';
        const f = fakeFetch([html('ok'), html('ok')]);
        const c = new TtClient({ fetchImpl: f.impl, cookies: { sessionid: 'a' } });
        await c.getText('https://www.tiktok.com/1');
        const pending = c.getText('https://www.tiktok.com/2');
        spawnSync(process.execPath, ['-e', `import('${SCRIPTS}/signal.ts').then(m => m.writeSignal('challenge', 'from another process'))`], { env: process.env });
        await expect(pending).rejects.toMatchObject({ code: 'blocked_by_signal' });
        expect(f.calls.length).toBe(1);
    });

    test('two processes are paced at least the gap apart', async () => {
        const env = { ...process.env, TIKTOK_MIN_GAP_MS: '300' };
        const code = `import('${SCRIPTS}/throttle.ts').then(m => m.waitTurn()).then(() => console.log(Date.now()))`;
        const run = () =>
            new Promise<number>((resolve) => {
                const p = spawn(process.execPath, ['-e', code], { env });
                let out = '';
                p.stdout.on('data', (d) => (out += d));
                p.on('close', () => resolve(Number(out.trim())));
            });
        const [a, b] = await Promise.all([run(), run()]);
        expect(Math.abs(a - b)).toBeGreaterThanOrEqual(290);
    });
});

describe('probe mode (settling required cookies)', () => {
    async function seeded() {
        await writeCookieMapToDisk({ sessionid: 'STORE', ttwid: 'STORE' });
        process.env.TIKTOK_COOKIES = 'sessionid=ENV';
        return createHash('sha256').update(readFileSync(resolveCookiePath())).digest('hex');
    }
    afterEach(() => delete process.env.TIKTOK_COOKIES);

    for (const withEnv of [false, true]) {
        test(`overrides reach fetch exactly and Set-Cookie changes nothing (env set: ${withEnv})`, async () => {
            const before = await seeded();
            if (!withEnv) delete process.env.TIKTOK_COOKIES;
            const f = fakeFetch([html('ok', 200, { 'set-cookie': 'sessionid=ROTATED; Path=/' }), html('ok', 200, { 'set-cookie': 'msToken=NEW; Path=/' })]);
            const reduced = { ttwid: 'R' };
            await new TtClient({ fetchImpl: f.impl, cookies: reduced, probe: true }).getText('https://www.tiktok.com/a');
            await new TtClient({ fetchImpl: f.impl, cookies: {}, probe: true }).getText('https://www.tiktok.com/b');
            expect(f.calls[0].headers.cookie).toBe('ttwid=R');
            expect(f.calls[1].headers.cookie).toBeUndefined();
            expect(reduced).toEqual({ ttwid: 'R' });
            expect(createHash('sha256').update(readFileSync(resolveCookiePath())).digest('hex')).toBe(before);
            if (withEnv) expect(process.env.TIKTOK_COOKIES).toBe('sessionid=ENV');
        });
    }

    test('probe auth leaves no signal; probe challenge and rate_limited write one', async () => {
        const login = () => html('', 302, { location: '/login' });
        await expect(new TtClient({ fetchImpl: fakeFetch([login()]).impl, cookies: {}, probe: true }).getText('https://www.tiktok.com/a')).rejects.toMatchObject({ kind: 'auth' });
        expect(await readSignal()).toBeNull();
        await expect(new TtClient({ fetchImpl: fakeFetch([html(fx('captcha.synthetic.html'))]).impl, cookies: {}, probe: true }).getText('https://www.tiktok.com/a')).rejects.toMatchObject({ kind: 'challenge' });
        expect((await readSignal())?.kind).toBe('challenge');
        await clearSignal();
        await expect(new TtClient({ fetchImpl: fakeFetch([html('', 429)]).impl, cookies: {}, probe: true }).getText('https://www.tiktok.com/a')).rejects.toMatchObject({ kind: 'rate_limited' });
        expect((await readSignal())?.kind).toBe('rate_limited');
    });

    test('an existing signal prevents probe dispatch', async () => {
        await writeSignal('challenge', 'x');
        const f = fakeFetch([html('ok')]);
        await expect(new TtClient({ fetchImpl: f.impl, cookies: {}, probe: true }).getText('https://www.tiktok.com/a')).rejects.toMatchObject({ code: 'blocked_by_signal' });
        expect(f.calls.length).toBe(0);
    });

    test('probe mode requires an explicit cookie override', () => {
        expect(() => new TtClient({ probe: true })).toThrow(/cookies/);
    });
});
