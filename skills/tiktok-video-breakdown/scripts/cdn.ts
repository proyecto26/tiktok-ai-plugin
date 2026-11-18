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

export async function downloadCdn(url: string, dest: string, opts: DownloadOptions = {}): Promise<{ bytes: number; contentType: string }> {
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
            throw new CdnError('http', `The CDN request to ${redactUrl(current)} failed: ${(e as Error).message}`);
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
    if (!MEDIA_TYPE.test(contentType)) {
        const text = (await res.text().catch(() => '')).slice(0, 65536);
        const p = ops.patterns;
        if (p.captcha.test(text) || p.waf.test(text) || p.verify.test(text) || p.tooMany.test(text) || /^\s*</.test(text)) {
            return stop(ops, 'challenge', `CDN answered a page instead of media at ${redactUrl(current)}`);
        }
        throw new CdnError('unexpected_body', `The CDN answered ${contentType || 'an unknown type'} instead of media at ${redactUrl(current)}.`);
    }
    const declared = Number(res.headers.get('content-length') ?? 0);
    if (!opts.probeBytes && declared > maxBytes) throw new CdnError('too_large', `The file is ${declared} bytes, over the limit of ${maxBytes}.`);
    const reader = (res.body as ReadableStream<Uint8Array>).getReader();
    let bytes = 0;
    if (opts.probeBytes) {
        try {
            while (bytes < opts.probeBytes) {
                const wait = idle(idleMs, `no data after ${bytes} bytes`);
                let step: { done: boolean; value?: Uint8Array };
                try {
                    step = await Promise.race([reader.read(), wait.p]);
                } finally {
                    wait.cancel();
                }
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
            const wait = idle(idleMs, `no data after ${bytes} bytes`);
            let step: { done: boolean; value?: Uint8Array };
            try {
                step = await Promise.race([reader.read(), wait.p]);
            } finally {
                wait.cancel();
            }
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
