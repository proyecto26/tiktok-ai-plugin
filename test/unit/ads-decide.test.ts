import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import path from 'node:path';

import { decide, parseCsv } from '../../skills/tiktok-ads/scripts/decide.ts';
import { parseNumber } from '../../skills/tiktok-ads/scripts/money.ts';

const FIX = path.resolve(import.meta.dir, '../fixtures/tiktok');
const csv = (n: string) => readFileSync(path.join(FIX, n), 'utf8');
const ad = (r: ReturnType<typeof decide>, name: string) => r.ads.find((a) => a.name === name)!;

describe('parseNumber', () => {
    test('currency strings in both locales', () => {
        expect(parseNumber('$1,234.50')).toBe(1234.5);
        expect(parseNumber('1.234,50 €')).toBe(1234.5);
        expect(parseNumber('€ 1.234,50')).toBe(1234.5);
        expect(parseNumber('USD 12.00')).toBe(12);
        expect(parseNumber('1 234,5')).toBe(1234.5);
        expect(parseNumber('1 234,50')).toBe(1234.5);
        expect(parseNumber('$0.75')).toBe(0.75);
        expect(parseNumber('1,234,567')).toBe(1234567);
        expect(parseNumber('1.234.567', ',')).toBe(1234567);
    });
    test('a lone separator follows the file locale', () => {
        expect(parseNumber('1,234')).toBe(1234);
        expect(parseNumber('1.234')).toBe(1.234);
        expect(parseNumber('1,234', ',')).toBe(1.234);
        expect(parseNumber('1.234', ',')).toBe(1234);
        expect(parseNumber('1,5')).toBe(1.5);
        expect(parseNumber('0,75', ',')).toBe(0.75);
    });
    test('percent, negatives and empty markers', () => {
        expect(parseNumber('1.25%')).toBe(1.25);
        expect(parseNumber('1,50 %', ',')).toBe(1.5);
        expect(parseNumber('-$3.00')).toBe(-3);
        expect(parseNumber('($3.00)')).toBe(-3);
        for (const e of ['', '-', '--', 'N/A', 'n/a', '—', 'null', undefined]) expect(parseNumber(e as string)).toBeNull();
        expect(parseNumber('abc')).toBeNull();
    });
});

describe('parseCsv', () => {
    test('quotes, escaped quotes, embedded commas and newlines, BOM and CRLF', () => {
        const t = '﻿a,b\r\n"x, y","he said ""hi"""\r\n"line1\nline2",3\r\n';
        expect(parseCsv(t).rows).toEqual([['a', 'b'], ['x, y', 'he said "hi"'], ['line1\nline2', '3']]);
    });
    test('detects the delimiter from the header', () => {
        expect(parseCsv('a;b;c\n1;2;3\n').delimiter).toBe(';');
        expect(parseCsv('a\tb\n1\t2\n').delimiter).toBe('\t');
        expect(parseCsv('a,b\n1,2\n').delimiter).toBe(',');
    });
});

