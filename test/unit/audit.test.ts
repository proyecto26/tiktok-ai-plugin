// tiktok-audit: medians, rate, splits, coverage scope from `exhausted`, dedupe, no_posts, CLI wording.
import { describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { AuditError, auditPosts, median, renderAudit } from '../../skills/tiktok-audit/scripts/audit.ts';
import type { ReadResult, TtVideo } from '../../skills/tiktok/scripts/read.ts';

const DAY = 86400;
const T0 = Date.UTC(2026, 9, 1) / 1000;
let seq = 0;
function v(o: Partial<TtVideo> = {}): TtVideo {
    seq++;
    return { id: String(7000000000000000000n + BigInt(seq)), url: '', createTime: T0 + seq * DAY, caption: '', durationSec: 30, plays: 1000, likes: 50, comments: 5, shares: 5, isPhoto: false, hashtags: [], ...o };
}
const list = (data: TtVideo[], extra: Partial<ReadResult<TtVideo[]>> = {}): ReadResult<TtVideo[]> => ({ source: 'page', data, complete: true, exhausted: true, ...extra });

describe('median', () => {
    test('odd and even samples', () => {
        expect(median([3, 1, 2])).toBe(2);
        expect(median([4, 1, 3, 2])).toBe(2.5);
        expect(median([])).toBeNull();
    });
});

describe('auditPosts', () => {
    test('medians of plays/likes/comments/shares', () => {
        const r = auditPosts(list([v({ plays: 100, likes: 10 }), v({ plays: 300, likes: 30 }), v({ plays: 200, likes: 20 }), v({ plays: 400, likes: 40 })]));
        expect(r.medians.plays).toBe(250);
        expect(r.medians.likes).toBe(25);
        expect(r.medians.comments).toBe(5);
    });
    test('0-play posts are excluded from the engagement rate', () => {
        const r = auditPosts(list([v({ plays: 0, likes: 10, comments: 0, shares: 0 }), v({ plays: 1000, likes: 90, comments: 5, shares: 5 })]));
        expect(r.engagementRate).toBeCloseTo(0.1, 6);
    });
    test('saves count in the rate when present; missing saves are omitted, not zero', () => {
        const none = auditPosts(list([v(), v()]));
        expect('saves' in none.medians).toBe(false);
        const some = auditPosts(list([v({ saves: 10 }), v({ saves: 30 }), v()]));
        expect(some.medians.saves).toBe(20);
        expect(auditPosts(list([v({ plays: 1000, likes: 50, comments: 0, shares: 0, saves: 50 })])).engagementRate).toBeCloseTo(0.1, 6);
    });
    test('photo vs video split and duration buckets (videos only)', () => {
        const r = auditPosts(list([v({ isPhoto: true, plays: 50, imageCount: 4 }), v({ durationSec: 10 }), v({ durationSec: 30 }), v({ durationSec: 90 }), v({ durationSec: 60 })]));
        expect(r.byFormat.photo.n).toBe(1);
        expect(r.byFormat.video.n).toBe(4);
        expect(r.byFormat.photo.medianPlays).toBe(50);
        expect(r.byDuration['<15s'].n).toBe(1);
        expect(r.byDuration['15-60s'].n).toBe(2);
        expect(r.byDuration['>60s'].n).toBe(1);
    });
    test('exhausted:true gives scope account', () => {
        expect(auditPosts(list([v()])).coverage.scope).toBe('account');
    });
    for (const [name, extra] of [
        ['limit cut', { complete: true, exhausted: false, reason: 'limit' }],
        ['error page', { complete: false, exhausted: false, reason: 'error page in the chain' }],
        ['dropped items', { complete: false, exhausted: false, reason: 'dropped 2' }],
        ['more pages', { complete: false, exhausted: false, reason: 'more pages' }],
        ['flag absent', { exhausted: undefined }],
    ] as const) {
        test(`exhausted not true (${name}) gives scope sample`, () => {
            const r = auditPosts(list([v(), v()], extra as Partial<ReadResult<TtVideo[]>>));
            expect(r.coverage.scope).toBe('sample');
            expect(r.coverage.n).toBe(2);
        });
    }
    test('duplicate ids are counted once', () => {
        const a = v({ plays: 100 });
        const r = auditPosts(list([a, { ...a }, v({ plays: 300 })]));
        expect(r.coverage.n).toBe(2);
        expect(r.medians.plays).toBe(200);
    });
    test('empty list throws no_posts', () => {
        expect(() => auditPosts(list([]))).toThrow(AuditError);
        try {
            auditPosts(list([]));
        } catch (e) {
            expect((e as AuditError).kind).toBe('no_posts');
        }
    });
    test('cadence, coverage dates and hashtags', () => {
        const base = T0 + 1000 * DAY;
        const posts = [0, 2, 4, 18].map((d, i) => v({ createTime: base + d * DAY, plays: 100 * (i + 1), hashtags: i < 3 ? ['cooking'] : ['travel'] }));
        const r = auditPosts(list(posts));
        expect(r.cadence.longestGapDays).toBe(14);
        expect(r.cadence.postsPerWeek).toBeCloseTo(4 / (18 / 7), 2);
        expect(r.coverage.from).toBe(new Date(base * 1000).toISOString().slice(0, 10));
        expect(r.hashtags[0]).toEqual({ tag: 'cooking', posts: 3, medianPlays: 200 });
    });
    test('markdown says "sample of N posts" whenever scope is sample', () => {
        const md = renderAudit(auditPosts(list([v(), v(), v()], { exhausted: false, reason: 'limit' })));
        expect(md).toMatch(/sample of 3 posts/);
        expect(renderAudit(auditPosts(list([v(), v(), v()])))).not.toMatch(/sample of/);
    });
});

describe('audit CLI', () => {
    const MAIN = path.resolve(import.meta.dir, '../../skills/tiktok-audit/scripts/main.ts');
    test('reads the operator output file and prints JSON or markdown', () => {
        const d = mkdtempSync(path.join(os.tmpdir(), 'tt-audit-'));
        const f = path.join(d, 'videos.json');
        writeFileSync(f, JSON.stringify(list([v(), v()], { exhausted: false, reason: 'limit' })));
        const j = spawnSync(process.execPath, [MAIN, 'audit', '--videos', f, '--json'], { encoding: 'utf8', cwd: d });
        expect(j.status).toBe(0);
        expect(JSON.parse(j.stdout).coverage.scope).toBe('sample');
        const m = spawnSync(process.execPath, [MAIN, 'audit', '--videos', f], { encoding: 'utf8', cwd: d });
        expect(m.stdout).toMatch(/sample of 2 posts/);
    });
    test('empty list exits non-zero with no_posts', () => {
        const d = mkdtempSync(path.join(os.tmpdir(), 'tt-audit-'));
        const f = path.join(d, 'videos.json');
        writeFileSync(f, JSON.stringify(list([])));
        const r = spawnSync(process.execPath, [MAIN, 'audit', '--videos', f, '--json'], { encoding: 'utf8' });
        expect(r.status).not.toBe(0);
        expect(r.stdout + r.stderr).toMatch(/no_posts/);
    });
    test('rubric keeps its upstream notice', () => {
        const rub = JSON.parse(readFileSync(path.resolve(import.meta.dir, '../../skills/tiktok-audit/references/profile-rubric.json'), 'utf8'));
        expect(rub.source).toMatch(/instagram-agent-skill/);
        expect(rub.total).toBe(rub.items.reduce((s: number, i: { points: number }) => s + i.points, 0));
    });
});
