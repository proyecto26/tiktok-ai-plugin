// tiktok-video-remake: stretches, the identity card, the targets and the plan (pure functions; no media, no network).
import { describe, expect, test } from 'bun:test';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';

import { OVERLAP_FRAMES, sceneStretches, stripFrames, stretchesOfScene } from '../../skills/tiktok-video-remake/scripts/stretch.ts';
import { PROMPT_CLAUSE, buildCard, buildPlan, cropFor, freshOf, promptFor, stableHash, targetHash, unitsOf, validateCard, validatePlan, validateTargets, type Targets } from '../../skills/tiktok-video-remake/scripts/plan.ts';

const FRAME = { width: 720, height: 1280 };
const card = { hair: 'long dark brown hair worn loose', face: 'an oval face with dark eyes', skin: 'light olive skin', build: 'slim build', distinctive_marks: 'a small mole under the left eye', jewellery: 'none', default_wardrobe: 'a black lace sleeveless mini dress' };
const fields = { framing: 'medium shot from head to hips', camera_move: 'static camera', light: 'strong cool blue backlight', wardrobe: 'a red coat', action: 'walks left to right, turns her head' };
const present = (extra: Record<string, unknown> = {}) => ({ present: true, seen_at: [0], seed: 'first', point: [300, 500], box_first: [250, 300, 120, 400], box_last: [250, 300, 120, 400], others: [], ...fields, ...extra });
const absent = (extra: Record<string, unknown> = {}) => ({ present: false, absent_checked: true, ...extra });

describe('stretches: a shot of at most 10 s is one run, a longer one is split with an overlap', () => {
    test('a short scene is one stretch named after its scene', () => {
        expect(stretchesOfScene({ n: 3, first: 100, end: 400 }, 30)).toEqual([{ id: 's3', scene: 3, first: 100, end: 400 }]);
    });
    test('a long scene is split into runs of at most 10 s that overlap by 8 frames and cover every frame once', () => {
        for (const [frames, fps] of [[750, 30], [301, 30], [577, 24], [1500, 60], [300 + 8, 30]] as const) {
            const st = stretchesOfScene({ n: 2, first: 1000, end: 1000 + frames }, fps);
            expect(st.length).toBeGreaterThan(1);
            expect(st[0].first).toBe(1000);
            expect(st.at(-1)!.end).toBe(1000 + frames);
            let covered = 0;
            st.forEach((s, i) => {
                expect(s.end - s.first).toBeLessThanOrEqual(Math.floor(10 * fps));
                expect(s.id).toBe(`s2_${i + 1}`);
                if (i > 0) expect(st[i - 1].end - s.first).toBe(OVERLAP_FRAMES);
                covered += s.end - s.first - (i > 0 ? OVERLAP_FRAMES : 0);
            });
            // Every source frame once: the sum of the lengths minus the overlaps is the shot.
            expect(covered).toBe(frames);
        }
        // Exactly 10 s is still one run.
        expect(stretchesOfScene({ n: 1, first: 0, end: 300 }, 30)).toHaveLength(1);
    });
    test('scenes of the whole source', () => {
        const all = sceneStretches([60, 400], 700, 30);
        expect(all.map((s) => s.id)).toEqual(['s1', 's2_1', 's2_2', 's3']);
    });
});

describe('the strip a person looks at: at least 4 frames per second, the last frame included', () => {
    test('no gap is longer than 0.25 s', () => {
        for (const fps of [24, 25, 29.97, 30, 60]) {
            for (const [first, end] of [[0, 90], [17, 320], [100, 101], [5, 12]] as const) {
                const f = stripFrames(first, end, fps);
                expect(f[0]).toBe(first);
                expect(f.at(-1)).toBe(end - 1);
                for (let i = 1; i < f.length; i++) expect((f[i] - f[i - 1]) / fps).toBeLessThanOrEqual(0.25 + 1e-9);
                expect(new Set(f).size).toBe(f.length);
            }
        }
    });
});

describe('the identity card', () => {
    test('is validated and written the same way every time', () => {
        expect(validateCard(card)).toEqual({ ok: true, errors: [] });
        const text = buildCard(card);
        expect(text).toContain('long dark brown hair worn loose');
        expect(text).toContain('a small mole under the left eye');
        expect(text).toContain('a black lace sleeveless mini dress');
        expect(buildCard({ ...card })).toBe(text);
    });
    test('every field is required', () => {
        const { hair: _h, ...rest } = card;
        expect(validateCard(rest).errors.join()).toMatch(/hair/);
        expect(validateCard({ ...card, jewellery: '  ' }).errors.join()).toMatch(/jewellery/);
        expect(validateCard('nope' as unknown).ok).toBe(false);
    });
});

