import { ZodError } from 'zod';

export enum ErrorCode {
  // 400
  BAD_REQUEST = 'BAD_REQUEST',
  VALIDATION_ERROR = 'VALIDATION_ERROR',
  // 401
  UNAUTHORIZED = 'UNAUTHORIZED',
  // 403
  FORBIDDEN = 'FORBIDDEN',
  // 404
  NOT_FOUND = 'NOT_FOUND',
  // 409
  CONFLICT = 'CONFLICT',
  STATE_CONFLICT = 'STATE_CONFLICT',
  // 422
  UNPROCESSABLE = 'UNPROCESSABLE',
  // 500
  INTERNAL = 'INTERNAL',
}

const STATUS_MAP: Record<ErrorCode, number> = {
  [ErrorCode.BAD_REQUEST]: 400,
  [ErrorCode.VALIDATION_ERROR]: 400,
  [ErrorCode.UNAUTHORIZED]: 401,
  [ErrorCode.FORBIDDEN]: 403,
  [ErrorCode.NOT_FOUND]: 404,
  [ErrorCode.CONFLICT]: 409,
  [ErrorCode.STATE_CONFLICT]: 409,
  [ErrorCode.UNPROCESSABLE]: 422,
  [ErrorCode.INTERNAL]: 500,
};

export class AppError extends Error {
  public readonly code: ErrorCode;
  public readonly statusCode: number;
  public readonly details?: unknown;

  constructor(code: ErrorCode, message: string, details?: unknown) {
    super(message);
    this.name = 'AppError';
    this.code = code;
    this.statusCode = STATUS_MAP[code];
    this.details = details;
  }
}

export function formatZodError(error: ZodError): {
  code: ErrorCode;
  message: string;
  details: Array<{ path: string; message: string }>;
} {
  return {
    code: ErrorCode.VALIDATION_ERROR,
    message: 'Validation failed',
    details: error.issues.map((issue) => ({
      path: issue.path.join('.'),
      message: issue.message,
    })),
  };
}
