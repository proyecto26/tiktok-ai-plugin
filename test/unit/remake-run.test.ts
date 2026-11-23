// tiktok-video-remake: identity, targets, plan and run end to end against a fake ComfyUI, then the sound and the
// canvas. The fake "generates" by returning the clip it was sent; everything else (ffmpeg cuts, crops, reversal, the
// join of stretches, freshness, resume, audio) is the real thing. Needs ffmpeg and ffprobe.
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { FINE_RATE, findOffset } from '../../skills/tiktok-video-remake/scripts/audio.ts';
import * as ff from '../../skills/tiktok-video-remake/scripts/ff.ts';
import { main } from '../../skills/tiktok-video-remake/scripts/main.ts';
import { startFakeComfy } from './fake-comfy.ts';

const have = spawnSync('ffmpeg', ['-version']).status === 0 && spawnSync('ffprobe', ['-version']).status === 0;
const TMP = mkdtempSync(path.join(os.tmpdir(), 'tt-run-'));
const fake = startFakeComfy();
afterAll(() => {
    fake.stop();
    rmSync(TMP, { recursive: true, force: true });
});

const sh = (args: string[]) => {
    const r = spawnSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', ...args], { encoding: 'utf8' });
    if (r.status !== 0) throw new Error(r.stderr);
};
const read = (f: string) => JSON.parse(readFileSync(f, 'utf8'));
const write = (f: string, v: unknown) => writeFileSync(f, JSON.stringify(v, null, 2));
const card = { hair: 'long dark brown hair worn loose', face: 'an oval face with dark eyes', skin: 'light olive skin', build: 'slim build', distinctive_marks: 'a small mole under the left eye', jewellery: 'none', default_wardrobe: 'a black lace sleeveless mini dress' };
const shotCard = { framing: 'medium shot from head to hips', camera_move: 'static camera', light: 'flat studio light', wardrobe: 'a red coat', action: 'stands and turns her head' };
const box = [60, 100, 40, 90];
const COMFY = ['--comfy-url', fake.url];

// 18 s at 30 fps, 180x320: scene 1 white (0-59), scene 2 black for 12 s (60-419, longer than 10 s: two stretches),
// scene 3 gray (420-479), scene 4 blue (480-539). The sound is a tone whose pitch rises, so no two seconds are alike.
const SOURCE = path.join(TMP, 'source.mp4');
const PHOTO = path.join(TMP, 'photo.jpg');

beforeAll(() => {
    if (!have) return;
    sh(['-f', 'lavfi', '-i', 'color=c=white:s=180x320:r=30:d=2', '-f', 'lavfi', '-i', 'color=c=black:s=180x320:r=30:d=12', '-f', 'lavfi', '-i', 'color=c=0x808080:s=180x320:r=30:d=2', '-f', 'lavfi', '-i', 'color=c=blue:s=180x320:r=30:d=2',
        '-f', 'lavfi', '-i', "aevalsrc='sin(2*PI*(220+40*t)*t)*(0.55+0.4*sin(2*PI*0.37*t*t/4))':s=44100:d=18",
        '-filter_complex', '[0][1][2][3]concat=n=4:v=1:a=0[v]', '-map', '[v]', '-map', '4:a', '-c:v', 'libx264', '-crf', '12', '-pix_fmt', 'yuv420p', '-c:a', 'aac', SOURCE]);
    sh(['-f', 'lavfi', '-i', 'color=c=white:s=64x64', '-frames:v', '1', PHOTO]);
}, 60_000);

const answers = () => ({
    subject: 'the woman in the red coat',
    stretches: {
        s1: { present: true, seen_at: [0], seed: 'first', point: [90, 160], box_first: box, box_last: box, others: [], ...shotCard },
        s2_1: { present: true, seen_at: [2], seed: 'first', point: [90, 160], box_first: [10, 40, 150, 250], box_last: [10, 40, 150, 250], others: ['a man in a grey hoodie'], ...shotCard },
        s2_2: { present: false, absent_checked: true },
        s3: { present: true, seen_at: [15], seed: { t: 15, point: [90, 160], box }, box_first: box, box_last: box, others: [], ...shotCard },
        s4: { present: false, absent_checked: true },
    },
});

