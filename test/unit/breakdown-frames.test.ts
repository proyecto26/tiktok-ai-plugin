// analyze on the frame time base: exact frame cuts, a CFR working copy for VFR sources, frame corrections.
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { frameDiffsAround } from '../../skills/tiktok-video-breakdown/scripts/timebase.ts';

const MAIN = path.resolve(import.meta.dir, '../../skills/tiktok-video-breakdown/scripts/main.ts');
const HAS_FFMPEG = spawnSync('ffmpeg', ['-version']).status === 0 && spawnSync('ffprobe', ['-version']).status === 0;
if (!HAS_FFMPEG) console.warn('[breakdown-frames] ffmpeg/ffprobe not found: tests skipped.');

describe.skipIf(!HAS_FFMPEG)('analyze on frames', () => {
    const tmp = mkdtempSync(path.join(os.tmpdir(), 'bf-'));
    const fx = (n: string) => path.join(tmp, n);
    const ff = (args: string[]) => {
        const r = spawnSync('ffmpeg', ['-hide_banner', '-nostdin', '-y', '-loglevel', 'error', ...args], { encoding: 'utf8' });
        if (r.status !== 0) throw new Error(r.stderr);
    };
    const cli = (...args: string[]) => {
        const r = spawnSync(process.execPath, [MAIN, ...args], { encoding: 'utf8' });
        let json: any = null;
        try {
            json = JSON.parse(r.stdout);
        } catch {}
        return { code: r.status, json, err: r.stderr };
    };
    const bd = (dir: string) => JSON.parse(readFileSync(path.join(dir, 'breakdown.json'), 'utf8'));
    let n = 0;
    /** fetch --file into a fresh folder, then analyze with extra flags. */
    const analyzeFixture = (file: string, extra: string[] = []) => {
        const dir = fx(`run${n++}`);
        expect(cli('fetch', '--file', file, '-o', dir).code).toBe(0);
        const r = cli('analyze', dir, ...extra);
        expect(r.code).toBe(0);
        return { dir, r: r.json, b: bd(dir) };
    };
    const s = '160x284';
    const two = (a: string, b: string, ra = 30, rb = 30, d = 2) => ['-f', 'lavfi', '-i', `color=c=${a}:s=${s}:d=${d}:r=${ra}`, '-f', 'lavfi', '-i', `color=c=${b}:s=${s}:d=${d}:r=${rb}`, '-filter_complex', '[0][1]concat=n=2:v=1:a=0[v]', '-map', '[v]', '-c:v', 'libx264', '-pix_fmt', 'yuv420p'];

    beforeAll(() => {
        ff([...two('red', 'blue'), fx('cfr.mp4')]);
        ff([...two('red', 'blue'), '-output_ts_offset', '0.5', fx('offset.mp4')]);
        ff([...two('red', 'blue', 30, 15, 1), '-fps_mode', 'vfr', fx('vfr.mp4')]);
        ff([...two('green', 'white', 30, 15, 1), '-fps_mode', 'vfr', fx('vfr2.mp4')]);
        // Video track starting 0.5 s after the file's clock (audio from 0), as phones and editors write.
        ff(['-itsoffset', '0.5', '-i', fx('cfr.mp4'), '-f', 'lavfi', '-i', 'sine=d=4.5', '-map', '0:v', '-map', '1:a', '-c:v', 'copy', '-c:a', 'aac', fx('late.mp4')]);
        // A stream-copy trim: the edit list hides the packets before the in-point (red 0-2 s, blue 2-5 s once trimmed).
        ff([...two('red', 'blue', 30, 30, 3), '-g', '60', fx('long.mp4')]);
        ff(['-ss', '1', '-i', fx('long.mp4'), '-c', 'copy', fx('trim.mp4')]);
    }, 120_000);
    /** Mean RGB of an image, from a 1x1 scale. */
    const rgb = (file: string) => {
        const r = spawnSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-i', file, '-vf', 'scale=1:1', '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-'], { encoding: 'buffer' });
        return [...r.stdout.subarray(0, 3)];
    };
    const decodedFrames = (file: string) =>
        Number(spawnSync('ffprobe', ['-v', 'error', '-select_streams', 'v:0', '-count_frames', '-show_entries', 'stream=nb_read_frames', '-of', 'csv=p=0', file], { encoding: 'utf8' }).stdout.trim());

    test('a video track that starts after the file clock: cut and shot images on the video', () => {
        const { dir, b } = analyzeFixture(fx('late.mp4'));
        expect(b.cuts.frames.final).toEqual([60]);
        const [r, , bl] = rgb(path.join(dir, b.shots[1].images.first));
        expect(bl).toBeGreaterThan(r); // shot 2 opens on blue, not on the red before the cut
    }, 60_000);
    test('frames hidden by an edit list are not counted', () => {
        const { b } = analyzeFixture(fx('trim.mp4'));
        expect(b.timebase).toMatchObject({ cfr_copy: false, frames: decodedFrames(fx('trim.mp4')) });
        expect(b.cuts.frames.final).toEqual([60]);
    }, 60_000);
    test('a manual cut that leaves a very short shot is analysed', () => {
        const { b } = analyzeFixture(fx('cfr.mp4'), ['--add-cut-frame', '117']);
        expect(b.cuts.frames.final).toEqual([60, 117]);
        expect(b.shots.map((x: any) => x.end_frame - x.first_frame)).toEqual([60, 57, 3]);
    }, 60_000);
    test('--add-cut outside the video is refused and nothing is remembered', () => {
        const { dir } = analyzeFixture(fx('cfr.mp4'));
        expect(cli('analyze', dir, '--add-cut', '10').code).toBe(2);
        expect(existsSync(path.join(dir, 'cuts_override.json'))).toBe(false);
    }, 60_000);
    test('removals in seconds keep the 0.1 s reach (typed and migrated)', () => {
        const { dir } = analyzeFixture(fx('cfr.mp4'));
        expect(cli('analyze', dir, '--remove-cut', '2.08').code).toBe(0);
        expect(bd(dir).cuts.frames.final).toEqual([]);
        writeFileSync(path.join(dir, 'cuts_override.json'), JSON.stringify({ add: [], remove: [1.92] }));
        expect(cli('analyze', dir).code).toBe(0);
        expect(bd(dir).cuts.frames.final).toEqual([]);
    }, 60_000);
    afterAll(() => rmSync(tmp, { recursive: true, force: true }));

    test('hard cut lands on its exact frame', () => {
        const { b } = analyzeFixture(fx('cfr.mp4'));
        expect(b.timebase).toMatchObject({ rate: '30/1', frames: 120, cfr_copy: false, file: 'source/video.mp4' });
        expect(b.timebase.sha256).toMatch(/^[0-9a-f]{64}$/);
        expect(b.cuts.frames.final).toEqual([60]);
        expect(b.shots.map((x: any) => [x.first_frame, x.end_frame])).toEqual([[0, 60], [60, 120]]);
        expect(b.cuts.final).toEqual([2]);
    }, 60_000);
    test('hard cut on an offset source', () => {
        const { b } = analyzeFixture(fx('offset.mp4'));
        expect(b.cuts.frames.final).toEqual([60]);
        expect(b.shots[1].start).toBe(2);
    }, 60_000);
    test('a variable-rate source is analysed on a CFR copy', async () => {
        const { dir, b } = analyzeFixture(fx('vfr.mp4'));
        // The copy runs at the source's average rate, rounded (the remake's conversion command).
        expect(b.timebase).toMatchObject({ cfr_copy: true, file: 'source/work_cfr.mp4' });
        const fps = b.timebase.fps;
        expect(b.timebase.rate).toBe(`${fps}/1`);
        expect(b.timebase.frames).toBeGreaterThan(fps * 2 - 3);
        expect(existsSync(path.join(dir, 'source/work_cfr.mp4'))).toBe(true);
        // The conversion can move the change by a frame or two; on the copy itself the cut is exact.
        const d = await frameDiffsAround(path.join(dir, 'source/work_cfr.mp4'), b.timebase, 0, b.timebase.frames);
        expect(b.cuts.frames.final).toEqual([d.indexOf(Math.max(...d)) + 1]);
    }, 60_000);
    test('stale cfr copy rebuilt', () => {
        const { dir, b: b1 } = analyzeFixture(fx('vfr.mp4'));
        expect(cli('fetch', '--file', fx('vfr2.mp4'), '-o', dir).code).toBe(0);
        expect(cli('analyze', dir).code).toBe(0);
        expect(bd(dir).timebase.sha256).not.toBe(b1.timebase.sha256);
    }, 90_000);
    test('--add-cut snaps to the change and says so; --add-cut-frame is exact', () => {
        const { dir, r } = analyzeFixture(fx('cfr.mp4'), ['--add-cut', '1.94']);
        expect(r.snapped).toEqual([{ asked: 1.94, frame: 60, moved: 2, mad: expect.any(Number) }]);
        expect(bd(dir).cuts.frames.final).toEqual([60]);
        expect(cli('analyze', dir, '--reset-cuts', '--add-cut-frame', '45').code).toBe(0);
        expect(bd(dir).cuts.frames.final).toEqual([45, 60]);
        expect(cli('analyze', dir, '--add-cut-frame', '64').code).toBe(0);
        expect(bd(dir).cuts.frames.final).toEqual([45, 64]);
    }, 90_000);
    test('--add-cut on a still keeps the asked frame', () => {
        const { r, b } = analyzeFixture(fx('cfr.mp4'), ['--add-cut', '1']);
        expect(r.snapped).toEqual([{ asked: 1, frame: 30, moved: 0, mad: null }]);
        expect(b.cuts.frames.final).toEqual([30, 60]);
    }, 60_000);
    test('--remove-cut matches within one frame', () => {
        const { b } = analyzeFixture(fx('cfr.mp4'), ['--remove-cut', '2.033']);
        expect(b.cuts.frames.final).toEqual([]);
    }, 60_000);
    test('--add-cut-frame refuses frames outside the video', () => {
        const dir = fx(`run${n++}`);
        cli('fetch', '--file', fx('cfr.mp4'), '-o', dir);
        expect(cli('analyze', dir, '--add-cut-frame', '120').code).toBe(2);
        expect(cli('analyze', dir, '--add-cut-frame', '1.5').code).toBe(2);
    }, 60_000);
    test('old overrides migrate', () => {
        const dir = fx(`run${n++}`);
        expect(cli('fetch', '--file', fx('cfr.mp4'), '-o', dir).code).toBe(0);
        writeFileSync(path.join(dir, 'cuts_override.json'), JSON.stringify({ add: [1.0], remove: [] }));
        expect(cli('analyze', dir).code).toBe(0);
        expect(bd(dir).cuts.frames.final).toEqual([30, 60]);
        expect(JSON.parse(readFileSync(path.join(dir, 'cuts_override.json'), 'utf8'))).toMatchObject({ version: 2, add: [30], remove: [] });
    }, 60_000);
    test('corrections made on another source are dropped, and the user is told', () => {
        const dir = fx(`run${n++}`);
        cli('fetch', '--file', fx('cfr.mp4'), '-o', dir);
        expect(cli('analyze', dir, '--add-cut-frame', '30').code).toBe(0);
        cli('fetch', '--file', fx('offset.mp4'), '-o', dir);
        const r = cli('analyze', dir);
        expect(r.code).toBe(0);
        expect(r.err).toMatch(/cut corrections were made on another video/);
        expect(bd(dir).cuts.frames.final).toEqual([60]);
    }, 90_000);
});
