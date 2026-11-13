export type AppErrorCode =
  | "VALIDATION_ERROR"
  | "NOT_FOUND"
  | "CONFLICT"
  | "UNAUTHORIZED"
  | "FORBIDDEN"
  | "INFRASTRUCTURE_ERROR";

export class AppError extends Error {
  constructor(
    message: string,
    readonly code: AppErrorCode,
    readonly statusCode: number,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = new.target.name;
  }
}

export class ValidationError extends AppError {
  constructor(message = "The request is invalid.") {
    super(message, "VALIDATION_ERROR", 400);
  }
}

export class NotFoundError extends AppError {
  constructor(message = "The requested resource was not found.") {
    super(message, "NOT_FOUND", 404);
  }
}

export class ConflictError extends AppError {
  constructor(message = "The request conflicts with existing data.") {
    super(message, "CONFLICT", 409);
  }
}

export class UnauthorizedError extends AppError {
  constructor(message = "Authentication is required.") {
    super(message, "UNAUTHORIZED", 401);
  }
}

export class ForbiddenError extends AppError {
  constructor(message = "The request is not allowed.") {
    super(message, "FORBIDDEN", 403);
  }
}

export class InfrastructureError extends AppError {
  constructor(message = "A service dependency is unavailable.", options?: ErrorOptions) {
    super(message, "INFRASTRUCTURE_ERROR", 500, options);
  }
}

type PostgreSqlError = Error & { code?: string };

export function normalizeDatabaseError(error: unknown): Error {
  if (error instanceof AppError) {
    return error;
  }

  const code = (error as PostgreSqlError | null)?.code;
  if (code === "23505") {
    return new ConflictError("A record with the same unique value already exists.");
  }
  if (code === "23503" || code === "23514" || code === "22P02") {
    return new ValidationError("A referenced value or field is invalid.");
  }

  return new InfrastructureError("A database operation failed.", {
    cause: error,
  });
}

export function toApiError(error: unknown): {
  statusCode: number;
  body: { error: { code: AppErrorCode | "INTERNAL_ERROR"; message: string } };
} {
  if (error instanceof AppError) {
    return {
      statusCode: error.statusCode,
      body: { error: { code: error.code, message: error.message } },
    };
  }

  const statusCode = (error as { statusCode?: number } | null)?.statusCode;
  if (statusCode === 404) {
    return {
      statusCode,
      body: { error: { code: "NOT_FOUND", message: "The requested resource was not found." } },
    };
  }
  if (typeof statusCode === "number" && statusCode >= 400 && statusCode < 500) {
    return {
      statusCode,
      body: { error: { code: "VALIDATION_ERROR", message: "The request is invalid." } },
    };
  }

  return {
    statusCode: 500,
    body: { error: { code: "INTERNAL_ERROR", message: "An unexpected error occurred." } },
  };
}
