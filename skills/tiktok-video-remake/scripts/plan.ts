/**
 * The identity card, the per-stretch targets a model fills in by looking at the source, and the plan built from them.
 * Pure functions: no files, no network. main.ts reads and writes the files.
 *
 *  - identity_card.json   what the identity photo shows (hair, face, skin, build, marks, jewellery, wardrobe)
 *  - targets.json         per stretch: is the subject there, where, and what the shot looks like
 *  - plan.json            per run: swap or keep, the point, the crop, the tier and the prompt
 *
 * The prompt is built from the card and the targets and nothing else: scene content is never typed by the user.
 */
import { createHash } from 'node:crypto';

import { SWAP_DEFAULTS } from './graphs.ts';
import type { Rect } from './graphs.ts';
import { SCHEMA } from './manifest.ts';
import { MIN_FREE_HALF_FRAMES, MIN_HALF_FRAMES, frameTime, timeFrame, type Stretch } from './stretch.ts';

/** The plan's schema name follows the manifest's (`<prefix>.remake.v1` -> `<prefix>.remake.plan.v1`), so this file is the same in both plugins. */
export const PLAN_SCHEMA = SCHEMA.replace(/\.v1$/, '.plan.v1');

export interface Validation {
    ok: boolean;
    errors: string[];
}
const result = (errors: string[]): Validation => ({ ok: errors.length === 0, errors });

/** Collapses white space and drops a trailing full stop, so sentences can be joined without doubled punctuation. */
export const clean = (s: unknown): string => String(s ?? '').replace(/\s+/g, ' ').trim().replace(/[.\s]+$/, '');
const text = (v: unknown): v is string => typeof v === 'string' && clean(v).length > 0;
const num = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

// ---------------------------------------------------------------- identity card

export const CARD_FIELDS = ['hair', 'face', 'skin', 'build', 'distinctive_marks', 'jewellery', 'default_wardrobe'] as const;
export type Card = Record<(typeof CARD_FIELDS)[number], string>;

export function validateCard(card: unknown): Validation {
    if (!card || typeof card !== 'object' || Array.isArray(card)) return result(['identity_card.json must be an object with the fields ' + CARD_FIELDS.join(', ') + '.']);
    const errors: string[] = [];
    for (const k of CARD_FIELDS) {
        const v = (card as Record<string, unknown>)[k];
        if (!text(v)) errors.push(`${k} is required: a short description of what the photo shows ("none" when there is nothing to describe).`);
        else if (clean(v).length > 240) errors.push(`${k} is too long (240 characters at most).`);
    }
    return result(errors);
}

/** The character card text: the same words in every shot. */
export function buildCard(c: Card): string {
    return `a person with ${clean(c.face)}; hair: ${clean(c.hair)}; skin: ${clean(c.skin)}; build: ${clean(c.build)}; distinctive marks: ${clean(c.distinctive_marks)}; jewellery: ${clean(c.jewellery)}; wardrobe: ${clean(c.default_wardrobe)}`;
}

// ---------------------------------------------------------------- targets

export type Box = [number, number, number, number];
export type Seed = 'first' | 'last' | { t: number; point: [number, number]; box?: Box };

export interface TargetEntry {
    present: boolean;
    /** Times (seconds) of the strip frames where the subject appears. Required when present. */
    seen_at?: number[];
    /** Required when absent: the whole strip was looked at and the subject is in none of it. */
    absent_checked?: boolean;
    seed?: Seed;
    /** Pixels of the source frame, on the seed frame. Required for `first` and `last`. */
    point?: [number, number];
    box_first?: Box;
    box_last?: Box;
    others?: string[];
    framing?: string;
    camera_move?: string;
    light?: string;
    wardrobe?: string;
    action?: string;
}

export interface Targets {
    subject: string;
    stretches: Record<string, TargetEntry>;
}

export const SHOT_CARD_FIELDS = ['framing', 'camera_move', 'light', 'wardrobe', 'action'] as const;

