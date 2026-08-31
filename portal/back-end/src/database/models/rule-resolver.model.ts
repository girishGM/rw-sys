import { Column, CreatedAt, DataType, Model, Table, UpdatedAt } from 'sequelize-typescript';
import { parseJsonColumn, stringifyJsonColumn } from '../util/json-text.util';

/**
 * `reward_config.rule_resolvers` — T-102. Declares *how* to fetch a fact from a specific data
 * source (JSONPath on the event payload, sibling tracker-component lookup, aggregate SQL,
 * cached customer-profile API, schedule context). Inert metadata from this portal's point of
 * view — nothing here instantiates `handler_class`; a different microservice does that,
 * generically, by reading this table. See `rule-engine-mapped-design.md` §1.3/§2.1.
 */
@Table({
  schema: 'reward_config',
  tableName: 'rule_resolvers',
  underscored: true,
  timestamps: true,
  createdAt: 'created_at',
  updatedAt: 'updated_at',
})
export class RuleResolver extends Model<RuleResolver> {
  @Column({ type: DataType.INTEGER, autoIncrement: true, primaryKey: true })
  declare id: number;

  @Column({ type: DataType.STRING(50), allowNull: false, field: 'resolver_code' })
  declare resolverCode: string;

  @Column({ type: DataType.STRING(200), allowNull: false })
  declare name: string;

  @Column({ type: DataType.STRING(500), allowNull: true })
  declare description: string | null;

  @Column({ type: DataType.STRING(200), allowNull: false, field: 'handler_class' })
  declare handlerClass: string;

  /** JSON Schema text — read verbatim, never parsed by this portal. */
  @Column({ type: DataType.TEXT, allowNull: false, field: 'input_schema' })
  declare inputSchema: string;

  @Column({ type: DataType.STRING(20), allowNull: false, defaultValue: 'active' })
  declare status: string;

  /**
   * T-114 — JSON array of `rule_master.parameters`/`rule_versions.parameters` field `key`
   * strings this resolver consumes as *input* to its own lookup, rather than compares a
   * resolved fact against. Tolerant getter/setter, same discipline `rule-master.model.ts#
   * parameters` documents — malformed or absent content never throws, it falls back to `[]`
   * (no wired input fields), which is also the correct reading for a resolver seeded before
   * this column existed.
   */
  @Column(DataType.TEXT)
  get resolverInputFieldKeys(): readonly string[] {
    return parseJsonColumn(this.getDataValue('resolverInputFieldKeys'), []);
  }
  set resolverInputFieldKeys(value: readonly string[]) {
    this.setDataValue(
      'resolverInputFieldKeys',
      stringifyJsonColumn(value) as unknown as readonly string[],
    );
  }

  @CreatedAt
  @Column({ type: DataType.DATE, field: 'created_at' })
  declare createdAt: Date;

  @UpdatedAt
  @Column({ type: DataType.DATE, field: 'updated_at' })
  declare updatedAt: Date;
}
