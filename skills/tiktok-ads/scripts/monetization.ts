import { ALL_PROGRAMS, deepFind, SETTINGS, unavailable } from './studio.ts';
import type { StudioCapture } from './studio.ts';

export interface Program {
    name: string;
    description: string | null;
    m10n_project: number | null;
    requirements_met: number | null;
    total_requirements: number | null;
    /** true / false as the page says; null when the page did not say. */
    restricted: boolean | null;
    badges: string[];
    cta: string | null;
}

const n = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const s = (v: unknown): string | null => (typeof v === 'string' && v ? v : null);

export function toProgram(p: any): Program {
    return {
        name: s(p?.name) ?? '(unnamed program)',
        description: s(p?.description),
        m10n_project: n(p?.m10n_project),
        requirements_met: n(p?.requirements_met),
        total_requirements: n(p?.total_requirements),
        restricted: typeof p?.access_restriction_info?.is_access_restricted === 'boolean' ? p.access_restriction_info.is_access_restricted : null,
        badges: (Array.isArray(p?.m10n_badge) ? p.m10n_badge : []).map((b: any) => s(b?.badge_label)).filter((x: string | null): x is string => !!x),
        cta: s(p?.program_cta_text),
    };
}

export type Lists = { active: Program[]; eligible: Program[]; ineligible: Program[] };

/** The three program lists of the latest all_programs answer, or undefined when the page was not captured. */
export function programLists(cap: StudioCapture): Lists | undefined {
    const resp = cap.responses.filter((r) => ALL_PROGRAMS.test(r.path)).pop();
    if (!resp) return undefined;
    const list = (k: string): Program[] => {
        const v = deepFind(resp.body, k);
        return Array.isArray(v) ? v.map(toProgram) : [];
    };
    return { active: list('active_m10n_programs'), eligible: list('eligible_to_apply_m10n_programs'), ineligible: list('ineligible_to_apply_m10n_programs') };
}

export interface MonetizationReport {
    ok?: true;
    command?: string;
    capturedAt: string;
    programs: any;
    counts: any;
    restricted: any;
    currency: any;
}

export function monetization(cap: StudioCapture): MonetizationReport {
    const lists = programLists(cap);
    const settings = cap.responses.filter((r) => SETTINGS.test(r.path)).pop();
    let currency: any = unavailable('no settings answer in this capture (monetization page not captured)');
    if (settings) {
        const code = s(deepFind(settings.body, 'selected_currency')?.code);
        const all = deepFind(settings.body, 'all_currencies');
        const sym = Array.isArray(all) ? s(all.find((c: any) => c?.code === code)?.symbol) : null;
        currency = code ? { code, symbol: sym } : unavailable('the settings answer names no selected currency');
    }
    const none = unavailable('monetization page not captured (no all_programs answer; open /tiktokstudio/monetization and capture it)');
    return {
        capturedAt: cap.capturedAt,
        programs: lists ?? none,
        counts: lists ? { active: lists.active.length, eligible: lists.eligible.length, ineligible: lists.ineligible.length } : none,
        restricted: lists ? [...lists.active, ...lists.eligible, ...lists.ineligible].filter((p) => p.restricted === true).map((p) => p.name) : none,
        currency,
    };
}
