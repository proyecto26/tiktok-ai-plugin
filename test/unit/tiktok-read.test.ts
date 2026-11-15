import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import path from 'node:path';

import {
    commentsFromCapture,
    extractEmbedded,
    parseCapture,
    profileFromCapture,
    videoFromCapture,
    videosFromCapture,
    type Capture,
} from '../../skills/tiktok/scripts/read.ts';

const fx = (n: string) => JSON.parse(readFileSync(path.join(import.meta.dir, '../fixtures/tiktok', n), 'utf8'));

function cap(over: Partial<Capture>): Capture {
    return { schema: 'tt.capture.v1', url: 'https://www.tiktok.com/@jdnichollsc', capturedAt: '2026-11-15T00:00:00Z', scope: {}, responses: [], scrolls: 0, ...over };
}
const profileScope = () => fx('profile-scope.redacted.json').__DEFAULT_SCOPE__;
const listPage = (ids: string[], hasMore: boolean) => ({
    path: '/api/post/item_list/',
    body: { cursor: '1', hasMore, statusCode: 0, itemList: ids.map((id) => ({ ...fx('item-list-video.redacted.json').itemList[0], id })) },
});

describe('capture parsing', () => {
    test('rejects a capture from another site or schema', () => {
        expect(() => parseCapture(JSON.stringify(cap({ url: 'https://evil.example/@x' })))).toThrow(/tiktok/i);
        expect(() => parseCapture(JSON.stringify({ ...cap({}), schema: 'x' }))).toThrow(/schema/i);
    });
    test('extractEmbedded reads the rehydration script from html', () => {
        const html = `<html><script id="__UNIVERSAL_DATA_FOR_REHYDRATION__" type="application/json">${JSON.stringify(fx('profile-scope.redacted.json'))}</script></html>`;
        expect((extractEmbedded(html) as { __DEFAULT_SCOPE__: unknown }).__DEFAULT_SCOPE__).toBeDefined();
        expect(extractEmbedded('<html>Please wait...</html>')).toBeNull();
    });
});

describe('profile', () => {
    test('normalizes the live user-detail scope', () => {
        const r = profileFromCapture(cap({ scope: profileScope() }));
        expect(r.source).toBe('page');
        expect(r.complete).toBe(true);
        expect(r.data).toMatchObject({ username: 'jdnichollsc', nickname: 'J.D X El Mundo', followers: 1057, following: 8230, likes: 16100, videoCount: 193, private: false });
    });
    test('nonexistent user → not_found', () => {
        expect(() => profileFromCapture(cap({ scope: fx('profile-not-found.synthetic.json').__DEFAULT_SCOPE__ }))).toThrow(expect.objectContaining({ kind: 'not_found' }));
    });
    test('a page without the scope → unexpected_page', () => {
        expect(() => profileFromCapture(cap({ scope: {} }))).toThrow(expect.objectContaining({ kind: 'unexpected_page' }));
    });
    test('private account is reported, not an error', () => {
        expect(profileFromCapture(cap({ scope: fx('profile-private.synthetic.json').__DEFAULT_SCOPE__ })).data.private).toBe(true);
    });
});

