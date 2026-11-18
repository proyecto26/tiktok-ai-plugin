---
name: tiktok
description: This skill should be used when the user asks to "sign in to TikTok", "log in to TikTok with cookies", "read my TikTok profile", "list my TikTok videos", "get the comments of this TikTok", "check my TikTok session", or wants to "post this video to TikTok", "publish a TikTok photo post / carousel", "upload to TikTok privately", or to drive their own TikTok account from the terminal with their browser session (no TikTok API app, no third-party scraping service). It is the operator every other tiktok-* skill stands on.
---

# TikTok (The Operator)

Drive your own TikTok account with your browser session. Every command runs with:

```bash
npx -y bun skills/tiktok/scripts/main.ts <command> [options]
```

## Commands

| Command | What it does |
|---|---|
| `login` | Opens Chrome with a dedicated profile; you sign in (2FA is fine); the session cookies are captured over the local DevTools protocol |
| `import-cookies --file <path>` | Imports Cookie-Editor JSON, `cookies.txt` or a raw `Cookie:` header (only `.tiktok.com` cookies are kept) |
| `logout` | Deletes the stored session |
| `status` | Signed in or not, cookie names (never values), and whether the account is stopped by a signal |
| `resume` | Clears the account signal after you resolved a captcha or verification in the browser |
| `whoami` | The signed-in account (one paced request) |
| `profile --capture <file>` | Profile and stats from a browser capture |
| `videos --capture <file> [--limit N]` | Posts (default 20, max 200), videos and photo posts |
| `video --capture <file>` | One post |
| `comments --capture <file> [--limit N]` | Comments of a post |
| `hashtag --capture <file> [--limit N]` | Posts of a hashtag page (`/tag/<name>`) |
| `sound --capture <file> [--limit N]` | Posts of a sound page (`/music/<slug>-<id>`) |
| `publish prepare\|begin\|finish\|reconcile\|status` | Publish a video or photo post through TikTok Studio (see below) |

## Reading through your own Chrome

TikTok answers plain HTTP page loads with a "Please wait" WAF page, and its list APIs need signatures that only
its own page code makes. So reads happen in **your normal Chrome** (claude-in-chrome), where you are already
signed in:

1. Open one tab on the profile or post. Wait for it to load.
2. Run the text of `scripts/browser/capture.js` in the tab (javascript_tool). It installs a read-only hook that
   copies the JSON answers the page fetches for itself, and returns a `tt.capture.v1` capture.
3. To load more posts or comments, run `window.__ttCapture.more()` (one scroll, at most 10 per page), wait
   several seconds, and run the script again to collect.
   For comments, open the post **with a click from the profile** (it opens inside the page, no new page load);
   the page then fetches `/api/comment/list/` and the hook copies it. Loading a post URL directly is the
   request that got a 403 once; avoid it.
4. Save the returned JSON to a file and run the matching command above.

Lists also carry `exhausted`: `true` only when the whole list was read — every page from cursor 0 to the last
one, nothing dropped, nothing cut by `--limit`. Anything else is a sample: say "sample of N posts", never "the
account". The hook tags each answer with the list page it was requested on (profile, tag or music page) and
discards answers that arrive after the tab moved to another list (`stale`); answers from two list pages in one
capture are refused with `mixed_lists`. A hook installed by an older capture.js has no list identity: reload the
page before capturing. Captures now also carry each post's play and caption URLs: they are signed, never print
or share them.

Every result is `{source, data, complete, reason?}`. `complete: false` says why: `signed_list_api` (no list
answer was captured, only what the page embedded), `not_scrolled_far_enough`, `request_budget`,
`api_error` (TikTok answered a page with an error status; do not scroll on), `signed_comment_api` (no comment
page was captured for this post) or `capture_full` (the tab kept too many answers: reload the page and capture
again). Comments are kept per post and list pages per profile, so one tab can open several posts or profiles. If the page data belongs to another
profile or post than the URL (after moving around inside the page), the read fails with `unexpected_page`:
reload the page and capture again. A capture that met a captcha, a verification or an HTTP 429 is refused and
marks the account signal, like every other command; `more()` stops scrolling once it has seen one.

Pace yourself: one tab, few page loads, long pauses. A 403 "Access denied" page, a captcha or a "Please wait"
page means stop: write nothing more, close the tab and tell the user.

## Publishing (video or photo post, private by default)

