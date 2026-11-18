/**
 * Guarded download of a TikTok media file (video or caption) from TikTok's CDN.
 *
 * Read-only. It sends no cookies (TikTok session cookies never go to CDN hosts), follows at most
 * MAX_HOPS redirects and only to allowed hosts, and obeys the account-wide stop signal and request pacing
 * of this plugin's `tiktok` skill before every request and every hop. A 403, 429, captcha/verification page
 * or login redirect writes that signal and stops; nothing is retried.
 */
import { mkdir, open, rm } from 'node:fs/promises';
import path from 'node:path';

/** Hostname suffixes TikTok serves media from (narrowed by live recon, docs/reviews/evidence-phase3-reads.md). */
export const CDN_HOSTS: RegExp[] = [/\.tiktokcdn\.com$/, /\.tiktokcdn-us\.com$/, /\.tiktokv\.com$/, /\.byteoversea\.com$/, /\.ibyteimg\.com$/];
export const DEFAULT_MAX_BYTES = 200 * 1024 * 1024;
/** Headers, or a body read, that take longer than this abort the download. */
export const IDLE_MS = 60_000;
export const MAX_HOPS = 3;
const REFERER = 'https://www.tiktok.com/';
const MEDIA_TYPE = /^(video|audio|image)\/|^application\/octet-stream|^binary\/|^text\/vtt|^application\/(x-)?subrip/i;

export type CdnErrorKind =
    | 'host_refused' | 'too_many_redirects' | 'gone' | 'http' | 'too_large' | 'download_stalled' | 'unexpected_body' | 'empty' | 'signal_written';

export class CdnError extends Error {
    constructor(readonly kind: CdnErrorKind, message: string) {
        super(message);
        this.name = 'CdnError';
    }
}

/** The pieces of the `tiktok` operator this downloader obeys. */
export interface Operator {
    assertNoSignal(): Promise<void>;
    writeSignal(kind: string, detail: string): Promise<void>;
    waitTurn(): Promise<void>;
    patterns: { captcha: RegExp; waf: RegExp; verify: RegExp; tooMany: RegExp; loginPath: RegExp; verifyPath: RegExp };
}

/** Loads the operator from this plugin's `tiktok` skill (skills/tiktok next to this one). */
export async function loadOperator(): Promise<Operator> {
    try {
        const [s, t, c] = await Promise.all([
            import('../../tiktok/scripts/signal.ts'),
            import('../../tiktok/scripts/throttle.ts'),
            import('../../tiktok/scripts/client.ts'),
        ]);
        return {
            assertNoSignal: s.assertNoSignal,
            writeSignal: s.writeSignal,
            waitTurn: t.waitTurn,
            patterns: { captcha: c.CAPTCHA_HTML, waf: c.WAF_HTML, verify: c.VERIFY_JSON, tooMany: c.TOO_MANY, loginPath: c.LOGIN_PATH, verifyPath: c.VERIFY_PATH },
        };
    } catch (e) {
        const err = new Error(
            `Downloading from TikTok needs the "tiktok" skill of this plugin next to this one (skills/tiktok). It could not be loaded: ${(e as Error).message}. Analysing a local video file (fetch --file) works without it.`,
        );
        (err as Error & { kind: string }).kind = 'operator_missing';
        throw err;
    }
}

export function isAllowedCdn(url: string): boolean {
    let u: URL;
    try {
        u = new URL(url);
    } catch {
        return false;
    }
    return u.protocol === 'https:' && CDN_HOSTS.some((re) => re.test(u.hostname.toLowerCase()));
}

/** scheme://host/path — no query string (signed URLs carry tokens there). */
export function redactUrl(url: string): string {
    try {
        const u = new URL(url);
        return `${u.protocol}//${u.host}${u.pathname}`;
    } catch {
        return 'an invalid URL';
    }
}

async function stop(ops: Operator, kind: string, detail: string): Promise<never> {
    await ops.writeSignal(kind, detail);
    throw new CdnError('signal_written', `TikTok stopped the download (${kind}: ${detail}). Every TikTok read is paused until you resolve it in the browser and run \`resume\`.`);
}

/** A promise that rejects after `ms`, and a way to cancel it. */
function idle(ms: number, what: string): { p: Promise<never>; cancel(): void } {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const p = new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new CdnError('download_stalled', `The download stalled: ${what} for ${Math.round(ms / 1000)} s.`)), ms);
    });
    p.catch(() => {});
    return { p, cancel: () => clearTimeout(timer) };
}

