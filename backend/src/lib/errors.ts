// Errors thrown from handlers become `{ error: { code, message, ...extra } }`
// with the given HTTP status (see app.ts error handler).
export class AppError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
    public extra: Record<string, unknown> = {},
  ) {
    super(message);
  }
}

export const badRequest = (code: string, message: string, extra?: Record<string, unknown>) => new AppError(400, code, message, extra);
export const unauthorized = (message = 'Please log in again') => new AppError(401, 'unauthorized', message);
export const forbidden = (message = 'You cannot do this') => new AppError(403, 'forbidden', message);
export const notFound = (what = 'Item') => new AppError(404, 'not_found', `${what} not found`);
export const conflict = (code: string, message: string, extra?: Record<string, unknown>) => new AppError(409, code, message, extra);
