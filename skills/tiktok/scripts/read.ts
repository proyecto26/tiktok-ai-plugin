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
    /** Answers of the page's own /api/ requests, in the order they arrived. `itemId` is the post a comment page belongs to. */
    responses: { path: string; itemId?: string; route?: string; reqCursor?: string; body: unknown }[];
    /** How many times the page was scrolled to load more (the request budget is 10). */
    scrolls: number;
    /** Answers the hook could not keep because its response cap was full. */
    dropped?: number;
    /** Answers to requests sent before the tab moved to another list page (discarded). */
    stale?: number;
    /** The page showed a captcha or verification, or a kept request answered with one. */
    challenge?: boolean;
    /** A kept request was answered with HTTP 429. */
    rateLimited?: boolean;
}

export interface ReadResult<T> {
    source: 'page' | 'api';
    data: T;
    complete: boolean;
    reason?: string;
    /**
     * Lists only: the whole list was read — a continuous cursor chain from 0 to a last page with no more,
     * no error page, nothing dropped or stale, nothing cut by --limit. `complete` only says the limit was met
     * or there were no more pages.
     */
    exhausted?: boolean;
}

export interface TtMedia {
    playUrls: string[];
    width: number;
    height: number;
    captions: { lang: string; url: string; format: string; source: string }[];
    music?: { id: string; title: string; author: string; original: boolean };
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
    musicId?: string;
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
    if (c.rateLimited === true) throw new TtError('rate_limited', 'TikTok answered HTTP 429 (too many requests) while capturing. Stop, wait, then run `resume`.', 429);
    if (c.challenge === true) throw new TtError('challenge', 'TikTok showed a captcha or verification while capturing. Solve it in the browser, then run `resume`.');
    return { ...c, scope: obj(c.scope), responses: Array.isArray(c.responses) ? c.responses : [], scrolls: num(c.scrolls), dropped: num(c.dropped), stale: num(c.stale) };
}

function checkStatus(detail: Obj, what: string): void {
    const code = num(detail.statusCode);
    if (NOT_FOUND.has(code)) throw new TtError('not_found', `${what} not found on TikTok.`);
    if (code !== 0) throw new TtError('unexpected_page', `${what}: TikTok answered statusCode ${code} (${str(detail.statusMsg)}).`);
}

