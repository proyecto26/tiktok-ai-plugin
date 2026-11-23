import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { fetchFromCapture } from '../../skills/tiktok-video-breakdown/scripts/fetch.ts';
import { itemFromCapture, mediaFromCapture, normalizeVideo, parseCapture, videosFromCapture } from '../../skills/tiktok/scripts/read.ts';
import { clearSignal } from '../../skills/tiktok/scripts/signal.ts';

// Items TikTok flags as sensitive / age-restricted (isAd, maskType, contentLevel, ...) are read, projected and
// fetched like any other: the owner uses these skills knowingly and age-restricted posts are in scope.
const LIST = JSON.parse(readFileSync(path.resolve(import.meta.dir, '../fixtures/tiktok/item-list-restricted.synthetic.json'), 'utf8'));
const ID_PLAIN = '7000000000000000101';
const ID_ALT = '7000000000000000102';
const ID_NONE = '7000000000000000103';
const REFUSAL = /sensitiv|age.?restrict|not allowed|cannot (be )?(fetch|download)|unavailable for your age|refus/i;

const tmp = () => mkdtempSync(path.join(os.tmpdir(), 'tt-age-'));
function capFile(dir: string, body: unknown = LIST): string {
    const f = path.join(dir, 'cap.json');
    writeFileSync(f, JSON.stringify({ schema: 'tt.capture.v1', url: 'https://www.tiktok.com/@synthetic_a', capturedAt: '2026-11-17T00:00:00Z', scope: {}, responses: [{ path: '/api/post/item_list/', route: '@synthetic_a', reqCursor: '0', body }], scrolls: 0, dropped: 0 }));
    return f;
}
const media = (n = 16) => new Response(new Uint8Array(n).fill(1), { status: 200, headers: { 'content-type': 'video/mp4', 'content-length': String(n) } });
function fake(map: Record<string, () => Response>) {
    const calls: string[] = [];
    const impl = (async (u: string) => {
        calls.push(String(u));
        const k = Object.keys(map).find((x) => String(u).startsWith(x));
        if (!k) throw new Error(`unexpected ${u}`);
        return map[k]();
    }) as unknown as typeof fetch;
    return { impl, calls };
}

beforeEach(clearSignal);
afterEach(clearSignal);

describe('flagged items in the reader', () => {
    test('every flagged item is listed, none dropped', () => {
        const d = tmp();
        const r = videosFromCapture(parseCapture(readFileSync(capFile(d), 'utf8')), {});
        expect(r.data.map((v) => v.id)).toEqual([ID_PLAIN, ID_ALT, ID_NONE]);
        expect(r.data[0]).toMatchObject({ plays: 100, likes: 10, durationSec: 9 });
    });
    test('normalizeVideo does not look at the flags', () => {
        expect(normalizeVideo(LIST.itemList[1])).toMatchObject({ id: ID_ALT, isPhoto: false, plays: 50 });
    });
    test('the item is found by id', () => {
        const d = tmp();
        expect(itemFromCapture(parseCapture(readFileSync(capFile(d), 'utf8')), ID_ALT)).not.toBeNull();
    });
    test('the play URL is taken from PlayAddrStruct and every bitrate entry when playAddr is empty', () => {
        const d = tmp();
        const m = mediaFromCapture(parseCapture(readFileSync(capFile(d), 'utf8')), ID_ALT).data;
        expect(m.playUrls).toEqual([
            'https://v19.tiktokcdn.com/b/struct.mp4',
            'https://v16-webapp.tiktokcdn.com/c/rate2.mp4',
            'https://v16-webapp.tiktokcdn.com/c/rate3.mp4',
            'https://v16-webapp.tiktokcdn.com/c/rate4.mp4',
        ]);
    });
    test('a lower-case playAddrStruct and a playAddr object with a UrlList are read too', () => {
        const d = tmp();
        const body = { statusCode: 0, hasMore: false, cursor: '1', itemList: [
            { id: '1', video: { playAddrStruct: { UrlList: ['https://v16.tiktokcdn.com/x/a.mp4'] } }, author: { uniqueId: 'synthetic_a' } },
            { id: '2', video: { playAddr: { UrlList: ['https://v16.tiktokcdn.com/x/b.mp4'] } }, author: { uniqueId: 'synthetic_a' } },
        ] };
        const c = parseCapture(readFileSync(capFile(d, body), 'utf8'));
        expect(mediaFromCapture(c, '1').data.playUrls).toEqual(['https://v16.tiktokcdn.com/x/a.mp4']);
        expect(mediaFromCapture(c, '2').data.playUrls).toEqual(['https://v16.tiktokcdn.com/x/b.mp4']);
    });
});

