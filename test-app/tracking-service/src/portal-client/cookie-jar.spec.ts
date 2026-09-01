import { CookieJar } from './cookie-jar';

describe('CookieJar', () => {
  it('captures name=value from a real Set-Cookie header, dropping attributes', () => {
    const jar = new CookieJar();
    jar.applySetCookie([
      '__Host-rs_at=abc123; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=900',
      'rs_csrf=xyz; Secure; SameSite=Strict; Path=/',
    ]);

    expect(jar.toHeader()).toBe('__Host-rs_at=abc123; rs_csrf=xyz');
  });

  it('overwrites a cookie of the same name on a later Set-Cookie', () => {
    const jar = new CookieJar();
    jar.applySetCookie(['a=first']);
    jar.applySetCookie(['a=second']);

    expect(jar.toHeader()).toBe('a=second');
  });

  it('clear() empties the jar', () => {
    const jar = new CookieJar();
    jar.applySetCookie(['a=b']);
    jar.clear();

    expect(jar.isEmpty).toBe(true);
    expect(jar.toHeader()).toBe('');
  });
});