const inside = (x: number, y: number, f: { width: number; height: number }) => x >= 0 && y >= 0 && x < f.width && y < f.height;
const pointOk = (p: unknown, f: { width: number; height: number }): p is [number, number] => Array.isArray(p) && p.length === 2 && p.every(num) && inside(p[0], p[1], f);
const boxOk = (b: unknown, f: { width: number; height: number }): b is Box => Array.isArray(b) && b.length === 4 && b.every(num) && b[2] > 0 && b[3] > 0 && b[0] >= 0 && b[1] >= 0 && b[0] + b[2] <= f.width && b[1] + b[3] <= f.height;

/**
 * Where a split at time `t` falls, in frames, or why it cannot. `all` is every stretch of the source: a half that
 * borders a neighbouring stretch of the same shot (and so its 8-frame overlap) needs MIN_HALF_FRAMES; a half at the
 * free end of the shot needs only MIN_FREE_HALF_FRAMES.
 */
export function splitFrame(t: number, s: Stretch, fps: number, all: Stretch[] = []): { frame: number } | { error: string } {
    const frame = timeFrame(t, fps);
    if (!(frame >= s.first && frame < s.end)) return { error: `seed.t ${t} s is not inside the stretch (${frameTime(s.first, fps).toFixed(3)}-${frameTime(s.end, fps).toFixed(3)} s)` };
    const minBefore = all.some((x) => x.scene === s.scene && x.first < s.first) ? MIN_HALF_FRAMES : MIN_FREE_HALF_FRAMES;
    const minAfter = all.some((x) => x.scene === s.scene && x.first > s.first) ? MIN_HALF_FRAMES : MIN_FREE_HALF_FRAMES;
    if (frame - s.first + 1 < minBefore || s.end - frame < minAfter) return { error: `seed.t ${t} s is too close to an end of the stretch (the half before it needs at least ${minBefore} frames and the half after it ${minAfter}): use "first" or "last"` };
    return { frame };
}

export function validateTargets(targets: unknown, stretches: Stretch[], frame: { width: number; height: number }, fps: number): Validation {
    const errors: string[] = [];
    if (!targets || typeof targets !== 'object' || Array.isArray(targets)) return result(['targets.json must be an object with "subject" and "stretches".']);
    const t = targets as Partial<Targets>;
    if (!text(t.subject)) errors.push('subject is required: a short visual description of the person being replaced.');
    const answers = t.stretches && typeof t.stretches === 'object' && !Array.isArray(t.stretches) ? (t.stretches as Record<string, unknown>) : null;
    if (!answers) return result([...errors, '"stretches" must be an object with one entry per stretch.']);
    const ids = new Set(stretches.map((s) => s.id));
    for (const id of Object.keys(answers)) if (!ids.has(id)) errors.push(`${id} is not a stretch of this source (stretches: ${[...ids].join(', ')}).`);
    for (const s of stretches) {
        const raw = answers[s.id];
        if (raw === undefined) {
            errors.push(`${s.id} has no answer.`);
            continue;
        }
        if (!raw || typeof raw !== 'object') {
            errors.push(`${s.id}: the answer must be an object.`);
            continue;
        }
        const e = raw as TargetEntry;
        const start = frameTime(s.first, fps);
        const stop = frameTime(s.end - 1, fps);
        const half = 0.5 / fps;
        if (typeof e.present !== 'boolean') {
            errors.push(`${s.id}: "present" must be true or false.`);
            continue;
        }
        if (!e.present) {
            if (e.absent_checked !== true) errors.push(`${s.id}: absent_checked must be true: say that you looked at the whole strip and the subject is in none of it.`);
            if (Array.isArray(e.seen_at) && e.seen_at.length) errors.push(`${s.id}: seen_at lists times but present is false.`);
            continue;
        }
        if (!Array.isArray(e.seen_at) || !e.seen_at.length || !e.seen_at.every(num)) errors.push(`${s.id}: seen_at is required when present: the strip times where the subject appears.`);
        else if (e.seen_at.some((x) => x < start - half || x > stop + half)) errors.push(`${s.id}: seen_at must lie inside the stretch (${start.toFixed(3)}-${stop.toFixed(3)} s).`);
        const seed = e.seed;
        if (seed === 'first' || seed === 'last') {
            if (!pointOk(e.point, frame)) errors.push(`${s.id}: point [x, y] is required, in source pixels (0-${frame.width - 1} by 0-${frame.height - 1}) on the ${seed} frame.`);
        } else if (seed && typeof seed === 'object' && num(seed.t)) {
            const sp = splitFrame(seed.t, s, fps, stretches);
            if ('error' in sp) errors.push(`${s.id}: ${sp.error}.`);
            if (!pointOk(seed.point, frame)) errors.push(`${s.id}: seed.point [x, y] is required, in source pixels on the frame at seed.t.`);
            if (seed.box !== undefined && !boxOk(seed.box, frame)) errors.push(`${s.id}: seed.box must be [x, y, w, h] inside the frame.`);
        } else errors.push(`${s.id}: seed must be "first", "last" or {"t": seconds, "point": [x, y]} (a frame where the subject is clearly visible).`);
        for (const k of ['box_first', 'box_last'] as const) if (e[k] !== undefined && !boxOk(e[k], frame)) errors.push(`${s.id}: ${k} must be [x, y, w, h] inside the ${frame.width}x${frame.height} frame.`);
        if (e.others !== undefined && !(Array.isArray(e.others) && e.others.every((o) => typeof o === 'string'))) errors.push(`${s.id}: others must be a list of short descriptions.`);
        for (const k of SHOT_CARD_FIELDS) if (!text(e[k])) errors.push(`${s.id}: ${k} is required.`);
    }
    return result(errors);
}

