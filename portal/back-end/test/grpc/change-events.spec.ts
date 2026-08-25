/**
 * T-047 — `ConfigChangeEvent` (09-INTEGRATION.md §9), including the two tests that exist to prove
 * something does **not** happen.
 *
 * TC-23 (*"Super Admin blasts v3 → no event for campaigns pinned to v2"*) and TC-24 (*"maker edits
 * a draft → no event"*) are structural properties, not behavioural ones: neither `modules/blasts/`
 * nor any draft-editing path can reach the publisher at all. They are asserted here by reading the
 * source of those modules, which is the only way to test an absence that no amount of exercising
 * the API can demonstrate — a passing "no event was emitted" assertion proves the scenario was set
 * up wrongly just as easily as it proves the property.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { ChangeEventPublisher, changeTypeNumber } from '@/grpc/change-event.publisher';
import { CHANGE_TYPE, WATCH_MAX_QUEUE } from '@/grpc/grpc.constants';

const SRC = join(__dirname, '../../src');

function filesUnder(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) =>
    entry.isDirectory()
      ? filesUnder(join(directory, entry.name))
      : entry.name.endsWith('.ts')
        ? [join(directory, entry.name)]
        : [],
  );
}

describe('a blast emits nothing — TC-23, structurally', () => {
  it('no file under modules/blasts imports the publisher', () => {
    const offenders = filesUnder(join(SRC, 'modules/blasts')).filter((file) =>
      /change-event\.publisher|ChangeEventPublisher|ChangeEventsModule/.test(
        readFileSync(file, 'utf8'),
      ),
    );
    expect(offenders).toEqual([]);
  });

  it('no file under modules/versions imports the publisher either', () => {
    // Publishing a version, deprecating one or retiring one changes no running campaign's
    // configuration: every binding is pinned (06-VERSIONING.md §7).
    const offenders = filesUnder(join(SRC, 'modules/versions')).filter((file) =>
      /ChangeEventPublisher|ChangeEventsModule/.test(readFileSync(file, 'utf8')),
    );
    expect(offenders).toEqual([]);
  });

  it('exactly two modules may publish, and they are the two governance transitions', () => {
    const publishers = filesUnder(SRC)
      .filter((file) => !file.includes(join('src', 'grpc')))
      .filter((file) => /this\.changeEvents\.publish/.test(readFileSync(file, 'utf8')))
      .map((file) => file.slice(SRC.length + 1));
    expect(publishers.sort()).toEqual([
      join('modules', 'approvals', 'approvals.service.ts'),
      join('modules', 'campaigns', 'campaigns.service.ts'),
    ]);
  });

  it('the campaign service publishes only for statuses that are real to the runtime — TC-24', () => {
    const source = readFileSync(join(SRC, 'modules/campaigns/campaigns.service.ts'), 'utf8');
    // `publishStatusChange` returns without publishing for anything that is not paused/active/
    // completed/archived — which is every state a *draft* edit can produce.
    expect(source).toMatch(/if \(changeType === null\) return;/);
    expect(source).not.toMatch(/CAMPAIGN_STATUS\.DRAFT[\s\S]{0,80}publishTransition/);
  });

  it('the approvals service publishes only when the campaign became active', () => {
    const source = readFileSync(join(SRC, 'modules/approvals/approvals.service.ts'), 'utf8');
    expect(source).toMatch(
      /if \(outcome\.campaign\.status === CAMPAIGN_STATUS\.ACTIVE\)[\s\S]{0,400}publishTransition/,
    );
  });
});

describe('ChangeEventPublisher', () => {
  const event = (tenantId: number) => ({
    campaignId: 1,
    campaignCode: 'C1',
    tenantId,
    changeType: 'PAUSED' as const,
    etag: '',
    occurredAt: new Date().toISOString(),
  });

  it('delivers only to subscribers of the same tenant', () => {
    const publisher = new ChangeEventPublisher();
    const seven: unknown[] = [];
    const nine: unknown[] = [];
    publisher.subscribe(7, (received) => seven.push(received));
    publisher.subscribe(9, (received) => nine.push(received));

    publisher.publish(event(7));

    expect(seven).toHaveLength(1);
    expect(nine).toHaveLength(0);
  });

  it('stops delivering after unsubscribe', () => {
    const publisher = new ChangeEventPublisher();
    const received: unknown[] = [];
    const unsubscribe = publisher.subscribe(7, (value) => received.push(value));
    publisher.publish(event(7));
    unsubscribe();
    publisher.publish(event(7));
    expect(received).toHaveLength(1);
    expect(publisher.subscriberCount).toBe(0);
  });

  it('never throws when a subscriber does — a failed delivery cannot fail the transition', () => {
    const publisher = new ChangeEventPublisher();
    publisher.subscribe(7, () => {
      throw new Error('client went away mid-write');
    });
    expect(() => publisher.publish(event(7))).not.toThrow();
  });

  it('drops a subscriber that keeps failing rather than buffering forever — §8', () => {
    const publisher = new ChangeEventPublisher();
    publisher.subscribe(7, () => {
      throw new Error('broken');
    });
    for (let index = 0; index < WATCH_MAX_QUEUE; index += 1) publisher.publish(event(7));
    expect(publisher.subscriberCount).toBe(0);
  });

  it('builds the envelope for its two producers', () => {
    const publisher = new ChangeEventPublisher();
    const received: { changeType?: string; occurredAt?: string }[] = [];
    publisher.subscribe(7, (value) => received.push(value));
    publisher.publishTransition({
      campaignId: 3,
      campaignCode: 'C3',
      tenantId: 7,
      changeType: 'UPDATED',
    });
    expect(received[0].changeType).toBe('UPDATED');
    expect(Date.parse(received[0].occurredAt as string)).not.toBeNaN();
  });

  it('maps change types onto the proto enum numbers', () => {
    expect(changeTypeNumber('UPDATED')).toBe(CHANGE_TYPE.UPDATED);
    expect(changeTypeNumber('PAUSED')).toBe(CHANGE_TYPE.PAUSED);
    expect(changeTypeNumber('ENDED')).toBe(CHANGE_TYPE.ENDED);
  });
});
