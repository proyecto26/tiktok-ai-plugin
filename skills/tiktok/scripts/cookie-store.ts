import { rename, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { ensurePrivateDir, ensurePrivateFile, type Restrict } from './secure.ts';

import { resolveCookiePath } from './paths.ts';
export type LogFn = (message: string) => void;

interface CookieFileV1 {
    version: 1;
    updatedAt: string;
    cookieMap: Record<string, string>;
}

/**
 * Cookies the web client needs for an authenticated session.
 * CANDIDATE list: confirmed or revised by the guarded probes of plan Task 4 Step 6.
 */
export const REQUIRED_COOKIES: readonly string[] = ['sessionid'];

/** Cookies worth keeping when present (session, CSRF and device identity). Candidate names. */
export const USEFUL_COOKIES = ['sessionid', 'sessionid_ss', 'sid_tt', 'sid_guard', 'uid_tt', 'uid_tt_ss', 'tt_csrf_token', 'tt_chain_token', 'ttwid', 'msToken', 'odin_tt', 'passport_csrf_token', 'passport_csrf_token_default', 'sid_ucp_v1', 'ssid_ucp_v1', 'cmpl_token', 'multi_sids', 'store-idc', 'store-country-code', 'tt-target-idc'];

export function missingCookies(map: Record<string, string>): string[] {
    return REQUIRED_COOKIES.filter((n) => !map[n]);
}

export function hasRequiredCookies(map: Record<string, string>): boolean {
    return missingCookies(map).length === 0;
}

function isTikTokDomain(domain: string | undefined): boolean {
    if (!domain) return true; // raw header / unknown domain: trust the caller
    const d = domain.replace(/^\./, '').toLowerCase();
    return d === 'tiktok.com' || d.endsWith('.tiktok.com');
}

type RawCookie = { name?: string; value?: string; domain?: string; path?: string };

/** Keeps TikTok cookies; when a name repeats, the `.tiktok.com` root copy wins. */
export function buildCookieMap(cookies: RawCookie[]): Record<string, string> {
    const map: Record<string, string> = {};
    const rank: Record<string, number> = {};
    for (const c of cookies) {
        if (!c?.name || typeof c.value !== 'string' || !c.value) continue;
        if (!isTikTokDomain(c.domain)) continue;
        const d = (c.domain ?? '').replace(/^\./, '');
        const r = d === 'tiktok.com' ? 2 : d === 'www.tiktok.com' ? 1 : 0;
        if (!(c.name in map) || r > rank[c.name]) {
            map[c.name] = c.value;
            rank[c.name] = r;
        }
    }
    return map;
}

/**
 * Parses any of the cookie formats people actually have:
 *  - this tool's own file ({version:1, cookieMap})
 *  - browser-extension JSON exports (Cookie-Editor, EditThisCookie): array of {name, value, domain}
 *  - a plain {name: value} object
 *  - Netscape cookies.txt (tab-separated, as written by curl / yt-dlp / "Get cookies.txt")
 *  - a raw `Cookie:` request header ("sessionid=...; ttwid=...")
 */
export function parseCookieInput(text: string): Record<string, string> {
    const trimmed = text.trim().replace(/^﻿/, '');
    if (!trimmed) return {};

    if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
        const parsed = JSON.parse(trimmed) as unknown;
        if (Array.isArray(parsed)) return buildCookieMap(parsed as RawCookie[]);
        const obj = parsed as Record<string, unknown>;
        if (obj && obj.version === 1 && obj.cookieMap && typeof obj.cookieMap === 'object') {
            return normalize(obj.cookieMap as Record<string, unknown>);
        }
        if (Array.isArray(obj?.cookies)) return buildCookieMap(obj.cookies as RawCookie[]);
        return normalize(obj);
    }

    const lines = trimmed.split(/\r?\n/);
    const netscape = lines.filter((l) => l.split('\t').length >= 7);
    if (netscape.length > 0) {
        const cookies: RawCookie[] = [];
        for (const line of lines) {
            let l = line;
            // "#HttpOnly_" prefixes are real cookies, other "#" lines are comments.
            if (l.startsWith('#HttpOnly_')) l = l.slice('#HttpOnly_'.length);
            else if (l.startsWith('#') || !l.trim()) continue;
            const parts = l.split('\t');
            if (parts.length < 7) continue;
            cookies.push({ domain: parts[0], path: parts[2], name: parts[5], value: parts[6] });
        }
        return buildCookieMap(cookies);
    }

    const header = trimmed.replace(/^cookie:\s*/i, '');
    const map: Record<string, string> = {};
    for (const part of header.split(/;\s*/)) {
        const eq = part.indexOf('=');
        if (eq <= 0) continue;
        const name = part.slice(0, eq).trim();
        const value = part.slice(eq + 1).trim().replace(/^"|"$/g, '');
        if (name && value) map[name] = value;
    }
    return map;
}

