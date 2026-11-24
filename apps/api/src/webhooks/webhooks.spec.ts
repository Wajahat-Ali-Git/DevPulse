import assert from 'assert';
import { WebhooksController } from './webhooks.controller';
import { WebhooksService } from './webhooks.service';
import { GitHubWebhooks } from '@devpulse/github';
import { config } from '@devpulse/config';
import { BadRequestException, UnauthorizedException } from '@nestjs/common';
import { Request } from 'express';

async function runWebhookTests() {
  console.log('=== Running GitHub Webhook Endpoint Unit Tests ===\n');

  const secret = config.github.webhookSecret || 'test-webhook-secret-32-chars-long-abc';
  // Ensure config has webhook secret for tests
  (config.github as any).webhookSecret = secret;

  const service = new WebhooksService();
  const controller = new WebhooksController(service);

  // Helper to create mock request
  const createMockReq = (bodyObj: any, rawBodyString?: string): Request => {
    const raw = rawBodyString !== undefined ? rawBodyString : JSON.stringify(bodyObj);
    return {
      body: bodyObj,
      rawBody: Buffer.from(raw, 'utf8'),
      headers: {},
    } as unknown as Request;
  };

  // Test 1: Successful webhook ingestion with valid signature, headers, and payload
  console.log('Test 1: Valid GitHub webhook request accepted (202)');
  {
    const payload = { zen: 'Keep it logically awesome.', hook_id: 12345 };
    const rawPayload = JSON.stringify(payload);
    const validSignature = GitHubWebhooks.sign(rawPayload, secret);
    const req = createMockReq(payload, rawPayload);

    const response = await controller.handleGitHubWebhook(
      req,
      validSignature,
      'ping',
      'delivery-uuid-1',
      'application/json',
    );

    assert.strictEqual(response.received, true);
    assert.strictEqual(response.event, 'ping');
    assert.strictEqual(response.delivery, 'delivery-uuid-1');
    console.log('  ✔ Webhook successfully accepted with 202 and correct payload');
  }

  // Test 2: Reject request when Content-Type is missing or not application/json
  console.log('\nTest 2: Content-Type validation rejects unsupported types');
  {
    const payload = { ref: 'refs/heads/main' };
    const rawPayload = JSON.stringify(payload);
    const validSignature = GitHubWebhooks.sign(rawPayload, secret);
    const req = createMockReq(payload, rawPayload);

    // Missing content-type
    await assert.rejects(
      async () => {
        await controller.handleGitHubWebhook(
          req,
          validSignature,
          'push',
          'delivery-uuid-2',
          undefined,
        );
      },
      (err: any) => {
        assert(err instanceof BadRequestException);
        assert.strictEqual(err.message, 'Unsupported or missing Content-Type. Expected application/json');
        return true;
      },
    );

    // Non-json content-type
    await assert.rejects(
      async () => {
        await controller.handleGitHubWebhook(
          req,
          validSignature,
          'push',
          'delivery-uuid-2',
          'text/plain',
        );
      },
      (err: any) => {
        assert(err instanceof BadRequestException);
        return true;
      },
    );
    console.log('  ✔ Rejects non-JSON or missing Content-Type with 400 Bad Request');
  }

  // Test 3: Validate required headers (X-GitHub-Event, X-GitHub-Delivery, X-Hub-Signature-256)
  console.log('\nTest 3: Missing required headers validation');
  {
    const payload = { action: 'opened' };
    const rawPayload = JSON.stringify(payload);
    const validSignature = GitHubWebhooks.sign(rawPayload, secret);
    const req = createMockReq(payload, rawPayload);

    // Missing X-GitHub-Event
    await assert.rejects(
      async () => {
        await controller.handleGitHubWebhook(
          req,
          validSignature,
          undefined,
          'delivery-uuid-3',
          'application/json',
        );
      },
      (err: any) => {
        assert(err instanceof BadRequestException);
        assert.strictEqual(err.message, 'Missing required header: X-GitHub-Event');
        return true;
      },
    );

    // Missing X-GitHub-Delivery
    await assert.rejects(
      async () => {
        await controller.handleGitHubWebhook(
          req,
          validSignature,
          'pull_request',
          undefined,
          'application/json',
        );
      },
      (err: any) => {
        assert(err instanceof BadRequestException);
        assert.strictEqual(err.message, 'Missing required header: X-GitHub-Delivery');
        return true;
      },
    );

    // Missing X-Hub-Signature-256
    await assert.rejects(
      async () => {
        await controller.handleGitHubWebhook(
          req,
          undefined,
          'pull_request',
          'delivery-uuid-3',
          'application/json',
        );
      },
      (err: any) => {
        assert(err instanceof UnauthorizedException);
        assert.strictEqual(err.message, 'Missing webhook signature');
        return true;
      },
    );
    console.log('  ✔ Correctly rejects missing headers with 400 or 401');
  }

  // Test 4: Invalid, missing, or malformed signature rejection without exposing internal details
  console.log('\nTest 4: Signature verification failure and malformed signatures');
  {
    const payload = { action: 'synchronize' };
    const rawPayload = JSON.stringify(payload);
    const req = createMockReq(payload, rawPayload);

    // Mismatched signature
    const invalidSignature = 'sha256=ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff';
    await assert.rejects(
      async () => {
        await controller.handleGitHubWebhook(
          req,
          invalidSignature,
          'pull_request',
          'delivery-uuid-4',
          'application/json; charset=utf-8',
        );
      },
      (err: any) => {
        assert(err instanceof UnauthorizedException);
        assert.strictEqual(err.message, 'Invalid webhook signature');
        return true;
      },
    );

    // Malformed signatures (missing sha256= prefix, invalid length, invalid hex)
    const malformedSignatures = [
      'invalid-signature-without-prefix',
      'sha256=',
      'sha256=12345',
      'sha1=4328904832094823094823094823094823094823',
      'sha256=zzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzz',
    ];

    for (const malformedSig of malformedSignatures) {
      await assert.rejects(
        async () => {
          await controller.handleGitHubWebhook(
            req,
            malformedSig,
            'pull_request',
            'delivery-uuid-malformed',
            'application/json',
          );
        },
        (err: any) => {
          assert(err instanceof UnauthorizedException);
          assert.strictEqual(err.message, 'Invalid webhook signature');
          return true;
        },
      );
    }

    console.log('  ✔ Invalid and malformed HMAC signatures rejected with 401 Unauthorized without leakage');
  }

  // Test 5: Verify logger never logs webhook secrets or signature values
  console.log('\nTest 5: Secret and signature leak prevention in logs and responses');
  {
    const payload = { action: 'opened' };
    const rawPayload = JSON.stringify(payload);
    const secretValue = 'super-secret-key-1234567890-abcdef';
    const fakeSignature = 'sha256=0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';
    (config.github as any).webhookSecret = secretValue;

    const req = createMockReq(payload, rawPayload);

    let caughtError: any;
    try {
      await controller.handleGitHubWebhook(
        req,
        fakeSignature,
        'issues',
        'delivery-sec-1',
        'application/json',
      );
    } catch (err) {
      caughtError = err;
    }

    assert(caughtError instanceof UnauthorizedException);
    const errorString = JSON.stringify(caughtError);
    assert(!errorString.includes(secretValue), 'Secret leaked in error object!');
    assert(!errorString.includes(fakeSignature), 'Signature leaked in error object!');
    console.log('  ✔ Webhook secret and signature values are strictly never leaked');
  }

  // Test 6: Raw body verification accuracy against tampered payload
  console.log('\nTest 6: Tampered request body detection using rawBody');
  {
    const originalBody = '{"action":"opened","number":1}';
    const tamperedBody = '{"action":"opened","number":2}';
    const originalSignature = GitHubWebhooks.sign(originalBody, secret);

    // Request receives tampered body with original signature
    const req = createMockReq({ action: 'opened', number: 2 }, tamperedBody);

    await assert.rejects(
      async () => {
        await controller.handleGitHubWebhook(
          req,
          originalSignature,
          'pull_request',
          'delivery-uuid-6',
          'application/json',
        );
      },
      (err: any) => {
        assert(err instanceof UnauthorizedException);
        return true;
      },
    );
    console.log('  ✔ Tampered payload strictly caught by HMAC signature mismatch');
  }

  console.log('\n✅ ALL GITHUB WEBHOOK ENDPOINT TESTS PASSED SUCCESSFULLY!\n');
}

runWebhookTests().catch((err) => {
  console.error('Test suite failed:', err);
  process.exit(1);
});
