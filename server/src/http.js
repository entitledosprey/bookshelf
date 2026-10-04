export class HttpError extends Error {
  constructor(status, message, detail = '') {
    super(message);
    this.status = status;
    this.detail = detail;
  }
}

/** Wrap an async route so rejections reach the Express error handler. */
export const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

export const isoNow = () => new Date().toISOString();

export function reqStr(body, key, { max = 500, required = true } = {}) {
  const v = body?.[key];
  if (typeof v !== 'string' || v.trim() === '') {
    if (required) throw new HttpError(400, `${key} is required`);
    return '';
  }
  const s = v.trim();
  if (s.length > max) throw new HttpError(400, `${key} is too long`);
  return s;
}