describe('flagged items in fetch', () => {
    test('a flagged item with a play address is downloaded, with no refusal wording', async () => {
        const d = tmp();
        const logs: string[] = [];
        const f = fake({ 'https://v16-webapp.tiktokcdn.com/a/play.mp4': () => media(16) });
        const meta = await fetchFromCapture(capFile(d), ID_PLAIN, path.join(d, 'out'), { fetchImpl: f.impl, log: (m) => logs.push(m) });
        expect(meta).toMatchObject({ post_id: ID_PLAIN, owner: 'synthetic_a', video: { bytes: 16 } });
        expect(JSON.stringify(meta) + logs.join('\n')).not.toMatch(REFUSAL);
    });
    test('a flagged item whose play URL is only under alternative fields is downloaded from the first that works', async () => {
        const d = tmp();
        const f = fake({
            'https://v19.tiktokcdn.com/b/struct.mp4': () => new Response('', { status: 404 }),
            'https://v16-webapp.tiktokcdn.com/c/rate2.mp4': () => media(24),
        });
        const meta = await fetchFromCapture(capFile(d), ID_ALT, path.join(d, 'out'), { fetchImpl: f.impl });
        expect(meta.video).toMatchObject({ bytes: 24, cdn_host: 'v16-webapp.tiktokcdn.com' });
        expect(readFileSync(path.join(d, 'out/source/meta.json'), 'utf8')).not.toContain('struct.mp4');
    });
    test('a flagged item with no play address at all fails with a reason about the capture, not about its age flag', async () => {
        const d = tmp();
        const f = fake({});
        const e = await fetchFromCapture(capFile(d), ID_NONE, path.join(d, 'out'), { fetchImpl: f.impl }).catch((x: any) => x);
        expect(e.kind).toBe('no_play_url');
        expect(e.message).toMatch(/no video link/i);
        expect(e.message).toMatch(/fetch --file/);
        expect(e.message).not.toMatch(REFUSAL);
        expect(f.calls).toHaveLength(0);
    });
});

describe('capture.js projection of flagged items', () => {
    const SRC = readFileSync(path.resolve(import.meta.dir, '../../skills/tiktok/scripts/browser/capture.js'), 'utf8');
    const g = globalThis as Record<string, unknown>;
    const saved = { location: g.location, window: g.window, fetch: g.fetch, XMLHttpRequest: g.XMLHttpRequest, document: g.document, scrollTo: g.scrollTo };
    afterEach(() => Object.assign(g, saved));

    test('the alternative play fields survive the projection and the capture reads back', async () => {
        g.location = { origin: 'https://www.tiktok.com', href: 'https://www.tiktok.com/@synthetic_a' };
        g.window = globalThis;
        delete g.__ttCapture;
        g.fetch = async () => new Response(JSON.stringify(LIST), { status: 200 });
        g.XMLHttpRequest = function () {};
        (g.XMLHttpRequest as { prototype: Record<string, unknown> }).prototype.open = function () {};
        g.document = { getElementById: () => null, querySelector: () => null, body: { scrollHeight: 0 } };
        g.scrollTo = () => {};
        const run = () => (0, eval)(SRC);
        run();
        await (g.fetch as (u: string) => Promise<Response>)('/api/post/item_list/?a=1');
        await new Promise((r) => setTimeout(r, 20));
        const text = run() as string;
        const out = JSON.parse(text);
        expect(out.responses).toHaveLength(1);
        expect(out.responses[0].body.itemList.map((i: any) => i.id)).toEqual([ID_PLAIN, ID_ALT, ID_NONE]);
        const m = mediaFromCapture(parseCapture(text), ID_ALT).data;
        expect(m.playUrls).toHaveLength(4);
        expect(m.playUrls[0]).toBe('https://v19.tiktokcdn.com/b/struct.mp4');
        expect(mediaFromCapture(parseCapture(text), ID_PLAIN).data.playUrls).toEqual(['https://v16-webapp.tiktokcdn.com/a/play.mp4']);
    });
});
