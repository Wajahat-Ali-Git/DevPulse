import { HttpStatus } from '@nestjs/common';
import { ApiErrorCode } from '@devpulse/types';
import { AppException } from './app.exception';

/**
 * Thrown when user credentials or authentication tokens are missing, expired, or invalid.
 */
export class AuthenticationException extends AppException {
  constructor(message: string = 'Authentication required', details?: any) {
    super(ApiErrorCode.UNAUTHORIZED, message, HttpStatus.UNAUTHORIZED, details);
  }
}
