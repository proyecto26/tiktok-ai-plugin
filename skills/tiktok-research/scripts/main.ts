#!/usr/bin/env bun
/** tiktok-research CLI: outliers|scan --input <file>… Reads the tiktok operator's list JSON only. Prints JSON. */
import { readFileSync } from 'node:fs';
import process from 'node:process';

import { outliers, scan } from './research.ts';

const HELP = `TikTok research (offline; reads the tiktok skill's list output)

Usage: npx -y bun scripts/main.ts outliers --input <a.json> [<b.json> …]
       npx -y bun scripts/main.ts scan     --input <a.json> [--input <b.json> …]

  each file: output of tiktok hashtag|sound|videos --capture <file> --json`;

/** Every path after each --input, up to the next flag. */
function inputs(argv: string[]): string[] {
    const out: string[] = [];
    for (let i = 0; i < argv.length; i++) {
        if (argv[i] !== '--input') continue;
        for (let j = i + 1; j < argv.length && !argv[j].startsWith('--'); j++) out.push(argv[j]);
    }
    return out;
}

export function main(argv: string[]): number {
    const cmd = argv[0];
    if (cmd !== 'outliers' && cmd !== 'scan') {
        process.stdout.write(HELP + '\n');
        return cmd === undefined || cmd === '--help' || cmd === '-h' ? 0 : 2;
    }
    const files = inputs(argv);
    if (!files.length) {
        process.stderr.write(`${cmd} needs --input <file>\n`);
        return 2;
    }
    try {
        const lists = files.map((f) => JSON.parse(readFileSync(f, 'utf8')));
        process.stdout.write(JSON.stringify(cmd === 'outliers' ? outliers(lists) : scan(lists), null, 2) + '\n');
        return 0;
    } catch (e) {
        process.stdout.write(JSON.stringify({ ok: false, error: 'bad_input', message: (e as Error).message }) + '\n');
        return 1;
    }
}

if (import.meta.main) process.exitCode = main(process.argv.slice(2));
