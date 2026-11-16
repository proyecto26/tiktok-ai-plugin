import { randomBytes } from 'node:crypto';
import { open, readdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { TtError } from '../client.ts';
import { resolvePendingDir } from '../paths.ts';
import { ensurePrivateDir } from '../secure.ts';

/**
 * Publish attempts, durable and exclusive per data dir (one account per data dir).
 * An attempt is written before Post is clicked; only `published` or `rejected` close it.
 * An open or unreadable attempt blocks every new attempt until it is reconciled.
 */

export type Outcome = 'submitted' | 'processing' | 'published' | 'rejected' | 'unknown';

export interface Attempt {
    id: string;
    account: string;
    digest: string;
    state: Outcome;
    startedAt: string;
    updatedAt: string;
    detail?: string;
    postId?: string;
}

export type OpenAttempt = Attempt | { id: string; unreadable: true };

const CLOSED: Outcome[] = ['published', 'rejected'];
const OUTCOMES: Outcome[] = ['submitted', 'processing', 'published', 'rejected', 'unknown'];
const STALE_LOCK_MS = 30_000;
const LOCK_WAIT_MS = 10_000;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const attemptsDir = () => path.join(resolvePendingDir(), 'attempts');
const attemptFile = (id: string) => path.join(attemptsDir(), `${id}.json`);

async function withLock<T>(fn: () => Promise<T>): Promise<T> {
    const dir = resolvePendingDir();
    await ensurePrivateDir(dir);
    await ensurePrivateDir(attemptsDir());
    const lock = path.join(dir, 'publish.lock');
    const start = Date.now();
    for (;;) {
        try {
            const h = await open(lock, 'wx');
            await h.close();
            break;
        } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
            try {
                if (Date.now() - (await stat(lock)).mtimeMs > STALE_LOCK_MS) await rm(lock, { force: true });
            } catch {
                // lock vanished between calls
            }
            if (Date.now() - start > LOCK_WAIT_MS) throw new TtError('publish_busy', 'Another publish step holds the publish lock. Wait for it, then try again.');
            await sleep(20);
        }
    }
    try {
        return await fn();
    } finally {
        await rm(lock, { force: true });
    }
}

async function writeAttempt(a: Attempt): Promise<void> {
    const file = attemptFile(a.id);
    const tmp = `${file}.${process.pid}.tmp`;
    await writeFile(tmp, JSON.stringify(a, null, 2));
    await rename(tmp, file);
}

function parseAttempt(id: string, text: string): OpenAttempt {
    try {
        const a = JSON.parse(text) as Attempt;
        if (a.id !== id || !OUTCOMES.includes(a.state) || typeof a.digest !== 'string') throw new Error('bad record');
        return a;
    } catch {
        return { id, unreadable: true };
    }
}

async function readAll(): Promise<OpenAttempt[]> {
    let names: string[];
    try {
        names = await readdir(attemptsDir());
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
        throw error;
    }
    const out: OpenAttempt[] = [];
    for (const n of names.filter((n) => n.endsWith('.json')).sort()) {
        const id = n.slice(0, -'.json'.length);
        let text = '';
        try {
            text = await readFile(path.join(attemptsDir(), n), 'utf8');
        } catch {
            // unreadable: reported as such
        }
        out.push(parseAttempt(id, text));
    }
    return out;
}

const isOpen = (a: OpenAttempt) => 'unreadable' in a || !CLOSED.includes(a.state);

/** Open attempts: submitted, processing, unknown, and any record that cannot be read. */
export async function openAttempts(): Promise<OpenAttempt[]> {
    return (await readAll()).filter(isOpen);
}

/** Every readable attempt, newest first (for `publish status`). */
export async function allAttempts(): Promise<OpenAttempt[]> {
    return (await readAll()).reverse();
}

export async function beginAttempt(a: { account: string; digest: string }): Promise<Attempt> {
    return withLock(async () => {
        const open = (await readAll()).filter(isOpen);
        if (open.length) {
            const ids = open.map((o) => ('unreadable' in o ? `${o.id} (unreadable)` : `${o.id} (${o.state})`)).join(', ');
            throw new TtError('publish_busy', `An earlier publish is not settled: ${ids}. Reconcile it (publish reconcile / finish) before a new one.`);
        }
        const now = new Date().toISOString();
        const id = `${now.replace(/[-:.TZ]/g, '').slice(0, 14)}-${randomBytes(3).toString('hex')}`;
        const attempt: Attempt = { id, account: a.account, digest: a.digest, state: 'submitted', startedAt: now, updatedAt: now };
        await writeAttempt(attempt);
        return attempt;
    });
}

export async function getAttempt(id: string): Promise<Attempt> {
    if (!/^[\w-]+$/.test(id)) throw new Error(`Bad attempt id: ${id}`);
    let text: string;
    try {
        text = await readFile(attemptFile(id), 'utf8');
    } catch {
        throw new Error(`No publish attempt ${id}.`);
    }
    const a = parseAttempt(id, text);
    if ('unreadable' in a) throw new Error(`Publish attempt ${id} is unreadable; inspect ${attemptFile(id)} by hand.`);
    return a;
}

export async function markOutcome(id: string, state: Outcome, extra: { detail?: string; postId?: string } = {}): Promise<Attempt> {
    if (!OUTCOMES.includes(state)) throw new Error(`Unknown outcome ${state}`);
    return withLock(async () => {
        const a = await getAttempt(id);
        const next: Attempt = { ...a, state, updatedAt: new Date().toISOString(), ...(extra.detail !== undefined ? { detail: extra.detail } : {}), ...(extra.postId ? { postId: extra.postId } : {}) };
        await writeAttempt(next);
        return next;
    });
}
