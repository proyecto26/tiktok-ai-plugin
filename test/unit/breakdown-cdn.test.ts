import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { CDN_HOSTS, downloadCdn, isAllowedCdn, redactUrl, type Operator } from '../../skills/tiktok-video-breakdown/scripts/cdn.ts';
import { clearSignal, readSignal, writeSignal } from '../../skills/tiktok/scripts/signal.ts';

const dir = () => mkdtempSync(path.join(os.tmpdir(), 'tt-cdn-'));
const OK = 'https://v16-webapp.tiktokcdn.com/a/b/video.mp4?sig=SECRET123&expire=1';
const media = (bytes = 8, extra: Record<string, string> = {}) =>
    new Response(new Uint8Array(bytes).fill(7), { status: 200, headers: { 'content-type': 'video/mp4', 'content-length': String(bytes), ...extra } });

type Call = { url: string; init: RequestInit };
function fake(answers: (Response | (() => Response | Promise<Response>))[]) {
    const calls: Call[] = [];
    const impl = (async (url: string, init: RequestInit) => {
        calls.push({ url: String(url), init });
        const a = answers.shift();
        if (!a) throw new Error('no more answers');
        return typeof a === 'function' ? a() : a;
    }) as unknown as typeof fetch;
    return { impl, calls };
}

let turns = 0;
let checks = 0;
const realOps = async (): Promise<Operator> => {
    const s = await import('../../skills/tiktok/scripts/signal.ts');
    const c = await import('../../skills/tiktok/scripts/client.ts');
    return {
        assertNoSignal: async () => {
            checks++;
            await s.assertNoSignal();
        },
        writeSignal: s.writeSignal,
        waitTurn: async () => {
            turns++;
        },
        patterns: { captcha: c.CAPTCHA_HTML, waf: c.WAF_HTML, verify: c.VERIFY_JSON, tooMany: c.TOO_MANY, loginPath: c.LOGIN_PATH, verifyPath: c.VERIFY_PATH },
    };
};

beforeEach(async () => {
    turns = 0;
    checks = 0;
    await clearSignal();
});
afterEach(async () => {
    await clearSignal();
});

describe('allowlist', () => {
    test('TikTok CDN hosts pass; look-alikes and http do not', () => {
        expect(CDN_HOSTS.length).toBeGreaterThan(0);
        expect(isAllowedCdn(OK)).toBe(true);
        expect(isAllowedCdn('https://tiktokcdn.com.evil.io/v.mp4')).toBe(false);
        expect(isAllowedCdn('https://eviltiktokcdn.com/v.mp4')).toBe(false);
        expect(isAllowedCdn('http://v16-webapp.tiktokcdn.com/v.mp4')).toBe(false);
        expect(isAllowedCdn('not a url')).toBe(false);
    });
    test('redactUrl keeps scheme, host and path only', () => {
        expect(redactUrl(OK)).toBe('https://v16-webapp.tiktokcdn.com/a/b/video.mp4');
    });
});

