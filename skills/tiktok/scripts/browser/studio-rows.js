// Read-only: the first rows of TikTok Studio's post list (/tiktokstudio/content), run in the owner's Chrome
// after a publish, to settle the attempt with `publish reconcile --attempt <id> --rows <file>`.
// It never clicks anything. A row is the smallest block around one privacy label ("Only me", "Everyone",
// "Friends", ...); its text is its first line that is not a label, a date or a number.
(() => {
    if (location.origin !== 'https://www.tiktok.com' || !location.pathname.startsWith('/tiktokstudio/content')) return { error: 'not the TikTok Studio content page' };
    const PRIVACY = { 'only me': 'only_me', 'only you': 'only_me', friends: 'friends', everyone: 'everyone', 'followers you follow back': 'follow_back' };
    const LABEL_RE = /^(only me|only you|friends|everyone|followers you follow back)$/i;
    const SKIP = /^(only me|only you|friends|everyone|followers you follow back|content under review|under review|public|private|edit|delete|more|pinned|\d[\d.,]*\s*[kmb]?|[\d:]+|\w{3} \d{1,2}(, \d{4})?.*|\d{1,2}[/-]\d{1,2}[/-]\d{2,4}.*)$/i;
    // One line per leaf element (independent of layout, so it reads the same in every renderer).
    const lines = (el) => Array.from(el.querySelectorAll('*')).filter((e) => !e.children.length).map((e) => (e.textContent || '').replace(/\s+/g, ' ').trim()).filter(Boolean);
    const leafLabels = Array.from(document.querySelectorAll('span,div,p')).filter((e) => LABEL_RE.test((e.textContent || '').trim()) && !Array.from(e.children).some((c) => LABEL_RE.test((c.textContent || '').trim())));
    const rows = [];
    const seen = new Set();
    // Seen live 2026-11-16: each row is [data-tt="components_RowLayout_FlexRow"], the caption sits in
    // [data-tt$="PostInfoCell_TruncateText"], and the privacy label is ~10 levels deep inside a button.
    // Privacy is read only OUTSIDE the caption cell (a caption that says "Only me" is not the privacy),
    // preferring a label inside a button; a row with zero or several such labels reads 'unknown'.
    const known = Array.from(document.querySelectorAll('[data-tt="components_RowLayout_FlexRow"]'));
    for (const r of known.slice(0, 10)) {
        const cap = r.querySelector('[data-tt$="PostInfoCell_TruncateText"]');
        const labels = Array.from(r.querySelectorAll('span,div,p')).filter((e) => LABEL_RE.test((e.textContent || '').trim()) && !Array.from(e.children).some((c) => LABEL_RE.test((c.textContent || '').trim())) && !(cap && cap.contains(e)));
        const inButton = labels.filter((e) => e.closest('button'));
        const pick = inButton.length ? inButton : labels;
        const ls = lines(r);
        const capText = cap ? (cap.textContent || '').replace(/\s+/g, ' ').trim() : '';
        const row = {
            text: capText || ls.find((l) => !SKIP.test(l)) || '',
            privacy: pick.length === 1 ? PRIVACY[(pick[0].textContent || '').trim().toLowerCase()] || 'unknown' : 'unknown',
            underReview: ls.some((l) => /under review/i.test(l)),
        };
        const time = ls.find((l) => l !== capText && /^\w{3} \d{1,2}(, \d{4})?|^\d{1,2}[/-]\d{1,2}[/-]\d{2,4}/.test(l));
        if (time) row.time = time;
        rows.push(row);
    }
    for (const label of known.length ? [] : leafLabels) {
        let row = label.parentElement;
        // Fallback: grow until the block holds a caption line, but never two privacy labels (the whole table)
        for (let i = 0; i < 14 && row; i++) {
            const labels = Array.from(row.querySelectorAll('span,div,p')).filter((e) => LABEL_RE.test((e.textContent || '').trim()) && !e.children.length).length;
            if (labels > 1) {
                row = null;
                break;
            }
            if (lines(row).some((l) => !SKIP.test(l))) break;
            row = row.parentElement;
        }
        if (!row || seen.has(row)) continue;
        seen.add(row);
        const ls = lines(row);
        rows.push({
            text: ls.find((l) => !SKIP.test(l)) || '',
            privacy: PRIVACY[(label.textContent || '').trim().toLowerCase()] || 'unknown',
            underReview: ls.some((l) => /under review/i.test(l)),
            time: ls.find((l) => /^\w{3} \d{1,2}(, \d{4})?|^\d{1,2}[/-]\d{1,2}[/-]\d{2,4}/.test(l)),
        });
        if (rows.length >= 10) break;
    }
    let account = '';
    try {
        const u = window.__Creator_Center_Context__ && window.__Creator_Center_Context__.commonAppContext && window.__Creator_Center_Context__.commonAppContext.user;
        if (u && typeof u.uniqueId === 'string') account = u.uniqueId.toLowerCase();
    } catch {
        // unreadable context: no account (profile links on the page do not say who is signed in)
    }
    return JSON.stringify({ schema: 'tt-rows-v1', account, rows });
})();