const postIdOf = (c: Capture): string | undefined => c.url.match(/\/(?:video|photo)\/(\d+)/)?.[1];
const handleOf = (c: Capture): string | undefined => c.url.match(/tiktok\.com\/@([^/?#]+)/)?.[1]?.toLowerCase();

function userDetail(c: Capture): Obj {
    const d = c.scope['webapp.user-detail'];
    if (!d) throw new TtError('unexpected_page', 'The page has no profile data (webapp.user-detail). Was it a WAF, login or error page?');
    const detail = obj(d);
    checkStatus(detail, 'Profile');
    // The embedded data is the first page TikTok rendered; after an in-page route change it describes that page.
    const shown = str(obj(obj(detail.userInfo).user).uniqueId).toLowerCase();
    const wanted = handleOf(c);
    if (shown && wanted && shown !== wanted) throw new TtError('unexpected_page', `The page data is for @${shown}, not @${wanted}. Reload the profile page, then capture again.`);
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
    const musicId = str(obj(i.music).id);
    if (musicId) v.musicId = musicId;
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

function paged<T>(items: T[], limit: number, hasMore: boolean, scrolls: number, failed = false): Pick<ReadResult<T[]>, 'data' | 'complete' | 'reason'> {
    if (items.length >= limit) return { data: items.slice(0, limit), complete: true };
    // A page TikTok answered with an error status is not the end of the list.
    if (failed) return { data: items, complete: false, reason: 'api_error' };
    if (!hasMore) return { data: items, complete: true };
    return { data: items, complete: false, reason: scrolls >= SCROLL_BUDGET ? 'request_budget' : 'not_scrolled_far_enough' };
}

type Kept = { r: Capture['responses'][number]; body: Obj };

function keptFor(c: Capture, pathRe: RegExp): Kept[] {
    return c.responses.filter((r) => pathRe.test(r.path)).map((r) => ({ r, body: obj(typeof r.body === 'string' ? safeJson(r.body) : r.body) }));
}

/** Answers of one list kind that came from two list pages (profile, tag, music) are not one list. */
function assertOneRoute(pages: Kept[], what: string): void {
    const routes = new Set(pages.map((p) => p.r.route).filter((x): x is string => typeof x === 'string'));
    if (routes.size > 1) throw new TtError('mixed_lists', `The capture mixes ${what} answers from ${[...routes].join(', ')}. Reload the one page you want, then capture again.`);
}

/** The whole list was read: a continuous cursor chain from 0 to a last page with no more, nothing lost or cut. */
function chainExhausted(c: Capture, pages: Kept[], returned: number, total: number, failed: boolean): boolean {
    if (!pages.length || failed || num(c.dropped) > 0 || num(c.stale) > 0 || returned < total) return false;
    for (let i = 0; i < pages.length; i++) {
        const rc = pages[i].r.reqCursor;
        if (rc === undefined) return false;
        if (i === 0 ? rc !== '0' : rc !== str(pages[i - 1].body.cursor)) return false;
    }
    // Only an explicit "no more" proves the end; a page without the field proves nothing.
    const last = pages[pages.length - 1].body;
    return last.hasMore === false || last.hasMore === 0;
}

function itemListRead(c: Capture, pages: Kept[], limit: number): ReadResult<TtVideo[]> {
    const seen = new Set<string>();
    const items: TtVideo[] = [];
    for (const p of pages) {
        for (const raw of Array.isArray(p.body.itemList) ? p.body.itemList : []) {
            const v = normalizeVideo(raw);
            if (!v.id || seen.has(v.id)) continue;
            seen.add(v.id);
            items.push(v);
        }
    }
    const last = pages[pages.length - 1].body;
    const failed = pages.some((p) => p.body.statusCode !== undefined && num(p.body.statusCode) !== 0);
    const page = paged(items, limit, last.hasMore === true || last.hasMore === 1, c.scrolls, failed);
    return { source: 'api', ...page, exhausted: chainExhausted(c, pages, page.data.length, items.length, failed) };
}

function namedListFromCapture(c: Capture, pathRe: RegExp, what: string, opts: { limit?: number }): ReadResult<TtVideo[]> {
    const limit = clampLimit(opts.limit);
    const pages = keptFor(c, pathRe);
    if (!pages.length) return { source: 'page', data: [], complete: false, reason: c.dropped ? 'capture_full' : 'signed_list_api', exhausted: false };
    assertOneRoute(pages, what);
    return itemListRead(c, pages, limit);
}

/** Posts of a hashtag page (/tag/<name>), from the page's own /api/challenge/item_list/ answers. */
export function hashtagFromCapture(c: Capture, opts: { limit?: number }): ReadResult<TtVideo[]> {
    return namedListFromCapture(c, /\/api\/challenge\/item_list\/?$/, 'hashtag', opts);
}

/** Posts of a sound page (/music/<slug>-<id>), from the page's own /api/music/item_list/ answers. */
export function soundFromCapture(c: Capture, opts: { limit?: number }): ReadResult<TtVideo[]> {
    return namedListFromCapture(c, /\/api\/music\/item_list\/?$/, 'sound', opts);
}

/** The raw (projected) item of one post anywhere in the capture, or null. */
export function itemFromCapture(c: Capture, id: string): Record<string, unknown> | null {
    const candidates: unknown[] = [];
    for (const p of keptFor(c, /\/api\/(post|challenge|music)\/item_list\/?$|\/api\/item\/detail\/?$/)) {
        if (Array.isArray(p.body.itemList)) candidates.push(...p.body.itemList);
        if (p.body.itemInfo) candidates.push(obj(p.body.itemInfo).itemStruct);
    }
    const vd = obj(c.scope['webapp.video-detail']);
    if (vd.itemInfo) candidates.push(obj(vd.itemInfo).itemStruct);
    const ud = obj(obj(c.scope['webapp.user-detail']).userInfo);
    if (Array.isArray(ud.itemList)) candidates.push(...ud.itemList);
    return candidates.map(obj).find((i) => str(i.id) === id) ?? null;
}

/** Playable URLs, size and captions of one captured video. The URLs are signed: never log them. */
export function mediaFromCapture(c: Capture, id: string): ReadResult<TtMedia> {
    const hit = itemFromCapture(c, id);
    if (!hit) throw new TtError('not_found', `Post ${id} is not in the capture. Capture a list page that shows it, then try again.`);
    const v = obj(hit.video);
    const urls: string[] = [];
    const add = (u: unknown) => {
        const s = str(u);
        if (s && !urls.includes(s)) urls.push(s);
    };
    add(v.playAddr);
    add(v.downloadAddr);
    for (const b of Array.isArray(v.bitrateInfo) ? v.bitrateInfo : []) for (const u of Array.isArray(obj(obj(b).PlayAddr).UrlList) ? (obj(obj(b).PlayAddr).UrlList as unknown[]) : []) add(u);
    const captions = (Array.isArray(v.subtitleInfos) ? v.subtitleInfos : [])
        .map(obj)
        .filter((x) => str(x.Url))
        .map((x) => ({ lang: str(x.LanguageCodeName), url: str(x.Url), format: str(x.Format), source: str(x.Source) }));
    const m = obj(hit.music);
    const data: TtMedia = { playUrls: urls, width: num(v.width), height: num(v.height), captions };
    if (str(m.id)) data.music = { id: str(m.id), title: str(m.title), author: str(m.authorName), original: m.original === true };
    return { source: 'api', data, complete: true };
}

export function videosFromCapture(c: Capture, opts: { limit?: number }): ReadResult<TtVideo[]> {
    const limit = clampLimit(opts.limit);
    const wanted = handleOf(c);
    // One tab keeps the list pages of every profile opened in it: keep only the URL profile's pages.
    const all = keptFor(c, /\/api\/post\/item_list\/?$/);
    const pages = all.filter((p) => !wanted || (Array.isArray(p.body.itemList) ? p.body.itemList : []).every((i) => {
        const a = str(obj(obj(i).author).uniqueId).toLowerCase();
        return !a || a === wanted;
    }));
    if (all.length && !pages.length && !c.scope['webapp.user-detail']) return { source: 'api', data: [], complete: false, reason: 'signed_list_api', exhausted: false };
    if (pages.length) {
        assertOneRoute(pages, 'profile list');
        return itemListRead(c, pages, limit);
    }
    const info = obj(userDetail(c).userInfo);
    const embedded = (Array.isArray(info.itemList) ? info.itemList : []).map(normalizeVideo);
    if (!embedded.length && obj(info.user).privateAccount === true) throw new TtError('private', 'This account is private; its videos are not visible.');
    return { source: 'page', data: embedded.slice(0, limit), complete: false, reason: 'signed_list_api' };
}

export function videoFromCapture(c: Capture): ReadResult<TtVideo> {
    const id = postIdOf(c);
    if (!id) throw new TtError('unexpected_page', 'The capture URL names no post (/video/<id> or /photo/<id>). Open the post, then capture.');
    const detail = c.scope['webapp.video-detail'];
    if (detail) {
        const d = obj(detail);
        const item = obj(obj(d.itemInfo).itemStruct);
        // The embedded data may describe the first post rendered, not the one in the URL.
        if (!str(item.id) || str(item.id) === id) {
            checkStatus(d, 'Video');
            if (str(item.id)) return { source: 'page', data: normalizeVideo(item), complete: true };
        }
    }
    for (const p of [...responsesFor(c, /\/api\/(post\/item_list|item\/detail)\/?$/)]) {
        const list = Array.isArray(p.itemList) ? p.itemList : p.itemInfo ? [obj(p.itemInfo).itemStruct] : [];
        const hit = list.find((i) => str(obj(i).id) === id);
        if (hit) return { source: 'api', data: normalizeVideo(hit), complete: true };
    }
    throw new TtError('not_found', `Video ${id} is not in the capture. Open it from a profile capture that loaded its list page (window.__ttCapture.more()), then run \`video\` on that capture.`);
}

export function commentsFromCapture(c: Capture, opts: { limit?: number }): ReadResult<TtComment[]> {
    const limit = clampLimit(opts.limit);
    const post = postIdOf(c);
    // One tab keeps the answers of every post opened in it: keep only this post's pages.
    const pages = c.responses
        .filter((r) => /\/api\/comment\/list\/?$/.test(r.path) && (!post || !r.itemId || r.itemId === post))
        .map((r) => obj(typeof r.body === 'string' ? safeJson(r.body) : r.body));
    if (!pages.length) return { source: 'page', data: [], complete: false, reason: c.dropped ? 'capture_full' : 'signed_comment_api' };
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
    const failed = pages.some((p) => p.status_code !== undefined && num(p.status_code) !== 0);
    return { source: 'api', ...paged(out, limit, last.has_more === 1 || last.has_more === true, c.scrolls, failed) };
}