describe('downloadCdn', () => {
    test('downloads from an allowed host with no cookies, paced and checked', async () => {
        const d = dir();
        const f = fake([media(8)]);
        const r = await downloadCdn(OK, path.join(d, 'v.mp4'), { fetchImpl: f.impl, ops: await realOps() });
        expect(r).toEqual({ bytes: 8, contentType: 'video/mp4' });
        expect(readFileSync(path.join(d, 'v.mp4')).length).toBe(8);
        const h = new Headers(f.calls[0].init.headers);
        expect(h.get('cookie')).toBeNull();
        expect(h.get('referer')).toBe('https://www.tiktok.com/');
        expect(f.calls[0].init.credentials).toBe('omit');
        expect(f.calls[0].init.redirect).toBe('manual');
        expect(turns).toBe(1);
        expect(checks).toBe(1);
    });
    test('a refused host never reaches fetch; the error is redacted', async () => {
        const f = fake([]);
        const e = await downloadCdn('https://tiktokcdn.com.evil.io/v.mp4?token=SECRET', path.join(dir(), 'v.mp4'), { fetchImpl: f.impl, ops: await realOps() }).catch((x: any) => x);
        expect(e.kind).toBe('host_refused');
        expect(String(e.message)).not.toContain('SECRET');
        expect(f.calls).toHaveLength(0);
    });
    test('a redirect off the list is refused before writing', async () => {
        const d = dir();
        const f = fake([new Response(null, { status: 302, headers: { location: 'https://evil.example/v.mp4' } })]);
        const e = await downloadCdn(OK, path.join(d, 'v.mp4'), { fetchImpl: f.impl, ops: await realOps() }).catch((x: any) => x);
        expect(e.kind).toBe('host_refused');
        expect(existsSync(path.join(d, 'v.mp4'))).toBe(false);
    });
    test('redirects within the list are followed, paced and checked per hop; the 4th is refused', async () => {
        const hop = (n: number) => new Response(null, { status: 302, headers: { location: `https://v19.tiktokcdn.com/h${n}.mp4` } });
        const ok = fake([hop(1), hop(2), hop(3), media(4)]);
        await downloadCdn(OK, path.join(dir(), 'v.mp4'), { fetchImpl: ok.impl, ops: await realOps() });
        expect(ok.calls).toHaveLength(4);
        expect(turns).toBe(4);
        expect(checks).toBe(4);
        const many = fake([hop(1), hop(2), hop(3), hop(4)]);
        const e = await downloadCdn(OK, path.join(dir(), 'v.mp4'), { fetchImpl: many.impl, ops: await realOps() }).catch((x: any) => x);
        expect(e.kind).toBe('too_many_redirects');
    });
    test('a signal written between hops stops the next hop', async () => {
        const f = fake([
            async () => {
                await writeSignal('challenge', 'other process');
                return new Response(null, { status: 302, headers: { location: 'https://v19.tiktokcdn.com/x.mp4' } });
            },
        ]);
        const e = await downloadCdn(OK, path.join(dir(), 'v.mp4'), { fetchImpl: f.impl, ops: await realOps() }).catch((x: any) => x);
        expect(e.code ?? e.kind).toBe('blocked_by_signal');
        expect(f.calls).toHaveLength(1);
    });
    test('403 and 429 write the account signal', async () => {
        const a = await downloadCdn(OK, path.join(dir(), 'v.mp4'), { fetchImpl: fake([new Response('', { status: 403 })]).impl, ops: await realOps() }).catch((x: any) => x);
        expect(a.kind).toBe('signal_written');
        expect((await readSignal())?.kind).toBe('blocked');
        await clearSignal();
        await downloadCdn(OK, path.join(dir(), 'v.mp4'), { fetchImpl: fake([new Response('', { status: 429 })]).impl, ops: await realOps() }).catch((x: any) => x);
        expect((await readSignal())?.kind).toBe('rate_limited');
    });
    test('a 200 captcha or HTML body where media was expected writes challenge', async () => {
        const html = new Response('<html><div id="captcha-verify-container"></div></html>', { status: 200, headers: { 'content-type': 'text/html' } });
        const e = await downloadCdn(OK, path.join(dir(), 'v.mp4'), { fetchImpl: fake([html]).impl, ops: await realOps() }).catch((x: any) => x);
        expect(e.kind).toBe('signal_written');
        expect((await readSignal())?.kind).toBe('challenge');
    });
    test('a redirect to a TikTok login page writes the signal', async () => {
        const f = fake([new Response(null, { status: 302, headers: { location: 'https://www.tiktok.com/login?redirect=x' } })]);
        const e = await downloadCdn(OK, path.join(dir(), 'v.mp4'), { fetchImpl: f.impl, ops: await realOps() }).catch((x: any) => x);
        expect(e.kind).toBe('signal_written');
        expect((await readSignal())?.kind).toBe('auth');
    });
    test('404 and 410 are "gone" without a signal', async () => {
        const e = await downloadCdn(OK, path.join(dir(), 'v.mp4'), { fetchImpl: fake([new Response('', { status: 404 })]).impl, ops: await realOps() }).catch((x: any) => x);
        expect(e.kind).toBe('gone');
        expect(await readSignal()).toBeNull();
        expect(String(e.message)).not.toContain('SECRET');
    });
    test('over maxBytes → too_large, partial removed', async () => {
        const d = dir();
        const body = new ReadableStream<Uint8Array>({
            start(c) {
                c.enqueue(new Uint8Array(6));
                c.enqueue(new Uint8Array(6));
                c.close();
            },
        });
        const f = fake([new Response(body, { status: 200, headers: { 'content-type': 'video/mp4' } })]);
        const e = await downloadCdn(OK, path.join(d, 'v.mp4'), { fetchImpl: f.impl, ops: await realOps(), maxBytes: 10 }).catch((x: any) => x);
        expect(e.kind).toBe('too_large');
        expect(existsSync(path.join(d, 'v.mp4'))).toBe(false);
    });
    test('probeBytes stops early and keeps nothing', async () => {
        const d = dir();
        const r = await downloadCdn(OK, path.join(d, 'v.mp4'), { fetchImpl: fake([media(100)]).impl, ops: await realOps(), probeBytes: 10 });
        expect(r.bytes).toBeGreaterThanOrEqual(10);
        expect(r.contentType).toBe('video/mp4');
        expect(existsSync(path.join(d, 'v.mp4'))).toBe(false);
    });
    test('headers that never arrive → download_stalled, request aborted', async () => {
        let aborted = false;
        const impl = ((_u: string, init: RequestInit) =>
            new Promise<Response>((_, reject) => {
                init.signal?.addEventListener('abort', () => {
                    aborted = true;
                    reject(new Error('aborted'));
                });
            })) as unknown as typeof fetch;
        const e = await downloadCdn(OK, path.join(dir(), 'v.mp4'), { fetchImpl: impl, ops: await realOps(), idleMs: 30 }).catch((x: any) => x);
        expect(e.kind).toBe('download_stalled');
        expect(aborted).toBe(true);
    });
    test('a body that stalls mid-stream → download_stalled, partial removed', async () => {
        const d = dir();
        const body = new ReadableStream<Uint8Array>({
            start(c) {
                c.enqueue(new Uint8Array(4));
            },
        });
        const f = fake([new Response(body, { status: 200, headers: { 'content-type': 'video/mp4' } })]);
        const e = await downloadCdn(OK, path.join(d, 'v.mp4'), { fetchImpl: f.impl, ops: await realOps(), idleMs: 30 }).catch((x: any) => x);
        expect(e.kind).toBe('download_stalled');
        expect(existsSync(path.join(d, 'v.mp4'))).toBe(false);
    });
    test('an existing signal stops before any request', async () => {
        await writeSignal('challenge', 'earlier');
        const f = fake([media(4)]);
        const e = await downloadCdn(OK, path.join(dir(), 'v.mp4'), { fetchImpl: f.impl, ops: await realOps() }).catch((x: any) => x);
        expect(e.code).toBe('blocked_by_signal');
        expect(f.calls).toHaveLength(0);
    });
});

