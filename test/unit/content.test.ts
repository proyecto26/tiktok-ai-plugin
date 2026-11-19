// tiktok-content: the TikTok rules of the caption linter, the hook triple, upstream headers and asset paths.
import { describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { HASHTAG_WARN_ABOVE, PHOTO_DESCRIPTION_MAX, PHOTO_TITLE_MAX, TIKTOK_CAPTION_MAX, TRUNCATE, analyseCaption, analysePhoto } from '../../skills/tiktok-content/scripts/caption-lint.ts';
import { scoreTriple } from '../../skills/tiktok-content/scripts/hook-score.ts';

const SCRIPTS = path.resolve(import.meta.dir, '../../skills/tiktok-content/scripts');
const check = (a: { checks: { check: string; status: string }[] }, name: string) => a.checks.find((c) => c.check === name)?.status;

describe('caption-lint, TikTok rules', () => {
    test('limits are TikTok values', () => {
        expect(TIKTOK_CAPTION_MAX).toBe(2200);
        expect(TRUNCATE).toBe(80);
        expect(HASHTAG_WARN_ABOVE).toBe(8);
        expect(PHOTO_TITLE_MAX).toBe(90);
        expect(PHOTO_DESCRIPTION_MAX).toBe(4000);
    });
    test('TIKTOK_CAPTION_MAX changes the lint limit, as it does for publish prepare', () => {
        const saved = process.env.TIKTOK_CAPTION_MAX;
        try {
            process.env.TIKTOK_CAPTION_MAX = '100';
            expect(check(analyseCaption('x'.repeat(101)), 'LENGTH')).toBe('FAIL');
            expect(check(analyseCaption('x'.repeat(100)), 'LENGTH')).toBe('PASS');
            process.env.TIKTOK_CAPTION_MAX = 'nonsense';
            expect(check(analyseCaption('x'.repeat(2200)), 'LENGTH')).toBe('PASS');
        } finally {
            if (saved === undefined) delete process.env.TIKTOK_CAPTION_MAX;
            else process.env.TIKTOK_CAPTION_MAX = saved;
        }
    });
    test('a 2,150-char body plus 60 chars of hashtags fails on the total (Review Focus 5)', () => {
        const body = 'We tested 3 hooks on 12 videos. ' + 'x'.repeat(2150 - 32);
        const tags = ' ' + Array.from({ length: 6 }, (_, i) => `#tagword${i}`).join(' ').padEnd(59, 'z');
        const a = analyseCaption(body + '\n\n' + tags.trim());
        expect(a.characters).toBeGreaterThan(2200);
        expect(check(a, 'LENGTH')).toBe('FAIL');
        expect(a.verdict).toBe('FIX');
        expect(analyseCaption(body).characters).toBeLessThanOrEqual(2200);
        expect(check(analyseCaption(body), 'LENGTH')).toBe('PASS');
    });
    test('9 hashtags is a warning, not an error; 8 passes', () => {
        const tags = (n: number) => Array.from({ length: n }, (_, i) => `#topic${i}`).join(' ');
        const nine = analyseCaption(`We closed 3 clients in 14 days.\n\nSave this.\n\n${tags(9)}`);
        expect(check(nine, 'HASHTAGS')).toBe('WARN');
        expect(nine.checks.every((c) => c.status !== 'FAIL')).toBe(true);
        expect(check(analyseCaption(`We closed 3 clients in 14 days.\n\nSave this.\n\n${tags(8)}`), 'HASHTAGS')).toBe('PASS');
    });
    test('the first line folds at 80 characters', () => {
        const long = 'We closed 3 clients in 14 days and here is exactly how the whole process worked for us';
        expect(long.length).toBeGreaterThan(80);
        expect(check(analyseCaption(long), 'FIRST LINE')).toBe('WARN');
        expect(check(analyseCaption('We closed 3 clients in 14 days.'), 'FIRST LINE')).toBe('PASS');
    });
    test('photo post: title over 90 fails; description has its own 4000 limit', () => {
        const ok = analysePhoto('3 ways to pack light', 'We packed for 14 days in one bag.\n\nSave this.');
        expect(check(ok, 'TITLE')).toBe('PASS');
        expect(check(analysePhoto('t'.repeat(91), 'Short.'), 'TITLE')).toBe('FAIL');
        expect(check(analysePhoto('Title', 'We packed 14 days. ' + 'y'.repeat(3000)), 'LENGTH')).toBe('PASS');
        const over = analysePhoto('Title', 'We packed 14 days. ' + 'y'.repeat(4000));
        expect(check(over, 'LENGTH')).toBe('FAIL');
        expect(over.limit).toBe(4000);
    });
    test('CLI: --kind photo needs --title', () => {
        const d = mkdtempSync(path.join(os.tmpdir(), 'tt-cap-'));
        writeFileSync(path.join(d, 'c.txt'), 'We packed 14 days in one bag.');
        const r = spawnSync(process.execPath, [path.join(SCRIPTS, 'caption-lint.ts'), path.join(d, 'c.txt'), '--kind', 'photo'], { encoding: 'utf8' });
        expect(r.status).toBe(2);
        const j = spawnSync(process.execPath, [path.join(SCRIPTS, 'caption-lint.ts'), path.join(d, 'c.txt'), '--kind', 'photo', '--title', 'Pack light', '--json'], { encoding: 'utf8' });
        expect(JSON.parse(j.stdout)).toMatchObject({ kind: 'photo', limit: 4000, title: { characters: 10, limit: 90 } });
    });
});

describe('hook-score, the TikTok triple', () => {
    test('on-screen text with no spoken line scores lower than both', () => {
        const hook = 'I spent $4,000 testing 12 hooks so you do not have to';
        const both = scoreTriple({ spoken: hook, onScreen: '12 hooks, $4,000, 1 winner', visual: '' });
        const onlyScreen = scoreTriple({ spoken: '', onScreen: '12 hooks, $4,000, 1 winner', visual: '' });
        expect(onlyScreen.score).toBeLessThan(both.score);
        expect(onlyScreen.missing).toContain('spoken');
        const all = scoreTriple({ spoken: hook, onScreen: '12 hooks, $4,000, 1 winner', visual: 'hard cut to a desk covered in receipts' });
        expect(all.score).toBeGreaterThan(both.score);
        expect(all.missing).toEqual([]);
    });
    test('the weights come from hooks.json', () => {
        const h = JSON.parse(readFileSync(path.join(SCRIPTS, 'hooks.json'), 'utf8'));
        const w = h.tiktok.triple.weights;
        expect(w.spoken + w.on_screen + w.visual).toBeCloseTo(1, 6);
        expect(scoreTriple({ spoken: '', onScreen: '', visual: 'x' }).score).toBeCloseTo(100 * w.visual, 1);
    });
});

describe('ported scripts', () => {
    const files = ['hook-score.ts', 'caption-lint.ts', 'beats.ts', 'ai-tells.ts'];
    test('every copied script keeps its upstream header', () => {
        for (const f of files) expect(readFileSync(path.join(SCRIPTS, f), 'utf8').split('\n').slice(0, 3).join('\n')).toMatch(/Ported from instagram-agent-skill \(MIT, \(c\) 2026 Jake Schincariol\)/);
    });
    test('the JSON assets keep their upstream content and mark our additions', () => {
        const h = JSON.parse(readFileSync(path.join(SCRIPTS, 'hooks.json'), 'utf8'));
        expect(h.hooks.length).toBeGreaterThanOrEqual(26);
        expect(h.tiktok.note).toMatch(/tiktok-ai-plugin/);
        const s = JSON.parse(readFileSync(path.join(SCRIPTS, 'slop.json'), 'utf8'));
        expect(s.tiktok.note).toMatch(/tiktok-ai-plugin/);
        expect(s.tiktok.phrases.length).toBeGreaterThan(0);
    });
    test('each linter runs as a CLI from another working directory', () => {
        const cwd = mkdtempSync(path.join(os.tmpdir(), 'tt-cwd-'));
        writeFileSync(path.join(cwd, 'in.txt'), 'We tested 3 hooks on 12 videos.\nHere is what won.\n');
        const run = (f: string, ...a: string[]) => spawnSync(process.execPath, [path.join(SCRIPTS, f), ...a], { encoding: 'utf8', cwd });
        expect(run('ai-tells.ts', 'detect', 'in.txt', '--json').stdout).toMatch(/\{/);
        expect(run('hook-score.ts', '--hook', 'I tested 12 hooks', '--on-screen', '12 hooks', '--json').stdout).toMatch(/"triple"/);
        expect(run('caption-lint.ts', 'in.txt', '--json').stdout).toMatch(/"verdict"/);
        expect(run('beats.ts', 'in.txt', '--json').stdout).toMatch(/\{/);
    });
});
