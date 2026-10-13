import { HttpStatus } from '@nestjs/common';
import { ApiErrorCode } from '@devpulse/types';
import { AppException } from './app.exception';

/**
 * Thrown when a requested resource does not exist.
 */
export class ResourceNotFoundException extends AppException {
  constructor(message: string = 'Resource not found', details?: any) {
    super(ApiErrorCode.RESOURCE_NOT_FOUND, message, HttpStatus.NOT_FOUND, details);
  }
}
