#!/usr/bin/env bun
import { readFile } from 'node:fs/promises';
import process from 'node:process';

import { getTikTokCookiesViaChrome } from './auth.ts';
import { deleteCookieFile, loadCookies, missingCookies, parseCookieInput, writeCookieMapToDisk } from './cookie-store.ts';
import { resolveCookiePath, resolveDataDir } from './paths.ts';
import { assertNoSignal, clearSignal, readSignal, writeSignal } from './signal.ts';
import { TtClient } from './client.ts';
import { PUBLISH_BOOLEANS, PUBLISH_HELP, publishCommand } from './publish/cli.ts';
import { commentsFromCapture, hashtagFromCapture, parseCapture, profileFromCapture, soundFromCapture, videoFromCapture, videosFromCapture } from './read.ts';

/** Identity request. CANDIDATE endpoint, confirmed live in plan Task 4. */
export const IDENTITY_URL = 'https://www.tiktok.com/passport/web/account/info/?aid=1459';

export function parseIdentity(json: unknown): { username: string; userId: string } | null {
    const d = (json as { data?: Record<string, unknown> })?.data;
    const username = d?.username;
    const userId = d?.user_id_str ?? d?.user_id;
    if (typeof username !== 'string' || !username || userId === undefined) return null;
    return { username, userId: String(userId) };
}

const HELP = `TikTok operator

Usage: npx -y bun skills/tiktok/scripts/main.ts <command> [options]

  login [--timeout <min>]     Open Chrome, sign in, capture the session cookies (default 5 min)
  import-cookies --file <p>   Import Cookie-Editor JSON, cookies.txt or a raw Cookie header
  logout                      Delete the stored session
  status                      Session state (cookie names only) and the account signal
  whoami                      The signed-in account (one paced read)
  resume                      Clear the account signal after resolving it in the browser

Reads (from a capture made in your own Chrome with scripts/browser/capture.js):
  profile  --capture <file>              Profile and stats
  videos   --capture <file> [--limit N]  Posts (default 20, max 200)
  video    --capture <file>              One post
  comments --capture <file> [--limit N]  Comments of a post
  hashtag  --capture <file> [--limit N]  Posts of a hashtag page (/tag/<name>)
  sound    --capture <file> [--limit N]  Posts of a sound page (/music/<slug>-<id>)
  Lists say "exhausted": true only when the whole list was read (every page, nothing cut).

${PUBLISH_HELP}

Output is JSON. Cookie values are never printed.`;

export interface ParsedArgs {
    command: string | undefined;
    positionals: string[];
    flags: Record<string, string | true>;
}

/** `--name value`, `--name=value`, and bare boolean flags (`--json`). */
export function parseArgs(argv: string[], booleans: readonly string[] = ['json', 'help']): ParsedArgs {
    const flags: Record<string, string | true> = {};
    const positionals: string[] = [];
    for (let i = 0; i < argv.length; i++) {
        const a = argv[i];
        if (a.startsWith('--')) {
            const eq = a.indexOf('=');
            if (eq > 0) {
                flags[a.slice(2, eq)] = a.slice(eq + 1);
                continue;
            }
            const name = a.slice(2);
            const next = argv[i + 1];
            if (booleans.includes(name) || next === undefined || next.startsWith('--')) flags[name] = true;
            else {
                flags[name] = next;
                i++;
            }
        } else positionals.push(a);
    }
    return { command: positionals.shift(), positionals, flags };
}

