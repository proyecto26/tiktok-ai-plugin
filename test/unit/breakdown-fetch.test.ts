import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { fetchFromCapture, fetchFromFile } from '../../skills/tiktok-video-breakdown/scripts/fetch.ts';
import { clearSignal, readSignal } from '../../skills/tiktok/scripts/signal.ts';

const tmp = () => mkdtempSync(path.join(os.tmpdir(), 'tt-fetch-'));
const PLAY = 'https://v16-webapp.tiktokcdn.com/a/play.mp4?sig=SECRET';
const DL = 'https://v19.tiktokcdn.com/b/dl.mp4?sig=SECRET';
const VTT = 'https://v16-webapp.tiktokcdn.com/s/eng.vtt?sig=SECRET';

const item = (over: Record<string, unknown> = {}) => ({
    id: '7000000000000000001',
    desc: 'SYNTH: a caption #synthtag',
    createTime: 1700000000,
    stats: { playCount: 100, diggCount: 10, commentCount: 2, shareCount: 1, collectCount: 3 },
    video: { duration: 9, width: 720, height: 1280, playAddr: PLAY, downloadAddr: DL, subtitleInfos: [{ LanguageCodeName: 'eng-US', Url: VTT, Format: 'webvtt', Source: 'ASR' }] },
    music: { title: 'SYNTH sound', id: '555', authorName: 'synthetic_artist', original: true },
    challenges: [{ title: 'synthtag' }],
    textExtra: [{ hashtagName: 'synthtag' }],
    author: { uniqueId: 'synthetic_a' },
    ...over,
});
function capFile(dir: string, items: unknown[], extra: Record<string, unknown> = {}): string {
    const f = path.join(dir, 'cap.json');
    writeFileSync(f, JSON.stringify({ schema: 'tt.capture.v1', url: 'https://www.tiktok.com/@synthetic_a', capturedAt: '2026-11-17T00:00:00Z', scope: {}, responses: [{ path: '/api/post/item_list/', route: '@synthetic_a', reqCursor: '0', body: { statusCode: 0, hasMore: false, cursor: '1', itemList: items } }], scrolls: 0, dropped: 0, ...extra }));
    return f;
}
const media = (n = 16, type = 'video/mp4') => new Response(new Uint8Array(n).fill(1), { status: 200, headers: { 'content-type': type, 'content-length': String(n) } });
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

