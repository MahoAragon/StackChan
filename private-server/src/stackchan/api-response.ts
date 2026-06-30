/**
 * GoFrame-compatible response envelope.
 *
 * The firmware treats `code === 0` as success and reads `data`
 * (hal_account.cpp / hal_app_center.cpp). It also tolerates several bare
 * shapes, but matching the original GoFrame `{ code, message, data }` wrapper
 * keeps us byte-compatible with the production server.
 */
export interface ApiEnvelope<T> {
  code: number;
  message: string;
  data: T;
}

export function ok<T>(data: T): ApiEnvelope<T> {
  return { code: 0, message: '', data };
}

export function fail(message: string, code = 1): ApiEnvelope<null> {
  return { code, message, data: null };
}
