import * as crypto from 'crypto';
import { config } from '@devpulse/config';

/**
 * Key Derivation and Encryption Strategy:
 * - Uses AES-256-GCM (Authenticated Encryption with Associated Data).
 * - Derives a 256-bit (32-byte) key from the configured ENCRYPTION_KEY using HKDF (SHA-256)
 *   with an application-specific info context ('devpulse-token-encryption-at-rest').
 * - For each encrypted value:
 *   - Generates a cryptographically secure 12-byte IV (nonce).
 *   - Produces ciphertext and a 16-byte auth tag.
 *   - Encodes as versioned string: "v1:<iv_hex>:<tag_hex>:<ciphertext_hex>".
 * - Supports key rotation readiness and backward compatibility:
 *   - If plaintext is passed or already decrypted, gracefully handles or detects format.
 *   - Format validation ensures corrupted or tampered payloads fail-safe with clear error.
 */

const CIPHER_ALGORITHM = 'aes-256-gcm';
const IV_LENGTH_BYTES = 12; // Standard 96-bit nonce for GCM
const AUTH_TAG_LENGTH_BYTES = 16;
const HKDF_INFO = 'devpulse-token-encryption-at-rest';
const HKDF_SALT = 'devpulse-encryption-salt-v1';

export class TokenEncryptionService {
  private readonly derivedKey: Buffer;

  constructor(masterKey?: string) {
    const rawKey = masterKey || config.encryption.key;
    if (!rawKey) {
      throw new Error('Encryption key is required for TokenEncryptionService');
    }

    // Derive a fixed 32-byte key using HKDF
    this.derivedKey = Buffer.from(
      crypto.hkdfSync(
        'sha256',
        Buffer.from(rawKey, 'utf8'),
        Buffer.from(HKDF_SALT, 'utf8'),
        Buffer.from(HKDF_INFO, 'utf8'),
        32,
      ),
    );
  }

  /**
   * Encrypts a sensitive plaintext token string using AES-256-GCM.
   * If value is null, undefined, or empty, returns null or empty string.
   */
  encrypt(plainText: string): string;
  encrypt(plainText: string | null | undefined): string | null;
  encrypt(plainText: string | null | undefined): string | null {
    if (plainText === null || plainText === undefined) {
      return null;
    }
    if (plainText === '') {
      return '';
    }

    // If already encrypted with v1 format, return as is
    if (this.isEncrypted(plainText)) {
      return plainText;
    }

    const iv = crypto.randomBytes(IV_LENGTH_BYTES);
    const cipher = crypto.createCipheriv(CIPHER_ALGORITHM, this.derivedKey, iv, {
      authTagLength: AUTH_TAG_LENGTH_BYTES,
    });

    const encrypted = Buffer.concat([
      cipher.update(plainText, 'utf8'),
      cipher.final(),
    ]);

    const tag = cipher.getAuthTag();

    // Versioned envelope format: v1:iv:tag:ciphertext
    return `v1:${iv.toString('hex')}:${tag.toString('hex')}:${encrypted.toString('hex')}`;
  }

  /**
   * Decrypts an encrypted token envelope.
   * If value is null, undefined, or empty, returns null or empty string.
   * If value is not an encrypted envelope, returns it directly (for backward compatibility).
   */
  decrypt(cipherEnvelope: string): string;
  decrypt(cipherEnvelope: string | null | undefined): string | null;
  decrypt(cipherEnvelope: string | null | undefined): string | null {
    if (cipherEnvelope === null || cipherEnvelope === undefined) {
      return null;
    }
    if (cipherEnvelope === '') {
      return '';
    }

    if (!this.isEncrypted(cipherEnvelope)) {
      // Legacy unencrypted plaintext fallback
      return cipherEnvelope;
    }

    const parts = cipherEnvelope.split(':');
    if (parts.length !== 4) {
      throw new Error('Malformed encrypted token envelope structure');
    }

    const [version, ivHex, tagHex, encryptedHex] = parts;
    if (version !== 'v1') {
      throw new Error(`Unsupported token encryption version: ${version}`);
    }

    const iv = Buffer.from(ivHex, 'hex');
    const tag = Buffer.from(tagHex, 'hex');
    const encryptedText = Buffer.from(encryptedHex, 'hex');

    if (iv.length !== IV_LENGTH_BYTES) {
      throw new Error('Invalid initialization vector length');
    }
    if (tag.length !== AUTH_TAG_LENGTH_BYTES) {
      throw new Error('Invalid authentication tag length');
    }

    const decipher = crypto.createDecipheriv(CIPHER_ALGORITHM, this.derivedKey, iv, {
      authTagLength: AUTH_TAG_LENGTH_BYTES,
    });
    decipher.setAuthTag(tag);

    try {
      const decrypted = Buffer.concat([
        decipher.update(encryptedText),
        decipher.final(),
      ]);

      return decrypted.toString('utf8');
    } catch (err: any) {
      throw new Error(`Failed to decrypt token: payload authentication check failed or corrupted data (${err.message})`);
    }
  }

  /**
   * Checks whether a given string is in the versioned envelope encryption format.
   */
  isEncrypted(value: string): boolean {
    if (!value || typeof value !== 'string') {
      return false;
    }
    const parts = value.split(':');
    return (
      parts.length === 4 &&
      parts[0] === 'v1' &&
      parts[1].length === IV_LENGTH_BYTES * 2 &&
      parts[2].length === AUTH_TAG_LENGTH_BYTES * 2
    );
  }
}
