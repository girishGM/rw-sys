/**
 * T-038 implementation note 5 — the scheduled sweep.
 *
 * The sweep is deliberately the *less* important half of expiry: correctness comes from the read
 * side (`isApprovalExpired`, applied on every read and before every decision), and this only makes
 * the stored column agree. What matters here is therefore the failure behaviour, not the happy
 * path: a `@Cron` handler that rejects produces an unhandled promise rejection, which under Node
 * 20's default policy terminates the process. An approval-queue tidy-up must not be able to take
 * the API down, so `sweep()` cannot reject — that is what this file pins.
 */
import { Logger } from '@nestjs/common';
import { ApprovalExpirySweeper } from '@/modules/approvals/approval-expiry.sweeper';
import type { ApprovalExpiryStore } from '@/modules/approvals/approvals.repository';

function sweeperWith(store: ApprovalExpiryStore): ApprovalExpirySweeper {
  return new ApprovalExpirySweeper(store);
}

describe('T-038 · ApprovalExpirySweeper', () => {
  beforeEach(() => {
    jest.restoreAllMocks();
  });

  it('logs how many requests it expired when it changed anything', async () => {
    const log = jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    const markExpired = jest.fn<Promise<number>, []>().mockResolvedValue(3);

    await sweeperWith({ markExpired }).sweep();

    expect(markExpired).toHaveBeenCalledTimes(1);
    expect(log).toHaveBeenCalledWith(expect.stringContaining('3'));
  });

  it('stays silent when there was nothing to sweep — an hourly no-op is not news', async () => {
    const log = jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);

    await sweeperWith({ markExpired: jest.fn().mockResolvedValue(0) }).sweep();

    expect(log).not.toHaveBeenCalled();
  });

  it('never rejects when the store fails, and says why that is safe', async () => {
    const error = jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    const markExpired = jest.fn<Promise<number>, []>().mockRejectedValue(new Error('pool drained'));

    await expect(sweeperWith({ markExpired }).sweep()).resolves.toBeUndefined();

    expect(error).toHaveBeenCalledWith(expect.stringContaining('pool drained'), expect.anything());
    // The message has to state the mitigation, because that is what an operator reading this at
    // 3am needs to know: nothing became actionable.
    expect(error.mock.calls[0][0]).toContain('no request became actionable');
  });
});
