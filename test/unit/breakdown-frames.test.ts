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
    }, 120_000);
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
