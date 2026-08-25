import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
  timingSafeEqual
} from 'node:crypto';
import { config } from '../config';
import { HttpError } from './http';

const ENVELOPE_VERSION = 'tsk1';
const CONNECTOR_SECRET_PREFIX = 'tks';
const IV_BYTES = 12;

export interface EncryptedSupportValue {
  ciphertext: string;
  keyId: string;
}

export interface MintedSupportConnectorSecret {
  lookupId: string;
  secret: string;
  secretHash: string;
}

export function supportDataEncryptionAvailable(
  keyMaterial = config.TASKARA_SUPPORT_DATA_SECRET
): boolean {
  return Boolean(keyMaterial && Buffer.byteLength(keyMaterial, 'utf8') >= 32);
}

/**
 * Generate independent public lookup and secret material. Only the hash and an AES-GCM envelope
 * are persisted; the plaintext is returned to the connector administrator once.
 */
export function mintSupportConnectorSecret(): MintedSupportConnectorSecret {
  const lookupId = randomBytes(16).toString('hex');
  const secret = `${CONNECTOR_SECRET_PREFIX}_${randomBytes(32).toString('base64url')}`;
  return { lookupId, secret, secretHash: sha256Hex(secret) };
}

export function hashSupportPayload(bytes: Buffer): string {
  return sha256Hex(bytes);
}

export function encryptSupportText(
  plaintext: string,
  keyMaterial?: string
): EncryptedSupportValue {
  const { key, keyId } = supportDataKey(resolveKeyMaterial(keyMaterial));
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return {
    ciphertext: [ENVELOPE_VERSION, keyId, iv.toString('base64url'), tag.toString('base64url'), encrypted.toString('base64url')].join('.'),
    keyId
  };
}

export function decryptSupportText(
  envelope: string,
  keyMaterial?: string
): string {
  const [version, envelopeKeyId, encodedIv, encodedTag, encodedCiphertext, ...rest] = envelope.split('.');
  if (
    version !== ENVELOPE_VERSION ||
    !envelopeKeyId ||
    !encodedIv ||
    !encodedTag ||
    encodedCiphertext === undefined ||
    rest.length
  ) {
    throw new HttpError(500, 'Support encrypted value has an invalid envelope');
  }

  const { key, keyId } = supportDataKey(resolveKeyMaterial(keyMaterial));
  if (!constantTimeTextEqual(envelopeKeyId, keyId)) {
    throw new HttpError(500, 'Support encrypted value uses an unavailable key');
  }

  try {
    const iv = decodeCanonicalBase64url(encodedIv);
    const tag = decodeCanonicalBase64url(encodedTag);
    const encrypted = decodeCanonicalBase64url(encodedCiphertext);
    const decipher = createDecipheriv('aes-256-gcm', key, iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([
      decipher.update(encrypted),
      decipher.final()
    ]).toString('utf8');
  } catch {
    throw new HttpError(500, 'Support encrypted value failed authentication');
  }
}

function decodeCanonicalBase64url(value: string): Buffer {
  const decoded = Buffer.from(value, 'base64url');
  if (decoded.toString('base64url') !== value) throw new Error('Non-canonical base64url');
  return decoded;
}

export function encryptSupportBytes(
  plaintext: Buffer,
  keyMaterial?: string
): { ciphertext: Buffer; keyId: string } {
  const encrypted = encryptSupportText(plaintext.toString('base64'), keyMaterial);
  return { ciphertext: Buffer.from(encrypted.ciphertext, 'utf8'), keyId: encrypted.keyId };
}

export function decryptSupportBytes(
  ciphertext: Uint8Array,
  keyMaterial?: string
): Buffer {
  return Buffer.from(decryptSupportText(Buffer.from(ciphertext).toString('utf8'), keyMaterial), 'base64');
}

export function verifySupportConnectorSecret(secret: string, expectedHash: string): boolean {
  return constantTimeTextEqual(sha256Hex(secret), expectedHash);
}

export function constantTimeTextEqual(left: string, right: string): boolean {
  const a = Buffer.from(left, 'utf8');
  const b = Buffer.from(right, 'utf8');
  if (a.length !== b.length) {
    timingSafeEqual(b, b);
    return false;
  }
  return timingSafeEqual(a, b);
}

function supportDataKey(keyMaterial: string | undefined): { key: Buffer; keyId: string } {
  if (!keyMaterial || Buffer.byteLength(keyMaterial, 'utf8') < 32) {
    throw new HttpError(
      503,
      'Support intake encryption is not configured; set TASKARA_SUPPORT_DATA_SECRET to at least 32 bytes'
    );
  }
  const key = createHash('sha256').update(keyMaterial, 'utf8').digest();
  return { key, keyId: createHash('sha256').update(key).digest('hex').slice(0, 16) };
}

function resolveKeyMaterial(explicit?: string): string | undefined {
  // `config` is the boot-time authority. Reading process.env as a fallback keeps isolated service
  // tests able to install a test-only key after module loading; production still fails closed when
  // neither source contains 32 bytes.
  return explicit ?? config.TASKARA_SUPPORT_DATA_SECRET ?? process.env.TASKARA_SUPPORT_DATA_SECRET;
}

function sha256Hex(value: string | Buffer): string {
  return createHash('sha256').update(value).digest('hex');
}