// ---------------------------------------------------------------- crop and tier

/**
 * The area of the frame to send for a subject whose boxes are known at both ends of a run. A 9:16 window that holds
 * all the boxes and is at least 2.5 times the subject's height (rounded up to a multiple of 32 so the sides are
 * whole and even) at tier 480 with mask growth 32; or, when the subject covers a lot of the frame (the boxes are
 * wider than 60% of it, or the subject is 35% of its height or more), or no such window fits, the whole frame at 768.
 */
export function cropFor(boxes: number[][], frame: { width: number; height: number }): { crop?: Rect; tier: '480' | '768'; expand: number } {
    const whole = { tier: '768' as const, expand: SWAP_DEFAULTS.expand };
    const bs = boxes.filter((b) => b && b.length === 4);
    if (!bs.length) return whole;
    const x1 = Math.min(...bs.map((b) => b[0]));
    const y1 = Math.min(...bs.map((b) => b[1]));
    const x2 = Math.max(...bs.map((b) => b[0] + b[2]));
    const y2 = Math.max(...bs.map((b) => b[1] + b[3]));
    const tallest = Math.max(...bs.map((b) => b[3]));
    if (x2 - x1 > 0.6 * frame.width || tallest >= 0.35 * frame.height) return whole;
    const wanted = Math.max(2.5 * tallest, y2 - y1, ((x2 - x1) * 16) / 9);
    // At least 128 high (72 wide): the model cannot work on less, and a crop must be 64 pixels or more on both sides.
    const h = Math.max(128, Math.ceil(wanted / 32) * 32);
    const w = (h / 32) * 18;
    if (h > frame.height || w > frame.width) return whole;
    const x = Math.min(Math.max(Math.round((x1 + x2) / 2 - w / 2), 0), frame.width - w);
    const y = Math.min(Math.max(Math.round((y1 + y2) / 2 - h / 2), 0), frame.height - h);
    return { crop: { x, y, w, h }, tier: '480', expand: 32 };
}

// ---------------------------------------------------------------- prompt

/** The part of every prompt that is the same: what must not change. */
export const PROMPT_CLAUSE = 'Keep exactly the same pose, movement, timing and position as in <Video 1>. Keep the background, the lighting and every other person unchanged.';

