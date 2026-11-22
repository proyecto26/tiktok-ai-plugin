import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { Window } from 'happy-dom';

const src = (n: string) => readFileSync(path.resolve(import.meta.dir, '../../skills/tiktok/scripts/browser', n), 'utf8');
const COMPOSE = src('compose.js');
const ROWS = src('studio-rows.js');

/** Runs an in-page script against a happy-dom page; returns [result, window]. */
function runIn(script: string, url: string, html: string) {
    const w = new Window({ url });
    // Studio's own app context is the only account source compose.js trusts (no profile-link fallback)
    (w as unknown as Record<string, unknown>).__Creator_Center_Context__ = { commonAppContext: { user: { uniqueId: 'JDNichollsc' } } };
    w.document.body.innerHTML = html;
    const names = ['window', 'document', 'location', 'HTMLInputElement', 'HTMLTextAreaElement', 'InputEvent', 'Event'] as const;
    const f = new Function(...names, `return (${script.trim().replace(/;$/, '')})`);
    const result = f(w, w.document, w.location, w.HTMLInputElement, w.HTMLTextAreaElement, w.InputEvent, w.Event);
    return { result, w: w as unknown as Window & { __ttCompose: { state(): Record<string, unknown>; fill(s: unknown): Promise<{ filled: string[]; state: Record<string, unknown> }> } } };
}

const VIDEO_EDITOR = `
  <a href="https://www.tiktok.com/@JDNichollsc">me</a>
  <div data-e2e="caption_container"><div contenteditable="true">old caption</div></div>
  <div data-e2e="video_visibility_container"><span>Who can see this post</span><div><button role="combobox" aria-expanded="false"><div><div class="label">Everyone</div></div></button></div></div>
  <ul class="dropdown"></ul>
  <div><span>Comment</span><input type="checkbox" checked></div>
  <div><span>Reuse of content</span><input type="checkbox" checked></div>
  <div><span>Disclose post content</span><div role="switch" aria-checked="false"></div></div>
  <div><span>AI-generated content</span><div role="switch" aria-checked="false"></div></div>
  <video></video>
  <button data-e2e="post_video_button">Post</button><button>Save draft</button><button>Discard</button>`;
const UPLOAD = 'https://www.tiktok.com/tiktokstudio/upload?from=webapp';

describe('compose.js', () => {
    test('state() reads what the page shows', () => {
        const { result } = runIn(COMPOSE, UPLOAD, VIDEO_EDITOR);
        expect(result).toMatchObject({ schema: 'tt-pagestate-v1', account: 'jdnichollsc', kind: 'video', caption: 'old caption', privacy: 'everyone', allowComments: true, allowReuse: true, discloseContent: false, aiGenerated: false, files: 1, ready: true });
        expect(result.unread).toBeUndefined();
    });
    test('fill() sets caption, privacy and toggles, and never clicks Post / Save draft / Discard', async () => {
        const { w } = runIn(COMPOSE, UPLOAD, VIDEO_EDITOR);
        const clicked: string[] = [];
        for (const b of Array.from(w.document.querySelectorAll('button'))) b.addEventListener('click', () => clicked.push(b.textContent ?? ''));
        // like the live dropdown (2026-11-16): options exist only after the combobox button is clicked;
        // the Friends option carries a subtitle; picking one sets the label and closes the list
        const cb = w.document.querySelector('[role="combobox"]')!;
        const list = w.document.querySelector('.dropdown')!;
        cb.addEventListener('click', () => {
            cb.setAttribute('aria-expanded', 'true');
            list.innerHTML = '<li role="option">Everyone</li><li role="option">Friends<span>Followers you follow back</span></li><li role="option">Only you</li>';
            for (const o of Array.from(list.querySelectorAll('[role="option"]'))) o.addEventListener('click', () => {
                w.document.querySelector('.label')!.textContent = o.firstChild!.textContent;
                cb.setAttribute('aria-expanded', 'false');
                list.innerHTML = '';
            });
        });
        for (const s of Array.from(w.document.querySelectorAll('[role="switch"]'))) s.addEventListener('click', () => s.setAttribute('aria-checked', String(s.getAttribute('aria-checked') !== 'true')));
        const r = await w.__ttCompose.fill({ kind: 'video', caption: 'seam test', privacy: 'only_me', allowComments: false, allowReuse: true, aiGenerated: true, discloseContent: false });
        expect(r.state).toMatchObject({ caption: 'seam test', privacy: 'only_me', allowComments: false, allowReuse: true, aiGenerated: true, discloseContent: false });
        expect(clicked.filter((t) => /^(Post|Save draft|Discard)$/.test(t))).toEqual([]);
    });
    test('a file dropped onto the page is recorded too, so a dropped replacement breaks the byte check', async () => {
        const { w } = runIn(COMPOSE, UPLOAD, VIDEO_EDITOR);
        const file = { name: 'clip.mp4', size: 3, type: 'video/mp4', arrayBuffer: async () => new Uint8Array([1, 2, 3]).buffer };
        const drop = new w.Event('drop', { bubbles: true, cancelable: true });
        Object.defineProperty(drop, 'dataTransfer', { value: { files: [file] } });
        w.document.body.dispatchEvent(drop);
        const recs = await Promise.all((w as unknown as { __ttUploadRecords: Promise<{ name: string; bytes: number; sha256: string }>[] }).__ttUploadRecords);
        expect(recs).toHaveLength(1);
        expect(recs[0]).toMatchObject({ name: 'clip.mp4', bytes: 3, sha256: '039058c6f2c0cb492c533b0a4d14ef77cc0f78abccced5287d84a1a2011cfb81' });
    });
    test('live Studio shape: account from the creator context, files from the upload status', () => {
        const live = VIDEO_EDITOR.replace('<a href="https://www.tiktok.com/@JDNichollsc">me</a>', '').replace('<video></video>', '<div data-e2e="upload_status_container"><span>seam-story.mp4</span><span>1080P</span><span>Uploaded（8.74MB）</span><span>Replace</span></div>');
        const w = new Window({ url: UPLOAD });
        (w as unknown as Record<string, unknown>).__Creator_Center_Context__ = { commonAppContext: { user: { uniqueId: 'JDNichollsc' } } };
        w.document.body.innerHTML = live;
        const names = ['window', 'document', 'location', 'HTMLInputElement', 'HTMLTextAreaElement', 'InputEvent', 'Event'] as const;
        const r = new Function(...names, `return (${COMPOSE.trim().replace(/;$/, '')})`)(w, w.document, w.location, w.HTMLInputElement, w.HTMLTextAreaElement, w.InputEvent, w.Event);
        expect(r).toMatchObject({ account: 'jdnichollsc', files: 1, ready: true });
        w.document.querySelector('[data-e2e="upload_status_container"]')!.innerHTML = '<span>seam-story.mp4</span><span>Uploading 45%</span>';
        expect((w as unknown as { __ttCompose: { state(): Record<string, unknown> } }).__ttCompose.state()).toMatchObject({ files: 0, ready: false });
    });
    test('a missing toggle is reported as unread, not as false', () => {
        const { result } = runIn(COMPOSE, UPLOAD, VIDEO_EDITOR.replace('<div><span>Comment</span><input type="checkbox" checked></div>', ''));
        expect(result.unread).toEqual(['allowComments']);
    });
    test('a disabled Post button or a progress bar → ready false', () => {
        expect(runIn(COMPOSE, UPLOAD, VIDEO_EDITOR.replace('data-e2e="post_video_button"', 'data-e2e="post_video_button" disabled')).result.ready).toBe(false);
        expect(runIn(COMPOSE, UPLOAD, `${VIDEO_EDITOR}<div role="progressbar"></div>`).result.ready).toBe(false);
    });
    test('photo editor: title input and description', () => {
        const html = VIDEO_EDITOR.replace('<div contenteditable="true">old caption</div>', '<input maxlength="90" value="T1"><div contenteditable="true">D1</div>').replace('<video></video>', '');
        const { result } = runIn(COMPOSE, 'https://www.tiktok.com/tiktokstudio/upload/post/photo', html);
        expect(result).toMatchObject({ kind: 'photo', title: 'T1', description: 'D1' });
    });
    test('refuses other pages', () => {
        expect(runIn(COMPOSE, 'https://www.tiktok.com/@jdnichollsc', VIDEO_EDITOR).result).toEqual({ error: 'not a TikTok Studio upload page' });
        expect(runIn(COMPOSE, 'https://evil.example/tiktokstudio/upload', VIDEO_EDITOR).result).toEqual({ error: 'not a TikTok Studio upload page' });
    });
});

