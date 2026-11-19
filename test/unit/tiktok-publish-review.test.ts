// Regression tests for the Phase 2 Seldon/Codex review findings (one per finding).
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, utimesSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { readFileSync } from 'node:fs';
import { Window } from 'happy-dom';

import { resolvePendingDir } from '../../skills/tiktok/scripts/paths.ts';
import type { Draft } from '../../skills/tiktok/scripts/publish/draft.ts';
import { beginAttempt, markOutcome } from '../../skills/tiktok/scripts/publish/ledger.ts';
import { compareState, matchRow, type PageState } from '../../skills/tiktok/scripts/publish/reconcile.ts';

const draft = {
    account: 'jdnichollsc',
    media: [{ path: 'C:\\x\\seam-story.mp4', sha256: 'a'.repeat(64), bytes: 9169788, manualFilePick: false }],
    settings: { kind: 'video', caption: 'publish test (plugin), private', privacy: 'only_me', allowComments: true, allowReuse: true, aiGenerated: false, discloseContent: false },
} as Draft;
const NOW = Date.parse('2026-11-16T13:06:31Z');
const page = (over: Partial<PageState> = {}): PageState => ({
    schema: 'tt-pagestate-v1',
    url: 'https://www.tiktok.com/tiktokstudio/upload',
    capturedAt: new Date(NOW - 10_000).toISOString(),
    account: 'jdnichollsc',
    kind: 'video',
    caption: 'publish test (plugin), private',
    privacy: 'only_me',
    allowComments: true,
    allowReuse: true,
    aiGenerated: false,
    discloseContent: false,
    files: 1,
    fileNames: ['seam-story.mp4'],
    uploads: [{ sha256: 'a'.repeat(64), bytes: 9169788, dhash: null }],
    location: '',
    ready: true,
    challenge: false,
    ...over,
});
const BASELINE = () => ({ schema: 'tt-rows-v1', account: 'jdnichollsc', capturedAt: new Date().toISOString(), rows: [{ text: 'older post', privacy: 'only_me', underReview: false, time: 'Nov 1, 9:00 AM' }] });
const has = (diff: string[], word: string) => expect(diff.some((d) => d.startsWith(word))).toBe(true);

describe('finding 1: unread controls never pass as approved', () => {
    test('a page state with unread toggles is a mismatch', () => {
        expect(compareState(draft, page(), NOW)).toEqual([]);
        has(compareState(draft, page({ unread: ['aiGenerated', 'discloseContent'] }), NOW), 'unread');
    });
});

describe('finding 2: reconcile never settles on an older or ambiguous row', () => {
    const startedAt = '2026-11-16T13:06:31.754Z';
    const local = (iso: string) => {
        const d = new Date(iso);
        return d.toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
    };
    const row = (time: string | undefined) => ({ text: 'publish test (plugin), private', privacy: 'only_me' as const, underReview: false, time });
    test('a same-caption row older than the attempt does not match', () => {
        expect(matchRow(draft, startedAt, [row('Nov 15, 2026, 4:04 PM')])).toBeNull();
    });
    test('two new rows with the same caption are ambiguous', () => {
        expect(matchRow(draft, startedAt, [row(local(startedAt)), row(local(startedAt))])).toBeNull();
    });
    test('one row at the attempt minute matches; a row without a time does not', () => {
        expect(matchRow(draft, startedAt, [row(local(startedAt))])).not.toBeNull();
        expect(matchRow(draft, startedAt, [row(undefined)])).toBeNull();
    });
});

