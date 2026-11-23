import { describe, expect, test } from 'bun:test';
import { mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { main } from '../../skills/tiktok-ads/scripts/main.ts';

const ROOT = path.resolve(import.meta.dir, '../..');
const SKILL = path.join(ROOT, 'skills/tiktok-ads');
const FIX = path.resolve(import.meta.dir, '../fixtures/tiktok');
const fx = (n: string) => path.join(FIX, n);
const AN = fx('studio-capture-analytics.synthetic.json');
const MO = fx('studio-capture-monetization.synthetic.json');
const PR = fx('profile-read.synthetic.json');
const CSV = fx('ads-export.synthetic.csv');

function run(argv: string[]) {
    let out = '';
    let err = '';
    const code = main(argv, { out: (s) => (out += s), err: (s) => (err += s) });
    return { code, out, err, json: out.trim().startsWith('{') ? JSON.parse(out) : undefined };
}
const tmp = (name: string, content: string) => {
    const f = path.join(mkdtempSync(path.join(os.tmpdir(), 'tt-ads-')), name);
    writeFileSync(f, content);
    return f;
};

describe('tiktok-ads CLI', () => {
    test('analytics', () => {
        const r = run(['analytics', '--studio', AN]);
        expect(r.code).toBe(0);
        expect(r.json).toMatchObject({ ok: true, command: 'analytics' });
        expect(r.json.metrics.views.current.total).toBeGreaterThan(0);
    });
    test('monetization', () => {
        const r = run(['monetization', '--studio', MO]);
        expect(r.code).toBe(0);
        expect(r.json.counts).toEqual({ active: 1, eligible: 3, ineligible: 3 });
    });
    test('eligibility accepts --studio more than once and comma separated', () => {
        for (const args of [['--studio', AN, '--studio', MO], ['--studio', `${AN},${MO}`]]) {
            const r = run(['eligibility', '--profile', PR, ...args]);
            expect(r.code).toBe(0);
            expect(r.json.program.reason).toBe('not offered to this account or region');
            expect(r.json.criteria.map((c: any) => c.id)).toEqual(['followers', 'views_30d', 'age', 'region']);
        }
        expect(run(['eligibility', '--profile', PR, '--age', '21', '--region', 'us']).json.criteria.filter((c: any) => c.status === 'met').length).toBe(3);
    });
    test('decide', () => {
        const r = run(['decide', '--csv', CSV, '--target-cpa', '25']);
        expect(r.code).toBe(0);
        expect(r.json.summary.kill).toBe(3);
        expect(run(['decide', '--csv', CSV, '--target-cpa', 'abc']).code).toBe(2);
    });
    test('a rate-limited capture is refused with its reason', () => {
        const f = tmp('c.json', JSON.stringify({ ...JSON.parse(readFileSync(AN, 'utf8')), rateLimited: true }));
        const r = run(['analytics', '--studio', f]);
        expect(r.code).toBe(1);
        expect(r.json).toMatchObject({ ok: false, error: 'rate_limited' });
    });
    test('usage errors: unknown command, missing flag, unreadable file', () => {
        expect(run(['nope']).code).toBe(2);
        expect(run(['analytics']).code).toBe(2);
        const r = run(['analytics', '--studio', '/no/such/file.json']);
        expect(r.code).toBe(1);
        expect(r.json.error).toBe('bad_input');
    });
    test('help lists every command', () => {
        const r = run(['--help']);
        expect(r.code).toBe(0);
        for (const c of ['eligibility', 'analytics', 'monetization', 'decide', 'report']) expect(r.out).toContain(c);
    });
});

describe('report', () => {
    const full = () => run(['report', '--profile', PR, '--studio', AN, '--studio', MO, '--csv', CSV, '--target-cpa', '25']);
    test('FACTS / HYPOTHESES / MISSING / ACTIONS in JSON and markdown', () => {
        const r = full();
        expect(r.code).toBe(0);
        const j = r.json;
        expect(j).toMatchObject({ ok: true, command: 'report', read_only: true });
        for (const k of ['facts', 'hypotheses', 'missing', 'actions']) expect(j[k].length).toBeGreaterThan(0);
        expect(j.facts.every((f: any) => typeof f.source === 'string' && f.source)).toBe(true);
        expect(j.hypotheses.every((h: any) => ['high', 'medium', 'low'].includes(h.confidence))).toBe(true);
        const md: string = j.markdown;
        const at = ['FACTS', 'HYPOTHESES', 'MISSING', 'ACTIONS'].map((h) => md.indexOf('## ' + h));
        expect(at.every((i) => i >= 0)).toBe(true);
        expect([...at].sort((a, b) => a - b)).toEqual(at);
    });
    test('states what the numbers say: views change, rewards program, kill count', () => {
        const j = full().json;
        const facts = j.facts.map((f: any) => f.text).join('\n');
        expect(facts).toMatch(/views/i);
        expect(facts).toMatch(/not offered to this account or region/);
        expect(facts).toMatch(/3 .*kill|kill.* 3/i);
        const missing = j.missing.map((m: any) => m.item).join('\n');
        expect(missing).toMatch(/age/i);
        expect(missing).toMatch(/region/i);
    });
    test('missing target CPA and an unavailable page are listed under MISSING', () => {
        const j = run(['report', '--profile', PR, '--studio', AN, '--csv', CSV]).json;
        const missing = j.missing.map((m: any) => m.item).join('\n');
        expect(missing).toMatch(/target CPA/i);
        expect(missing).toMatch(/monetization/i);
    });
    test('a falling views trend plus an audit with a long gap yields a cadence hypothesis', () => {
        const cap = JSON.parse(readFileSync(AN, 'utf8'));
        cap.responses[0].body.vv_history = cap.responses[0].body.vv_history.map((p: any, i: number) => (i > 60 ? { status: 0, value: 500 } : p));
        const studio = tmp('a.json', JSON.stringify(cap));
        const audit = tmp('audit.json', JSON.stringify({ coverage: { n: 48, scope: 'sample', reason: 'limit', from: '2026-08-01', to: '2026-11-01' }, medians: { plays: 3200 }, cadence: { postsPerWeek: 1.5, longestGapDays: 21 } }));
        const j = run(['report', '--studio', studio, '--audit', audit]).json;
        expect(j.facts.map((f: any) => f.text).join('\n')).toMatch(/sample of 48 posts/);
        expect(j.hypotheses.map((h: any) => h.text).join('\n')).toMatch(/21 days/);
    });
    test('markdown only with --markdown', () => {
        const r = run(['report', '--profile', PR, '--studio', AN, '--markdown']);
        expect(r.out.startsWith('# ')).toBe(true);
        expect(r.out).toContain('## FACTS');
    });
    test('no input at all is refused', () => {
        expect(run(['report']).code).toBe(2);
    });
    test('no action asks the tool to create, boost or promote anything', () => {
        const j = full().json;
        for (const a of j.actions) expect(a.text).toMatch(/\b(in|from) (the app|TikTok Ads Manager|TikTok Studio|Ads Manager|Promote)|your|no change|re-run|capture/i);
        expect(j.read_only).toBe(true);
    });
});

describe('skill package', () => {
    const skill = readFileSync(path.join(SKILL, 'SKILL.md'), 'utf8');
    test('frontmatter name and read-only statement', () => {
        expect(skill).toMatch(/^---\nname: tiktok-ads\n/);
        expect(skill).toMatch(/read-only/i);
        expect(skill).toMatch(/never (creates|promotes|boosts)|does not create/i);
    });
    test('every command is documented with its input and output', () => {
        for (const c of ['eligibility --profile', 'analytics --studio', 'monetization --studio', 'decide --csv', 'report']) expect(skill).toContain(c);
    });
    test('LLM neutral: no client-specific tool names', () => {
        const all = [skill, ...readdirSync(path.join(SKILL, 'references')).map((f) => readFileSync(path.join(SKILL, 'references', f), 'utf8'))].join('\n');
        for (const bad of [/javascript_tool/, /claude-in-chrome/i, /AskUserQuestion/, /\bBash tool\b/, /\bRead tool\b/, /mcp__/, /Task tool/]) expect(all).not.toMatch(bad);
        expect(skill).toMatch(/browser tool that can run JavaScript in the page/);
    });
    test('policy figures are dated and marked verify', () => {
        for (const f of ['creator-rewards.md', 'monetization-programs.md', 'decision-system.md']) {
            const t = readFileSync(path.join(SKILL, 'references', f), 'utf8');
            expect(t).toMatch(/2026-11-22/);
            expect(t).toMatch(/verify/i);
        }
    });
    test('references named in SKILL.md exist', () => {
        const names = [...skill.matchAll(/references\/([\w.-]+)/g)].map((m) => m[1]);
        expect(names.length).toBeGreaterThan(3);
        const have = new Set(readdirSync(path.join(SKILL, 'references')));
        for (const n of names) expect(have.has(n)).toBe(true);
    });
    test('scripts make no network call', () => {
        for (const f of readdirSync(path.join(SKILL, 'scripts'))) {
            const t = readFileSync(path.join(SKILL, 'scripts', f), 'utf8');
            expect(t).not.toMatch(/\bfetch\(|XMLHttpRequest|node:https?|node:net|WebSocket|Bun\.spawn|child_process/);
        }
    });
    test('the thresholds file matches what the decision system documents', () => {
        const t = JSON.parse(readFileSync(path.join(SKILL, 'references/thresholds.json'), 'utf8'));
        const doc = readFileSync(path.join(SKILL, 'references/decision-system.md'), 'utf8');
        for (const v of [t.gate_multiple, t.kill_multiple, t.scale_multiple, t.frequency_critical]) expect(doc).toContain(String(v));
    });
});
