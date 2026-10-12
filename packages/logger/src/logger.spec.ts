import assert from 'assert';
import { Logger } from './logger';
import { redactSensitiveData, REDACTED_VALUE } from './redact';
import { CorrelationContext } from './context';

console.log('--- Running Logger Tests ---');

// 1. Redaction tests
console.log('Test 1: Redaction of sensitive fields');
const testObj = {
  user: 'alice',
  password: 'supersecretpassword',
  token: 'xyz-secret-token',
  apiKey: '1234567890',
  nested: {
    authorization: 'Bearer secret_token_123',
    sessionSecret: 'my_session_secret',
    clientSecret: 'secret_value',
    safeField: 'hello world',
  },
};

const redacted = redactSensitiveData(testObj);
assert.strictEqual(redacted.user, 'alice');
assert.strictEqual(redacted.password, REDACTED_VALUE);
assert.strictEqual(redacted.token, REDACTED_VALUE);
assert.strictEqual(redacted.apiKey, REDACTED_VALUE);
assert.strictEqual(redacted.nested.safeField, 'hello world');
assert.strictEqual(redacted.nested.authorization, REDACTED_VALUE);
assert.strictEqual(redacted.nested.sessionSecret, REDACTED_VALUE);
assert.strictEqual(redacted.nested.clientSecret, REDACTED_VALUE);

// Bearer token inside arbitrary string
const bearerString = 'Request header was Bearer abc123def456xyz';
assert.strictEqual(redactSensitiveData(bearerString), `Request header was Bearer ${REDACTED_VALUE}`);

console.log('✓ Redaction passed');

// 2. CorrelationContext tests
console.log('Test 2: CorrelationContext async propagation');
CorrelationContext.run({ correlationId: 'corr-123', requestId: 'req-456' }, () => {
  const ctx = CorrelationContext.get();
  assert.strictEqual(ctx.correlationId, 'corr-123');
  assert.strictEqual(ctx.requestId, 'req-456');

  CorrelationContext.setContext({ jobId: 'job-789' });
  const updated = CorrelationContext.get();
  assert.strictEqual(updated.jobId, 'job-789');
});
assert.strictEqual(CorrelationContext.get().correlationId, undefined);
console.log('✓ CorrelationContext passed');

// 3. Logger structured output test
console.log('Test 3: Structured JSON output');
let capturedLog: any = null;
const originalStdoutWrite = process.stdout.write;
process.stdout.write = ((chunk: any) => {
  try {
    capturedLog = JSON.parse(chunk.toString());
  } catch (e) {
    // ignore non-json
  }
  return true;
}) as any;

try {
  const jsonLogger = new Logger({
    service: 'test-api',
    context: 'TestModule',
    level: 'info',
    format: 'json',
  });

  CorrelationContext.run({ correlationId: 'trace-abc', jobId: 'job-xyz' }, () => {
    jsonLogger.info('Testing info message', {
      sensitiveKey: 'secret_val',
      password: 'password123',
      normalKey: 'ok',
    });
  });

  assert(capturedLog !== null, 'Log should have been captured');
  assert.strictEqual(capturedLog.service, 'test-api');
  assert.strictEqual(capturedLog.context, 'TestModule');
  assert.strictEqual(capturedLog.level, 'info');
  assert.strictEqual(capturedLog.message, 'Testing info message');
  assert.strictEqual(capturedLog.correlationId, 'trace-abc');
  assert.strictEqual(capturedLog.jobId, 'job-xyz');
  assert.strictEqual(capturedLog.meta.normalKey, 'ok');
  assert.strictEqual(capturedLog.meta.password, REDACTED_VALUE);
  assert.strictEqual(capturedLog.meta.sensitiveKey, REDACTED_VALUE);
  assert(capturedLog.timestamp, 'Timestamp must exist');
} finally {
  process.stdout.write = originalStdoutWrite;
}

console.log('✓ Structured JSON output & redaction passed');

// 4. Log levels filtering test
console.log('Test 4: Log level filtering');
let debugLogged = false;
process.stdout.write = ((chunk: any) => {
  debugLogged = true;
  return true;
}) as any;

try {
  const infoOnlyLogger = new Logger({ level: 'info', format: 'json' });
  infoOnlyLogger.debug('This debug should NOT be logged');
  assert.strictEqual(debugLogged, false, 'Debug should not be logged when level is info');
} finally {
  process.stdout.write = originalStdoutWrite;
}
console.log('✓ Log level filtering passed');

console.log('\nAll logger tests passed successfully!');
