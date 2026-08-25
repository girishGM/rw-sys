/**
 * T-049 — the transcript (architecture.html §14's `.chat` column).
 *
 * ### Assistant output is untrusted input to this DOM
 *
 * Implementation note 8, and the first test written for this task (TC-13): *"never render
 * assistant output as HTML"*. Every bubble below renders `{message.text}` as a JSX child, which
 * React escapes — `<script>alert(1)</script>` becomes eight visible characters and a `<script>`
 * element that never exists. There is deliberately **no** `dangerouslySetInnerHTML`, no markdown
 * renderer and no sanitiser anywhere in this feature: a sanitiser would imply markup is expected
 * here, and the wire contract already says it is not (`agentTurnSchema.reply` — *"plain text.
 * **Never HTML**"*). `test/features/campaign-agent/noDangerousHtml.spec.ts` asserts this at the
 * source level so a later "let's support bold text" cannot quietly reintroduce it.
 *
 * ### Bounded DOM, not a virtual scroller (TC-21)
 *
 * A 50-turn conversation must stay smooth. Rather than pull in a windowing dependency for a list
 * that is append-only and read top-to-bottom, the stream renders the most recent
 * {@link VISIBLE_MESSAGE_WINDOW} turns and puts the rest behind one "Show earlier messages"
 * button. The DOM node count is bounded by a constant either way, which is the property that
 * actually matters for scroll performance, and the earlier turns remain reachable — a chat that
 * silently discards what was said would be a chat whose transcript disagrees with the server's
 * (§7).
 *
 * ### Announcement
 *
 * The list is `aria-live="polite"` so a new reply is read out without stealing focus, and
 * `aria-busy` while a turn is in flight so a screen reader is told the assistant is still working
 * rather than that nothing happened.
 */
import { useEffect, useRef, useState } from 'react';
import type { AgentChatMessage } from './useAgentSession';

/** How many turns stay in the DOM. See this file's header. */
export const VISIBLE_MESSAGE_WINDOW = 20;

export interface MessageStreamProps {
  readonly messages: readonly AgentChatMessage[];
  /** Renders the typing indicator (implementation note 6). */
  readonly busy: boolean;
}

const ROLE_LABEL: Readonly<Record<AgentChatMessage['role'], string>> = {
  user: 'You',
  assistant: 'Assistant',
  system: 'Portal',
};

const ROLE_CLASSES: Readonly<Record<AgentChatMessage['role'], string>> = {
  user: 'self-end bg-primary-600 text-white',
  assistant: 'self-start bg-white text-slate-800 border border-slate-200',
  system: 'self-start bg-slate-100 text-slate-700 border border-slate-200',
};

export function MessageStream({ messages, busy }: MessageStreamProps) {
  const [showAll, setShowAll] = useState(false);
  const endRef = useRef<HTMLDivElement>(null);

  const hidden = showAll ? 0 : Math.max(0, messages.length - VISIBLE_MESSAGE_WINDOW);
  const visible = hidden === 0 ? messages : messages.slice(hidden);

  useEffect(() => {
    const node = endRef.current;
    // jsdom implements neither `scrollIntoView` nor layout; the guard keeps the component honest
    // in tests without pretending the browser behaviour is optional.
    if (node !== null && typeof node.scrollIntoView === 'function') {
      node.scrollIntoView({ block: 'end' });
    }
  }, [messages.length, busy]);

  return (
    <div className="flex max-h-[28rem] flex-col gap-3 overflow-y-auto p-4">
      {hidden > 0 && (
        <button
          type="button"
          onClick={() => {
            setShowAll(true);
          }}
          className="self-center rounded-control px-3 py-1 text-xs font-medium text-primary-700 underline hover:bg-slate-100"
        >
          Show {hidden} earlier message{hidden === 1 ? '' : 's'}
        </button>
      )}

      <ol
        aria-live="polite"
        aria-busy={busy || undefined}
        aria-label="Conversation with the assistant"
        className="flex list-none flex-col gap-3"
      >
        {visible.map((message) => (
          <li
            key={message.id}
            className={`flex max-w-[88%] flex-col gap-1 rounded-card px-3 py-2 text-sm ${ROLE_CLASSES[message.role]}`}
          >
            <span
              className={
                message.role === 'user'
                  ? 'text-xs font-semibold text-primary-100'
                  : 'text-xs font-semibold text-slate-500'
              }
            >
              {ROLE_LABEL[message.role]}
            </span>
            {/* Plain text. See this file's header — no `dangerouslySetInnerHTML`, ever. */}
            <span className="whitespace-pre-wrap break-words">{message.text}</span>
          </li>
        ))}
      </ol>

      {busy && (
        <p role="status" className="self-start text-sm text-slate-500">
          <span aria-hidden="true" className="mr-2 inline-flex gap-1">
            <span className="inline-block size-1.5 animate-pulse rounded-full bg-slate-400" />
            <span className="inline-block size-1.5 animate-pulse rounded-full bg-slate-400" />
            <span className="inline-block size-1.5 animate-pulse rounded-full bg-slate-400" />
          </span>
          The assistant is typing…
        </p>
      )}

      <div ref={endRef} />
    </div>
  );
}
