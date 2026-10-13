import { HttpStatus } from '@nestjs/common';
import { ApiErrorCode } from '@devpulse/types';
import { AppException } from './app.exception';

/**
 * Thrown when an unrecoverable database or persistence failure occurs.
 */
export class DatabaseException extends AppException {
  constructor(
    message: string = 'Database operation failed',
    details?: any,
    statusCode: number = HttpStatus.INTERNAL_SERVER_ERROR,
  ) {
    super(ApiErrorCode.DATABASE_ERROR, message, statusCode, details);
  }
}
