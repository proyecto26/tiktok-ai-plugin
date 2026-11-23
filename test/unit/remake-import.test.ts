// tiktok-video-remake init --from-breakdown: the remake starts from the breakdown's working file and frame cuts.
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { appendFileSync, copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { main } from '../../skills/tiktok-video-remake/scripts/main.ts';

const HAS_FFMPEG = spawnSync('ffmpeg', ['-version']).status === 0 && spawnSync('ffprobe', ['-version']).status === 0;
if (!HAS_FFMPEG) console.warn('[remake-import] ffmpeg/ffprobe not found: tests skipped.');

describe.skipIf(!HAS_FFMPEG)('init --from-breakdown', () => {
    const tmp = mkdtempSync(path.join(os.tmpdir(), 'ri-'));
    const ff = (args: string[]) => {
        const r = spawnSync('ffmpeg', ['-hide_banner', '-nostdin', '-y', '-loglevel', 'error', ...args], { encoding: 'utf8' });
        if (r.status !== 0) throw new Error(r.stderr);
    };
    const sha = (f: string) => createHash('sha256').update(readFileSync(f)).digest('hex');
    const photo = path.join(tmp, 'id.jpg');
    const gray = path.join(tmp, 'gray.mp4');
    let n = 0;
    /** A breakdown folder with a hand-written breakdown.json: the clip has no visible cut, the file says 45. */
    const breakdown = (o: { dir?: string; file?: string; timebase?: boolean; cfr?: boolean } = {}) => {
        const dir = o.dir ?? path.join(tmp, `bd${n++}`);
        const rel = o.file ?? 'source/video.mp4';
        mkdirSync(path.join(dir, 'source'), { recursive: true });
        copyFileSync(gray, path.join(dir, rel));
        const timebase = { rate: '30/1', fps: 30, frames: 120, start_time: 0, file: rel, sha256: sha(path.join(dir, rel)), cfr_copy: Boolean(o.cfr) };
        writeFileSync(path.join(dir, 'breakdown.json'), JSON.stringify({ schema: 'tt.breakdown.v1', analysis_id: 'a0000abcd-2', ...(o.timebase === false ? {} : { timebase }), cuts: { final: [1.5], frames: { final: [45], detected: [], added: [45], removed: [] } } }));
        return dir;
    };
    const runDir = () => path.join(tmp, `run${n++}`);
    const remake = (run: string) => JSON.parse(readFileSync(path.join(run, 'remake.json'), 'utf8'));
    const init = (run: string, bd: string) => main(['init', run, '--from-breakdown', bd, '--identity', photo, '--json']);

    beforeAll(() => {
        ff(['-f', 'lavfi', '-i', 'color=c=gray:s=160x284:d=4:r=30', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', gray]);
        ff(['-f', 'lavfi', '-i', 'color=c=white:s=64x64', '-frames:v', '1', photo]);
    }, 60_000);
    afterAll(() => rmSync(tmp, { recursive: true, force: true }));

    test('import adopts the breakdown frames and measures nothing', async () => {
        const bd = breakdown();
        const run = runDir();
        await init(run, bd);
        expect(remake(run).source).toMatchObject({ cuts: [45], frames: 120, cutsBy: 'imported', fps: 30, sha256: sha(gray), importedFrom: { analysisId: 'a0000abcd-2', sha256: sha(gray) } });
    }, 60_000);
    test('a VFR breakdown is imported from its CFR copy', async () => {
        const bd = breakdown({ file: 'source/work_cfr.mp4', cfr: true });
        writeFileSync(path.join(bd, 'source', 'video.mp4'), 'not the working file');
        const run = runDir();
        await init(run, bd);
        expect(remake(run).source.sha256).toBe(sha(path.join(bd, 'source/work_cfr.mp4')));
    }, 60_000);
    test('a changed or missing working file is refused', async () => {
        const bd = breakdown();
        appendFileSync(path.join(bd, 'source/video.mp4'), 'x');
        await expect(init(runDir(), bd)).rejects.toThrow(/Run init with --source/);
        rmSync(path.join(bd, 'source/video.mp4'));
        await expect(init(runDir(), bd)).rejects.toThrow(/Run init with --source/);
    }, 60_000);
    test('a breakdown without a time base is refused', async () => {
        await expect(init(runDir(), breakdown({ timebase: false }))).rejects.toThrow(/predates frame cuts/);
        await expect(init(runDir(), path.join(tmp, 'nothing-here'))).rejects.toThrow(/No breakdown.json/);
    }, 60_000);
    test('hand cuts win over imported ones and stay', async () => {
        const run = runDir();
        await init(run, breakdown());
        await main(['scenes', run, '--set', '30,90', '--json']);
        await main(['scenes', run, '--json']);
        expect(remake(run).source).toMatchObject({ cuts: [30, 90], cutsBy: 'hand' });
    }, 60_000);
    test('relative breakdown path', async () => {
        const bd = breakdown({ dir: path.join(tmp, 'my breakdown') });
        const run = runDir();
        const cwd = process.cwd();
        process.chdir(tmp);
        try {
            await main(['init', run, '--from-breakdown', path.relative(tmp, bd), '--identity', photo, '--json']);
        } finally {
            process.chdir(cwd);
        }
        expect(remake(run).source.cutsBy).toBe('imported');
    }, 60_000);
    test('breakdown → remake: the remake scenes are the breakdown shots, frame for frame', () => {
        const clip = path.join(tmp, 'rgb.mp4');
        ff(['-f', 'lavfi', '-i', 'color=c=red:s=160x284:d=2:r=30', '-f', 'lavfi', '-i', 'color=c=blue:s=160x284:d=2:r=30', '-f', 'lavfi', '-i', 'color=c=green:s=160x284:d=2:r=30',
            '-filter_complex', '[0][1][2]concat=n=3:v=1:a=0[v]', '-map', '[v]', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', clip]);
        const BD = path.resolve(import.meta.dir, '../../skills/tiktok-video-breakdown/scripts/main.ts');
        const RM = path.resolve(import.meta.dir, '../../skills/tiktok-video-remake/scripts/main.ts');
        const sh = (script: string, ...args: string[]) => {
            const r = spawnSync(process.execPath, [script, ...args], { encoding: 'utf8' });
            expect(r.status).toBe(0);
            const out = r.stdout.trim();
            try {
                return JSON.parse(out); // the breakdown prints one indented object
            } catch {
                return JSON.parse(out.split('\n').pop()!.trim()); // the remake prints one line per object
            }
        };
        const bd = path.join(tmp, 'e2e-bd');
        sh(BD, 'fetch', '--file', clip, '-o', bd);
        sh(BD, 'analyze', bd);
        const run = runDir();
        sh(RM, 'init', run, '--from-breakdown', bd, '--identity', photo, '--json');
        const scenes = sh(RM, 'scenes', run, '--json');
        expect(scenes.scenes).toEqual(['scene 1: frames 0-59 (0.000-2.000 s)', 'scene 2: frames 60-119 (2.000-4.000 s)', 'scene 3: frames 120-179 (4.000-6.000 s)']);
        expect(scenes.cutsBy).toBe('imported');
    }, 120_000);
    test('--source and --from-breakdown are exclusive', async () => {
        await expect(main(['init', runDir(), '--source', gray, '--from-breakdown', breakdown(), '--identity', photo])).rejects.toThrow(/--source or --from-breakdown/);
        await expect(main(['init', runDir(), '--identity', photo])).rejects.toThrow(/--source or --from-breakdown/);
    }, 60_000);
});