describe('targets', () => {
    const stretches = sceneStretches([100], 250, 30);
    const base = (): Targets => ({ subject: 'the woman in the red coat', stretches: { s1: present(), s2: absent() } }) as unknown as Targets;
    const check = (t: unknown) => validateTargets(t, stretches, FRAME, 30);
    test('a complete answer is valid', () => expect(check(base())).toEqual({ ok: true, errors: [] }));
    test('every stretch must be answered, and unknown ones are refused', () => {
        const t = base();
        delete (t.stretches as any).s2;
        expect(check(t).errors.join()).toMatch(/s2.*no answer/);
        expect(check({ ...base(), stretches: { ...base().stretches, s9: absent() } }).errors.join()).toMatch(/s9.*not a stretch/);
        expect(check({ stretches: base().stretches }).errors.join()).toMatch(/subject/);
    });
    test('seen_at is required when present, absent_checked when not', () => {
        expect(check({ ...base(), stretches: { s1: present({ seen_at: [] }), s2: absent() } }).errors.join()).toMatch(/s1.*seen_at/);
        expect(check({ ...base(), stretches: { s1: present(), s2: { present: false } } }).errors.join()).toMatch(/s2.*absent_checked/);
        expect(check({ ...base(), stretches: { s1: present(), s2: absent({ seen_at: [3] }) } }).errors.join()).toMatch(/s2.*seen_at/);
        // seen_at times must lie inside the stretch (s1 is 0-3.333 s)
        expect(check({ ...base(), stretches: { s1: present({ seen_at: [9] }), s2: absent() } }).errors.join()).toMatch(/s1.*seen_at.*inside/);
    });
    test('points and boxes must lie inside the frame', () => {
        expect(check({ ...base(), stretches: { s1: present({ point: [720, 10] }), s2: absent() } }).errors.join()).toMatch(/s1.*point/);
        expect(check({ ...base(), stretches: { s1: present({ box_first: [600, 300, 200, 400] }), s2: absent() } }).errors.join()).toMatch(/s1.*box_first/);
        expect(check({ ...base(), stretches: { s1: present({ point: undefined }), s2: absent() } }).errors.join()).toMatch(/s1.*point/);
    });
    test('the shot card fields are required for a stretch with the subject', () => {
        expect(check({ ...base(), stretches: { s1: present({ light: '' }), s2: absent() } }).errors.join()).toMatch(/s1.*light/);
    });
    test('a seed time inside the stretch splits it; outside, or too close to an end, is refused', () => {
        const ok = { t: 1.5, point: [300, 500] };
        expect(check({ ...base(), stretches: { s1: present({ seed: ok, point: undefined }), s2: absent() } }).errors).toEqual([]);
        expect(check({ ...base(), stretches: { s1: present({ seed: { t: 7, point: [1, 1] }, point: undefined }), s2: absent() } }).errors.join()).toMatch(/s1.*seed.*inside/);
        expect(check({ ...base(), stretches: { s1: present({ seed: { t: 0, point: [1, 1] }, point: undefined }), s2: absent() } }).errors.join()).toMatch(/s1.*seed.*too close/);
        expect(check({ ...base(), stretches: { s1: present({ seed: 'middle' }), s2: absent() } }).errors.join()).toMatch(/s1.*seed/);
    });
});

