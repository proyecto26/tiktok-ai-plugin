# Monetization programs on TikTok

Dated 2026-11-22. **Verify every requirement on the account's own Monetization page: programs, names and bars
change often and differ by region.** `monetization --studio <capture>` prints what the page lists for the account
(active, eligible to apply, not eligible, with `requirements_met` of `total_requirements` and a restriction flag).
That output beats this file.

## Programs seen on the Studio monetization page (owner's account, 2026-11-22)

| Program | Group on that account | What it is (verify) |
|---|---|---|
| LIVE rewards | active | income from LIVE gifts and related LIVE programs |
| Work with Artists | eligible to apply | creators promote artists' music in videos for a fee |
| LIVE Incentive Program | eligible to apply | payments for LIVE hosting goals |
| Service+ | eligible to apply | creators sell services through the app |
| Video Gifts | not eligible | viewers send gifts on videos |
| Subscription | not eligible | paid subscriptions to a creator's content |
| Creator Marketplace | not eligible | brands find and hire creators; usually follower and engagement bars |
| Creator Rewards Program | not listed | pays for qualified views of longer original videos; see `creator-rewards.md` |

The group a program lands in is the account's, not a universal ranking. A program missing from every group is
`not offered to this account or region`.

## Reading `requirements_met` of `total_requirements`

The page shows how many of a program's requirements the account meets. 0 of 4 is far; 3 of 4 is one step. The
requirement texts are in the app, not in the captured fields: when an account is close, tell the user to open that
program on the Monetization page and read which requirement is open. Programs flagged `restricted: true` have an
access restriction (for example region or account type): do not suggest working toward them before the user checks it.

## TikTok Shop affiliate (outside Studio's monetization page)

- Creators earn a commission when viewers buy a product they tagged in a video, LIVE or photo post.
  Applications and product selection are in the TikTok Shop affiliate pages of the app, not in this plugin.
- Typical conditions (verify, they differ by market and change): age 18+, a TikTok account in good standing, a
  follower minimum that varies by market, and a market where Shop is open.
- Judge a product the way an ad is judged: a clear problem, a visible demonstration in the first two seconds, a
  price the viewer can decide on inside a short video. Organic posts that already beat the account's median are
  the best candidates; read them with `tiktok-audit`.
- Disclose the commission relationship as the platform and local rules require; the tag in the app helps, but the
  creator remains responsible for the disclosure.

## What not to do

- Do not promise income, approval or timelines.
- Do not tell the user to create new accounts, buy followers or views, or use engagement pods to reach a bar:
  these break TikTok's rules and put the account at risk.
