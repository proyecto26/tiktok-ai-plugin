/**
 * The frame time base: every measurement is a frame index on one constant-rate file; seconds are derived.
 *
 * SHARED MODULE: this file is byte-identical in instagram-ai-plugin and tiktok-ai-plugin (after CRLF→LF).
 * Change both copies together and update SHARED.sha256 next to it; the tests compare the hashes.
 */
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';

import { ffmpeg, run } from './ff.ts';

export const SHARED_MODULE = 'timebase@1';

export interface Timebase {
    /** The rate as a rational, e.g. "30000/1001". */
    rate: string;
    fps: number;
    /** Exact frame count of `file`. */
    frames: number;
    /** Presentation time of the first frame, in seconds; frame indices count from it. */
    start_time: number;
    /**
     * Seconds from the start of the file's clock (where ffmpeg filters and `-ss` count from) to the first
     * video frame: non-zero when the video track starts after the audio. Filter times minus this are frame times.
     */
    clock_offset: number;
    /** The file every step reads, relative to the breakdown folder, with forward slashes. */
    file: string;
    sha256: string;
    /** `file` is a constant-rate copy made because the source has a variable frame rate. */
    cfr_copy: boolean;
}

export function parseRate(r: string): { num: number; den: number } {
    const m = /^\s*(\d+)(?:\s*\/\s*(\d+))?\s*$/.exec(String(r ?? ''));
    if (!m) throw new Error(`Not a frame rate: "${r}".`);
    const num = Number(m[1]);
    const den = m[2] === undefined ? 1 : Number(m[2]);
    if (!(num > 0) || !(den > 0)) throw new Error(`Not a frame rate: "${r}".`);
    return { num, den };
}

/** Time of frame `n` from the first frame (unrounded). */
export function frameToSec(n: number, rate: string): number {
    const { num, den } = parseRate(rate);
    return (n * den) / num;
}

/** Nearest frame to time `t` (seconds on the file's clock), counted from the first frame; never below 0. */
export function secToFrame(t: number, rate: string, start_time = 0): number {
    const { num, den } = parseRate(rate);
    return Math.max(0, Math.round(((t - start_time) * num) / den));
}

/** The shortest shot detection keeps, in frames: a quarter of a second, rounded up. */
export function minShotFrames(rate: string): number {
    const { num, den } = parseRate(rate);
    return Math.ceil((0.25 * num) / den - 1e-9);
}

/** How many timestamps sit more than a third of a frame off the constant grid first + i / fps. */
export function countUneven(pts: number[], fps: number): number {
    if (!pts.length || !(fps > 0)) return 0;
    const s = [...pts].sort((a, b) => a - b);
    let bad = 0;
    for (let i = 0; i < s.length; i++) if (Math.abs(s[i] - s[0] - i / fps) > 1 / (3 * fps)) bad++;
    return bad;
}

