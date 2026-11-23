import { readFileSync } from 'node:fs';

import { currencyOf, detectDecimal, parseNumber } from './money.ts';
import type { Decimal } from './money.ts';
import { AdsError } from './studio.ts';

export interface Thresholds {
    as_of: string;
    note: string;
    gate_multiple: number;
    kill_multiple: number;
    scale_multiple: number;
    scale_min_conversions: number;
    frequency_warning: number;
    frequency_critical: number;
    ctr_floor_pct: number;
    cpm_high_multiple: number;
    no_target_min_impressions: number;
}
export const thresholds = (): Thresholds => JSON.parse(readFileSync(new URL('../references/thresholds.json', import.meta.url), 'utf8'));

// ---- CSV ---------------------------------------------------------------------------------------------------

/** RFC 4180 reader: quoted fields, doubled quotes, embedded delimiters and newlines, BOM, CRLF. */
export function parseCsv(input: string): { delimiter: string; rows: string[][] } {
    const text = input.replace(/^﻿/, '');
    const firstLine = text.split(/\r?\n/, 1)[0] ?? '';
    const count = (d: string) => {
        let q = false;
        let n = 0;
        for (const ch of firstLine) {
            if (ch === '"') q = !q;
            else if (ch === d && !q) n++;
        }
        return n;
    };
    const delimiter = [',', ';', '\t'].map((d) => ({ d, n: count(d) })).sort((a, b) => b.n - a.n)[0];
    const D = delimiter.n > 0 ? delimiter.d : ',';
    const rows: string[][] = [];
    let row: string[] = [];
    let field = '';
    let quoted = false;
    for (let i = 0; i < text.length; i++) {
        const ch = text[i];
        if (quoted) {
            if (ch === '"') {
                if (text[i + 1] === '"') {
                    field += '"';
                    i++;
                } else quoted = false;
            } else field += ch;
        } else if (ch === '"' && field === '') quoted = true;
        else if (ch === D) {
            row.push(field);
            field = '';
        } else if (ch === '\n' || ch === '\r') {
            if (ch === '\r' && text[i + 1] === '\n') i++;
            row.push(field);
            field = '';
            if (row.some((c) => c !== '')) rows.push(row);
            row = [];
        } else field += ch;
    }
    row.push(field);
    if (row.some((c) => c !== '')) rows.push(row);
    return { delimiter: D, rows };
}

// ---- columns -----------------------------------------------------------------------------------------------

type Metric = 'spend' | 'impressions' | 'clicks' | 'ctr' | 'cpm' | 'conversions' | 'cpa' | 'frequency';
const METRICS: Metric[] = ['spend', 'impressions', 'clicks', 'ctr', 'cpm', 'conversions', 'cpa', 'frequency'];

/** Header names (lowercase, no accents or punctuation), best match first. English and Spanish; others are reported missing. */
const ALIASES: Record<'name' | Metric, string[]> = {
    name: ['ad name', 'ad', 'nombre del anuncio', 'creative name', 'name'],
    spend: ['cost', 'spend', 'total cost', 'amount spent', 'coste', 'gasto', 'importe gastado'],
    impressions: ['impressions', 'impresiones'],
    clicks: ['clicks destination', 'clicks', 'link clicks', 'clics destino', 'clics', 'clicks all'],
    ctr: ['ctr destination', 'ctr', 'click through rate', 'ctr all'],
    cpm: ['cpm', 'cpm cost per 1000 impressions', 'cpm cost per mille'],
    conversions: ['conversions', 'results', 'total conversions', 'conversiones', 'resultados'],
    cpa: ['cpa', 'cost per conversion', 'cost per result', 'cpa cost per conversion', 'coste por conversion', 'coste por resultado'],
    frequency: ['frequency', 'frecuencia'],
};
const norm = (h: string) =>
    h
        .normalize('NFD')
        .replace(/[̀-ͯ]/g, '')
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, ' ')
        .trim();

// ---- decision ----------------------------------------------------------------------------------------------

export type Verdict = 'scale' | 'keep' | 'kill' | 'wait' | 'unknown';
export interface AdResult {
    name: string;
    rows: number;
    spend: number | null;
    impressions: number | null;
    clicks: number | null;
    ctr: number | null;
    cpm: number | null;
    conversions: number | null;
    cpa: number | null;
    frequency: number | null;
    verdict: Verdict;
    reasons: string[];
    flags: string[];
    /** Metrics the judgement needed or could show that the export did not carry (after derivation). */
    missing: string[];
    /** Metrics worked out from other columns rather than read. */
    derived: string[];
}
export interface DecideResult {
    ok?: true;
    command?: string;
    delimiter: string;
    decimal: Decimal;
    currency: string | null;
    target_cpa: number | null;
    thresholds: Thresholds;
    columns: { found: Record<string, string>; missing: string[] };
    ads: AdResult[];
    summary: Record<Verdict, number>;
    skipped_rows: number;
    missing: string[];
}

