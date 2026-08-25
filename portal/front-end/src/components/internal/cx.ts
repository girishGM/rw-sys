/**
 * T-021 — thin re-export of `clsx` so every component imports class-name merging from one
 * internal module. If a future task needs `tailwind-merge`-style de-duplication, this is
 * the single place that changes.
 */
export { default as cx } from 'clsx';
