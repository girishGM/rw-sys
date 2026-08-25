import { describe, expect, it } from 'vitest';
import { render } from '@testing-library/react';
import { Skeleton } from '../../src/components/Skeleton';

describe('Skeleton', () => {
  it('TC-1: renders as a decorative, aria-hidden placeholder', () => {
    const { container } = render(<Skeleton className="h-4 w-24" />);
    const el = container.firstChild as HTMLElement;
    expect(el).toHaveAttribute('aria-hidden', 'true');
  });
});
