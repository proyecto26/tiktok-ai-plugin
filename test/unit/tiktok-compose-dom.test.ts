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
    w.document.body.innerHTML = html;
    const names = ['window', 'document', 'location', 'HTMLInputElement', 'HTMLTextAreaElement', 'InputEvent', 'Event'] as const;
    const f = new Function(...names, `return (${script.trim().replace(/;$/, '')})`);
    const result = f(w, w.document, w.location, w.HTMLInputElement, w.HTMLTextAreaElement, w.InputEvent, w.Event);
    return { result, w: w as unknown as Window & { __ttCompose: { state(): Record<string, unknown>; fill(s: unknown): Promise<{ filled: string[]; state: Record<string, unknown> }> } } };
}

const VIDEO_EDITOR = `
  <a href="https://www.tiktok.com/@JDNichollsc">me</a>
  <div data-e2e="caption_container"><div contenteditable="true">old caption</div></div>
  <div data-e2e="video_visibility_container"><div role="combobox">Everyone</div></div>
  <ul class="dropdown"><li role="option">Everyone</li><li role="option">Friends</li><li role="option">Only you</li></ul>
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
        expect(result).toMatchObject({ schema: 'tt.pagestate.v1', account: 'jdnichollsc', kind: 'video', caption: 'old caption', privacy: 'everyone', allowComments: true, allowReuse: true, discloseContent: false, aiGenerated: false, files: 1, ready: true });
        expect(result.unread).toBeUndefined();
    });
    test('fill() sets caption, privacy and toggles, and never clicks Post / Save draft / Discard', async () => {
        const { w } = runIn(COMPOSE, UPLOAD, VIDEO_EDITOR);
        const clicked: string[] = [];
        for (const b of Array.from(w.document.querySelectorAll('button'))) b.addEventListener('click', () => clicked.push(b.textContent ?? ''));
        // options behave like the real dropdown: clicking one sets the combobox label
        for (const o of Array.from(w.document.querySelectorAll('[role="option"]'))) o.addEventListener('click', () => (w.document.querySelector('[role="combobox"]')!.textContent = o.textContent));
        for (const s of Array.from(w.document.querySelectorAll('[role="switch"]'))) s.addEventListener('click', () => s.setAttribute('aria-checked', String(s.getAttribute('aria-checked') !== 'true')));
        const r = await w.__ttCompose.fill({ kind: 'video', caption: 'seam test', privacy: 'only_me', allowComments: false, allowReuse: true, aiGenerated: true, discloseContent: false });
        expect(r.state).toMatchObject({ caption: 'seam test', privacy: 'only_me', allowComments: false, allowReuse: true, aiGenerated: true, discloseContent: false });
        expect(clicked).toEqual([]);
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
            schema: 'tt.rows.v1',
            account: 'jdnichollsc',
            rows: [
                { text: 'seam test', privacy: 'only_me', underReview: true, time: 'Nov 15, 2026' },
                { text: 'older post', privacy: 'everyone', underReview: false, time: 'Nov 15, 2026' },
            ],
        });
    });
    test('refuses other pages', () => {
        expect(runIn(ROWS, 'https://www.tiktok.com/tiktokstudio/upload', '').result).toEqual({ error: 'not the TikTok Studio content page' });
    });
});
