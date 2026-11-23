<!-- Adapted from marketingskills (MIT, (c) 2025 Corey Haines), skills/ads/references/meta-andromeda-playbook.md, through instagram-ai-plugin; retargeted to TikTok. -->

# TikTok paid promotion: Spark Ads, Promote, Ads Manager

Dated 2026-11-22. Product names, limits and flows change often: **verify in the app or Ads Manager before quoting a
number or a menu path.** This plugin does none of this itself; the user does every step.

## Three ways to pay for reach

| Route | Where | Good for | Limits (verify) |
|---|---|---|---|
| **Promote** | TikTok app or TikTok Studio, on one of your own videos | a quick boost for views, profile visits, website visits or followers; no ad account to learn | few settings; one video at a time; the app's payment method; less targeting and reporting |
| **Spark Ads** | TikTok Ads Manager, using an existing organic post as the ad | scaling a post that already works, with its likes, comments and shares kept on the original | the post must be public and eligible; a creator's post needs the creator's authorisation code (valid for a period they choose); sounds are subject to commercial-use rules |
| **Non-Spark (dark) ads** | TikTok Ads Manager, a video uploaded as an ad | variants you do not want on the profile; strict tests | no organic social proof; the ad is not on the profile grid |

Start from evidence: `tiktok-audit` lists the posts at 3x or more of the account's own median. A post that already
beats the median organically is the cheapest creative test. Prefer posts whose hook works with the sound off and
whose first two seconds state the claim; comments full of questions signal buying intent.

## Campaign structure in Ads Manager

- **Campaign** holds the objective (awareness, traffic, video views, community interaction, lead generation,
  website conversions, app promotion, product sales). Pick the objective that matches the event you will judge on.
- **Ad group** holds placement, audience, budget, schedule, optimisation event and bid.
- **Ad** holds the creative, text, call to action and destination.
- Install the TikTok Pixel (or Events API) before a conversion objective, and test that the event fires.
- Two campaigns work well: **Testing** (new concepts, a protected budget) and **Scaling** (graduated winners).
  Graduate only past `references/decision-system.md` thresholds; scale in steps of about 20%.
- TikTok also offers automated campaign types (Smart+ and, for Shop, GMV Max). They trade control for delivery
  automation; use them once there is a proven creative and enough conversion volume (verify the current rules).

## Creative-led delivery

- **Broad audience, specific creative.** The video does the targeting. Avoid stacking many interests early.
- **Native beats polished.** Ads that look like ads are scrolled past. Shoot vertical 9:16, handheld, with captions,
  a person on camera or a clear hand and product, sound on. Keep text inside the safe zone
  (`../tiktok-content/references`).
- **Hook in the first 2 seconds**: a claim, a question, a before and after, a pattern break. The rest of the
  structure is the same as an organic post (see `tiktok-video-breakdown` for how a winner is built).
- **Volume of distinct concepts is the lever.** Variants of one idea count as one concept. Plan three axes: the
  concept (one product truth), the angle (the way it is said) and the awareness level (new to the category or a
  power user). A matrix of these shows which message, to whom, is winning.
- **Run proven content as an ad.** An organic video with strong watch time plus paid distribution is the
  highest-leverage move.
- **Sequence, do not repeat.** Cold concept, then a different-angle retarget (proof or an objection), then the
  offer. Do not retarget with the same ad.
- **Give each ad about five days before judging it**; a Friday launch meets a different audience than a Monday one.
- **Keep a lessons file**: what each test taught feeds the next brief.

## Landing page and funnel

Open the destination on a phone from a real ad preview, inside the app's browser: it must load fast, match the
promise in the video, and fire its events. Read the funnel stage by stage. Strong hook and hold but few clicks: the
ad earned attention but not the tap. Clicks but no conversions: the page breaks the promise. Conversions of poor
quality: look at the optimisation event and the audience.

## TikTok Shop

Shop ads and affiliate content are covered in `monetization-programs.md`; judge them with the same target-CPA rules,
using the profit per order as the anchor.

## What this skill will not do

It will not create, boost, promote, pause or fund an ad, change a budget, or ask for the user's TikTok password or
payment details. Give the exact setting to enter and let the user make the change.
