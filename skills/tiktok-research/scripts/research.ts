/**
 * Research over the `tiktok` operator's list reads (`hashtag`, `sound`, `videos` with `--capture … --json`).
 * Reads files only: no network, no session. Inputs are merged and deduped by post id before anything is counted.
 */
import type { ReadResult, TtVideo } from '../../tiktok/scripts/read.ts';

export const OUTLIER = { minSample: 8, ratio: 3 } as const;

/** Middle value; the mean of the two middle values for an even count (this skill carries its own copy). */
function median(xs: number[]): number | null {
    if (!xs.length) return null;
    const s = [...xs].sort((a, b) => a - b);
    const m = s.length >> 1;
    return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}
const UNKNOWN = '(unknown)';

export type AuthorResult =
    | { author: string; n: number; median: number; items: { id: string; url: string; plays: number; ratio: number }[] }
    | { author: string; n: number; reason: 'sample_too_small' | 'zero_median' | 'unattributed' };

export interface ScanResult {
    hashtags: { tag: string; posts: number; medianPlays: number }[];
    sounds: { musicId: string; title: string; posts: number; medianPlays: number }[];
    sample: { n: number; scope: 'complete_lists' | 'partial' };
}

/** Lower-cased handle from the post URL (`/@handle/video/…`); '' when the read carried no handle. */
export function authorOf(p: TtVideo): string {
    const m = /tiktok\.com\/@([^/?#]+)\//.exec(p.url ?? '');
    const a = m ? decodeURIComponent(m[1]).toLowerCase() : '';
    return a === '_' ? '' : a;
}

function merge(lists: ReadResult<TtVideo[]>[]): TtVideo[] {
    const seen = new Map<string, TtVideo>();
    for (const l of lists) {
        if (!l || !Array.isArray(l.data)) throw new Error('expected the JSON of a tiktok list read (hashtag, sound or videos --json)');
        for (const p of l.data) if (p && p.id && !seen.has(p.id)) seen.set(p.id, p);
    }
    return [...seen.values()];
}

export function outliers(lists: ReadResult<TtVideo[]>[]): { authors: AuthorResult[] } {
    const by = new Map<string, TtVideo[]>();
    for (const p of merge(lists)) {
        const a = authorOf(p) || UNKNOWN;
        by.set(a, [...(by.get(a) ?? []), p]);
    }
    const authors: AuthorResult[] = [];
    for (const [author, posts] of by) {
        const n = posts.length;
        // Posts with no handle may come from many creators: never one baseline.
        if (author === UNKNOWN) {
            authors.push({ author, n, reason: 'unattributed' });
            continue;
        }
        if (n < OUTLIER.minSample) {
            authors.push({ author, n, reason: 'sample_too_small' });
            continue;
        }
        const med = median(posts.map((p) => p.plays))!;
        if (med <= 0) {
            authors.push({ author, n, reason: 'zero_median' });
            continue;
        }
        const items = posts
            .filter((p) => p.plays >= OUTLIER.ratio * med)
            .map((p) => ({ id: p.id, url: p.url, plays: p.plays, ratio: Math.round((p.plays / med) * 100) / 100 }))
            .sort((a, b) => b.ratio - a.ratio);
        authors.push({ author, n, median: med, items });
    }
    authors.sort((a, b) => b.n - a.n);
    return { authors };
}

export function scan(lists: ReadResult<TtVideo[]>[]): ScanResult {
    const posts = merge(lists);
    const tags = new Map<string, number[]>();
    const sounds = new Map<string, { titles: Map<string, number>; plays: number[] }>();
    for (const p of posts) {
        for (const t of new Set((p.hashtags ?? []).map((h) => h.toLowerCase()))) tags.set(t, [...(tags.get(t) ?? []), p.plays]);
        if (p.musicId) {
            const s = sounds.get(p.musicId) ?? { titles: new Map<string, number>(), plays: [] as number[] };
            s.plays.push(p.plays);
            if (p.musicTitle) s.titles.set(p.musicTitle, (s.titles.get(p.musicTitle) ?? 0) + 1);
            sounds.set(p.musicId, s);
        }
    }
    return {
        hashtags: [...tags].map(([tag, pl]) => ({ tag, posts: pl.length, medianPlays: median(pl)! })).sort((a, b) => b.posts - a.posts || b.medianPlays - a.medianPlays),
        sounds: [...sounds]
            .map(([musicId, s]) => ({ musicId, title: [...s.titles].sort((a, b) => b[1] - a[1])[0]?.[0] ?? '', posts: s.plays.length, medianPlays: median(s.plays)! }))
            .sort((a, b) => b.posts - a.posts || b.medianPlays - a.medianPlays),
        sample: { n: posts.length, scope: lists.every((l) => l.exhausted === true) ? 'complete_lists' : 'partial' },
    };
}
