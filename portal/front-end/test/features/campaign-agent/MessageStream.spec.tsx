/**
 * T-049 — `MessageStream`: TC-13, TC-14 (assistant output is text, never markup), TC-21 (a long
 * conversation stays bounded) and the `aria-live` announcement of implementation note 7.
 *
 * TC-13 is first in the file because the task file says to write it first: *"assistant output is
 * untrusted input to your DOM"*. Everything else in this component is a rendering decision; this
 * one is a security property.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import {
  MessageStream,
  VISIBLE_MESSAGE_WINDOW,
} from '../../../src/features/campaign-agent/MessageStream';
import type { AgentChatMessage } from '../../../src/features/campaign-agent/useAgentSession';

function messages(...texts: readonly string[]): AgentChatMessage[] {
  return texts.map((text, index) => ({
    id: `m-${String(index)}`,
    role: index % 2 === 0 ? 'assistant' : 'user',
    text,
  }));
}

afterEach(() => {
  cleanup();
});

describe('TC-13 — assistant text containing markup is rendered as text, never parsed', () => {
  it('a <script> tag becomes visible characters and no script element', () => {
    const payload = '<script>alert("xss")</script>';
    const { container } = render(<MessageStream messages={messages(payload)} busy={false} />);

    expect(screen.getByText(payload)).toBeInTheDocument();
    expect(container.querySelector('script')).toBeNull();
  });

  it('an <img onerror=…> payload creates no element and no attribute', () => {
    const payload = '<img src=x onerror="fetch(\'https://evil.example\')">';
    const { container } = render(<MessageStream messages={messages(payload)} busy={false} />);

    expect(screen.getByText(payload)).toBeInTheDocument();
    expect(container.querySelector('img')).toBeNull();
    // No *element* carries the handler: the payload survives only as escaped text, which is what
    // `&lt;img` in the serialised HTML proves.
    expect(container.querySelector('[onerror]')).toBeNull();
    expect(container.innerHTML).toContain('&lt;img');
  });

  it('an <iframe> payload is inert too', () => {
    const payload = '<iframe src="https://evil.example"></iframe>';
    const { container } = render(<MessageStream messages={messages(payload)} busy={false} />);

    expect(screen.getByText(payload)).toBeInTheDocument();
    expect(container.querySelector('iframe')).toBeNull();
  });
});

describe('TC-14 — markdown and HTML entities are escaped, not interpreted', () => {
  it('markdown emphasis stays literal', () => {
    render(<MessageStream messages={messages('**bold** and _italic_ and `code`')} busy={false} />);

    expect(screen.getByText('**bold** and _italic_ and `code`')).toBeInTheDocument();
    expect(document.querySelector('strong')).toBeNull();
    expect(document.querySelector('em')).toBeNull();
  });

  it('a markdown link is not turned into an anchor', () => {
    const { container } = render(
      <MessageStream messages={messages('[click me](https://evil.example)')} busy={false} />,
    );

    expect(screen.getByText('[click me](https://evil.example)')).toBeInTheDocument();
    expect(container.querySelector('a')).toBeNull();
  });

  it('an HTML entity is shown as the characters the assistant sent', () => {
    render(<MessageStream messages={messages('&lt;b&gt;not bold&lt;/b&gt;')} busy={false} />);

    expect(screen.getByText('&lt;b&gt;not bold&lt;/b&gt;')).toBeInTheDocument();
  });
});

describe('announcement and the typing indicator', () => {
  it('the message list is a polite live region', () => {
    render(<MessageStream messages={messages('Hello')} busy={false} />);

    const list = screen.getByRole('list', { name: 'Conversation with the assistant' });
    expect(list).toHaveAttribute('aria-live', 'polite');
  });

  it('shows a status while a turn is in flight, and marks the list busy', () => {
    render(<MessageStream messages={messages('Hello')} busy />);

    expect(screen.getByRole('status')).toHaveTextContent('The assistant is typing…');
    expect(screen.getByRole('list', { name: 'Conversation with the assistant' })).toHaveAttribute(
      'aria-busy',
      'true',
    );
  });

  it('shows no typing indicator when nothing is in flight', () => {
    render(<MessageStream messages={messages('Hello')} busy={false} />);

    expect(screen.queryByRole('status')).not.toBeInTheDocument();
  });

  it('names who said what, so the two sides are distinguishable without colour', () => {
    render(<MessageStream messages={messages('From the assistant', 'From me')} busy={false} />);

    const items = screen.getAllByRole('listitem');
    expect(within(items[0]).getByText('Assistant')).toBeInTheDocument();
    expect(within(items[1]).getByText('You')).toBeInTheDocument();
  });
});

describe('TC-21 — a 50-message conversation stays bounded', () => {
  const fifty = messages(...Array.from({ length: 50 }, (_, index) => `Message ${String(index)}`));

  it('renders only the most recent window, newest last', () => {
    render(<MessageStream messages={fifty} busy={false} />);

    expect(screen.getAllByRole('listitem')).toHaveLength(VISIBLE_MESSAGE_WINDOW);
    expect(screen.getByText('Message 49')).toBeInTheDocument();
    expect(screen.queryByText('Message 0')).not.toBeInTheDocument();
  });

  it('offers the earlier turns rather than discarding them', async () => {
    const user = userEvent.setup();
    render(<MessageStream messages={fifty} busy={false} />);

    await user.click(screen.getByRole('button', { name: /Show 30 earlier messages/ }));

    expect(screen.getAllByRole('listitem')).toHaveLength(50);
    expect(screen.getByText('Message 0')).toBeInTheDocument();
  });

  it('shows no "earlier messages" control for a short conversation', () => {
    render(<MessageStream messages={messages('one', 'two')} busy={false} />);

    expect(screen.queryByRole('button', { name: /earlier message/ })).not.toBeInTheDocument();
  });
});
