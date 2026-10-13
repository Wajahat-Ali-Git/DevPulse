import { ApiErrorCode } from '@devpulse/types';

export interface MappedDatabaseError {
  status: number;
  code: string;
  message: string;
  details?: any;
}

/**
 * Determine if an exception originates from Prisma ORM.
 */
export function isPrismaError(exception: any): boolean {
  if (!exception || typeof exception !== 'object') {
    return false;
  }

  const name = exception.name || exception.constructor?.name;
  return (
    name === 'PrismaClientKnownRequestError' ||
    name === 'PrismaClientValidationError' ||
    name === 'PrismaClientInitializationError' ||
    name === 'PrismaClientRustPanicError' ||
    name === 'PrismaClientUnknownRequestError' ||
    (typeof exception.code === 'string' && exception.code.startsWith('P') && Boolean(exception.clientVersion))
  );
}

/**
 * Safely map Prisma database errors into predictable API error responses
 * without exposing internal database schema, connection strings, or query details in production.
 */
export function mapPrismaError(exception: any, isProduction: boolean): MappedDatabaseError {
  const name = exception.name || exception.constructor?.name;
  const prismaCode = exception.code;

  // 1. Known Request Errors (Pxxxx)
  if (name === 'PrismaClientKnownRequestError' || (typeof prismaCode === 'string' && prismaCode.startsWith('P'))) {
    switch (prismaCode) {
      case 'P2002': {
        // Unique constraint violation (e.g. duplicate email, unique slug)
        const target = exception.meta?.target;
        const targetDesc = Array.isArray(target) ? target.join(', ') : target;
        return {
          status: 409,
          code: ApiErrorCode.CONFLICT,
          message: isProduction
            ? 'A resource with this identifier already exists'
            : targetDesc
              ? `A resource with this identifier already exists (conflict on: ${targetDesc})`
              : 'A resource with this identifier already exists',
          details: isProduction ? undefined : { target: exception.meta?.target, constraint: prismaCode },
        };
      }

      case 'P2025': {
        // Record not found
        return {
          status: 404,
          code: ApiErrorCode.RESOURCE_NOT_FOUND,
          message: 'The requested resource was not found',
        };
      }

      case 'P2003': {
        // Foreign key constraint failed
        const field = exception.meta?.field_name;
        return {
          status: 400,
          code: ApiErrorCode.DATABASE_CONSTRAINT_VIOLATION,
          message: isProduction
            ? 'Referenced resource does not exist or relation conflict'
            : `Foreign key constraint failed on field ${field || 'unknown'}`,
          details: isProduction ? undefined : { field, constraint: prismaCode },
        };
      }

      case 'P2014': {
        // Required relation violation
        return {
          status: 400,
          code: ApiErrorCode.DATABASE_CONSTRAINT_VIOLATION,
          message: 'Operation violates a required database relation constraint',
        };
      }

      case 'P2000': {
        // Value too long for column
        return {
          status: 400,
          code: ApiErrorCode.BAD_REQUEST,
          message: 'Input value is too long for the target field',
        };
      }

      case 'P2001': {
        // Record does not exist where condition
        return {
          status: 404,
          code: ApiErrorCode.RESOURCE_NOT_FOUND,
          message: 'The requested resource was not found',
        };
      }

      default: {
        return {
          status: 400,
          code: ApiErrorCode.DATABASE_ERROR,
          message: isProduction
            ? 'Database operation failed'
            : `Database operation failed (${prismaCode})`,
          details: isProduction ? undefined : { prismaCode },
        };
      }
    }
  }

  // 2. Prisma Client Validation Error (malformed query args)
  if (name === 'PrismaClientValidationError') {
    return {
      status: 400,
      code: ApiErrorCode.VALIDATION_ERROR,
      message: isProduction
        ? 'Invalid database query parameters'
        : 'Invalid database query parameters',
      details: isProduction ? undefined : { originalMessage: exception.message },
    };
  }

  // 3. Prisma Client Initialization Error (connection failure, wrong credentials)
  if (name === 'PrismaClientInitializationError') {
    return {
      status: 503,
      code: ApiErrorCode.DATABASE_UNAVAILABLE,
      message: 'Database service is temporarily unavailable',
    };
  }

  // 4. Engine Crash / Panic / Unknown
  return {
    status: 500,
    code: ApiErrorCode.INTERNAL_SERVER_ERROR,
    message: isProduction
      ? 'An internal server error occurred'
      : 'An unexpected database error occurred',
  };
}
