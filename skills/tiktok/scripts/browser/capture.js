// In-page capture for TikTok reads, run in the owner's own Chrome tab on https://www.tiktok.com.
// Read-only: it never clicks, likes, follows or posts, and it never calls TikTok itself. It only
// (1) reads the page's embedded data script and (2) copies the JSON answers of the requests the
// page already makes for itself (they are signed by TikTok's own code).
//
// Agent usage (claude-in-chrome javascript_tool), one tab, long pauses between steps:
//   1. Run this file's text right after the page loads           → installs the hook, returns a capture
//   2. Optionally scroll:  window.__ttCapture.more()              → one scroll, at most 10 per page
//      wait several seconds, then run step 1 again to collect
//   3. Save the returned JSON to a file and run e.g.
//      main.ts videos --capture <file> [--limit N]
(() => {
    if (location.origin !== 'https://www.tiktok.com') return { error: 'not a www.tiktok.com page' };
    const KEEP = /^\/api\/(post\/item_list|comment\/list|item\/detail|challenge\/item_list|music\/item_list)\/?$/;
    const MAX_RESPONSES = 40;
    const MAX_SCROLLS = 10;
    const CHALLENGE = /"type"\s*:\s*"verify"|"verify_event"|"verifyConfig"|captcha-verify|secsdk-captcha/;
    const w = window;
    // Which list the tab shows: a profile, a tag or a music page. Other paths (a post opened in-page) keep the list.
    const listKey = () => {
        const p = new URL(location.href).pathname;
        const m = p.match(/^\/@([^/]+)/);
        if (m) return '@' + m[1].toLowerCase();
        const t = p.match(/^\/(tag|music)\/([^/]+)/);
        if (t) return t[1] + '/' + t[2].toLowerCase();
        return w.__ttState ? w.__ttState.key : p;
    };
    // A move to another list clears what was kept and starts a new generation.
    const sync = () => {
        const s = w.__ttState;
        if (!s) return; // a hook installed by an older capture.js: reload the page to get list identity
        const k = listKey();
        if (k !== s.key) {
            s.key = k;
            s.gen++;
            s.responses = [];
        }
    };
    if (!w.__ttCapture) {
        const state = { responses: [], scrolls: 0, dropped: 0, stale: 0, challenge: false, rateLimited: false, key: listKey(), gen: 0 };
        w.__ttState = state;
        // Called when a request is sent: which list it belongs to.
        const dispatch = () => {
            sync();
            return { route: state.key, gen: state.gen };
        };
        const keep = (url, text, status, tag) => {
            try {
                const u = new URL(url, location.href);
                if (!KEEP.test(u.pathname)) return;
                // HTTP 429 stops every read (account signal), whatever the body says.
                if (status === 429) {
                    state.rateLimited = true;
                    return;
                }
                if (!text) return;
                // An API answer that is a captcha or verification page stops every read (account signal).
                if (CHALLENGE.test(text) || /^\s*</.test(text)) {
                    state.challenge = true;
                    return;
                }
                // An answer to a request sent on another list page (the tab moved on) is not this list's.
                sync();
                if (!tag || tag.gen !== state.gen) {
                    state.stale++;
                    return;
                }
                if (state.responses.length >= MAX_RESPONSES) {
                    state.dropped++;
                    return;
                }
                // One tab keeps the answers of every post opened in it; aweme_id says which post a page belongs to.
                const itemId = u.searchParams.get('aweme_id') || u.searchParams.get('item_id') || u.searchParams.get('itemId') || undefined;
                const cur = u.searchParams.get('cursor');
                const reqCursor = cur !== null && /^\d+$/.test(cur) ? cur : undefined;
                state.responses.push({ path: u.pathname, itemId, route: tag.route, reqCursor, body: JSON.parse(text) });
            } catch {
                // not JSON or not ours: ignore
            }
        };
        const origFetch = w.fetch;
        w.fetch = async function (...args) {
            const tag = dispatch();
            const res = await origFetch.apply(this, args);
            try {
                const url = typeof args[0] === 'string' ? args[0] : args[0]?.url;
                if (url) res.clone().text().then((t) => keep(url, t, res.status, tag), () => {});
            } catch {
                // never break the page
            }
            return res;
        };
        const origOpen = XMLHttpRequest.prototype.open;
        XMLHttpRequest.prototype.open = function (method, url, ...rest) {
            const tag = dispatch();
            this.addEventListener('load', () => {
                try {
                    if (this.responseType === '' || this.responseType === 'text') keep(String(url), this.responseText, this.status, tag);
                } catch {
                    // ignore
                }
            });
            return origOpen.call(this, method, url, ...rest);
        };
        w.__ttCapture = {
            state,
            more() {
                // A captcha, verification or 429 means stop: no more scrolling on this page.
                if (state.challenge || state.rateLimited) return { scrolls: state.scrolls, stopped: true };
                if (state.scrolls >= MAX_SCROLLS) return { scrolls: state.scrolls, budget: 'used up' };
                state.scrolls++;
                w.scrollTo({ top: document.body.scrollHeight, behavior: 'smooth' });
                return { scrolls: state.scrolls };
            },
        };
    }
    let scope = {};
    try {
        const el = document.getElementById('__UNIVERSAL_DATA_FOR_REHYDRATION__');
        scope = el ? JSON.parse(el.textContent || '{}').__DEFAULT_SCOPE__ || {} : {};
    } catch {
        scope = {};
    }
    // Compact output: only the fields read.ts uses. Tokens such as secUid are left out, so the
    // extension does not block the result and long answers are not cut.
    const user = (d) => {
        const i = d && d.userInfo;
        if (!d) return undefined;
        const u = (i && i.user) || {};
        return {
            statusCode: d.statusCode,
            statusMsg: d.statusMsg,
            userInfo: i && {
                user: { id: u.id, uniqueId: u.uniqueId, nickname: u.nickname, signature: u.signature, verified: u.verified, privateAccount: u.privateAccount },
                stats: i.stats,
                itemList: (i.itemList || []).map(item),
            },
        };
    };
    const video = (v) => (!v || typeof v !== 'object' ? {} : {
        duration: v.duration,
        width: v.width,
        height: v.height,
        playAddr: v.playAddr,
        downloadAddr: v.downloadAddr,
        bitrateInfo: Array.isArray(v.bitrateInfo) ? v.bitrateInfo.slice(0, 3).map((b) => ({ PlayAddr: { UrlList: b && b.PlayAddr && b.PlayAddr.UrlList } })) : undefined,
        subtitleInfos: Array.isArray(v.subtitleInfos) ? v.subtitleInfos.map((x) => ({ LanguageCodeName: x.LanguageCodeName, Url: x.Url, Format: x.Format, Source: x.Source })) : undefined,
    });
    const music = (m) => (!m || typeof m !== 'object' ? {} : { title: m.title, id: m.id, authorName: m.authorName, original: m.original });
    const item = (i) => (!i || typeof i !== 'object' ? {} : {
        id: i.id,
        desc: i.desc,
        createTime: i.createTime,
        stats: i.stats,
        video: video(i.video),
        imagePost: i.imagePost ? { images: (i.imagePost.images || []).map(() => ({})) } : undefined,
        music: music(i.music),
        challenges: (i.challenges || []).map((c) => ({ title: c.title })),
        textExtra: (i.textExtra || []).map((t) => ({ hashtagName: t.hashtagName })),
        author: { uniqueId: i.author && i.author.uniqueId },
    });
    const comment = (c) => ({
        cid: c.cid,
        text: c.text,
        digg_count: c.digg_count,
        create_time: c.create_time,
        reply_comment_total: c.reply_comment_total,
        user: { unique_id: c.user && c.user.unique_id },
    });
    const body = (path, b) => {
        if (!b || typeof b !== 'object') return {};
        if (path.includes('comment/list')) return { status_code: b.status_code, has_more: b.has_more, cursor: b.cursor, comments: (b.comments || []).map(comment) };
        if (path.includes('item/detail')) return { statusCode: b.statusCode, itemInfo: b.itemInfo && { itemStruct: item(b.itemInfo.itemStruct || {}) } };
        return { statusCode: b.statusCode, hasMore: b.hasMore, cursor: b.cursor, itemList: (b.itemList || []).map(item) };
    };
    const vd = scope['webapp.video-detail'];
    const s = w.__ttCapture.state;
    sync();
    return JSON.stringify({
        schema: 'tt.capture.v1',
        url: location.href.split('?')[0],
        capturedAt: new Date().toISOString(),
        scope: {
            'webapp.user-detail': user(scope['webapp.user-detail']),
            'webapp.video-detail': vd && { statusCode: vd.statusCode, statusMsg: vd.statusMsg, itemInfo: vd.itemInfo && { itemStruct: item(vd.itemInfo.itemStruct || {}) } },
        },
        responses: s.responses.map((r) => ({ path: r.path, itemId: r.itemId, route: r.route, reqCursor: r.reqCursor, body: body(r.path, r.body) })),
        scrolls: s.scrolls,
        dropped: s.dropped,
        stale: s.stale,
        rateLimited: s.rateLimited,
        challenge: s.challenge || !!document.querySelector('#captcha-verify-container, #captcha_container, .captcha-verify-container, [class*="secsdk-captcha"]'),
    });
})();
