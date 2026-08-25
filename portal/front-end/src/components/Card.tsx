import { forwardRef, type HTMLAttributes } from 'react';
import { cx } from './internal/cx';

export type CardProps = HTMLAttributes<HTMLDivElement>;

/** T-021 — 04-FRONTEND.md §7: 10px radius, single `shadow-card` elevation. */
export const Card = forwardRef<HTMLDivElement, CardProps>(function Card(
  { className, children, ...rest },
  ref,
) {
  return (
    <div
      ref={ref}
      className={cx('rounded-card border border-slate-200 bg-white shadow-card', className)}
      {...rest}
    >
      {children}
    </div>
  );
});

export function CardHeader({ className, children, ...rest }: HTMLAttributes<HTMLDivElement>) {
  return (
    <div className={cx('border-b border-slate-200 px-6 py-4', className)} {...rest}>
      {children}
    </div>
  );
}

export function CardBody({ className, children, ...rest }: HTMLAttributes<HTMLDivElement>) {
  return (
    <div className={cx('px-6 py-4', className)} {...rest}>
      {children}
    </div>
  );
}

export function CardFooter({ className, children, ...rest }: HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      className={cx(
        'flex items-center justify-end gap-2 border-t border-slate-200 px-6 py-4',
        className,
      )}
      {...rest}
    >
      {children}
    </div>
  );
}
