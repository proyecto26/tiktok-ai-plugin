// In-page composer helper for TikTok Studio upload, run in the owner's own Chrome tab (claude-in-chrome
// javascript_tool) AFTER the file(s) were added to the page. It fills the approved settings and reads back
// what the page shows. It NEVER clicks Post, Save draft or Discard: the agent clicks Post itself, once,
// only after `publish begin` accepted the page state.
//
//   1. Run this file's text                   → installs window.__ttCompose, returns state()
//   2. await window.__ttCompose.fill(settings) → settings = draft.settings from `publish prepare`
//   3. JSON.stringify(window.__ttCompose.state()) → save to a file → `publish begin --page-state <file>`
//
// Locators come from docs/reviews/recon-upload.md (data-e2e caption_container, video_visibility_container,
// post_video_button; Post found by its text on the photo editor). Anything not found is reported as
// unknown/false so `publish begin` refuses rather than guessing.
(() => {
    if (location.origin !== 'https://www.tiktok.com' || !location.pathname.startsWith('/tiktokstudio/upload')) return { error: 'not a TikTok Studio upload page' };
    const PRIVACY = { 'only you': 'only_me', 'only me': 'only_me', friends: 'friends', everyone: 'everyone', 'followers you follow back': 'follow_back' };
    const LABEL = { only_me: 'Only you', friends: 'Friends', everyone: 'Everyone', follow_back: 'Followers you follow back' };
    const FORBIDDEN = /^(post|save draft|discard)$/i;
    const TOGGLES = { allowComments: /^comment$/i, allowReuse: /^reuse of content$/i, discloseContent: /^disclose post content$/i, aiGenerated: /^ai-generated content$/i };
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    const text = (el) => (el ? (el.innerText ?? el.textContent ?? '').replace(/\s+/g, ' ').trim() : '');
    const all = (sel, root = document) => Array.from(root.querySelectorAll(sel));

    /** Clicks only controls that are not Post / Save draft / Discard. */
    const safeClick = (el) => {
        if (!el) return false;
        const btn = el.closest ? el.closest('button') || el : el;
        if (FORBIDDEN.test(text(btn)) || FORBIDDEN.test(text(el)) || (btn.getAttribute && btn.getAttribute('data-e2e') === 'post_video_button')) throw new Error('compose.js refuses to click Post, Save draft or Discard');
        el.click();
        return true;
    };
    const byText = (re, root = document) => all('span,div,label,p,button,li,[role="option"]', root).filter((e) => re.test(text(e)) && !Array.from(e.children).some((c) => re.test(text(c))));

    const caption = () => document.querySelector('[data-e2e="caption_container"]');
    const editable = () => {
        const c = caption();
        return c ? all('[contenteditable="true"]', c) : [];
    };
    const titleInput = () => {
        const c = caption();
        return c ? c.querySelector('input[maxlength="90"], input[type="text"], textarea[maxlength="90"]') : null;
    };
    const kind = () => (location.pathname.includes('/post/photo') || titleInput() ? 'photo' : 'video');

    const setEditable = (el, value) => {
        el.focus();
        const sel = window.getSelection && window.getSelection();
        if (sel && document.createRange) {
            const r = document.createRange();
            r.selectNodeContents(el);
            sel.removeAllRanges();
            sel.addRange(r);
        }
        const ok = document.execCommand && document.execCommand('insertText', false, value);
        if (!ok || text(el) !== value.replace(/\s+/g, ' ').trim()) {
            el.textContent = value;
            el.dispatchEvent(new InputEvent('input', { bubbles: true, data: value, inputType: 'insertText' }));
        }
    };
    const setInput = (el, value) => {
        const proto = el.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
        Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, value);
        el.dispatchEvent(new Event('input', { bubbles: true }));
        el.dispatchEvent(new Event('change', { bubbles: true }));
    };

    const privacyBox = () => document.querySelector('[data-e2e="video_visibility_container"]');
    const readPrivacy = () => {
        const t = text(privacyBox()).toLowerCase();
        for (const [label, v] of Object.entries(PRIVACY).sort((a, b) => b[0].length - a[0].length)) if (t.includes(label)) return v;
        return 'unknown';
    };

    /** The checkbox/switch that belongs to a label, searched upwards a few levels. */
    const control = (re) => {
        for (const label of byText(re)) {
            let n = label;
            for (let i = 0; i < 5 && n; i++, n = n.parentElement) {
                const c = n.querySelector('input[type="checkbox"], [role="switch"], [role="checkbox"]');
                if (c) return c;
            }
        }
        return null;
    };
    const checked = (c) => (c ? (c.checked === true || c.getAttribute('aria-checked') === 'true') : null);
    const showMore = () => {
        const m = byText(/^show more$/i)[0];
        if (m) safeClick(m);
    };

    const account = () => {
        // Seen live 2026-11-16: Studio keeps the signed-in user in its app context (no profile link on the page).
        try {
            const u = (window.__Creator_Center_Context__ && window.__Creator_Center_Context__.commonAppContext && window.__Creator_Center_Context__.commonAppContext.user) || (window.__NEXT_DATA__ && window.__NEXT_DATA__.props && window.__NEXT_DATA__.props.initialProps && window.__NEXT_DATA__.props.initialProps.$user);
            if (u && typeof u.uniqueId === 'string' && u.uniqueId) return u.uniqueId.toLowerCase();
        } catch {
            // unreadable context: no account
        }
        // No fallback to profile links: any page can link to any @handle, so they do not say who is signed in.
        return '';
    };
    const postButton = () => document.querySelector('[data-e2e="post_video_button"]') || all('button').find((b) => /^post$/i.test(text(b))) || null;
    // Seen live: [data-e2e="upload_status_container"] reads "seam-story.mp4 1080P Uploaded（8.74MB） Replace".
    const status = () => document.querySelector('[data-e2e="upload_status_container"]');
    const files = () => {
        const st = status();
        if (st) return (text(st).match(/Uploaded/gi) || []).length;
        const n = all('input[type="file"]').reduce((s, i) => s + (i.files ? i.files.length : 0), 0);
        if (n) return n;
        return kind() === 'video' ? (document.querySelector('video') ? 1 : 0) : all('[data-e2e*="photo"] img, [class*="image-item" i] img').length;
    };
    // File names shown by the upload status (leaf text that ends in an extension), in page order.
    const fileNames = () => {
        const st = status();
        if (!st) return [];
        return all('*', st).filter((e) => !e.children.length).map((e) => text(e)).filter((t) => /^[^\s/\\]+\.[a-z0-9]{2,5}$/i.test(t));
    };
    // Only TikTok's own verification overlays, and only when shown (a hidden SDK loader is not a challenge).
    const challenge = () => all('#captcha-verify-container, #captcha_container, [class*="captcha_verify" i], iframe[src*="captcha" i]').some((e) => !e.hidden && e.getAttribute('aria-hidden') !== 'true' && (!e.getClientRects || e.getClientRects().length > 0 || !window.getComputedStyle || window.getComputedStyle(e).display !== 'none'));
    const busy = () => (status() && !/Uploaded/i.test(text(status()))) || /uploading|processing|\b\d{1,2}%/i.test(text(document.querySelector('[class*="upload" i][class*="progress" i]')) || '') || all('[role="progressbar"]').length > 0;

    function state() {
        const k = kind();
        const eds = editable();
        const s = {
            schema: 'tt-pagestate-v1',
            url: location.href.split('?')[0],
            capturedAt: new Date().toISOString(),
            account: account(),
            kind: k,
            privacy: readPrivacy(),
            files: files(),
            fileNames: fileNames(),
            challenge: challenge(),
            ready: !challenge() && !!postButton() && !postButton().disabled && postButton().getAttribute('aria-disabled') !== 'true' && !busy(),
        };
        if (k === 'video') s.caption = text(eds[0]);
        else {
            const t = titleInput();
            s.title = t ? t.value : '';
            s.description = text(eds[0]);
        }
        // a control that was not found is null (not false), so it can never pass as an approved value
        for (const [key, re] of Object.entries(TOGGLES)) s[key] = checked(control(re));
        const unread = Object.entries(TOGGLES).filter(([, re]) => !control(re)).map(([key]) => key);
        if (unread.length) s.unread = unread;
        return s;
    }

    async function fill(settings) {
        const done = [];
        if (settings.kind === 'video') {
            const ed = editable()[0];
            if (!ed) throw new Error('caption field not found (data-e2e caption_container)');
            setEditable(ed, settings.caption || '');
            done.push('caption');
        } else {
            const t = titleInput();
            if (t) {
                setInput(t, settings.title || '');
                done.push('title');
            }
            const ed = editable()[0];
            if (ed) {
                setEditable(ed, settings.description || '');
                done.push('description');
            }
        }
        if (readPrivacy() !== settings.privacy) {
            // Seen live: <button role="combobox" aria-expanded> inside the container; options are [role="option"]
            // rendered only while it is open, and "Friends" carries a subtitle ("Followers you follow back").
            const box = privacyBox();
            const cb = box && (box.querySelector('[role="combobox"]') || box.querySelector('button'));
            if (!cb) throw new Error('privacy combobox not found (data-e2e video_visibility_container)');
            if (cb.getAttribute('aria-expanded') !== 'true') safeClick(cb);
            await sleep(400);
            const want = LABEL[settings.privacy].toLowerCase();
            const options = all('[role="option"]');
            const opt = options.find((o) => text(o).toLowerCase() === want) || options.find((o) => text(o).toLowerCase().startsWith(want)) || byText(new RegExp(`^${LABEL[settings.privacy]}$`, 'i')).find((e) => !box.contains(e));
            if (!opt) throw new Error(`privacy option "${LABEL[settings.privacy]}" not found`);
            safeClick(opt);
            await sleep(300);
            done.push('privacy');
        }
        if (Object.values(TOGGLES).some((re) => !control(re))) {
            showMore();
            await sleep(400);
        }
        for (const [key, re] of Object.entries(TOGGLES)) {
            const c = control(re);
            if (!c) continue;
            if (checked(c) !== settings[key]) {
                safeClick(c);
                await sleep(200);
                done.push(key);
            }
        }
        return { filled: done, state: state() };
    }

    window.__ttCompose = { state, fill };
    return state();
})();
