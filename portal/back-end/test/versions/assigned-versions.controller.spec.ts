/**
 * T-041 — `AssignedVersionsController`: `GET /countries/:id/assigned-versions` reuses
 * `country:view` — see that controller's own header for why.
 */
import 'reflect-metadata';
import { PERMISSION_METADATA_KEY } from '@/common/rbac/rbac.constants';
import { AssignedVersionsController } from '@/modules/versions/assigned-versions.controller';
import type { AssignedVersionsService } from '@/modules/versions/assigned-versions.service';

describe('AssignedVersionsController', () => {
  it('reuses country:view', () => {
    const meta = Reflect.getMetadata(
      PERMISSION_METADATA_KEY,
      AssignedVersionsController.prototype.list,
    ) as { entity: string; action: string };
    expect(meta).toEqual({ entity: 'country', action: 'view' });
  });

  it('list() delegates the country id and wraps the result', async () => {
    const listForCountry = jest.fn().mockResolvedValue([{ entityType: 'rule' }]);
    const controller = new AssignedVersionsController({
      listForCountry,
    } as unknown as AssignedVersionsService);

    const response = await controller.list(7);

    expect(listForCountry).toHaveBeenCalledWith(7);
    expect(response.data).toHaveLength(1);
  });
});
