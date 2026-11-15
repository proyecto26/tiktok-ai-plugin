import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import path from 'node:path';

import { parseIdentity } from '../../skills/tiktok/scripts/main.ts';

const fx = (n: string) => JSON.parse(readFileSync(path.join(import.meta.dir, '../fixtures/tiktok', n), 'utf8'));

describe('whoami', () => {
    test('returns only username and id from the account-info answer', () => {
        expect(parseIdentity(fx('account-info.redacted.json'))).toEqual({ username: 'jdnichollsc', userId: '1' });
    });
    test('a logged-out answer is null (treated as auth)', () => {
        expect(parseIdentity(fx('account-info-logged-out.synthetic.json'))).toBeNull();
    });
});