const r2 = (n: number) => Math.round(n * 100) / 100;
const TOTAL = /^(total|totals|grand total|summary|all ads|total of|subtotal)\b/i;

export function decide(csvText: string, opts: { targetCpa?: number }): DecideResult {
    const th = thresholds();
    const { delimiter, rows } = parseCsv(csvText);
    if (rows.length < 1) throw new AdsError('bad_input', 'the CSV is empty');
    const header = rows[0].map(norm);
    const col: Partial<Record<'name' | Metric, number>> = {};
    const found: Record<string, string> = {};
    for (const key of Object.keys(ALIASES) as ('name' | Metric)[]) {
        for (const alias of ALIASES[key]) {
            const i = header.indexOf(alias);
            if (i >= 0) {
                col[key] = i;
                found[key] = rows[0][i].trim();
                break;
            }
        }
    }
    if (col.name === undefined) throw new AdsError('bad_input', `no ad name column found (looked for: ${ALIASES.name.join(', ')}). Columns seen: ${rows[0].join(' | ')}`);
    const body = rows.slice(1);

    const numericCols = METRICS.map((m) => col[m]).filter((i): i is number => i !== undefined);
    const decimal = detectDecimal(body.flatMap((r) => numericCols.map((i) => r[i] ?? '')), delimiter);
    const currency = col.spend !== undefined ? body.map((r) => currencyOf(r[col.spend as number] ?? '')).find(Boolean) ?? null : null;

    // One entry per ad: rows with the same name (a daily breakdown) are added together.
    interface Acc { name: string; rows: number; given: Partial<Record<Metric, number | null>>; sums: Record<'spend' | 'impressions' | 'clicks' | 'conversions', number | null>; freqW: number; freqN: number; miss: Record<'spend' | 'conversions', number> }
    const order: string[] = [];
    const byName = new Map<string, Acc>();
    let skipped = 0;
    for (const r of body) {
        const name = (r[col.name] ?? '').trim();
        if (!name || TOTAL.test(name)) {
            skipped++;
            continue;
        }
        let a = byName.get(name);
        if (!a) {
            a = { name, rows: 0, given: {}, sums: { spend: null, impressions: null, clicks: null, conversions: null }, freqW: 0, freqN: 0, miss: { spend: 0, conversions: 0 } };
            byName.set(name, a);
            order.push(name);
        }
        a.rows++;
        const val = (m: Metric) => (col[m] === undefined ? null : parseNumber(r[col[m] as number], decimal));
        for (const m of ['spend', 'impressions', 'clicks', 'conversions'] as const) {
            const v = val(m);
            if (v !== null) a.sums[m] = (a.sums[m] ?? 0) + v;
            else if ((m === 'spend' || m === 'conversions') && col[m] !== undefined) a.miss[m]++;
        }
        for (const m of ['ctr', 'cpm', 'cpa', 'frequency'] as const) a.given[m] = val(m);
        const f = val('frequency');
        const w = val('impressions') ?? 1;
        if (f !== null) {
            a.freqW += f * w;
            a.freqN += w;
        }
    }

    const target = opts.targetCpa !== undefined && opts.targetCpa > 0 ? opts.targetCpa : null;
    const ads: AdResult[] = order.map((n) => {
        const a = byName.get(n) as Acc;
        const derived: string[] = [];
        const { spend, impressions, clicks, conversions } = a.sums;
        // Some rows of an ad lack spend or conversions while the column exists: the sums cover different rows, so no ratio of them is honest.
        const partial = (m: 'spend' | 'conversions') => a.miss[m] > 0 && a.miss[m] < a.rows;
        const partialSpend = partial('spend');
        const partialConv = partial('conversions');
        const pick = (m: 'ctr' | 'cpm' | 'cpa', calc: number | null): number | null => {
            const given = a.rows === 1 ? a.given[m] ?? null : null;
            if (given !== null) return r2(given);
            if (calc === null || !Number.isFinite(calc)) return null;
            derived.push(m);
            return r2(calc);
        };
        const ctr = pick('ctr', clicks !== null && impressions ? (clicks / impressions) * 100 : null);
        const cpm = pick('cpm', !partialSpend && spend !== null && impressions ? (spend / impressions) * 1000 : null);
        const cpa = pick('cpa', !partialSpend && !partialConv && spend !== null && conversions ? spend / conversions : null);
        const frequency = a.rows === 1 ? a.given.frequency ?? null : a.freqN ? r2(a.freqW / a.freqN) : null;
        const ad: AdResult = { name: n, rows: a.rows, spend: spend === null ? null : r2(spend), impressions, clicks, ctr, cpm, conversions, cpa, frequency, verdict: 'unknown', reasons: [], flags: [], missing: [], derived };
        for (const m of METRICS) if ((ad as any)[m] === null) ad.missing.push(m);
        if (partialSpend) {
            ad.flags.push('partial_spend');
            if (!ad.missing.includes('spend')) ad.missing.push('spend');
            ad.reasons.push(`spend is missing on ${a.miss.spend} of ${a.rows} rows: cost per conversion cannot be judged`);
        }
        if (partialConv) {
            ad.flags.push('partial_conversions');
            if (!ad.missing.includes('conversions')) ad.missing.push('conversions');
            ad.reasons.push(`conversions is missing on ${a.miss.conversions} of ${a.rows} rows: cost per conversion cannot be judged`);
        }
        return ad;
    });

    // Batch context: a CPM far above the batch median is flagged, never a verdict by itself.
    const cpms = ads.map((a) => a.cpm).filter((x): x is number => x !== null).sort((x, y) => x - y);
    const medianCpm = cpms.length >= 3 ? cpms[Math.floor(cpms.length / 2)] : null;

    for (const ad of ads) {
        const why = (s: string) => ad.reasons.push(s);
        const partialRows = ad.flags.includes('partial_spend') || ad.flags.includes('partial_conversions');
        if (ad.frequency !== null && ad.frequency > th.frequency_warning && ad.frequency <= th.frequency_critical) ad.flags.push('fatigue_warning');
        if (ad.ctr !== null && ad.ctr < th.ctr_floor_pct) ad.flags.push('ctr_below_floor');
        if (medianCpm !== null && ad.cpm !== null && ad.cpm > th.cpm_high_multiple * medianCpm) ad.flags.push('cpm_high');
        if (partialRows) continue; // verdict stays unknown; the reasons were written with the flags
        if (ad.spend === null) {
            ad.verdict = 'unknown';
            why('no spend column: nothing to judge cost against');
            continue;
        }
        const gate = target === null ? null : th.gate_multiple * target;
        if (gate !== null && ad.spend < gate) {
            ad.verdict = 'wait';
            why(`spend ${ad.spend} is under ${th.gate_multiple}x the target CPA (${r2(gate)}): too early to judge`);
            continue;
        }
        if (gate === null && ad.impressions !== null && ad.impressions < th.no_target_min_impressions) {
            ad.verdict = 'wait';
            why(`${ad.impressions} impressions is under ${th.no_target_min_impressions}: too early to judge`);
            continue;
        }
        if (target !== null && ad.conversions === null && ad.cpa === null) {
            ad.verdict = 'unknown';
            why('no conversions or CPA column: cost against the target cannot be judged');
            continue;
        }
        if (ad.frequency !== null && ad.frequency > th.frequency_critical) {
            ad.verdict = 'kill';
            why(`frequency ${ad.frequency} is above ${th.frequency_critical}: the audience is saturated, retire the concept and brief a new one`);
            continue;
        }
        if (target === null) {
            ad.verdict = 'keep';
            why('no target CPA given: cost cannot be judged, so this ad can be kept but not scaled or killed on cost');
            if (ad.flags.includes('ctr_below_floor')) why(`CTR ${ad.ctr}% is under ${th.ctr_floor_pct}%: the hook is weak, test a new first 2 seconds`);
            continue;
        }
        if (ad.conversions === 0 || (ad.conversions === null && ad.cpa === null)) {
            ad.verdict = 'kill';
            why(`no conversions after spending ${ad.spend} (at least ${th.gate_multiple}x the target CPA): the concept is not converting`);
            continue;
        }
        const cpa = ad.cpa as number;
        const ratio = cpa / target;
        if (ratio > th.kill_multiple) {
            ad.verdict = 'kill';
            why(`CPA ${cpa} is ${r2(ratio)}x the target ${target} (kill above ${th.kill_multiple}x)`);
        } else if (ratio <= th.scale_multiple) {
            const blockers: string[] = [];
            if (ad.conversions === null) blockers.push('conversions are not in the export');
            else if (ad.conversions < th.scale_min_conversions) blockers.push(`only ${ad.conversions} conversions (scale needs ${th.scale_min_conversions})`);
            if (ad.frequency !== null && ad.frequency > th.frequency_warning) blockers.push(`frequency ${ad.frequency} is above ${th.frequency_warning}`);
            if (blockers.length) {
                ad.verdict = 'keep';
                why(`CPA ${cpa} is ${r2(ratio)}x the target, but not scaling: ${blockers.join('; ')}`);
            } else {
                ad.verdict = 'scale';
                why(`CPA ${cpa} is ${r2(ratio)}x the target (scale at ${th.scale_multiple}x or lower) with ${ad.conversions} conversions`);
            }
        } else {
            ad.verdict = 'keep';
            why(ratio <= 1 ? `CPA ${cpa} is within the target ${target}` : `CPA ${cpa} is ${r2(ratio)}x the target: normal variance up to ${th.kill_multiple}x, watch it for another week`);
        }
    }

    const summary: Record<Verdict, number> = { scale: 0, keep: 0, kill: 0, wait: 0, unknown: 0 };
    for (const a of ads) summary[a.verdict]++;
    return {
        delimiter,
        decimal,
        currency,
        target_cpa: target,
        thresholds: th,
        columns: { found, missing: METRICS.filter((m) => col[m] === undefined) },
        ads,
        summary,
        skipped_rows: skipped,
        missing: target === null ? ['target_cpa'] : [],
    };
}
