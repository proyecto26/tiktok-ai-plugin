import { TtError } from './client.ts';

/**
 * Reads are captured in the owner's own Chrome (scripts/browser/capture.js), where TikTok's page passes
 * its WAF and signs its own API calls. This module only parses and normalizes what was captured:
 * the page's embedded data scope and the JSON answers of the page's own /api/ requests.
 */

export interface Capture {
    schema: 'tt.capture.v1';
    url: string;
    capturedAt: string;
    /** `__DEFAULT_SCOPE__` of the page's `__UNIVERSAL_DATA_FOR_REHYDRATION__` script. */
    scope: Record<string, unknown>;
    /** Answers of the page's own /api/ requests, in the order they arrived. */
    responses: { path: string; body: unknown }[];
    /** How many times the page was scrolled to load more (the request budget is 10). */
    scrolls: number;
}

export interface ReadResult<T> {
    source: 'page' | 'api';
    data: T;
    complete: boolean;
    reason?: string;
}

export interface TtProfile {
    username: string;
    userId: string;
    secUid: string;
    nickname: string;
    bio: string;
    followers: number;
    following: number;
    likes: number;
    videoCount: number;
    verified: boolean;
    private: boolean;
}

export interface TtVideo {
    id: string;
    url: string;
    createTime: number;
    caption: string;
    durationSec: number;
    plays: number;
    likes: number;
    comments: number;
    shares: number;
    saves?: number;
    isPhoto: boolean;
    imageCount?: number;
    musicTitle?: string;
    hashtags: string[];
}

export interface TtComment {
    id: string;
    text: string;
    likes: number;
    replies: number;
    createTime: number;
    author: string;
}

export const DEFAULT_LIMIT = 20;
export const MAX_LIMIT = 200;
export const SCROLL_BUDGET = 10;
const NOT_FOUND = new Set([10202, 10221]);
const EMBEDDED_ID = '__UNIVERSAL_DATA_FOR_REHYDRATION__';

type Obj = Record<string, unknown>;
const obj = (v: unknown): Obj => (v && typeof v === 'object' ? (v as Obj) : {});
const num = (v: unknown): number => (typeof v === 'number' ? v : Number(v) || 0);
const str = (v: unknown): string => (typeof v === 'string' ? v : v === undefined || v === null ? '' : String(v));

export function extractEmbedded(html: string): unknown | null {
    const m = html.match(new RegExp(`<script[^>]*id="${EMBEDDED_ID}"[^>]*>([\\s\\S]*?)</script>`));
    if (!m) return null;
    try {
        return JSON.parse(m[1]);
    } catch {
        return null;
    }
}

export function parseCapture(text: string): Capture {
    const c = JSON.parse(text) as Capture;
    if (c?.schema !== 'tt.capture.v1') throw new TtError('unexpected_page', 'Not a tt.capture.v1 schema file (capture it with scripts/browser/capture.js).');
    let origin = '';
    try {
        origin = new URL(c.url).origin;
    } catch {
        // fall through
    }
    if (origin !== 'https://www.tiktok.com') throw new TtError('unexpected_page', `The capture is not from https://www.tiktok.com (${c.url}).`);
    return { ...c, scope: obj(c.scope), responses: Array.isArray(c.responses) ? c.responses : [], scrolls: num(c.scrolls) };
}

function checkStatus(detail: Obj, what: string): void {
    const code = num(detail.statusCode);
    if (NOT_FOUND.has(code)) throw new TtError('not_found', `${what} not found on TikTok.`);
    if (code !== 0) throw new TtError('unexpected_page', `${what}: TikTok answered statusCode ${code} (${str(detail.statusMsg)}).`);
}

function userDetail(c: Capture): Obj {
    const d = c.scope['webapp.user-detail'];
    if (!d) throw new TtError('unexpected_page', 'The page has no profile data (webapp.user-detail). Was it a WAF, login or error page?');
    const detail = obj(d);
    checkStatus(detail, 'Profile');
    return detail;
}

export function profileFromCapture(c: Capture): ReadResult<TtProfile> {
    const info = obj(userDetail(c).userInfo);
    const u = obj(info.user);
    const s = obj(info.stats);
    return {
        source: 'page',
        complete: true,
        data: {
            username: str(u.uniqueId),
            userId: str(u.id),
            secUid: str(u.secUid),
            nickname: str(u.nickname),
            bio: str(u.signature),
            followers: num(s.followerCount),
            following: num(s.followingCount),
            likes: num(s.heartCount ?? s.heart),
            videoCount: num(s.videoCount),
            verified: u.verified === true,
            private: u.privateAccount === true,
        },
    };
}

