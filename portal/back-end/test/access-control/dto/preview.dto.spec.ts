import 'reflect-metadata';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { previewRequestSchema } from '@reward-portal/shared';
import { PreviewDto } from '@/modules/access-control/dto/preview.dto';

async function isValid(body: Record<string, unknown>): Promise<boolean> {
  const errors = await validate(plainToInstance(PreviewDto, body), {
    whitelist: true,
    forbidNonWhitelisted: true,
  });
  return errors.length === 0;
}

describe('PreviewDto — implementation note 6', () => {
  it("accepts just a role — previews the role's current, committed config", async () => {
    await expect(isValid({ role: 'checker' })).resolves.toBe(true);
  });

  it('rejects an unrecognised role', async () => {
    await expect(isValid({ role: 'god_mode' })).resolves.toBe(false);
  });

  it('accepts a full draft — nav, permissions and widgets all uncommitted', async () => {
    await expect(
      isValid({
        role: 'merchant',
        nav: [
          {
            navKey: 'dashboard',
            label: 'Dashboard',
            path: '/dashboard',
            sortOrder: 10,
            enabled: true,
          },
        ],
        permissions: { campaign: ['view'] },
        widgets: [
          { widgetKey: 'kpi_active_campaigns', label: 'Active', sortOrder: 10, enabled: true },
        ],
      }),
    ).resolves.toBe(true);
  });

  it('is a subset of the shared Zod request schema', () => {
    expect(previewRequestSchema.safeParse({ role: 'checker' }).success).toBe(true);
    expect(previewRequestSchema.safeParse({ role: 'god_mode' }).success).toBe(false);
  });
});
