# Creator Rewards: criteria and how `eligibility` reads them

Dated 2026-11-22. **Verify before quoting any figure: TikTok changes this program often**, by region and by
account. The Monetization page of the account's own TikTok Studio is the only authority.

## Criteria used by `eligibility` (also in `creator-rewards.json`)

| Criterion | Bar (2026-11-22, verify) | Where the number comes from | Notes |
|---|---|---|---|
| Followers | 10,000 | `tiktok profile --capture` (`followers`) | exact, as of the capture |
| Views, last 30 days | 100,000 | Studio analytics `vv_history`, the last 30 daily points | all views: an **upper bound**. The program counts *qualified* views (original content, long enough, not ineligible for the For You feed), which Studio does not break out |
| Age | 18 or older | not shown by Studio | `unknown` unless the user states it (`--age`) |
| Region | an eligible region | not shown by Studio | `unknown` unless the user states it (`--region`); the list in `creator-rewards.json` is possibly incomplete, so a region outside it stays `unknown`, never `not_met` |

Other conditions TikTok has stated and this skill cannot check: an account in good standing (no recent violations),
original videos above a minimum length, and the account not being a business account in some markets. List them
under MISSING when a user is close to the bars.

## "Not offered to this account or region"

The monetization page lists programs in three groups (`active`, `eligible_to_apply`, `ineligible_to_apply`). On the
owner's account (recon 2026-11-22) Creator Rewards appeared in none of them, while its help text did exist. So when
no list names it (`Creator Rewards` or `Creativity Program`), `eligibility` reports `program: unavailable: not offered
to this account or region` and `verdict: unavailable`, and still prints the four criteria so the user sees how far
they are. When the monetization page was not captured it says so instead: that is a different reason.

## How to talk about it

- `met` for every criterion means the numbers pass; it is not an approval. TikTok decides, in the app.
- `not_met` on views: say how many views short and over what window, and that the real shortfall may be larger
  (qualified views are fewer than all views).
- Never project earnings. The rewards total in Studio (`analytics`, `rewards`) is the only money figure, with its
  currency, and it is the account's own history, not a forecast.
- Advice that moves the numbers belongs to `tiktok-audit` (what worked) and `tiktok-content` (what to post); this
  skill only reports where the account stands.
