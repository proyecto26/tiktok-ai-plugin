/** library.json (schema tt.travel.v1) and trip grouping by date gaps and GPS distance. */
import { readFile, writeFile } from 'node:fs/promises';

import { ToolError } from './ff.ts';
import type { Gps, Item } from './media.ts';

export const SCHEMA = 'tt.travel.v1';
export const DEFAULT_GAP_HOURS = 36;
export const DEFAULT_MAX_KM = 150;

export interface Trip {
    id: string;
    undated: boolean;
    start: string | null;
    end: string | null;
    items: string[];
    videos: number;
    photos: number;
    centre: Gps | null;
}

export interface Library {
    schema: typeof SCHEMA;
    kind: 'library';
    created_at: string;
    roots: string[];
    items: Item[];
    trips: Trip[];
    skipped: { path: string; reason: string }[];
    skipped_total: number;
    scoring?: unknown;
}

export function haversineKm(a: Gps, b: Gps): number {
    const r = Math.PI / 180;
    const dLat = (b.lat - a.lat) * r;
    const dLon = (b.lon - a.lon) * r;
    const h = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * r) * Math.cos(b.lat * r) * Math.sin(dLon / 2) ** 2;
    return 2 * 6371 * Math.asin(Math.min(1, Math.sqrt(h)));
}

// EXIF dates have no zone and container dates are UTC; days-long gaps make the difference irrelevant, so both are compared as UTC.
const ms = (t: string) => Date.parse(/Z$|[+-]\d\d:\d\d$/.test(t) ? t : `${t}Z`);

type G = Pick<Item, 'id' | 'taken_at' | 'gps' | 'kind'>;

export function groupTrips(items: G[], opts: { gapHours?: number; maxKm?: number } = {}): Trip[] {
    const gap = (opts.gapHours ?? DEFAULT_GAP_HOURS) * 3600_000;
    const maxKm = opts.maxKm ?? DEFAULT_MAX_KM;
    const dated = items.filter((i) => i.taken_at && !Number.isNaN(ms(i.taken_at))).sort((a, b) => ms(a.taken_at!) - ms(b.taken_at!));
    const undated = items.filter((i) => !(i.taken_at && !Number.isNaN(ms(i.taken_at))));
    const groups: G[][] = [];
    let cur: G[] = [];
    let lastGps: Gps | null = null;
    for (const it of dated) {
        const prev = cur[cur.length - 1];
        const far = !!(lastGps && it.gps && haversineKm(lastGps, it.gps) > maxKm);
        if (prev && (ms(it.taken_at!) - ms(prev.taken_at!) > gap || far)) {
            groups.push(cur);
            cur = [];
            lastGps = null;
        }
        cur.push(it);
        if (it.gps) lastGps = it.gps;
    }
    if (cur.length) groups.push(cur);
    const mk = (g: G[], id: string, undatedFlag: boolean): Trip => {
        const gps = g.filter((i) => i.gps).map((i) => i.gps!);
        return {
            id,
            undated: undatedFlag,
            start: undatedFlag ? null : g[0].taken_at,
            end: undatedFlag ? null : g[g.length - 1].taken_at,
            items: g.map((i) => i.id),
            videos: g.filter((i) => i.kind === 'video').length,
            photos: g.filter((i) => i.kind === 'photo').length,
            centre: gps.length ? { lat: gps.reduce((s, x) => s + x.lat, 0) / gps.length, lon: gps.reduce((s, x) => s + x.lon, 0) / gps.length } : null,
        };
    };
    const trips = groups.map((g, i) => mk(g, `trip-${i + 1}`, false));
    if (undated.length) trips.push(mk(undated, 'undated', true));
    return trips;
}

export async function loadLibrary(file: string): Promise<Library> {
    let raw: string;
    try {
        raw = await readFile(file, 'utf8');
    } catch {
        throw new ToolError('library_not_found', `Cannot read ${file}.`, 'Run `scan <folders...> -o library.json` first.');
    }
    const lib = JSON.parse(raw) as Library;
    if (lib.schema !== SCHEMA || lib.kind !== 'library') throw new ToolError('bad_schema', `${file} is not a ${SCHEMA} library.`);
    return lib;
}

export const saveJson = (file: string, data: unknown) => writeFile(file, `${JSON.stringify(data, null, 2)}\n`);
