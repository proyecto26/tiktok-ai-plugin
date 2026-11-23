/** Number parsing for Ads Manager exports: "$1,234.50", "1.234,50 €", "1,50 %", "(3.00)", "-" ... */

export type Decimal = '.' | ',';

const EMPTY = /^(|-|--|—|–|n\/?a|null|none|nan)$/i;
// First numeric token: digits with . , spaces (also no-break spaces) inside it.
const TOKEN = /(?:\d|[.,]\d)[\d.,\s  ']*\d?/;

/** The numeric token of a cell, spaces and apostrophes removed (they only group digits). */
function token(raw: string): string | null {
    const m = raw.match(TOKEN);
    return m ? m[0].replace(/[\s  ']/g, '') : null;
}

/** Parse one cell. `decimal` is the file's decimal mark; it only decides a lone separator that could be either. */
export function parseNumber(raw: string | null | undefined, decimal: Decimal = '.'): number | null {
    if (raw === null || raw === undefined) return null;
    const s = String(raw).trim();
    if (EMPTY.test(s)) return null;
    let t = token(s);
    if (t === null) return null;
    const before = s.slice(0, s.indexOf(t.charAt(0)));
    const negative = /^\(.*\)$/.test(s) || /-/.test(before);
    const dots = (t.match(/\./g) || []).length;
    const commas = (t.match(/,/g) || []).length;
    if (dots && commas) {
        const dec = t.lastIndexOf('.') > t.lastIndexOf(',') ? '.' : ',';
        const grp = dec === '.' ? /,/g : /\./g;
        t = t.replace(grp, '');
        if (dec === ',') t = t.replace(',', '.');
    } else if (dots + commas > 0) {
        const sep = dots ? '.' : ',';
        const count = dots || commas;
        const at = t.indexOf(sep);
        const after = t.length - at - 1;
        if (count > 1) t = t.split(sep).join('');
        else if (sep === decimal) t = t.replace(sep, '.');
        else if (after === 3 && at > 0) t = t.replace(sep, '');
        else t = t.replace(sep, '.');
    }
    const n = Number(t);
    if (!Number.isFinite(n)) return null;
    return negative ? -n : n;
}

/** Which mark a file uses for decimals, from the cells that can only be read one way. */
export function detectDecimal(cells: string[], delimiter = ','): Decimal {
    let comma = 0;
    let dot = 0;
    for (const c of cells) {
        const t = token(String(c));
        if (!t) continue;
        const dots = (t.match(/\./g) || []).length;
        const commas = (t.match(/,/g) || []).length;
        if (dots && commas) {
            if (t.lastIndexOf('.') > t.lastIndexOf(',')) dot++;
            else comma++;
        } else if (commas > 1) dot++;
        else if (dots > 1) comma++;
        else if (commas === 1) {
            const after = t.length - t.indexOf(',') - 1;
            if (after !== 3) comma++;
        } else if (dots === 1) {
            const after = t.length - t.indexOf('.') - 1;
            if (after !== 3) dot++;
        }
    }
    if (comma === dot) return delimiter === ';' ? ',' : '.';
    return comma > dot ? ',' : '.';
}

/** The currency mark of a cell ("$", "€", "USD"), if it carries one. */
export function currencyOf(raw: string): string | undefined {
    const m = String(raw).match(/[$€£¥]|\b[A-Z]{3}\b/);
    return m ? m[0] : undefined;
}
