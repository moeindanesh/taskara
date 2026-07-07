import { afterEach, describe, expect, test } from 'bun:test';
import { config } from '../config';
import { resolveCorsOrigin } from './cors';

const originalNodeEnv = process.env.NODE_ENV;

afterEach(() => {
  if (originalNodeEnv === undefined) {
    delete process.env.NODE_ENV;
  } else {
    process.env.NODE_ENV = originalNodeEnv;
  }
});

describe('CORS origin resolution', () => {
  test('allows configured web origin', () => {
    expect(resolveCorsOrigin(config.WEB_ORIGIN)).toBe(config.WEB_ORIGIN);
  });

  test('allows loopback origins on alternate dev ports outside production', () => {
    process.env.NODE_ENV = 'development';

    expect(resolveCorsOrigin('http://localhost:3006')).toBe('http://localhost:3006');
    expect(resolveCorsOrigin('http://127.0.0.1:3190')).toBe('http://127.0.0.1:3190');
  });

  test('does not allow loopback origins implicitly in production', () => {
    process.env.NODE_ENV = 'production';

    expect(resolveCorsOrigin('http://localhost:3006')).toBeNull();
  });

  test('rejects unrelated origins', () => {
    process.env.NODE_ENV = 'development';

    expect(resolveCorsOrigin('https://example.invalid')).toBeNull();
  });
});
