import {
  ExceptionFilter,
  Catch,
  ArgumentsHost,
  HttpException,
  HttpStatus,
} from '@nestjs/common';
import { randomUUID } from 'crypto';
import {
  ApiErrorCode,
  ApiErrorDetail,
  ApiErrorPayload,
  ApiResponseError,
} from '@devpulse/types';
import { Logger, CorrelationContext } from '@devpulse/logger';
import { AppException } from '../errors/app.exception';
import { isPrismaError, mapPrismaError } from './prisma-error.util';

interface ResolvedErrorInfo {
  status: number;
  code: string;
  message: string;
  details?: any;
  stack?: string;
}

/**
 * Global exception filter catching all application, HTTP, database, and unexpected errors.
 * Formats errors into a predictable JSON structure, strips sensitive details in production,
 * propagates requestId, and logs appropriately.
 */
@Catch()
export class GlobalExceptionFilter implements ExceptionFilter {
  private readonly logger: Logger;
  private readonly isProduction: boolean;

  constructor(logger?: Logger, isProduction?: boolean) {
    this.logger = logger || new Logger({ service: 'api', context: 'GlobalExceptionFilter' });
    this.isProduction =
      isProduction !== undefined
        ? isProduction
        : process.env.NODE_ENV === 'production';
  }

  catch(exception: unknown, host: ArgumentsHost): void {
    const ctx = host.switchToHttp();
    const response = ctx.getResponse();
    const request = ctx.getRequest();

    // 1. Extract or generate Request ID
    const requestId = this.extractRequestId(request, response);

    // 2. Resolve Status, Code, Message, Details, Stack
    const { status, code, message, details, stack } = this.resolveErrorInfo(exception);

    // 3. Log error appropriately
    this.logError(status, code, message, exception, requestId, request);

    // 4. Construct consistent error response payload
    const errorPayload: ApiErrorPayload = {
      code,
      message,
    };

    if (details !== undefined && details !== null) {
      errorPayload.details = details;
    }

    // Never leak stack traces in production; allow in dev/test for 5xx debugging
    if (!this.isProduction && status >= 500 && stack) {
      errorPayload.stack = stack;
    }

    const responseBody: ApiResponseError = {
      success: false,
      error: errorPayload,
      requestId,
    };

    // 5. Ensure headers match response and send JSON
    if (response && typeof response.setHeader === 'function') {
      response.setHeader('x-request-id', requestId);
    }

    if (response && typeof response.status === 'function') {
      response.status(status).json(responseBody);
    }
  }

  /**
   * Resolves error information (status, error code, message, details, stack)
   * across different exception categories.
   */
  private resolveErrorInfo(exception: unknown): ResolvedErrorInfo {
    // A. Custom DevPulse AppException
    if (exception instanceof AppException) {
      return {
        status: exception.getStatus(),
        code: exception.code,
        message: exception.message,
        details: exception.details,
        stack: exception.stack,
      };
    }

    // B. Prisma Database Errors
    if (isPrismaError(exception)) {
      const mapped = mapPrismaError(exception, this.isProduction);
      return {
        status: mapped.status,
        code: mapped.code,
        message: mapped.message,
        details: mapped.details,
        stack: (exception as any)?.stack,
      };
    }

    // C. Zod Validation Errors
    if (
      exception &&
      typeof exception === 'object' &&
      ((exception as any).name === 'ZodError' || Array.isArray((exception as any).issues))
    ) {
      const issues = (exception as any).issues || [];
      return {
        status: HttpStatus.BAD_REQUEST,
        code: ApiErrorCode.VALIDATION_ERROR,
        message: 'Validation failed',
        details: this.formatZodErrors(issues),
        stack: (exception as any).stack,
      };
    }

    // D. NestJS Built-in HttpExceptions
    if (exception instanceof HttpException) {
      const status = exception.getStatus();
      const res = exception.getResponse();
      let code: string | undefined;
      let message = exception.message;
      let details: any;

      if (typeof res === 'string') {
        message = res;
      } else if (res && typeof res === 'object') {
        const resObj = res as Record<string, any>;
        if (resObj.code) code = resObj.code;
        if (resObj.details) details = resObj.details;

        if (Array.isArray(resObj.message)) {
          // Standard NestJS ValidationPipe error
          code = ApiErrorCode.VALIDATION_ERROR;
          message = 'Validation failed';
          details = this.formatValidationMessages(resObj.message);
        } else if (typeof resObj.message === 'string') {
          message = resObj.message;
        }
      }

      // Default mapping based on HTTP status code
      if (!code) {
        code = this.mapHttpStatusToErrorCode(status, details);
      }

      // Hide 500 error messages in production
      if (status >= 500 && this.isProduction) {
        message = 'An internal server error occurred';
        details = undefined;
      }

      return {
        status,
        code,
        message,
        details,
        stack: exception.stack,
      };
    }

    // E. Generic JavaScript Error (Unhandled Runtime Exception)
    if (exception instanceof Error) {
      return {
        status: HttpStatus.INTERNAL_SERVER_ERROR,
        code: ApiErrorCode.INTERNAL_SERVER_ERROR,
        message: this.isProduction ? 'An internal server error occurred' : exception.message,
        stack: exception.stack,
      };
    }

    // F. Non-Error thrown object or primitive
    return {
      status: HttpStatus.INTERNAL_SERVER_ERROR,
      code: ApiErrorCode.INTERNAL_SERVER_ERROR,
      message: 'An internal server error occurred',
    };
  }

