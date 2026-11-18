// tiktok-research: per-author outliers after dedupe, zero median, scan by sound id, partial scope, CLI.
import { describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { OUTLIER, authorOf, outliers, scan } from '../../skills/tiktok-research/scripts/research.ts';
import type { ReadResult, TtVideo } from '../../skills/tiktok/scripts/read.ts';

let seq = 0;
function v(author: string, plays: number, o: Partial<TtVideo> = {}): TtVideo {
    const id = String(7100000000000000000n + BigInt(++seq));
    return { id, url: `https://www.tiktok.com/@${author}/video/${id}`, createTime: 1760000000 + seq, caption: '', durationSec: 20, plays, likes: 1, comments: 0, shares: 0, isPhoto: false, hashtags: [], ...o };
}
const list = (data: TtVideo[], exhausted = true): ReadResult<TtVideo[]> => ({ source: 'page', data, complete: true, exhausted });
type Analysed = { author: string; n: number; median: number; items: { id: string; plays: number; ratio: number }[] };
const find = (r: ReturnType<typeof outliers>, a: string) => r.authors.find((x) => x.author === a)!;

describe('outliers', () => {
    test('thresholds', () => {
        expect(OUTLIER).toEqual({ minSample: 8, ratio: 3 });
    });
    test('author from the post URL', () => {
        expect(authorOf(v('Some.Creator', 1))).toBe('some.creator');
        expect(authorOf({ ...v('x', 1), url: 'https://www.tiktok.com/@_/video/1' })).toBe('');
    });
    test('7 distinct posts plus duplicates of them is sample_too_small (Review Focus 4)', () => {
        const posts = Array.from({ length: 7 }, (_, i) => v('ana', 100 + i));
        const r = outliers([list(posts), list(posts.map((p) => ({ ...p })))]);
        expect(find(r, 'ana')).toEqual({ author: 'ana', n: 7, reason: 'sample_too_small' });
    });
    test('authors of 8 and 3: only the first is analysed', () => {
        const r = outliers([list([...Array.from({ length: 8 }, () => v('big', 100)), ...Array.from({ length: 3 }, () => v('small', 100))])]);
        expect('median' in find(r, 'big')).toBe(true);
        expect(find(r, 'small')).toEqual({ author: 'small', n: 3, reason: 'sample_too_small' });
    });
    test('median 0 gives zero_median and no outliers', () => {
        const r = outliers([list([...Array.from({ length: 7 }, () => v('z', 0)), v('z', 5000)])]);
        expect(find(r, 'z')).toEqual({ author: 'z', n: 8, reason: 'zero_median' });
    });
    test('exactly 3x the median is included; just under is not', () => {
        const posts = [...Array.from({ length: 7 }, () => v('c', 100)), v('c', 300), v('c', 299)];
        const a = find(outliers([list(posts)]), 'c') as Analysed;
        expect(a.median).toBe(100);
        expect(a.items.map((i) => i.plays)).toEqual([300]);
        expect(a.items[0].ratio).toBe(3);
    });
    test('overlapping lists are not double counted', () => {
        const posts = [...Array.from({ length: 8 }, () => v('d', 100)), v('d', 1000)];
        const r = outliers([list(posts.slice(0, 6)), list(posts.slice(3))]);
        const a = find(r, 'd') as Analysed;
        expect(a.n).toBe(9);
        expect(a.items).toHaveLength(1);
    });
});

describe('scan', () => {
    test('sounds grouped by id even with differing titles; hashtags counted once per post', () => {
        const a = v('e', 100, { musicId: '77', musicTitle: 'original sound - e', hashtags: ['diy', 'DIY'] });
        const b = v('f', 300, { musicId: '77', musicTitle: 'Song Name', hashtags: ['diy'] });
        const c = v('g', 50, { musicId: '88', musicTitle: 'Other' });
        const r = scan([list([a, b]), list([a, c])]);
        expect(r.sample.n).toBe(3);
        const s = r.sounds.find((x) => x.musicId === '77')!;
        expect(s.posts).toBe(2);
        expect(s.medianPlays).toBe(200);
        expect(r.hashtags.find((h) => h.tag === 'diy')).toEqual({ tag: 'diy', posts: 2, medianPlays: 200 });
        expect(r.sample.scope).toBe('complete_lists');
    });
    test('any input with exhausted:false makes the scope partial', () => {
        expect(scan([list([v('h', 1)]), list([v('i', 1)], false)]).sample.scope).toBe('partial');
    });
});

describe('research CLI', () => {
    const MAIN = path.resolve(import.meta.dir, '../../skills/tiktok-research/scripts/main.ts');
    test('outliers and scan read several operator files', () => {
        const d = mkdtempSync(path.join(os.tmpdir(), 'tt-res-'));
        const f1 = path.join(d, 'a.json');
        const f2 = path.join(d, 'b.json');
        writeFileSync(f1, JSON.stringify(list(Array.from({ length: 8 }, () => v('j', 100, { musicId: '9' })))));
        writeFileSync(f2, JSON.stringify(list([v('j', 900, { musicId: '9' })], false)));
        const o = spawnSync(process.execPath, [MAIN, 'outliers', '--input', f1, f2], { encoding: 'utf8', cwd: d });
        expect(o.status).toBe(0);
        expect(JSON.parse(o.stdout).authors[0].items).toHaveLength(1);
        const s = spawnSync(process.execPath, [MAIN, 'scan', '--input', f1, '--input', f2], { encoding: 'utf8', cwd: d });
        expect(JSON.parse(s.stdout).sample).toEqual({ n: 9, scope: 'partial' });
    });
});

describe('final review fixes: unattributed posts', () => {
    test('posts without a handle are never analysed as one creator', () => {
        const anon = (plays: number) => ({ ...v('x', plays), url: 'https://www.tiktok.com/@_/video/1' + String(++seq) });
        const r = outliers([list([...Array.from({ length: 8 }, () => anon(100)), anon(1000)])]);
        expect(r.authors.some((a) => 'median' in a)).toBe(false);
        expect(r.authors.find((a) => a.author === '(unknown)')).toEqual({ author: '(unknown)', n: 9, reason: 'unattributed' } as never);
    });
});
