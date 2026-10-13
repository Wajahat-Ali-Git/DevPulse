import { HttpStatus } from '@nestjs/common';
import { ApiErrorCode } from '@devpulse/types';
import { AppException } from './app.exception';

/**
 * Thrown when an authenticated user lacks permission to perform the requested operation.
 */
export class AuthorizationException extends AppException {
  constructor(message: string = 'You do not have permission to access this resource', details?: any) {
    super(ApiErrorCode.FORBIDDEN, message, HttpStatus.FORBIDDEN, details);
  }
}
