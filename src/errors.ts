export class HttpError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
    public details?: Record<string, unknown>,
  ) {
    super(message);
  }
}

export const notFound = (what = 'Item') => new HttpError(404, 'not_found', `${what} not found`);
export const forbidden = (msg = 'You do not have permission to do that') =>
  new HttpError(403, 'forbidden', msg);