describe('videos', () => {
    test('normalizes item_list items: video and photo post', () => {
        const r = videosFromCapture(cap({ scope: profileScope(), responses: [{ path: '/api/post/item_list/', body: fx('item-list-video.redacted.json') }] }), {});
        expect(r.source).toBe('api');
        const [v, p] = r.data;
        expect(v).toMatchObject({ id: '7606492896908299528', durationSec: 60, plays: 294, likes: 7, isPhoto: false, hashtags: ['paratiiiiiiiiiiiiiiiiiiiiiiiiiiiiiii', 'fyp', 'fypシ゚'] });
        expect(v.url).toBe('https://www.tiktok.com/@jdnichollsc/video/7606492896908299528');
        expect(p).toMatchObject({ isPhoto: true, imageCount: 2 });
        expect(p.url).toContain('/photo/');
    });
    test('--limit 3 returns 3', () => {
        const r = videosFromCapture(cap({ responses: [listPage(['1', '2', '3', '4'], true)] }), { limit: 3 });
        expect(r.data.map((v) => v.id)).toEqual(['1', '2', '3']);
        expect(r.complete).toBe(true);
    });
    test('default limit 20, clamp 200, duplicates removed', () => {
        const ids = Array.from({ length: 30 }, (_, i) => String(i));
        expect(videosFromCapture(cap({ responses: [listPage(ids, true), listPage(['0', '1'], true)] }), {}).data.length).toBe(20);
        const many = Array.from({ length: 250 }, (_, i) => String(i));
        expect(videosFromCapture(cap({ responses: [listPage(many, true)] }), { limit: 500 }).data.length).toBe(200);
    });
    test('list ended → complete; budget used up → request_budget', () => {
        expect(videosFromCapture(cap({ responses: [listPage(['1', '2'], false)] }), { limit: 10 }).complete).toBe(true);
        const r = videosFromCapture(cap({ responses: [listPage(['1', '2'], true)], scrolls: 10 }), { limit: 10 });
        expect(r).toMatchObject({ complete: false, reason: 'request_budget' });
    });
    test('no signed list responses → embedded items with signed_list_api', () => {
        const r = videosFromCapture(cap({ scope: profileScope() }), {});
        expect(r).toMatchObject({ source: 'page', complete: false, reason: 'signed_list_api' });
    });
    test('private account with nothing visible → private', () => {
        expect(() => videosFromCapture(cap({ scope: fx('profile-private.synthetic.json').__DEFAULT_SCOPE__ }), {})).toThrow(expect.objectContaining({ kind: 'private' }));
    });
});

describe('single video and comments', () => {
    test('video from a list capture by id', () => {
        const c = cap({ url: 'https://www.tiktok.com/@jdnichollsc/video/7606492896908299528', responses: [{ path: '/api/post/item_list/', body: fx('item-list-video.redacted.json') }] });
        expect(videoFromCapture(c).data.id).toBe('7606492896908299528');
    });
    test('video-detail scope is used when present', () => {
        const item = fx('item-list-video.redacted.json').itemList[0];
        const c = cap({ url: 'https://www.tiktok.com/@jdnichollsc/video/7606492896908299528', scope: { 'webapp.video-detail': { statusCode: 0, itemInfo: { itemStruct: item } } } });
        expect(videoFromCapture(c)).toMatchObject({ source: 'page', data: { id: item.id } });
    });
    test('comments normalize to TtComment', () => {
        const r = commentsFromCapture(cap({ responses: [{ path: '/api/comment/list/', body: fx('comment-list.synthetic.json') }] }), {});
        expect(r.data).toEqual([
            { id: 'c1', text: 'great', likes: 2, replies: 0, createTime: 1771024700, author: 'fan1' },
            { id: 'c2', text: 'wow', likes: 0, replies: 1, createTime: 1771024800, author: 'fan2' },
        ]);
        expect(r.complete).toBe(true);
    });
    test('no comment responses → [] with signed_comment_api', () => {
        expect(commentsFromCapture(cap({}), {})).toEqual({ source: 'page', data: [], complete: false, reason: 'signed_comment_api' });
    });
});

describe('CLI read commands (no network)', () => {
    const { spawnSync } = require('node:child_process') as typeof import('node:child_process');
    const { mkdtempSync, writeFileSync } = require('node:fs') as typeof import('node:fs');
    const os = require('node:os') as typeof import('node:os');
    const MAIN = path.resolve(import.meta.dir, '../../skills/tiktok/scripts/main.ts');
    const TRAP = path.resolve(import.meta.dir, 'fetch-trap.ts');
    const run = (args: string[]) => spawnSync(process.execPath, ['--preload', TRAP, MAIN, ...args], { env: process.env, encoding: 'utf8' });
    test('videos --capture prints a ReadResult and makes no request', () => {
        const dir = mkdtempSync(path.join(os.tmpdir(), 'ttcap-'));
        const file = path.join(dir, 'c.json');
        writeFileSync(file, JSON.stringify(cap({ responses: [{ path: '/api/post/item_list/', body: fx('item-list-video.redacted.json') }] })));
        const r = run(['videos', '--capture', file, '--limit', '1']);
        expect(r.status).toBe(0);
        expect(JSON.parse(r.stdout)).toMatchObject({ source: 'api', complete: true, data: [{ id: '7606492896908299528' }] });
    });
    test('missing --capture is an error with exit 1', () => {
        const r = run(['profile']);
        expect(r.status).toBe(1);
        expect(r.stdout).toContain('--capture');
    });
});