export function normalizeVideo(raw: unknown): TtVideo {
    const i = obj(raw);
    const s = { ...obj(i.statsV2), ...obj(i.stats) };
    const author = str(obj(i.author).uniqueId);
    const images = Array.isArray(obj(i.imagePost).images) ? (obj(i.imagePost).images as unknown[]) : null;
    const id = str(i.id);
    const tags = new Set<string>();
    for (const t of Array.isArray(i.textExtra) ? i.textExtra : []) if (str(obj(t).hashtagName)) tags.add(str(obj(t).hashtagName));
    for (const ch of Array.isArray(i.challenges) ? i.challenges : []) if (str(obj(ch).title)) tags.add(str(obj(ch).title));
    const v: TtVideo = {
        id,
        url: `https://www.tiktok.com/@${author || '_'}/${images ? 'photo' : 'video'}/${id}`,
        createTime: num(i.createTime),
        caption: str(i.desc),
        durationSec: num(obj(i.video).duration),
        plays: num(s.playCount),
        likes: num(s.diggCount),
        comments: num(s.commentCount),
        shares: num(s.shareCount),
        isPhoto: images !== null,
        hashtags: [...tags],
    };
    if (s.collectCount !== undefined) v.saves = num(s.collectCount);
    if (images) v.imageCount = images.length;
    const music = str(obj(i.music).title);
    if (music) v.musicTitle = music;
    return v;
}

function clampLimit(limit?: number): number {
    if (!limit || !Number.isFinite(limit) || limit <= 0) return DEFAULT_LIMIT;
    return Math.min(Math.floor(limit), MAX_LIMIT);
}

function responsesFor(c: Capture, pathRe: RegExp): Obj[] {
    return c.responses.filter((r) => pathRe.test(r.path)).map((r) => obj(typeof r.body === 'string' ? safeJson(r.body) : r.body));
}

function safeJson(s: string): unknown {
    try {
        return JSON.parse(s);
    } catch {
        return {};
    }
}

function paged<T>(items: T[], limit: number, hasMore: boolean, scrolls: number): Pick<ReadResult<T[]>, 'data' | 'complete' | 'reason'> {
    if (items.length >= limit) return { data: items.slice(0, limit), complete: true };
    if (!hasMore) return { data: items, complete: true };
    return { data: items, complete: false, reason: scrolls >= SCROLL_BUDGET ? 'request_budget' : 'not_scrolled_far_enough' };
}

export function videosFromCapture(c: Capture, opts: { limit?: number }): ReadResult<TtVideo[]> {
    const limit = clampLimit(opts.limit);
    const pages = responsesFor(c, /\/api\/post\/item_list\/?$/);
    if (pages.length) {
        const seen = new Set<string>();
        const items: TtVideo[] = [];
        for (const p of pages) {
            for (const raw of Array.isArray(p.itemList) ? p.itemList : []) {
                const v = normalizeVideo(raw);
                if (!v.id || seen.has(v.id)) continue;
                seen.add(v.id);
                items.push(v);
            }
        }
        const last = pages[pages.length - 1];
        return { source: 'api', ...paged(items, limit, last.hasMore === true || last.hasMore === 1, c.scrolls) };
    }
    const info = obj(userDetail(c).userInfo);
    const embedded = (Array.isArray(info.itemList) ? info.itemList : []).map(normalizeVideo);
    if (!embedded.length && obj(info.user).privateAccount === true) throw new TtError('private', 'This account is private; its videos are not visible.');
    return { source: 'page', data: embedded.slice(0, limit), complete: false, reason: 'signed_list_api' };
}

export function videoFromCapture(c: Capture): ReadResult<TtVideo> {
    const id = c.url.match(/\/(?:video|photo)\/(\d+)/)?.[1];
    const detail = c.scope['webapp.video-detail'];
    if (detail) {
        const d = obj(detail);
        checkStatus(d, 'Video');
        const item = obj(obj(d.itemInfo).itemStruct);
        if (str(item.id)) return { source: 'page', data: normalizeVideo(item), complete: true };
    }
    for (const p of [...responsesFor(c, /\/api\/(post\/item_list|item\/detail)\/?$/)]) {
        const list = Array.isArray(p.itemList) ? p.itemList : p.itemInfo ? [obj(p.itemInfo).itemStruct] : [];
        const hit = list.find((i) => !id || str(obj(i).id) === id);
        if (hit) return { source: 'api', data: normalizeVideo(hit), complete: true };
    }
    throw new TtError(id ? 'not_found' : 'unexpected_page', id ? `Video ${id} is not in the capture. Open it from a profile capture that loaded its list page (window.__ttCapture.more()), then run \`video\` on that capture.` : 'The capture has no video.');
}

export function commentsFromCapture(c: Capture, opts: { limit?: number }): ReadResult<TtComment[]> {
    const limit = clampLimit(opts.limit);
    const pages = responsesFor(c, /\/api\/comment\/list\/?$/);
    if (!pages.length) return { source: 'page', data: [], complete: false, reason: 'signed_comment_api' };
    const seen = new Set<string>();
    const out: TtComment[] = [];
    for (const p of pages) {
        for (const raw of Array.isArray(p.comments) ? p.comments : []) {
            const x = obj(raw);
            const id = str(x.cid);
            if (!id || seen.has(id)) continue;
            seen.add(id);
            out.push({ id, text: str(x.text), likes: num(x.digg_count), replies: num(x.reply_comment_total), createTime: num(x.create_time), author: str(obj(x.user).unique_id) });
        }
    }
    const last = pages[pages.length - 1];
    return { source: 'api', ...paged(out, limit, last.has_more === 1 || last.has_more === true, c.scrolls) };
}
