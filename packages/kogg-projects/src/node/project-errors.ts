// observability-exempt: Pure error declarations; callers log operational failures with safe fields.
// diagnostic-exempt: Pure error declarations have no independent runtime state.

export class ProjectError extends Error {
  constructor(readonly code: string, message: string, options?: ErrorOptions) {
    super(`${code}: ${message}`, options);
    this.name = 'ProjectError';
  }
}

export function errorType(error: unknown): string {
  return error instanceof Error ? error.name : 'UnknownError';
}
