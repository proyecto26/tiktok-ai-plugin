/**
 * Per-file analysis behind `score` and `render`: sharpness (ffmpeg blurdetect), motion (frame differences, with the
 * centroid of what moves), exposure (signalstats), duration fit, and faces only through a local detector the user
 * configures (TT_FACE_CMD). Nothing is downloaded and nothing leaves the machine.
 */
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { clamp01, must, round3, run } from './ff.ts';
import type { Item } from './media.ts';

export const WEIGHTS = { sharpness: 0.35, motion: 0.25, exposure: 0.25, duration_fit: 0.15, faces: 0.2 } as const;
export type Term = keyof typeof WEIGHTS;

// Editorial thresholds (not TikTok rules): a clip of 4 to 30 s is a comfortable source for a short cut.
export const FIT_MIN = 4;
export const FIT_MAX = 30;
const BLUR_BAD = 20; // blurdetect value (on a 640 px wide frame) that scores 0
const MOTION_FULL = 0.06; // mean absolute frame difference (0..1) that scores 1
const MOTION_PIXEL_FLOOR = 16; // gray levels a pixel must change by to count towards the centroid
const IDEAL_LUMA = 118; // mean luma (0..255, limited range) that scores 1

export function durationFit(d: number | null): number | null {
    if (d === null) return null;
    if (d < FIT_MIN) return round3(Math.max(0, d / FIT_MIN));
    if (d > FIT_MAX) return round3(FIT_MAX / d);
    return 1;
}

export function combine(terms: Record<Term, number | null>): { total: number; used: Term[] } {
    const used = (Object.keys(WEIGHTS) as Term[]).filter((t) => terms[t] !== null && Number.isFinite(terms[t]));
    const w = used.reduce((s, t) => s + WEIGHTS[t], 0);
    const total = w ? used.reduce((s, t) => s + WEIGHTS[t] * (terms[t] as number), 0) / w : 0;
    return { total: round3(total), used };
}

// ---- faces (optional local detector) ----------------------------------------------------------------------------

export function resolveFaceCmd(env: Record<string, string | undefined> = process.env): string | null {
    const c = env.TT_FACE_CMD?.trim();
    return c ? c : null;
}

/** Splits a command template on spaces (double quotes group), replaces {file}, appends the file when there is no placeholder. */
export function splitCommand(template: string, file: string): string[] {
    const parts: string[] = [];
    const re = /"([^"]*)"|(\S+)/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(template))) parts.push(m[1] ?? m[2]);
    let had = false;
    const out = parts.map((p) => {
        if (p.includes('{file}')) had = true;
        return p.split('{file}').join(file);
    });
    if (!had) out.push(file);
    return out;
}

export interface Box {
    x: number;
    y: number;
    w: number;
    h: number;
}

/** Accepts `[{x,y,w,h}]` or `{boxes|faces: [...]}`, fractions of the frame (values above 1 are pixels of the frame given). */
export function parseBoxes(stdout: string, frameW: number, frameH: number): Box[] {
    const j = JSON.parse(stdout);
    const arr: any[] = Array.isArray(j) ? j : Array.isArray(j?.boxes) ? j.boxes : Array.isArray(j?.faces) ? j.faces : [];
    const out: Box[] = [];
    for (const b of arr) {
        const [x, y, w, h] = [b?.x, b?.y, b?.w, b?.h].map(Number);
        if (![x, y, w, h].every(Number.isFinite) || w <= 0 || h <= 0) continue;
        const px = Math.max(x, y, x + w, y + h) > 1.0001;
        out.push(px ? { x: x / frameW, y: y / frameH, w: w / frameW, h: h / frameH } : { x, y, w, h });
    }
    return out;
}

export interface Faces {
    detector: 'TT_FACE_CMD';
    count: number;
    frames_checked: number;
    centre: [number, number] | null;
}

