import { analytics } from './analytics.ts';
import { decide } from './decide.ts';
import type { DecideResult } from './decide.ts';
import { eligibility } from './eligibility.ts';
import { monetization } from './monetization.ts';
import type { StudioCapture } from './studio.ts';

export interface ReportInput {
    profile?: any;
    studio?: StudioCapture;
    csv?: string;
    /** Output of `tiktok-audit ... --json`. */
    audit?: any;
    targetCpa?: number;
    age?: number;
    region?: string;
}
export interface ReportItem { text: string; source: string }
export interface Report {
    ok?: true;
    command?: string;
    read_only: true;
    facts: ReportItem[];
    hypotheses: { text: string; confidence: 'high' | 'medium' | 'low'; basis: string }[];
    missing: { item: string; impact: string }[];
    actions: { step: number; text: string }[];
    markdown: string;
}

const fmt = (n: number) => new Intl.NumberFormat('en-US', { maximumFractionDigits: 2 }).format(n);
const fixed2 = (n: number) => new Intl.NumberFormat('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(n);
const pct = (n: number | null) => (n === null ? 'n/a' : `${n > 0 ? '+' : ''}${n}%`);
const isUn = (x: any) => !!x && x.unavailable === true;

export function buildReport(input: ReportInput): Report {
    const facts: ReportItem[] = [];
    const hyps: Report['hypotheses'] = [];
    const missing: Report['missing'] = [];
    const actions: string[] = [];
    const cap = input.studio;
    const a = cap ? analytics(cap) : undefined;
    const money = cap ? monetization(cap) : undefined;
    let viewsFall: number | null = null;

    // ---- audit (tiktok-audit output) ----
    const audit = input.audit;
    let gapDays: number | null = null;
    if (audit?.coverage) {
        const c = audit.coverage;
        const scope = c.scope === 'account' ? `all ${c.n} posts` : `sample of ${c.n} posts${c.reason ? ` (${c.reason})` : ''}`;
        facts.push({ text: `Public posts read: ${scope}; median ${fmt(audit.medians?.plays ?? 0)} plays; ${audit.cadence?.postsPerWeek ?? 'n/a'} posts a week, longest gap ${audit.cadence?.longestGapDays ?? 'n/a'} days.`, source: 'tiktok-audit output' });
        if (typeof audit.cadence?.longestGapDays === 'number') gapDays = audit.cadence.longestGapDays;
    }

    // ---- Studio analytics ----
    if (a) {
        const v = a.metrics.views;
        if (!isUn(v)) {
            if (!isUn(v.change)) {
                facts.push({ text: `Views: ${fmt(v.current.total)} over the last ${v.current.points} daily points vs ${fmt(v.previous.total)} over the ${v.previous.points} before (${pct(v.change.pct)}).`, source: 'Studio analytics, vv_history' });
                if (v.change.pct !== null && v.change.pct <= -20) viewsFall = v.change.pct;
            } else facts.push({ text: `Views: ${fmt(v.current.total)} over ${v.current.points} days; no previous period in the capture.`, source: 'Studio analytics, vv_history' });
        }
        const f = a.metrics.follower_growth;
        if (!isUn(f)) facts.push({ text: `Followers ${fmt(f.current.last)} at the end of the window, ${f.current.change >= 0 ? '+' : ''}${fmt(f.current.change)} over it.`, source: 'Studio analytics, follower_num_history' });
        for (const k of ['likes', 'comments', 'shares']) {
            const m = a.metrics[k];
            if (!isUn(m) && !isUn(m.change)) facts.push({ text: `${k[0].toUpperCase()}${k.slice(1)}: ${fmt(m.current.total)} (${pct(m.change.pct)} vs the previous period).`, source: `Studio analytics, ${m.source}` });
        }
        const t = a.traffic_sources;
        if (!isUn(t) && t.items.length) {
            const top = t.items[0];
            facts.push({ text: `Traffic sources${t.days ? ` (last ${t.days} days)` : ''}: ${t.items.map((x: any) => `${x.label} ${x.share === null ? 'n/a' : Math.round(x.share * 100) + '%'}`).join(', ')}.`, source: 'Studio analytics, vv_traffic_source' });
            if (top.share !== null && top.share > 0.6) hyps.push({ text: `Reach depends on one source (${top.label}, ${Math.round(top.share * 100)}%): a post that stops being pushed there loses most of its views.`, confidence: 'low', basis: 'vv_traffic_source share above 60%' });
        }
        const s = a.search_terms;
        if (!isUn(s) && s.items.length) facts.push({ text: `Search terms that led to the account: ${s.items.slice(0, 5).map((x: any) => `${x.term} (${x.value})`).join(', ')}.`, source: 'Studio analytics, user_search_terms' });
        const w = a.rewards;
        if (!isUn(w) && w.total.amount !== null) facts.push({ text: `Rewards in the window: ${w.total.symbol ?? ''}${fmt(w.total.amount)} ${w.total.currency ?? ''}${w.percent_change !== null ? ` (${pct(w.percent_change)})` : ''}.`.replace(/\s+\./, '.'), source: 'Studio analytics, rewards overview' });
        if (!isUn(a.incentive_views)) facts.push({ text: `Incentive views: ${fmt(a.incentive_views.value)}.`, source: 'Studio analytics, incentive_vv' });
        missing.push({ item: 'Per-post Studio analytics (watch time, retention, per-video followers)', impact: 'which posts brought the followers; only public counts are available here' });
        const unrequested = Object.entries(a.metrics).filter(([, x]) => isUn(x)).map(([k]) => k);
        if (unrequested.length) missing.push({ item: `Analytics not in the capture: ${unrequested.join(', ')}`, impact: 'open /tiktokstudio/analytics, let the charts load, and capture again' });
    }

    if (viewsFall !== null) {
        if (gapDays !== null && gapDays >= 14) hyps.push({ text: `Views fell ${Math.abs(viewsFall)}%, and the longest gap between posts is ${gapDays} days: a posting gap is the likeliest cause.`, confidence: 'medium', basis: 'Studio views trend and tiktok-audit cadence' });
        else if (gapDays !== null) hyps.push({ text: `Views fell ${Math.abs(viewsFall)}% although the longest gap between posts is only ${gapDays} days: look at format, length and hook of the recent posts (tiktok-audit hits and misses).`, confidence: 'low', basis: 'Studio views trend and tiktok-audit cadence' });
        else {
            hyps.push({ text: `Views fell ${Math.abs(viewsFall)}%; the cause cannot be narrowed without the posting cadence.`, confidence: 'low', basis: 'Studio views trend only' });
            missing.push({ item: 'tiktok-audit output (--audit)', impact: 'cadence and per-post multiples show whether a posting gap or a format change explains the fall' });
        }
        actions.push('Post on a steady schedule for the next two weeks, then capture TikTok Studio analytics again and re-run `report` to compare windows.');
    }

    // ---- monetization and Creator Rewards ----
    let elig: ReturnType<typeof eligibility> | undefined;
    if (input.profile || cap) {
        elig = eligibility(input.profile, cap, { age: input.age, region: input.region });
        for (const c of elig.criteria) facts.push({ text: `Creator Rewards, ${c.label.toLowerCase()}: ${c.status.replace('_', ' ')}${c.actual !== null ? ` (${typeof c.actual === 'number' ? fmt(c.actual) : c.actual}${typeof c.required === 'number' ? ` of ${fmt(c.required)} needed` : ''})` : ''}${c.note ? `, ${c.note}` : ''}.`, source: c.source });
        if (isUn(elig.program)) {
            facts.push({ text: `Creator Rewards program: ${elig.program.reason}.`, source: 'Studio monetization, all_programs' });
            if (elig.program.reason.startsWith('not offered')) actions.push('No change to make for Creator Rewards: TikTok does not list it for this account or region. Capture the monetization page again after the account or region changes.');
        } else if (elig.program.listed) facts.push({ text: `Creator Rewards program is listed as ${elig.program.list}; requirements met ${elig.program.requirements_met ?? 'n/a'} of ${elig.program.total_requirements ?? 'n/a'}.`, source: 'Studio monetization, all_programs' });
        const views = elig.criteria.find((c) => c.id === 'views_30d');
        const offered = !(isUn(elig.program) && String(elig.program.reason).startsWith('not offered'));
        const fol = elig.criteria.find((c) => c.id === 'followers');
        if (offered && views?.status === 'not_met' && fol?.status === 'met' && typeof views.actual === 'number' && typeof views.required === 'number') {
            hyps.push({ text: `Views, not followers, are the blocker for Creator Rewards: ${fmt(views.actual)} of ${fmt(views.required)} views in 30 days (${Math.round((views.actual / views.required) * 100)}%).`, confidence: 'medium', basis: 'followers met, 30-day views short' });
            actions.push('In TikTok Studio, read the Creator Rewards requirements on the Monetization page and plan posts that raise 30-day views; re-run `eligibility` after the next capture.');
        }
        if (elig.criteria.some((c) => c.id === 'age' && c.status === 'unknown')) missing.push({ item: 'Account owner age (18+ is required)', impact: 'age is not shown by TikTok Studio; state it with --age' });
        if (elig.criteria.some((c) => c.id === 'region' && c.status === 'unknown')) missing.push({ item: 'Account region', impact: 'region eligibility is not shown by TikTok Studio; state it with --region' });
    }
    if (money) {
        if (isUn(money.programs)) missing.push({ item: 'Monetization page capture (programs, Creator Rewards listing)', impact: 'which programs are active, eligible or ineligible and why; open /tiktokstudio/monetization and capture it' });
        else {
            const c = money.counts;
            facts.push({ text: `Monetization programs: ${c.active} active, ${c.eligible} eligible to apply, ${c.ineligible} not eligible${money.restricted.length ? `; access restricted for: ${money.restricted.join(', ')}` : ''}.`, source: 'Studio monetization, all_programs' });
            const near = (money.programs.ineligible as any[]).filter((p) => p.requirements_met !== null && p.total_requirements && p.requirements_met / p.total_requirements >= 0.5);
            for (const p of near) actions.push(`In TikTok Studio > Monetization, open "${p.name}": ${p.requirements_met} of ${p.total_requirements} requirements are met; read which one is missing.`);
        }
    }

    // ---- ads ----
    let ads: DecideResult | undefined;
    if (input.csv !== undefined) {
        ads = decide(input.csv, { targetCpa: input.targetCpa });
        const sum = ads.summary;
        const spend = ads.ads.reduce((x, y) => x + (y.spend ?? 0), 0);
        facts.push({ text: `Ads Manager export: ${ads.ads.length} ads, spend ${ads.currency ?? ''}${fixed2(spend)}; verdicts ${sum.scale} scale, ${sum.keep} keep, ${sum.kill} kill, ${sum.wait} wait, ${sum.unknown} unknown${ads.target_cpa ? ` against a target CPA of ${ads.target_cpa}` : ''}.`.replace(/ ,/g, ','), source: 'decide on the exported CSV' });
        const fat = ads.ads.filter((x) => x.verdict === 'kill' && x.reasons.some((r) => /frequency/.test(r)));
        const costly = ads.ads.filter((x) => x.verdict === 'kill' && !fat.includes(x));
        if (fat.length) hyps.push({ text: `${fat.map((x) => x.name).join(', ')} saturated their audience (frequency above ${ads.thresholds.frequency_critical}): the concept is spent, not the budget.`, confidence: 'medium', basis: 'frequency over the critical band' });
        if (costly.length) hyps.push({ text: `${costly.map((x) => x.name).join(', ')} cost too much per conversion for this offer or audience; the hook may still work, so check CTR before retiring the concept.`, confidence: 'low', basis: 'CPA above the kill multiple or no conversions' });
        for (const x of ads.ads) {
            if (x.verdict === 'kill') actions.push(`In TikTok Ads Manager, pause "${x.name}": ${x.reasons[0]}. Keep a replacement concept ready first.`);
            else if (x.verdict === 'scale') actions.push(`In TikTok Ads Manager, raise the budget of "${x.name}" by 20% and wait 3 to 5 days before the next step.`);
            else if (x.verdict === 'wait') actions.push(`Leave "${x.name}" untouched in TikTok Ads Manager: ${x.reasons[0]}.`);
        }
        if (ads.missing.includes('target_cpa')) missing.push({ item: 'Target CPA (--target-cpa)', impact: 'without it no ad can be scaled or killed on cost, only on frequency' });
        if (ads.columns.missing.length) missing.push({ item: `Export columns not found: ${ads.columns.missing.join(', ')}`, impact: 'verdicts that needed them are unknown or less certain; export them from Ads Manager' });
        const partialAds = ads.ads.filter((a) => a.flags.includes('partial_spend') || a.flags.includes('partial_conversions')).map((a) => a.name);
        if (partialAds.length) missing.push({ item: `Spend or conversions missing on some rows of: ${partialAds.join(', ')}`, impact: 'cost per conversion is not judged for those ads; re-export the rows with complete cells' });
        if (ads.skipped_rows) facts.push({ text: `${ads.skipped_rows} total or empty row(s) in the export were skipped.`, source: 'decide on the exported CSV' });
    }

    if (actions.length === 0) actions.push('No change to make from this data; capture TikTok Studio analytics again in 14 days and re-run `report` to compare.');
    else actions.push('Capture TikTok Studio analytics again in 14 days and re-run `report`; every change above is made by you in the app, this tool changes nothing.');

    const report: Report = {
        read_only: true,
        facts,
        hypotheses: hyps.length ? hyps : [{ text: 'No pattern is strong enough to name from this data alone.', confidence: 'low', basis: 'no rule fired' }],
        missing: missing.length ? missing : [{ item: 'Nothing the requested commands needed', impact: 'none' }],
        actions: actions.map((text, i) => ({ step: i + 1, text })),
        markdown: '',
    };
    report.markdown = renderMarkdown(report);
    return report;
}

export function renderMarkdown(r: Report): string {
    const lines = ['# TikTok ads and monetization report', '', 'Read-only: nothing here creates, boosts or changes anything.', ''];
    lines.push('## FACTS', '', ...r.facts.map((f) => `- ${f.text} _(${f.source})_`), '');
    lines.push('## HYPOTHESES', '', ...r.hypotheses.map((h) => `- ${h.text} (confidence: ${h.confidence}; ${h.basis})`), '');
    lines.push('## MISSING', '', ...r.missing.map((m) => `- ${m.item}: ${m.impact}`), '');
    lines.push('## ACTIONS', '', ...r.actions.map((x) => `${x.step}. ${x.text}`), '');
    return lines.join('\n');
}
