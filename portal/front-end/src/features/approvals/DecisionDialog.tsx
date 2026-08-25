/**
 * T-038 — the comment dialog behind Approve / Reject / Return.
 *
 * ### Why rejecting and returning force a comment and approving does not
 *
 * Implementation note 4, 03-API-CONTRACT.md §12. Approving is agreeing with what the maker already
 * documented; rejecting or returning changes someone else's work and owes them a reason. The
 * asymmetry lives in one constant below (`requiresComment`) and in the shared schema the server
 * re-parses, so the disabled Confirm button and the server's 400 are the same rule rather than two
 * rules that happen to agree today.
 *
 * The 500-character bound is `APPROVAL_COMMENT_MAX_LENGTH`, imported — the same number the DTO's
 * `@MaxLength` and `varchar(500)` use. A counter is shown from 400 characters on, because a
 * checker who writes past the limit and then loses the text is a checker who stops writing
 * comments.
 */
import { useEffect, useId, useState } from 'react';
import { APPROVAL_COMMENT_MAX_LENGTH } from '@reward-portal/shared';
import { Button } from '../../components/Button';
import { Modal } from '../../components/Modal';

export type Decision = 'approve' | 'reject' | 'return';

const COPY: Record<
  Decision,
  { title: string; description: string; confirm: string; requiresComment: boolean }
> = {
  approve: {
    title: 'Approve this campaign',
    description: 'The campaign becomes active immediately and its maker is notified.',
    confirm: 'Approve',
    requiresComment: false,
  },
  reject: {
    title: 'Reject this campaign',
    description:
      'This submission is closed. The maker keeps the campaign as a draft and must submit again.',
    confirm: 'Reject',
    requiresComment: true,
  },
  return: {
    title: 'Return this campaign for rework',
    description: 'The maker can edit and resubmit. Tell them what needs to change.',
    confirm: 'Return',
    requiresComment: true,
  },
};

export interface DecisionDialogProps {
  readonly decision: Decision | null;
  readonly isPending: boolean;
  /** Server-side failure text, shown in the dialog rather than swallowed. */
  readonly error: string | null;
  readonly onClose: () => void;
  readonly onConfirm: (comment: string) => void;
}

export function DecisionDialog({
  decision,
  isPending,
  error,
  onClose,
  onConfirm,
}: DecisionDialogProps) {
  const [comment, setComment] = useState('');
  const commentId = useId();

  // A fresh dialog starts empty: carrying a rejection reason into the next approval would be a
  // very bad kind of convenience.
  useEffect(() => {
    setComment('');
  }, [decision]);

  if (decision === null) return null;

  const copy = COPY[decision];
  const trimmed = comment.trim();
  const tooLong = comment.length > APPROVAL_COMMENT_MAX_LENGTH;
  const missing = copy.requiresComment && trimmed === '';
  const remaining = APPROVAL_COMMENT_MAX_LENGTH - comment.length;

  return (
    <Modal
      open
      onClose={onClose}
      title={copy.title}
      description={copy.description}
      footer={
        <>
          <Button type="button" variant="secondary" onClick={onClose} disabled={isPending}>
            Cancel
          </Button>
          <Button
            type="button"
            variant={decision === 'reject' ? 'danger' : 'primary'}
            disabled={missing || tooLong}
            isLoading={isPending}
            onClick={() => {
              onConfirm(trimmed);
            }}
          >
            {copy.confirm}
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-2">
        <label htmlFor={commentId} className="text-sm font-medium text-slate-700">
          {copy.requiresComment ? 'Reason (required)' : 'Comment (optional)'}
        </label>
        <textarea
          id={commentId}
          rows={4}
          value={comment}
          aria-required={copy.requiresComment}
          aria-invalid={tooLong || undefined}
          aria-describedby={tooLong ? `${commentId}-error` : undefined}
          onChange={(event) => {
            setComment(event.target.value);
          }}
          className="rounded-control border border-slate-300 px-3 py-2 text-sm"
        />
        {remaining <= 100 && (
          <p className={tooLong ? 'text-xs text-danger-600' : 'text-xs text-slate-500'}>
            {tooLong
              ? `${String(-remaining)} character(s) over the ${String(APPROVAL_COMMENT_MAX_LENGTH)} limit`
              : `${String(remaining)} character(s) left`}
          </p>
        )}
        {tooLong && (
          <p id={`${commentId}-error`} role="alert" className="text-xs text-danger-600">
            Comments are limited to {APPROVAL_COMMENT_MAX_LENGTH} characters.
          </p>
        )}
        {error !== null && (
          <p role="alert" className="text-sm text-danger-600">
            {error}
          </p>
        )}
      </div>
    </Modal>
  );
}
