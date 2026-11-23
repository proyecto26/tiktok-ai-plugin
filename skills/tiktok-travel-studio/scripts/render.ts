/**
 * Vertical 1080x1920 cuts. Focus order: --focus override, faces centre, motion centroid, centre. Rotation metadata is
 * honoured (ffmpeg rotates on decode and the crop is computed on the displayed frame). A variable-rate source is
 * rendered from a constant-rate copy so audio and picture cannot drift and the output rate is exact.
 */
import { mkdir, rm } from 'node:fs/promises';
import path from 'node:path';

import { analyseMotion, chooseFocus, detectFaces, resolveFaceCmd, type Faces } from './analyse.ts';
import { ToolError, ffmpeg, round3 } from './ff.ts';
import type { Item } from './media.ts';

export const OUT_W = 1080;
export const OUT_H = 1920;
export const DEFAULT_LENGTH = 15;

export function parseFocus(s: string): [number, number] {
    const m = s.match(/^\s*(-?\d*\.?\d+)\s*,\s*(-?\d*\.?\d+)\s*$/);
    const x = m ? Number(m[1]) : NaN;
    const y = m ? Number(m[2]) : NaN;
    if (!(x >= 0 && x <= 1 && y >= 0 && y <= 1)) throw new ToolError('bad_focus', `--focus must be "x,y" with both between 0 and 1 (fractions of the displayed frame), got "${s}".`);
    return [x, y];
}

/** Scale to cover w x h, then crop so the focus point sits as close to the centre of the window as the frame allows. */
export function coverCrop(w: number, h: number, fx: number, fy: number): string {
    return `scale=${w}:${h}:force_original_aspect_ratio=increase,crop=${w}:${h}:x='min(max(${fx}*iw-${w / 2},0),iw-${w})':y='min(max(${fy}*ih-${h / 2},0),ih-${h})',setsar=1`;
}

const COMMON = [23.976, 24, 25, 29.97, 30, 50, 59.94, 60];
/** The output rate follows the source: snapped to a common rate when within 1.5 %, kept between 15 and 60. */
export function pickFps(avg: number | null): number {
    const f = avg && avg > 0 ? avg : 30;
    const snap = COMMON.find((c) => Math.abs(c - f) / c < 0.015);
    return Math.min(60, Math.max(15, snap ?? Math.round(f * 100) / 100));
}

export interface RenderOpts {
    length?: number;
    start?: number;
    focus?: [number, number] | null;
    /** Face detector command; undefined reads TT_FACE_CMD, null disables. */
    faceCmd?: string | null;
    keepAudio?: boolean;
    name?: string;
}

export interface RenderReport {
    input: string;
    output: string;
    width: number;
    height: number;
    fps: number;
    start: number;
    duration: number;
    focus: { x: number; y: number; source: 'override' | 'faces' | 'motion' | 'centre' };
    rotation: number;
    displayed: [number, number];
    cfr_copy: boolean;
    audio: boolean;
    notes: string[];
}

export async function renderClip(item: Item, outDir: string, opts: RenderOpts = {}): Promise<RenderReport> {
    if (item.kind !== 'video') throw new ToolError('not_a_video', `${item.path} is a photo; use the photos command.`);
    const length = opts.length ?? DEFAULT_LENGTH;
    if (!(length > 0)) throw new ToolError('bad_length', '--length must be above 0 seconds.');
    const dur = item.duration ?? 0;
    const notes: string[] = [];
    const faceCmd = opts.faceCmd === undefined ? resolveFaceCmd() : opts.faceCmd;

    let focus: RenderReport['focus'];
    let motion = null as Awaited<ReturnType<typeof analyseMotion>> | null;
    if (opts.start === undefined || !opts.focus) motion = await analyseMotion(item, length);
    if (opts.focus) focus = { x: opts.focus[0], y: opts.focus[1], source: 'override' };
    else {
        let faces: Faces | null = null;
        if (faceCmd) {
            try {
                faces = await detectFaces(item, faceCmd);
            } catch (e) {
                notes.push(`faces not used: TT_FACE_CMD failed (${(e as Error).message.split('\n')[0]})`);
            }
        } else notes.push('faces not used: TT_FACE_CMD is not configured');
        const c = chooseFocus({ faces, motion });
        focus = { x: round3(c.x), y: round3(c.y), source: c.source };
    }

    const start = Math.max(0, Math.min(opts.start ?? motion?.best_start ?? 0, Math.max(0, dur - 0.1)));
    const duration = round3(Math.min(length, dur - start));
    const fps = pickFps(item.fps);
    const keepAudio = !!opts.keepAudio && item.has_audio;
    const base = opts.name ?? `${path.basename(item.path, path.extname(item.path))}_9x16`;
    await mkdir(outDir, { recursive: true });
    const output = path.join(outDir, `${base}.mp4`);

    let source = item.path;
    let cfrFile: string | null = null;
    if (item.variable_rate) {
        const work = path.join(outDir, '.work');
        await mkdir(work, { recursive: true });
        cfrFile = path.join(work, `${base}_cfr.mp4`);
        await ffmpeg(['-i', item.path, '-vf', `fps=${fps}`, '-fps_mode', 'cfr', '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '14', '-pix_fmt', 'yuv420p', ...(keepAudio ? ['-c:a', 'aac', '-b:a', '160k'] : ['-an']), cfrFile]);
        source = cfrFile;
    }
    try {
        await ffmpeg(['-ss', String(start), '-i', source, '-t', String(duration), '-vf', coverCrop(OUT_W, OUT_H, focus.x, focus.y), '-r', String(fps), '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20', '-pix_fmt', 'yuv420p', ...(keepAudio ? ['-c:a', 'aac', '-b:a', '160k'] : ['-an']), '-movflags', '+faststart', output]);
    } finally {
        if (cfrFile) await rm(cfrFile, { force: true });
    }
    if (item.has_audio && !keepAudio) notes.push('source audio dropped (use --keep-audio to keep it; music adds a new track)');
    if (duration < length) notes.push(`clip is ${round3(dur)} s, shorter than the ${length} s target: kept whole, never looped or padded`);
    return { input: item.path, output, width: OUT_W, height: OUT_H, fps, start: round3(start), duration, focus, rotation: item.rotation, displayed: [item.width, item.height], cfr_copy: !!cfrFile, audio: keepAudio, notes };
}
