/** ffmpeg / ffprobe helpers. Every call passes an argument array; nothing goes through a shell. */
import { spawn } from 'node:child_process';

export class ToolError extends Error {
    constructor(
        readonly code: string,
        message: string,
        readonly hint?: string,
    ) {
        super(message);
    }
}

export interface RunResult {
    code: number;
    stdout: Buffer;
    stderr: string;
}

export function run(cmd: string, args: string[], timeoutMs?: number): Promise<RunResult> {
    return new Promise((resolve, reject) => {
        const child = spawn(cmd, args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], timeout: timeoutMs });
        const out: Buffer[] = [];
        const err: Buffer[] = [];
        child.stdout.on('data', (c: Buffer) => out.push(c));
        child.stderr.on('data', (c: Buffer) => err.push(c));
        child.on('error', (e: NodeJS.ErrnoException) => {
            if (e.code === 'ENOENT') reject(new ToolError('tool_missing', `${cmd} was not found on PATH.`, installHint(cmd)));
            else reject(e);
        });
        child.on('close', (code) => resolve({ code: code ?? -1, stdout: Buffer.concat(out), stderr: Buffer.concat(err).toString('utf8') }));
    });
}

export async function must(cmd: string, args: string[]): Promise<RunResult> {
    const r = await run(cmd, args);
    if (r.code !== 0) {
        const tail = r.stderr.trim().split(/\r?\n/).slice(-6).join('\n');
        throw new ToolError('tool_failed', `${cmd} failed (exit ${r.code}):\n${tail}`);
    }
    return r;
}

export const ffmpeg = (args: string[]) => must('ffmpeg', ['-hide_banner', '-nostdin', '-y', '-v', 'error', ...args]);
export const ffprobeJson = async (file: string, extra: string[] = ['-show_streams', '-show_format']): Promise<any> => JSON.parse((await must('ffprobe', ['-v', 'error', ...extra, '-of', 'json', file])).stdout.toString('utf8'));

export function installHint(cmd: string): string {
    return `Install ffmpeg (it includes ffprobe): Windows \`winget install Gyan.FFmpeg\`, macOS \`brew install ffmpeg\`, Debian/Ubuntu \`sudo apt install ffmpeg\`, then open a new terminal. (${cmd} is required.)`;
}

export async function toolVersion(cmd: string): Promise<string | null> {
    try {
        const r = await run(cmd, ['-version']);
        return r.code === 0 ? (r.stdout.toString('utf8').split(/\r?\n/)[0] ?? null) : null;
    } catch {
        return null;
    }
}

export const clamp01 = (x: number) => Math.min(1, Math.max(0, x));
export const round3 = (x: number) => Math.round(x * 1000) / 1000;
