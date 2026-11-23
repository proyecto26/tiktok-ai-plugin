// In-page capture for TikTok Studio analytics and monetization, run in the owner's own Chrome tab on
// https://www.tiktok.com/tiktokstudio/... Read-only: it never clicks, scrolls, likes, follows or posts, and it
// never calls TikTok itself. It only copies the JSON answers of the requests the Studio page already makes for
// itself (they are signed by TikTok's own code), keeps a sanitized projection, and returns it.
//
// Agent usage (a browser tool that can run JavaScript in the page), one tab, long pauses between steps:
//   1. Open /tiktokstudio/analytics (or /tiktokstudio/monetization) and run this file's text right after the
//      page loads: it installs the hook and returns a capture (possibly with no answers yet).
//   2. Wait for the page to load its charts (about 10 s), or switch the page's own date range once with the mouse
//      yourself; run this file's text again to collect.
//   3. Save the returned JSON to a file and pass it to the tiktok-ads skill: main.ts analytics|monetization|
//      eligibility --studio <file>
//
// Allowlist (seen live 2026-11-22, docs/plans/2026-11-22-studio-recon.md):
//   /aweme/v2/data/insight/                                  analytics series (type_requests query says which)
//   /tiktok/v1/analytics/insights/                           analytics overview (rewards)
//   /tiktok/v1/creator/m10n_center/(all_programs|settings|reward_analytics)
// Kept: metric fields, program fields, and the `type_requests` query (it says which metrics were requested).
// Dropped: every URL, logid / impr_id / log_pb, and every other query parameter (msToken, X-Bogus, device ids).
(() => {
    if (location.origin !== 'https://www.tiktok.com') return { error: 'not a www.tiktok.com page' };
    const KEEP = [
        /^\/aweme\/v2\/data\/insight\/?$/,
        /^\/tiktok\/v1\/analytics\/insights\/?$/,
        /^\/tiktok\/v1\/creator\/m10n_center\/(all_programs|settings|reward_analytics)\/?$/,
    ];
    const MAX_RESPONSES = 60;
    const MAX_ARRAY = 500;
    const CHALLENGE = /"type"\s*:\s*"verify"|"verify_event"|"verifyConfig"|captcha-verify|secsdk-captcha/;
    // Kept in step with TOO_MANY in scripts/client.ts and capture.js.
    const TOO_MANY = /too many attempts|maximum number of attempts|too many requests/i;
    // A JSON answer is judged by its own error message (non-zero status), never by program text.
    const tooMany = (text) => {
        let j;
        try {
            j = JSON.parse(text);
        } catch {
            return TOO_MANY.test(text);
        }
        if (!j || typeof j !== 'object') return false;
        const code = j.statusCode ?? j.status_code;
        if (code === 0 || code === '0') return false;
        return [j.statusMsg, j.status_msg, j.message, j.msg].some((m) => typeof m === 'string' && TOO_MANY.test(m));
    };
    const w = window;
    if (!w.__ttStudio) {
        const state = { responses: [], dropped: 0, challenge: false, rateLimited: false };
        w.__ttStudio = { state };
        const keep = (url, text, status, route) => {
            try {
                const u = new URL(url, location.href);
                if (!KEEP.some((re) => re.test(u.pathname))) return;
                // HTTP 429 stops every read (account signal), whatever the body says.
                if (status === 429) {
                    state.rateLimited = true;
                    return;
                }
                // A refused API call (401/403), with or without a body, is a block.
                if (status === 401 || status === 403) {
                    state.challenge = true;
                    return;
                }
                if (!text) return;
                if (tooMany(text)) {
                    state.rateLimited = true;
                    return;
                }
                if (CHALLENGE.test(text) || /^\s*</.test(text)) {
                    state.challenge = true;
                    return;
                }
                let typeRequests;
                const tr = u.searchParams.get('type_requests');
                if (tr !== null) {
                    try {
                        typeRequests = JSON.parse(tr);
                    } catch {
                        typeRequests = tr.slice(0, 500);
                    }
                }
                const entry = { path: u.pathname, route, typeRequests, raw: JSON.parse(text) };
                const id = entry.path + '|' + JSON.stringify(typeRequests ?? null) + '|' + route;
                const at = state.responses.findIndex((r) => r.id === id);
                if (at >= 0) {
                    state.responses[at] = { id, ...entry };
                    return;
                }
                if (state.responses.length >= MAX_RESPONSES) {
                    state.dropped++;
                    return;
                }
                state.responses.push({ id, ...entry });
            } catch {
                // not JSON or not ours: ignore
            }
        };
        const origFetch = w.fetch;
        w.fetch = async function (...args) {
            const route = location.pathname;
            const res = await origFetch.apply(this, args);
            try {
                const url = typeof args[0] === 'string' ? args[0] : args[0]?.url;
                if (url) res.clone().text().then((t) => keep(url, t, res.status, route), () => {});
            } catch {
                // never break the page
            }
            return res;
        };
        const origOpen = XMLHttpRequest.prototype.open;
        XMLHttpRequest.prototype.open = function (method, url, ...rest) {
            const route = location.pathname;
            this.addEventListener('load', () => {
                try {
                    if (this.responseType === '' || this.responseType === 'text') keep(String(url), this.responseText, this.status, route);
                } catch {
                    // ignore
                }
            });
            return origOpen.call(this, method, url, ...rest);
        };
    }

    // ---- sanitized projection -------------------------------------------------------------------------------
    // Any key that carries a link, an id of a log line, an icon or a token is dropped; so is any URL inside a string.
    const DROP_KEY = /url|uri$|logid|log_pb|impr_id|icon|avatar|cover|token|^extra$|^schema$/i;
    const clean = (s) => s.replace(/https?:\/\/\S*/gi, '').trim();
    const sanitize = (v, depth = 0) => {
        if (v === null || v === undefined) return undefined;
        if (typeof v === 'string') {
            const s = clean(v);
            return s === '' && v !== '' ? undefined : s;
        }
        if (typeof v !== 'object') return v;
        if (depth > 8) return undefined;
        if (Array.isArray(v)) return v.slice(0, MAX_ARRAY).map((x) => sanitize(x, depth + 1));
        const out = {};
        for (const [k, x] of Object.entries(v)) {
            if (DROP_KEY.test(k)) continue;
            const y = sanitize(x, depth + 1);
            if (y === undefined) continue;
            if (y && typeof y === 'object' && !Array.isArray(y) && Object.keys(y).length === 0) continue; // unrequested metric
            out[k] = y;
        }
        return out;
    };
    const program = (p) => {
        if (!p || typeof p !== 'object') return {};
        const a = p.access_restriction_info;
        const wp = p.web_page_info;
        return {
            name: typeof p.name === 'string' ? clean(p.name) : undefined,
            description: typeof p.description === 'string' ? clean(p.description) : undefined,
            m10n_project: p.m10n_project,
            requirements_met: p.requirements_met,
            total_requirements: p.total_requirements,
            access_restriction_info: a && typeof a === 'object' ? { is_access_restricted: a.is_access_restricted } : undefined,
            program_cta_text: typeof p.program_cta_text === 'string' ? clean(p.program_cta_text) : undefined,
            m10n_badge: Array.isArray(p.m10n_badge) ? p.m10n_badge.map((b) => ({ badge_label: b && typeof b.badge_label === 'string' ? clean(b.badge_label) : undefined })) : undefined,
            show_red_dot: p.show_red_dot,
            web_page_info: wp && typeof wp === 'object' ? { button_text: typeof wp.button_text === 'string' ? clean(wp.button_text) : undefined, status: wp.status } : undefined,
        };
    };
    const programs = (b) => {
        const list = (k) => (Array.isArray(b[k]) ? b[k].slice(0, MAX_ARRAY).map(program) : undefined);
        return {
            status_code: b.status_code,
            active_m10n_programs: list('active_m10n_programs'),
            eligible_to_apply_m10n_programs: list('eligible_to_apply_m10n_programs'),
            ineligible_to_apply_m10n_programs: list('ineligible_to_apply_m10n_programs'),
        };
    };
    const body = (path, b) => {
        if (!b || typeof b !== 'object') return {};
        if (/all_programs\/?$/.test(path)) return programs(b);
        return sanitize(b) || {};
    };

    const s = w.__ttStudio.state;
    return JSON.stringify({
        schema: 'tt.studio-capture.v1',
        url: location.origin + location.pathname,
        capturedAt: new Date().toISOString(),
        responses: s.responses.map((r) => ({ path: r.path, route: r.route, typeRequests: sanitize(r.typeRequests), body: body(r.path, r.raw) })),
        dropped: s.dropped,
        rateLimited: s.rateLimited,
        challenge: s.challenge || !!document.querySelector('#captcha-verify-container, #captcha_container, .captcha-verify-container, [class*="secsdk-captcha"]'),
    });
})();
