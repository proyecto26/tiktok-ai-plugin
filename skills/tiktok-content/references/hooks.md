# Hooks: the first 1-3 seconds

A TikTok viewer decides in the first seconds whether to stay. Three things happen at once, and each is written
separately:

| Layer | What it is | Rule |
|---|---|---|
| Spoken line | the first sentence said aloud | sounds like a person talking; one specific fact; no greeting |
| On-screen text | what is read before it is heard | a few words, never the spoken line repeated (muted viewers get it, sound viewers get a second hook) |
| Frame one | what the picture shows before anything is said | the result, the tension or a break in the expected picture; never a logo, a title card or a slow zoom |

Score the three together: `hook-score.ts --hook "<spoken>" --on-screen "<text>" --visual "<frame one>"`. A missing
layer scores zero in its weight, so the score shows what is not there yet.

## Shapes by goal

Pick the goal first, then the shape. Fill every shape with a fact the owner gave.

| Goal | Shape | Spoken example (shape only) | Usually ruined by |
|---|---|---|---|
| completion | show the result first, promise the how | "This kitchen cost {{n}} to redo. Here's where the money went." | the result shown at the end instead |
| completion | start in the middle of the story | "Twenty minutes before the launch, the site went down." | backing up to explain the context first |
| completion | break the picture | (frame one: something enters or the camera snaps close before a word) | a break that has nothing to do with the topic |
| saves | one odd, exact number | "{{n}} settings changed my battery life." | a round or invented number |
| saves | numbered payoff | "Three things I check before every {{task}}." | numbers that never appear on screen |
| saves | step one now, result previewed | (frame one: the finished thing; line: "Step one takes ten seconds.") | a long setup before step one |
| comments | the exact question the video answers | "Why does {{thing}} always {{problem}}?" | a question nobody asks |
| comments | a flat claim, no hedge | "{{Common advice}} is costing you {{result}}." | a claim the video cannot back |
| shares | a hyper-specific shared moment | "When you {{very specific situation}}…" | being generic enough to fit anyone |
| shares | a trending sound with a twist | (the sound's known pattern bent to the niche) | the sound with no twist, or a sound the owner cannot use |

The formulas in `scripts/hooks.json` (26, upstream) add templates, filled examples and on-screen versions; they were
written for short-form video in general and work here when the three layers are written separately.

## Checks before filming

- Read the spoken line out loud. If it sounds written, rewrite it.
- The on-screen text and the spoken line differ.
- Frame one is planned, not "whatever the camera sees".
- The video pays off the promise; a hook that the video does not keep loses the next video too.
