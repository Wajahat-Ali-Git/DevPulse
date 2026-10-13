import * as assert from 'node:assert';
import {
  BadRequestException,
  NotFoundException,
  UnauthorizedException,
  ForbiddenException,
  ConflictException as NestConflictException,
  HttpStatus,
  ArgumentsHost,
} from '@nestjs/common';
import { ApiErrorCode } from '@devpulse/types';
import { CorrelationContext, Logger } from '@devpulse/logger';
import { GlobalExceptionFilter } from './global-exception.filter';
import {
  AppException,
  ValidationException,
  ResourceNotFoundException,
  AuthenticationException,
  AuthorizationException,
  ConflictException,
  DatabaseException,
} from '../errors';

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
    url: '/api/v1/test',
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
  } as unknown as ArgumentsHost;

  return {
    host,
    getResponseData: () => responseData,
    getStatusCode: () => statusCode,
    getHeaders: () => headers,
  };
}

// Silent logger for testing to prevent noisy test output
const testLogger = new Logger({ level: 'fatal', format: 'pretty' });

async function runTests() {
  console.log('--- Running Global API Error Handling Test Suite ---');

  // Test 1: Standard NotFoundException matching exact requirement example
  console.log('Test 1: Standard NotFoundException matching exact specification');
  {
    const filter = new GlobalExceptionFilter(testLogger, true);
    const mock = createMockHost({
      headers: { 'x-request-id': 'req_123' },
    });

    const notFoundEx = new NotFoundException('Repository not found');
    filter.catch(notFoundEx, mock.host);

    assert.strictEqual(mock.getStatusCode(), HttpStatus.NOT_FOUND);
    const body = mock.getResponseData();
    assert.deepStrictEqual(body, {
      success: false,
      error: {
        code: ApiErrorCode.RESOURCE_NOT_FOUND,
        message: 'Repository not found',
      },
      requestId: 'req_123',
    });
    assert.strictEqual(mock.getHeaders()['x-request-id'], 'req_123');
    console.log('  ✓ Exact match with specification example passed');
  }

  // Test 2: Authentication Error (401 Unauthorized)
  console.log('Test 2: Authentication Error Handling (401)');
  {
    const filter = new GlobalExceptionFilter(testLogger, true);

    // Standard NestJS UnauthorizedException
    const mock1 = createMockHost({ headers: { 'x-request-id': 'req_auth_1' } });
    filter.catch(new UnauthorizedException('Authentication required'), mock1.host);
    assert.strictEqual(mock1.getStatusCode(), HttpStatus.UNAUTHORIZED);
    assert.strictEqual(mock1.getResponseData().error.code, ApiErrorCode.UNAUTHORIZED);
    assert.strictEqual(mock1.getResponseData().error.message, 'Authentication required');

    // Custom AuthenticationException
    const mock2 = createMockHost({ headers: { 'x-request-id': 'req_auth_2' } });
    filter.catch(new AuthenticationException('Invalid JWT token'), mock2.host);
    assert.strictEqual(mock2.getStatusCode(), HttpStatus.UNAUTHORIZED);
    assert.strictEqual(mock2.getResponseData().error.code, ApiErrorCode.UNAUTHORIZED);
    assert.strictEqual(mock2.getResponseData().error.message, 'Invalid JWT token');

    console.log('  ✓ Authentication errors handled correctly');
  }

  // Test 3: Authorization Error (403 Forbidden)
  console.log('Test 3: Authorization Error Handling (403)');
  {
    const filter = new GlobalExceptionFilter(testLogger, true);

    // Standard NestJS ForbiddenException
    const mock1 = createMockHost({ headers: { 'x-request-id': 'req_forb_1' } });
    filter.catch(new ForbiddenException('You do not have permission to access this repository'), mock1.host);
    assert.strictEqual(mock1.getStatusCode(), HttpStatus.FORBIDDEN);
    assert.strictEqual(mock1.getResponseData().error.code, ApiErrorCode.FORBIDDEN);
    assert.strictEqual(mock1.getResponseData().error.message, 'You do not have permission to access this repository');

    // Custom AuthorizationException
    const mock2 = createMockHost({ headers: { 'x-request-id': 'req_forb_2' } });
    filter.catch(new AuthorizationException('Insufficient permissions'), mock2.host);
    assert.strictEqual(mock2.getStatusCode(), HttpStatus.FORBIDDEN);
    assert.strictEqual(mock2.getResponseData().error.code, ApiErrorCode.FORBIDDEN);
    assert.strictEqual(mock2.getResponseData().error.message, 'Insufficient permissions');

    console.log('  ✓ Authorization errors handled correctly');
  }

  // Test 4: Validation Errors (400 Bad Request)
  console.log('Test 4: Validation Errors Handling (400)');
  {
    const filter = new GlobalExceptionFilter(testLogger, true);

    // ValidationPipe format (array of strings)
    const mock1 = createMockHost({ headers: { 'x-request-id': 'req_val_1' } });
    const validationEx = new BadRequestException([
      'email must be an email',
      'name should not be empty',
    ]);
    filter.catch(validationEx, mock1.host);

    assert.strictEqual(mock1.getStatusCode(), HttpStatus.BAD_REQUEST);
    const body1 = mock1.getResponseData();
    assert.strictEqual(body1.error.code, ApiErrorCode.VALIDATION_ERROR);
    assert.strictEqual(body1.error.message, 'Validation failed');
    assert.deepStrictEqual(body1.error.details, [
      { field: 'email', message: 'email must be an email' },
      { field: 'name', message: 'name should not be empty' },
    ]);

    // ValidationPipe format with class-validator objects
    const mock2 = createMockHost({ headers: { 'x-request-id': 'req_val_2' } });
    const classValEx = new BadRequestException([
      {
        property: 'age',
        constraints: { min: 'age must be greater than or equal to 18' },
      },
    ]);
    filter.catch(classValEx, mock2.host);
    assert.strictEqual(mock2.getStatusCode(), HttpStatus.BAD_REQUEST);
    const body2 = mock2.getResponseData();
    assert.strictEqual(body2.error.code, ApiErrorCode.VALIDATION_ERROR);
    assert.deepStrictEqual(body2.error.details, [
      { field: 'age', message: 'age must be greater than or equal to 18' },
    ]);

    // Zod error format
    const mock3 = createMockHost({ headers: { 'x-request-id': 'req_val_3' } });
    const zodError = {
      name: 'ZodError',
      issues: [
        { path: ['user', 'email'], message: 'Invalid email address', code: 'invalid_string' },
      ],
    };
    filter.catch(zodError, mock3.host);
    assert.strictEqual(mock3.getStatusCode(), HttpStatus.BAD_REQUEST);
    const body3 = mock3.getResponseData();
    assert.strictEqual(body3.error.code, ApiErrorCode.VALIDATION_ERROR);
    assert.deepStrictEqual(body3.error.details, [
      { field: 'user.email', message: 'Invalid email address', code: 'invalid_string' },
    ]);

    // Custom ValidationException
    const mock4 = createMockHost({ headers: { 'x-request-id': 'req_val_4' } });
    filter.catch(
      new ValidationException('Payload validation failed', [{ field: 'query', message: 'Query too short' }]),
      mock4.host,
    );
    assert.strictEqual(mock4.getStatusCode(), HttpStatus.BAD_REQUEST);
    const body4 = mock4.getResponseData();
    assert.strictEqual(body4.error.code, ApiErrorCode.VALIDATION_ERROR);
    assert.strictEqual(body4.error.message, 'Payload validation failed');

    console.log('  ✓ Validation errors handled cleanly across all formats');
  }

  // Test 5: Conflict Error Handling (409)
  console.log('Test 5: Conflict Error Handling (409)');
  {
    const filter = new GlobalExceptionFilter(testLogger, true);

    const mock1 = createMockHost({ headers: { 'x-request-id': 'req_conf_1' } });
    filter.catch(new NestConflictException('User with this email already exists'), mock1.host);
    assert.strictEqual(mock1.getStatusCode(), HttpStatus.CONFLICT);
    assert.strictEqual(mock1.getResponseData().error.code, ApiErrorCode.CONFLICT);
    assert.strictEqual(mock1.getResponseData().error.message, 'User with this email already exists');

    const mock2 = createMockHost({ headers: { 'x-request-id': 'req_conf_2' } });
    filter.catch(new ConflictException('Repository already registered'), mock2.host);
    assert.strictEqual(mock2.getStatusCode(), HttpStatus.CONFLICT);
    assert.strictEqual(mock2.getResponseData().error.code, ApiErrorCode.CONFLICT);
    assert.strictEqual(mock2.getResponseData().error.message, 'Repository already registered');

    console.log('  ✓ Conflict errors handled correctly');
  }

  // Test 6: Database Errors Safely Handled (Prisma)
  console.log('Test 6: Database Errors Safely Handled');
  {
    const filterProd = new GlobalExceptionFilter(testLogger, true);
    const filterDev = new GlobalExceptionFilter(testLogger, false);

    // Prisma P2002: Unique Constraint Violation
    const prismaUniqueError = {
      name: 'PrismaClientKnownRequestError',
      code: 'P2002',
      clientVersion: '5.22.0',
      meta: { target: ['email'] },
      message: 'Unique constraint failed on the fields: (`email`)',
    };

    const mockP2002Prod = createMockHost({ headers: { 'x-request-id': 'req_db_1' } });
    filterProd.catch(prismaUniqueError, mockP2002Prod.host);
    assert.strictEqual(mockP2002Prod.getStatusCode(), HttpStatus.CONFLICT);
    assert.strictEqual(mockP2002Prod.getResponseData().error.code, ApiErrorCode.CONFLICT);
    assert.strictEqual(mockP2002Prod.getResponseData().error.message, 'A resource with this identifier already exists');
    assert.strictEqual(mockP2002Prod.getResponseData().error.details, undefined);

    const mockP2002Dev = createMockHost({ headers: { 'x-request-id': 'req_db_1d' } });
    filterDev.catch(prismaUniqueError, mockP2002Dev.host);
    assert.strictEqual(mockP2002Dev.getStatusCode(), HttpStatus.CONFLICT);
    assert.ok(mockP2002Dev.getResponseData().error.message.includes('conflict on: email'));

    // Prisma P2025: Record Not Found
    const prismaNotFoundError = {
      name: 'PrismaClientKnownRequestError',
      code: 'P2025',
      clientVersion: '5.22.0',
      message: 'Record to update not found.',
    };
    const mockP2025 = createMockHost({ headers: { 'x-request-id': 'req_db_2' } });
    filterProd.catch(prismaNotFoundError, mockP2025.host);
    assert.strictEqual(mockP2025.getStatusCode(), HttpStatus.NOT_FOUND);
    assert.strictEqual(mockP2025.getResponseData().error.code, ApiErrorCode.RESOURCE_NOT_FOUND);
    assert.strictEqual(mockP2025.getResponseData().error.message, 'The requested resource was not found');

    // Prisma P2003: Foreign Key Constraint Violation
    const prismaFkError = {
      name: 'PrismaClientKnownRequestError',
      code: 'P2003',
      clientVersion: '5.22.0',
      meta: { field_name: 'repositoryId' },
      message: 'Foreign key constraint violation.',
    };
    const mockP2003 = createMockHost({ headers: { 'x-request-id': 'req_db_3' } });
    filterProd.catch(prismaFkError, mockP2003.host);
    assert.strictEqual(mockP2003.getStatusCode(), HttpStatus.BAD_REQUEST);
    assert.strictEqual(mockP2003.getResponseData().error.code, ApiErrorCode.DATABASE_CONSTRAINT_VIOLATION);
    assert.strictEqual(
      mockP2003.getResponseData().error.message,
      'Referenced resource does not exist or relation conflict',
    );

    // Prisma Initialization Error (Never leak DB connection/password)
    const prismaInitError = {
      name: 'PrismaClientInitializationError',
      message: 'Could not connect to postgresql://postgres:supersecret@db:5432/devpulse',
    };
    const mockInit = createMockHost({ headers: { 'x-request-id': 'req_db_4' } });
    filterProd.catch(prismaInitError, mockInit.host);
    assert.strictEqual(mockInit.getStatusCode(), HttpStatus.SERVICE_UNAVAILABLE);
    assert.strictEqual(mockInit.getResponseData().error.code, ApiErrorCode.DATABASE_UNAVAILABLE);
    assert.strictEqual(mockInit.getResponseData().error.message, 'Database service is temporarily unavailable');
    // Ensure secrets are NOT leaked in response
    assert.ok(!JSON.stringify(mockInit.getResponseData()).includes('supersecret'));

    // Custom DatabaseException
    const mockDbEx = createMockHost({ headers: { 'x-request-id': 'req_db_5' } });
    filterProd.catch(new DatabaseException('Storage failure'), mockDbEx.host);
    assert.strictEqual(mockDbEx.getStatusCode(), HttpStatus.INTERNAL_SERVER_ERROR);
    assert.strictEqual(mockDbEx.getResponseData().error.code, ApiErrorCode.DATABASE_ERROR);

    console.log('  ✓ Database errors handled safely without exposing internal details');
  }

  // Test 7: Production Information Hiding & Stack Trace Sanitization
  console.log('Test 7: Production Information Hiding & Stack Traces');
  {
    const filterProd = new GlobalExceptionFilter(testLogger, true);
    const filterDev = new GlobalExceptionFilter(testLogger, false);

    const unexpectedError = new Error('Raw SQL syntax error at SELECT * FROM secret_table WHERE id = 1');
    unexpectedError.stack = 'Error: Raw SQL syntax error\n    at internalQuery (D:/project/src/db.ts:42:15)';

    // Production: Hide message and stack trace
    const mockProd = createMockHost({ headers: { 'x-request-id': 'req_prod_1' } });
    filterProd.catch(unexpectedError, mockProd.host);

    assert.strictEqual(mockProd.getStatusCode(), HttpStatus.INTERNAL_SERVER_ERROR);
    const prodBody = mockProd.getResponseData();
    assert.strictEqual(prodBody.error.code, ApiErrorCode.INTERNAL_SERVER_ERROR);
    assert.strictEqual(prodBody.error.message, 'An internal server error occurred');
    assert.strictEqual(prodBody.error.stack, undefined);
    assert.ok(!JSON.stringify(prodBody).includes('secret_table'));
    assert.ok(!JSON.stringify(prodBody).includes('db.ts'));

    // Development: Include stack trace for developer debugging
    const mockDev = createMockHost({ headers: { 'x-request-id': 'req_dev_1' } });
    filterDev.catch(unexpectedError, mockDev.host);

    assert.strictEqual(mockDev.getStatusCode(), HttpStatus.INTERNAL_SERVER_ERROR);
    const devBody = mockDev.getResponseData();
    assert.strictEqual(devBody.error.code, ApiErrorCode.INTERNAL_SERVER_ERROR);
    assert.strictEqual(devBody.error.message, unexpectedError.message);
    assert.strictEqual(typeof devBody.error.stack, 'string');
    assert.ok(devBody.error.stack.includes('db.ts'));

    console.log('  ✓ Internal details and stack traces securely hidden in production');
  }

  // Test 8: Request ID and Correlation ID Propagation
  console.log('Test 8: Request ID and Correlation Context Propagation');
  {
    const filter = new GlobalExceptionFilter(testLogger, true);

    // Scenario A: Request ID from CorrelationContext
    CorrelationContext.run({ requestId: 'corr_req_999', correlationId: 'corr_999' }, () => {
      const mockA = createMockHost();
      filter.catch(new NotFoundException('Item not found'), mockA.host);
      assert.strictEqual(mockA.getResponseData().requestId, 'corr_req_999');
      assert.strictEqual(mockA.getHeaders()['x-request-id'], 'corr_req_999');
    });

    // Scenario B: Request ID from Request Header
    const mockB = createMockHost({ headers: { 'x-request-id': 'header_req_888' } });
    filter.catch(new NotFoundException('Item not found'), mockB.host);
    assert.strictEqual(mockB.getResponseData().requestId, 'header_req_888');
    assert.strictEqual(mockB.getHeaders()['x-request-id'], 'header_req_888');

    // Scenario C: Auto-generated UUID when no ID is provided
    const mockC = createMockHost();
    filter.catch(new NotFoundException('Item not found'), mockC.host);
    const generatedId = mockC.getResponseData().requestId;
    assert.strictEqual(typeof generatedId, 'string');
    assert.ok(generatedId.length > 20, 'Generated ID must be a valid UUID');
    assert.strictEqual(mockC.getHeaders()['x-request-id'], generatedId);

    console.log('  ✓ Request ID propagation verified across context and headers');
  }

  // Test 9: Logging Integration (4xx warns, 5xx errors)
  console.log('Test 9: Logging Integration Verification');
  {
    const logState: { level?: string; message?: string } = {};

    const mockLogger = {
      warn: (msg: string) => {
        logState.level = 'warn';
        logState.message = msg;
      },
      error: (msg: string) => {
        logState.level = 'error';
        logState.message = msg;
      },
      info: () => {},
      debug: () => {},
      trace: () => {},
      fatal: () => {},
      log: () => {},
      verbose: () => {},
    } as unknown as Logger;

    const filterWithMockLogger = new GlobalExceptionFilter(mockLogger, true);

    // 404 should log at warn
    const mock404 = createMockHost({ headers: { 'x-request-id': 'req_log_404' } });
    filterWithMockLogger.catch(new NotFoundException('Resource missing'), mock404.host);
    assert.strictEqual(logState.level, 'warn');
    assert.ok(logState.message?.includes('404 RESOURCE_NOT_FOUND'));

    // 500 should log at error
    const mock500 = createMockHost({ headers: { 'x-request-id': 'req_log_500' } });
    filterWithMockLogger.catch(new Error('Fatal boom'), mock500.host);
    assert.strictEqual(logState.level, 'error');
    assert.ok(logState.message?.includes('500 INTERNAL_SERVER_ERROR'));

    console.log('  ✓ Appropriate logging levels (warn vs error) verified');
  }

  console.log('\n✅ ALL API ERROR HANDLING TESTS PASSED SUCCESSFULLY!');
}

runTests().catch((err) => {
  console.error('❌ Tests failed:', err);
  process.exit(1);
});
