/**
 * drafts.json: one local draft per rendered video and per photo set, with caption suggestions linted by the sibling
 * `tiktok-content` skill (scripts/caption-lint.ts) and the `tiktok publish prepare` command each draft would use.
 * Nothing here publishes, schedules or contacts TikTok: `publish prepare` is itself a dry run, and the owner approves
 * the exact post there.
 */
import { stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { ToolError } from './ff.ts';
import { SCHEMA } from './library.ts';
import { probeMedia } from './media.ts';
import type { PhotoSet } from './photos.ts';

export interface LintCheck {
    check: string;
    status: string;
    detail: string;
}
export interface LintResult {
    verdict: 'FIX' | 'REVIEW' | 'READY';
    characters: number;
    limit: number;
    checks: LintCheck[];
}
export interface Linter {
    analyseCaption(text: string): LintResult;
    analysePhoto(title: string, description: string): LintResult;
}

const DEFAULT_LINTER = fileURLToPath(new URL('../../tiktok-content/scripts/caption-lint.ts', import.meta.url));

/** Loads the sibling skill's linter; null when the file is missing or does not export what is needed. */
export async function loadCaptionLinter(file: string = DEFAULT_LINTER): Promise<Linter | null> {
    if (!(await stat(file).catch(() => null))?.isFile()) return null;
    try {
        const m = await import(pathToFileURL(file).href);
        if (typeof m.analyseCaption !== 'function' || typeof m.analysePhoto !== 'function') return null;
        return { analyseCaption: (t) => m.analyseCaption(t), analysePhoto: (t, d) => m.analysePhoto(t, d) };
    } catch {
        return null;
    }
}

export const slug = (s: string) => s.normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]/g, '');
export const shellQuote = (s: string) => (/^[A-Za-z0-9_/.:=,@%+-]+$/.test(s) ? s : `'${s.replace(/'/g, `'\\''`)}'`);

export interface Suggestion {
    text: string;
    source: 'template' | 'supplied';
    lint: LintResult | null;
}
export interface Draft {
    id: string;
    kind: 'video' | 'photo';
    files: string[];
    duration?: number | null;
    title?: string;
    status: 'ready' | 'review' | 'needs_edit' | 'unlinted';
    suggestions: Suggestion[];
    chosen: number | null;
    prepare: { argv: string[]; command: string } | null;
}
export interface DraftsFile {
    schema: typeof SCHEMA;
    kind: 'drafts';
    created_at: string;
    publishing: string;
    lint: { available: boolean; source: string; reason?: string };
    drafts: Draft[];
    warnings: string[];
}
export interface PhotoSetsFile {
    schema: string;
    kind: 'photosets';
    limit: number;
    sets: PhotoSet[];
}
export interface DraftsInput {
    videos?: string[];
    photosets?: PhotoSetsFile | null;
    place?: string;
    hook?: string;
    /** Captions written by the owner or the assistant; linted like the templates and listed first. */
    captions?: string[];
    /** false = lint only the supplied captions. */
    templates?: boolean;
}

const PHOTO_TITLE_MAX = 90; // mirrors caption-lint; the lint result is what is authoritative.
const rank = (l: LintResult | null) => (l?.verdict === 'READY' ? 0 : l?.verdict === 'REVIEW' ? 1 : l ? 2 : 0);

function templates(kind: 'video' | 'photo', place: string | undefined, hook: string | undefined): { hook: string; texts: string[] } {
    const h = hook?.trim() || (kind === 'video' ? (place ? `${place}, in under a minute.` : 'A trip, cut down to the good parts.') : `${place || 'The trip'}: the photos worth keeping.`);
    const tags = ['#travel', place && slug(place) ? `#${slug(place)}` : null, '#traveltok'].filter(Boolean).join(' ');
    const where = place ? `Filmed in ${place}.` : '';
    const join = (...p: string[]) => p.filter(Boolean).join('\n\n');
    return { hook: h, texts: [join(h, where, tags), join(where || h, where ? h : '', tags), `${h} ${tags}`].filter((t, i, a) => a.indexOf(t) === i) };
}

const posix = (argv: string[]) => `npx -y bun skills/tiktok/scripts/main.ts ${argv.map(shellQuote).join(' ')}`;