  /**
   * Map HTTP Status code to canonical DevPulse ApiErrorCode.
   */
  private mapHttpStatusToErrorCode(status: number, details?: any): string {
    switch (status) {
      case HttpStatus.BAD_REQUEST:
        return details ? ApiErrorCode.VALIDATION_ERROR : ApiErrorCode.BAD_REQUEST;
      case HttpStatus.UNAUTHORIZED:
        return ApiErrorCode.UNAUTHORIZED;
      case HttpStatus.FORBIDDEN:
        return ApiErrorCode.FORBIDDEN;
      case HttpStatus.NOT_FOUND:
        return ApiErrorCode.RESOURCE_NOT_FOUND;
      case HttpStatus.METHOD_NOT_ALLOWED:
        return ApiErrorCode.METHOD_NOT_ALLOWED;
      case HttpStatus.NOT_ACCEPTABLE:
        return ApiErrorCode.NOT_ACCEPTABLE;
      case HttpStatus.CONFLICT:
        return ApiErrorCode.CONFLICT;
      case HttpStatus.PAYLOAD_TOO_LARGE:
        return ApiErrorCode.PAYLOAD_TOO_LARGE;
      case HttpStatus.UNSUPPORTED_MEDIA_TYPE:
        return ApiErrorCode.UNSUPPORTED_MEDIA_TYPE;
      case HttpStatus.UNPROCESSABLE_ENTITY:
        return ApiErrorCode.UNPROCESSABLE_ENTITY;
      case HttpStatus.TOO_MANY_REQUESTS:
        return ApiErrorCode.TOO_MANY_REQUESTS;
      case HttpStatus.INTERNAL_SERVER_ERROR:
        return ApiErrorCode.INTERNAL_SERVER_ERROR;
      case HttpStatus.NOT_IMPLEMENTED:
        return ApiErrorCode.NOT_IMPLEMENTED;
      case HttpStatus.BAD_GATEWAY:
        return ApiErrorCode.BAD_GATEWAY;
      case HttpStatus.SERVICE_UNAVAILABLE:
        return ApiErrorCode.SERVICE_UNAVAILABLE;
      case HttpStatus.GATEWAY_TIMEOUT:
        return ApiErrorCode.GATEWAY_TIMEOUT;
      default:
        return `HTTP_${status}`;
    }
  }

  /**
   * Normalize validation error messages into ApiErrorDetail format.
   */
  private formatValidationMessages(messages: any[]): ApiErrorDetail[] {
    return messages.map((item) => {
      if (typeof item === 'string') {
        const spaceIndex = item.indexOf(' ');
        const field = spaceIndex > 0 ? item.substring(0, spaceIndex) : undefined;
        return { field, message: item };
      }
      if (item && typeof item === 'object') {
        const field = item.property || item.field;
        const message =
          item.message ||
          (item.constraints ? Object.values(item.constraints).join(', ') : JSON.stringify(item));
        return { field, message };
      }
      return { message: String(item) };
    });
  }

  /**
   * Format Zod validation issues into ApiErrorDetail format.
   */
  private formatZodErrors(issues: any[]): ApiErrorDetail[] {
    return issues.map((issue) => ({
      field: Array.isArray(issue.path) ? issue.path.join('.') : undefined,
      message: issue.message,
      code: issue.code,
    }));
  }

  /**
   * Retrieve request ID from active CorrelationContext, response/request headers, or fallback to UUID.
   */
  private extractRequestId(req?: any, res?: any): string {
    const context = CorrelationContext.get();
    if (context.requestId) {
      return context.requestId;
    }

    if (res && typeof res.getHeader === 'function') {
      const header = res.getHeader('x-request-id') || res.getHeader('x-correlation-id');
      if (header) return String(header);
    }

    if (req) {
      if (req.id) return String(req.id);
      if (req.headers) {
        const header = req.headers['x-request-id'] || req.headers['x-correlation-id'];
        if (header) return String(header);
      }
    }

    return randomUUID();
  }

  /**
   * Log the caught error with appropriate log level and metadata.
   */
  private logError(
    status: number,
    code: string,
    message: string,
    exception: unknown,
    requestId: string,
    request: any,
  ): void {
    const method = request?.method || 'UNKNOWN';
    const url = request?.originalUrl || request?.url || '';

    if (status >= 500) {
      this.logger.error(
        `[${requestId}] ${method} ${url} - ${status} ${code}: ${
          exception instanceof Error ? exception.message : message
        }`,
        exception instanceof Error ? exception : undefined,
        {
          statusCode: status,
          errorCode: code,
          requestId,
          method,
          url,
          ip: request?.ip,
        },
      );
    } else {
      this.logger.warn(`[${requestId}] ${method} ${url} - ${status} ${code}: ${message}`, {
        statusCode: status,
        errorCode: code,
        requestId,
        method,
        url,
      });
    }
  }
}
