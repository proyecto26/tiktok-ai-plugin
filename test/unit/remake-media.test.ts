// tiktok-video-remake: the ffmpeg steps added to the port (strip frames, joining overlapped stretches, the canvas
// export, sound from the source following the timeline). These need ffmpeg and ffprobe: they do not skip here.
import { describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { FINE_RATE, findOffset } from '../../skills/tiktok-video-remake/scripts/audio.ts';
import * as ff from '../../skills/tiktok-video-remake/scripts/ff.ts';
import { sceneStretches, stripFrames, stretchesOfScene, OVERLAP_FRAMES } from '../../skills/tiktok-video-remake/scripts/stretch.ts';

const TMP = mkdtempSync(path.join(os.tmpdir(), 'tt-media-'));
const have = spawnSync('ffmpeg', ['-version']).status === 0 && spawnSync('ffprobe', ['-version']).status === 0;

const sh = (args: string[]) => {
    const r = spawnSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', ...args], { encoding: 'utf8' });
    if (r.status !== 0) throw new Error(r.stderr);
};
/** Average luma of every frame (an 8x8 thumbnail), in order. */
function lumas(file: string): number[] {
    const r = spawnSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-i', file, '-vf', 'scale=8:8:flags=area,format=gray', '-fps_mode', 'passthrough', '-f', 'rawvideo', '-'], { maxBuffer: 1 << 28 });
    const b = r.stdout as Buffer;
    const out: number[] = [];
    for (let i = 0; i + 64 <= b.length; i += 64) out.push(b.subarray(i, i + 64).reduce((s, v) => s + v, 0) / 64);
    return out;
}
const pixel = (file: string, x: number, y: number, t = 0): number[] => {
    const r = spawnSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-ss', String(t), '-i', file, '-frames:v', '1', '-vf', `crop=2:2:${x}:${y},scale=1:1`, '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-']);
    return Array.from(r.stdout as Buffer);
};

describe('media tools are present', () => {
    test('ffmpeg and ffprobe are on PATH, so the media tests run instead of skipping', () => expect(have).toBe(true));
});

describe.skipIf(!have)('remake strip frames', () => {
    test('a subject that is on screen only between the first and the last frame appears in the strip', async () => {
        // 3 s at 30 fps, blue; frames 40-47 (a quarter of a second, the person walking through) are red.
        const src = path.join(TMP, 'brief.mp4');
        sh(['-f', 'lavfi', '-i', 'color=c=blue:s=96x160:r=30:d=3', '-vf', "drawbox=x=0:y=0:w=96:h=160:color=red:t=fill:enable='between(n,40,47)'", '-c:v', 'libx264', '-crf', '8', '-pix_fmt', 'yuv420p', src]);
        const picks = stripFrames(0, 90, 30);
        const files = await ff.extractFrames(src, path.join(TMP, 'strip'), { first: 0, count: 90, fps: 30, picks, maxSide: 64 });
        expect(files).toHaveLength(picks.length);
        const reds = files.map((f) => pixel(f, 20, 20)).filter((p) => p[0] > 150 && p[2] < 100);
        expect(reds.length).toBeGreaterThanOrEqual(1);
        // the frames are the right ones: frame 42 is red, frame 35 is blue
        expect(picks).toContain(42);
        expect(pixel(path.join(TMP, 'strip', 'f42.jpg'), 20, 20)[0]).toBeGreaterThan(150);
        expect(pixel(path.join(TMP, 'strip', 'f35.jpg'), 20, 20)[2]).toBeGreaterThan(150);
    });
    test('frames are read from the middle of a file by absolute number', async () => {
        const src = path.join(TMP, 'ramp.mp4');
        sh(['-f', 'lavfi', '-i', 'color=c=black:s=64x64:r=30:d=4', '-vf', "geq=lum='N*2':cb=128:cr=128", '-c:v', 'libx264', '-crf', '8', '-pix_fmt', 'yuv420p', src]);
        const files = await ff.extractFrames(src, path.join(TMP, 'ramp'), { first: 50, count: 40, fps: 30, picks: [50, 60, 89] });
        const l = files.map((f) => pixel(f, 10, 10)[0]);
        expect(Math.abs(l[0] - 100)).toBeLessThan(14);
        expect(Math.abs(l[1] - 120)).toBeLessThan(14);
        expect(Math.abs(l[2] - 178)).toBeLessThan(14);
        expect(l[0] < l[1] && l[1] < l[2]).toBe(true);
        await expect(ff.extractFrames(src, path.join(TMP, 'ramp'), { first: 50, count: 40, fps: 30, picks: [90] })).rejects.toThrow(/inside the stretch/);
    });
});

describe.skipIf(!have)('remake joins overlapped stretches so every frame appears once', () => {
    test('two clips overlapping by 8 frames become exactly the source, with no gap and no repeat at the seam', async () => {
        const src = path.join(TMP, 'seam.mp4');
        sh(['-f', 'lavfi', '-i', 'color=c=black:s=64x64:r=30:d=4', '-vf', "geq=lum='N*2':cb=128:cr=128", '-c:v', 'libx264', '-crf', '8', '-pix_fmt', 'yuv420p', src]);
        const clip = (name: string, a: number, b: number) => {
            const f = path.join(TMP, name);
            sh(['-i', src, '-vf', `trim=start_frame=${a}:end_frame=${b},setpts=PTS-STARTPTS`, '-c:v', 'libx264', '-crf', '8', '-pix_fmt', 'yuv420p', f]);
            return f;
        };
        const A = clip('seamA.mp4', 0, 70);
        const B = clip('seamB.mp4', 62, 110);
        const out = path.join(TMP, 'seamjoin.mp4');
        await ff.joinOverlap({ file: A, frames: 70 }, { file: B, frames: 48 }, OVERLAP_FRAMES, out);
        const got = lumas(out);
        expect(got).toHaveLength(110);
        const want = lumas(src).slice(0, 110);
        // identical content on both sides of the seam: every frame is the source frame of its own position
        got.forEach((v, i) => expect(Math.abs(v - want[i])).toBeLessThan(6));
        // and it is a one-frame overlap too
        const out1 = path.join(TMP, 'seamjoin1.mp4');
        const C = clip('seamC.mp4', 0, 31);
        const D = clip('seamD.mp4', 30, 100);
        await ff.joinOverlap({ file: C, frames: 31 }, { file: D, frames: 70 }, 1, out1);
        const g1 = lumas(out1);
        expect(g1).toHaveLength(100);
        g1.forEach((v, i) => expect(Math.abs(v - want[i])).toBeLessThan(6));
    });
    test('the stretches of a long shot, joined, give exactly the frames of the shot', async () => {
        const fps = 30;
        const total = 760;
        const stretches = stretchesOfScene({ n: 1, first: 0, end: total }, fps);
        expect(stretches.length).toBe(3);
        const src = path.join(TMP, 'long.mp4');
        sh(['-f', 'lavfi', '-i', `color=c=black:s=32x32:r=${fps}:d=${total / fps}`, '-vf', "geq=lum='mod(N,250)':cb=128:cr=128", '-c:v', 'libx264', '-crf', '10', '-pix_fmt', 'yuv420p', src]);
        let joined = '';
        let frames = 0;
        for (const [i, s] of stretches.entries()) {
            const f = path.join(TMP, `long_${i}.mp4`);
            sh(['-i', src, '-vf', `trim=start_frame=${s.first}:end_frame=${s.end},setpts=PTS-STARTPTS`, '-c:v', 'libx264', '-crf', '10', '-pix_fmt', 'yuv420p', f]);
            if (!joined) {
                joined = f;
                frames = s.end - s.first;
                continue;
            }
            const out = path.join(TMP, `long_join${i}.mp4`);
            await ff.joinOverlap({ file: joined, frames }, { file: f, frames: s.end - s.first }, OVERLAP_FRAMES, out);
            joined = out;
            frames += s.end - s.first - OVERLAP_FRAMES;
        }
        expect(frames).toBe(total);
        expect((await ff.probe(joined)).frames).toBe(total);
        expect(sceneStretches([], total, fps).map((s) => s.id)).toEqual(['s1_1', 's1_2', 's1_3']);
    }, 120_000);
});

describe.skipIf(!have)('remake canvas export: 1080x1920 whatever the source', () => {
    const size = async (f: string) => {
        const p = await ff.probe(f);
        return `${p.width}x${p.height}`;
    };
    const make = (name: string, s: string) => {
        const f = path.join(TMP, name);
        sh(['-f', 'lavfi', '-i', `testsrc2=s=${s}:r=30:d=1`, '-c:v', 'libx264', '-pix_fmt', 'yuv420p', f]);
        return f;
    };
    test('1080x1920 stays; 720x1280 is scaled', async () => {
        for (const [n, s, w, h] of [['c1.mp4', '1080x1920', 1080, 1920], ['c2.mp4', '720x1280', 720, 1280]] as const) {
            const out = path.join(TMP, `out_${n}`);
            await ff.exportCanvas(make(n, s), out, 'fit', { width: w, height: h });
            expect(await size(out)).toBe('1080x1920');
            expect((await ff.probe(out)).frames).toBe(30);
        }
    });
    test('a landscape source is fitted over a blurred copy of itself, or cover-cropped', async () => {
        const src = make('land.mp4', '1920x1080');
        const fit = path.join(TMP, 'land_fit.mp4');
        await ff.exportCanvas(src, fit, 'fit', { width: 1920, height: 1080 });
        expect(await size(fit)).toBe('1080x1920');
        // the bars above and below are not black: they are the blurred picture
        const top = pixel(fit, 540, 100);
        expect(top.reduce((a, b) => a + b, 0)).toBeGreaterThan(60);
        // the whole picture is visible in the middle band (1080x607): its left and right edges are in the output
        const mid = pixel(fit, 3, 960);
        expect(mid.reduce((a, b) => a + b, 0)).toBeGreaterThan(30);
        const cover = path.join(TMP, 'land_cover.mp4');
        await ff.exportCanvas(src, cover, 'cover', { width: 1920, height: 1080 });
        expect(await size(cover)).toBe('1080x1920');
        // cover crops the sides, fit does not: a pixel in the middle band, 3 px from the left edge, shows the picture's
        // left edge in fit and a point well inside the picture in cover
        expect(pixel(cover, 3, 960)).not.toEqual(pixel(fit, 3, 960));
    });
});

describe.skipIf(!have)('remake sound follows the timeline map', () => {
    // A 12 s mono track whose pitch and loudness never repeat, so any 1 s window can be located in it.
    const track = path.join(TMP, 'tone.wav');
    sh(['-f', 'lavfi', '-i', "aevalsrc='sin(2*PI*(220+60*t)*t)*(0.55+0.4*sin(2*PI*0.37*t*t/4))':s=44100:d=12", '-c:a', 'pcm_s16le', track]);
    test('each piece of the soundtrack is the source audio of its own range, in timeline order', async () => {
        const out = path.join(TMP, 'mapped.wav');
        const pieces = [
            { at: 0, length: 2, from: 7 }, // a later part first (a reorder)
            { at: 2, length: 2, from: 1 },
            { at: 4, length: 2, from: 3 }, // not a neighbour of the previous piece's end (3 s) -> crossfaded join
            { at: 6, length: 2, from: 5 }, // neighbour of the previous end (5 s): no join at all
        ];
        await ff.audioFromPieces(track, out, pieces, { total: 8, sourceLength: 12, eps: 0.017 });
        expect(Math.abs((await ff.audioLength(out)) - 8)).toBeLessThan(0.05);
        const source = await ff.decodeAudio(track, FINE_RATE);
        const mapped = await ff.decodeAudio(out, FINE_RATE);
        for (const p of pieces) {
            // the middle of the piece, away from its crossfaded ends
            const clip = mapped.slice(Math.round((p.at + 0.3) * FINE_RATE), Math.round((p.at + p.length - 0.3) * FINE_RATE));
            const r = findOffset(source, clip);
            expect(r.verdict).toBe('match');
            expect(Math.abs(r.offset - (p.from + 0.3))).toBeLessThan(0.01);
        }
    });
    test('without a join the piece is one continuous cut of the source', async () => {
        const out = path.join(TMP, 'one.wav');
        await ff.audioFromPieces(track, out, [{ at: 0, length: 3, from: 2 }], { total: 3, sourceLength: 12, eps: 0.017 });
        const source = await ff.decodeAudio(track, FINE_RATE);
        const mapped = await ff.decodeAudio(out, FINE_RATE);
        const r = findOffset(source, mapped.slice(0, 3 * FINE_RATE - 100));
        expect(r.verdict).toBe('match');
        expect(Math.abs(r.offset - 2)).toBeLessThan(0.005);
        expect(existsSync(out) && readFileSync(out).length > 1000).toBe(true);
    });
});
