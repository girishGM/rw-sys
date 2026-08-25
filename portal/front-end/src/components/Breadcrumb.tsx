import type { ReactNode } from 'react';
import { ChevronRight } from 'lucide-react';
import { cx } from './internal/cx';

export interface BreadcrumbItem {
  label: string;
  href?: string;
  onClick?: () => void;
}

export interface BreadcrumbProps {
  items: BreadcrumbItem[];
  className?: string;
  /** Renders `href` items as this component (e.g. router `Link`) instead of `<a>`. */
  linkAs?: (props: { href: string; children: ReactNode; className?: string }) => JSX.Element;
}

/** T-021 — `nav[aria-label="Breadcrumb"]` + `aria-current="page"` on the final crumb. */
export function Breadcrumb({ items, className, linkAs: LinkAs }: BreadcrumbProps) {
  return (
    <nav aria-label="Breadcrumb" className={className}>
      <ol className="flex flex-wrap items-center gap-1 text-sm text-slate-500">
        {items.map((item, index) => {
          const isLast = index === items.length - 1;
          return (
            <li key={`${item.label}-${index}`} className="flex items-center gap-1">
              {index > 0 && <ChevronRight className="size-3.5 text-slate-300" aria-hidden="true" />}
              {isLast ? (
                <span aria-current="page" className="font-medium text-slate-700">
                  {item.label}
                </span>
              ) : item.href ? (
                LinkAs ? (
                  <LinkAs href={item.href} className="hover:text-slate-700 hover:underline">
                    {item.label}
                  </LinkAs>
                ) : (
                  <a href={item.href} className="hover:text-slate-700 hover:underline">
                    {item.label}
                  </a>
                )
              ) : (
                <button
                  type="button"
                  onClick={item.onClick}
                  className={cx('hover:text-slate-700 hover:underline')}
                >
                  {item.label}
                </button>
              )}
            </li>
          );
        })}
      </ol>
    </nav>
  );
}