const ROWS = readFileSync(path.resolve(import.meta.dir, '../../skills/tiktok/scripts/browser/studio-rows.js'), 'utf8');
const COMPOSE = readFileSync(path.resolve(import.meta.dir, '../../skills/tiktok/scripts/browser/compose.js'), 'utf8');
function runIn(script: string, url: string, html: string, ctx?: unknown) {
    const w = new Window({ url });
    if (ctx) (w as unknown as Record<string, unknown>).__Creator_Center_Context__ = ctx;
    w.document.body.innerHTML = html;
    const names = ['window', 'document', 'location', 'HTMLInputElement', 'HTMLTextAreaElement', 'InputEvent', 'Event'] as const;
    return new Function(...names, `return (${script.trim().replace(/;$/, '')})`)(w, w.document, w.location, w.HTMLInputElement, w.HTMLTextAreaElement, w.InputEvent, w.Event);
}

describe('finding 3: a caption cannot impersonate the privacy control', () => {
    test('caption "Only me" on a public row reads everyone', () => {
        const html = `<div data-tt="components_RowLayout_FlexRow"><span data-tt="components_PostInfoCell_TruncateText"><span>Only me</span></span><div><button><div>Everyone</div></button></div></div>`;
        const r = JSON.parse(runIn(ROWS, 'https://www.tiktok.com/tiktokstudio/content', html));
        expect(r.rows).toEqual([{ text: 'Only me', privacy: 'everyone', underReview: false }]);
    });
});

const EDITOR = (status: string) => `
  <div data-e2e="upload_status_container">${status}</div>
  <div data-e2e="caption_container"><div contenteditable="true">c</div></div>
  <div data-e2e="video_visibility_container"><button role="combobox" aria-expanded="false"><div>Only you</div></button></div>
  <div><span>Comment</span><input type="checkbox" checked></div><div><span>Reuse of content</span><input type="checkbox" checked></div>
  <div><span>Disclose post content</span><div role="switch" aria-checked="false"></div></div><div><span>AI-generated content</span><div role="switch" aria-checked="false"></div></div>
  <button data-e2e="post_video_button">Post</button>`;
const CTX = { commonAppContext: { user: { uniqueId: 'jdnichollsc' } } };
const UPLOAD = 'https://www.tiktok.com/tiktokstudio/upload';

describe('finding 4: the uploaded media is bound by name, not only by count', () => {
    test('compose.js reads the uploaded file names', () => {
        const s = runIn(COMPOSE, UPLOAD, EDITOR('<span>seam-story.mp4</span><span>1080P</span><span>Uploaded（8.74MB）</span>'), CTX);
        expect(s.fileNames).toEqual(['seam-story.mp4']);
    });
    test('another file with the same count is a mismatch; unreadable names too', () => {
        has(compareState(draft, page({ fileNames: ['other.mp4'] }), NOW), 'files');
        has(compareState(draft, page({ fileNames: undefined }), NOW), 'files');
    });
    test('a video with no record of the bytes handed to the page is a mismatch (a same-name file would pass)', () => {
        expect(compareState(draft, page(), NOW)).toEqual([]);
        has(compareState(draft, page({ uploads: undefined }), NOW), 'files');
        has(compareState(draft, page({ uploads: [{ sha256: 'b'.repeat(64), bytes: 1, dhash: null }] }), NOW), 'files');
    });
});

describe('finding 5: the page state is fresh, from the upload page, and the account comes from Studio itself', () => {
    test('stale or foreign snapshots are mismatches', () => {
        has(compareState(draft, page({ capturedAt: new Date(NOW - 10 * 60_000).toISOString() }), NOW), 'stale');
        has(compareState(draft, page({ capturedAt: undefined }), NOW), 'stale');
        has(compareState(draft, page({ url: 'https://evil.example/tiktokstudio/upload' }), NOW), 'url');
    });
    test('compose.js does not take the account from an arbitrary profile link', () => {
        const s = runIn(COMPOSE, UPLOAD, `<a href="https://www.tiktok.com/@jdnichollsc">x</a>${EDITOR('<span>a.mp4</span><span>Uploaded</span>')}`);
        expect(s.account).toBe('');
    });
});

