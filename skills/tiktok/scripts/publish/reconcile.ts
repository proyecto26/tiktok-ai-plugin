import type { Draft, Privacy } from './draft.ts';
import { normalizeAccount } from './draft.ts';

/** What the composer shows, read by scripts/browser/compose.js `state()`. */
export interface PageState {
    schema: 'tt.pagestate.v1';
    url: string;
    account: string;
    kind: 'video' | 'photo';
    caption?: string;
    title?: string;
    description?: string;
    privacy: Privacy | 'unknown';
    allowComments: boolean;
    allowReuse: boolean;
    aiGenerated: boolean;
    discloseContent: boolean;
    files: number;
    ready: boolean;
}

/** One row of /tiktokstudio/content, read by scripts/browser/studio-rows.js. */
export interface Row {
    text: string;
    privacy: Privacy | 'unknown';
    underReview: boolean;
    time?: string;
}

export interface Rows {
    schema: 'tt.rows.v1';
    account: string;
    rows: Row[];
}

const squash = (s: string | undefined) => (s ?? '').replace(/\s+/g, ' ').trim();

/** Every difference between the approved draft and what the page shows; empty means they agree. */
export function compareState(d: Pick<Draft, 'account' | 'media' | 'settings'>, s: PageState): string[] {
    const diff: string[] = [];
    if (s?.schema !== 'tt.pagestate.v1') return ['schema: not a tt.pagestate.v1 file (run scripts/browser/compose.js state())'];
    const pageAccount = normalizeAccount(String(s.account ?? ''));
    if (pageAccount !== d.account) diff.push(`account: page is signed in as @${pageAccount || '?'}, draft is for @${d.account}`);
    const set = d.settings;
    if (s.kind !== set.kind) diff.push(`kind: page ${s.kind}, draft ${set.kind}`);
    const fields = set.kind === 'video' ? (['caption'] as const) : (['title', 'description'] as const);
    for (const f of fields) if (squash(s[f]) !== squash(set[f])) diff.push(`${f}: page "${squash(s[f])}", draft "${squash(set[f])}"`);
    if (s.privacy !== set.privacy) diff.push(`privacy: page ${s.privacy}, draft ${set.privacy}`);
    for (const k of ['allowComments', 'allowReuse', 'aiGenerated', 'discloseContent'] as const) if (s[k] !== set[k]) diff.push(`${k}: page ${s[k]}, draft ${set[k]}`);
    if (s.files !== d.media.length) diff.push(`files: page has ${s.files}, draft has ${d.media.length}`);
    if (s.ready !== true) diff.push('ready: the page is still uploading or processing the files');
    return diff;
}

/**
 * The Studio row for this draft: the first (newest) row whose text is the start of the draft's text.
 * Studio rows may be cut ("..."), so the shown prefix must match; a draft with no text cannot be matched.
 */
export function matchRow(d: Pick<Draft, 'settings'>, rows: Row[]): Row | null {
    const want = squash(d.settings.kind === 'video' ? d.settings.caption : d.settings.title || d.settings.description);
    if (!want) return null;
    for (const r of rows) {
        const shown = squash(r.text).replace(/(\.\.\.|…)$/, '').trim();
        if (shown.length >= Math.min(want.length, 20) && want.startsWith(shown)) return r;
    }
    return null;
}
