/**
 * T-PC-011. `HttpExceptionFilter` — unit-level coverage of the branch real HTTP traffic never
 * exercises (an unmapped, unexpected error type falling through to a generic `500`, logged
 * server-side but never leaked to the caller). `PromoCodeConfigValidationError` → `400` and
 * `ConfigNameConflictError` → `409` are already covered end to end via real HTTP in
 * `promo-code-config.controller.spec.ts` (TC-9/TC-10/TC-11).
 */
import type { ArgumentsHost } from '@nestjs/common';
import { HttpException } from '@nestjs/common';
import { HttpExceptionFilter } from '@/modules/promo-code-config/filters/http-exception.filter';

function mockHost(): {
  host: ArgumentsHost;
  response: { status: jest.Mock; json: jest.Mock };
} {
  const response = { status: jest.fn().mockReturnThis(), json: jest.fn() };
  const host = {
    switchToHttp: () => ({
      getResponse: () => response,
    }),
  } as unknown as ArgumentsHost;
  return { host, response };
}

describe('T-PC-011 — HttpExceptionFilter', () => {
  it('maps an unrecognised error to a generic 500 without leaking its message', () => {
    const filter = new HttpExceptionFilter();
    const { host, response } = mockHost();

    filter.catch(new Error('some internal driver detail'), host);

    expect(response.status).toHaveBeenCalledWith(500);
    expect(response.json).toHaveBeenCalledWith('Internal server error');
  });

  it('passes an existing HttpException straight through unchanged', () => {
    const filter = new HttpExceptionFilter();
    const { host, response } = mockHost();
    const exception = new HttpException('teapot', 418);

    filter.catch(exception, host);

    expect(response.status).toHaveBeenCalledWith(418);
  });
});
