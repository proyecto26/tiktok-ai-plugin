import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import path from 'node:path';

import { TtError } from '../client.ts';

/**
 * A draft is the dry run of one post: the exact media bytes and every setting the owner approves.
 * Its digest binds the approval; any change to bytes, settings, order or account voids it.
 */

export type Privacy = 'only_me' | 'friends' | 'everyone' | 'follow_back';

export interface PostSettings {
    kind: 'video' | 'photo';
    /** Video only. */
    caption?: string;
    /** Photo only (Studio shows a title field and a description field). */
    title?: string;
    description?: string;
    privacy: Privacy;
    allowComments: boolean;
    allowReuse: boolean;
    aiGenerated: boolean;
    discloseContent: boolean;
}

export interface DraftMedia {
    path: string;
    sha256: string;
    bytes: number;
    /** Over the 10 MB cap of the agent's upload tool: the owner picks this file in the page. */
    manualFilePick: boolean;
}

export interface Draft {
    schema: 'tt.draft.v1';
    account: string;
    media: DraftMedia[];
    settings: PostSettings;
    digest: string;
    createdAt: string;
}

export const UPLOAD_TOOL_MAX_BYTES = 10 * 1024 * 1024;
export const TITLE_MAX = 90;
export const DESCRIPTION_MAX = 4000;
export const PHOTO_MAX = 35;
const VIDEO_EXT = new Set(['.mp4', '.mov', '.webm']);
const PHOTO_EXT = new Set(['.jpg', '.jpeg', '.png', '.webp']);
const PRIVACY: Record<PostSettings['kind'], Privacy[]> = { video: ['only_me', 'friends', 'everyone'], photo: ['only_me', 'friends', 'everyone', 'follow_back'] };

export function captionMax(): number {
    const v = Number(process.env.TIKTOK_CAPTION_MAX);
    return Number.isInteger(v) && v > 0 ? v : 2200;
}

export const normalizeAccount = (a: string): string => a.trim().replace(/^@/, '').toLowerCase();

const invalid = (msg: string): never => {
    throw new TtError('invalid_draft', msg);
};

function canonical(v: unknown): string {
    if (Array.isArray(v)) return `[${v.map(canonical).join(',')}]`;
    if (v && typeof v === 'object') {
        const o = v as Record<string, unknown>;
        return `{${Object.keys(o)
            .filter((k) => o[k] !== undefined)
            .sort()
            .map((k) => `${JSON.stringify(k)}:${canonical(o[k])}`)
            .join(',')}}`;
    }
    return JSON.stringify(v);
}

/** sha256 over the account, the media bytes in order (paths excluded) and every setting. */
export function approvalDigest(d: Pick<Draft, 'account' | 'media' | 'settings'>): string {
    const body = canonical({ account: d.account, media: d.media.map((m) => [m.sha256, m.bytes]), settings: d.settings });
    return createHash('sha256').update(body).digest('hex');
}

async function hashFile(p: string): Promise<{ sha256: string; bytes: number }> {
    let bytes: number;
    try {
        const s = await stat(p);
        if (!s.isFile()) return invalid(`media not found or not a file: ${p}`);
        bytes = s.size;
    } catch {
        return invalid(`media not found: ${p}`);
    }
    const h = createHash('sha256');
    for await (const chunk of createReadStream(p)) h.update(chunk as Buffer);
    return { sha256: h.digest('hex'), bytes };
}