describe('decide', () => {
    test('kill / keep / scale / wait per ad against a target CPA', () => {
        const r = decide(csv('ads-export.synthetic.csv'), { targetCpa: 25 });
        expect(ad(r, 'synthetic_ad_scale').verdict).toBe('scale');
        expect(ad(r, 'synthetic_ad_keep').verdict).toBe('keep');
        expect(ad(r, 'synthetic_ad_kill_cpa').verdict).toBe('kill');
        expect(ad(r, 'synthetic_ad_kill_zero').verdict).toBe('kill');
        expect(ad(r, 'synthetic_ad_wait').verdict).toBe('wait');
        const f = ad(r, 'synthetic_ad_fatigue');
        expect(f.verdict).toBe('kill');
        expect(f.reasons.join(' ')).toMatch(/frequency/i);
        expect(r.skipped_rows).toBe(1); // the Total row
        expect(r.summary).toEqual({ scale: 1, keep: 1, kill: 3, wait: 1, unknown: 0 });
        expect(r.currency).toBe('$');
    });
    test('currency strings parse into numbers', () => {
        const r = decide(csv('ads-export.synthetic.csv'), { targetCpa: 25 });
        expect(ad(r, 'synthetic_ad_scale')).toMatchObject({ spend: 1234.5, impressions: 300000, clicks: 4500, ctr: 1.5, conversions: 70, frequency: 1.8 });
    });
    test('a European export (semicolons, 1.234,50 €, 1,50 %) gives the same numbers', () => {
        const r = decide(csv('ads-export-eu.synthetic.csv'), { targetCpa: 25 });
        expect(ad(r, 'synthetic_ad_eu_a')).toMatchObject({ spend: 1234.5, impressions: 300000, clicks: 4500, ctr: 1.5, cpm: 4.12, conversions: 70, cpa: 17.64, frequency: 1.8, verdict: 'scale' });
        expect(ad(r, 'synthetic_ad_eu_b').verdict).toBe('keep');
        expect(r.currency).toBe('€');
    });
    test('derives CTR, CPM and CPA when the columns are absent, and says so', () => {
        const t = 'Ad name,Cost,Impressions,Clicks,Conversions\nsynthetic_x,$300.00,100000,500,12\n';
        const a = ad(decide(t, { targetCpa: 30 }), 'synthetic_x');
        expect(a).toMatchObject({ ctr: 0.5, cpm: 3, cpa: 25 });
        expect(a.derived.sort()).toEqual(['cpa', 'cpm', 'ctr']);
        expect(a.missing).toEqual(expect.arrayContaining(['frequency']));
    });
    test('missing spend: every verdict is unknown and the column is reported', () => {
        const r = decide('Ad name,Impressions\nsynthetic_x,1000\n', { targetCpa: 25 });
        expect(ad(r, 'synthetic_x').verdict).toBe('unknown');
        expect(ad(r, 'synthetic_x').missing).toContain('spend');
        expect(r.columns.missing).toContain('spend');
    });
    test('missing conversions with a target: unknown, not a guess', () => {
        const r = decide('Ad name,Cost,Impressions\nsynthetic_x,$900.00,100000\n', { targetCpa: 25 });
        expect(ad(r, 'synthetic_x').verdict).toBe('unknown');
        expect(ad(r, 'synthetic_x').missing).toEqual(expect.arrayContaining(['conversions']));
    });
    test('no target CPA: never scale, and the target is reported missing', () => {
        const r = decide(csv('ads-export.synthetic.csv'), {});
        expect(r.ads.some((a) => a.verdict === 'scale')).toBe(false);
        expect(r.missing).toContain('target_cpa');
        expect(ad(r, 'synthetic_ad_scale').verdict).toBe('keep');
        expect(ad(r, 'synthetic_ad_fatigue').verdict).toBe('kill'); // critical frequency retires the ad even without a target
    });
    test('rows with the same ad name (daily breakdown) are added together', () => {
        const t = 'Ad name,Cost,Impressions,Clicks,Conversions\nsynthetic_x,$100.00,50000,250,5\nsynthetic_x,$200.00,50000,250,15\n';
        const a = ad(decide(t, { targetCpa: 25 }), 'synthetic_x');
        expect(a).toMatchObject({ spend: 300, impressions: 100000, clicks: 500, conversions: 20, rows: 2 });
        expect(a.cpa).toBe(15);
    });
    test('data gate: spend under 3x the target CPA waits', () => {
        const t = 'Ad name,Cost,Impressions,Conversions\nsynthetic_x,$74.00,10000,0\nsynthetic_y,$76.00,10000,0\n';
        const r = decide(t, { targetCpa: 25 });
        expect(ad(r, 'synthetic_x').verdict).toBe('wait');
        expect(ad(r, 'synthetic_y').verdict).toBe('kill');
    });
    test('thresholds used are echoed and dated', () => {
        const r = decide(csv('ads-export.synthetic.csv'), { targetCpa: 25 });
        expect(r.thresholds.as_of).toMatch(/^\d{4}-\d{2}-\d{2}$/);
        expect(r.thresholds.gate_multiple).toBe(3);
        expect(r.thresholds.kill_multiple).toBe(1.5);
        expect(r.thresholds.scale_multiple).toBe(0.8);
    });
    test('no recognisable ad column: bad_input', () => {
        expect(() => decide('foo,bar\n1,2\n', {})).toThrow(/ad/i);
        expect(() => decide('', {})).toThrow();
    });
});