describe('finding 9: a challenge on the page blocks', () => {
    test('compose.js reports a captcha and compareState refuses it', () => {
        const s = runIn(COMPOSE, UPLOAD, `${EDITOR('<span>a.mp4</span><span>Uploaded</span>')}<div id="captcha-verify-container"></div>`, CTX);
        expect(s.challenge).toBe(true);
        has(compareState(draft, page({ challenge: true }), NOW), 'challenge');
    });
});

describe('ledger findings', () => {
    let before: string | undefined;
    beforeEach(() => {
        before = process.env.TIKTOK_DATA_DIR;
        process.env.TIKTOK_DATA_DIR = mkdtempSync(path.join(os.tmpdir(), 'ttreview-'));
        process.env.TIKTOK_LOCK_WAIT_MS = '300';
    });
    afterEach(() => {
        process.env.TIKTOK_DATA_DIR = before;
        delete process.env.TIKTOK_LOCK_WAIT_MS;
    });
    const lockWith = (pid: number) => {
        const dir = resolvePendingDir();
        mkdirSync(path.join(dir, 'attempts'), { recursive: true });
        const lock = path.join(dir, 'publish.lock');
        writeFileSync(lock, JSON.stringify({ pid, token: 'other' }));
        const old = new Date(Date.now() - 120_000);
        utimesSync(lock, old, old);
    };
    test('finding 7: an old lock whose owner is alive is not stolen', async () => {
        lockWith(process.pid);
        await expect(beginAttempt({ account: 'jdnichollsc', digest: 'd' })).rejects.toThrow(expect.objectContaining({ kind: 'publish_busy' }));
    });
    test('finding 7: an old lock whose owner is gone is cleared', async () => {
        lockWith(2_147_000_000);
        await expect(beginAttempt({ account: 'jdnichollsc', digest: 'd' })).resolves.toMatchObject({ state: 'submitted' });
    });
    test('finding 8: a closed attempt cannot be reopened', async () => {
        const a = await beginAttempt({ account: 'jdnichollsc', digest: 'a' });
        await markOutcome(a.id, 'published');
        await beginAttempt({ account: 'jdnichollsc', digest: 'b' });
        await expect(markOutcome(a.id, 'unknown')).rejects.toThrow(/closed/);
    });
});

describe('CLI findings (6 and 9)', () => {
    const { spawnSync } = require('node:child_process') as typeof import('node:child_process');
    const MAIN = path.resolve(import.meta.dir, '../../skills/tiktok/scripts/main.ts');
    const TRAP = path.resolve(import.meta.dir, 'fetch-trap.ts');
    let dir: string;
    let env: NodeJS.ProcessEnv;
    beforeEach(() => {
        dir = mkdtempSync(path.join(os.tmpdir(), 'ttreviewcli-'));
        env = { ...process.env, TIKTOK_DATA_DIR: path.join(dir, 'data'), TIKTOK_ACCOUNT: 'jdnichollsc' };
    });
    const run = (args: string[]) => {
        if (args[1] === 'begin' && !args.includes('--baseline')) args = [...args, '--baseline', put('baseline.json', BASELINE())];
        const r = spawnSync(process.execPath, ['--preload', TRAP, MAIN, ...args], { env, encoding: 'utf8' });
        return JSON.parse(r.stdout || '{}');
    };
    const put = (name: string, v: unknown) => {
        const p = path.join(dir, name);
        writeFileSync(p, typeof v === 'string' ? v : JSON.stringify(v));
        return p;
    };
    // The CLI tests hand the page a one-byte file containing "v".
    const vUploads = [{ sha256: '4c94485e0c21ae6c41ce1dfe7b6bfaceea5ab68e40a2476f50208e526f506080', bytes: 1, dhash: null }];
    const fresh = (over: Partial<PageState> = {}) => page({ caption: 'c', fileNames: ['seam-story.mp4'], uploads: vUploads, capturedAt: new Date().toISOString(), ...over });
    test('finding 6: finish published/rejected needs --by-owner and records it', () => {
        const d = run(['publish', 'prepare', '--video', put('seam-story.mp4', 'v'), '--caption', 'c']).draft;
        const id = run(['publish', 'begin', '--draft', d.digest, '--approve', d.digest, '--page-state', put('ps.json', fresh())]).attempt.id;
        expect(run(['publish', 'finish', '--attempt', id, '--outcome', 'published']).error.message).toMatch(/by-owner/);
        expect(run(['publish', 'finish', '--attempt', id, '--outcome', 'published', '--by-owner']).attempt).toMatchObject({ state: 'published', detail: expect.stringContaining('owner') });
    });
    test('finding 9: a page state with a challenge writes the account signal', () => {
        const d = run(['publish', 'prepare', '--video', put('seam-story.mp4', 'v'), '--caption', 'c']).draft;
        const r = run(['publish', 'begin', '--draft', d.digest, '--approve', d.digest, '--page-state', put('ps.json', fresh({ challenge: true }))]);
        expect(r.error.kind).toBe('challenge');
        expect(run(['status']).signal).toMatchObject({ kind: 'challenge' });
    });
});

