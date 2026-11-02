/**
 * Standard error response format (T15.9)
 *
 * Consistent error structure across all endpoints.
 */

export interface ErrorResponse {
  readonly code: string;
  readonly message: string;
  readonly reason?: string;
  readonly context?: ErrorContext;
  readonly quarantineRef?: string;
  readonly warning?: string;
}

export interface ErrorContext {
  readonly operation?: string;
  readonly documentType?: string;
  readonly dId?: string;
  readonly path?: string;
  readonly versionNo?: number;
}

/** Map error codes to HTTP status codes. */
export function httpStatusForCode(code: string): number {
  switch (code) {
    case 'PARSE_ERROR':
      return 400;
    case 'INVALID_CONTROL_HEADER':
      return 400;
    case 'INVALID_SCHEMA':
    case 'INVALID_NAME':
    case 'EMPTY_BINDINGS':
    case 'INVALID_FIELD_PATH':
      return 400;
    case 'SCHEMA_VALIDATION_FAILED':
      return 422;
    case 'ENRICHMENT_CONFLICT':
      return 409;
    case 'VERSION_CONFLICT':
      return 409;
    case 'DOCUMENT_NOT_FOUND':
    case 'SCHEMA_NOT_FOUND':
    case 'DOCUMENT_TYPE_NOT_FOUND':
    case 'CHANNEL_NOT_FOUND':
    case 'QUARANTINE_NOT_FOUND':
      return 404;
    case 'SCHEMA_ALREADY_EXISTS':
    case 'DOCUMENT_TYPE_ALREADY_EXISTS':
    case 'CHANNEL_ALREADY_EXISTS':
    case 'ALREADY_DECOMMISSIONED':
    case 'ALREADY_ACTIVE':
    case 'ALREADY_DELETED':
      return 409;
    case 'CHANNEL_INACTIVE':
    case 'CHANNEL_BLOCKED':
    case 'MASTER_SCHEMA_ACTIVE':
    case 'DOCUMENTS_EXIST':
      return 403;
    case 'NO_DID_DEFINITION':
    case 'NO_PRIMARY_KEY':
      return 400;
    case 'RATE_LIMITED':
      return 429;
    default:
      return 500;
  }
}

/**
 * Build a standard error response.
 */
export function buildErrorResponse(
  code: string,
  message: string,
  extras?: { reason?: string; context?: ErrorContext; quarantineRef?: string; warning?: string },
): ErrorResponse {
  const base: ErrorResponse = { code, message };
  if (!extras) return base;

  return {
    code,
    message,
    ...(extras.reason !== undefined ? { reason: extras.reason } : {}),
    ...(extras.context !== undefined ? { context: extras.context } : {}),
    ...(extras.quarantineRef !== undefined ? { quarantineRef: extras.quarantineRef } : {}),
    ...(extras.warning !== undefined ? { warning: extras.warning } : {}),
  };
}