describe('studio-rows.js', () => {
    const CONTENT = 'https://www.tiktok.com/tiktokstudio/content';
    const row = (caption: string, privacy: string, review: boolean) => `<div class="row"><div class="cap">${caption}</div><div>Nov 15, 2026</div><span>${privacy}</span>${review ? '<span>Content under review</span>' : ''}<div>294</div></div>`;
    test('reads caption, privacy and review state per row', () => {
        const { result } = runIn(ROWS, CONTENT, `<a href="/@jdnichollsc">me</a><div class="table">${row('seam test', 'Only me', true)}${row('older post', 'Everyone', false)}</div>`);
        expect(JSON.parse(result)).toEqual({
            schema: 'tt-rows-v1',
            account: 'jdnichollsc',
            capturedAt: expect.any(String),
            rows: [
                { text: 'seam test', privacy: 'only_me', underReview: true, time: 'Nov 15, 2026' },
                { text: 'older post', privacy: 'everyone', underReview: false, time: 'Nov 15, 2026' },
            ],
        });
    });
    test('live Studio table (2026-11-16): row container and caption cell by data-tt, label deep in a button', () => {
        const deep = (inner: string, n: number): string => (n ? `<div>${deep(inner, n - 1)}</div>` : inner);
        const liveRow = (caption: string, privacy: string, review: boolean) =>
            `<div data-tt="components_RowLayout_FlexRow"><div data-tt="components_RowLayout_FlexRow_2"><div data-tt="components_PostInfoCell_FlexRow"><div>00:43</div><div data-tt="components_PostInfoCell_FlexColumn"><span data-tt="components_PostInfoCell_TruncateText"><span>${caption}</span></span>${review ? '<div>Content under review</div>' : ''}</div></div></div>` +
            deep(`<button><svg><path></path></svg><div>${privacy}</div></button>`, 9) + '<div>0</div><div>0</div></div>';
        const { result } = runIn(ROWS, CONTENT, `<div data-tt="components_PostTable_Absolute">${liveRow('publish test (plugin), private', 'Only me', true)}${liveRow('Seam: two shots in', 'Only me', false)}</div>`);
        expect(JSON.parse(result).rows).toEqual([
            { text: 'publish test (plugin), private', privacy: 'only_me', underReview: true },
            { text: 'Seam: two shots in', privacy: 'only_me', underReview: false },
        ]);
    });
    test('refuses other pages', () => {
        expect(runIn(ROWS, 'https://www.tiktok.com/tiktokstudio/upload', '').result).toEqual({ error: 'not the TikTok Studio content page' });
    });
});