describe('verifier follow-ups', () => {
    test('an unread toggle is null in state(), so it mismatches even without the unread list', () => {
        const html = EDITOR('<span>a.mp4</span><span>Uploaded</span>').replace('<div><span>AI-generated content</span><div role="switch" aria-checked="false"></div></div>', '');
        const s = runIn(COMPOSE, UPLOAD, html, CTX);
        expect(s.aiGenerated).toBeNull();
        const { unread: _u, ...rest } = { ...page(), aiGenerated: null } as unknown as PageState;
        has(compareState(draft, rest as PageState, NOW), 'aiGenerated');
    });
    test('studio-rows takes the account only from the app context, not from a profile link', () => {
        const r = JSON.parse(runIn(ROWS, 'https://www.tiktok.com/tiktokstudio/content', '<a href="/@someone">x</a>'));
        expect(r.account).toBe('');
    });
    test('a privacy label that also holds an icon element is still read', () => {
        const html = `<div data-tt="components_RowLayout_FlexRow"><span data-tt="components_PostInfoCell_TruncateText"><span>hi</span></span><button><div>Only me<svg></svg></div></button></div>`;
        expect(JSON.parse(runIn(ROWS, 'https://www.tiktok.com/tiktokstudio/content', html)).rows[0].privacy).toBe('only_me');
    });
    test('only the upload page counts; a hidden captcha script does not raise a challenge', () => {
        has(compareState(draft, page({ url: 'https://www.tiktok.com/tiktokstudio/uploadX' }), NOW), 'url');
        const s = runIn(COMPOSE, UPLOAD, `${EDITOR('<span>a.mp4</span><span>Uploaded</span>')}<iframe src="https://x.example/verify-email"></iframe><div class="captcha-sdk-loader" hidden></div>`, CTX);
        expect(s.challenge).toBe(false);
    });
});

