/**
 * T-013 — `PermissionRepository`, driven against a stubbed `Sequelize`, exactly as
 * `session.repository.spec.ts` and `credential.repository.spec.ts` are.
 *
 * A statement-shape test, not a SQL-correctness test. What it pins:
 *
 *  - every caller-supplied value arrives as a **bound replacement**; there is no interpolation
 *    anywhere in this file's SQL, not even the frozen-literal exception `session.repository.ts`
 *    documents;
 *  - the `actions` blob is parsed defensively — a corrupt row grants nothing rather than
 *    everything;
 *  - the version bump is arithmetic **in SQL**, so two concurrent permission edits cannot both
 *    read the same value and publish only one invalidation.
 *
 * Whether these statements return the right rows against real Postgres is `rbac.e2e-spec.ts`'s
 * job.
 */
import type { Sequelize } from 'sequelize-typescript';
import { PermissionRepository, parseActions } from '@/common/rbac';

interface RecordedQuery {
  sql: string;
  options: { replacements?: Record<string, unknown> };
}

class StubSequelize {
  readonly calls: RecordedQuery[] = [];
  responses: unknown[] = [];

  async query(sql: string, options: RecordedQuery['options']): Promise<unknown> {
    this.calls.push({ sql, options });
    return this.responses.shift() ?? [];
  }

  asSequelize(): Sequelize {
    return this as unknown as Sequelize;
  }

  get lastCall(): RecordedQuery {
    const call = this.calls.at(-1);
    if (call === undefined) throw new Error('no query was executed');
    return call;
  }

  /** Whitespace-normalised, for readable substring assertions. */
  get lastSql(): string {
    return this.lastCall.sql.replace(/\s+/g, ' ').trim();
  }
}

function build(): { db: StubSequelize; repository: PermissionRepository } {
  const db = new StubSequelize();
  return { db, repository: new PermissionRepository(db.asSequelize()) };
}

