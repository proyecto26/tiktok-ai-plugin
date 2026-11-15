#!/usr/bin/env bun
import { readFile } from 'node:fs/promises';
import process from 'node:process';

import { getTikTokCookiesViaChrome } from './auth.ts';
import { deleteCookieFile, loadCookies, missingCookies, parseCookieInput, writeCookieMapToDisk } from './cookie-store.ts';
import { resolveCookiePath, resolveDataDir } from './paths.ts';
import { clearSignal, readSignal } from './signal.ts';

const HELP = `TikTok operator (phase 1)

Usage: npx -y bun skills/tiktok/scripts/main.ts <command> [options]

  login                       Open Chrome, sign in, capture the session cookies
  import-cookies --file <p>   Import Cookie-Editor JSON, cookies.txt or a raw Cookie header
  logout                      Delete the stored session
  status                      Session state (cookie names only) and the account signal
  resume                      Clear the account signal after resolving it in the browser

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
    const { command, flags } = parseArgs(argv);
    switch (command) {
        case undefined:
        case 'help':
            process.stdout.write(`${HELP}\n`);
            return 0;
        case 'login': {
            const map = await getTikTokCookiesViaChrome({ log });
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
        case 'resume': {
            const before = await readSignal();
            await clearSignal();
            out({ resumed: true, cleared: before ? { kind: before.kind, at: before.at } : null });
            return 0;
        }
        default:
            process.stderr.write(`Unknown command: ${command}\n\n${HELP}\n`);
            return 2;
    }
}

if (import.meta.main) {
    main(process.argv.slice(2)).then(
        (code) => process.exit(code),
        (error: Error & { code?: string }) => {
            out({ ok: false, error: { kind: error.code ?? error.name, message: error.message } });
            process.exit(1);
        },
    );
}