describe('experimental gate (design §4: first live write of each type needs --experimental)', () => {
    const { spawnSync } = require('node:child_process') as typeof import('node:child_process');
    const MAIN = path.resolve(import.meta.dir, '../../skills/tiktok/scripts/main.ts');
    const TRAP = path.resolve(import.meta.dir, 'fetch-trap.ts');
    let dir: string;
    let env: NodeJS.ProcessEnv;
    beforeEach(() => {
        dir = mkdtempSync(path.join(os.tmpdir(), 'ttexp-'));
        env = { ...process.env, TIKTOK_DATA_DIR: path.join(dir, 'data'), TIKTOK_ACCOUNT: 'jdnichollsc' };
    });
    const run = (args: string[]) => {
        if (args[1] === 'begin' && !args.includes('--baseline')) args = [...args, '--baseline', put('baseline.json', BASELINE())];
        return JSON.parse(spawnSync(process.execPath, ['--preload', TRAP, MAIN, ...args], { env, encoding: 'utf8' }).stdout || '{}');
    };
    const put = (name: string, v: unknown) => {
        const p = path.join(dir, name);
        writeFileSync(p, typeof v === 'string' ? v : JSON.stringify(v));
        return p;
    };
    test('prepare lists the unverified variants; begin refuses them without --experimental', () => {
        const p = run(['publish', 'prepare', '--photos', `${put('a.jpg', 'a')},${put('b.jpg', 'b')}`, '--title', 'T', '--description', 'D', '--ai-generated']);
        expect(p.experimental).toEqual(['ai-label']);
        const d = p.draft;
        const state = put('ps.json', { ...page({ kind: 'photo', title: 'T', description: 'D', files: 2, fileNames: undefined, uploads: [{ sha256: 'ca978112ca1bbdcafac231b39a23dc4da786eff8147c4e72b9807785afee48bb', bytes: 1, dhash: '0'.repeat(64) }, { sha256: '3e23e816 0039594a33894f6564e1b1348bbd7a0088d42c4acb73eeaed59c009d', bytes: 1, dhash: 'f'.repeat(64) }], thumbs: [{ dhash: '0'.repeat(64) }, { dhash: 'f'.repeat(64) }], aiGenerated: true, capturedAt: new Date().toISOString() }), caption: undefined });
        expect(run(['publish', 'begin', '--draft', d.digest, '--approve', d.digest, '--page-state', state]).error.message).toMatch(/(ai-label).*--experimental/);
        expect(run(['publish', 'begin', '--draft', d.digest, '--approve', d.digest, '--page-state', state, '--experimental']).attempt).toMatchObject({ state: 'submitted', detail: expect.stringContaining('experimental: ai-label') });
    });
    test('the verified private photo carousel needs no flag', () => {
        const p = run(['publish', 'prepare', '--photos', `${put('a.jpg', 'a')},${put('b.jpg', 'b')}`, '--title', 'T', '--description', 'D']);
        expect(p.experimental).toEqual([]);
    });
    test('the verified private video needs no flag', () => {
        const p = run(['publish', 'prepare', '--video', put('seam-story.mp4', 'v'), '--caption', 'c']);
        expect(p.experimental).toEqual([]);
        const state = put('ps.json', page({ caption: 'c', uploads: [{ sha256: '4c94485e0c21ae6c41ce1dfe7b6bfaceea5ab68e40a2476f50208e526f506080', bytes: 1, dhash: null }], capturedAt: new Date().toISOString() }));
        expect(run(['publish', 'begin', '--draft', p.draft.digest, '--approve', p.draft.digest, '--page-state', state]).attempt.state).toBe('submitted');
    });
    test('public, AI label and disclosure are each unverified', () => {
        const p = run(['publish', 'prepare', '--video', put('v.mp4', 'v'), '--caption', 'c', '--privacy', 'everyone', '--public', '--ai-generated', '--disclose']);
        expect(p.experimental).toEqual(['non-private', 'ai-label', 'disclosure']);
    });
});

