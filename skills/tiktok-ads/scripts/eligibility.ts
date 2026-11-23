import { readFileSync } from 'node:fs';

import { programLists } from './monetization.ts';
import { historySeries, sum, unavailable } from './studio.ts';
import type { StudioCapture } from './studio.ts';

export interface Policy {
    as_of: string;
    note: string;
    followers_min: number;
    views_30d_min: number;
    age_min: number;
    regions: string[];
    regions_note: string;
}
export const policy = (): Policy => JSON.parse(readFileSync(new URL('../references/creator-rewards.json', import.meta.url), 'utf8'));

export type Status = 'met' | 'not_met' | 'unknown';
export interface Criterion {
    id: 'followers' | 'views_30d' | 'age' | 'region';
    label: string;
    required: number | string;
    actual: number | string | null;
    status: Status;
    source: string;
    note: string;
}

const NAME = /creator\s*rewards?|creativity\s*program/i;

/** Views of the last 30 daily points of vv_history (the current period ends yesterday), or why not. */
export function views30(cap: StudioCapture | undefined): { views: number } | { reason: string } {
    if (!cap) return { reason: 'no Studio capture given (capture /tiktokstudio/analytics and pass --studio)' };
    const s = historySeries(cap, 'vv_history');
    if (!s) return { reason: 'the Studio capture has no vv_history answer (capture /tiktokstudio/analytics)' };
    if (s.current.length < 30) return { reason: `vv_history covers ${s.current.length} days in the capture, under 30` };
    return { views: sum(s.current.slice(-30)) };
}

export interface EligibilityReport {
    ok?: true;
    command?: string;
    program: any;
    verdict: 'met' | 'not_met' | 'unknown' | 'unavailable';
    criteria: Criterion[];
    policy: { as_of: string; note: string; regions_note: string };
}

export function eligibility(profile: any, cap: StudioCapture | undefined, opts: { age?: number; region?: string }): EligibilityReport {
    const pol = policy();
    const p = profile && typeof profile === 'object' && profile.data && typeof profile.data === 'object' ? profile.data : profile;
    const criteria: Criterion[] = [];

    const followers = typeof p?.followers === 'number' ? p.followers : null;
    criteria.push({
        id: 'followers',
        label: 'Followers',
        required: pol.followers_min,
        actual: followers,
        status: followers === null ? 'unknown' : followers >= pol.followers_min ? 'met' : 'not_met',
        source: 'profile read (tiktok profile --capture)',
        note: followers === null ? 'the profile read has no follower count' : followers >= pol.followers_min ? '' : `short by ${pol.followers_min - followers}`,
    });

    const v = views30(cap);
    const caveat = 'all views counted, an upper bound: the program counts qualified views only';
    if ('views' in v) {
        criteria.push({
            id: 'views_30d',
            label: 'Views in the last 30 days',
            required: pol.views_30d_min,
            actual: v.views,
            status: v.views >= pol.views_30d_min ? 'met' : 'not_met',
            source: 'Studio analytics vv_history, last 30 daily points',
            note: v.views >= pol.views_30d_min ? caveat : `short by ${pol.views_30d_min - v.views} (${caveat})`,
        });
    } else {
        criteria.push({ id: 'views_30d', label: 'Views in the last 30 days', required: pol.views_30d_min, actual: null, status: 'unknown', source: 'Studio analytics vv_history', note: v.reason });
    }

    criteria.push(
        opts.age === undefined
            ? { id: 'age', label: 'Age', required: pol.age_min, actual: null, status: 'unknown', source: 'not shown by TikTok Studio', note: `needs ${pol.age_min}+; pass --age <years> if you know it` }
            : { id: 'age', label: 'Age', required: pol.age_min, actual: opts.age, status: opts.age >= pol.age_min ? 'met' : 'not_met', source: 'stated by the user', note: '' },
    );

    const region = opts.region?.trim().toUpperCase();
    const regionRequired = `one of ${pol.regions.join(', ')} (${pol.as_of}, verify)`;
    criteria.push(
        !region
            ? { id: 'region', label: 'Region', required: regionRequired, actual: null, status: 'unknown', source: 'not shown by TikTok Studio', note: 'pass --region <ISO code> if you know it' }
            : pol.regions.includes(region)
              ? { id: 'region', label: 'Region', required: regionRequired, actual: region, status: 'met', source: 'stated by the user', note: `in the ${pol.as_of} list` }
              : { id: 'region', label: 'Region', required: regionRequired, actual: region, status: 'unknown', source: 'stated by the user', note: `not in the ${pol.as_of} list, which changes often: check the Monetization page` },
    );

    // Is the program offered to this account at all? Only the all_programs answer can say.
    const lists = cap ? programLists(cap) : undefined;
    let program: any;
    let absent = false;
    if (!lists) program = unavailable('monetization page not captured (capture /tiktokstudio/monetization and pass it with --studio)');
    else {
        const hit = (['active', 'eligible', 'ineligible'] as const).flatMap((k) => lists[k].filter((x) => NAME.test(x.name)).map((x) => ({ x, k }))).shift();
        if (hit) program = { listed: true, list: hit.k, name: hit.x.name, requirements_met: hit.x.requirements_met, total_requirements: hit.x.total_requirements, restricted: hit.x.restricted };
        else {
            program = unavailable('not offered to this account or region');
            absent = true;
        }
    }

    const verdict = absent ? 'unavailable' : criteria.some((c) => c.status === 'not_met') ? 'not_met' : criteria.some((c) => c.status === 'unknown') ? 'unknown' : 'met';
    return { program, verdict, criteria, policy: { as_of: pol.as_of, note: pol.note, regions_note: pol.regions_note } };
}
