/**
 * T-003 — a minimal in-memory cookie jar.
 *
 * `fetch` (Node 20's built-in `undici` implementation) does not manage cookies for the caller the
 * way a browser does, and this client is a Node process, not a browser — so `portal/back-end`'s
 * `Set-Cookie` triple (`__Host-rs_at`/`__Host-rs_rt`/`rs_csrf`, `auth.controller.ts`'s
 * `setSessionCookies`) has to be captured and replayed by hand. Only name/value pairs are kept;
 * attributes (`Path`, `Secure`, `SameSite`, ...) are meaningless for a same-process server-to-server
 * client and are discarded, exactly like a client would that only cares about round-tripping the
 * cookie itself.
 */
export class CookieJar {
  private readonly cookies = new Map<string, string>();

  /** Parses every `Set-Cookie` header from a response (`Response.headers.getSetCookie()`) and
   * stores/overwrites each named cookie. */
  applySetCookie(setCookieHeaders: readonly string[]): void {
    for (const header of setCookieHeaders) {
      const [pair] = header.split(';');
      const separatorIndex = pair.indexOf('=');
      if (separatorIndex === -1) continue;
      const name = pair.slice(0, separatorIndex).trim();
      const value = pair.slice(separatorIndex + 1).trim();
      if (name.length === 0) continue;
      this.cookies.set(name, value);
    }
  }

  /** Every cookie is dropped, e.g. before a fresh login so a stale/rejected session cookie is
   * never accidentally reused. */
  clear(): void {
    this.cookies.clear();
  }

  get isEmpty(): boolean {
    return this.cookies.size === 0;
  }

  /** The `Cookie` request header value, or `''` when nothing has been captured yet. */
  toHeader(): string {
    return [...this.cookies.entries()].map(([name, value]) => `${name}=${value}`).join('; ');
  }
}