describe("seed splits: only a half that meets a neighbour's overlap needs 9 frames", () => {
    const seedAt = (frame: number, fps = 30) => ({ t: frame / fps, point: [300, 500] });
    const targetsFor = (st: ReturnType<typeof sceneStretches>, id: string, frame: number): Targets => ({ subject: 'the woman in the red coat', stretches: Object.fromEntries(st.map((s) => [s.id, s.id === id ? present({ seed: seedAt(frame), point: undefined }) : absent()])) }) as unknown as Targets;
    const errorsOf = (st: ReturnType<typeof sceneStretches>, id: string, frame: number) => validateTargets(targetsFor(st, id, frame), st, FRAME, 30).errors.filter((e) => e.startsWith(`${id}:`) && /seed/.test(e));
    test('a 16-frame single-stretch shot takes a seed at its middle and splits into two halves', () => {
        const st = sceneStretches([], 16, 30);
        const targets = targetsFor(st, 's1', 8);
        expect(validateTargets(targets, st, FRAME, 30).errors).toEqual([]);
        const plan = buildPlan({ stretches: st, targets, frame: FRAME, fps: 30, frames: 16, card: buildCard(card) });
        expect(plan.units.map((u) => [u.id, u.first, u.end])).toEqual([['s1_a', 0, 9], ['s1_b', 8, 16]]);
        // a half of one frame is still too short
        expect(errorsOf(st, 's1', 0).join()).toMatch(/too close/);
        expect(errorsOf(st, 's1', 15).join()).toMatch(/too close/);
        expect(errorsOf(st, 's1', 1)).toEqual([]);
        expect(errorsOf(st, 's1', 14)).toEqual([]);
    });
    test('a half that borders a neighbouring stretch keeps the 9-frame minimum; the free end does not', () => {
        const st = sceneStretches([], 700, 30);
        expect(st.map((s) => s.id)).toEqual(['s1_1', 's1_2', 's1_3']);
        const [a, b, c] = st;
        // first stretch: its start borders nothing, its end borders s1_2
        expect(errorsOf(st, 's1_1', a.first + 1)).toEqual([]);
        expect(errorsOf(st, 's1_1', a.end - 8).join()).toMatch(/too close/);
        expect(errorsOf(st, 's1_1', a.end - 9)).toEqual([]);
        // middle stretch: both ends border a neighbour
        expect(errorsOf(st, 's1_2', b.first + 7).join()).toMatch(/too close/);
        expect(errorsOf(st, 's1_2', b.end - 8).join()).toMatch(/too close/);
        // last stretch: its end is free, its start borders s1_2
        expect(errorsOf(st, 's1_3', c.first + 7).join()).toMatch(/too close/);
        expect(errorsOf(st, 's1_3', c.end - 2)).toEqual([]);
    });
});

describe('crop and tier', () => {
    test('a small subject gets a 9:16 crop around both of its boxes, 480, mask growth 32', () => {
        const c = cropFor([[100, 400, 80, 200], [420, 500, 80, 200]], FRAME);
        expect(c.crop).toBeDefined();
        const r = c.crop!;
        expect(r.w * 16).toBe(r.h * 9);
        expect(r.h).toBeGreaterThanOrEqual(2.5 * 200);
        for (const [x, y, w, h] of [[100, 400, 80, 200], [420, 500, 80, 200]]) {
            expect(r.x).toBeLessThanOrEqual(x);
            expect(r.y).toBeLessThanOrEqual(y);
            expect(r.x + r.w).toBeGreaterThanOrEqual(x + w);
            expect(r.y + r.h).toBeGreaterThanOrEqual(y + h);
        }
        expect(r.x + r.w).toBeLessThanOrEqual(FRAME.width);
        expect(r.y + r.h).toBeLessThanOrEqual(FRAME.height);
        expect(r.w % 2 + r.h % 2).toBe(0);
        expect(c).toMatchObject({ tier: '480', expand: 32 });
    });
    test('a subject that moves across more than 60% of the frame, or stands 35% tall, is sent whole at 768', () => {
        expect(cropFor([[10, 400, 80, 200], [620, 400, 80, 200]], FRAME)).toEqual({ tier: '768', expand: 64 });
        expect(cropFor([[100, 300, 200, 460]], FRAME)).toEqual({ tier: '768', expand: 64 });
        expect(cropFor([], FRAME)).toEqual({ tier: '768', expand: 64 });
    });
    test('a crop that cannot hold the subject at 2.5x its height is not used', () => {
        expect(cropFor([[100, 200, 60, 300]], { width: 400, height: 1000 })).toEqual({ tier: '768', expand: 64 });
    });
});

describe('prompt', () => {
    test('is the character card, the shot card from the targets and the fixed keep clause, and nothing else', () => {
        const text = buildCard(card);
        const p = promptFor({ subject: 'the woman in the red coat', card: text, target: present({ others: ['a man in a grey hoodie'] }) as any });
        expect(p).toContain(text);
        expect(p).toContain(PROMPT_CLAUSE);
        for (const v of [fields.framing, fields.camera_move, fields.light, fields.wardrobe, fields.action, 'the woman in the red coat', 'a man in a grey hoodie']) expect(p).toContain(v);
        expect(p).toBe(promptFor({ subject: 'the woman in the red coat', card: text, target: present({ others: ['a man in a grey hoodie'] }) as any }));
        // Nothing about consent, rights or who may be depicted is added to the prompt.
        expect(p).not.toMatch(/consent|rights|permission/i);
    });
});