describe('photo binding: exact bytes handed to the page + visual fingerprint per thumbnail', () => {
    const photoDraft = {
        account: 'jdnichollsc',
        media: [
            { path: 'C:/x/seam-1.jpg', sha256: 'a'.repeat(64), bytes: 10, manualFilePick: false },
            { path: 'C:/x/seam-2.jpg', sha256: 'b'.repeat(64), bytes: 20, manualFilePick: false },
        ],
        settings: { kind: 'photo', title: 'T', description: 'D', privacy: 'only_me', allowComments: true, allowReuse: true, aiGenerated: false, discloseContent: false },
    } as Draft;
    const H1 = '0'.repeat(64);
    const H2 = 'f'.repeat(64);
    const near = (h: string) => `${h.slice(0, 62)}${h[62] === '0' ? '01' : 'fe'}`; // a few bits off
    const photoPage = (over: Partial<PageState> = {}) =>
        page({ kind: 'photo', caption: undefined, title: 'T', description: 'D', files: 2, fileNames: undefined, uploads: [{ sha256: 'a'.repeat(64), bytes: 10, dhash: H1 }, { sha256: 'b'.repeat(64), bytes: 20, dhash: H2 }], thumbs: [{ dhash: near(H1) }, { dhash: near(H2) }], ...over });
    test('matching bytes and thumbnails in order pass, with no file names on the page', () => {
        expect(compareState(photoDraft, photoPage(), NOW)).toEqual([]);
    });
    test('a different file handed to the page is a mismatch', () => {
        has(compareState(photoDraft, photoPage({ uploads: [{ sha256: 'c'.repeat(64), bytes: 10, dhash: H1 }, { sha256: 'b'.repeat(64), bytes: 20, dhash: H2 }] }), NOW), 'files');
    });
    test('no recorded uploads (compose.js armed too late) is a mismatch', () => {
        has(compareState(photoDraft, photoPage({ uploads: undefined }), NOW), 'files');
    });
    test('swapped thumbnails are a mismatch', () => {
        has(compareState(photoDraft, photoPage({ thumbs: [{ dhash: near(H2) }, { dhash: near(H1) }] }), NOW), 'order');
    });
    test('a thumbnail that matches no upload, or an unreadable one, is a mismatch', () => {
        const far = '0f'.repeat(32);
        has(compareState(photoDraft, photoPage({ thumbs: [{ dhash: far }, { dhash: near(H2) }] }), NOW), 'order');
        has(compareState(photoDraft, photoPage({ thumbs: [{ dhash: null }, { dhash: near(H2) }] }), NOW), 'order');
    });
    test('compose.js records the files handed to a file input, in order, with their sha256', async () => {
        const w = new Window({ url: 'https://www.tiktok.com/tiktokstudio/upload?tab=photo' });
        (w as unknown as Record<string, unknown>).__Creator_Center_Context__ = CTX;
        w.document.body.innerHTML = '<input type="file" multiple>';
        const names = ['window', 'document', 'location', 'HTMLInputElement', 'HTMLTextAreaElement', 'InputEvent', 'Event'] as const;
        new Function(...names, `return (${COMPOSE.trim().replace(/;$/, '')})`)(w, w.document, w.location, w.HTMLInputElement, w.HTMLTextAreaElement, w.InputEvent, w.Event);
        const input = w.document.querySelector('input')!;
        const files = [new w.File(['hello'], 'seam-1.jpg'), new w.File(['world!'], 'seam-2.jpg')];
        Object.defineProperty(input, 'files', { value: files, configurable: true });
        input.dispatchEvent(new w.Event('change', { bubbles: true }));
        const up = await (w as unknown as { __ttCompose: { uploads(): Promise<unknown[]> } }).__ttCompose.uploads();
        expect(up).toEqual([
            { name: 'seam-1.jpg', bytes: 5, sha256: '2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824', dhash: null },
            { name: 'seam-2.jpg', bytes: 6, sha256: '711e9609339e92b03ddc0a211827dba421f38f9ed8b9d806e1ffdd8c15ffa03d', dhash: null },
        ]);
    });
});

