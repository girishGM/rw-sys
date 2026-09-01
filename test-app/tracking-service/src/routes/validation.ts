/**
 * T-004 — the one `customerId` validation rule every route that takes one shares (TC-11: "4xx,
 * clear error, no crash" for an unknown customer). A single shared check so "unknown customer"
 * always produces the same shape/status across `dashboard`/`rewards`/`activities`/`events`.
 */
import type { Response } from 'express';
import { isValidCustomerId } from '../data/customers';

/**
 * Validates a `customerId` value pulled from `req.query`/`req.body` (both typed loosely by
 * Express). Writes a 400 (missing/wrong type) or 404 (well-formed but unknown) response itself
 * and returns `false` when invalid, so callers can `if (!requireCustomerId(...)) return;` and
 * otherwise treat the narrowed value as a real `string`.
 */
export function requireCustomerId(value: unknown, res: Response): value is string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    res.status(400).json({ error: 'customerId is required' });
    return false;
  }
  if (!isValidCustomerId(value)) {
    res.status(404).json({ error: `unknown customerId "${value}"` });
    return false;
  }
  return true;
}
