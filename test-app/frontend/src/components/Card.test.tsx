/**
 * T-005 — TC-6: `Card` carries the `.glass` treatment (tokens.css) plus the `rounded-card`
 * radius, in every theme (the class list itself is theme-independent — `tokens.css`'s
 * `[data-theme="…"]` blocks are what actually change the rendered colours, verified separately
 * by `styles/tokens.test.ts`).
 */
import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { Card } from './Card';

describe('Card', () => {
  it('applies the glass treatment and card radius', () => {
    render(<Card data-testid="card">content</Card>);
    const card = screen.getByTestId('card');
    expect(card).toHaveClass('glass');
    expect(card).toHaveClass('rounded-card');
  });

  it('merges a caller-provided className rather than replacing the built-in ones', () => {
    render(
      <Card data-testid="card" className="p-6">
        content
      </Card>,
    );
    const card = screen.getByTestId('card');
    expect(card).toHaveClass('glass');
    expect(card).toHaveClass('p-6');
  });

  it('forwards a ref to the underlying element', () => {
    let node: HTMLDivElement | null = null;
    render(
      <Card
        ref={(el) => {
          node = el;
        }}
      >
        content
      </Card>,
    );
    expect(node).not.toBeNull();
  });
});
