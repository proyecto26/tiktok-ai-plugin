// Regressions for review 4 (codex, safety focus, 2026-11-16) and the live checks that followed it.
import { beforeEach, describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Window } from 'happy-dom';

import type { Draft } from '../../skills/tiktok/scripts/publish/draft.ts';
import { checkBaseline, compareState, type PageState, type Row } from '../../skills/tiktok/scripts/publish/reconcile.ts';

const COMPOSE = readFileSync(path.resolve(import.meta.dir, '../../skills/tiktok/scripts/browser/compose.js'), 'utf8');
const ROWS_JS = readFileSync(path.resolve(import.meta.dir, '../../skills/tiktok/scripts/browser/studio-rows.js'), 'utf8');
const CTX = { commonAppContext: { user: { uniqueId: 'jdnichollsc' } } };
const NAMES = ['window', 'document', 'location', 'HTMLInputElement', 'HTMLTextAreaElement', 'InputEvent', 'Event'] as const;
function install(html: string, url = 'https://www.tiktok.com/tiktokstudio/upload') {
    const w = new Window({ url });
    (w as unknown as Record<string, unknown>).__Creator_Center_Context__ = CTX;
    w.document.body.innerHTML = html;
    const res = new Function(...NAMES, `return (${COMPOSE.trim().replace(/;$/, '')})`)(w, w.document, w.location, w.HTMLInputElement, w.HTMLTextAreaElement, w.InputEvent, w.Event);
    return { w, res, api: (w as unknown as { __ttCompose: { state(): Record<string, unknown> } }).__ttCompose };
}
const editor = (privacy: string, extra = '') => `
  <div data-e2e="caption_container"><div contenteditable="true">c</div></div>
  <div data-e2e="video_visibility_container"><span>Who can see this post</span>${privacy}</div>
  <div><span>Comment</span><input type="checkbox" checked></div>
  <div><span>Reuse of content</span><input type="checkbox" checked></div>
  <div><span>Disclose post content</span><input type="checkbox" role="switch"></div>
  <div><span>AI-generated content</span><input type="checkbox" role="switch"></div>${extra}`;

describe('privacy is read from the combobox itself (codex H2)', () => {
    test('an option inside the container does not count as the selection', () => {
        const { api } = install(editor('<button role="combobox" aria-expanded="false">Everyone</button><div role="listbox"><div role="option">Only you</div></div>'));
        expect(api.state().privacy).toBe('everyone');
    });
    test('an open combobox reads unknown', () => {
        const { api } = install(editor('<button role="combobox" aria-expanded="true">Only you</button>'));
        expect(api.state().privacy).toBe('unknown');
    });
    test('no combobox reads unknown, even if the container mentions a privacy', () => {
        const { api } = install(editor('<div>Only you</div>'));
        expect(api.state().privacy).toBe('unknown');
    });
    test('live shape (2026-11-16): button text is the selected label', () => {
        expect(install(editor('<button role="combobox" aria-expanded="false"><div>Only you</div></button>')).api.state().privacy).toBe('only_me');
        expect(install(editor('<button role="combobox" aria-expanded="false"><div>Friends</div></button>')).api.state().privacy).toBe('friends');
    });
});

describe('toggles: a control whose state cannot be read is null and unread (codex M)', () => {
    test('live shape: input checkboxes (two with role=switch and no aria-checked) read their checked property', () => {
        const s = install(editor('<button role="combobox" aria-expanded="false">Only you</button>')).api.state();
        expect([s.allowComments, s.allowReuse, s.discloseContent, s.aiGenerated]).toEqual([true, true, false, false]);
        expect(s.unread).toBeUndefined();
    });
    test('a non-input switch without aria-checked is null and listed as unread', () => {
        const html = editor('<button role="combobox" aria-expanded="false">Only you</button>').replace('<input type="checkbox" role="switch"></div>\n  <div><span>AI', '<div role="switch"></div></div>\n  <div><span>AI');
        const s = install(html).api.state();
        expect(s.discloseContent).toBeNull();
        expect(s.unread).toEqual(['discloseContent']);
    });
});

describe('location is part of the page state (seen live: a stray click set one)', () => {
    test('a chosen location is read, and begin refuses it (the draft never has one)', () => {
        const s = install(editor('<button role="combobox" aria-expanded="false">Only you</button>', '<div data-e2e="poi_container"><input value="Some Place"></div>')).api.state();
        expect(s.location).toBe('Some Place');
        const d = { account: 'jdnichollsc', media: [{ path: 'clip.mp4', sha256: 'a'.repeat(64), bytes: 1, manualFilePick: false }], settings: { kind: 'video', caption: 'c', privacy: 'only_me', allowComments: true, allowReuse: true, aiGenerated: false, discloseContent: false } } as Draft;
        const page = { schema: 'tt-pagestate-v1', url: 'https://www.tiktok.com/tiktokstudio/upload', capturedAt: new Date().toISOString(), account: 'jdnichollsc', kind: 'video', caption: 'c', privacy: 'only_me', allowComments: true, allowReuse: true, aiGenerated: false, discloseContent: false, files: 1, fileNames: ['clip.mp4'], location: '', ready: true } as PageState;
        expect(compareState(d, page)).toEqual([]);
        expect(compareState(d, { ...page, location: 'Some Place' }).join(' ')).toMatch(/location/);
        expect(compareState(d, { ...page, location: undefined }).join(' ')).toMatch(/location/);
    });
    test('an empty location input reads as no location', () => {
        const s = install(editor('<button role="combobox" aria-expanded="false">Only you</button>', '<div data-e2e="poi_container"><input value=""></div>')).api.state();
        expect(s.location).toBe('');
    });
});

