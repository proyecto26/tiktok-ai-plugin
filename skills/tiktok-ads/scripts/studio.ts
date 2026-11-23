/**
 * Reads a `tt.studio-capture.v1` file (made with skills/tiktok/scripts/browser/studio-capture.js in the owner's
 * own Chrome) and gives the other modules typed access to it. Offline: nothing here makes a request.
 */

export class AdsError extends Error {
    constructor(
        public kind: string,
        message: string,
    ) {
        super(message);
    }
}

export interface Unavailable {
    unavailable: true;
    reason: string;
}
export const unavailable = (reason: string): Unavailable => ({ unavailable: true, reason });

export interface StudioResponse {
    path: string;
    route?: string;
    typeRequests?: unknown;
    body: Record<string, any>;
}
export interface StudioCapture {
    schema: 'tt.studio-capture.v1';
    url: string;
    capturedAt: string;
    responses: StudioResponse[];
    dropped?: number;
    rateLimited?: boolean;
    challenge?: boolean;
}

export const INSIGHT = /^\/aweme\/v2\/data\/insight\/?$/;
export const INSIGHTS = /^\/tiktok\/v1\/analytics\/insights\/?$/;
export const ALL_PROGRAMS = /\/m10n_center\/all_programs\/?$/;
export const SETTINGS = /\/m10n_center\/settings\/?$/;
export const REWARD_ANALYTICS = /\/m10n_center\/reward_analytics\/?$/;

export function parseStudio(text: string): StudioCapture {
    let c: any;
    try {
        c = JSON.parse(text);
    } catch (e) {
        throw new AdsError('bad_input', `The studio capture is not JSON: ${(e as Error).message}`);
    }
    if (c?.schema !== 'tt.studio-capture.v1') throw new AdsError('bad_input', 'Not a tt.studio-capture.v1 file (capture it with skills/tiktok/scripts/browser/studio-capture.js).');
    let origin = '';
    try {
        origin = new URL(c.url).origin;
    } catch {
        // fall through
    }
    if (origin !== 'https://www.tiktok.com') throw new AdsError('bad_input', `The capture is not from https://www.tiktok.com (${c.url}).`);
    if (c.rateLimited === true) throw new AdsError('rate_limited', 'TikTok said too many requests (HTTP 429 or "too many attempts") while capturing. Stop, wait, and tell the owner; do not capture again today.');
    if (c.challenge === true) throw new AdsError('challenge', 'TikTok showed a captcha or verification, or refused a request (HTTP 401/403), while capturing. Stop and tell the owner to check the browser.');
    const responses = (Array.isArray(c.responses) ? c.responses : []).filter((r: any) => r && typeof r.path === 'string').map((r: any) => ({ ...r, body: r.body && typeof r.body === 'object' ? r.body : {} }));
    return { ...c, responses };
}

export function mergeStudio(caps: StudioCapture[]): StudioCapture {
    if (caps.length === 0) throw new AdsError('bad_input', 'no studio capture given');
    const last = caps[caps.length - 1];
    return { ...last, capturedAt: caps.map((c) => c.capturedAt).sort().pop() ?? last.capturedAt, responses: caps.flatMap((c) => c.responses) };
}

/** First value stored under `key` in `v` (top level, or one to three levels down, e.g. under `data`). */
export function deepFind(v: unknown, key: string, depth = 0): any {
    if (!v || typeof v !== 'object' || depth > 3) return undefined;
    const o = v as Record<string, unknown>;
    if (key in o) return o[key];
    for (const x of Object.values(o)) {
        if (Array.isArray(x)) continue;
        const r = deepFind(x, key, depth + 1);
        if (r !== undefined) return r;
    }
    return undefined;
}

export const num = (v: unknown): number | undefined => (typeof v === 'number' && Number.isFinite(v) ? v : undefined);
export const sum = (xs: number[]): number => xs.reduce((a, b) => a + b, 0);

/** The request entry (from `type_requests`) whose type key is `key`, in either spelling of the key. */
export function requestFor(resp: StudioResponse, key: string): Record<string, any> | undefined {
    const list = Array.isArray(resp.typeRequests) ? (resp.typeRequests as any[]) : [];
    return list.find((r) => r && (r.insigh_type === key || r.insight_type === key));
}

/** The latest answer of the insight endpoint that carries `key`, with the request that asked for it. */
export function insight(cap: StudioCapture, key: string): { value: any; request?: Record<string, any>; response: StudioResponse } | undefined {
    let found: { value: any; request?: Record<string, any>; response: StudioResponse } | undefined;
    for (const r of cap.responses) {
        if (!INSIGHT.test(r.path)) continue;
        if (r.body[key] !== undefined) found = { value: r.body[key], request: requestFor(r, key), response: r };
    }
    return found;
}

export interface Series {
    key: string;
    days?: number;
    end_days?: number;
    /** Daily values of the current period, oldest first. */
    current: number[];
    /** The period before it, when the series is exactly two periods (2 x days + 2 points). */
    previous?: number[];
    statuses: number[];
}

/**
 * A `*_history` answer is a list of `{status, value}`, one per day. For a request of `days` days the page
 * receives `2 x days + 2` points (seen live: 122 for 60): the previous period first, then the current one,
 * `days + 1` points each. Any other length is read as one period with no previous.
 */
export function historySeries(cap: StudioCapture, key: string): Series | undefined {
    const f = insight(cap, key);
    if (!f || !Array.isArray(f.value)) return undefined;
    const pts = (f.value as any[]).filter((p) => p && num(p.value) !== undefined);
    const values = pts.map((p) => p.value as number);
    const statuses = [...new Set(pts.map((p) => num(p.status)).filter((s): s is number => s !== undefined))].sort((a, b) => a - b);
    const days = num(f.request?.days);
    const n = values.length;
    if (days !== undefined && n === 2 * days + 2) return { key, days, end_days: num(f.request?.end_days), current: values.slice(days + 1), previous: values.slice(0, days + 1), statuses };
    return { key, days, end_days: num(f.request?.end_days), current: values, statuses };
}
