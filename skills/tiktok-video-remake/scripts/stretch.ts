/**
 * Stretches: the runs a source is cut into for generation. A shot of up to 10 s is one stretch; a longer one is
 * split into consecutive stretches of at most 10 s that overlap by 8 frames, and `place` joins them with a crossfade
 * over the overlap, so every source frame of the shot appears exactly once. Pure functions: frame arithmetic only.
 */
import { scenes, type Scene } from './cadence.ts';
import { SWAP_MAX_SECONDS } from './graphs.ts';

/** Frames two neighbouring stretches of one shot share. */
export const OVERLAP_FRAMES = 8;

export interface Stretch {
    /** `s<scene>` for a shot that is one stretch, `s<scene>_<k>` (k from 1) for the stretches of a long one. */
    id: string;
    scene: number;
    first: number;
    /** Exclusive. */
    end: number;
}

/** The most frames one run takes at this frame rate (10 s). */
export function maxStretchFrames(fps: number): number {
    return Math.floor(SWAP_MAX_SECONDS * fps + 1e-6);
}

export function stretchesOfScene(scene: Scene, fps: number): Stretch[] {
    const frames = scene.end - scene.first;
    const max = maxStretchFrames(fps);
    if (frames <= max) return [{ id: `s${scene.n}`, scene: scene.n, first: scene.first, end: scene.end }];
    // n runs whose lengths, less the overlaps, add up to the shot: total = frames + (n - 1) * overlap, shared evenly.
    const n = Math.ceil((frames - OVERLAP_FRAMES) / (max - OVERLAP_FRAMES));
    const total = frames + (n - 1) * OVERLAP_FRAMES;
    const out: Stretch[] = [];
    let first = scene.first;
    for (let i = 0; i < n; i++) {
        const len = Math.floor(total / n) + (i < total % n ? 1 : 0);
        out.push({ id: `s${scene.n}_${i + 1}`, scene: scene.n, first, end: first + len });
        first += len - OVERLAP_FRAMES;
    }
    return out;
}

/** Every stretch of the source, in playing order. */
export function sceneStretches(cuts: number[], frames: number, fps: number): Stretch[] {
    return scenes(cuts, frames).flatMap((sc) => stretchesOfScene(sc, fps));
}

/**
 * The frames of a stretch a person looks at to find the subject: every `floor(fps / 4)`th frame and always the last,
 * so no two are more than 0.25 s apart and a person who enters and leaves between two samples is still seen.
 */
export function stripFrames(first: number, end: number, fps: number): number[] {
    const step = Math.max(1, Math.floor(fps / 4 + 1e-9));
    const out: number[] = [];
    for (let f = first; f < end; f += step) out.push(f);
    if (out.at(-1) !== end - 1) out.push(end - 1);
    return out;
}

/** The time of a frame on the source's own clock. */
export const frameTime = (frame: number, fps: number): number => frame / fps;

/** The frame nearest to a time. */
export const timeFrame = (t: number, fps: number): number => Math.round(t * fps);

/**
 * Frames a half of a split stretch must have when it meets a neighbouring stretch's overlap (the seed frame counts
 * for both halves), so the half can be generated and then joined to that neighbour over the 8 shared frames.
 */
export const MIN_HALF_FRAMES = OVERLAP_FRAMES + 1;
/** Frames a half needs when it borders no neighbour: the two halves share one frame, so each needs more than that. */
export const MIN_FREE_HALF_FRAMES = 2;
