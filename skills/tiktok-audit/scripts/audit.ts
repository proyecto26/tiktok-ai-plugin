/**
 * Audit of a TikTok account from the `tiktok` operator's own output (`videos --capture … --json`, optionally
 * `profile`). Reads files only: no network, no session. Every figure is a median over the posts that carry it.
 * The coverage is `account` only when the operator says the whole list was read (`exhausted: true`).
 */
import type { ReadResult, TtProfile, TtVideo } from '../../tiktok/scripts/read.ts';

export class AuditError extends Error {
    constructor(public kind: 'no_posts' | 'bad_input', message: string) {
        super(message);
    }
}

export interface Bucket {
    n: number;
    medianPlays: number | null;
    engagementRate: number | null;
}

export interface AuditReport {
    schema: 'tt.audit.v1';
    account?: { username: string; followers: number; likes: number; videoCount: number; bioChars: number; verified: boolean };
    coverage: { n: number; scope: 'account' | 'sample'; reason?: string; from: string; to: string };
    medians: { plays: number; likes: number; comments: number; shares: number; saves?: number };
    /** Median over posts with plays > 0 of (likes + comments + shares + saves when known) / plays. */
    engagementRate: number | null;
    byFormat: { video: Bucket; photo: Bucket };
    byDuration: { '<15s': Bucket; '15-60s': Bucket; '>60s': Bucket };
    cadence: { postsPerWeek: number; longestGapDays: number };
    hashtags: { tag: string; posts: number; medianPlays: number }[];
    posts: { id: string; url: string; date: string; plays: number; rate: number | null; multiple: number | null; isPhoto: boolean; durationSec: number; firstLine: string }[];
}

