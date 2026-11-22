import { applySetCookie, formatCookieHeader, loadCookies, missingCookies, writeCookieMapToDisk } from './cookie-store.ts';
import { assertNoSignal, writeSignal } from './signal.ts';
import { waitTurn } from './throttle.ts';

export type TtErrorKind =
    | 'auth' | 'challenge' | 'rate_limited' | 'not_found' | 'private' | 'unexpected_page' | 'network' | 'blocked_by_signal'
    | 'invalid_draft' | 'approval_mismatch' | 'publish_busy' | 'page_mismatch' | 'mixed_lists';

export class TtError extends Error {
    constructor(
        readonly kind: TtErrorKind,
        message: string,
        readonly status?: number,
    ) {
        super(message);
        this.name = 'TtError';
    }
}

/** Only these hosts are ever requested. */
export const ALLOWED_HOST = /^https:\/\/(www|m)\.tiktok\.com\//;
const MAX_HOPS = 3;
const USER_AGENT =
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36';

// Challenge and error patterns. CANDIDATES backed by synthetic fixtures until seen live.
export const CAPTCHA_HTML = /captcha-verify-container|secsdk-captcha|captcha_container|verify-bar-close/i;
/** WAF JavaScript interstitial ("Please wait..."), seen live on plain-HTTP page loads 2026-11-15. */
export const WAF_HTML = /_wafchallengeid|SlardarWAF|waf-aiso/;
export const VERIFY_JSON = /"type"\s*:\s*"verify"|"verify_event"|"verifyConfig"/;
export const TOO_MANY = /too many attempts|maximum number of attempts|too many requests/i;

/** "Too many attempts": a JSON body by its own error message (non-zero status), any other body by its text. */
export function isTooMany(body: string): boolean {
    let j: unknown;
    try {
        j = JSON.parse(body);
    } catch {
        return TOO_MANY.test(body);
    }
    if (!j || typeof j !== 'object') return false;
    const o = j as Record<string, unknown>;
    const code = o.statusCode ?? o.status_code;
    if (code === 0 || code === '0') return false;
    return [o.statusMsg, o.status_msg, o.message, o.msg].some((m) => typeof m === 'string' && TOO_MANY.test(m));
}
export const LOGIN_PATH = /^\/login(\/|\?|$)/;
export const VERIFY_PATH = /\/(verify|captcha)(\/|\?|$)/i;
export const NOT_FOUND_STATUS = /"status_?[cC]ode"\s*:\s*(10202|10221)\b/;
export const PRIVATE_STATUS = /"status_?[cC]ode"\s*:\s*10222\b/;

function pathOf(u: string, base: string): string {
    try {
        return new URL(u, base).pathname + new URL(u, base).search;
    } catch {
        return u;
    }
}

/** Classifies a response (or a redirect, via `location`) into a stop condition, or null when it is usable. */
export function classifyResponse(status: number, url: string, body: string, location?: string): TtErrorKind | null {
    if (status === 429) return 'rate_limited';
    if (location !== undefined) {
        const p = pathOf(location, url);
        if (LOGIN_PATH.test(p)) return 'auth';
        if (VERIFY_PATH.test(p)) return 'challenge';
        return null;
    }
    if (LOGIN_PATH.test(pathOf(url, url))) return 'auth';
    if (WAF_HTML.test(body) || CAPTCHA_HTML.test(body) || VERIFY_JSON.test(body) || isTooMany(body)) return 'challenge';
    if (NOT_FOUND_STATUS.test(body)) return 'not_found';
    if (PRIVATE_STATUS.test(body)) return 'private';
    if (status === 404) return 'not_found';
    return null;
}

const STOPS: TtErrorKind[] = ['challenge', 'rate_limited', 'auth'];

export interface TtClientOptions {
    fetchImpl?: typeof fetch;
    /** Explicit cookies. Required in probe mode (an empty map is valid). */
    cookies?: Record<string, string>;
    /**
     * Probe mode (settling which cookies are required): cookies are a cloned override with no fallback
     * to TIKTOK_COOKIES or the store, no local required-cookie check, Set-Cookie is saved nowhere,
     * and an `auth` answer does not write the account signal (challenge / rate_limited still do).
     */
    probe?: boolean;
    log?: (m: string) => void;
}

