/**
 * T-005 — tiny class-name joiner shared by this task's own components (`Card`/`ProgressBar`/
 * `Badge`/`ThemeSwitcher`). No `clsx`/`tailwind-merge` dependency added for it — this task's
 * file scope is `src/components/**`/`src/styles/**`, not `package.json`, and a one-line filter
 * + join covers everything these components need.
 */
export function cx(...classes: Array<string | false | null | undefined>): string {
  return classes.filter(Boolean).join(' ');
}