async function detectFaces(item: Pick<Item, 'path' | 'kind' | 'duration' | 'width' | 'height'>, cmd: string): Promise<Faces> {
    const tmp = await mkdtemp(path.join(os.tmpdir(), 'tt-faces-'));
    try {
        const stamps = item.kind === 'photo' || !item.duration ? [0] : [0.25, 0.5, 0.75].map((f) => (item.duration as number) * f);
        const fw = Math.min(960, item.width);
        const fh = Math.round((fw * item.height) / item.width);
        let n = 0;
        const boxes: Box[] = [];
        let maxCount = 0;
        for (const [i, t] of stamps.entries()) {
            const jpg = path.join(tmp, `f${i}.jpg`);
            await must('ffmpeg', ['-hide_banner', '-nostdin', '-y', '-v', 'error', ...(t ? ['-ss', String(t)] : []), '-i', item.path, '-frames:v', '1', '-vf', `scale=${fw}:-2`, '-update', '1', jpg]);
            const argv = splitCommand(cmd, jpg);
            const r = await run(argv[0], argv.slice(1), 60_000);
            if (r.code !== 0) throw new Error(`exit ${r.code}: ${r.stderr.trim().split(/\r?\n/).slice(-1)[0] ?? ''}`);
            const b = parseBoxes(r.stdout.toString('utf8'), fw, fh);
            n++;
            maxCount = Math.max(maxCount, b.length);
            boxes.push(...b);
        }
        const area = boxes.reduce((s, b) => s + b.w * b.h, 0);
        const centre: [number, number] | null = area ? [round3(boxes.reduce((s, b) => s + (b.x + b.w / 2) * b.w * b.h, 0) / area), round3(boxes.reduce((s, b) => s + (b.y + b.h / 2) * b.w * b.h, 0) / area)] : null;
        return { detector: 'TT_FACE_CMD', count: maxCount, frames_checked: n, centre };
    } finally {
        await rm(tmp, { recursive: true, force: true });
    }
}

// ---- motion -----------------------------------------------------------------------------------------------------

const GRID = 96;

export interface Motion {
    mean: number;
    score: number;
    /** Where the change is, as fractions of the displayed frame; null when nothing moves. */
    centroid: [number, number] | null;
    /** Start (s) of the most active window of the target length. */
    best_start: number;
    samples: number;
}

export async function analyseMotion(item: Pick<Item, 'path' | 'duration'>, length: number): Promise<Motion> {
    const d = item.duration ?? 0;
    const fps = Math.min(4, Math.max(0.5, 120 / Math.max(d, 1)));
    const r = await must('ffmpeg', ['-hide_banner', '-nostdin', '-v', 'error', '-i', item.path, '-vf', `fps=${fps},scale=${GRID}:${GRID},format=gray`, '-f', 'rawvideo', '-']);
    const buf = r.stdout;
    const size = GRID * GRID;
    const frames = Math.floor(buf.length / size);
    const per: number[] = [];
    let wx = 0;
    let wy = 0;
    let wsum = 0;
    for (let f = 1; f < frames; f++) {
        let sum = 0;
        const a = (f - 1) * size;
        const b = f * size;
        for (let i = 0; i < size; i++) {
            const diff = Math.abs(buf[b + i] - buf[a + i]);
            sum += diff;
            if (diff > MOTION_PIXEL_FLOOR) {
                const w = diff - MOTION_PIXEL_FLOOR;
                wx += w * ((i % GRID) + 0.5);
                wy += w * (Math.floor(i / GRID) + 0.5);
                wsum += w;
            }
        }
        per.push(sum / size / 255);
    }
    const mean = per.length ? per.reduce((s, x) => s + x, 0) / per.length : 0;
    // A few stray pixels are codec noise, not movement.
    const centroid: [number, number] | null = wsum > 400 ? [round3(wx / wsum / GRID), round3(wy / wsum / GRID)] : null;
    let best = 0;
    if (d > length && per.length) {
        const win = Math.max(1, Math.round(length * fps));
        let cur = per.slice(0, win).reduce((s, x) => s + x, 0);
        let top = cur;
        for (let s = 1; s + win <= per.length; s++) {
            cur += per[s + win - 1] - per[s - 1];
            if (cur > top) {
                top = cur;
                best = s;
            }
        }
        best = Math.min(round3(best / fps), Math.max(0, round3(d - length)));
    }
    return { mean: round3(mean), score: round3(clamp01(mean / MOTION_FULL)), centroid, best_start: best, samples: frames };
}

// ---- sharpness + exposure ---------------------------------------------------------------------------------------

