import * as assert from 'node:assert';
import { ExecutionContext, UnauthorizedException, ForbiddenException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { AuthService } from './auth.service';
import { JwtAuthGuard, RolesGuard } from './guards';
import { IS_PUBLIC_KEY, ROLES_KEY } from './decorators/auth.decorators';

function createMockContext(headers: Record<string, string> = {}, handlerMetadata?: any, classMetadata?: any): ExecutionContext {
  const req: any = {
    headers,
    user: undefined,
  };

  return {
    switchToHttp: () => ({
      getRequest: () => req,
      getResponse: () => ({}),
      getNext: () => () => {},
    }),
    getHandler: () => handlerMetadata || (() => {}),
    getClass: () => classMetadata || class TestController {},
  } as unknown as ExecutionContext;
}

async function runTests() {
  console.log('--- Running Authentication & Authorization Guard Tests ---');

  const authService = new AuthService();
  const reflector = new Reflector();

  // Test 1: AuthService generates and verifies JWT access token
  console.log('Test 1: AuthService token generation and verification');
  {
    const payload = {
      sub: 'usr_test_123',
      email: 'dev@devpulse.local',
      role: 'ADMIN' as const,
      sessionId: 'sess_abc_1',
    };

    const token = authService.generateAccessToken(payload);
    assert.strictEqual(typeof token, 'string');

    const decoded = authService.verifyAccessToken(token);
    assert.strictEqual(decoded.sub, payload.sub);
    assert.strictEqual(decoded.email, payload.email);
    assert.strictEqual(decoded.role, payload.role);
    assert.strictEqual(decoded.sessionId, payload.sessionId);
    console.log('  ✓ Token generation and verification passed');
  }

  // Test 2: AuthService refresh token generation and hashing
  console.log('Test 2: Refresh token generation and SHA-256 hash');
  {
    const { token, hash } = authService.generateRefreshToken();
    assert.strictEqual(typeof token, 'string');
    assert.strictEqual(typeof hash, 'string');
    assert.strictEqual(hash, authService.hashToken(token));
    console.log('  ✓ Refresh token hashing passed');
  }

  // Test 3: JwtAuthGuard allows public routes
  console.log('Test 3: JwtAuthGuard allows public route without token');
  {
    const publicReflector = {
      getAllAndOverride: (key: string) => (key === IS_PUBLIC_KEY ? true : undefined),
    } as unknown as Reflector;

    const guard = new JwtAuthGuard(publicReflector, authService);
    const context = createMockContext({});
    const canActivate = await guard.canActivate(context);
    assert.strictEqual(canActivate, true);
    console.log('  ✓ Public route allowed');
  }

  // Test 4: JwtAuthGuard rejects missing Bearer token on private route
  console.log('Test 4: JwtAuthGuard rejects missing token on private route');
  {
    const privateReflector = {
      getAllAndOverride: () => undefined,
    } as unknown as Reflector;

    const guard = new JwtAuthGuard(privateReflector, authService);
    const context = createMockContext({});

    await assert.rejects(
      async () => {
        await guard.canActivate(context);
      },
      (err: any) => {
        assert.ok(err instanceof UnauthorizedException);
        assert.strictEqual(err.message, 'Authentication token missing');
        return true;
      },
    );
    console.log('  ✓ Missing token rejected with 401 Unauthorized');
  }

  // Test 5: JwtAuthGuard verifies valid Bearer token and attaches user to request
  console.log('Test 5: JwtAuthGuard attaches user payload for valid token');
  {
    const privateReflector = {
      getAllAndOverride: () => undefined,
    } as unknown as Reflector;

    const guard = new JwtAuthGuard(privateReflector, authService);
    const token = authService.generateAccessToken({
      sub: 'usr_dev_456',
      email: 'lead@devpulse.local',
      role: 'MEMBER',
    });

    const context = createMockContext({
      authorization: `Bearer ${token}`,
    });

    const canActivate = await guard.canActivate(context);
    assert.strictEqual(canActivate, true);

    const req = context.switchToHttp().getRequest();
    assert.strictEqual(req.user.sub, 'usr_dev_456');
    assert.strictEqual(req.user.email, 'lead@devpulse.local');
    assert.strictEqual(req.user.role, 'MEMBER');
    console.log('  ✓ User authenticated and attached to request context');
  }

  // Test 6: RolesGuard allows authorized role
  console.log('Test 6: RolesGuard allows matching role');
  {
    const rolesReflector = {
      getAllAndOverride: (key: string) => (key === ROLES_KEY ? ['ADMIN'] : undefined),
    } as unknown as Reflector;

    const rolesGuard = new RolesGuard(rolesReflector);
    const context = createMockContext();
    const req = context.switchToHttp().getRequest();
    req.user = { sub: 'usr_admin', email: 'admin@devpulse.local', role: 'ADMIN' };

    const allowed = rolesGuard.canActivate(context);
    assert.strictEqual(allowed, true);
    console.log('  ✓ ADMIN role successfully allowed');
  }

  // Test 7: RolesGuard denies unauthorized role
  console.log('Test 7: RolesGuard denies insufficient role');
  {
    const rolesReflector = {
      getAllAndOverride: (key: string) => (key === ROLES_KEY ? ['ADMIN'] : undefined),
    } as unknown as Reflector;

    const rolesGuard = new RolesGuard(rolesReflector);
    const context = createMockContext();
    const req = context.switchToHttp().getRequest();
    req.user = { sub: 'usr_viewer', email: 'viewer@devpulse.local', role: 'VIEWER' };

    assert.throws(
      () => {
        rolesGuard.canActivate(context);
      },
      (err: any) => {
        assert.ok(err instanceof ForbiddenException);
        assert.ok(err.message.includes('required role is [ADMIN], current role is [VIEWER]'));
        return true;
      },
    );
    console.log('  ✓ Non-admin role rejected with 403 Forbidden');
  }

  console.log('\n✅ ALL AUTHENTICATION & GUARD TESTS PASSED!');
}

runTests().catch((err) => {
  console.error('❌ Auth tests failed:', err);
  process.exit(1);
});
