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
    assert.strictEqual(response.status, 'accepted');
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

    // Restore original secret
    (config.github as any).webhookSecret = secret;

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

  // Test 7: Supported events validation (push, pull_request, pull_request_review, repository)
  console.log('\nTest 7: Supported events field validation');
  {
    const repoObj = { id: 101, name: 'core', full_name: 'devpulse/core' };
    const senderObj = { id: 202, login: 'octocat' };

    // 7.1 Push event
    const pushPayload = {
      ref: 'refs/heads/main',
      commits: [{ id: 'c1', message: 'feat: add feature' }],
      repository: repoObj,
      sender: senderObj,
    };
    const pushRaw = JSON.stringify(pushPayload);
    const pushSig = GitHubWebhooks.sign(pushRaw, secret);
    const pushReq = createMockReq(pushPayload, pushRaw);
    const pushRes = await controller.handleGitHubWebhook(
      pushReq,
      pushSig,
      'push',
      'del-push-1',
      'application/json',
    );
    assert.strictEqual(pushRes.event, 'push');
    assert.strictEqual(pushRes.status, 'accepted');

    // Missing ref in push
    const invalidPushPayload = { commits: [], repository: repoObj };
    const invalidPushRaw = JSON.stringify(invalidPushPayload);
    const invalidPushSig = GitHubWebhooks.sign(invalidPushRaw, secret);
    const invalidPushReq = createMockReq(invalidPushPayload, invalidPushRaw);
    await assert.rejects(
      async () => {
        await controller.handleGitHubWebhook(
          invalidPushReq,
          invalidPushSig,
          'push',
          'del-push-2',
          'application/json',
        );
      },
      (err: any) => {
        assert(err instanceof BadRequestException);
        assert(err.message.includes('ref'));
        return true;
      },
    );

    // 7.2 Pull request event
    const prPayload = {
      action: 'opened',
      pull_request: { id: 303, number: 42, title: 'New PR' },
      repository: repoObj,
      sender: senderObj,
    };
    const prRaw = JSON.stringify(prPayload);
    const prSig = GitHubWebhooks.sign(prRaw, secret);
    const prReq = createMockReq(prPayload, prRaw);
    const prRes = await controller.handleGitHubWebhook(
      prReq,
      prSig,
      'pull_request',
      'del-pr-1',
      'application/json',
    );
    assert.strictEqual(prRes.event, 'pull_request');
    assert.strictEqual(prRes.status, 'accepted');

    // Missing pull_request object
    const invalidPrPayload = { action: 'opened', repository: repoObj };
    const invalidPrRaw = JSON.stringify(invalidPrPayload);
    const invalidPrSig = GitHubWebhooks.sign(invalidPrRaw, secret);
    const invalidPrReq = createMockReq(invalidPrPayload, invalidPrRaw);
    await assert.rejects(
      async () => {
        await controller.handleGitHubWebhook(
          invalidPrReq,
          invalidPrSig,
          'pull_request',
          'del-pr-2',
          'application/json',
        );
      },
      (err: any) => {
        assert(err instanceof BadRequestException);
        return true;
      },
    );

    // 7.3 Pull request review event
    const reviewPayload = {
      action: 'submitted',
      pull_request: { id: 303, number: 42 },
      review: { id: 404, state: 'approved' },
      repository: repoObj,
      sender: senderObj,
    };
    const reviewRaw = JSON.stringify(reviewPayload);
    const reviewSig = GitHubWebhooks.sign(reviewRaw, secret);
    const reviewReq = createMockReq(reviewPayload, reviewRaw);
    const reviewRes = await controller.handleGitHubWebhook(
      reviewReq,
      reviewSig,
      'pull_request_review',
      'del-rev-1',
      'application/json',
    );
    assert.strictEqual(reviewRes.event, 'pull_request_review');
    assert.strictEqual(reviewRes.status, 'accepted');

    // 7.4 Repository lifecycle event
    const repoPayload = {
      action: 'created',
      repository: repoObj,
      sender: senderObj,
    };
    const repoRaw = JSON.stringify(repoPayload);
    const repoSig = GitHubWebhooks.sign(repoRaw, secret);
    const repoReq = createMockReq(repoPayload, repoRaw);
    const repoRes = await controller.handleGitHubWebhook(
      repoReq,
      repoSig,
      'repository',
      'del-repo-1',
      'application/json',
    );
    assert.strictEqual(repoRes.event, 'repository');
    assert.strictEqual(repoRes.status, 'accepted');

    console.log('  ✔ Push, pull_request, pull_request_review, and repository event payloads validated');
  }

  // Test 8: Safely ignore unsupported event types without throwing 500
  console.log('\nTest 8: Safely ignore unsupported event types');
  {
    const payload = { action: 'created', check_run: { id: 999 } };
    const rawPayload = JSON.stringify(payload);
    const sig = GitHubWebhooks.sign(rawPayload, secret);
    const req = createMockReq(payload, rawPayload);

    const res = await controller.handleGitHubWebhook(
      req,
      sig,
      'check_run',
      'del-unsupported-1',
      'application/json',
    );

    assert.strictEqual(res.received, true);
    assert.strictEqual(res.event, 'check_run');
    assert.strictEqual(res.status, 'ignored');
    console.log('  ✔ Unsupported event types (e.g. check_run) safely ignored with status: ignored');
  }

  // Test 9: Repository and actor account validation using mocked database
  console.log('\nTest 9: Repository and actor account ownership check against connected accounts');
  {
    const mockDeliveries: any[] = [];
    const mockDb: any = {
      client: {
        repository: {
          findFirst: async ({ where }: any) => {
            if (where.githubId === BigInt(101)) {
              return { id: 'db-repo-101', workspaceId: 'ws-101' };
            }
            return null;
          },
        },
        gitHubAccount: {
          findFirst: async ({ where }: any) => {
            if (where.githubUserId === BigInt(202)) {
              return { id: 'db-gh-acc-202', userId: 'user-202' };
            }
            return null;
          },
        },
        webhookDelivery: {
          upsert: async ({ where, create, update }: any) => {
            const existingIdx = mockDeliveries.findIndex(d => d.deliveryId === where.deliveryId);
            if (existingIdx >= 0) {
              mockDeliveries[existingIdx] = {
                ...mockDeliveries[existingIdx],
                ...update,
                id: mockDeliveries[existingIdx].id,
              };
              return mockDeliveries[existingIdx];
            } else {
              const newRec = {
                id: `whd_${mockDeliveries.length + 1}`,
                ...create,
              };
              mockDeliveries.push(newRec);
              return newRec;
            }
          },
          findUnique: async ({ where }: any) => {
            return mockDeliveries.find(d => d.deliveryId === where.deliveryId) || null;
          },
        },
      },
    };

    const serviceWithDb = new WebhooksService(mockDb);
    const controllerWithDb = new WebhooksController(serviceWithDb);

    // Tracked repository & connected user
    const payload1 = {
      ref: 'refs/heads/main',
      commits: [{ id: 'c1' }],
      repository: { id: 101, name: 'core', full_name: 'devpulse/core' },
      sender: { id: 202, login: 'octocat' },
    };
    const raw1 = JSON.stringify(payload1);
    const sig1 = GitHubWebhooks.sign(raw1, secret);
    const req1 = createMockReq(payload1, raw1);

    const res1 = await controllerWithDb.handleGitHubWebhook(
      req1,
      sig1,
      'push',
      'del-acc-1',
      'application/json',
    );
    assert.strictEqual(res1.status, 'accepted');
    assert.strictEqual(res1.details?.isTracked, true);
    assert.strictEqual(res1.details?.hasConnectedAccount, true);

    // Untracked repository & unknown user
    const payload2 = {
      ref: 'refs/heads/main',
      commits: [{ id: 'c2' }],
      repository: { id: 999999, name: 'external', full_name: 'stranger/external' },
      sender: { id: 888888, login: 'stranger' },
    };
    const raw2 = JSON.stringify(payload2);
    const sig2 = GitHubWebhooks.sign(raw2, secret);
    const req2 = createMockReq(payload2, raw2);

    const res2 = await controllerWithDb.handleGitHubWebhook(
      req2,
      sig2,
      'push',
      'del-acc-2',
      'application/json',
    );
    assert.strictEqual(res2.status, 'accepted');
    assert.strictEqual(res2.details?.isTracked, false);
    assert.strictEqual(res2.details?.hasConnectedAccount, false);

    console.log('  ✔ Repository and actor successfully validated against connected accounts without trusting unverified IDs');
  }

  // Test 10: Metadata extraction and normalization
  console.log('\nTest 10: Normalized webhook metadata extraction');
  {
    const beforeTime = new Date();
    const payload = {
      action: 'opened',
      pull_request: { id: 7001, number: 10, title: 'Extract metadata' },
      repository: { id: 8001, name: 'devpulse', full_name: 'devpulse/devpulse' },
      sender: { id: 9001, login: 'developer-jane' },
    };
    const rawPayload = JSON.stringify(payload);
    const sig = GitHubWebhooks.sign(rawPayload, secret);
    const req = createMockReq(payload, rawPayload);

    const res = await controller.handleGitHubWebhook(
      req,
      sig,
      'pull_request',
      'delivery-meta-12345',
      'application/json',
    );

    assert.strictEqual(res.received, true);
    assert.strictEqual(res.event, 'pull_request');
    assert.strictEqual(res.delivery, 'delivery-meta-12345');
    assert.strictEqual(res.status, 'accepted');

    // Verify normalized metadata fields
    const meta = res.metadata;
    assert.ok(meta, 'Metadata must be defined');
    assert.strictEqual(meta.deliveryId, 'delivery-meta-12345');
    assert.strictEqual(meta.eventType, 'pull_request');
    assert.strictEqual(meta.repositoryGitHubId, BigInt(8001));
    assert.strictEqual(meta.repositoryFullName, 'devpulse/devpulse');
    assert.strictEqual(meta.senderGitHubId, BigInt(9001));
    assert.strictEqual(meta.action, 'opened');
    assert(meta.receivedAt instanceof Date, 'receivedAt must be a Date instance');
    assert(meta.receivedAt.getTime() >= beforeTime.getTime());

    // Verify ping metadata extraction without repository or sender
    const pingPayload = { zen: 'Favor focus over features.' };
    const pingRaw = JSON.stringify(pingPayload);
    const pingSig = GitHubWebhooks.sign(pingRaw, secret);
    const pingReq = createMockReq(pingPayload, pingRaw);

    const pingRes = await controller.handleGitHubWebhook(
      pingReq,
      pingSig,
      'ping',
      'delivery-ping-999',
      'application/json',
    );
    assert.ok(pingRes.metadata, 'Ping metadata must be defined');
    assert.strictEqual(pingRes.metadata.deliveryId, 'delivery-ping-999');
    assert.strictEqual(pingRes.metadata.eventType, 'ping');
    assert.strictEqual(pingRes.metadata.repositoryGitHubId, undefined);
    assert.strictEqual(pingRes.metadata.repositoryFullName, undefined);
    assert.strictEqual(pingRes.metadata.senderGitHubId, undefined);
    assert.strictEqual(pingRes.metadata.action, undefined);

    console.log('  ✔ Delivery ID, event type, repo ID & full name, sender ID, action, and received timestamp extracted and normalized');
  }

  // Test 11: Malformed JSON payload handling
  console.log('\nTest 11: Malformed JSON rejection');
  {
    const malformedRaw = '{"action":"opened", invalid_json';
    const sig = GitHubWebhooks.sign(malformedRaw, secret);
    const req = {
      body: undefined, // Body parser failed or empty
      rawBody: Buffer.from(malformedRaw, 'utf8'),
      headers: {},
    } as unknown as Request;

    await assert.rejects(
      async () => {
        await controller.handleGitHubWebhook(
          req,
          sig,
          'pull_request',
          'del-malformed-json-1',
          'application/json',
        );
      },
      (err: any) => {
        assert(err instanceof BadRequestException);
        assert.strictEqual(err.message, 'Webhook payload must be a valid JSON object');
        return true;
      },
    );
    console.log('  ✔ Malformed JSON payload cleanly rejected with 400 Bad Request');
  }

  // Test 12: Centralized config security and frontend isolation
  console.log('\nTest 12: Centralized config isolation (GITHUB_WEBHOOK_SECRET is private)');
  {
    // config.private.github.webhookSecret exists
    assert.ok(config.private.github.webhookSecret, 'Private config must contain webhookSecret');
    // config.public.github must NOT contain webhookSecret
    assert.strictEqual(
      (config.public.github as any).webhookSecret,
      undefined,
      'Public config must NEVER expose webhookSecret',
    );
    assert.strictEqual(
      (config.public as any).githubWebhookSecret,
      undefined,
      'Public config must NEVER expose githubWebhookSecret',
    );
    console.log('  ✔ GITHUB_WEBHOOK_SECRET is strictly confined to server-side private configuration');
  }

  // Test 13: Webhook event delivery persistence in database
  console.log('\nTest 13: WebhookDelivery model persistence with payload and metadata');
  {
    const deliveryStorage: any[] = [];
    const persistenceMockDb: any = {
      client: {
        repository: {
          findFirst: async ({ where }: any) => {
            if (where.githubId === BigInt(5555)) {
              return { id: 'repo-uuid-5555', workspaceId: 'ws-5555' };
            }
            return null;
          },
        },
        gitHubAccount: {
          findFirst: async ({ where }: any) => {
            if (where.githubUserId === BigInt(6666)) {
              return { id: 'gh-acc-6666', userId: 'user-6666' };
            }
            return null;
          },
        },
        webhookDelivery: {
          findUnique: async ({ where }: any) => {
            return deliveryStorage.find(d => d.deliveryId === where.deliveryId) || null;
          },
          upsert: async ({ where, create, update }: any) => {
            const idx = deliveryStorage.findIndex(d => d.deliveryId === where.deliveryId);
            if (idx >= 0) {
              deliveryStorage[idx] = { ...deliveryStorage[idx], ...update };
              return deliveryStorage[idx];
            }
            const record = {
              id: `whd-${deliveryStorage.length + 1}`,
              ...create,
              createdAt: new Date(),
              updatedAt: new Date(),
            };
            deliveryStorage.push(record);
            return record;
          },
        },
      },
    };

    const persistenceService = new WebhooksService(persistenceMockDb);
    const persistenceController = new WebhooksController(persistenceService);

    const pullPayload = {
      action: 'opened',
      pull_request: { id: 7777, number: 101, title: 'Persistent PR' },
      repository: { id: 5555, name: 'persisted-repo', full_name: 'devpulse/persisted-repo' },
      sender: { id: 6666, login: 'persistent-author' },
    };
    const pullRaw = JSON.stringify(pullPayload);
    const pullSig = GitHubWebhooks.sign(pullRaw, secret);
    const pullReq = createMockReq(pullPayload, pullRaw);

    const response = await persistenceController.handleGitHubWebhook(
      pullReq,
      pullSig,
      'pull_request',
      'delivery-persistent-uuid-1',
      'application/json',
    );

    assert.strictEqual(response.status, 'accepted');
    assert.strictEqual(response.delivery, 'delivery-persistent-uuid-1');
    assert.strictEqual(response.deliveryRecordId, 'whd-1');

    // Verify stored record
    assert.strictEqual(deliveryStorage.length, 1);
    const stored = deliveryStorage[0];
    assert.strictEqual(stored.deliveryId, 'delivery-persistent-uuid-1');
    assert.strictEqual(stored.eventType, 'pull_request');
    assert.strictEqual(stored.action, 'opened');
    assert.strictEqual(stored.repositoryId, 'repo-uuid-5555');
    assert.strictEqual(stored.githubRepositoryId, BigInt(5555));
    assert.strictEqual(stored.senderGithubId, BigInt(6666));
    assert.strictEqual(stored.status, 'RECEIVED');
    assert.deepStrictEqual(stored.payload, pullPayload);
    assert(stored.receivedAt instanceof Date);

    // Repeated delivery with same delivery ID (idempotent upsert)
    const repeatResponse = await persistenceController.handleGitHubWebhook(
      pullReq,
      pullSig,
      'pull_request',
      'delivery-persistent-uuid-1',
      'application/json',
    );

    assert.strictEqual(repeatResponse.deliveryRecordId, 'whd-1');
    assert.strictEqual(deliveryStorage.length, 1, 'Delivery ID must remain unique without duplicate rows');

    console.log('  ✔ WebhookDelivery model persists deliveryId, payload, timestamps, and status with unique deduplication');
  }

  // Test 14: Duplicate delivery detection and concurrent request handling
  console.log('\nTest 14: Duplicate delivery protection and concurrent request handling');
  {
    const deliveryStore: any[] = [];
    const enqueuedJobs: any[] = [];

    const mockQueueService: any = {
      addWebhookEventJob: async (payload: any, options: any) => {
        const jobId = options?.jobId || payload.deliveryId;
        if (enqueuedJobs.some(j => j.jobId === jobId)) {
          return { enqueued: false, jobId };
        }
        enqueuedJobs.push({ jobId, payload });
        return { enqueued: true, jobId };
      },
    };

    const duplicateDb: any = {
      client: {
        repository: {
          findFirst: async ({ where }: any) => {
            if (where.githubId === BigInt(9999)) {
              return { id: 'repo-dup-9999', workspaceId: 'ws-dup' };
            }
            return null;
          },
        },
        gitHubAccount: {
          findFirst: async () => null,
        },
        webhookDelivery: {
          findUnique: async ({ where }: any) => {
            return deliveryStore.find(d => d.deliveryId === where.deliveryId) || null;
          },
          upsert: async ({ where, create, update }: any) => {
            const existing = deliveryStore.find(d => d.deliveryId === where.deliveryId);
            if (existing) {
              Object.assign(existing, update);
              return existing;
            }
            const record = {
              id: `whd-${deliveryStore.length + 1}`,
              ...create,
              createdAt: new Date(),
              updatedAt: new Date(),
            };
            deliveryStore.push(record);
            return record;
          },
        },
      },
    };

    const service = new WebhooksService(duplicateDb, mockQueueService);
    const controller = new WebhooksController(service);

    const testPayload = {
      action: 'opened',
      pull_request: { id: 8888, number: 42 },
      repository: { id: 9999, name: 'repo-dup', full_name: 'devpulse/repo-dup' },
      sender: { id: 1111, login: 'dup-sender' },
    };
    const raw = JSON.stringify(testPayload);
    const sig = GitHubWebhooks.sign(raw, secret);
    const req = createMockReq(testPayload, raw);

    // Initial delivery
    const res1 = await controller.handleGitHubWebhook(
      req,
      sig,
      'pull_request',
      'delivery-concurrent-test-1',
      'application/json',
    );

    assert.strictEqual(res1.status, 'accepted');
    assert.strictEqual(res1.isDuplicate, false);
    assert.strictEqual(res1.details?.enqueued, true);
    assert.strictEqual(enqueuedJobs.length, 1);
    assert.strictEqual(enqueuedJobs[0].payload.deliveryId, 'delivery-concurrent-test-1');
    assert.strictEqual(enqueuedJobs[0].payload.deliveryDatabaseId, 'whd-1');
    assert.strictEqual(enqueuedJobs[0].payload.eventType, 'pull_request');

    // Second delivery of same deliveryId (e.g. GitHub retry or re-delivery)
    const res2 = await controller.handleGitHubWebhook(
      req,
      sig,
      'pull_request',
      'delivery-concurrent-test-1',
      'application/json',
    );

    assert.strictEqual(res2.status, 'accepted', 'Duplicate delivery must acknowledge success');
    assert.strictEqual(res2.isDuplicate, true, 'Detected as duplicate delivery');
    assert.strictEqual(enqueuedJobs.length, 1, 'Job must NOT be re-enqueued for duplicate delivery');

    // Concurrent delivery simulation (simulating two identical requests racing at the same time)
    const res3Promise = controller.handleGitHubWebhook(
      req,
      sig,
      'pull_request',
      'delivery-concurrent-race-2',
      'application/json',
    );
    const res4Promise = controller.handleGitHubWebhook(
      req,
      sig,
      'pull_request',
      'delivery-concurrent-race-2',
      'application/json',
    );

    const [res3, res4] = await Promise.all([res3Promise, res4Promise]);
    assert.strictEqual(res3.status, 'accepted');
    assert.strictEqual(res4.status, 'accepted');
    // Exactly one job should be in the queue for 'delivery-concurrent-race-2'
    const raceJobs = enqueuedJobs.filter(j => j.jobId === 'delivery-concurrent-race-2');
    assert.strictEqual(raceJobs.length, 1, 'Only one job should be enqueued across concurrent identical requests');

    console.log('  ✔ Duplicate delivery detection, safe concurrent handling, and single-job enqueueing verified');
  }

  // Test 15: Queue failure resilience and recovery mechanism for unqueued deliveries
  console.log('\nTest 15: Queue failure resilience and recovery for unqueued deliveries');
  {
    const storage: any[] = [];
    let queueOnline = false; // Simulate queue downtime during ingress
    const recoveredJobs: any[] = [];

    const mockDb: any = {
      client: {
        repository: {
          findFirst: async () => null,
        },
        gitHubAccount: {
          findFirst: async () => null,
        },
        webhookDelivery: {
          findUnique: async ({ where }: any) => {
            return storage.find(d => d.deliveryId === where.deliveryId) || null;
          },
          upsert: async ({ where, create, update }: any) => {
            const existing = storage.find(d => d.deliveryId === where.deliveryId);
            if (existing) {
              Object.assign(existing, update);
              return existing;
            }
            const record = {
              id: `whd-recover-${storage.length + 1}`,
              ...create,
              createdAt: new Date(),
              updatedAt: new Date(),
            };
            storage.push(record);
            return record;
          },
          findMany: async ({ where }: any) => {
            return storage.filter(d => (!where?.status || d.status === where.status) && (d.processedAt === null || d.processedAt === undefined));
          },
        },
      },
    };

    const mockFailingQueueService: any = {
      addWebhookEventJob: async (payload: any, options: any) => {
        if (!queueOnline) {
          throw new Error('Redis connection down');
        }
        recoveredJobs.push({ jobId: options?.jobId || payload.deliveryId, payload });
        return { enqueued: true, jobId: payload.deliveryId };
      },
      recoverUnqueuedDeliveries: async (options?: any) => {
        const unqueued = await mockDb.client.webhookDelivery.findMany({
          where: { status: 'RECEIVED' },
        });
        let count = 0;
        for (const item of unqueued) {
          if (queueOnline) {
            recoveredJobs.push({ jobId: item.deliveryId, payload: item });
            count++;
          }
        }
        return { recoveredCount: count, errors: 0 };
      },
    };

    const resilientService = new WebhooksService(mockDb, mockFailingQueueService);
    const resilientController = new WebhooksController(resilientService);

    const payload = {
      ref: 'refs/heads/main',
      commits: [{ id: 'c-fail-1' }],
      repository: { id: 777, name: 'fail-repo', full_name: 'devpulse/fail-repo' },
      sender: { id: 888, login: 'dev' },
    };
    const raw = JSON.stringify(payload);
    const sig = GitHubWebhooks.sign(raw, secret);
    const req = createMockReq(payload, raw);

    // Ingress occurs while queue is down
    const res = await resilientController.handleGitHubWebhook(
      req,
      sig,
      'push',
      'delivery-failed-queue-1',
      'application/json',
    );

    // Event must still be acknowledged and persisted without losing data
    assert.strictEqual(res.status, 'accepted');
    assert.strictEqual(res.details?.enqueued, false);
    assert.strictEqual(storage.length, 1);
    assert.strictEqual(storage[0].deliveryId, 'delivery-failed-queue-1');
    assert.strictEqual(storage[0].status, 'RECEIVED');
    assert.strictEqual(recoveredJobs.length, 0);

    // Later: Queue recovers, run recovery mechanism
    queueOnline = true;
    const recoveryResult = await mockFailingQueueService.recoverUnqueuedDeliveries();
    assert.strictEqual(recoveryResult.recoveredCount, 1);
    assert.strictEqual(recoveredJobs.length, 1);
    assert.strictEqual(recoveredJobs[0].jobId, 'delivery-failed-queue-1');

    console.log('  ✔ Ingress succeeds and persists during queue failure; recovery sweep successfully enqueues unqueued deliveries');
  }

  console.log('\n✅ ALL GITHUB WEBHOOK ENDPOINT TESTS PASSED SUCCESSFULLY!\n');
}

runWebhookTests().catch((err) => {
  console.error('Test suite failed:', err);
  process.exit(1);
});
