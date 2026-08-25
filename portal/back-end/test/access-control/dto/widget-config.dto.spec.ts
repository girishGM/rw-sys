import 'reflect-metadata';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { putWidgetConfigRequestSchema } from '@reward-portal/shared';
import { flattenValidationErrors } from '@/common/errors/validation.exception-factory';
import { PutWidgetConfigDto } from '@/modules/access-control/dto/widget-config.dto';

async function failures(body: Record<string, unknown>): Promise<Record<string, string[]>> {
  const errors = await validate(plainToInstance(PutWidgetConfigDto, body), {
    whitelist: true,
    forbidNonWhitelisted: true,
  });
  const flat: Record<string, string[]> = {};
  for (const detail of flattenValidationErrors(errors)) {
    flat[detail.field] = [...(flat[detail.field] ?? []), detail.code];
  }
  return flat;
}

function validBody(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    expectedVersion: 1,
    items: [{ widgetKey: 'kpi_my_drafts', label: 'My Drafts', sortOrder: 10, enabled: true }],
    ...overrides,
  };
}

describe('PutWidgetConfigDto', () => {
  it('accepts a minimal valid body', async () => {
    await expect(failures(validBody())).resolves.toEqual({});
  });

  it('accepts an empty items array', async () => {
    await expect(failures(validBody({ items: [] }))).resolves.toEqual({});
  });

  it('accepts a free-form config object', async () => {
    await expect(
      failures(
        validBody({
          items: [
            {
              widgetKey: 'chart_campaign_performance',
              label: 'Performance',
              config: { chartType: 'bar', metrics: ['clicks'] },
              sortOrder: 30,
              enabled: true,
            },
          ],
        }),
      ),
    ).resolves.toEqual({});
  });

  it('rejects a config that is not a plain object', async () => {
    const result = await failures(
      validBody({
        items: [{ widgetKey: 'x', label: 'X', config: [1, 2], sortOrder: 1, enabled: true }],
      }),
    );
    expect(result['items[0].config']).toContain('IS_WIDGET_CONFIG');
  });

  it('rejects an upper-case widgetKey', async () => {
    const result = await failures(
      validBody({ items: [{ widgetKey: 'KPI', label: 'X', sortOrder: 1, enabled: true }] }),
    );
    expect(result['items[0].widgetKey']).toContain('MATCHES');
  });

  it('is a subset of the shared Zod request schema', () => {
    expect(putWidgetConfigRequestSchema.safeParse(validBody()).success).toBe(true);
  });
});