export function promptFor(o: { subject: string; card: string; target: TargetEntry }): string {
    const t = o.target;
    const others = (t.others ?? []).map(clean).filter(Boolean);
    return [
        `Replace the selected person in <Video 1> (${clean(o.subject)}, wearing ${clean(t.wardrobe)}) with the person from <Picture 1>: ${clean(o.card)}.`,
        `Framing: ${clean(t.framing)}. Camera: ${clean(t.camera_move)}. Light: ${clean(t.light)}. What the person does: ${clean(t.action)}.`,
        ...(others.length ? [`Other people in frame, to stay unchanged: ${others.join('; ')}.`] : []),
        PROMPT_CLAUSE,
    ].join(' ');
}

// ---------------------------------------------------------------- plan

export interface PlanUnit {
    id: string;
    scene: number;
    stretch: string;
    action: 'swap' | 'keep';
    /** Source frames [first, end). */
    first: number;
    end: number;
    reverse?: boolean;
    /** The frame the point is on: the first frame the model sees. */
    seed_frame?: number;
    /** Pixels of the source frame, on the seed frame. */
    point?: [number, number];
    crop?: Rect;
    tier?: '480' | '768';
    expand?: number;
    prompt?: string;
    /** Generation seed. */
    seed?: number;
    /** Hash of the targets this entry was made from (the plan is stale when the targets change under it). */
    target_sha256?: string;
}

export interface Plan {
    schema: string;
    created_at: string;
    fps: number;
    frames: number;
    /** Hash of the character card the prompts were built from: the plan is stale when the card changes. */
    card_sha256: string;
    units: PlanUnit[];
}

export function stableStringify(v: unknown): string {
    if (Array.isArray(v)) return `[${v.map(stableStringify).join(',')}]`;
    if (v && typeof v === 'object') {
        const o = v as Record<string, unknown>;
        return `{${Object.keys(o).filter((k) => o[k] !== undefined).sort().map((k) => `${JSON.stringify(k)}:${stableStringify(o[k])}`).join(',')}}`;
    }
    return JSON.stringify(v) ?? 'null';
}
export const stableHash = (v: unknown): string => createHash('sha256').update(stableStringify(v)).digest('hex');
export const targetHash = (subject: string, entry: TargetEntry | undefined): string => stableHash({ subject, entry: entry ?? null });

export function buildPlan(o: { stretches: Stretch[]; targets: Targets; frame: { width: number; height: number }; fps: number; frames: number; card: string; photoSha256?: string; now?: string }): Plan {
    const units: PlanUnit[] = [];
    for (const s of o.stretches) {
        const e = o.targets.stretches[s.id];
        if (!e) throw new Error(`${s.id} has no answer in targets.json.`);
        const base = { scene: s.scene, stretch: s.id };
        const target_sha256 = targetHash(o.targets.subject, e);
        if (!e.present) {
            units.push({ id: s.id, ...base, action: 'keep', first: s.first, end: s.end, target_sha256 });
            continue;
        }
        const prompt = promptFor({ subject: o.targets.subject, card: o.card, target: e });
        const swap = (id: string, first: number, end: number, seedFrame: number, point: [number, number], reverse: boolean, boxes: Array<Box | undefined>): PlanUnit => {
            let c = cropFor(boxes.filter((b): b is Box => Boolean(b)), o.frame);
            // A point outside the window (boxes and point disagree) cannot be sent: use the whole frame.
            if (c.crop && !(point[0] >= c.crop.x && point[0] < c.crop.x + c.crop.w && point[1] >= c.crop.y && point[1] < c.crop.y + c.crop.h)) c = { tier: '768', expand: SWAP_DEFAULTS.expand };
            return { id, ...base, action: 'swap', first, end, reverse, seed_frame: seedFrame, point, ...(c.crop ? { crop: c.crop } : {}), tier: c.tier, expand: c.expand, prompt, seed: SWAP_DEFAULTS.seed, target_sha256 };
        };
        const seed = e.seed!;
        if (seed === 'first') units.push(swap(s.id, s.first, s.end, s.first, e.point!, false, [e.box_first, e.box_last]));
        else if (seed === 'last') units.push(swap(s.id, s.first, s.end, s.end - 1, e.point!, true, [e.box_first, e.box_last]));
        else {
            const sp = splitFrame(seed.t, s, o.fps, o.stretches);
            if ('error' in sp) throw new Error(`${s.id}: ${sp.error}.`);
            const T = sp.frame;
            // [first, T] runs backwards from the seed frame T; [T, end) forwards from it. Frame T is in both and
            // is joined once, with a one-frame overlap.
            units.push(swap(`${s.id}_a`, s.first, T + 1, T, seed.point, true, [e.box_first, seed.box]));
            units.push(swap(`${s.id}_b`, T, s.end, T, seed.point, false, [seed.box, e.box_last]));
        }
    }
    return { schema: PLAN_SCHEMA, created_at: o.now ?? new Date().toISOString(), fps: o.fps, frames: o.frames, card_sha256: stableHash({ card: o.card }), units };
}

