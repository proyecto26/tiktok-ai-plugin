import type { Draft, Privacy } from './draft.ts';
import { normalizeAccount } from './draft.ts';

/** What the composer shows, read by scripts/browser/compose.js `state()`. */
export interface PageState {
    schema: 'tt-pagestate-v1';
    url: string;
    /** When compose.js read the page (ISO); begin refuses a state older than STATE_MAX_AGE_MS. */
    capturedAt?: string;
    account: string;
    kind: 'video' | 'photo';
    caption?: string;
    title?: string;
    description?: string;
    privacy: Privacy | 'unknown';
    /** null: compose.js could not find the control. */
    allowComments: boolean | null;
    allowReuse: boolean | null;
    aiGenerated: boolean | null;
    discloseContent: boolean | null;
    files: number;
    /** File names the upload status shows, in order; compared with the approved media's names. */
    fileNames?: string[];
    ready: boolean;
    /** A captcha or verification overlay is on the page. */
    challenge?: boolean;
    /** Toggles compose.js could not find; their values in this state are not readings. */
    unread?: string[];
}

/** One row of /tiktokstudio/content, read by scripts/browser/studio-rows.js. */
export interface Row {
    text: string;
    privacy: Privacy | 'unknown';
    underReview: boolean;
    time?: string;
}

export interface Rows {
    schema: 'tt-rows-v1';
    account: string;
    rows: Row[];
}

const squash = (s: string | undefined) => (s ?? '').replace(/\s+/g, ' ').trim();
const baseName = (p: string) => p.split(/[\\/]/).pop() ?? p;
export const STATE_MAX_AGE_MS = 2 * 60_000;
const UPLOAD_URL = 'https://www.tiktok.com/tiktokstudio/upload';

/** Every difference between the approved draft and what the page shows; empty means they agree. */
export function compareState(d: Pick<Draft, 'account' | 'media' | 'settings'>, s: PageState, now = Date.now()): string[] {
    const diff: string[] = [];
    if (s?.schema !== 'tt-pagestate-v1') return ['schema: not a tt-pagestate-v1 file (run scripts/browser/compose.js state())'];
    if (typeof s.url !== 'string' || !/^https:\/\/www\.tiktok\.com\/tiktokstudio\/upload(?:[/?#]|$)/.test(s.url)) diff.push(`url: the state was not read on ${UPLOAD_URL}`);
    const at = Date.parse(String(s.capturedAt ?? ''));
    if (!Number.isFinite(at) || now - at > STATE_MAX_AGE_MS || at - now > 60_000) diff.push('stale: read the page state again right before publish begin (it is older than 2 minutes or has no capturedAt)');
    if (s.challenge === true) diff.push('challenge: a captcha or verification is on the page');
    if (Array.isArray(s.unread) && s.unread.length) diff.push(`unread: compose.js could not read ${s.unread.join(', ')}; their values are not known`);
    const pageAccount = normalizeAccount(String(s.account ?? ''));
    if (pageAccount !== d.account) diff.push(`account: page is signed in as @${pageAccount || '?'}, draft is for @${d.account}`);
    const set = d.settings;
    if (s.kind !== set.kind) diff.push(`kind: page ${s.kind}, draft ${set.kind}`);
    const fields = set.kind === 'video' ? (['caption'] as const) : (['title', 'description'] as const);
    for (const f of fields) if (squash(s[f]) !== squash(set[f])) diff.push(`${f}: page "${squash(s[f])}", draft "${squash(set[f])}"`);
    if (s.privacy !== set.privacy) diff.push(`privacy: page ${s.privacy}, draft ${set.privacy}`);
    for (const k of ['allowComments', 'allowReuse', 'aiGenerated', 'discloseContent'] as const) if (s[k] !== set[k]) diff.push(`${k}: page ${s[k]}, draft ${set[k]}`);
    if (s.files !== d.media.length) diff.push(`files: page has ${s.files}, draft has ${d.media.length}`);
    else {
        const want = d.media.map((m) => baseName(m.path));
        const shown = Array.isArray(s.fileNames) ? s.fileNames.map(String) : [];
        if (shown.length !== want.length || shown.some((n, i) => n !== want[i])) diff.push(`files: page shows ${shown.length ? shown.join(', ') : 'no readable file names'}, draft has ${want.join(', ')}`);
    }
    if (s.ready !== true) diff.push('ready: the page is still uploading or processing the files');
    return diff;
}

const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];

/** Studio's row time ("Nov 16, 8:06 AM" or "May 14, 2024, 2:02 AM", browser-local) as epoch ms; the year defaults to `year`. */
export function rowTime(t: string | undefined, year: number): number | null {
    const m = (t ?? '').trim().match(/^(\w{3}) (\d{1,2})(?:, (\d{4}))?, (\d{1,2}):(\d{2})\s*([AP]M)$/i);
    if (!m) return null;
    const month = MONTHS.indexOf(m[1].toLowerCase());
    if (month < 0) return null;
    const hour = (Number(m[4]) % 12) + (m[6].toUpperCase() === 'PM' ? 12 : 0);
    return new Date(m[3] ? Number(m[3]) : year, month, Number(m[2]), hour, Number(m[5])).getTime();
}

/** A row counts for an attempt only if it was created from the attempt's minute up to this long after. */
export const ROW_WINDOW_MS = 15 * 60_000;

/**
 * The Studio row for this attempt: the only row whose text is the start of the draft's text AND whose time
 * falls in [attempt minute, attempt + ROW_WINDOW_MS]. Rows may be cut ("..."), so the shown prefix must match.
 * No text, no readable time, or two candidates -> null (never guess: the attempt stays open).
 */
export function matchRow(d: Pick<Draft, 'settings'>, startedAt: string, rows: Row[]): Row | null {
    const want = squash(d.settings.kind === 'video' ? d.settings.caption : d.settings.title || d.settings.description);
    const start = Date.parse(startedAt);
    if (!want || !Number.isFinite(start)) return null;
    const from = Math.floor(start / 60_000) * 60_000;
    const year = new Date(start).getFullYear();
    const hits = rows.filter((r) => {
        const shown = squash(r.text).replace(/(\.\.\.|…)$/, '').trim();
        if (!(shown.length >= Math.min(want.length, 20) && want.startsWith(shown))) return false;
        const t = rowTime(r.time, year);
        return t !== null && t >= from && t <= start + ROW_WINDOW_MS;
    });
    return hits.length === 1 ? hits[0] : null;
}