test('compose.js registers its upload listener even if the records array already exists (seen live)', async () => {
    const w = new Window({ url: 'https://www.tiktok.com/tiktokstudio/upload?tab=photo' });
    (w as unknown as Record<string, unknown>).__Creator_Center_Context__ = CTX;
    (w as unknown as Record<string, unknown>).__ttUploadRecords = [];
    w.document.body.innerHTML = '<input type="file" multiple>';
    const names = ['window', 'document', 'location', 'HTMLInputElement', 'HTMLTextAreaElement', 'InputEvent', 'Event'] as const;
    new Function(...names, `return (${COMPOSE.trim().replace(/;$/, '')})`)(w, w.document, w.location, w.HTMLInputElement, w.HTMLTextAreaElement, w.InputEvent, w.Event);
    const input = w.document.querySelector('input')!;
    Object.defineProperty(input, 'files', { value: [new w.File(['hello'], 'seam-1.jpg')], configurable: true });
    input.dispatchEvent(new w.Event('change', { bubbles: true }));
    const up = await (w as unknown as { __ttCompose: { uploads(): Promise<unknown[]> } }).__ttCompose.uploads();
    expect(up.length).toBe(1);
});

test('photo description is written with a textInput event, never execCommand (seen live: execCommand crashes the photo editor)', async () => {
    const w = new Window({ url: 'https://www.tiktok.com/tiktokstudio/upload/post/photo' });
    (w as unknown as Record<string, unknown>).__Creator_Center_Context__ = CTX;
    w.document.body.innerHTML = `<div data-e2e="caption_container"><input maxlength="90"><div contenteditable="true" class="public-DraftEditor-content"><div data-contents="true"><div data-block="true" data-offset-key="a-0-0"><div data-offset-key="a-0-0"><span data-offset-key="a-0-0"><br data-text="true"></span></div></div></div></div></div>`;
    const doc = w.document as unknown as { execCommand: unknown; createEvent: unknown };
    let execCalls = 0;
    doc.execCommand = () => {
        execCalls++;
        return true;
    };
    doc.createEvent = (t: string) => {
        if (t !== 'TextEvent') throw new Error('unexpected');
        const e = new w.Event('textInput', { bubbles: true, cancelable: true }) as unknown as Record<string, unknown>;
        e.initTextEvent = (_type: string, _b: boolean, _c: boolean, _v: unknown, data: string) => (e.data = data);
        return e;
    };
    const ed = w.document.querySelector('[contenteditable]')!;
    ed.addEventListener('textInput', (e) => {
        (ed.querySelector('span[data-offset-key]') as unknown as { innerHTML: string }).innerHTML = `<span data-text="true">${(e as unknown as { data: string }).data}</span>`;
        e.preventDefault();
    });
    const names = ['window', 'document', 'location', 'HTMLInputElement', 'HTMLTextAreaElement', 'InputEvent', 'Event'] as const;
    new Function(...names, `return (${COMPOSE.trim().replace(/;$/, '')})`)(w, w.document, w.location, w.HTMLInputElement, w.HTMLTextAreaElement, w.InputEvent, w.Event);
    const api = (w as unknown as { __ttCompose: { fill(s: unknown): Promise<unknown>; state(): { description: string } } }).__ttCompose;
    await api.fill({ kind: 'photo', title: 'T', description: 'private carousel test', privacy: 'only_me' }).catch(() => {});
    expect(execCalls).toBe(0);
    expect(api.state().description).toBe('private carousel test');
});

test('a photo row is matched by its description (seen live: Studio lists a photo post by its description, not its title)', () => {
    const d = { settings: { kind: 'photo', title: 'publish test (plugin), photos', description: 'private carousel test', privacy: 'only_me' } } as Pick<Draft, 'settings'>;
    const start = new Date(2026, 10, 16, 12, 59, 6).toISOString();
    const row = { text: 'private carousel test', privacy: 'only_me' as const, underReview: false, time: 'Nov 16, 12:59 PM' };
    expect(matchRow(d, start, [row])).toEqual(row);
    // the title alone is not what Studio shows
    expect(matchRow(d, start, [{ ...row, text: 'publish test (plugin), photos' }])).toBeNull();
    // under review rows carry no time yet: never matched
    expect(matchRow(d, start, [{ text: 'private carousel test', privacy: 'only_me' as const, underReview: true }])).toBeNull();
});