function checkSettings(s: PostSettings, count: number, isPublic: boolean): PostSettings {
    if (s.kind !== 'video' && s.kind !== 'photo') invalid('kind is video or photo');
    if (s.kind === 'video' && count !== 1) invalid('a video post takes exactly one video file');
    if (s.kind === 'photo' && (count < 1 || count > PHOTO_MAX)) invalid(`a photo post takes 1-${PHOTO_MAX} photos`);
    if (!PRIVACY[s.kind].includes(s.privacy)) invalid(`privacy for a ${s.kind} is one of ${PRIVACY[s.kind].join(', ')}`);
    if (s.privacy === 'everyone' && !isPublic) invalid('privacy everyone is a public post: pass --public as well');
    if (s.kind === 'video') {
        if ((s.caption ?? '').length > captionMax()) invalid(`caption is over ${captionMax()} characters`);
        if (s.title !== undefined || s.description !== undefined) invalid('a video has a caption, not a title/description');
    } else {
        if ((s.title ?? '').length > TITLE_MAX) invalid(`title is over ${TITLE_MAX} characters`);
        if ((s.description ?? '').length > DESCRIPTION_MAX) invalid(`description is over ${DESCRIPTION_MAX} characters`);
        if (s.caption !== undefined) invalid('a photo post has a title and a description, not a caption');
    }
    for (const k of ['allowComments', 'allowReuse', 'aiGenerated', 'discloseContent'] as const) if (typeof s[k] !== 'boolean') invalid(`${k} is true or false`);
    const { kind, caption, title, description, privacy, allowComments, allowReuse, aiGenerated, discloseContent } = s;
    return { kind, caption, title, description, privacy, allowComments, allowReuse, aiGenerated, discloseContent };
}

export async function prepareDraft(input: { files: string[]; settings: PostSettings; account: string; public?: boolean }): Promise<Draft> {
    const settings = checkSettings(input.settings, input.files.length, input.public === true);
    const ext = settings.kind === 'video' ? VIDEO_EXT : PHOTO_EXT;
    const media: DraftMedia[] = [];
    for (const f of input.files) {
        const p = path.resolve(f);
        if (!ext.has(path.extname(p).toLowerCase())) invalid(`${path.basename(p)}: extension not allowed for a ${settings.kind} (${[...ext].join(' ')})`);
        const { sha256, bytes } = await hashFile(p);
        if (bytes === 0) invalid(`${path.basename(p)} is empty`);
        media.push({ path: p, sha256, bytes, manualFilePick: bytes > UPLOAD_TOOL_MAX_BYTES });
    }
    const account = normalizeAccount(input.account);
    if (!account) invalid('account is empty');
    const base = { account, media, settings };
    return { schema: 'tt.draft.v1', ...base, digest: approvalDigest(base), createdAt: new Date().toISOString() };
}

/** Re-hashes every file and recomputes the digest; any difference voids the approval. */
export async function verifyDraft(d: Draft): Promise<void> {
    if (approvalDigest(d) !== d.digest) throw new TtError('approval_mismatch', 'The draft changed after it was prepared. Prepare it again and get a new approval.');
    for (const m of d.media) {
        let now: { sha256: string; bytes: number };
        try {
            now = await hashFile(m.path);
        } catch {
            throw new TtError('approval_mismatch', `${m.path} is gone since the draft was prepared.`);
        }
        if (now.sha256 !== m.sha256 || now.bytes !== m.bytes) throw new TtError('approval_mismatch', `${path.basename(m.path)} changed since the draft was prepared. Prepare it again and get a new approval.`);
    }
}

/**
 * Post variants that have passed a live run (design §4: the first live write of each type needs
 * --experimental until it has passed). Add a variant here only with its evidence in docs/reviews/.
 *   video-private: docs/reviews/evidence-publish-live.md (2026-11-16)
 */
// Passed live: video-private (attempt 20261116130631-cd382e), photo carousel, private (20261116175906-aea64e).
export const VERIFIED_VARIANTS: readonly string[] = ['video-private', 'photo'];

/** The variants a draft exercises that have not passed live yet; non-empty means `begin` needs --experimental. */
export function experimentalVariants(s: PostSettings): string[] {
    const v = [s.kind === 'photo' ? 'photo' : 'video-private'];
    if (s.privacy !== 'only_me') v.push('non-private');
    if (s.aiGenerated) v.push('ai-label');
    if (s.discloseContent) v.push('disclosure');
    return v.filter((x) => !VERIFIED_VARIANTS.includes(x));
}