describe('final review fixes', () => {
    test('a transport error that quotes the signed URL is redacted', async () => {
        const f = fake([() => Promise.reject(new TypeError(`fetch failed: unable to connect to ${OK}`))]);
        const e = (await downloadCdn(OK, path.join(dir(), 'v.mp4'), { fetchImpl: f.impl, ops: await realOps() }).catch((x) => x)) as Error;
        expect(e.message).not.toContain('SECRET123');
        expect(e.message).not.toContain('?sig=');
    });
    test('a body-read error that quotes the signed URL is redacted', async () => {
        const body = new ReadableStream<Uint8Array>({
            start(c) {
                c.error(new Error(`stream aborted for ${OK}`));
            },
        });
        const f = fake([new Response(body, { status: 200, headers: { 'content-type': 'video/mp4' } })]);
        const e = (await downloadCdn(OK, path.join(dir(), 'v.mp4'), { fetchImpl: f.impl, ops: await realOps() }).catch((x) => x)) as Error;
        expect(e).toBeInstanceOf(Error);
        expect(e.message).not.toContain('SECRET123');
    });
    test('an HTML challenge served as octet-stream is a challenge, not media', async () => {
        const html = '<!DOCTYPE html><html><body>Please wait... captcha</body></html>';
        const f = fake([new Response(html, { status: 200, headers: { 'content-type': 'application/octet-stream' } })]);
        const d = dir();
        const e = (await downloadCdn(OK, path.join(d, 'v.mp4'), { fetchImpl: f.impl, ops: await realOps() }).catch((x) => x)) as Error & { kind?: string };
        expect(e).toBeInstanceOf(Error);
        expect(existsSync(path.join(d, 'v.mp4'))).toBe(false);
        expect(await readSignal()).not.toBeNull();
    });
    test('a non-media body that never ends times out instead of hanging', async () => {
        const body = new ReadableStream<Uint8Array>({
            start(c) {
                c.enqueue(new TextEncoder().encode('{"partial":'));
            },
        });
        const f = fake([new Response(body, { status: 200, headers: { 'content-type': 'application/json' } })]);
        const e = (await downloadCdn(OK, path.join(dir(), 'v.mp4'), { fetchImpl: f.impl, ops: await realOps(), idleMs: 50 }).catch((x) => x)) as Error;
        expect(e).toBeInstanceOf(Error);
    });
});
