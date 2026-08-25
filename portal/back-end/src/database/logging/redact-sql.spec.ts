import { redactSql } from './redact-sql';

describe('redactSql (T-003 TC-10)', () => {
  it('replaces positional bind placeholders, keeping the statement shape', () => {
    const sql =
      'SELECT * FROM reward_portal.portal_user_credentials WHERE id = $1 AND user_id = $2';
    expect(redactSql(sql)).toBe(
      'SELECT * FROM reward_portal.portal_user_credentials WHERE id = $? AND user_id = $?',
    );
  });

  it('redacts an inlined VALUES tuple so a password hash never reaches the log', () => {
    const sql =
      "INSERT INTO reward_portal.portal_user_credentials (user_id, password_hash) VALUES (1, 'argon2id$v=19$...')";
    const redacted = redactSql(sql);
    expect(redacted).not.toContain('argon2id');
    expect(redacted).toContain('VALUES (…)');
  });

  it('leaves SQL with no bind parameters or VALUES tuple untouched', () => {
    const sql = 'SELECT count(*) FROM reward_config.countries';
    expect(redactSql(sql)).toBe(sql);
  });
});