describe('plan', () => {
    const photo = 'sha-of-photo';
    const mk = (cuts: number[], frames: number, fps: number, stretchesAnswers: Record<string, unknown>, extra: Record<string, unknown> = {}) => {
        const st = sceneStretches(cuts, frames, fps);
        const targets = { subject: 'the woman in the red coat', stretches: stretchesAnswers } as unknown as Targets;
        return { st, targets, plan: buildPlan({ stretches: st, targets, frame: FRAME, fps, frames, card: buildCard(card), photoSha256: photo, ...extra }) };
    };
    test('swap when the subject is present, keep when not', () => {
        const { plan } = mk([100], 250, 30, { s1: present(), s2: absent() });
        expect(plan.units.map((u) => [u.id, u.action])).toEqual([['s1', 'swap'], ['s2', 'keep']]);
        expect(plan.units[0]).toMatchObject({ first: 0, end: 100, reverse: false, point: [300, 500] });
        expect(plan.units[1]).toMatchObject({ first: 100, end: 250 });
    });
    test('every stretch of a long shot where the subject is present is swapped; the absent one is kept', () => {
        const { plan, st } = mk([], 700, 30, { s1_1: present(), s1_2: absent(), s1_3: present({ seed: 'last' }) });
        expect(st.map((s) => s.id)).toEqual(['s1_1', 's1_2', 's1_3']);
        expect(plan.units.map((u) => u.action)).toEqual(['swap', 'keep', 'swap']);
        expect(plan.units[2].reverse).toBe(true);
    });
    test('the point is on the seed frame: the first frame, or the last frame when reversed', () => {
        const { plan } = mk([], 100, 30, { s1: present({ seed: 'last', point: [10, 20] }) });
        expect(plan.units[0]).toMatchObject({ reverse: true, point: [10, 20], seed_frame: 99 });
        const fwd = mk([], 100, 30, { s1: present() }).plan.units[0];
        expect(fwd).toMatchObject({ reverse: false, seed_frame: 0 });
    });
    test('a seed time splits the stretch: the first half runs reversed, the second forward, overlapping on the seed frame', () => {
        const { plan } = mk([], 100, 30, { s1: present({ seed: { t: 1, point: [300, 500], box: [250, 300, 120, 400] }, point: undefined }) });
        expect(plan.units.map((u) => [u.id, u.action, u.first, u.end, u.reverse, u.seed_frame, u.point])).toEqual([
            ['s1_a', 'swap', 0, 31, true, 30, [300, 500]],
            ['s1_b', 'swap', 30, 100, false, 30, [300, 500]],
        ]);
        // the pair is one shot with a 1-frame overlap
        expect(unitsOf(plan).groups).toEqual([{ id: 's1', scene: 1, first: 0, end: 100, parts: [{ unit: 's1_a' }, { unit: 's1_b' }] }]);
    });
    test('a moving subject gets a crop that holds both of its boxes, or the full frame', () => {
        const moving = mk([], 100, 30, { s1: present({ box_first: [100, 400, 80, 200], box_last: [420, 500, 80, 200] }) }).plan.units[0];
        expect(moving.tier).toBe('480');
        expect(moving.expand).toBe(32);
        const r = moving.crop!;
        expect(r.x).toBeLessThanOrEqual(100);
        expect(r.x + r.w).toBeGreaterThanOrEqual(500);
        const wide = mk([], 100, 30, { s1: present({ box_first: [10, 400, 80, 200], box_last: [620, 400, 80, 200] }) }).plan.units[0];
        expect(wide.crop).toBeUndefined();
        expect(wide.tier).toBe('768');
    });
    test('the prompt comes from the card and the targets only', () => {
        const { plan, targets } = mk([], 100, 30, { s1: present() });
        expect(plan.units[0].prompt).toBe(promptFor({ subject: targets.subject, card: buildCard(card), target: targets.stretches.s1 }));
    });
    test('a shot with every stretch kept has no swap at all', () => {
        const { plan } = mk([100], 250, 30, { s1: absent(), s2: absent() });
        expect(plan.units.every((u) => u.action === 'keep')).toBe(true);
        expect(unitsOf(plan).groups).toEqual([]);
    });
    test('the plan can be checked and edited', () => {
        const { plan, st } = mk([100], 250, 30, { s1: present(), s2: absent() });
        expect(validatePlan(plan, st, FRAME, 250)).toEqual({ ok: true, errors: [] });
        const bad = JSON.parse(JSON.stringify(plan));
        bad.units[0].tier = '1024';
        bad.units[0].prompt = '';
        bad.units[0].point = [9999, 1];
        const errs = validatePlan(bad, st, FRAME, 250).errors.join('\n');
        expect(errs).toMatch(/s1.*tier/);
        expect(errs).toMatch(/s1.*prompt/);
        expect(errs).toMatch(/s1.*point/);
        const missing = JSON.parse(JSON.stringify(plan));
        missing.units.pop();
        expect(validatePlan(missing, st, FRAME, 250).errors.join()).toMatch(/s2.*no entry/);
    });
});

