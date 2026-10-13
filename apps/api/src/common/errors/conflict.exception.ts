import { HttpStatus } from '@nestjs/common';
import { ApiErrorCode } from '@devpulse/types';
import { AppException } from './app.exception';

/**
 * Thrown when a request conflicts with the current state of a resource (e.g., duplicate record).
 */
export class ConflictException extends AppException {
  constructor(message: string = 'Resource conflict', details?: any) {
    super(ApiErrorCode.CONFLICT, message, HttpStatus.CONFLICT, details);
  }
}