describe('fetchFromCapture', () => {
    test('downloads the first play URL, saves captions and writes meta.json', async () => {
        const d = tmp();
        const f = fake({ [PLAY.split('?')[0]]: () => media(16), [VTT.split('?')[0]]: () => new Response('WEBVTT\n\n00:00.000 --> 00:01.000\nSYNTH\n', { status: 200, headers: { 'content-type': 'text/vtt' } }) });
        const meta = await fetchFromCapture(capFile(d, [item()]), '7000000000000000001', path.join(d, 'out'), { fetchImpl: f.impl });
        expect(meta).toMatchObject({ schema: 'tt.breakdown.source.v1', origin: 'tiktok', owner: 'synthetic_a', post_id: '7000000000000000001', music_id: '555', hashtags: ['synthtag'] });
        expect(meta.metrics).toEqual({ likes: 10, comments: 2, plays: 100, shares: 1, saves: 3 });
        expect(meta.audio_attribution).toMatchObject({ kind: 'original_audio', title: 'SYNTH sound', artist: 'synthetic_artist' });
        expect(meta.video).toMatchObject({ file: 'source/video.mp4', bytes: 16, width: 720, height: 1280, cdn_host: 'v16-webapp.tiktokcdn.com' });
        expect(meta.captions).toEqual([{ lang: 'eng-US', file: 'source/captions.eng-US.vtt', source: 'ASR' }]);
        expect(readFileSync(path.join(d, 'out/source/captions.eng-US.vtt'), 'utf8')).toContain('WEBVTT');
        const saved = readFileSync(path.join(d, 'out/source/meta.json'), 'utf8');
        expect(saved).not.toContain('SECRET');
        expect(saved).not.toContain('sig=');
    });
    test('a photo post is refused with photo_post (Review Focus 1)', async () => {
        const d = tmp();
        const e = await fetchFromCapture(capFile(d, [item({ imagePost: { images: [{}, {}] } })]), '7000000000000000001', path.join(d, 'out'), { fetchImpl: fake({}).impl }).catch((x: any) => x);
        expect(e.kind).toBe('photo_post');
    });
    test('a capture that met a challenge writes the signal and fetches nothing', async () => {
        const d = tmp();
        const f = fake({});
        const e = await fetchFromCapture(capFile(d, [item()], { challenge: true }), '7000000000000000001', path.join(d, 'out'), { fetchImpl: f.impl }).catch((x: any) => x);
        expect(e.kind).toBe('challenge');
        expect((await readSignal())?.kind).toBe('challenge');
        expect(f.calls).toHaveLength(0);
    });
    test('first URL 404, second 200 → second used', async () => {
        const d = tmp();
        const f = fake({ [PLAY.split('?')[0]]: () => new Response('', { status: 404 }), [DL.split('?')[0]]: () => media(8), [VTT.split('?')[0]]: () => new Response('', { status: 404 }) });
        const meta = await fetchFromCapture(capFile(d, [item()]), '7000000000000000001', path.join(d, 'out'), { fetchImpl: f.impl });
        expect(meta.video.cdn_host).toBe('v19.tiktokcdn.com');
        expect(meta.captions).toEqual([]);
    });
    test('first URL 403 → signal written, second URL never tried', async () => {
        const d = tmp();
        const f = fake({ [PLAY.split('?')[0]]: () => new Response('', { status: 403 }), [DL.split('?')[0]]: () => media(8) });
        const e = await fetchFromCapture(capFile(d, [item()]), '7000000000000000001', path.join(d, 'out'), { fetchImpl: f.impl }).catch((x: any) => x);
        expect(e.kind).toBe('signal_written');
        expect((await readSignal())?.kind).toBe('blocked');
        expect(f.calls.some((u) => u.startsWith(DL.split('?')[0]))).toBe(false);
        expect(existsSync(path.join(d, 'out/source/meta.json'))).toBe(false);
    });
    test('every URL gone → no_fetchable_url with a fetch --file hint, no URL in the message', async () => {
        const d = tmp();
        const f = fake({ [PLAY.split('?')[0]]: () => new Response('', { status: 410 }), [DL.split('?')[0]]: () => new Response('', { status: 404 }) });
        const e = await fetchFromCapture(capFile(d, [item()]), '7000000000000000001', path.join(d, 'out'), { fetchImpl: f.impl }).catch((x: any) => x);
        expect(e.kind).toBe('no_fetchable_url');
        expect(e.message).toMatch(/fetch --file/);
        expect(e.message).not.toContain('SECRET');
    });
    test('an id not in the capture → not_found', async () => {
        const d = tmp();
        const e = await fetchFromCapture(capFile(d, [item()]), '1', path.join(d, 'out'), { fetchImpl: fake({}).impl }).catch((x: any) => x);
        expect(e.kind).toBe('not_found');
    });
});

describe('fetchFromFile', () => {
    test('copies a local file and writes a local meta', async () => {
        const d = tmp();
        writeFileSync(path.join(d, 'v.mp4'), 'x');
        const meta = await fetchFromFile(path.join(d, 'v.mp4'), path.join(d, 'out'));
        expect(meta).toMatchObject({ origin: 'local_file', ref: 'v.mp4', captions: [], video: { file: 'source/video.mp4', bytes: 1 } });
    });
    test('a new source clears the transcript and recogniser output of the previous one', async () => {
        const d = tmp();
        const out = path.join(d, 'out');
        writeFileSync(path.join(d, 'v.mp4'), 'x');
        await fetchFromFile(path.join(d, 'v.mp4'), out);
        writeFileSync(path.join(out, 'transcript.json'), '{"source":"tiktok_captions:eng"}');
        writeFileSync(path.join(out, 'asr_out.json'), '{}');
        writeFileSync(path.join(d, 'w.mp4'), 'yy');
        await fetchFromFile(path.join(d, 'w.mp4'), out);
        expect(existsSync(path.join(out, 'transcript.json'))).toBe(false);
        expect(existsSync(path.join(out, 'asr_out.json'))).toBe(false);
    });
    test('works with the tiktok operator folder absent', () => {
        const root = tmp();
        cpSync(path.resolve(import.meta.dir, '../../skills/tiktok-video-breakdown'), path.join(root, 'skills/tiktok-video-breakdown'), { recursive: true });
        writeFileSync(path.join(root, 'v.mp4'), 'abc');
        const mod = path.join(root, 'skills/tiktok-video-breakdown/scripts/fetch.ts').replace(/\\/g, '/');
        const code = `const { fetchFromFile } = await import(${JSON.stringify(mod)}); const m = await fetchFromFile(${JSON.stringify(path.join(root, 'v.mp4'))}, ${JSON.stringify(path.join(root, 'out'))}); console.log(m.video.bytes);`;
        const r = spawnSync(process.execPath, ['-e', code], { encoding: 'utf8' });
        expect(r.stderr).toBe('');
        expect(r.stdout.trim()).toBe('3');
    });
});
