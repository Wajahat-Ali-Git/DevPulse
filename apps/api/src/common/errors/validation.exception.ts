import { HttpStatus } from '@nestjs/common';
import { ApiErrorCode } from '@devpulse/types';
import { AppException } from './app.exception';

/**
 * Thrown when request data fails schema, format, or business validation.
 */
export class ValidationException extends AppException {
  constructor(message: string = 'Validation failed', details?: any) {
    super(ApiErrorCode.VALIDATION_ERROR, message, HttpStatus.BAD_REQUEST, details);
  }
}