export function median(xs: number[]): number | null {
    if (!xs.length) return null;
    const s = [...xs].sort((a, b) => a - b);
    const m = s.length >> 1;
    return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

const rate = (p: TtVideo): number | null => (p.plays > 0 ? (p.likes + p.comments + p.shares + (p.saves ?? 0)) / p.plays : null);
const day = (t: number) => new Date(t * 1000).toISOString().slice(0, 10);
const r1 = (n: number) => Math.round(n * 10) / 10;

function bucket(ps: TtVideo[]): Bucket {
    return { n: ps.length, medianPlays: median(ps.map((p) => p.plays)), engagementRate: median(ps.map(rate).filter((x): x is number => x !== null)) };
}

export function auditPosts(videos: ReadResult<TtVideo[]>, profile?: ReadResult<TtProfile> | TtProfile): AuditReport {
    if (!videos || !Array.isArray(videos.data)) throw new AuditError('bad_input', 'expected the JSON of `tiktok videos --capture <file> --json`');
    const seen = new Set<string>();
    const posts = videos.data.filter((p) => (seen.has(p.id) ? false : (seen.add(p.id), true)));
    if (!posts.length) throw new AuditError('no_posts', 'no posts in this read: capture the profile page again after scrolling the grid');
    const times = posts.map((p) => p.createTime).sort((a, b) => a - b);
    const gaps = times.slice(1).map((t, i) => (t - times[i]) / 86400);
    const spanWeeks = (times[times.length - 1] - times[0]) / (7 * 86400);
    const saves = posts.filter((p) => typeof p.saves === 'number').map((p) => p.saves as number);
    const medians: AuditReport['medians'] = {
        plays: median(posts.map((p) => p.plays))!,
        likes: median(posts.map((p) => p.likes))!,
        comments: median(posts.map((p) => p.comments))!,
        shares: median(posts.map((p) => p.shares))!,
        ...(saves.length ? { saves: median(saves)! } : {}),
    };
    const tags = new Map<string, number[]>();
    for (const p of posts) for (const t of new Set(p.hashtags.map((h) => h.toLowerCase()))) tags.set(t, [...(tags.get(t) ?? []), p.plays]);
    const vids = posts.filter((p) => !p.isPhoto);
    const exhausted = videos.exhausted === true;
    const prof = profile && 'data' in profile ? profile.data : (profile as TtProfile | undefined);
    return {
        schema: 'tt.audit.v1',
        ...(prof ? { account: { username: prof.username, followers: prof.followers, likes: prof.likes, videoCount: prof.videoCount, bioChars: [...(prof.bio ?? '')].length, verified: prof.verified } } : {}),
        coverage: {
            n: posts.length,
            scope: exhausted ? 'account' : 'sample',
            ...(exhausted ? {} : { reason: videos.reason ?? 'the operator did not confirm the whole list was read' }),
            from: day(times[0]),
            to: day(times[times.length - 1]),
        },
        medians,
        engagementRate: median(posts.map(rate).filter((x): x is number => x !== null)),
        byFormat: { video: bucket(vids), photo: bucket(posts.filter((p) => p.isPhoto)) },
        byDuration: {
            '<15s': bucket(vids.filter((p) => p.durationSec < 15)),
            '15-60s': bucket(vids.filter((p) => p.durationSec >= 15 && p.durationSec <= 60)),
            '>60s': bucket(vids.filter((p) => p.durationSec > 60)),
        },
        cadence: { postsPerWeek: Math.round((spanWeeks > 0 ? posts.length / spanWeeks : posts.length) * 100) / 100, longestGapDays: r1(gaps.length ? Math.max(...gaps) : 0) },
        hashtags: [...tags].map(([tag, plays]) => ({ tag, posts: plays.length, medianPlays: median(plays)! })).sort((a, b) => b.posts - a.posts || b.medianPlays - a.medianPlays),
        posts: posts.map((p) => ({ id: p.id, url: p.url, date: day(p.createTime), plays: p.plays, rate: rate(p), multiple: medians.plays > 0 ? r1(p.plays / medians.plays) : null, isPhoto: p.isPhoto, durationSec: p.durationSec, firstLine: (p.caption ?? '').split('\n')[0].slice(0, 120) })),
    };
}

const pct = (x: number | null) => (x === null ? 'n/a' : `${(x * 100).toFixed(1)}%`);
const fmt = (b: Bucket) => (b.n ? `n=${b.n}, median plays ${b.medianPlays}, rate ${pct(b.engagementRate)}${b.n < 3 ? ' (insufficient data)' : ''}` : 'none');

export function renderAudit(a: AuditReport): string {
    const who = a.account ? `@${a.account.username}` : 'account';
    const scope = a.coverage.scope === 'account' ? `all ${a.coverage.n} posts` : `sample of ${a.coverage.n} posts (${a.coverage.reason})`;
    const lines = [
        `# TikTok audit · ${who} · ${scope} · ${a.coverage.from} to ${a.coverage.to}`,
        '',
        `Baseline: median ${a.medians.plays} plays, ${a.medians.likes} likes, ${a.medians.comments} comments, ${a.medians.shares} shares${a.medians.saves !== undefined ? `, ${a.medians.saves} saves` : ''}; engagement rate ${pct(a.engagementRate)}.`,
        '',
        `- Videos: ${fmt(a.byFormat.video)}`,
        `- Photo posts: ${fmt(a.byFormat.photo)}`,
        `- Under 15 s: ${fmt(a.byDuration['<15s'])}`,
        `- 15-60 s: ${fmt(a.byDuration['15-60s'])}`,
        `- Over 60 s: ${fmt(a.byDuration['>60s'])}`,
        `- Cadence: ${a.cadence.postsPerWeek} posts a week, longest gap ${a.cadence.longestGapDays} days`,
        `- Top hashtags: ${a.hashtags.slice(0, 5).map((h) => `#${h.tag} (${h.posts}, median ${h.medianPlays})`).join(', ') || 'none'}`,
    ];
    if (a.coverage.scope === 'sample') lines.push('', `Every figure is from a sample of ${a.coverage.n} posts, not the whole account.`);
    return lines.join('\n') + '\n';
}