describe.skipIf(!have)('remake from a plan: identity, targets, plan, run', () => {
    const run = path.join(TMP, 'flow');
    const M = () => read(path.join(run, 'remake.json'));
    const plan = () => read(path.join(run, 'plan.json'));
    const swapped = ['s1', 's2_1', 's3_a', 's3_b'];
    const count = () => fake.counts();
    const since = (before: Record<string, number>) => Object.entries(count()).flatMap(([k, n]) => (n - (before[k] ?? 0) > 0 ? [k] : [])).sort();

    test('init takes a source and a photo and nothing else', async () => {
        await main(['init', run, '--source', SOURCE, '--identity', PHOTO, '--json']);
        expect(M().schema).toBe('tt.remake.v1');
        expect(M().source.cuts).toEqual([60, 420, 480]);
        expect(M().source.frames).toBe(540);
    }, 120_000);

    test('identity: a task for the photo, a validated card, the same text in every prompt', async () => {
        await main(['identity', run, '--json']);
        const task = read(path.join(run, 'identity_task.json'));
        expect(task.photo).toBe('refs/identity.jpg');
        expect(Object.keys(task.fields)).toEqual(['hair', 'face', 'skin', 'build', 'distinctive_marks', 'jewellery', 'default_wardrobe']);
        expect(M().character).toBeUndefined();
        write(path.join(run, 'identity_card.json'), { ...card, hair: '' });
        await expect(main(['identity', run, '--json'])).rejects.toThrow(/hair is required/);
        write(path.join(run, 'identity_card.json'), card);
        await main(['identity', run, '--json']);
        expect(M().character).toContain('long dark brown hair worn loose');
    });

    test('plan refuses without targets and prints the command; targets writes the strip tasks', async () => {
        await expect(main(['plan', run, '--json'])).rejects.toThrow(/Run targets .*flow/);
        await expect(main(['targets', run, '--check', '--json'])).rejects.toThrow(/There is no targets\.json/);
        await main(['targets', run, '--json']);
        const t = read(path.join(run, 'target_tasks.json'));
        expect(t.stretches.map((s: any) => s.id)).toEqual(['s1', 's2_1', 's2_2', 's3', 's4']);
        // the long shot is two stretches that share 8 frames
        const [a, b] = t.stretches.filter((s: any) => s.scene === 2);
        expect(a.end_frame - b.first_frame).toBe(8);
        expect(a.end_frame - a.first_frame).toBeLessThanOrEqual(300);
        // every strip is dense enough to catch a person who walks through between samples
        expect(t.strip_gap_max_seconds).toBeLessThanOrEqual(0.25);
        for (const s of t.stretches) {
            expect(s.strip[0].frame).toBe(s.first_frame);
            expect(s.strip.at(-1).frame).toBe(s.end_frame - 1);
            for (let i = 1; i < s.strip.length; i++) expect(s.strip[i].t - s.strip[i - 1].t).toBeLessThanOrEqual(0.25 + 1e-6);
            for (const e of s.strip) expect(existsSync(path.join(run, e.file))).toBe(true);
            expect(existsSync(path.join(run, s.first_frame_file))).toBe(true);
            expect(existsSync(path.join(run, s.last_frame_file))).toBe(true);
        }
    }, 120_000);

    test('targets --check names what is missing', async () => {
        const bad = answers() as any;
        delete bad.stretches.s2_2;
        bad.stretches.s1.seen_at = [];
        bad.stretches.s4 = { present: false };
        write(path.join(run, 'targets.json'), bad);
        const e: Error = await main(['targets', run, '--check', '--json']).catch((x) => x);
        expect(e.message).toMatch(/s2_2 has no answer/);
        expect(e.message).toMatch(/s1: seen_at is required/);
        expect(e.message).toMatch(/s4: absent_checked must be true/);
        // and the plan is not made from an incomplete answer
        await expect(main(['plan', run, '--json'])).rejects.toThrow(/not complete/);
        write(path.join(run, 'targets.json'), answers());
        await main(['targets', run, '--check', '--json']);
    });

    test('plan: swap where the subject is, keep where not, a crop for the small subject, a split for the seed time', async () => {
        await main(['plan', run, '--json']);
        const p = plan();
        expect(p.units.map((u: any) => `${u.id}:${u.action}`)).toEqual(['s1:swap', 's2_1:swap', 's2_2:keep', 's3_a:swap', 's3_b:swap', 's4:keep']);
        const u = Object.fromEntries(p.units.map((x: any) => [x.id, x]));
        expect(u.s1).toMatchObject({ first: 0, end: 60, reverse: false, point: [90, 160], tier: '480', expand: 32 });
        expect(u.s1.crop.w * 16).toBe(u.s1.crop.h * 9);
        expect(u.s2_1.crop).toBeUndefined(); // 250 of 320 high: the whole frame
        expect(u.s2_1.tier).toBe('768');
        expect(u.s2_1).toMatchObject({ first: 60, end: 244 });
        expect(u.s2_2).toMatchObject({ first: 236, end: 420 });
        expect(u.s3_a).toMatchObject({ first: 420, end: 451, reverse: true, seed_frame: 450 });
        expect(u.s3_b).toMatchObject({ first: 450, end: 480, reverse: false, seed_frame: 450 });
        expect(u.s1.prompt).toContain(M().character);
        expect(u.s1.prompt).toContain('stands and turns her head');
        await main(['plan', run, '--check', '--json']);
        const edited = JSON.parse(JSON.stringify(p));
        edited.units[0].tier = '1024';
        write(path.join(run, 'plan.json'), edited);
        await expect(main(['plan', run, '--check', '--json'])).rejects.toThrow(/s1: tier/);
        write(path.join(run, 'plan.json'), p);
    });

    test('swap --scene takes the planned prompt, point, crop and tier by default, and run reuses that attempt', async () => {
        await main(['swap', run, '--scene', '1', ...COMFY, '--json']);
        expect(fake.submissions).toHaveLength(1);
        const g = fake.submissions[0].graph;
        const u = plan().units[0];
        expect(g['801'].inputs.prompt).toBe(u.prompt);
        expect(g['31'].inputs.resolution).toBe('480');
        expect(g['110'].inputs.expansion_px).toBe(32);
        // the point travels in the pixels of the frame the model works at, inside the crop
        expect(JSON.parse(g['103'].inputs.positive_coords)).toHaveLength(1);
        expect(M().shots[0]).toMatchObject({ id: 's1', frames: [0, 60], crop: u.crop });
        // a scene made of several runs must be named
        await expect(main(['swap', run, '--scene', '3', ...COMFY, '--json'])).rejects.toThrow(/planned as 2 runs.*--unit/);
    }, 120_000);

    test('run: swaps and places every stretch with the subject, joins the stretches, assembles with --auto-approve', async () => {
        await main(['run', run, ...COMFY, '--auto-approve', '--json']);
        // s1 was made by the swap above and is reused, the other three are generated once each
        expect(count()).toEqual({ s1: 1, s2_1: 1, s3_a: 1, s3_b: 1 });
        // the reversed half runs backwards: the driving clip the fake saw, played forward, is what came back
        const m = M();
        expect(m.shots.map((s: any) => s.id).sort()).toEqual(['s1', 's2', 's2_1', 's3', 's3_a', 's3_b']);
        const s2 = m.shots.find((s: any) => s.id === 's2');
        expect(s2.parts).toEqual([{ shot: 's2_1' }, { source: [236, 420] }]);
        // every source frame of a shot appears once: the placed shots have exactly the frames of their scenes
        const frames = async (id: string) => (await ff.probe(path.join(run, 'shots', id, 'placed.mp4'))).frames;
        expect(await frames('s1')).toBe(60);
        expect(await frames('s2')).toBe(360);
        expect(await frames('s3')).toBe(60);
        expect(m.timeline.segments).toEqual([{ shot: 's1' }, { shot: 's2' }, { shot: 's3' }, { source: [16, 18] }]);
        const t = await ff.probe(path.join(run, 'timeline.mp4'));
        expect(t.frames).toBe(540);
        expect(m.shots.filter((s: any) => ['s1', 's2', 's3'].includes(s.id)).every((s: any) => s.approved)).toBe(true);
    }, 600_000);

    test('running again generates nothing', async () => {
        const before = { ...count() };
        await main(['run', run, ...COMFY, '--json']);
        await main(['run', run, ...COMFY, '--resume', '--json']);
        expect(since(before)).toEqual([]);
        // and the approvals survive it
        expect(M().shots.find((s: any) => s.id === 's2').approved).toBeDefined();
    }, 120_000);

    test('audio: the source sound, final.mp4 and final_silent.mp4 on the 1080x1920 canvas', async () => {
        const m = M();
        m.source.sound = { musicId: '7300000000000000001', title: 'original sound', artist: 'someone', kind: 'original_audio' };
        write(path.join(run, 'remake.json'), m);
        await main(['audio', run, '--json']);
        const fin = await ff.probe(path.join(run, 'final.mp4'));
        const sil = await ff.probe(path.join(run, 'final_silent.mp4'));
        expect([fin.width, fin.height]).toEqual([1080, 1920]);
        expect([sil.width, sil.height]).toEqual([1080, 1920]);
        expect(fin.hasAudio).toBe(true);
        expect(sil.hasAudio).toBe(false);
        expect(fin.frames).toBe(540);
        expect(M().audio).toMatchObject({ mode: 'source', sound: { musicId: '7300000000000000001', title: 'original sound' } });
        expect(M().final).toMatchObject({ file: 'final.mp4', silent: { file: 'final_silent.mp4' }, canvas: 'fit' });
        // --audio none: both files are silent
        await main(['audio', run, '--audio', 'none', '--json']);
        expect((await ff.probe(path.join(run, 'final.mp4'))).hasAudio).toBe(false);
        expect(M().audio.mode).toBe('none');
        await expect(main(['audio', run, '--audio', 'none', '--file', 'x.mp3'])).rejects.toThrow(/not both/);
    }, 300_000);

    test('the sound follows the timeline: a reordered timeline plays each piece of the source sound with its picture', async () => {
        // s2 (source 2-14 s) first, then s1 (source 0-2 s): the sound must be source 2-14, then 0-2
        await main(['assemble', run, '--segments', 'shot:s2,shot:s1', '--json']);
        await main(['audio', run, '--json']);
        const source = await ff.decodeAudio(SOURCE, FINE_RATE);
        const out = await ff.decodeAudio(path.join(run, 'final.mp4'), FINE_RATE);
        expect(Math.abs(out.length / FINE_RATE - 14)).toBeLessThan(0.1);
        const window = (t: number) => out.slice(Math.round(t * FINE_RATE), Math.round((t + 2) * FINE_RATE));
        // a window of the first piece (timeline 5-7 s is source 7-9 s), and of the second (timeline 12.5-14 s is source 0.5-2 s)
        const a = findOffset(source, window(5));
        expect(a.verdict).toBe('match');
        expect(Math.abs(a.offset - 7)).toBeLessThan(0.03);
        const b = findOffset(source, out.slice(Math.round(12.3 * FINE_RATE), Math.round(13.9 * FINE_RATE)));
        expect(b.verdict).toBe('match');
        expect(Math.abs(b.offset - 0.3)).toBeLessThan(0.03);
        await main(['assemble', run, '--segments', 'shot:s1,shot:s2,shot:s3,source:16-18', '--json']);
    }, 300_000);

    test('a continued shot has no source sound: --file is needed, and the sound is never looped', async () => {
        const m = M();
        // a stand-in continuation of s1, as if `continue` had run
        const gen = path.join(run, 'shots', 's1', 'attempt1.mp4');
        const s1 = m.shots.find((s: any) => s.id === 's1');
        const prev = s1.attempts.at(-1);
        m.shots.push({ id: 'more', kind: 'continue', after: 's1', attempts: [{ n: 1, at: 'x', kind: 'continue', settings: { afterAttempt: prev.n, afterSha256: prev.outputSha256, guideFrames: 25 }, graphHash: 'h', clientId: 'c', status: 'done', output: path.relative(run, gen).replace(/\\/g, '/'), outputSha256: prev.outputSha256, frames: 60 }] });
        write(path.join(run, 'remake.json'), m);
        await main(['place', run, '--shot', 'more', '--json']);
        await main(['approve', run, '--shot', 'more', '--json']);
        await main(['assemble', run, '--segments', 'shot:s1,shot:more', '--json']);
        await expect(main(['audio', run, '--json'])).rejects.toThrow(/continued shot "more"/);
        const long = path.join(TMP, 'long.wav');
        sh(['-f', 'lavfi', '-i', "aevalsrc='sin(2*PI*(300+30*t)*t)':s=44100:d=8", long]);
        await main(['audio', run, '--file', long, '--start', '1', '--json']);
        expect(M().audio).toMatchObject({ mode: 'file', start: 1 });
        expect(M().final.silent.file).toBe('final_silent.mp4');
        await main(['assemble', run, '--segments', 'shot:s1,shot:s2,shot:s3,source:16-18', '--json']);
    }, 300_000);

    test('editing the card regenerates every swapped shot, and clears the sound and both finals', async () => {
        await main(['audio', run, '--json']);
        expect(M().final).toBeDefined();
        const before = { ...count() };
        write(path.join(run, 'identity_card.json'), { ...card, hair: 'short red hair' });
        await main(['identity', run, '--json']);
        const m = M();
        expect(m.audio).toBeUndefined();
        expect(m.final).toBeUndefined();
        expect(m.timeline).toBeUndefined();
        expect(m.shots.filter((s: any) => s.kind === 'swap' && !s.parts).every((s: any) => !s.placed && !s.approved)).toBe(true);
        // the prompts repeat the card, so a plan made with the old one is refused
        await expect(main(['run', run, ...COMFY, '--json'])).rejects.toThrow(/card changed after the plan/);
        await main(['plan', run, '--json']);
        await main(['run', run, ...COMFY, '--auto-approve', '--json']);
        expect(since(before)).toEqual(swapped.slice().sort());
        for (const id of swapped) expect(count()[id]).toBeGreaterThan(before[id] ?? 0);
        expect(plan().units[0].prompt).toContain('short red hair');
    }, 600_000);

    test('editing a target point regenerates exactly that shot', async () => {
        const before = { ...count() };
        const t = read(path.join(run, 'targets.json'));
        t.stretches.s2_1.point = [100, 170];
        write(path.join(run, 'targets.json'), t);
        // the shot is out of date as soon as the target is checked, and its placement is cleared
        await main(['targets', run, '--check', '--json']);
        expect(M().shots.find((s: any) => s.id === 's2_1').placed).toBeUndefined();
        expect(M().shots.find((s: any) => s.id === 's2').placed).toBeUndefined();
        expect(M().timeline).toBeUndefined();
        // run refuses a plan made before the edit
        await expect(main(['run', run, ...COMFY, '--json'])).rejects.toThrow(/targets changed after these runs were planned: s2_1/);
        await main(['plan', run, '--json']);
        expect(plan().units.find((u: any) => u.id === 's2_1').point).toEqual([100, 170]);
        await main(['run', run, ...COMFY, '--auto-approve', '--json']);
        expect(since(before)).toEqual(['s2_1']);
    }, 600_000);

    test('editing a plan prompt regenerates exactly that shot', async () => {
        const before = { ...count() };
        const p = plan();
        p.units.find((u: any) => u.id === 's3_b').prompt += ' The person is smiling.';
        write(path.join(run, 'plan.json'), p);
        await main(['plan', run, '--check', '--json']);
        await main(['run', run, ...COMFY, '--auto-approve', '--json']);
        expect(since(before)).toEqual(['s3_b']);
        // the join of s3 was made again from the new part
        expect(M().shots.find((s: any) => s.id === 's3').placed).toBeDefined();
    }, 600_000);

    test('changing the identity photo regenerates every swapped shot', async () => {
        const before = { ...count() };
        const other = path.join(TMP, 'photo2.jpg');
        sh(['-f', 'lavfi', '-i', 'color=c=red:s=64x64', '-frames:v', '1', other]);
        await main(['identity', run, '--photo', other, '--json']);
        expect(M().shots.filter((s: any) => !s.parts).every((s: any) => !s.placed)).toBe(true);
        await main(['run', run, ...COMFY, '--auto-approve', '--json']);
        expect(since(before)).toEqual(swapped.slice().sort());
    }, 600_000);

    test('run stops at the first failed shot with its name, and --resume does not redo the finished ones', async () => {
        const before = { ...count() };
        const p = plan();
        for (const id of ['s1', 's2_1']) p.units.find((u: any) => u.id === id).seed = 11;
        write(path.join(run, 'plan.json'), p);
        fake.state.fail.add('s2_1');
        const e: Error = await main(['run', run, ...COMFY, '--json']).catch((x) => x);
        expect(e.message).toMatch(/Stopped at s2_1/);
        expect(since(before)).toEqual(['s1']); // s1 was generated; s2_1 was refused, so it is not a submission
        fake.state.fail.clear();
        const mid = { ...count() };
        expect(mid.s1).toBe((before.s1 ?? 0) + 1);
        await main(['run', run, ...COMFY, '--resume', '--auto-approve', '--json']);
        expect(since(mid)).toEqual(['s2_1']);
        expect(M().timeline).toBeDefined();
    }, 600_000);

    test('status says what exists and what is next; doctor accepts the fake server', async () => {
        await main(['status', run, '--json']);
        process.exitCode = 0;
        await main(['doctor', ...COMFY, '--json']);
        expect(process.exitCode).toBe(0);
    });
});

describe.skipIf(!have)('a landscape source ends on the 1080x1920 canvas, and a cropped swap with it', () => {
    test('a hand-made shot in a 640x360 source, exported fit and cover', async () => {
        const run = path.join(TMP, 'land');
        const src = path.join(TMP, 'land.mp4');
        sh(['-f', 'lavfi', '-i', 'testsrc2=s=640x360:r=30:d=3', '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=44100:duration=3', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', src]);
        await main(['init', run, '--source', src, '--identity', PHOTO, '--json']);
        await main(['assemble', run, '--segments', 'source:0-3', '--json']);
        await main(['audio', run, '--json']);
        let p = await ff.probe(path.join(run, 'final.mp4'));
        expect([p.width, p.height, p.hasAudio]).toEqual([1080, 1920, true]);
        await main(['audio', run, '--canvas', 'cover', '--json']);
        p = await ff.probe(path.join(run, 'final.mp4'));
        expect([p.width, p.height]).toEqual([1080, 1920]);
        expect(JSON.parse(readFileSync(path.join(run, 'remake.json'), 'utf8')).final.canvas).toBe('cover');
        await expect(main(['audio', run, '--canvas', 'stretch'])).rejects.toThrow(/fit or cover/);
    }, 300_000);
});