describe('PermissionRepository', () => {
  describe('findGrantsForRole', () => {
    it('binds the role rather than interpolating it', async () => {
      const { db, repository } = build();
      db.responses = [[]];

      await repository.findGrantsForRole('maker');

      expect(db.lastCall.options.replacements).toEqual({ role: 'maker' });
      expect(db.lastSql).toContain('role = :role');
      expect(db.lastSql).not.toContain("'maker'");
    });

    it('reads the whole matrix in one query', async () => {
      const { db, repository } = build();
      db.responses = [[]];

      await repository.findGrantsForRole('maker');
      expect(db.calls).toHaveLength(1);
    });

    it('parses the packed actions array', async () => {
      const { db, repository } = build();
      db.responses = [[{ entity: 'campaign', actions: '["view","create"]' }]];

      await expect(repository.findGrantsForRole('maker')).resolves.toEqual([
        { entity: 'campaign', actions: ['view', 'create'] },
      ]);
    });

    it('returns an empty grant for a corrupt actions blob, never a wide one', async () => {
      const { db, repository } = build();
      db.responses = [[{ entity: 'campaign', actions: 'not json' }]];

      await expect(repository.findGrantsForRole('maker')).resolves.toEqual([
        { entity: 'campaign', actions: [] },
      ]);
    });
  });

  describe('parseActions', () => {
    it('parses a well-formed array', () => {
      expect(parseActions('["view","create"]')).toEqual(['view', 'create']);
    });

    it('returns nothing for null', () => {
      expect(parseActions(null)).toEqual([]);
    });

    it('returns nothing for malformed JSON', () => {
      expect(parseActions('["view"')).toEqual([]);
    });

    it('returns nothing for valid JSON that is not an array', () => {
      expect(parseActions('{"view":true}')).toEqual([]);
      expect(parseActions('"view"')).toEqual([]);
      expect(parseActions('42')).toEqual([]);
    });

    it('drops non-string entries rather than coercing them', () => {
      // `[1, "view"]` grants `view` and nothing numeric. Coercion would invent an action named
      // "1", which no route requires but which would still be a surprising grant to explain.
      expect(parseActions('[1,"view",null,{"a":1}]')).toEqual(['view']);
    });

    it('handles the empty array', () => {
      expect(parseActions('[]')).toEqual([]);
    });
  });

  describe('readRbacVersion', () => {
    it('binds the composed config key', async () => {
      const { db, repository } = build();
      db.responses = [[{ config_value: '4' }]];

      await expect(repository.readRbacVersion('maker')).resolves.toBe(4);
      expect(db.lastCall.options.replacements).toEqual({ key: 'rbac_version:maker' });
    });

    it('returns 0 when the row is absent', async () => {
      const { db, repository } = build();
      db.responses = [[]];

      await expect(repository.readRbacVersion('maker')).resolves.toBe(0);
    });

    it('returns 0 for an unparseable value', async () => {
      const { db, repository } = build();
      db.responses = [[{ config_value: 'oops' }]];

      await expect(repository.readRbacVersion('maker')).resolves.toBe(0);
    });
  });

  describe('readTtlSeconds', () => {
    it('reads the global key', async () => {
      const { db, repository } = build();
      db.responses = [[{ config_value: '300' }]];

      await expect(repository.readTtlSeconds()).resolves.toBe(300);
      expect(db.lastCall.options.replacements).toEqual({ key: 'rbac_ttl_seconds' });
    });

    it('returns null when the row is absent, so the caller applies its default', async () => {
      const { db, repository } = build();
      db.responses = [[]];

      await expect(repository.readTtlSeconds()).resolves.toBeNull();
    });

    it('returns null for an unparseable value', async () => {
      const { db, repository } = build();
      db.responses = [[{ config_value: 'soon' }]];

      await expect(repository.readTtlSeconds()).resolves.toBeNull();
    });

    it('rejects a non-positive TTL — a zero or negative TTL would disable the cache silently', async () => {
      const { db, repository } = build();
      db.responses = [[{ config_value: '0' }]];
      await expect(repository.readTtlSeconds()).resolves.toBeNull();

      db.responses = [[{ config_value: '-5' }]];
      await expect(repository.readTtlSeconds()).resolves.toBeNull();
    });
  });

  describe('bumpRbacVersion', () => {
    it('increments arithmetically in SQL, not read-modify-write', async () => {
      const { db, repository } = build();
      db.responses = [[{ config_value: '5' }]];

      await expect(repository.bumpRbacVersion('maker')).resolves.toBe(5);

      // One statement, and the arithmetic is inside it. A JS-side increment would let two
      // concurrent edits both read 4 and both write 5.
      expect(db.calls).toHaveLength(1);
      expect(db.lastSql).toContain('+ 1');
      expect(db.lastCall.options.replacements).toEqual({ key: 'rbac_version:maker' });
    });

    it('upserts, so a missing counter row does not make a permission edit unpublishable', async () => {
      const { db, repository } = build();
      db.responses = [[{ config_value: '1' }]];

      await repository.bumpRbacVersion('maker');
      expect(db.lastSql).toContain('ON CONFLICT (config_key) DO UPDATE');
    });

    it('resets a non-numeric value to 1 rather than erroring the caller’s transaction', async () => {
      const { db, repository } = build();
      db.responses = [[{ config_value: '1' }]];

      await repository.bumpRbacVersion('maker');
      // The regex guard is what stops `::bigint` from aborting the whole transaction on a
      // hand-edited value.
      expect(db.lastSql).toContain("~ '^[0-9]+$'");
    });

    it('returns 0 if the database somehow returns an unparseable new value', async () => {
      const { db, repository } = build();
      db.responses = [[{ config_value: 'x' }]];

      await expect(repository.bumpRbacVersion('maker')).resolves.toBe(0);
    });
  });

  describe('no interpolation anywhere', () => {
    it('every statement this repository issues uses only bound replacements', async () => {
      const { db, repository } = build();
      db.responses = [
        [],
        [{ config_value: '1' }],
        [{ config_value: '1' }],
        [{ config_value: '1' }],
      ];

      await repository.findGrantsForRole('maker');
      await repository.readRbacVersion('maker');
      await repository.readTtlSeconds();
      await repository.bumpRbacVersion('maker');

      for (const call of db.calls) {
        // No role name, no composed key, and no value from a replacement map ever appears in the
        // SQL text itself.
        expect(call.sql).not.toContain('maker');
        expect(call.sql).not.toContain('rbac_version:maker');
      }
    });
  });
});
