import * as assert from 'node:assert';
import { TokenEncryptionService } from './token-encryption.service';
import { AuthService } from './auth.service';

async function runEncryptionTests() {
  console.log('=== Token Encryption at Rest & Key Management Tests ===');

  const encryptionService = new TokenEncryptionService();

  // Test 1: AES-256-GCM encryption produces versioned format
  console.log('Test 1: Encryption produces correct versioned envelope');
  {
    const plainToken = 'gho_16C7e42F292c6912E7710c838347Ae178B4a';
    const encrypted = encryptionService.encrypt(plainToken);

    assert.notStrictEqual(encrypted, plainToken);
    assert.ok(encrypted.startsWith('v1:'), 'Envelope must start with version v1:');

    const parts = encrypted.split(':');
    assert.strictEqual(parts.length, 4, 'Must have version, IV, authTag, and ciphertext');
    assert.strictEqual(parts[0], 'v1');
    assert.strictEqual(parts[1].length, 24, 'IV must be 12 bytes hex (24 chars)');
    assert.strictEqual(parts[2].length, 32, 'AuthTag must be 16 bytes hex (32 chars)');
    assert.ok(parts[3].length > 0, 'Ciphertext must be non-empty');
    console.log('  ✓ Versioned envelope structure verified');
  }

  // Test 2: Decryption reproduces identical plaintext
  console.log('Test 2: Decryption restores original token exactly');
  {
    const tokens = [
      'gho_998877665544332211aabbccddeeff0011223344',
      'ghr_refresh_token_example_super_secret_value',
      'github_pat_11AABCDEF_very_long_opaque_token_string',
    ];

    for (const token of tokens) {
      const encrypted = encryptionService.encrypt(token);
      const decrypted = encryptionService.decrypt(encrypted);
      assert.strictEqual(decrypted, token, `Decrypted token should match original for ${token}`);
    }
    console.log('  ✓ Token encryption and decryption round-trip verified');
  }

  // Test 3: Unique nonces (IVs) ensure distinct ciphertexts for identical plaintext
  console.log('Test 3: Nonce uniqueness ensures different ciphertexts for same input');
  {
    const plainToken = 'gho_identical_token_value';
    const enc1 = encryptionService.encrypt(plainToken);
    const enc2 = encryptionService.encrypt(plainToken);

    assert.notStrictEqual(enc1, enc2, 'Two encryptions of the same plaintext must yield different ciphertexts');
    assert.strictEqual(encryptionService.decrypt(enc1), plainToken);
    assert.strictEqual(encryptionService.decrypt(enc2), plainToken);
    console.log('  ✓ Probabilistic encryption with unique IVs verified');
  }

  // Test 4: Tamper-resistance and integrity check with GCM auth tag
  console.log('Test 4: Tampered ciphertext or tag is rejected (fail-secure)');
  {
    const plainToken = 'gho_secret_tamper_test';
    const encrypted = encryptionService.encrypt(plainToken);
    const parts = encrypted.split(':');

    // Tamper ciphertext
    const tamperedCipher = parts[3].slice(0, -2) + (parts[3].endsWith('a') ? 'b' : 'a');
    const tamperedPayload = `${parts[0]}:${parts[1]}:${parts[2]}:${tamperedCipher}`;

    assert.throws(
      () => encryptionService.decrypt(tamperedPayload),
      /failed|authentication check failed/i,
      'Tampered ciphertext must fail authentication',
    );

    // Tamper auth tag
    const tamperedTag = (parts[2].startsWith('0') ? '1' : '0') + parts[2].slice(1);
    const tamperedTagPayload = `${parts[0]}:${parts[1]}:${tamperedTag}:${parts[3]}`;

    assert.throws(
      () => encryptionService.decrypt(tamperedTagPayload),
      /failed|authentication check failed/i,
      'Tampered auth tag must fail authentication',
    );
    console.log('  ✓ Tamper-resistance verified via GCM authentication tag');
  }

  // Test 5: Key derivation ensures keys from different master secrets cannot decrypt each other
  console.log('Test 5: Key segregation across different master keys');
  {
    const serviceA = new TokenEncryptionService('custom_master_key_11111111111111111');
    const serviceB = new TokenEncryptionService('custom_master_key_22222222222222222');

    const token = 'gho_key_segregation_test';
    const encA = serviceA.encrypt(token);

    assert.throws(
      () => serviceB.decrypt(encA),
      /failed|authentication check failed/i,
      'Decrypting with a different master key must fail authentication',
    );
    console.log('  ✓ Key derivation segregation verified');
  }

  // Test 6: Null and empty handling
  console.log('Test 6: Safe handling of null, undefined, and empty string');
  {
    assert.strictEqual(encryptionService.encrypt(null), null);
    assert.strictEqual(encryptionService.encrypt(undefined), null);
    assert.strictEqual(encryptionService.encrypt(''), '');
    assert.strictEqual(encryptionService.decrypt(null), null);
    assert.strictEqual(encryptionService.decrypt(undefined), null);
    assert.strictEqual(encryptionService.decrypt(''), '');
    console.log('  ✓ Null and empty values handled gracefully');
  }

  // Test 7: AuthService integration
  console.log('Test 7: AuthService encryptToken and decryptToken helpers');
  {
    const authService = new AuthService(encryptionService);
    const token = 'gho_auth_service_integration_token';
    const encrypted = authService.encryptToken(token);

    assert.ok(encrypted);
    assert.notStrictEqual(encrypted, token);
    assert.ok(encrypted.startsWith('v1:'));
    assert.strictEqual(authService.decryptToken(encrypted), token);
    console.log('  ✓ AuthService encryption helper methods verified');
  }

  console.log('\n✅ ALL TOKEN ENCRYPTION & KEY MANAGEMENT TESTS PASSED!\n');
}

runEncryptionTests().catch((err) => {
  console.error('❌ Token encryption tests failed:', err);
  process.exit(1);
});