function normalize(obj: Record<string, unknown>): Record<string, string> {
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries(obj)) if (typeof v === 'string' && v.trim()) out[k] = v.trim();
    return out;
}

export async function readCookieMapFromDisk(options?: { cookiePath?: string; log?: LogFn }): Promise<Record<string, string>> {
    const cookiePath = options?.cookiePath ?? resolveCookiePath();
    try {
        const raw = await readFile(cookiePath, 'utf8');
        return parseCookieInput(raw);
    } catch (error) {
        if ((error as NodeJS.ErrnoException)?.code === 'ENOENT') return {};
        options?.log?.(`[tiktok] Could not read cookies at ${cookiePath}: ${(error as Error).message}`);
        return {};
    }
}

export async function writeCookieMapToDisk(map: Record<string, string>, options?: { cookiePath?: string; log?: LogFn; restrict?: Restrict }): Promise<string> {
    const cookiePath = options?.cookiePath ?? resolveCookiePath();
    // Lock the folder first so the file is never readable by others, even briefly.
    await ensurePrivateDir(path.dirname(cookiePath), { restrict: options?.restrict });
    const payload: CookieFileV1 = { version: 1, updatedAt: new Date().toISOString(), cookieMap: map };
    // Write to a fresh temp file, lock it, then rename over the old file. An existing cookie file may
    // carry its own explicit grants, so new values must never be written into it in place.
    const tmp = `${cookiePath}.${process.pid}.${Date.now()}.tmp`;
    try {
        await writeFile(tmp, '', { mode: 0o600, flag: 'wx' });
        await ensurePrivateFile(tmp, { restrict: options?.restrict });
        await writeFile(tmp, `${JSON.stringify(payload, null, 2)}\n`, { mode: 0o600 });
        await rename(tmp, cookiePath);
        await ensurePrivateFile(cookiePath, { restrict: options?.restrict });
    } catch (error) {
        await rm(tmp, { force: true });
        await rm(cookiePath, { force: true });
        throw error;
    }
    options?.log?.(`[tiktok] Saved session cookies to ${cookiePath} (access: current user only)`);
    return cookiePath;
}

export async function deleteCookieFile(cookiePath = resolveCookiePath()): Promise<void> {
    await rm(cookiePath, { force: true });
}

/** Loads cookies from TIKTOK_COOKIES (any supported format) or the cookie file. */
export async function loadCookies(log?: LogFn): Promise<Record<string, string>> {
    const fromEnv = process.env.TIKTOK_COOKIES?.trim();
    if (fromEnv) return parseCookieInput(fromEnv);
    return readCookieMapFromDisk({ log });
}

export function formatCookieHeader(map: Record<string, string>): string {
    return Object.entries(map)
        .filter(([, v]) => Boolean(v))
        .map(([k, v]) => `${k}=${v}`)
        .join('; ');
}

/** Merges Set-Cookie updates (msToken / tt_chain_token rotate) into the map in place. Returns true if anything changed. */
export function applySetCookie(map: Record<string, string>, setCookieHeaders: string[]): boolean {
    let changed = false;
    for (const h of setCookieHeaders) {
        const first = h.split(';')[0];
        const eq = first.indexOf('=');
        if (eq <= 0) continue;
        const name = first.slice(0, eq).trim();
        const value = first.slice(eq + 1).trim().replace(/^"|"$/g, '');
        if (!value || value === '""' || /max-age=0|expires=thu, 01[- ]jan[- ]1970/i.test(h)) continue;
        if (map[name] !== value) {
            map[name] = value;
            changed = true;
        }
    }
    return changed;
}

/** Redacts a cookie map for display: names plus value length only. */
export function redact(map: Record<string, string>): Record<string, string> {
    return Object.fromEntries(Object.entries(map).map(([k, v]) => [k, `<${v.length} chars>`]));
}
