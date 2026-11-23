/**
 * Adds the owner's own music file to a rendered clip: fades in and out, loudness normalised to -14 LUFS (two-pass
 * loudnorm on the faded signal), picture copied untouched. The music NEVER loops: when it is shorter than the clip it
 * fades out where it ends and the rest of the clip is silent (reported as music_ended_early_by); the owner can pick a
 * longer track or a --start earlier in it. Longer music is cut at the end of the clip and fades out there.
 */
import { stat } from 'node:fs/promises';
import path from 'node:path';

import { ToolError, ffprobeJson, ffmpeg, round3, run } from './ff.ts';

export const TARGET_LUFS = -14;
const TRUE_PEAK = -1.5;
const LRA = 11;

export interface MusicOpts {
    video: string;
    music: string;
    out: string;
    start?: number;
    fade?: number;
}

export interface MusicReport {
    output: string;
    duration: number;
    music_used: number;
    music_start: number;
    music_ended_early_by: number;
    looped: false;
    fade: number;
    loudness: { target_lufs: number; input_lufs: number | null; output_lufs: number | null };
    warnings: string[];
}

async function lufsOf(file: string): Promise<number | null> {
    const r = await run('ffmpeg', ['-hide_banner', '-nostdin', '-i', file, '-vn', '-af', 'ebur128', '-f', 'null', '-']);
    const all = [...r.stderr.matchAll(/I:\s+(-?[\d.]+) LUFS/g)];
    return all.length ? Number(all[all.length - 1][1]) : null;
}

export async function addMusic(o: MusicOpts): Promise<MusicReport> {
    const exists = async (f: string) => !!(await stat(f).catch(() => null))?.isFile();
    if (!(await exists(o.video))) throw new ToolError('video_not_found', `No video at ${o.video}.`);
    if (!(await exists(o.music))) throw new ToolError('music_not_found', `No music file at ${o.music}.`, 'Pass --file with an audio file you have the rights to use.');
    const vp = await ffprobeJson(o.video);
    const vDur = Number(vp.format?.duration);
    const mp = await ffprobeJson(o.music);
    if (!(mp.streams ?? []).some((s: any) => s.codec_type === 'audio')) throw new ToolError('not_audio', `${o.music} has no audio stream.`);
    const mDur = Number(mp.format?.duration);
    if (!Number.isFinite(vDur) || !Number.isFinite(mDur)) throw new ToolError('no_duration', 'Could not read the duration of the video or the music.');
    const mStart = Math.max(0, o.start ?? 0);
    if (mStart >= mDur) throw new ToolError('bad_start', `--start ${mStart} is past the end of the music (${round3(mDur)} s).`);
    const used = Math.min(vDur, mDur - mStart);
    const early = Math.max(0, vDur - used);
    const fade = Math.max(0, Math.min(o.fade ?? 1, used / 2));
    const warnings: string[] = [];
    if (early > 0.05) warnings.push(`the music is shorter than the video by ${round3(early)} s: it fades out where it ends and the rest is silent (it is never looped). Pick a longer track or an earlier --start to cover the clip.`);

    const fades = fade > 0 ? `afade=t=in:st=0:d=${fade},afade=t=out:st=${round3(used - fade)}:d=${fade},` : '';
    const norm = `loudnorm=I=${TARGET_LUFS}:TP=${TRUE_PEAK}:LRA=${LRA}`;
    const inArgs = ['-ss', String(mStart), '-t', String(round3(used)), '-i', o.music, '-vn'];

    // Pass 1: measure the faded signal.
    const m = await run('ffmpeg', ['-hide_banner', '-nostdin', '-nostats', ...inArgs, '-af', `${fades}${norm}:print_format=json`, '-f', 'null', '-']);
    const json = m.stderr.match(/\{[^{}]*"input_i"[^{}]*\}/s)?.[0];
    if (m.code !== 0 || !json) throw new ToolError('loudnorm_failed', `Could not measure the music loudness:\n${m.stderr.trim().split(/\r?\n/).slice(-4).join('\n')}`);
    const meas = JSON.parse(json) as Record<string, string>;
    const num = (k: string) => Number(meas[k]);
    const finite = [num('input_i'), num('input_tp'), num('input_lra'), num('input_thresh'), num('target_offset')].every(Number.isFinite);
    const second = finite ? `${norm}:measured_I=${num('input_i')}:measured_TP=${num('input_tp')}:measured_LRA=${num('input_lra')}:measured_thresh=${num('input_thresh')}:offset=${num('target_offset')}:linear=true` : norm;
    if (!finite) warnings.push('the music is silent or too short to measure; loudness was not normalised exactly');

    // Pass 2: apply, keep the video's picture, pad with silence to the video length (no loop).
    await ffmpeg(['-i', o.video, ...inArgs.slice(0, -1), '-map', '0:v:0', '-map', '1:a:0', '-c:v', 'copy', '-filter:a', `${fades}${second},aresample=48000,apad`, '-c:a', 'aac', '-b:a', '192k', '-t', String(round3(vDur)), '-movflags', '+faststart', path.resolve(o.out)]);
    return {
        output: path.resolve(o.out),
        duration: round3(vDur),
        music_used: round3(used),
        music_start: mStart,
        music_ended_early_by: round3(early),
        looped: false,
        fade: round3(fade),
        loudness: { target_lufs: TARGET_LUFS, input_lufs: finite ? num('input_i') : null, output_lufs: await lufsOf(o.out) },
        warnings,
    };
}