export type Part = { unit: string } | { source: [number, number] };
export interface Group {
    id: string;
    scene: number;
    first: number;
    end: number;
    parts: Part[];
}
export type PlanSegment = { shot: string } | { source: [number, number] };

/**
 * How the plan's runs come together: a scene with more than one part (a long shot, a split stretch, or kept and
 * swapped stretches side by side) is one group whose parts are joined; the segments are what `assemble` takes, in
 * playing order, with neighbouring kept stretches merged.
 */
export function unitsOf(plan: Plan): { units: PlanUnit[]; groups: Group[]; segments: PlanSegment[] } {
    const byScene = new Map<number, PlanUnit[]>();
    for (const u of plan.units) byScene.set(u.scene, [...(byScene.get(u.scene) ?? []), u]);
    const groups: Group[] = [];
    const segments: PlanSegment[] = [];
    const pushSource = (a: number, b: number) => {
        const last = segments.at(-1);
        if (last && 'source' in last && last.source[1] === a) last.source[1] = b;
        else segments.push({ source: [a, b] });
    };
    for (const [scene, us] of [...byScene.entries()].sort((a, b) => a[0] - b[0])) {
        const first = Math.min(...us.map((u) => u.first));
        const end = Math.max(...us.map((u) => u.end));
        if (!us.some((u) => u.action === 'swap')) {
            pushSource(first, end);
            continue;
        }
        if (us.length === 1) {
            segments.push({ shot: us[0].id });
            continue;
        }
        const id = `s${scene}`;
        groups.push({ id, scene, first, end, parts: us.map((u): Part => (u.action === 'swap' ? { unit: u.id } : { source: [u.first, u.end] })) });
        segments.push({ shot: id });
    }
    return { units: plan.units, groups, segments };
}