export class TtClient {
    private readonly fetchImpl: typeof fetch;
    private readonly probe: boolean;
    private cookies: Record<string, string> | null;
    /** True only when cookies came from the store file, so rotations may be saved back. */
    private fromStore = false;

    constructor(private readonly opts: TtClientOptions = {}) {
        this.fetchImpl = opts.fetchImpl ?? fetch;
        this.probe = opts.probe === true;
        if (this.probe && !opts.cookies) throw new Error('probe mode needs an explicit cookies override');
        this.cookies = opts.cookies ? { ...opts.cookies } : null;
    }

    private async jar(): Promise<Record<string, string>> {
        if (this.cookies) return this.cookies;
        const map = await loadCookies(this.opts.log);
        this.fromStore = !process.env.TIKTOK_COOKIES?.trim();
        this.cookies = map;
        return map;
    }

    private async stop(kind: TtErrorKind, url: string, status?: number): Promise<never> {
        if (STOPS.includes(kind) && !(this.probe && kind === 'auth')) await writeSignal(kind, `${status ?? ''} ${new URL(url).pathname}`.trim());
        const msg: Record<string, string> = {
            auth: 'TikTok asked to sign in again. Run `login`.',
            challenge: 'TikTok showed a captcha or verification. Solve it in the browser, then run `resume`.',
            rate_limited: 'TikTok is rate limiting this account (HTTP 429). Wait, then run `resume`.',
            not_found: 'Not found on TikTok.',
            private: 'This account or video is private.',
        };
        throw new TtError(kind, msg[kind] ?? kind, status);
    }

    async getText(url: string): Promise<{ status: number; url: string; text: string }> {
        if (!ALLOWED_HOST.test(url)) throw new TtError('unexpected_page', `Refusing to request a non-TikTok host: ${url}`);
        const jar = await this.jar();
        if (!this.probe && missingCookies(jar).length) throw new TtError('auth', 'No TikTok session. Run `login`.');
        let current = url;
        for (let hop = 0; ; hop++) {
            await waitTurn();
            await assertNoSignal();
            const headers: Record<string, string> = { 'user-agent': USER_AGENT, accept: 'text/html,application/json;q=0.9,*/*;q=0.8', 'accept-language': 'en-US,en;q=0.9' };
            const cookie = formatCookieHeader(jar);
            if (cookie) headers.cookie = cookie;
            let res: Response;
            try {
                res = await this.fetchImpl(current, { headers, redirect: 'manual' });
            } catch (error) {
                throw new TtError('network', `Network error: ${(error as Error).message}`);
            }
            await this.absorbCookies(res);
            const location = res.headers.get('location');
            if (res.status >= 300 && res.status < 400 && location !== null) {
                const kind = classifyResponse(res.status, current, '', location);
                if (kind) return this.stop(kind, current, res.status);
                const next = new URL(location, current).toString();
                if (!ALLOWED_HOST.test(next)) throw new TtError('unexpected_page', `TikTok redirected to a non-TikTok host: ${new URL(next).host}`);
                if (hop + 1 >= MAX_HOPS + 1) throw new TtError('unexpected_page', `Too many redirects (more than ${MAX_HOPS}).`);
                current = next;
                continue;
            }
            const text = await res.text();
            const kind = classifyResponse(res.status, current, text);
            if (kind) return this.stop(kind, current, res.status);
            if (res.status >= 400) throw new TtError('unexpected_page', `HTTP ${res.status} from ${new URL(current).pathname}`, res.status);
            return { status: res.status, url: current, text };
        }
    }

    async getJson<T>(url: string): Promise<T> {
        const r = await this.getText(url);
        try {
            return JSON.parse(r.text) as T;
        } catch {
            throw new TtError('unexpected_page', `Expected JSON from ${new URL(r.url).pathname}`);
        }
    }

    private async absorbCookies(res: Response): Promise<void> {
        if (this.probe) return;
        const list = (res.headers as Headers & { getSetCookie?: () => string[] }).getSetCookie?.() ?? [];
        if (!list.length || !this.cookies) return;
        if (applySetCookie(this.cookies, list) && this.fromStore) await writeCookieMapToDisk(this.cookies);
    }
}
