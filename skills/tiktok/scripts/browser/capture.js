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
    const KEEP = /^\/api\/(post\/item_list|comment\/list|item\/detail)\/?$/;
    const MAX_RESPONSES = 40;
    const MAX_SCROLLS = 10;
    const w = window;
    if (!w.__ttCapture) {
        const state = { responses: [], scrolls: 0 };
        const keep = (url, text) => {
            try {
                const path = new URL(url, location.href).pathname;
                if (!KEEP.test(path) || state.responses.length >= MAX_RESPONSES || !text) return;
                state.responses.push({ path, body: JSON.parse(text) });
            } catch {
                // not JSON or not ours: ignore
            }
        };
        const origFetch = w.fetch;
        w.fetch = async function (...args) {
            const res = await origFetch.apply(this, args);
            try {
                const url = typeof args[0] === 'string' ? args[0] : args[0]?.url;
                if (url) res.clone().text().then((t) => keep(url, t), () => {});
            } catch {
                // never break the page
            }
            return res;
        };
        const origOpen = XMLHttpRequest.prototype.open;
        XMLHttpRequest.prototype.open = function (method, url, ...rest) {
            this.addEventListener('load', () => {
                try {
                    if (this.responseType === '' || this.responseType === 'text') keep(String(url), this.responseText);
                } catch {
                    // ignore
                }
            });
            return origOpen.call(this, method, url, ...rest);
        };
        w.__ttCapture = {
            state,
            more() {
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
    const item = (i) => ({
        id: i.id,
        desc: i.desc,
        createTime: i.createTime,
        stats: i.stats,
        video: { duration: i.video && i.video.duration },
        imagePost: i.imagePost ? { images: (i.imagePost.images || []).map(() => ({})) } : undefined,
        music: { title: i.music && i.music.title },
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
    return JSON.stringify({
        schema: 'tt.capture.v1',
        url: location.href.split('?')[0],
        capturedAt: new Date().toISOString(),
        scope: {
            'webapp.user-detail': user(scope['webapp.user-detail']),
            'webapp.video-detail': vd && { statusCode: vd.statusCode, statusMsg: vd.statusMsg, itemInfo: vd.itemInfo && { itemStruct: item(vd.itemInfo.itemStruct || {}) } },
        },
        responses: s.responses.map((r) => ({ path: r.path, body: body(r.path, r.body) })),
        scrolls: s.scrolls,
    });
})();