export function validatePlan(plan: unknown, stretches: Stretch[], frame: { width: number; height: number }, totalFrames: number): Validation {
    const errors: string[] = [];
    const p = plan as Partial<Plan> | null;
    if (!p || p.schema !== PLAN_SCHEMA || !Array.isArray(p.units)) return result([`plan.json is not a ${PLAN_SCHEMA} file (run plan to make one).`]);
    const seen = new Set<string>();
    for (const u of p.units) {
        const id = String(u?.id ?? '?');
        if (!/^[a-z0-9][a-z0-9_-]{0,31}$/.test(id)) errors.push(`${id}: not a usable id.`);
        if (seen.has(id)) errors.push(`${id}: appears twice.`);
        seen.add(id);
        if (!stretches.some((s) => s.id === u.stretch)) errors.push(`${id}: stretch "${u.stretch}" does not exist.`);
        if (!Number.isInteger(u.first) || !Number.isInteger(u.end) || !(u.first >= 0 && u.end > u.first && u.end <= totalFrames)) errors.push(`${id}: first and end must be whole frames inside 0-${totalFrames}.`);
        if (u.action !== 'swap' && u.action !== 'keep') errors.push(`${id}: action must be swap or keep.`);
        if (u.action !== 'swap') continue;
        if (u.tier !== '480' && u.tier !== '768') errors.push(`${id}: tier must be "480" or "768".`);
        if (!text(u.prompt)) errors.push(`${id}: prompt is required.`);
        if (!pointOk(u.point, frame)) errors.push(`${id}: point must be [x, y] inside the ${frame.width}x${frame.height} frame.`);
        if (typeof u.reverse !== 'boolean') errors.push(`${id}: reverse must be true or false.`);
        if (u.seed_frame !== undefined && !(u.seed_frame >= u.first && u.seed_frame < u.end)) errors.push(`${id}: seed_frame must be inside the run.`);
        // The model starts from the seed frame, and the run is played towards the other end: a reversed run starts from its last frame.
        else if (u.seed_frame !== undefined && typeof u.reverse === 'boolean' && u.seed_frame !== (u.reverse ? u.end - 1 : u.first)) errors.push(`${id}: seed_frame ${u.seed_frame} does not match reverse: ${u.reverse ? `a reversed run starts from its last frame (${u.end - 1})` : `a forward run starts from its first frame (${u.first})`}.`);
        if (u.crop) {
            const c = u.crop;
            const okInts = [c.x, c.y, c.w, c.h].every((n) => Number.isInteger(n) && n >= 0);
            if (!okInts || c.w < 64 || c.h < 64 || c.w % 2 || c.h % 2 || c.x + c.w > frame.width || c.y + c.h > frame.height) errors.push(`${id}: crop must be whole pixels, at least 64x64, even sides, inside the frame.`);
            else if (pointOk(u.point, frame) && !(u.point[0] >= c.x && u.point[0] < c.x + c.w && u.point[1] >= c.y && u.point[1] < c.y + c.h)) errors.push(`${id}: point is outside the crop.`);
        }
        if (u.expand !== undefined && !(Number.isInteger(u.expand) && u.expand >= 0 && u.expand <= 256)) errors.push(`${id}: expand must be a whole number of pixels, 0-256.`);
    }
    for (const s of stretches) {
        const us = p.units.filter((u) => u.stretch === s.id).sort((a, b) => a.first - b.first);
        if (!us.length) {
            errors.push(`${s.id} has no entry in the plan.`);
            continue;
        }
        const tiled = us[0].first === s.first && us.at(-1)!.end === s.end && us.every((u, i) => (i === 0 ? true : u.first >= us[i - 1].end - 1 && u.first <= us[i - 1].end));
        if (!tiled) errors.push(`${s.id}: its entries do not cover frames ${s.first}-${s.end - 1} (neighbouring halves of a split may share one frame).`);
        if (us.length > 1 && us.some((u) => u.action !== 'swap')) errors.push(`${s.id}: a split stretch is swapped in both halves.`);
    }
    return result(errors);
}

// ---------------------------------------------------------------- freshness

export interface Fresh {
    photo: string;
    card: string;
    target: string;
    plan: string;
}

/** What the plan entry contributes to a run: everything that changes the picture the model is asked for. */
const planInputs = (u: PlanUnit) => ({ first: u.first, end: u.end, point: u.point, reverse: Boolean(u.reverse), crop: u.crop ?? null, tier: u.tier, expand: u.expand, prompt: u.prompt, seed: u.seed ?? SWAP_DEFAULTS.seed });

export function freshOf(o: { photoSha256: string; card: string; target: unknown; entry: PlanUnit }): Fresh {
    return { photo: stableHash({ photo: o.photoSha256 }), card: stableHash({ card: o.card }), target: stableHash({ target: o.target ?? null }), plan: stableHash(planInputs(o.entry)) };
}

export const sameFresh = (a: Fresh | undefined, b: Fresh): boolean => Boolean(a) && a!.photo === b.photo && a!.card === b.card && a!.target === b.target && a!.plan === b.plan;

