/**
 * Boundary validation with the contract's own Zod schemas. Nothing is re-declared here: a route hands the
 * schema of the `api` route table plus the raw value, and gets the parsed value or an `invalid_request`
 * `AppError` that names the offending fields (path + stable reason code — never the submitted value).
 */
import type { z } from 'zod';
import { AppError } from '../../application/index.ts';

const MAX_FIELDS = 50;

export function parseWithContract<S extends z.ZodType>(schema: S, value: unknown, location: 'params' | 'query' | 'body'): z.output<S> {
  const result = schema.safeParse(value);
  if (result.success) return result.data;
  const fields = result.error.issues.slice(0, MAX_FIELDS).map((issue) => ({
    // `unrecognized_keys` lists the keys in `keys`; the path is the object that contained them.
    field: [location, ...issue.path.map(String)].join('.').slice(0, 200),
    reason: issue.code.slice(0, 100),
  }));
  throw new AppError('invalid_request', { fields });
}
