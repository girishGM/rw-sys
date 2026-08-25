/**
 * T-021 — the imperative half of `Toast` (`./Toast.tsx` holds the `<Toaster/>` component
 * that must be mounted once; this is the function feature code calls to enqueue one).
 * Split into its own module — deliberately not `toast.ts` (case-insensitive filesystems,
 * still common in CI/dev, would collide with `Toast.tsx`) — so `Toast.tsx` only exports a
 * component (fast-refresh rule).
 */
export { toast } from 'sonner';
