/**
 * T-005 — every icon in the set renders a real 24px-viewBox stroke SVG (UI-UX-DESIGN.md
 * "Icons"), not a raster/emoji, and accepts a `className` so callers can size/colour it via
 * Tailwind (`text-accent`, `h-5 w-5`, ...).
 */
import { describe, expect, it } from 'vitest';
import { render } from '@testing-library/react';
import {
  AlertTriangleIcon,
  ArrowRightIcon,
  CalendarCheckIcon,
  CheckCircleIcon,
  ChevronDownIcon,
  ClockIcon,
  CreditCardIcon,
  GiftIcon,
  MenuIcon,
  ShoppingBagIcon,
  TagIcon,
  UserPlusIcon,
  XIcon,
  ZapIcon,
} from './index';

const ICONS = {
  ShoppingBagIcon,
  UserPlusIcon,
  CalendarCheckIcon,
  GiftIcon,
  ClockIcon,
  AlertTriangleIcon,
  ChevronDownIcon,
  ArrowRightIcon,
  CheckCircleIcon,
  CreditCardIcon,
  TagIcon,
  ZapIcon,
  // T-006
  MenuIcon,
  XIcon,
};

describe.each(Object.entries(ICONS))('%s', (_name, IconComponent) => {
  it('renders a 24x24-viewBox stroke SVG and forwards className', () => {
    const { container } = render(<IconComponent className="text-accent" data-testid="icon" />);
    const svg = container.querySelector('svg');
    expect(svg).not.toBeNull();
    expect(svg).toHaveAttribute('viewBox', '0 0 24 24');
    expect(svg).toHaveAttribute('stroke', 'currentColor');
    expect(svg).toHaveAttribute('fill', 'none');
    expect(svg).toHaveClass('text-accent');
  });
});
