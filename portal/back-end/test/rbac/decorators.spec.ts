/**
 * T-013 — the two decorators and the metadata reader they feed.
 *
 * Small surface, but two of the assertions matter more than their size suggests: that the
 * decorators reject an empty argument list at *startup* rather than producing a route nobody can
 * reach, and that `getAllAndOverride` really does give the handler the last word.
 */
import { Controller, Get } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { Public } from '@/modules/auth/decorators/public.decorator';
import {
  PERMISSION_METADATA_KEY,
  ROLES_METADATA_KEY,
  RequirePermission,
  Roles,
  isRouteUnguarded,
  readRouteAuthorisation,
} from '@/common/rbac';
import { contextFor } from './support/execution-context';

@Controller('x')
@Roles('super_admin')
class Sample {
  @Get('a')
  inherited(): void {}

  @Get('b')
  @Roles('maker', 'checker')
  overridden(): void {}

  @Get('c')
  @RequirePermission('campaign', 'create')
  permissionOnly(): void {}

  @Get('d')
  @Roles('maker')
  @RequirePermission('campaign', 'update')
  both(): void {}
}

@Controller('y')
class Bare {
  @Get('a')
  unguarded(): void {}

  @Get('b')
  @Public()
  open(): void {}
}

describe('@Roles', () => {
  it('writes the namespaced metadata key', () => {
    expect(Reflect.getMetadata(ROLES_METADATA_KEY, Sample.prototype.overridden)).toEqual([
      'maker',
      'checker',
    ]);
  });

  it('refuses an empty role list at startup', () => {
    // An empty allow-list is far more likely to be an unfinished edit than a deliberate
    // statement, and guessing wrong leaves an open endpoint.
    expect(() => Roles()).toThrow(/requires at least one role/);
  });

  it('points the reader at @Public() for the genuine "no role needed" case', () => {
    expect(() => Roles()).toThrow(/@Public\(\)/);
  });
});

describe('@RequirePermission', () => {
  it('writes the entity/action pair', () => {
    expect(Reflect.getMetadata(PERMISSION_METADATA_KEY, Sample.prototype.permissionOnly)).toEqual({
      entity: 'campaign',
      action: 'create',
    });
  });

  it('refuses a blank entity', () => {
    expect(() => RequirePermission('  ', 'create')).toThrow(/non-empty entity and action/);
  });

  it('refuses a blank action', () => {
    expect(() => RequirePermission('campaign', '')).toThrow(/non-empty entity and action/);
  });
});

describe('readRouteAuthorisation', () => {
  const reflector = new Reflector();

  it('falls back to class-level roles', () => {
    const authorisation = readRouteAuthorisation(reflector, contextFor(Sample, 'inherited'));
    expect(authorisation.roles).toEqual(['super_admin']);
  });

  it('lets handler-level roles override the class’s entirely', () => {
    const authorisation = readRouteAuthorisation(reflector, contextFor(Sample, 'overridden'));
    expect(authorisation.roles).toEqual(['maker', 'checker']);
  });

  it('reads both kinds of metadata when both are present', () => {
    const authorisation = readRouteAuthorisation(reflector, contextFor(Sample, 'both'));
    expect(authorisation.roles).toEqual(['maker']);
    expect(authorisation.permission).toEqual({ entity: 'campaign', action: 'update' });
  });

  it('reports undefined for metadata that is absent', () => {
    const authorisation = readRouteAuthorisation(reflector, contextFor(Bare, 'unguarded'));
    expect(authorisation.roles).toBeUndefined();
    expect(authorisation.permission).toBeUndefined();
  });
});

describe('isRouteUnguarded', () => {
  const reflector = new Reflector();

  it('is true only when neither decorator is present', () => {
    expect(isRouteUnguarded(readRouteAuthorisation(reflector, contextFor(Bare, 'unguarded')))).toBe(
      true,
    );
  });

  it('is false for a route with @Roles alone (TC-1’s shape)', () => {
    expect(
      isRouteUnguarded(readRouteAuthorisation(reflector, contextFor(Sample, 'inherited'))),
    ).toBe(false);
  });

  it('is false for a route with @RequirePermission alone', () => {
    expect(
      isRouteUnguarded(readRouteAuthorisation(reflector, contextFor(Sample, 'permissionOnly'))),
    ).toBe(false);
  });

  it('is true for a @Public() route too — the guards check @Public() first', () => {
    // Deliberate: `isRouteUnguarded` answers only "is there authorisation metadata?". Both
    // guards test `isPublic()` before consulting it, so a public route never reaches this branch.
    expect(isRouteUnguarded(readRouteAuthorisation(reflector, contextFor(Bare, 'open')))).toBe(
      true,
    );
  });
});
