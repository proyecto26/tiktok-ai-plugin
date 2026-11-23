#!/usr/bin/env bun
/**
 * tiktok-ads CLI. Offline and read-only: it reads files the tiktok operator and the Studio capture wrote
 * (and an Ads Manager CSV export) and prints JSON. It makes no request and changes nothing anywhere.
 */
import { readFileSync } from 'node:fs';
import process from 'node:process';

import { analytics } from './analytics.ts';
import { decide } from './decide.ts';
import { eligibility } from './eligibility.ts';
import { monetization } from './monetization.ts';
import { buildReport } from './report.ts';
import { AdsError, mergeStudio, parseStudio } from './studio.ts';
import type { StudioCapture } from './studio.ts';

const HELP = `TikTok ads and monetization strategist (offline, read-only, JSON output)

Usage: npx -y bun skills/tiktok-ads/scripts/main.ts <command> [options]

  eligibility --profile <profile.json> [--studio <capture>]... [--age <years>] [--region <ISO>]
        Creator Rewards criteria: met / not_met / unknown, with numbers and sources
  analytics --studio <capture>...
        Studio overview: current vs previous period, traffic sources, search terms, rewards
  monetization --studio <capture>...
        Programs grouped active / eligible / ineligible, requirements met, restrictions
  decide --csv <ads-manager-export.csv> [--target-cpa <n>]
        kill / keep / scale / wait per ad (CTR, CPM, CPA, frequency, spend against the target)
  report [--profile <f>] [--studio <f>]... [--csv <f>] [--audit <f>] [--target-cpa <n>] [--age <y>] [--region <c>] [--markdown]
        FACTS / HYPOTHESES / MISSING / ACTIONS from whatever is given

Inputs
  profile.json   output of: tiktok profile --capture <file>
  capture        output of: skills/tiktok/scripts/browser/studio-capture.js (tt.studio-capture.v1);
                 --studio may repeat or take a comma-separated list
  audit          output of: tiktok-audit audit --videos ... --json

Anything not visible is reported as "unavailable" with the reason. Exit codes: 0 ok, 1 failed (JSON error on stdout), 2 usage.`;

export interface Io {
    out(s: string): void;
    err(s: string): void;
}
const stdio: Io = { out: (s) => process.stdout.write(s), err: (s) => process.stderr.write(s) };

class Usage extends Error {}

const BOOLEANS = new Set(['markdown', 'help']);
function parseFlags(args: string[]): Map<string, string[]> {
    const flags = new Map<string, string[]>();
    for (let i = 0; i < args.length; i++) {
        const a = args[i];
        if (!a.startsWith('--')) throw new Usage(`unexpected argument ${a}`);
        const eq = a.indexOf('=');
        const name = eq > 0 ? a.slice(2, eq) : a.slice(2);
        let value: string;
        if (BOOLEANS.has(name)) value = 'true';
        else if (eq > 0) value = a.slice(eq + 1);
        else {
            value = args[++i];
            if (value === undefined || value.startsWith('--')) throw new Usage(`--${name} needs a value`);
        }
        flags.set(name, [...(flags.get(name) ?? []), value]);
    }
    return flags;
}

function readText(file: string, what: string): string {
    try {
        return readFileSync(file, 'utf8');
    } catch (e) {
        throw new AdsError('bad_input', `could not read ${what} ${file}: ${(e as Error).message}`);
    }
}
function readJson(file: string, what: string): any {
    try {
        return JSON.parse(readText(file, what));
    } catch (e) {
        if (e instanceof AdsError) throw e;
        throw new AdsError('bad_input', `${what} ${file} is not JSON: ${(e as Error).message}`);
    }
}
function studio(flags: Map<string, string[]>): StudioCapture | undefined {
    const files = (flags.get('studio') ?? []).flatMap((v) => v.split(',')).map((v) => v.trim()).filter(Boolean);
    if (!files.length) return undefined;
    return mergeStudio(files.map((f) => parseStudio(readText(f, 'studio capture'))));
}
function numberFlag(flags: Map<string, string[]>, name: string): number | undefined {
    const v = flags.get(name)?.[0];
    if (v === undefined) return undefined;
    const n = Number(v);
    if (!Number.isFinite(n) || n <= 0) throw new Usage(`--${name} is a positive number`);
    return n;
}
const one = (flags: Map<string, string[]>, name: string) => flags.get(name)?.[0];

export function main(argv: string[], io: Io = stdio): number {
    const cmd = argv[0];
    if (cmd === undefined || cmd === '--help' || cmd === '-h' || cmd === 'help') {
        io.out(HELP + '\n');
        return 0;
    }
    try {
        const flags = parseFlags(argv.slice(1));
        if (flags.has('help')) {
            io.out(HELP + '\n');
            return 0;
        }
        const emit = (command: string, data: object) => io.out(JSON.stringify({ ok: true, command, ...data }, null, 2) + '\n');
        switch (cmd) {
            case 'analytics':
            case 'monetization': {
                const cap = studio(flags);
                if (!cap) throw new Usage(`${cmd} needs --studio <capture>`);
                emit(cmd, cmd === 'analytics' ? analytics(cap) : monetization(cap));
                return 0;
            }
            case 'eligibility': {
                const p = one(flags, 'profile');
                if (!p) throw new Usage('eligibility needs --profile <profile.json> (output of tiktok profile --capture)');
                const age = numberFlag(flags, 'age');
                emit(cmd, eligibility(readJson(p, 'profile'), studio(flags), { age, region: one(flags, 'region') }));
                return 0;
            }
            case 'decide': {
                const f = one(flags, 'csv');
                if (!f) throw new Usage('decide needs --csv <ads-manager-export.csv>');
                emit(cmd, decide(readText(f, 'CSV'), { targetCpa: numberFlag(flags, 'target-cpa') }));
                return 0;
            }
            case 'report': {
                const profile = one(flags, 'profile');
                const csv = one(flags, 'csv');
                const audit = one(flags, 'audit');
                const cap = studio(flags);
                if (!profile && !csv && !audit && !cap) throw new Usage('report needs at least one of --profile, --studio, --csv, --audit');
                const r = buildReport({
                    profile: profile ? readJson(profile, 'profile') : undefined,
                    studio: cap,
                    csv: csv ? readText(csv, 'CSV') : undefined,
                    audit: audit ? readJson(audit, 'audit') : undefined,
                    targetCpa: numberFlag(flags, 'target-cpa'),
                    age: numberFlag(flags, 'age'),
                    region: one(flags, 'region'),
                });
                if (flags.has('markdown')) io.out(r.markdown);
                else emit(cmd, r);
                return 0;
            }
            default:
                throw new Usage(`unknown command ${cmd}`);
        }
    } catch (e) {
        if (e instanceof Usage) {
            io.err(`${e.message}\n\n${HELP}\n`);
            return 2;
        }
        if (e instanceof AdsError) {
            io.out(JSON.stringify({ ok: false, error: e.kind, message: e.message }) + '\n');
            return 1;
        }
        io.out(JSON.stringify({ ok: false, error: 'error', message: (e as Error).message }) + '\n');
        return 1;
    }
}

if (import.meta.main) process.exitCode = main(process.argv.slice(2));
