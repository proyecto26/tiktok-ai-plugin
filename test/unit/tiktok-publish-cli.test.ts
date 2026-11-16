import { beforeEach, describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { compareState, matchRow, type PageState } from '../../skills/tiktok/scripts/publish/reconcile.ts';
import type { Draft } from '../../skills/tiktok/scripts/publish/draft.ts';

const MAIN = path.resolve(import.meta.dir, '../../skills/tiktok/scripts/main.ts');
const TRAP = path.resolve(import.meta.dir, 'fetch-trap.ts');
let env: NodeJS.ProcessEnv;
let dir: string;
beforeEach(() => {
    dir = mkdtempSync(path.join(os.tmpdir(), 'ttpub-'));
    env = { ...process.env, TIKTOK_DATA_DIR: path.join(dir, 'data'), TIKTOK_ACCOUNT: 'jdnichollsc' };
});
const run = (args: string[]) => {
    const r = spawnSync(process.execPath, ['--preload', TRAP, MAIN, ...args], { env, encoding: 'utf8' });
    let json: Record<string, any> = {};
    try {
        json = JSON.parse(r.stdout);
    } catch {
        // not JSON
    }
    return { status: r.status, json, stderr: r.stderr };
};
const put = (name: string, v: unknown) => {
    const p = path.join(dir, name);
    writeFileSync(p, typeof v === 'string' ? v : JSON.stringify(v));
    return p;
};
const pageState = (over: Partial<PageState> = {}): PageState => ({
    schema: 'tt-pagestate-v1',
    url: 'https://www.tiktok.com/tiktokstudio/upload',
    account: 'jdnichollsc',
    kind: 'video',
    caption: 'seam test',
    privacy: 'only_me',
    allowComments: true,
    allowReuse: true,
    aiGenerated: false,
    discloseContent: false,
    files: 1,
    ready: true,
    ...over,
});
const prepare = () => run(['publish', 'prepare', '--video', put('clip.mp4', 'video-bytes'), '--caption', 'seam test']);

describe('publish CLI', () => {
    test('prepare is a dry run that prints the draft with privacy only_me by default', () => {
        const r = prepare();
        expect(r.status).toBe(0);
        expect(r.json).toMatchObject({ dryRun: true, draft: { schema: 'tt.draft.v1', account: 'jdnichollsc', settings: { kind: 'video', caption: 'seam test', privacy: 'only_me', allowComments: true, allowReuse: true, aiGenerated: false, discloseContent: false } } });
        expect(r.json.draft.digest).toMatch(/^[0-9a-f]{64}$/);
    });
    test('photo prepare takes title, description and toggles', () => {
        const r = run(['publish', 'prepare', '--photos', `${put('a.jpg', 'a')},${put('b.png', 'b')}`, '--title', 'T', '--description', 'D', '--no-comments', '--no-reuse', '--ai-generated', '--disclose', '--privacy', 'friends']);
        expect(r.status).toBe(0);
        expect(r.json.draft.settings).toMatchObject({ kind: 'photo', title: 'T', description: 'D', privacy: 'friends', allowComments: false, allowReuse: false, aiGenerated: true, discloseContent: true });
        expect(r.json.draft.media).toHaveLength(2);
    });
    test('happy path: begin → finish published; status shows it closed', () => {
        const d = prepare().json.draft;
        const b = run(['publish', 'begin', '--draft', d.digest, '--approve', d.digest, '--page-state', put('ps.json', pageState())]);
        expect(b.status).toBe(0);
        expect(b.json.attempt).toMatchObject({ state: 'submitted', digest: d.digest });
        const again = run(['publish', 'begin', '--draft', d.digest, '--approve', d.digest, '--page-state', put('ps2.json', pageState())]);
        expect(again.json.error.kind).toBe('publish_busy');
        const f = run(['publish', 'finish', '--attempt', b.json.attempt.id, '--outcome', 'published', '--post-id', '7']);
        expect(f.json.attempt).toMatchObject({ state: 'published', postId: '7' });
        const s = run(['publish', 'status']);
        expect(s.json).toMatchObject({ open: [], recent: [{ id: b.json.attempt.id, state: 'published' }] });
    });
    test('a wrong approval digest is refused', () => {
        const d = prepare().json.draft;
        const b = run(['publish', 'begin', '--draft', d.digest, '--approve', 'f'.repeat(64), '--page-state', put('ps.json', pageState())]);
        expect(b.status).toBe(1);
        expect(b.json.error.kind).toBe('approval_mismatch');
    });
    test('page state that differs from the draft → page_mismatch naming the fields; no attempt written', () => {
        const d = prepare().json.draft;
        const b = run(['publish', 'begin', '--draft', d.digest, '--approve', d.digest, '--page-state', put('ps.json', pageState({ privacy: 'everyone', account: 'other' }))]);
        expect(b.json.error.kind).toBe('page_mismatch');
        expect(b.json.error.message).toContain('privacy');
        expect(b.json.error.message).toContain('account');
        expect(run(['publish', 'status']).json.open).toEqual([]);
    });
    test('an account signal blocks begin', () => {
        const d = prepare().json.draft;
        put('sig.json', '');
        const sig = path.join(env.TIKTOK_DATA_DIR as string, 'signal.json');
        require('node:fs').writeFileSync(sig, JSON.stringify({ kind: 'challenge', detail: 'x', at: 'now' }));
        const b = run(['publish', 'begin', '--draft', d.digest, '--approve', d.digest, '--page-state', put('ps.json', pageState())]);
        expect(b.json.error.kind).toBe('blocked_by_signal');
    });
    test('reconcile: under review → processing; then Only me row → published', () => {
        const d = prepare().json.draft;
        const id = run(['publish', 'begin', '--draft', d.digest, '--approve', d.digest, '--page-state', put('ps.json', pageState())]).json.attempt.id;
        const rows = (underReview: boolean, privacy = 'only_me') => put(`rows-${underReview}-${privacy}.json`, { schema: 'tt-rows-v1', account: 'jdnichollsc', rows: [{ text: 'older post', privacy: 'everyone', underReview: false }, { text: 'seam test', privacy, underReview }] });
        expect(run(['publish', 'reconcile', '--attempt', id, '--rows', rows(true)]).json.attempt.state).toBe('processing');
        expect(run(['publish', 'reconcile', '--attempt', id, '--rows', rows(false)]).json.attempt.state).toBe('published');
    });
    test('reconcile: a privacy that differs stays unknown (never re-post)', () => {
        const d = prepare().json.draft;
        const id = run(['publish', 'begin', '--draft', d.digest, '--approve', d.digest, '--page-state', put('ps.json', pageState())]).json.attempt.id;
        const rows = put('rows.json', { schema: 'tt-rows-v1', account: 'jdnichollsc', rows: [{ text: 'seam test', privacy: 'everyone', underReview: false }] });
        const r = run(['publish', 'reconcile', '--attempt', id, '--rows', rows]);
        expect(r.json.attempt).toMatchObject({ state: 'unknown', detail: expect.stringContaining('privacy_mismatch') });
    });
});

describe('compareState and matchRow', () => {
    const draft = { account: 'jdnichollsc', media: [{ path: 'x', sha256: 'h', bytes: 1, manualFilePick: false }], settings: { kind: 'video', caption: 'Hello  world ', privacy: 'only_me', allowComments: true, allowReuse: true, aiGenerated: false, discloseContent: false } } as Draft;
    test('whitespace differences in the caption are not a mismatch; a page not ready is', () => {
        expect(compareState(draft, pageState({ caption: 'Hello world' }))).toEqual([]);
        expect(compareState(draft, pageState({ caption: 'Hello world', ready: false, files: 2 }))).toEqual(expect.arrayContaining([expect.stringContaining('ready'), expect.stringContaining('files')]));
    });
    test('a draft with no text cannot be matched to a row', () => {
        const empty = { ...draft, settings: { ...draft.settings, caption: '' } } as Draft;
        expect(matchRow(empty, [{ text: '', privacy: 'only_me', underReview: false }])).toBeNull();
    });
    test('a truncated row text matches the start of the caption', () => {
        const long = { ...draft, settings: { ...draft.settings, caption: `${'a'.repeat(100)} end` } } as Draft;
        expect(matchRow(long, [{ text: `${'a'.repeat(60)}...`, privacy: 'only_me', underReview: false }])).not.toBeNull();
    });
});