describe('plan checks: reverse and seed_frame agree; kept runs record their target', () => {
    const st = sceneStretches([], 100, 30);
    const build = (answer: unknown) => JSON.parse(JSON.stringify(buildPlan({ stretches: st, targets: { subject: 'the woman in the red coat', stretches: { s1: answer } } as unknown as Targets, frame: FRAME, fps: 30, frames: 100, card: buildCard(card) })));
    test('a plan as built passes', () => expect(validatePlan(build(present({ seed: 'last', point: [10, 20] })), st, FRAME, 100)).toEqual({ ok: true, errors: [] }));
    test('seed last with reverse edited to false is refused, naming the run', () => {
        const p = build(present({ seed: 'last', point: [10, 20] }));
        p.units[0].reverse = false;
        expect(validatePlan(p, st, FRAME, 100).errors.join()).toMatch(/s1.*seed_frame 99.*reverse/);
    });
    test('seed first with reverse edited to true is refused', () => {
        const p = build(present());
        p.units[0].reverse = true;
        expect(validatePlan(p, st, FRAME, 100).errors.join()).toMatch(/s1.*seed_frame 0.*reverse/);
    });
    test('a seed_frame that is neither end of the run is refused', () => {
        const p = build(present());
        p.units[0].seed_frame = 50;
        expect(validatePlan(p, st, FRAME, 100).errors.join()).toMatch(/s1.*seed_frame 50/);
    });
    test('a kept run records the hash of the target it was made from', () => {
        const p = build(absent());
        expect(p.units[0].action).toBe('keep');
        expect(p.units[0].target_sha256).toBe(targetHash('the woman in the red coat', absent() as never));
    });
});

describe('freshness hashes', () => {
    test('stable under key order, and each input changes its own hash only', () => {
        expect(stableHash({ a: 1, b: [1, { c: 2, d: 3 }] })).toBe(stableHash({ b: [1, { d: 3, c: 2 }], a: 1 }));
        const entry = { id: 's1', first: 0, end: 10, point: [1, 2], reverse: false, tier: '480', expand: 32, prompt: 'p' } as any;
        const base = freshOf({ photoSha256: 'p', card: 'c', target: { x: 1 }, entry });
        expect(freshOf({ photoSha256: 'p', card: 'c', target: { x: 1 }, entry })).toEqual(base);
        expect(freshOf({ photoSha256: 'q', card: 'c', target: { x: 1 }, entry }).photo).not.toBe(base.photo);
        expect(freshOf({ photoSha256: 'p', card: 'd', target: { x: 1 }, entry }).card).not.toBe(base.card);
        expect(freshOf({ photoSha256: 'p', card: 'c', target: { x: 2 }, entry }).target).not.toBe(base.target);
        expect(freshOf({ photoSha256: 'p', card: 'c', target: { x: 1 }, entry: { ...entry, prompt: 'z' } }).plan).not.toBe(base.plan);
        expect(freshOf({ photoSha256: 'p', card: 'c', target: { x: 1 }, entry: { ...entry, point: [1, 3] } }).plan).not.toBe(base.plan);
        // The generation seed is a plan input too.
        expect(freshOf({ photoSha256: 'p', card: 'c', target: { x: 1 }, entry: { ...entry, crop: { x: 0, y: 0, w: 64, h: 64 } } }).plan).not.toBe(base.plan);
    });
});

describe('the skill text', () => {
    const dir = path.resolve(import.meta.dir, '../../skills/tiktok-video-remake');
    const docs = [path.join(dir, 'SKILL.md'), ...readdirSync(path.join(dir, 'references')).map((f) => path.join(dir, 'references', f))];
    test('asks nobody for consent or rights, and has no gate', () => {
        for (const f of docs) {
            const t = readFileSync(f, 'utf8');
            expect(t).not.toMatch(/--consent|--rights|stated consent|agreed to appear|refuse to proceed|basis for (a video|publishing)/i);
        }
    });
    test('names no tool of one assistant: every step is a command with JSON output', () => {
        const t = readFileSync(path.join(dir, 'SKILL.md'), 'utf8');
        expect(t).not.toMatch(/javascript_tool|claude-in-chrome|AskUserQuestion|mcp__|Claude Code|\bClaude\b/);
        expect(t).toMatch(/--json/);
        expect(t).toMatch(/publish prepare --ai-generated/);
    });
    test('keeps the content limits in one paragraph', () => {
        const t = readFileSync(path.join(dir, 'SKILL.md'), 'utf8');
        expect(t).toMatch(/never depict a minor/i);
        expect(t).toMatch(/impersonate a public figure/i);
    });
});