export interface DownloadOptions {
    maxBytes?: number;
    /** Recon mode: read this many bytes, keep nothing. */
    probeBytes?: number;
    idleMs?: number;
    fetchImpl?: typeof fetch;
    ops?: Operator;
}

/** Every URL in a message loses its query and fragment (signed tokens live there); host and path stay. */
export function scrubUrls(message: string): string {
    return message.replace(/(https?:\/\/[^\s"'<>?#]+)[?#][^\s"'<>]*/gi, '$1');
}

const PAGE_PREFIX = /^\s*(<!doctype|<html|<head|<body|<\?xml|<script|\{\s*"(statusCode|status_code|code)")/i;
const SNIFF_BYTES = 65536;
/** How much of a media body is read before it is trusted: enough for a page header split across chunks. */
const MEDIA_SNIFF_BYTES = 2048;
const CAPTION_TYPE = /^text\/vtt|^application\/(x-)?subrip/i;

export async function downloadCdn(url: string, dest: string, opts: DownloadOptions = {}): Promise<{ bytes: number; contentType: string }> {
    try {
        return await downloadInner(url, dest, opts);
    } catch (e) {
        // CdnError and the operator's own errors (they carry a kind or code) keep their identity; only the text is scrubbed.
        if (e instanceof CdnError || (e instanceof Error && (typeof (e as { kind?: unknown }).kind === 'string' || typeof (e as { code?: unknown }).code === 'string'))) {
            (e as Error).message = scrubUrls((e as Error).message);
            throw e;
        }
        throw new CdnError('http', `The CDN download failed: ${scrubUrls(String((e as Error)?.message ?? e))}`);
    }
}

async function downloadInner(url: string, dest: string, opts: DownloadOptions): Promise<{ bytes: number; contentType: string }> {
    const ops = opts.ops ?? (await loadOperator());
    const fetchImpl = opts.fetchImpl ?? fetch;
    const maxBytes = opts.maxBytes ?? DEFAULT_MAX_BYTES;
    const idleMs = opts.idleMs ?? IDLE_MS;
    let current = url;
    let res: Response | undefined;
    let controller: AbortController | undefined;
    for (let hop = 0; ; hop++) {
        if (!isAllowedCdn(current)) throw new CdnError('host_refused', `Refusing to download from a host that is not a TikTok CDN: ${redactUrl(current)}`);
        await ops.assertNoSignal();
        await ops.waitTurn();
        // A signal raised while this request waited its turn stops it too.
        await ops.assertNoSignal();
        controller = new AbortController();
        const wait = idle(idleMs, 'no answer');
        try {
            res = await Promise.race([
                fetchImpl(current, { redirect: 'manual', credentials: 'omit', signal: controller.signal, headers: { accept: '*/*', referer: REFERER } }),
                wait.p,
            ]);
        } catch (e) {
            controller.abort();
            if (e instanceof CdnError) throw e;
            throw new CdnError('http', `The CDN request to ${redactUrl(current)} failed: ${scrubUrls(String((e as Error)?.message ?? e))}`);
        } finally {
            wait.cancel();
        }
        if (res.status === 429) return stop(ops, 'rate_limited', `CDN HTTP 429 at ${redactUrl(current)}`);
        if (res.status === 403) return stop(ops, 'blocked', `CDN HTTP 403 at ${redactUrl(current)}`);
        if (res.status >= 300 && res.status < 400) {
            const loc = res.headers.get('location');
            if (!loc) throw new CdnError('http', `The CDN answered HTTP ${res.status} with no location.`);
            const next = new URL(loc, current);
            if (/(^|\.)tiktok\.com$/i.test(next.hostname) && (ops.patterns.loginPath.test(next.pathname) || ops.patterns.verifyPath.test(next.pathname))) {
                return stop(ops, ops.patterns.loginPath.test(next.pathname) ? 'auth' : 'challenge', `CDN redirect to ${redactUrl(next.href)}`);
            }
            if (hop >= MAX_HOPS) throw new CdnError('too_many_redirects', `More than ${MAX_HOPS} redirects; stopping at ${redactUrl(next.href)}.`);
            current = next.href;
            continue;
        }
        break;
    }
    if (res.status === 404 || res.status === 410) throw new CdnError('gone', `The CDN answered HTTP ${res.status} for ${redactUrl(current)}; the link may have expired.`);
    if (!res.ok || !res.body) throw new CdnError('http', `The CDN answered HTTP ${res.status} for ${redactUrl(current)}.`);
    const contentType = (res.headers.get('content-type') ?? '').split(';')[0].trim();
    const reader = (res.body as ReadableStream<Uint8Array>).getReader();
    const held: Uint8Array[] = [];
    /** Next chunk: the ones held back by the sniff first, then the stream, each under the idle timeout. */
    const next = async (what: string): Promise<{ done: boolean; value?: Uint8Array }> => {
        if (held.length) return { done: false, value: held.shift() };
        const wait = idle(idleMs, what);
        try {
            return await Promise.race([reader.read(), wait.p]);
        } finally {
            wait.cancel();
        }
    };
    const release = () => {
        void reader.cancel().catch(() => {});
        controller?.abort();
    };
    const isPage = (text: string) => {
        const p = ops.patterns;
        return p.captcha.test(text) || p.waf.test(text) || p.verify.test(text) || p.tooMany.test(text) || PAGE_PREFIX.test(text);
    };
    const media = MEDIA_TYPE.test(contentType);
    // Sniff the start of the body whatever its declared type: a challenge page can be labelled as media, and its
    // header can be split across chunks. Reads come straight from the stream (the held chunks are replayed later),
    // each under the idle timeout; non-media bodies are read up to SNIFF_BYTES only.
    let sniffed = 0;
    const sniffLimit = media ? MEDIA_SNIFF_BYTES : SNIFF_BYTES;
    try {
        while (sniffed < sniffLimit) {
            const wait = idle(idleMs, `no data after ${sniffed} bytes`);
            let step: { done: boolean; value?: Uint8Array };
            try {
                step = await Promise.race([reader.read(), wait.p]);
            } finally {
                wait.cancel();
            }
            if (step.done || !step.value) break;
            held.push(step.value);
            sniffed += step.value.length;
        }
    } catch (e) {
        release();
        throw e;
    }
    const head = new TextDecoder('utf-8', { fatal: false }).decode(concat(held).subarray(0, sniffLimit));
    // Captions are plain text that may mention anything: only a markup start or a missing WEBVTT header marks a page.
    const page = CAPTION_TYPE.test(contentType)
        ? PAGE_PREFIX.test(head) || /^\s*</.test(head) || (/^text\/vtt/i.test(contentType) && !/^\uFEFF?WEBVTT/.test(head))
        : isPage(head) || (!media && /<!doctype|<html[\s>]/i.test(head));
    if (page) {
        release();
        return stop(ops, 'challenge', `CDN answered a page instead of media at ${redactUrl(current)}`);
    }
    if (!media) {
        release();
        throw new CdnError('unexpected_body', `The CDN answered ${contentType || 'an unknown type'} instead of media at ${redactUrl(current)}.`);
    }
    const declared = Number(res.headers.get('content-length') ?? 0);
    if (!opts.probeBytes && declared > maxBytes) {
        release();
        throw new CdnError('too_large', `The file is ${declared} bytes, over the limit of ${maxBytes}.`);
    }
    let bytes = 0;
    if (opts.probeBytes) {
        try {
            while (bytes < opts.probeBytes) {
                const step = await next(`no data after ${bytes} bytes`);
                if (step.done || !step.value) break;
                bytes += step.value.length;
            }
        } finally {
            void reader.cancel().catch(() => {});
            controller?.abort();
        }
        return { bytes, contentType };
    }
    await mkdir(path.dirname(dest), { recursive: true });
    const handle = await open(dest, 'w');
    try {
        for (;;) {
            if (declared > 0 && bytes >= declared) break;
            const step = await next(`no data after ${bytes} bytes`);
            if (step.done || !step.value) break;
            bytes += step.value.length;
            if (bytes > maxBytes) throw new CdnError('too_large', `The download passed the limit of ${maxBytes} bytes.`);
            await handle.write(step.value);
        }
        if (declared > 0 && bytes < declared) throw new CdnError('http', `The download ended early: ${bytes} of ${declared} bytes.`);
        if (bytes === 0) throw new CdnError('empty', 'The CDN returned an empty file.');
        await handle.close();
        void reader.cancel().catch(() => {});
    } catch (e) {
        void reader.cancel().catch(() => {});
        controller?.abort();
        await handle.close().catch(() => {});
        await rm(dest, { force: true });
        throw e;
    }
    return { bytes, contentType };
}

function concat(parts: Uint8Array[]): Uint8Array {
    const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
    let o = 0;
    for (const p of parts) {
        out.set(p, o);
        o += p.length;
    }
    return out;
}
