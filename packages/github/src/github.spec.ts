import assert from 'assert';
import {
  GitHubClient,
  GitHubWebhooks,
  GitHubError,
  GitHubRateLimitError,
  GitHubNotFoundError,
  GitHubAuthenticationError,
  GitHubForbiddenError,
} from './index';

async function runTests() {
  console.log('Running @devpulse/github tests...');

  // 1. Client instantiation test
  const client = new GitHubClient({
    token: 'ghp_test_token_12345',
    baseUrl: 'https://api.github.com',
    oauthConfig: {
      clientId: 'test-client-id',
      clientSecret: 'test-client-secret',
      callbackUrl: 'http://localhost:3000/callback',
    },
    webhookSecret: 'test-webhook-secret',
  });

  assert.ok(client.auth, 'client.auth should be defined');
  assert.ok(client.users, 'client.users should be defined');
  assert.ok(client.repositories, 'client.repositories should be defined');
  assert.ok(client.commits, 'client.commits should be defined');
  assert.ok(client.pullRequests, 'client.pullRequests should be defined');
  assert.ok(client.reviews, 'client.reviews should be defined');
  assert.ok(client.issues, 'client.issues should be defined');
  assert.ok(client.webhooks, 'client.webhooks should be defined');
  console.log('✔ Client submodules instantiated successfully');

  // 2. OAuth authorization URL generation test
  const authUrl = client.auth.getAuthorizationUrl({
    scopes: ['read:user', 'repo'],
    state: 'state123',
  });
  assert.ok(authUrl.includes('client_id=test-client-id'), 'authUrl contains client_id');
  assert.ok(authUrl.includes('state=state123'), 'authUrl contains state');
  assert.ok(authUrl.includes('scope=read%3Auser+repo') || authUrl.includes('scope=read%3Auser%20repo'), 'authUrl contains scopes');
  console.log('✔ OAuth URL generation verified');

  // 3. Webhook signature creation and verification test
  const payload = JSON.stringify({ action: 'opened', pull_request: { id: 101, number: 1 } });
  const secret = 'super-secret-key';
  const signature = GitHubWebhooks.sign(payload, secret);

  assert.ok(signature.startsWith('sha256='), 'Signature starts with sha256=');
  assert.strictEqual(
    GitHubWebhooks.verifySignature({ payload, signature, secret }),
    true,
    'Valid signature should verify to true'
  );
  assert.strictEqual(
    GitHubWebhooks.verifySignature({ payload, signature: signature.slice(0, -2) + 'aa', secret }),
    false,
    'Invalid signature should verify to false'
  );
  assert.strictEqual(
    GitHubWebhooks.verifySignature({ payload, signature, secret: 'wrong-secret' }),
    false,
    'Wrong secret should fail verification'
  );

  const parsed = client.webhooks.parseEvent(payload, signature, secret);
  assert.strictEqual(parsed.action, 'opened');
  assert.strictEqual(GitHubWebhooks.isPullRequestEvent('pull_request', parsed), true);
  assert.strictEqual(GitHubWebhooks.isPushEvent('pull_request', parsed), false);
  console.log('✔ Webhook signature verification and parsing verified');

  // 4. Rate-limit and custom error hierarchy test
  const rateLimitInfo = {
    limit: 5000,
    remaining: 0,
    reset: Math.floor(Date.now() / 1000) + 120,
    used: 5000,
  };
  const rateLimitErr = new GitHubRateLimitError('API rate limit exceeded', rateLimitInfo);
  assert.ok(rateLimitErr instanceof GitHubError, 'RateLimitError is instance of GitHubError');
  assert.strictEqual(rateLimitErr.status, 403);
  assert.strictEqual(rateLimitErr.isRateLimitExceeded, true);
  assert.strictEqual(rateLimitErr.rateLimit?.remaining, 0);
  assert.ok(rateLimitErr.retryAfterSeconds > 0, 'Retry after seconds should be positive');

  const notFoundErr = new GitHubNotFoundError('Repository not found');
  assert.strictEqual(notFoundErr.status, 404);

  const authErr = new GitHubAuthenticationError('Bad credentials');
  assert.strictEqual(authErr.status, 401);

  const forbiddenErr = new GitHubForbiddenError('Must have push access');
  assert.strictEqual(forbiddenErr.status, 403);
  console.log('✔ Error hierarchy and rate limit models verified');

  console.log('All @devpulse/github tests passed successfully! 🎉');
}

runTests().catch((err) => {
  console.error('Test failed:', err);
  process.exit(1);
});