function out(value: unknown): void {
    process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

const log = (m: string) => process.stderr.write(`${m}\n`);

async function status(): Promise<void> {
    const map = await loadCookies(log);
    const missing = missingCookies(map);
    const signal = await readSignal();
    out({
        signedIn: Object.keys(map).length > 0 && missing.length === 0,
        cookies: Object.keys(map).sort(),
        missing,
        source: process.env.TIKTOK_COOKIES?.trim() ? 'TIKTOK_COOKIES' : resolveCookiePath(),
        dataDir: resolveDataDir(),
        signal: signal ? { kind: signal.kind, at: signal.at, detail: signal.detail } : null,
    });
}

export async function main(argv: string[]): Promise<number> {
    const { command, positionals, flags } = parseArgs(argv, ['json', 'help', ...PUBLISH_BOOLEANS]);
    switch (command) {
        case undefined:
        case 'help':
            process.stdout.write(`${HELP}\n`);
            return 0;
        case 'login': {
            const minutes = typeof flags.timeout === 'string' ? Number(flags.timeout) : 5;
            if (!Number.isFinite(minutes) || minutes <= 0 || minutes > 30) throw new Error('--timeout is minutes, 1 to 30');
            const map = await getTikTokCookiesViaChrome({ log, timeoutMs: minutes * 60_000 });
            await writeCookieMapToDisk(map, { log });
            out({ signedIn: true, cookies: Object.keys(map).sort(), missing: missingCookies(map) });
            return 0;
        }
        case 'import-cookies': {
            const file = flags.file;
            if (typeof file !== 'string') throw new Error('import-cookies needs --file <path>');
            const map = parseCookieInput(await readFile(file, 'utf8'));
            const missing = missingCookies(map);
            if (missing.length) throw new Error(`The file has no ${missing.join(', ')} cookie for tiktok.com; nothing was saved.`);
            await writeCookieMapToDisk(map, { log });
            out({ signedIn: true, cookies: Object.keys(map).sort() });
            return 0;
        }
        case 'logout':
            await deleteCookieFile();
            out({ signedIn: false });
            return 0;
        case 'status':
            await status();
            return 0;
        case 'whoami': {
            const json = await new TtClient({ log }).getJson<unknown>(IDENTITY_URL);
            const id = parseIdentity(json);
            if (!id) throw Object.assign(new Error('TikTok did not return the signed-in account. Run `login`.'), { code: 'auth' });
            out(id);
            return 0;
        }
        case 'resume': {
            const before = await readSignal();
            await clearSignal();
            out({ resumed: true, cleared: before ? { kind: before.kind, at: before.at } : null });
            return 0;
        }
        case 'profile':
        case 'videos':
        case 'video':
        case 'comments':
        case 'hashtag':
        case 'sound': {
            const file = flags.capture;
            if (typeof file !== 'string') throw new Error(`${command} needs --capture <file> (made with scripts/browser/capture.js)`);
            // One account signal stops every transport, browser captures included.
            await assertNoSignal();
            const text = await readFile(file, 'utf8');
            let cap;
            try {
                cap = parseCapture(text);
            } catch (error) {
                const kind = (error as { kind?: string }).kind;
                if (kind === 'challenge' || kind === 'rate_limited') await writeSignal(kind, `capture ${command}`);
                throw error;
            }
            const limit = typeof flags.limit === 'string' ? Number(flags.limit) : undefined;
            if (limit !== undefined && (!Number.isInteger(limit) || limit <= 0)) throw new Error('--limit is a positive whole number');
            const result =
                command === 'profile' ? profileFromCapture(cap)
                : command === 'videos' ? videosFromCapture(cap, { limit })
                : command === 'video' ? videoFromCapture(cap)
                : command === 'hashtag' ? hashtagFromCapture(cap, { limit })
                : command === 'sound' ? soundFromCapture(cap, { limit })
                : commentsFromCapture(cap, { limit });
            out(result);
            return 0;
        }
        case 'publish':
            return publishCommand(positionals[0], flags, out);
        default:
            process.stderr.write(`Unknown command: ${command}\n\n${HELP}\n`);
            return 2;
    }
}

if (import.meta.main) {
    main(process.argv.slice(2)).then(
        (code) => process.exit(code),
        (error: Error & { code?: string; kind?: string }) => {
            out({ ok: false, error: { kind: error.kind ?? error.code ?? error.name, message: error.message } });
            process.exit(1);
        },
    );
}