The CLI never posts by itself. It binds the owner's approval to the exact local bytes (sha256) and settings,
records the attempt before Post is clicked, and settles the outcome. The page itself is checked by caption
(or title and description), privacy and toggles; a video by its file name; photos by the exact bytes handed
to the page's file input plus a visual fingerprint of each editor thumbnail, in order (the photo editor shows
no file names and re-encodes the images, so what the editor holds is bound only by that fingerprint: a
photo dropped in by drag and drop is never recorded, and a close re-edit of an approved photo could pass).
The cover is left at TikTok's default: before Post, look at the
preview (right media, right order) and that no verification is on the page.
Variants not yet verified live (non-private, AI label, disclosure; `prepare` lists them as
`experimental`) need `begin --experimental`, and only after telling the owner. The composer is driven in **your normal Chrome**.

1. `publish prepare --video clip.mp4 --caption "..."` (or `--photos a.jpg,b.jpg --title "..." --description "..."`).
   Privacy defaults to `only_me`; `--privacy everyone` also needs `--public`. Toggles: `--no-comments`,
   `--no-reuse`, `--ai-generated`, `--disclose`. It prints the draft and its digest (a dry run).
2. **Show the draft to the owner** (file name, size, sha256, caption, every setting) and wait for an explicit yes.
3. Open `https://www.tiktok.com/tiktokstudio/upload` (photos: the Photo tab) and run the text of
   `scripts/browser/compose.js` **before** adding any file (it records the bytes the file input receives; a
   page reload loses it: run it again and add the files again). Then add the file(s), in the approved order,
   with the page's file input; a file marked `manualFilePick` (over 10 MB) is chosen by the owner in the page.
   Photos: if the editor already holds other photos, remove them so it shows exactly the approved ones.
   Add photos only through the file input, never by drag and drop. Every file added after compose.js ran
   stays recorded even if removed later, so a wrong pick means: reload, run compose.js again, start over.
4. `await window.__ttCompose.fill(<draft.settings>)`. Read the baseline (below) in a second tab; then, back in
   the upload tab, save
   `JSON.stringify(await window.__ttCompose.snapshot())` to a file **right before** step 5 (a state older than
   2 minutes is refused). Copy it verbatim; never edit or fill in a field by hand. Never type into the photo
   description with other tools: it is a Draft.js editor, and a native text insert crashes the whole editor.
   The baseline: in a second tab, open `https://www.tiktok.com/tiktokstudio/content`, run `scripts/browser/studio-rows.js`
   and save the result: the **baseline** (at most 5 minutes old at begin; a list that did not load reads as no
   rows and is refused). Reconcile tells this post apart by text and minute, so begin refuses if Studio already
   lists a post with the same text still under review or dated in that minute: wait for a date, or change the text.
5. `publish begin --draft <digest> --approve <digest> --page-state <file> --baseline <rows file>`. It refuses on
   an account signal, a changed file, a different digest, a stale state, a verification on the page (it writes the account signal),
   a toggle or privacy compose.js could not read (an open privacy dropdown reads as unknown), a location on the
   post (approved posts have none; clear it), uploaded files that differ from the draft (name for a video; bytes,
   count or thumbnail order for photos), or anything else the
   page shows differently (`page_mismatch` lists the fields). Only when it prints an attempt: click **Post**
   once, in the same tab, without reloading or switching accounts.
   Studio rows have no post id and only a minute, so reconcile can be fooled: from the baseline until the
   attempt is settled (up to 15 minutes after begin), post nothing else on this account whose text matches or
   starts like this one. If that may have happened, have the owner check Studio and close it with `--by-owner`.
6. Studio moves to `/tiktokstudio/content`. Run `scripts/browser/studio-rows.js`, save the result, then
   `publish reconcile --attempt <id> --rows <file>`. A row matches only when its text (video: caption;
   photos: the description, which is what Studio lists) AND its time fit the attempt, and only if exactly one
   row does; otherwise the attempt stays open. While "Content under review" Studio shows no date, so the
   attempt stays open: reload Studio content after a few minutes and reconcile again. If the page crashed or the result is unclear:
   `publish finish --attempt <id> --outcome unknown`. `finish --outcome published|rejected` needs `--by-owner`
   and is recorded as an owner override (the owner checked Studio themselves). Disclosure toggles are not
   shown in the Studio list, so they are verified before Post (step 5), not after.

One open attempt (`submitted`, `processing`, `unknown`, or an unreadable record) blocks every new `begin`
until it is settled; a closed attempt (`published`, `rejected`) can never be reopened. A privacy that differs from the approval stays `unknown`: fix it in Studio by hand and
never post again to correct it. `publish status` lists open attempts.

## Rules

- Cookie values are never printed. The cookie store is locked to your user; if that lock fails nothing is saved.
- On HTTP 429, a captcha, a verification page or "too many attempts" every command stops and the account is
  marked with a signal; nothing runs again until you run `resume`. There are no retry loops.
- There are no like, follow, unfollow, DM or delete commands, by design.
- Nothing is published without the owner's explicit yes to the exact draft; Post is clicked once per attempt.
