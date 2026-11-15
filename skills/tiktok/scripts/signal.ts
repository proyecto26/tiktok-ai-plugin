import { readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { resolveSignalPath } from './paths.ts';
import { ensurePrivateDir, ensurePrivateFile } from './secure.ts';

/**
 * One account-wide stop signal shared by every transport (HTTP client and browser steps)
 * and every process. Written on a captcha, verification page, 429, "too many attempts"
 * or an unexpected login redirect; cleared only by `resume`.
 */
export interface Signal {
    kind: string;
    detail: string;
    at: string;
}

export class SignalError extends Error {
    readonly code = 'blocked_by_signal';
    constructor(readonly signal: Signal) {
        super(`TikTok is paused for this account (${signal.kind}: ${signal.detail}, since ${signal.at}). Resolve it in the browser, then run \`resume\`.`);
        this.name = 'SignalError';
    }
}

export async function writeSignal(kind: string, detail: string): Promise<void> {
    const file = resolveSignalPath();
    await ensurePrivateDir(path.dirname(file));
    const signal: Signal = { kind, detail, at: new Date().toISOString() };
    await writeFile(file, JSON.stringify(signal, null, 2));
    await ensurePrivateFile(file);
}

/** null when no signal exists; an unreadable file is reported as a signal, never ignored. */
export async function readSignal(): Promise<Signal | null> {
    let text: string;
    try {
        text = await readFile(resolveSignalPath(), 'utf8');
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
        return { kind: 'unreadable', detail: (error as Error).message, at: '?' };
    }
    try {
        const s = JSON.parse(text) as Partial<Signal>;
        if (typeof s.kind !== 'string') throw new Error('no kind');
        return { kind: s.kind, detail: String(s.detail ?? ''), at: String(s.at ?? '?') };
    } catch {
        return { kind: 'unreadable', detail: 'signal.json could not be parsed', at: '?' };
    }
}

export async function clearSignal(): Promise<void> {
    await rm(resolveSignalPath(), { force: true });
}

/** Throws SignalError (code 'blocked_by_signal') when the account is paused. */
export async function assertNoSignal(): Promise<void> {
    const s = await readSignal();
    if (s) throw new SignalError(s);
}
