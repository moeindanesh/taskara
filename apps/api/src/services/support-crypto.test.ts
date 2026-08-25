import { describe, expect, test } from 'bun:test';
import {
  decryptSupportBytes,
  decryptSupportText,
  encryptSupportBytes,
  encryptSupportText,
  mintSupportConnectorSecret,
  verifySupportConnectorSecret
} from './support-crypto';

const TEST_KEY = 'test-only-support-data-key-material-32-bytes-long';

describe('Support secret and payload encryption', () => {
  test('round trips text and exact non-UTF8 bytes without deterministic ciphertext', () => {
    const first = encryptSupportText('connector signing secret', TEST_KEY);
    const second = encryptSupportText('connector signing secret', TEST_KEY);
    expect(first.ciphertext).not.toBe(second.ciphertext);
    expect(decryptSupportText(first.ciphertext, TEST_KEY)).toBe('connector signing secret');

    const bytes = Buffer.from([0, 1, 2, 254, 255, 10, 13]);
    const encrypted = encryptSupportBytes(bytes, TEST_KEY);
    expect(decryptSupportBytes(encrypted.ciphertext, TEST_KEY)).toEqual(bytes);
  });

  test('rejects tampering and the wrong deployment key', () => {
    const encrypted = encryptSupportText('sensitive', TEST_KEY);
    expect(() => decryptSupportText(`${encrypted.ciphertext}x`, TEST_KEY)).toThrow();
    expect(() => decryptSupportText(encrypted.ciphertext, `${TEST_KEY}-different`)).toThrow();
  });

  test('mints a high-entropy one-time secret whose hash can be verified', () => {
    const minted = mintSupportConnectorSecret();
    expect(minted.lookupId).toMatch(/^[0-9a-f]{32}$/);
    expect(minted.secret).toMatch(/^tks_[A-Za-z0-9_-]{43}$/);
    expect(verifySupportConnectorSecret(minted.secret, minted.secretHash)).toBe(true);
    expect(verifySupportConnectorSecret(`${minted.secret}x`, minted.secretHash)).toBe(false);
  });
});
