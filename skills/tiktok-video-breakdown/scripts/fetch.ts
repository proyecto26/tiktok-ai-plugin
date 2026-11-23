/**
 * A TikTok post (from a browser capture) or a local file -> source/video.mp4, source/captions.*.vtt, source/meta.json.
 *
 * Read-only. The capture is made in the owner's own Chrome by the `tiktok` skill; the media bytes come from
 * TikTok's CDN through the guarded downloader (no cookies, allowlisted hosts, account signal and pacing).
 * Signed media URLs are never written to meta.json or printed.
 */
import { copyFile, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { CdnError, downloadCdn, type Operator } from './cdn.ts';
import type { Meta } from './source.ts';

/** What an earlier fetch into this folder derived from its video: none of it belongs to the new source. */
async function clearDerived(outDir: string): Promise<void> {
    const { readdir } = await import('node:fs/promises');
    for (const f of await readdir(outDir).catch(() => [] as string[])) {
        if (f === 'transcript.json' || /^asr_out(\.(json|srt|vtt))?$/.test(f)) await rm(path.join(outDir, f), { force: true });
    }
    const src = path.join(outDir, 'source');
    for (const f of await readdir(src).catch(() => [] as string[])) if (/^captions\..+\.vtt$/.test(f)) await rm(path.join(src, f), { force: true });
}

export type { Meta } from './source.ts';

export class FetchError extends Error {
    constructor(readonly kind: 'photo_post' | 'not_found' | 'no_fetchable_url' | 'no_play_url' | 'challenge' | 'rate_limited' | 'operator_missing' | 'bad_capture', message: string) {
        super(message);
        this.name = 'FetchError';
    }
}

/** The `tiktok` skill's capture reader, loaded only for this path so `fetch --file` works without it. */
async function loadReader(): Promise<typeof import('../../tiktok/scripts/read.ts') & { signal: typeof import('../../tiktok/scripts/signal.ts') }> {
    try {
        const [read, signal] = await Promise.all([import('../../tiktok/scripts/read.ts'), import('../../tiktok/scripts/signal.ts')]);
        return { ...read, signal };
    } catch (e) {
        throw new FetchError('operator_missing', `Fetching from a TikTok capture needs the "tiktok" skill of this plugin next to this one (skills/tiktok). It could not be loaded: ${(e as Error).message}. Analysing a local video file (fetch --file) works without it.`);
    }
}

const host = (u: string) => {
    try {
        return new URL(u).hostname;
    } catch {
        return null;
    }
};
const safeLang = (l: string) => (l.replace(/[^A-Za-z0-9-]/g, '').slice(0, 20) || 'und');
const CAPTION_MAX_BYTES = 2 * 1024 * 1024;

export interface FetchOptions {
    maxBytes?: number;
    fetchImpl?: typeof fetch;
    ops?: Operator;
    log?: (m: string) => void;
}

export async function fetchFromCapture(capture: string, id: string, outDir: string, opts: FetchOptions = {}): Promise<Meta> {
    const r = await loadReader();
    await r.signal.assertNoSignal();
    let cap;
    try {
        cap = r.parseCapture(await readFile(capture, 'utf8'));
    } catch (e) {
        const kind = (e as { kind?: string }).kind;
        if (kind === 'challenge' || kind === 'rate_limited') {
            await r.signal.writeSignal(kind, 'capture read by tiktok-video-breakdown fetch');
            throw new FetchError(kind, (e as Error).message);
        }
        throw new FetchError('bad_capture', (e as Error).message);
    }
    const raw = r.itemFromCapture(cap, id);
    if (!raw) throw new FetchError('not_found', `Post ${id} is not in the capture. Capture a page that lists it, then try again.`);
    const post = r.normalizeVideo(raw);
    if (post.isPhoto) throw new FetchError('photo_post', `Post ${id} is a photo post (${post.imageCount ?? '?'} images); only videos are analysed.`);
    const media = r.mediaFromCapture(cap, id).data;

    // Nothing to download: the capture holds no video link for this post. The post is not refused (a post flagged
    // sensitive or age-restricted is fetched like any other); the page showed no link, so say how to get one.
    if (!media.playUrls.length) {
        throw new FetchError('no_play_url', `The capture has no video link for post ${id} (the page did not load its video data). Open the post itself in the signed-in browser, let it start playing, capture again, or save the video yourself and run fetch --file <video.mp4>.`);
    }
    const src = path.join(outDir, 'source');
    await mkdir(src, { recursive: true });
    await clearDerived(outDir);
    const dest = path.join(src, 'video.mp4');
    let used: string | null = null;
    let bytes = 0;
    for (const url of media.playUrls) {
        try {
            ({ bytes } = await downloadCdn(url, dest, { maxBytes: opts.maxBytes, fetchImpl: opts.fetchImpl, ops: opts.ops }));
            used = url;
            break;
        } catch (e) {
            // Only an expired link moves on to the next URL. A signal, a refused host or anything else stops.
            if (e instanceof CdnError && e.kind === 'gone') {
                opts.log?.(`[breakdown] ${e.message} Trying the next URL.`);
                continue;
            }
            throw e;
        }
    }
    if (!used) {
        throw new FetchError('no_fetchable_url', `None of the ${media.playUrls.length} video links in the capture could be downloaded (they expire after a while). Capture the page again, or save the video yourself and run fetch --file <video.mp4>.`);
    }

    const captions: Meta['captions'] = [];
    for (const c of media.captions) {
        const lang = safeLang(c.lang);
        const file = `captions.${lang}.vtt`;
        if (captions.some((x) => x.lang === lang)) continue;
        try {
            await downloadCdn(c.url, path.join(src, file), { maxBytes: CAPTION_MAX_BYTES, fetchImpl: opts.fetchImpl, ops: opts.ops });
            captions.push({ lang, file: `source/${file}`, source: c.source });
        } catch (e) {
            if (e instanceof CdnError && (e.kind === 'gone' || e.kind === 'unexpected_body' || e.kind === 'empty')) {
                opts.log?.(`[breakdown] caption ${lang} not saved: ${e.message}`);
                continue;
            }
            throw e;
        }
    }

    const meta: Meta = {
        schema: 'tt.breakdown.source.v1',
        origin: 'tiktok',
        fetched_at: new Date().toISOString(),
        ref: path.basename(capture),
        url: post.url || null,
        owner: (raw.author as { uniqueId?: string } | undefined)?.uniqueId ?? null,
        post_id: id,
        caption: post.caption,
        hashtags: post.hashtags,
        metrics: { likes: post.likes, comments: post.comments, plays: post.plays, shares: post.shares, saves: post.saves ?? null },
        duration_sec: post.durationSec || null,
        has_audio: null,
        taken_at: post.createTime ? new Date(post.createTime * 1000).toISOString() : null,
        audio_attribution: media.music ? { kind: media.music.original ? 'original_audio' : 'licensed_music', title: media.music.title || null, artist: media.music.author || null, source: 'tiktok_capture' } : null,
        music_id: media.music?.id ?? null,
        captions,
        video: { file: 'source/video.mp4', bytes, width: media.width || null, height: media.height || null, cdn_host: host(used) },
        cover: null,
    };
    await writeFile(path.join(src, 'meta.json'), `${JSON.stringify(meta, null, 2)}\n`);
    return meta;
}

export async function fetchFromFile(file: string, outDir: string): Promise<Meta> {
    const info = await stat(file).catch(() => null);
    if (!info?.isFile()) throw new Error(`${file} is not a file.`);
    const src = path.join(outDir, 'source');
    await mkdir(src, { recursive: true });
    const dest = path.join(src, 'video.mp4');
    if (path.resolve(file) !== path.resolve(dest)) await copyFile(file, dest);
    // A local file replaces whatever an earlier fetch left: its captions and transcript belong to another video.
    await clearDerived(outDir);
    const meta: Meta = {
        schema: 'tt.breakdown.source.v1', origin: 'local_file', fetched_at: new Date().toISOString(), ref: path.basename(file), url: null, owner: null, post_id: null,
        caption: '', hashtags: [], metrics: { likes: null, comments: null, plays: null, shares: null, saves: null }, duration_sec: null, has_audio: null,
        taken_at: null, audio_attribution: null, music_id: null, captions: [],
        video: { file: 'source/video.mp4', bytes: info.size, width: null, height: null, cdn_host: null }, cover: null,
    };
    await writeFile(path.join(src, 'meta.json'), `${JSON.stringify(meta, null, 2)}\n`);
    return meta;
}