async function stats(item: Pick<Item, 'path' | 'kind' | 'duration'>): Promise<{ blur: number | null; yavg: number | null; method: 'blurdetect' | 'unavailable' }> {
    const d = item.duration ?? 0;
    const pre = item.kind === 'video' ? `fps=${Math.min(2, Math.max(0.25, 12 / Math.max(d, 1)))},` : '';
    const attempt = async (withBlur: boolean) =>
        run('ffmpeg', ['-hide_banner', '-nostdin', '-v', 'error', '-i', item.path, '-vf', `${pre}scale=640:-2,${withBlur ? 'blurdetect,' : ''}signalstats,metadata=mode=print:file=-`, '-f', 'null', '-']);
    let method: 'blurdetect' | 'unavailable' = 'blurdetect';
    let r = await attempt(true);
    if (r.code !== 0) {
        method = 'unavailable'; // an ffmpeg older than 7.0 has no blurdetect filter
        r = await attempt(false);
        if (r.code !== 0) throw new Error(`ffmpeg could not analyse ${item.path}: ${r.stderr.trim().split(/\r?\n/).slice(-1)[0]}`);
    }
    const text = r.stdout.toString('utf8');
    const grab = (key: string) => [...text.matchAll(new RegExp(`${key}=([-\\d.eE+naif]+)`, 'g'))].map((m) => Number(m[1])).filter((n) => Number.isFinite(n));
    const med = (xs: number[]) => (xs.length ? [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)] : null);
    const y = grab('lavfi\\.signalstats\\.YAVG');
    return { blur: method === 'blurdetect' ? med(grab('lavfi\\.blur')) : null, yavg: y.length ? y.reduce((s, x) => s + x, 0) / y.length : null, method };
}

export interface Analysis {
    sharpness: { blur: number | null; score: number | null; method: 'blurdetect' | 'unavailable' };
    motion: Motion | null;
    exposure: { yavg: number | null; score: number | null };
    duration_fit: number | null;
    faces: Faces | null;
    faces_note: string | null;
}

export async function analyse(item: Pick<Item, 'path' | 'kind' | 'duration' | 'width' | 'height'>, opts: { faceCmd?: string | null; length?: number } = {}): Promise<Analysis> {
    const faceCmd = opts.faceCmd === undefined ? resolveFaceCmd() : opts.faceCmd;
    const s = await stats(item);
    const motion = item.kind === 'video' ? await analyseMotion(item, opts.length ?? 15) : null;
    let faces: Faces | null = null;
    let note: string | null = null;
    if (!faceCmd) note = 'faces not scored: TT_FACE_CMD is not configured (a local face detector that prints boxes as JSON); nothing is downloaded.';
    else {
        try {
            faces = await detectFaces(item, faceCmd);
        } catch (e) {
            note = `faces not scored: TT_FACE_CMD failed (${(e as Error).message.split('\n')[0]})`;
        }
    }
    return {
        sharpness: { blur: s.blur === null ? null : round3(s.blur), score: s.blur === null ? null : round3(clamp01(1 - s.blur / BLUR_BAD)), method: s.method },
        motion,
        exposure: { yavg: s.yavg === null ? null : round3(s.yavg), score: s.yavg === null ? null : round3(clamp01(1 - Math.abs(s.yavg - IDEAL_LUMA) / IDEAL_LUMA)) },
        duration_fit: durationFit(item.duration),
        faces,
        faces_note: note,
    };
}

/** Faces help a pick but their absence is not a defect (a landscape shot has none). */
export const facesTerm = (f: Faces | null): number | null => (f ? (f.count > 0 ? 1 : 0.4) : null);

export function termsOf(a: Analysis): Record<Term, number | null> {
    return { sharpness: a.sharpness.score, motion: a.motion?.score ?? null, exposure: a.exposure.score, duration_fit: a.duration_fit, faces: facesTerm(a.faces) };
}

/** Where to aim the 9:16 crop: faces centre, else motion centroid, else the centre. */
export function chooseFocus(a: Pick<Analysis, 'faces' | 'motion'>): { x: number; y: number; source: 'faces' | 'motion' | 'centre' } {
    if (a.faces?.centre) return { x: a.faces.centre[0], y: a.faces.centre[1], source: 'faces' };
    if (a.motion?.centroid) return { x: a.motion.centroid[0], y: a.motion.centroid[1], source: 'motion' };
    return { x: 0.5, y: 0.5, source: 'centre' };
}