describe('a Studio baseline read before begin keeps an older same-text post from settling the attempt (codex H1)', () => {
    const d = { account: 'jdnichollsc', settings: { kind: 'video', caption: 'same caption', privacy: 'only_me' } } as Pick<Draft, 'account' | 'settings'>;
    const at = new Date(2026, 10, 16, 12, 59, 30).getTime();
    const rows = (r: Row[], over: Record<string, unknown> = {}) => ({ schema: 'tt-rows-v1' as const, account: 'jdnichollsc', capturedAt: new Date(at).toISOString(), rows: r, ...over });
    const row = (time?: string, text = 'same caption'): Row => ({ text, privacy: 'only_me', underReview: !time, time });
    test('the reproduced case: same text dated in the baseline minute is refused', () => {
        expect(checkBaseline(d, rows([row('Nov 16, 12:59 PM')]), at).join(' ')).toMatch(/baseline: Studio already lists/);
    });
    test('same text under review (no date yet) is refused', () => {
        expect(checkBaseline(d, rows([row(undefined)]), at).join(' ')).toMatch(/under review/);
    });
    test('same text from an earlier minute, or other text, is fine', () => {
        expect(checkBaseline(d, rows([row('Nov 16, 12:58 PM'), row(undefined, 'other post'), row('Nov 16, 12:59 PM', 'other post')]), at)).toEqual([]);
    });
    test('stale, future, undated, wrong-account or wrong-schema baselines are refused', () => {
        expect(checkBaseline(d, rows([], { capturedAt: new Date(at - 6 * 60_000).toISOString() }), at).join(' ')).toMatch(/stale/);
        expect(checkBaseline(d, rows([], { capturedAt: new Date(at + 2 * 60_000).toISOString() }), at).join(' ')).toMatch(/stale/);
        expect(checkBaseline(d, rows([], { capturedAt: undefined }), at).join(' ')).toMatch(/stale/);
        expect(checkBaseline(d, rows([], { account: 'other' }), at).join(' ')).toMatch(/@other/);
        expect(checkBaseline(d, undefined, at).join(' ')).toMatch(/tt-rows-v1/);
        // an unloaded list reads as zero rows: never proof that no same-text post exists (codex round 2)
        expect(checkBaseline(d, rows([]), at).join(' ')).toMatch(/no rows/);
    });
    test('photos are compared by description (what Studio lists)', () => {
        const p = { account: 'jdnichollsc', settings: { kind: 'photo', title: 'T', description: 'private carousel test', privacy: 'only_me' } } as Pick<Draft, 'account' | 'settings'>;
        expect(checkBaseline(p, rows([row(undefined, 'private carousel test')]), at)).not.toEqual([]);
    });
});

describe('begin requires the baseline (codex H1)', () => {
    const MAIN = path.resolve(import.meta.dir, '../../skills/tiktok/scripts/main.ts');
    const TRAP = path.resolve(import.meta.dir, 'fetch-trap.ts');
    let dir: string;
    let env: NodeJS.ProcessEnv;
    beforeEach(() => {
        dir = mkdtempSync(path.join(os.tmpdir(), 'ttbase-'));
        env = { ...process.env, TIKTOK_DATA_DIR: path.join(dir, 'data'), TIKTOK_ACCOUNT: 'jdnichollsc' };
    });
    const run = (args: string[]) => JSON.parse(spawnSync(process.execPath, ['--preload', TRAP, MAIN, ...args], { env, encoding: 'utf8' }).stdout || '{}');
    const put = (name: string, v: unknown) => {
        const p = path.join(dir, name);
        writeFileSync(p, JSON.stringify(v));
        return p;
    };
    const state = () => ({ schema: 'tt-pagestate-v1', url: 'https://www.tiktok.com/tiktokstudio/upload', capturedAt: new Date().toISOString(), account: 'jdnichollsc', kind: 'video', caption: 'c', privacy: 'only_me', allowComments: true, allowReuse: true, aiGenerated: false, discloseContent: false, files: 1, fileNames: ['clip.mp4'], location: '', ready: true });
    test('no baseline, or a clashing one, is refused before any attempt; a clean one records the attempt', () => {
        writeFileSync(path.join(dir, 'clip.mp4'), 'v');
        const dg = run(['publish', 'prepare', '--video', path.join(dir, 'clip.mp4'), '--caption', 'c']).draft.digest as string;
        const begin = (extra: string[]) => run(['publish', 'begin', '--draft', dg, '--approve', dg, '--page-state', put('ps.json', state()), ...extra]);
        expect(begin([]).error.message).toMatch(/--baseline/);
        const fresh = (r: Row[]) => put('b.json', { schema: 'tt-rows-v1', account: 'jdnichollsc', capturedAt: new Date().toISOString(), rows: r });
        expect(begin(['--baseline', fresh([{ text: 'c', privacy: 'only_me', underReview: true }])]).error.message).toMatch(/under review/);
        expect(run(['publish', 'status']).open).toEqual([]);
        expect(begin(['--baseline', fresh([{ text: 'older post', privacy: 'only_me', underReview: false, time: 'Nov 1, 9:00 AM' }])]).attempt.state).toBe('submitted');
    });
});

test('studio-rows.js stamps capturedAt', () => {
    const w = new Window({ url: 'https://www.tiktok.com/tiktokstudio/content' });
    (w as unknown as Record<string, unknown>).__Creator_Center_Context__ = CTX;
    const out = JSON.parse(new Function('window', 'document', 'location', `return (${ROWS_JS.trim().replace(/;$/, '')})`)(w, w.document, w.location));
    expect(Number.isFinite(Date.parse(out.capturedAt))).toBe(true);
});