/** Rate, exact frame count (packets, no decode), first-frame time and whether the frames are unevenly spaced. */
export async function probeRate(file: string): Promise<{ rate: string; fps: number; avg_fps: number; frames: number; start_time: number; clock_offset: number; variable: boolean }> {
    const r = await run('ffprobe', ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=r_frame_rate,avg_frame_rate,start_time:packet=pts_time,flags:format=start_time', '-of', 'json', file]);
    if (r.code !== 0) throw new Error(`ffprobe could not read ${file}: ${r.stderr.trim().slice(-300)}`);
    const j = JSON.parse(r.stdout.toString('utf8'));
    const v = j.streams?.[0];
    if (!v) throw new Error(`${file} has no video stream.`);
    const nominal = parseRate(v.r_frame_rate);
    const fps = nominal.num / nominal.den;
    let avg = 0;
    try {
        const a = parseRate(v.avg_frame_rate);
        avg = a.num / a.den;
    } catch {
        avg = fps;
    }
    // Packets an edit list discards (flag D, e.g. before the in-point of a stream-copy trim) are never shown.
    const shown = (j.packets ?? []).filter((p: any) => !String(p.flags ?? '').includes('D'));
    const pts = shown.map((p: any) => Number(p.pts_time)).filter((n: number) => Number.isFinite(n));
    const start = pts.length ? Math.min(...pts) : Number(v.start_time) || 0;
    const fileStart = Number(j.format?.start_time);
    const clock = Number.isFinite(fileStart) ? Math.max(0, start - Math.max(0, fileStart)) : 0;
    const variable = Math.abs(avg - fps) / fps > 0.005 || countUneven(pts, fps) > 0;
    return { rate: `${nominal.num}/${nominal.den}`, fps, avg_fps: avg, frames: pts.length, start_time: start, clock_offset: Math.round(clock * 1e6) / 1e6, variable };
}

/** sha256 of a file, streamed. */
export function sha256File(file: string): Promise<string> {
    return new Promise((resolve, reject) => {
        const h = createHash('sha256');
        createReadStream(file)
            .on('data', (c) => h.update(c))
            .on('error', reject)
            .on('end', () => resolve(h.digest('hex')));
    });
}

/** A constant-rate working copy of a variable-rate source (the command the remake prints for the same case). */
export async function cfrCopy(src: string, dest: string, fps: number): Promise<void> {
    await ffmpeg(['-i', src, '-fps_mode', 'cfr', '-r', String(Math.round(fps)), '-c:v', 'libx264', '-crf', '12', '-c:a', 'copy', dest]);
}

const SIG_W = 64;
const SIG_H = 36;

/** Mean absolute difference between consecutive 64x36 gray frames first..first+count-1 (length count-1). */
export async function frameDiffsAround(file: string, tb: { rate: string; start_time: number }, first: number, count: number): Promise<number[]> {
    const half = frameToSec(0.5, tb.rate);
    const at = frameToSec(Math.max(0, first), tb.rate);
    const seek = Math.max(0, at - 1);
    const from = tb.start_time + at - half;
    const r = await run('ffmpeg', ['-hide_banner', '-nostdin', '-loglevel', 'error', '-ss', seek.toFixed(6), '-copyts', '-i', file, '-an', '-vf', `select='gte(t\\,${from.toFixed(6)})',scale=${SIG_W}:${SIG_H},format=gray`, '-fps_mode', 'passthrough', '-frames:v', String(count), '-f', 'rawvideo', '-']);
    if (r.code !== 0) throw new Error(`ffmpeg could not read frames of ${file}: ${r.stderr.trim().slice(-300)}`);
    const size = SIG_W * SIG_H;
    const n = Math.floor(r.stdout.length / size);
    const out: number[] = [];
    for (let i = 1; i < n; i++) {
        let sum = 0;
        for (let k = 0; k < size; k++) sum += Math.abs(r.stdout[i * size + k] - r.stdout[(i - 1) * size + k]);
        out.push(sum / size);
    }
    return out;
}

/**
 * The frame within two of `center` where the picture changes most. `diffs[i]` is the change between frame
 * `first + i` and `first + i + 1`, so a change at diffs[i] makes frame `first + i + 1` the first of a new shot.
 * Under `floor` nothing changed enough: the centre is kept and `mad` is null.
 */
export function snapToChange(diffs: number[], first: number, center: number, floor = 4): { frame: number; moved: number; mad: number | null } {
    let best = -1;
    let bestMad = -Infinity;
    for (let f = center - 2; f <= center + 2; f++) {
        const i = f - first - 1;
        if (i < 0 || i >= diffs.length) continue;
        if (diffs[i] > bestMad) {
            bestMad = diffs[i];
            best = f;
        }
    }
    if (best < 0 || bestMad < floor) return { frame: center, moved: 0, mad: null };
    return { frame: best, moved: best - center, mad: Math.round(bestMad * 100) / 100 };
}
