import assert from 'node:assert';
import { validateConfig, getPublicConfig, getPrivateConfig, config } from './config';

async function runTests() {
  console.log('Running @devpulse/config test suite...');

  // Test 1: Configuration structure and environment groups
  console.log('Test 1: Validating default configuration and environment groups...');
  assert.strictEqual(typeof config.app.port, 'number');
  assert.strictEqual(typeof config.app.nodeEnv, 'string');
  assert.strictEqual(typeof config.database.url, 'string');
  assert.strictEqual(typeof config.redis.host, 'string');
  assert.strictEqual(typeof config.github.clientId, 'string');
  assert.strictEqual(typeof config.auth.jwtSecret, 'string');
  assert.strictEqual(typeof config.encryption.key, 'string');
  assert.strictEqual(typeof config.urls.web, 'string');
  console.log('  ✓ Environment groups (app, database, redis, github, auth, encryption, urls) present');

  // Test 2: Public vs Private Configuration separation
  console.log('Test 2: Validating public vs private configuration separation...');
  const pub = getPublicConfig();
  const priv = getPrivateConfig();

  assert.strictEqual(pub.github.clientId, config.github.clientId);
  assert.strictEqual((pub as any).github.clientSecret, undefined);
  assert.strictEqual((pub as any).auth, undefined);

  assert.strictEqual(priv.github.clientSecret, config.github.clientSecret);
  assert.strictEqual(priv.auth.jwtSecret, config.auth.jwtSecret);
  assert.strictEqual(priv.encryption.key, config.encryption.key);
  console.log('  ✓ Public and private configuration separation verified');

  // Test 3: Invalid configuration triggers clear error
  console.log('Test 3: Validating invalid configuration handling...');
  try {
    validateConfig({
      NODE_ENV: 'development',
      PORT: 'not-a-number' as any,
      WEB_URL: 'invalid-url',
    });
    assert.fail('Should have thrown on invalid PORT and WEB_URL');
  } catch (err: any) {
    assert(err.message.includes('DEVPULSE CONFIGURATION ERROR'));
    assert(err.message.includes('PORT'));
    assert(err.message.includes('WEB_URL'));
    console.log('  ✓ Invalid configuration correctly caught with formatted error message');
  }

  // Test 4: Missing production secrets prevents app startup
  console.log('Test 4: Validating production secret requirement enforcement...');
  try {
    validateConfig({
      NODE_ENV: 'production',
      // No secrets provided
    });
    assert.fail('Should have thrown on missing production secrets');
  } catch (err: any) {
    assert(err.message.includes('Missing required production secrets'));
    assert(err.message.includes('JWT_SECRET'));
    console.log('  ✓ Missing production secrets successfully blocked app startup');
  }

  console.log('\n✅ ALL CONFIGURATION TESTS PASSED SUCCESSFULLY!');
}

runTests().catch((err) => {
  console.error('❌ Config tests failed:', err);
  process.exit(1);
});
