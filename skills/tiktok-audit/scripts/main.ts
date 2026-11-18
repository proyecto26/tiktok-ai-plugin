#!/usr/bin/env bun
/** tiktok-audit CLI: audit --videos <file> [--profile <file>] [--json]. Reads the tiktok operator's JSON output only. */
import { readFileSync } from 'node:fs';
import process from 'node:process';

import { AuditError, auditPosts, renderAudit } from './audit.ts';

const HELP = `TikTok audit (offline; reads the tiktok skill's output)

Usage: npx -y bun scripts/main.ts audit --videos <videos.json> [--profile <profile.json>] [--json]

  videos.json   output of: tiktok videos --capture <file> --limit 200 --json
  profile.json  output of: tiktok profile --capture <file> --json`;

function flag(argv: string[], name: string): string | undefined {
    const i = argv.indexOf(`--${name}`);
    return i >= 0 ? argv[i + 1] : undefined;
}

function readJson(file: string, what: string): any {
    try {
        return JSON.parse(readFileSync(file, 'utf8'));
    } catch (e) {
        throw new AuditError('bad_input', `could not read ${what} ${file}: ${(e as Error).message}`);
    }
}

export function main(argv: string[]): number {
    const json = argv.includes('--json');
    if (argv[0] !== 'audit' || argv.includes('--help') || argv.includes('-h')) {
        process.stdout.write(HELP + '\n');
        return argv[0] === 'audit' || argv[0] === undefined || argv.includes('--help') || argv.includes('-h') ? 0 : 2;
    }
    const videos = flag(argv, 'videos');
    if (!videos) {
        process.stderr.write('audit needs --videos <file>\n');
        return 2;
    }
    try {
        const p = flag(argv, 'profile');
        const report = auditPosts(readJson(videos, 'videos'), p ? readJson(p, 'profile') : undefined);
        process.stdout.write(json ? JSON.stringify(report, null, 2) + '\n' : renderAudit(report));
        return 0;
    } catch (e) {
        const kind = e instanceof AuditError ? e.kind : 'error';
        const msg = (e as Error).message;
        if (json) process.stdout.write(JSON.stringify({ ok: false, error: kind, message: msg }) + '\n');
        else process.stderr.write(`${kind}: ${msg}\n`);
        return 1;
    }
}

if (import.meta.main) process.exitCode = main(process.argv.slice(2));
