/** Photo-post sets: JPEG crops at 9:16 (1080x1920) and/or 4:5 (1080x1350), in sets that never exceed the photo-mode limit. */
import { mkdir } from 'node:fs/promises';
import path from 'node:path';

import { detectFaces, resolveFaceCmd } from './analyse.ts';
import { ToolError, ffmpeg } from './ff.ts';
import { probeMedia } from './media.ts';
import { coverCrop } from './render.ts';

/**
 * Most images one TikTok photo post may carry in the web photo mode. 35 is the working number from the owner's
 * recon notes; it MUST be confirmed against the live photo composer before relying on it (TikTok has changed this
 * limit before). Change it here only: `photos` refuses larger sets and splits bigger batches into several sets.
 */
export const PHOTO_POST_MAX = 35;

export type Ratio = '9:16' | '4:5';
export const SIZES: Record<Ratio, [number, number]> = { '9:16': [1080, 1920], '4:5': [1080, 1350] };

export interface PhotoSet {
    id: string;
    ratio: Ratio;
    size: [number, number];
    files: string[];
    count: number;
}

export interface PhotoOpts {
    outDir: string;
    ratio: Ratio | 'both';
    perSet?: number;
    focus?: [number, number] | null;
    focusByPath?: Record<string, [number, number] | null | undefined>;
    faceCmd?: string | null;
}

export async function buildPhotoSets(files: string[], opts: PhotoOpts): Promise<{ sets: PhotoSet[]; warnings: string[]; focus_sources: string[] }> {
    if (!files.length) throw new ToolError('no_photos', 'No photos were given.', 'Pass image files, or --shortlist with photo entries.');
    const perSet = opts.perSet ?? PHOTO_POST_MAX;
    if (!Number.isInteger(perSet) || perSet < 1 || perSet > PHOTO_POST_MAX) throw new ToolError('photo_limit', `A photo post holds at most ${PHOTO_POST_MAX} images; --per-set ${perSet} is not allowed.`, `Use --per-set ${PHOTO_POST_MAX} or lower. The limit is PHOTO_POST_MAX in scripts/photos.ts and still has to be confirmed in the live composer.`);
    const ratios: Ratio[] = opts.ratio === 'both' ? ['9:16', '4:5'] : [opts.ratio];
    const faceCmd = opts.faceCmd === undefined ? resolveFaceCmd() : opts.faceCmd;
    const warnings: string[] = [];

    const prepared: { src: string; w: number; h: number; focus: [number, number]; source: string }[] = [];
    for (const f of files) {
        const it = await probeMedia(f);
        if (it.kind !== 'photo') throw new ToolError('not_a_photo', `${f} is a video; photo posts take images only.`, 'Use render for videos.');
        let focus: [number, number] = [0.5, 0.5];
        let source = 'centre';
        const manual = opts.focusByPath?.[path.resolve(f)] ?? opts.focus;
        if (manual) {
            focus = manual;
            source = 'override';
        } else if (faceCmd) {
            try {
                const faces = await detectFaces(it, faceCmd);
                if (faces.centre) {
                    focus = faces.centre;
                    source = 'faces';
                }
            } catch (e) {
                warnings.push(`faces not used for ${path.basename(f)}: ${(e as Error).message.split('\n')[0]}`);
            }
        }
        prepared.push({ src: it.path, w: it.width, h: it.height, focus, source });
    }

    const sets: PhotoSet[] = [];
    let upscaled = 0;
    for (let s = 0; s * perSet < prepared.length; s++) {
        const chunk = prepared.slice(s * perSet, (s + 1) * perSet);
        for (const ratio of ratios) {
            const [W, H] = SIZES[ratio];
            const id = `set-${s + 1}-${ratio.replace(':', 'x')}`;
            const dir = path.join(opts.outDir, id);
            await mkdir(dir, { recursive: true });
            const out: string[] = [];
            for (const [i, ph] of chunk.entries()) {
                const dest = path.join(dir, `${String(i + 1).padStart(2, '0')}_${path.basename(ph.src, path.extname(ph.src))}.jpg`);
                await ffmpeg(['-i', ph.src, '-vf', coverCrop(W, H, ph.focus[0], ph.focus[1]), '-frames:v', '1', '-update', '1', '-q:v', '2', dest]);
                if (Math.max(W / ph.w, H / ph.h) > 1) upscaled++;
                out.push(path.resolve(dest));
            }
            sets.push({ id, ratio, size: [W, H], files: out, count: out.length });
        }
    }
    if (upscaled) warnings.push(`${upscaled} crop(s) were upscaled: the source is smaller than the output (soft result; use a larger original)`);
    if (prepared.length > perSet) warnings.push(`${prepared.length} photos do not fit one post (limit ${perSet}): split into ${Math.ceil(prepared.length / perSet)} sets`);
    return { sets, warnings, focus_sources: prepared.map((p) => p.source) };
}
