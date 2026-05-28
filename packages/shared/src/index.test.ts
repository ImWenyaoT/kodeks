import { describe, expect, it } from 'vitest';

import { err, isErr, isOk, ok } from './index';

describe('@kodeks/shared result helpers', () => {
  it('creates typed ok and error results', () => {
    const success = ok({ id: 'session_1' });
    const failure = err('missing session');

    expect(isOk(success)).toBe(true);
    expect(isErr(success)).toBe(false);
    expect(success.value).toEqual({ id: 'session_1' });
    expect(isErr(failure)).toBe(true);
    expect(isOk(failure)).toBe(false);
    expect(failure.error).toBe('missing session');
  });
});
