import { afterEach, describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import path from 'node:path';

import {
    hashtagFromCapture,
    mediaFromCapture,
    soundFromCapture,
    videosFromCapture,
    type Capture,
} from '../../skills/tiktok/scripts/read.ts';

// Phase 3: media projection, coverage (exhausted), list identity, hashtag and sound reads.

const SRC = readFileSync(path.resolve(import.meta.dir, '../../skills/tiktok/scripts/browser/capture.js'), 'utf8');
const g = globalThis as Record<string, unknown>;
const saved = { location: g.location, window: g.window, fetch: g.fetch, XMLHttpRequest: g.XMLHttpRequest, document: g.document, scrollTo: g.scrollTo };
afterEach(() => Object.assign(g, saved));

const rawItem = (id: string, over: Record<string, unknown> = {}) => ({
    id,
    desc: 'SYNTH: caption',
    createTime: 1700000000,
    stats: { playCount: 10, diggCount: 1, commentCount: 0, shareCount: 0, collectCount: 0 },
    video: {
        duration: 12,
        width: 1080,
        height: 1920,
        playAddr: 'https://v16-webapp.tiktokcdn.com/a/play.mp4',
        downloadAddr: 'https://v16-webapp.tiktokcdn.com/a/dl.mp4',
        bitrateInfo: [1, 2, 3, 4].map((n) => ({ Bitrate: n, PlayAddr: { UrlList: [`https://v19.tiktokcdn.com/b${n}.mp4`, 'https://v16-webapp.tiktokcdn.com/a/play.mp4'] } })),
        subtitleInfos: [{ LanguageCodeName: 'eng-US', Url: 'https://v16-webapp.tiktokcdn.com/s.vtt', Format: 'webvtt', Source: 'ASR', Size: 99 }],
        secretField: 'not kept',
    },
    music: { title: 'Sound', id: '777', authorName: 'synthetic_artist', original: true, playUrl: 'not kept' },
    author: { uniqueId: 'synthetic_a', secUid: 'not kept' },
    ...over,
});

interface Xhr { url: string; listeners: (() => void)[]; status: number; responseText: string; responseType: string; addEventListener(e: string, f: () => void): void }

function page(href: string) {
    const pending: { resolve: (r: Response) => void }[] = [];
    const xhrs: Xhr[] = [];
    g.location = new URL(href);
    g.window = globalThis;
    delete g.__ttCapture;
    g.fetch = () => new Promise<Response>((resolve) => pending.push({ resolve }));
    const X = function (this: Xhr) {
        this.listeners = [];
        this.addEventListener = (_e: string, f: () => void) => this.listeners.push(f);
        this.responseType = '';
        xhrs.push(this);
    } as unknown as { prototype: Record<string, unknown> };
    X.prototype.open = function (this: Xhr, _m: string, url: string) {
        this.url = url;
    };
    g.XMLHttpRequest = X;
    g.document = { getElementById: () => null, querySelector: () => null, body: { scrollHeight: 0 } };
    g.scrollTo = () => {};
    const run = (): Capture => JSON.parse((0, eval)(SRC));
    const go = (h: string) => {
        g.location = new URL(h);
    };
    const xhr = (url: string) => {
        const x = new (g.XMLHttpRequest as unknown as new () => Xhr & { open(m: string, u: string): void })();
        x.open('GET', url);
        return { done: (status: number, text: string) => { x.status = status; x.responseText = text; x.listeners.forEach((f) => f()); } };
    };
    return { run, go, xhr, pending };
}
const settle = () => new Promise((r) => setTimeout(r, 20));
const list = (ids: string[], hasMore: boolean, cursor: string) => JSON.stringify({ statusCode: 0, hasMore, cursor, itemList: ids.map((i) => rawItem(i)) });

describe('capture.js media projection and list identity', () => {
    test('keeps exactly the projected media fields of an item', async () => {
        const p = page('https://www.tiktok.com/@synthetic_a');
        p.run();
        const f = (g.fetch as (u: string) => Promise<Response>)('/api/post/item_list/?cursor=0&secUid=abc');
        p.pending[0].resolve(new Response(list(['1'], false, '16'), { status: 200 }));
        await f;
        await settle();
        const c = p.run();
        const v = (c.responses[0].body as { itemList: Record<string, any>[] }).itemList[0];
        expect(Object.keys(v.video).sort()).toEqual(['bitrateInfo', 'downloadAddr', 'duration', 'height', 'playAddr', 'subtitleInfos', 'width']);
        expect(v.video.bitrateInfo).toHaveLength(3);
        expect(v.video.bitrateInfo[0]).toEqual({ PlayAddr: { UrlList: ['https://v19.tiktokcdn.com/b1.mp4', 'https://v16-webapp.tiktokcdn.com/a/play.mp4'] } });
        expect(v.video.subtitleInfos).toEqual([{ LanguageCodeName: 'eng-US', Url: 'https://v16-webapp.tiktokcdn.com/s.vtt', Format: 'webvtt', Source: 'ASR' }]);
        expect(v.music).toEqual({ title: 'Sound', id: '777', authorName: 'synthetic_artist', original: true });
        expect(c.responses[0]).toMatchObject({ route: '@synthetic_a', reqCursor: '0' });
    });
    test('keeps hashtag and music list answers', async () => {
        const p = page('https://www.tiktok.com/tag/travel');
        p.run();
        const f = (g.fetch as (u: string) => Promise<Response>)('/api/challenge/item_list/?cursor=0');
        p.pending[0].resolve(new Response(list(['1'], false, '30'), { status: 200 }));
        await f;
        await settle();
        expect(p.run().responses.map((r) => [r.path, r.route])).toEqual([['/api/challenge/item_list/', 'tag/travel']]);
    });
    test('a non-digit cursor is not kept', async () => {
        const p = page('https://www.tiktok.com/tag/travel');
        p.run();
        const f = (g.fetch as (u: string) => Promise<Response>)('/api/challenge/item_list/?cursor=abc');
        p.pending[0].resolve(new Response(list(['1'], false, '30'), { status: 200 }));
        await f;
        await settle();
        expect(p.run().responses[0].reqCursor).toBeUndefined();
    });
    test('moving tag A → tag B keeps only B answers; delayed A answers are stale, not tagged B', async () => {
        const p = page('https://www.tiktok.com/tag/aaa');
        p.run();
        const fA = (g.fetch as (u: string) => Promise<Response>)('/api/challenge/item_list/?cursor=0');
        const xA = p.xhr('/api/challenge/item_list/?cursor=16');
        p.go('https://www.tiktok.com/tag/bbb');
        const fB = (g.fetch as (u: string) => Promise<Response>)('/api/challenge/item_list/?cursor=0');
        p.pending[1].resolve(new Response(list(['b1'], false, '9'), { status: 200 }));
        await fB;
        await settle();
        p.pending[0].resolve(new Response(list(['a1'], true, '16'), { status: 200 }));
        await fA;
        xA.done(200, list(['a2'], false, '32'));
        await settle();
        const c = p.run();
        expect(c.responses.map((r) => r.route)).toEqual(['tag/bbb']);
        expect(c.stale).toBe(2);
    });
    test('a stale answer with 429 or a challenge still stops reads', async () => {
        const p = page('https://www.tiktok.com/tag/aaa');
        p.run();
        const fA = (g.fetch as (u: string) => Promise<Response>)('/api/challenge/item_list/?cursor=0');
        const xA = p.xhr('/api/challenge/item_list/?cursor=16');
        p.go('https://www.tiktok.com/tag/bbb');
        p.pending[0].resolve(new Response('{}', { status: 429 }));
        await fA;
        xA.done(200, '{"type":"verify"}');
        await settle();
        const c = p.run();
        expect(c.rateLimited).toBe(true);
        expect(c.challenge).toBe(true);
    });
});

// ---- read.ts ----
const fx = (n: string) => JSON.parse(readFileSync(path.join(import.meta.dir, '../fixtures/tiktok', n), 'utf8'));
function cap(over: Partial<Capture>): Capture {
    return { schema: 'tt.capture.v1', url: 'https://www.tiktok.com/@jdnichollsc', capturedAt: '2026-11-15T00:00:00Z', scope: {}, responses: [], scrolls: 0, dropped: 0, ...over };
}
const base = () => fx('item-list-video.redacted.json').itemList[0];
const page2 = (p: string, ids: string[], hasMore: boolean, reqCursor: string | undefined, cursor: string, route = '@jdnichollsc', statusCode = 0) => ({
    path: p,
    route,
    reqCursor,
    body: { cursor, hasMore, statusCode, itemList: ids.map((id) => ({ ...base(), id, author: { uniqueId: 'jdnichollsc' } })) },
});
const POST = '/api/post/item_list/';
const ids = (n: number, from = 0) => Array.from({ length: n }, (_, i) => String(from + i + 1));

describe('coverage: exhausted', () => {
    test('limit filled with hasMore → complete, not exhausted', () => {
        const r = videosFromCapture(cap({ responses: [page2(POST, ids(5), true, '0', '5')] }), { limit: 3 });
        expect(r).toMatchObject({ complete: true, exhausted: false });
    });
    test('30 items, limit 20, terminal page → not exhausted (cut by limit)', () => {
        const r = videosFromCapture(cap({ responses: [page2(POST, ids(16), true, '0', '16'), page2(POST, ids(14, 16), false, '16', '30')] }), { limit: 20 });
        expect(r.data).toHaveLength(20);
        expect(r.exhausted).toBe(false);
    });
    test('full chain, terminal page, every item → exhausted', () => {
        const r = videosFromCapture(cap({ responses: [page2(POST, ids(16), true, '0', '16'), page2(POST, ids(14, 16), false, '16', '30')] }), { limit: 50 });
        expect(r).toMatchObject({ complete: true, exhausted: true });
    });
    test('an error page, dropped or stale answers → not exhausted', () => {
        const err = [page2(POST, ids(3), true, '0', '3'), page2(POST, [], false, '3', '3', '@jdnichollsc', 1)];
        expect(videosFromCapture(cap({ responses: err }), { limit: 50 }).exhausted).toBe(false);
        const one = [page2(POST, ids(3), false, '0', '3')];
        expect(videosFromCapture(cap({ responses: one, dropped: 1 }), { limit: 50 }).exhausted).toBe(false);
        expect(videosFromCapture(cap({ responses: one, stale: 1 }), { limit: 50 }).exhausted).toBe(false);
        expect(videosFromCapture(cap({ responses: one }), { limit: 50 }).exhausted).toBe(true);
    });
    test('a chain 0 → 16 → 32 with the middle page missing → not exhausted', () => {
        const r = videosFromCapture(cap({ responses: [page2(POST, ids(16), true, '0', '16'), page2(POST, ids(5, 32), false, '32', '37')] }), { limit: 50 });
        expect(r.exhausted).toBe(false);
    });
    test('answers without reqCursor (older captures) → not exhausted', () => {
        const r = videosFromCapture(cap({ responses: [page2(POST, ids(3), false, undefined, '3')] }), { limit: 50 });
        expect(r).toMatchObject({ complete: true, exhausted: false });
    });
    test('a first page not at cursor 0 → not exhausted', () => {
        expect(videosFromCapture(cap({ responses: [page2(POST, ids(3), false, '16', '19')] }), { limit: 50 }).exhausted).toBe(false);
    });
});

describe('list identity', () => {
    test('answers of one kind from two routes → mixed_lists', () => {
        const c = cap({ url: 'https://www.tiktok.com/tag/a', responses: [page2('/api/challenge/item_list/', ids(2), true, '0', '2', 'tag/a'), page2('/api/challenge/item_list/', ids(2, 2), false, '2', '4', 'tag/b')] });
        expect(() => hashtagFromCapture(c, {})).toThrow(expect.objectContaining({ kind: 'mixed_lists' }));
    });
});

describe('hashtag and sound reads', () => {
    test('hashtag list normalizes with musicId; hasMore → not_scrolled_far_enough', () => {
        const c = cap({ url: 'https://www.tiktok.com/tag/travel', responses: [{ ...page2('/api/challenge/item_list/', ['1', '2'], true, '0', '2', 'tag/travel'), body: { cursor: '2', hasMore: true, statusCode: 0, itemList: [rawItem('1'), rawItem('2')] } }] });
        const r = hashtagFromCapture(c, {});
        expect(r.data.map((v) => [v.id, v.musicId])).toEqual([['1', '777'], ['2', '777']]);
        expect(r).toMatchObject({ source: 'api', complete: false, reason: 'not_scrolled_far_enough', exhausted: false });
    });
    test('sound list normalizes; terminal chain → exhausted', () => {
        const c = cap({ url: 'https://www.tiktok.com/music/x-777', responses: [{ path: '/api/music/item_list/', route: 'music/x-777', reqCursor: '0', body: { cursor: '1', hasMore: false, statusCode: 0, itemList: [rawItem('9')] } }] });
        expect(soundFromCapture(c, {})).toMatchObject({ complete: true, exhausted: true, data: [{ id: '9', musicId: '777' }] });
    });
    test('no hashtag answers → [] with signed_list_api', () => {
        expect(hashtagFromCapture(cap({ url: 'https://www.tiktok.com/tag/x' }), {})).toMatchObject({ data: [], complete: false, reason: 'signed_list_api' });
    });
});

describe('mediaFromCapture', () => {
    test('extracts play urls (deduped, in order) and captions', () => {
        const c = cap({ responses: [{ path: POST, body: { statusCode: 0, hasMore: false, itemList: [rawItem('42')] } }] });
        const r = mediaFromCapture(c, '42');
        expect(r.data.playUrls).toEqual([
            'https://v16-webapp.tiktokcdn.com/a/play.mp4',
            'https://v16-webapp.tiktokcdn.com/a/dl.mp4',
            'https://v19.tiktokcdn.com/b1.mp4',
            'https://v19.tiktokcdn.com/b2.mp4',
            'https://v19.tiktokcdn.com/b3.mp4',
            'https://v19.tiktokcdn.com/b4.mp4',
        ]);
        expect(r.data).toMatchObject({ width: 1080, height: 1920, captions: [{ lang: 'eng-US', url: 'https://v16-webapp.tiktokcdn.com/s.vtt', format: 'webvtt', source: 'ASR' }], music: { id: '777', title: 'Sound', author: 'synthetic_artist', original: true } });
    });
    test('unknown id → not_found', () => {
        expect(() => mediaFromCapture(cap({}), '1')).toThrow(expect.objectContaining({ kind: 'not_found' }));
    });
});

describe('final review fixes: coverage needs terminal evidence', () => {
    test('a last page without hasMore is not proof the list ended', () => {
        const pg = page2(POST, ids(3), false, '0', '3');
        delete (pg.body as { hasMore?: boolean }).hasMore;
        const r = videosFromCapture(cap({ responses: [pg] }), { limit: 50 });
        expect(r.exhausted).toBe(false);
    });
});

describe('second review fixes: every page must be well formed', () => {
    test('a page without statusCode is not proof of anything', () => {
        const pg = page2(POST, ids(3), false, '0', '3');
        delete (pg.body as { statusCode?: number }).statusCode;
        const r = videosFromCapture(cap({ responses: [pg] }), { limit: 50 });
        expect(r.exhausted).toBe(false);
        expect(r.complete).toBe(false);
    });
    test('a malformed middle page breaks the chain', () => {
        const bad = { path: POST, route: '@jdnichollsc', reqCursor: '3', body: { cursor: '6' } };
        const r = videosFromCapture(cap({ responses: [page2(POST, ids(3), true, '0', '3'), bad as never, page2(POST, ids(3, 3), false, '6', '9')] }), { limit: 50 });
        expect(r.exhausted).toBe(false);
    });
});

describe('live page shapes (redacted captures of 2026-11-19)', () => {
    const live = (n: string) => JSON.parse(readFileSync(path.join(import.meta.dir, '../fixtures/tiktok', n), 'utf8')) as Capture;
    test('a /tag page read live: 30 posts from cursor 30, a sample (the cursor-0 page loads before the hook)', () => {
        const r = hashtagFromCapture(live('tag-item-list.redacted.json'), { limit: 30 });
        expect(r).toMatchObject({ source: 'api', complete: true, exhausted: false });
        expect(hashtagFromCapture(live('tag-item-list.redacted.json'), { limit: 100 })).toMatchObject({ complete: false, exhausted: false });
        expect(r.data).toHaveLength(30);
        expect(r.data[0]).toMatchObject({ durationSec: 9, plays: 1500000, likes: 196900, saves: 45200, isPhoto: false, hashtags: ['claude', 'ai', 'edit', 'coding', 'larp'] });
        expect(r.data.every((p) => /^https:\/\/www\.tiktok\.com\/@synthetic_creator\d+\/video\/\d+$/.test(p.url))).toBe(true);
    });
    test('a /music page read live: every post carries that sound', () => {
        const r = soundFromCapture(live('music-item-list.redacted.json'), { limit: 10 });
        expect(r).toMatchObject({ source: 'api', complete: true, exhausted: false });
        expect(r.data).toHaveLength(10);
        expect(new Set(r.data.map((p) => p.musicId))).toEqual(new Set(['7639417177691473937']));
    });
});
