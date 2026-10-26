import * as assert from 'node:assert';
import { ExecutionContext, HttpStatus } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { ApiErrorCode } from '@devpulse/types';
import { AuthService } from './auth.service';
import { JwtAuthGuard, RolesGuard } from './guards';
import { IS_PUBLIC_KEY, ROLES_KEY } from './decorators/auth.decorators';
import { AuthenticationException, AuthorizationException } from '../common/errors';
import { GlobalExceptionFilter } from '../common/filters/global-exception.filter';

function createMockHost(req: any = {}, res: any = {}) {
  let statusCode = 200;
  let responseData: any = null;
  const headers: Record<string, string> = {};

  const mockResponse = {
    status: (code: number) => {
      statusCode = code;
      return mockResponse;
    },
    json: (data: any) => {
      responseData = data;
      return mockResponse;
    },
    setHeader: (name: string, value: string) => {
      headers[name.toLowerCase()] = value;
      return mockResponse;
    },
    getHeader: (name: string) => headers[name.toLowerCase()],
    ...res,
  };

  const mockRequest = {
    method: 'GET',
    url: '/api/v1/auth/me',
    headers: {},
    ...req,
  };

  const host = {
    switchToHttp: () => ({
      getResponse: () => mockResponse,
      getRequest: () => mockRequest,
      getNext: () => () => {},
    }),
    getType: () => 'http',
    getArgs: () => [mockRequest, mockResponse],
    getArgByIndex: (index: number) => (index === 0 ? mockRequest : mockResponse),
    switchToRpc: () => ({} as any),
    switchToWs: () => ({} as any),
  };

  return {
    host,
    getResponseData: () => responseData,
    getStatusCode: () => statusCode,
    getHeaders: () => headers,
  };
}

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
  const filter = new GlobalExceptionFilter(undefined, true);

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

  // Test 4: JwtAuthGuard rejects missing Bearer token on private route with AuthenticationException
  console.log('Test 4: JwtAuthGuard rejects unauthenticated request with consistent 401 error structure');
  {
    const privateReflector = {
      getAllAndOverride: () => undefined,
    } as unknown as Reflector;

    const guard = new JwtAuthGuard(privateReflector, authService);
    const context = createMockContext({});

    let caughtError: any;
    try {
      await guard.canActivate(context);
    } catch (err) {
      caughtError = err;
    }

    assert.ok(caughtError instanceof AuthenticationException);
    assert.strictEqual(caughtError.message, 'Authentication token missing');
    assert.strictEqual(caughtError.code, ApiErrorCode.UNAUTHORIZED);

    // Verify response shape through GlobalExceptionFilter
    const mock = createMockHost({ headers: { 'x-request-id': 'req_unauth_test' } });
    filter.catch(caughtError, mock.host as any);

    assert.strictEqual(mock.getStatusCode(), HttpStatus.UNAUTHORIZED);
    assert.deepStrictEqual(mock.getResponseData(), {
      success: false,
      error: {
        code: ApiErrorCode.UNAUTHORIZED,
        message: 'Authentication token missing',
      },
      requestId: 'req_unauth_test',
    });
    console.log('  ✓ Unauthenticated request rejected with canonical 401 response payload');
  }

  // Test 5: JwtAuthGuard verifies valid Bearer token and attaches user to request
  console.log('Test 5: JwtAuthGuard authorizes authenticated request with valid JWT');
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
    console.log('  ✓ Authenticated request passes and context has user info');
  }

  // Test 6: RolesGuard allows authorized role
  console.log('Test 6: RolesGuard allows matching role for authenticated request');
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

  // Test 7: RolesGuard denies unauthorized role with AuthorizationException
  console.log('Test 7: RolesGuard rejects forbidden role with canonical 403 error structure');
  {
    const rolesReflector = {
      getAllAndOverride: (key: string) => (key === ROLES_KEY ? ['ADMIN'] : undefined),
    } as unknown as Reflector;

    const rolesGuard = new RolesGuard(rolesReflector);
    const context = createMockContext();
    const req = context.switchToHttp().getRequest();
    req.user = { sub: 'usr_viewer', email: 'viewer@devpulse.local', role: 'VIEWER' };

    let caughtError: any;
    try {
      rolesGuard.canActivate(context);
    } catch (err) {
      caughtError = err;
    }

    assert.ok(caughtError instanceof AuthorizationException);
    assert.strictEqual(caughtError.code, ApiErrorCode.FORBIDDEN);
    assert.ok(caughtError.message.includes('required role is [ADMIN], current role is [VIEWER]'));

    // Verify response shape through GlobalExceptionFilter
    const mock = createMockHost({ headers: { 'x-request-id': 'req_forbid_test' } });
    filter.catch(caughtError, mock.host as any);

    assert.strictEqual(mock.getStatusCode(), HttpStatus.FORBIDDEN);
    assert.deepStrictEqual(mock.getResponseData(), {
      success: false,
      error: {
        code: ApiErrorCode.FORBIDDEN,
        message: 'Access denied: required role is [ADMIN], current role is [VIEWER]',
      },
      requestId: 'req_forbid_test',
    });
    console.log('  ✓ Forbidden request rejected with canonical 403 response payload');
  }

  console.log('\n✅ ALL AUTHENTICATION & GUARD TESTS PASSED!');
}

runTests().catch((err) => {
  console.error('❌ Auth tests failed:', err);
  process.exit(1);
});

