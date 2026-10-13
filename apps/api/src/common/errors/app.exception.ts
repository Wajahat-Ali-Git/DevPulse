import { HttpException, HttpStatus } from '@nestjs/common';
import { ApiErrorCode } from '@devpulse/types';

/**
 * Base application exception for DevPulse.
 * All domain and application exceptions inherit from this class.
 */
export class AppException extends HttpException {
  readonly code: string;
  readonly details?: any;

  constructor(
    code: string = ApiErrorCode.INTERNAL_SERVER_ERROR,
    message: string = 'An unexpected error occurred',
    statusCode: number = HttpStatus.INTERNAL_SERVER_ERROR,
    details?: any,
  ) {
    super(
      {
        code,
        message,
        details,
      },
      statusCode,
    );
    this.code = code;
    this.details = details;
  }
}
