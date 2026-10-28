/** Business errors carry their own HTTP status so the API layer stays thin. */
export class ServiceError extends Error {
  constructor(
    readonly httpStatus: number,
    readonly code: string,
    message: string,
    readonly details?: string[],
  ) {
    super(message);
    this.name = 'ServiceError';
  }
}