export async function buildDrafts(input: DraftsInput, linter: Linter | null): Promise<DraftsFile> {
    const warnings: string[] = [];
    if (!linter) warnings.push('captions were not linted: skills/tiktok-content/scripts/caption-lint.ts is missing or unusable. Install the tiktok-content skill next to this one, then run drafts again; until then check each caption with `publish prepare`, which enforces the length limits.');
    const drafts: Draft[] = [];
    const useTemplates = input.templates !== false;

    const finish = (d: Omit<Draft, 'status' | 'chosen' | 'prepare'>, mk: (text: string) => string[]): Draft => {
        let chosen: number | null = null;
        if (!linter) chosen = d.suggestions.length ? 0 : null;
        else {
            const ok = d.suggestions.map((s, i) => ({ i, r: rank(s.lint) })).filter((x) => x.r < 2).sort((a, b) => a.r - b.r || a.i - b.i);
            chosen = ok.length ? ok[0].i : null;
        }
        const argv = chosen === null ? null : mk(d.suggestions[chosen].text);
        const verdict = chosen === null ? null : d.suggestions[chosen].lint?.verdict;
        return { ...d, status: !linter ? 'unlinted' : chosen === null ? 'needs_edit' : verdict === 'READY' ? 'ready' : 'review', chosen, prepare: argv ? { argv, command: posix(argv) } : null };
    };

    for (const [i, v] of (input.videos ?? []).entries()) {
        const abs = path.resolve(v);
        if (!(await stat(abs).catch(() => null))?.isFile()) throw new ToolError('video_not_found', `No video at ${abs}.`);
        const info = await probeMedia(abs);
        if (info.kind !== 'video') throw new ToolError('not_a_video', `${abs} is not a video.`);
        if (info.width !== 1080 || info.height !== 1920) warnings.push(`${path.basename(abs)} is ${info.width}x${info.height}, not a 1080x1920 cut from render.`);
        const t = templates('video', input.place, input.hook);
        const texts: { text: string; source: Suggestion['source'] }[] = [...(input.captions ?? []).map((text) => ({ text, source: 'supplied' as const })), ...(useTemplates ? t.texts.map((text) => ({ text, source: 'template' as const })) : [])];
        drafts.push(finish({ id: `draft-video-${i + 1}`, kind: 'video', files: [abs], duration: info.duration, suggestions: texts.map((x) => ({ ...x, lint: linter ? linter.analyseCaption(x.text) : null })) }, (text) => ['publish', 'prepare', '--video', abs, '--caption', text]));
    }

    for (const s of input.photosets?.sets ?? []) {
        const t = templates('photo', input.place, input.hook);
        const title = Array.from(t.hook).slice(0, PHOTO_TITLE_MAX).join('');
        const texts: { text: string; source: Suggestion['source'] }[] = [...(input.captions ?? []).map((text) => ({ text, source: 'supplied' as const })), ...(useTemplates ? t.texts.map((text) => ({ text, source: 'template' as const })) : [])];
        drafts.push(finish({ id: `draft-${s.id}`, kind: 'photo', files: s.files, title, suggestions: texts.map((x) => ({ ...x, lint: linter ? linter.analysePhoto(title, x.text) : null })) }, (text) => ['publish', 'prepare', '--photos', s.files.join(','), '--title', title, '--description', text]));
    }

    if (!drafts.length) throw new ToolError('nothing_to_draft', 'No videos or photo sets were given.', 'Pass --videos a.mp4,b.mp4 and/or --photosets photos/photosets.json.');
    return {
        schema: SCHEMA,
        kind: 'drafts',
        created_at: new Date().toISOString(),
        publishing: 'Never publishes: nothing is published or scheduled by this skill. Each command below is a dry run (`publish prepare`); the owner reviews the draft and approves the exact post in the tiktok skill.',
        lint: linter ? { available: true, source: 'skills/tiktok-content/scripts/caption-lint.ts' } : { available: false, source: 'skills/tiktok-content/scripts/caption-lint.ts', reason: 'the tiktok-content skill (caption-lint.ts) was not found next to tiktok-travel-studio' },
        drafts,
        warnings,
    };
}
