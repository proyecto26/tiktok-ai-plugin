// timebase: the shared frame time base. Pure conversions run always; media tests build lavfi fixtures
// and are skipped (with a message) when ffmpeg is not installed.
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { cfrCopy, countUneven, frameDiffsAround, frameToSec, minShotFrames, parseRate, probeRate, secToFrame, snapToChange } from '../../skills/tiktok-video-breakdown/scripts/timebase.ts';

const HAS_FFMPEG = spawnSync('ffmpeg', ['-version']).status === 0 && spawnSync('ffprobe', ['-version']).status === 0;
if (!HAS_FFMPEG) console.warn('[timebase] ffmpeg/ffprobe not found: media fixture tests are skipped.');

describe('conversions', () => {
    test('ntsc round trip', () => {
        for (const rate of ['30000/1001', '24000/1001', '30/1', '60/1'])
            for (let n = 0; n <= 27000; n++) expect(secToFrame(Number(frameToSec(n, rate).toFixed(3)), rate)).toBe(n);
    });
    test('min shot in frames', () => {
        expect(minShotFrames('30/1')).toBe(8);
        expect(minShotFrames('30000/1001')).toBe(8);
        expect(minShotFrames('60/1')).toBe(15);
    });
    test('bad rates throw', () => {
        for (const r of ['0/0', '', 'abc', '30/0']) expect(() => parseRate(r)).toThrow();
        expect(parseRate('30000/1001')).toEqual({ num: 30000, den: 1001 });
        expect(parseRate('25')).toEqual({ num: 25, den: 1 });
    });
    test('a time before the first frame is frame 0', () => {
        expect(secToFrame(0.2, '30/1', 0.5)).toBe(0);
    });
    test('uneven timestamps are counted', () => {
        expect(countUneven([0, 1 / 30, 2 / 30, 3 / 30], 30)).toBe(0);
        expect(countUneven([0, 1 / 30, 3 / 30, 4 / 30], 30)).toBe(2);
    });
    test('snap picks the strongest change within two frames, or keeps the centre', () => {
        // diffs[i] is the change between frame first+i and first+i+1
        expect(snapToChange([1, 1, 1, 40, 1], 57, 59)).toEqual({ frame: 61, moved: 2, mad: 40 });
        expect(snapToChange([1, 2, 1, 2, 1], 57, 59)).toEqual({ frame: 59, moved: 0, mad: null });
    });
});

describe.skipIf(!HAS_FFMPEG)('media', () => {
    const tmp = mkdtempSync(path.join(os.tmpdir(), 'tb-'));
    const fx = (n: string) => path.join(tmp, n);
    const ff = (args: string[]) => {
        const r = spawnSync('ffmpeg', ['-hide_banner', '-nostdin', '-y', '-loglevel', 'error', ...args], { encoding: 'utf8' });
        if (r.status !== 0) throw new Error(r.stderr);
    };
    const s = '160x284';
    beforeAll(() => {
        const rb = ['-f', 'lavfi', '-i', `color=c=red:s=${s}:d=2:r=30`, '-f', 'lavfi', '-i', `color=c=blue:s=${s}:d=2:r=30`, '-filter_complex', '[0][1]concat=n=2:v=1:a=0[v]', '-map', '[v]', '-c:v', 'libx264', '-pix_fmt', 'yuv420p'];
        ff([...rb, fx('cfr.mp4')]);
        ff([...rb, '-output_ts_offset', '0.5', fx('offset.mp4')]);
        ff(['-f', 'lavfi', '-i', `color=c=red:s=${s}:d=1:r=30`, '-f', 'lavfi', '-i', `color=c=blue:s=${s}:d=1:r=15`, '-filter_complex', '[0][1]concat=n=2:v=1:a=0[v]', '-map', '[v]', '-fps_mode', 'vfr', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', fx('vfr.mp4')]);
    }, 120_000);
    afterAll(() => rmSync(tmp, { recursive: true, force: true }));

    test('probeRate on a CFR 30 fps clip', async () => {
        expect(await probeRate(fx('cfr.mp4'))).toMatchObject({ rate: '30/1', fps: 30, frames: 120, variable: false });
    });
    test('start offset', async () => {
        const p = await probeRate(fx('offset.mp4'));
        expect(p.start_time).toBeCloseTo(0.5, 2);
        expect(secToFrame(p.start_time + 2, p.rate, p.start_time)).toBe(60);
    });
    test('probeRate flags a variable-rate clip and cfrCopy fixes it', async () => {
        expect((await probeRate(fx('vfr.mp4'))).variable).toBe(true);
        await cfrCopy(fx('vfr.mp4'), fx('out.mp4'), 30);
        expect(await probeRate(fx('out.mp4'))).toMatchObject({ rate: '30/1', variable: false });
    });
    test('frameDiffsAround is frame exact at a hard cut', async () => {
        const d = await frameDiffsAround(fx('cfr.mp4'), { rate: '30/1', start_time: 0 }, 57, 6);
        expect(d).toHaveLength(5);
        expect(d.indexOf(Math.max(...d))).toBe(2);
    });
    test('frameDiffsAround on an offset source', async () => {
        const p = await probeRate(fx('offset.mp4'));
        const d = await frameDiffsAround(fx('offset.mp4'), p, 57, 6);
        expect(d.indexOf(Math.max(...d))).toBe(2);
    });
});
