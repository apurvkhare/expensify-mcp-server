/**
 * The two dialogs behind the row buttons: edit an expense, confirm a delete.
 * Both end in a tool call by id (update_expense, delete_expense), so the scope check,
 * the validation, and the log line are the server's, exactly as when the model calls them.
 */
import type { App } from '@modelcontextprotocol/ext-apps';
import { useId, useLayoutEffect, useRef, useState, type ReactNode, type SubmitEvent } from 'react';
import { CATEGORIES, ExpenseForm, deleteExpense, updateExpense, type ExpensePatch, type ExpenseRow } from './data.ts';
import { formatDate, formatINR } from './format.ts';

const message = (err: unknown) => (err instanceof Error ? err.message : String(err));
const capitalize = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

interface ModalProps {
  /** Document Y of the row that opened the dialog. */
  anchorTop: number;
  labelledBy: string;
  busy: boolean;
  onClose(): void;
  children: ReactNode;
}

/**
 * A native modal <dialog>: focus trap, Escape, and backdrop come with it.
 * The one thing it gets wrong in a host iframe is where it sits. The iframe is as tall as its content
 * and never scrolls, so "centred in the viewport" can be far from the row the user clicked, even off
 * screen. So the dialog is placed beside that row, and the page is kept tall enough to contain it.
 */
function Modal({ anchorTop, labelledBy, busy, onClose, children }: ModalProps) {
  const ref = useRef<HTMLDialogElement>(null);

  useLayoutEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    dialog.showModal();
    const height = dialog.offsetHeight;
    const pageHeight = Math.max(document.documentElement.scrollHeight, height + 16);
    document.body.style.minHeight = `${pageHeight}px`;
    dialog.style.top = `${Math.min(Math.max(8, anchorTop - height / 3), pageHeight - height - 8)}px`;
    return () => {
      document.body.style.minHeight = '';
      dialog.close();
    };
  }, [anchorTop]);

  return (
    <dialog
      ref={ref}
      className="modal"
      aria-labelledby={labelledBy}
      onCancel={(e) => {
        e.preventDefault();
        if (!busy) onClose();
      }}
      onClick={(e) => {
        // A click that lands on the dialog element itself is a click on the backdrop.
        if (e.target === ref.current && !busy) onClose();
      }}
    >
      {children}
    </dialog>
  );
}

type Field = 'merchant' | 'amount' | 'category' | 'date' | 'note';

/** The schema decides what is valid; these say it in the form's own words. */
const FIELD_ERRORS: Record<Field, string> = {
  merchant: 'Enter who was paid, in 80 characters or fewer.',
  amount: 'Enter an amount above 0, up to ₹1,00,00,000.',
  category: 'Pick a category.',
  date: 'Pick a date.',
  note: 'Keep the note to 200 characters or fewer.'
};

interface DialogProps {
  app: App;
  expense: ExpenseRow;
  anchorTop: number;
  onClose(): void;
  /** Called after the server confirmed the change, with a one-line description of it. */
  onChanged(description: string): void;
}

export function EditDialog({ app, expense, anchorTop, onClose, onChanged }: DialogProps) {
  const id = useId();
  const [values, setValues] = useState({
    merchant: expense.merchant,
    amount: String(expense.amount),
    category: expense.category,
    date: expense.date,
    note: expense.note ?? ''
  });
  const [errors, setErrors] = useState<Partial<Record<Field, string>>>({});
  const [failure, setFailure] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const set = (field: Field) => (e: { target: { value: string } }) => {
    setValues((v) => ({ ...v, [field]: e.target.value }));
    setErrors((prev) => ({ ...prev, [field]: undefined }));
  };

  async function submit(e: SubmitEvent<HTMLFormElement>) {
    e.preventDefault();
    const parsed = ExpenseForm.safeParse({ ...values, amount: values.amount.trim() === '' ? Number.NaN : Number(values.amount) });
    if (!parsed.success) {
      const next: Partial<Record<Field, string>> = {};
      for (const issue of parsed.error.issues) {
        const field = issue.path[0] as Field;
        if (field in FIELD_ERRORS) next[field] = FIELD_ERRORS[field];
      }
      setErrors(next);
      return;
    }

    // Send only what changed. A cleared note goes as '', which is how the API spells "no note".
    const next = parsed.data;
    const patch: ExpensePatch = {};
    if (next.merchant !== expense.merchant) patch.merchant = next.merchant;
    if (next.amount !== expense.amount) patch.amount = next.amount;
    if (next.category !== expense.category) patch.category = next.category;
    if (next.date !== expense.date) patch.date = next.date;
    if ((next.note ?? '') !== (expense.note ?? '')) patch.note = next.note ?? '';
    if (Object.keys(patch).length === 0) return onClose();

    setSaving(true);
    setFailure(null);
    try {
      await updateExpense(app, expense.id, patch);
      const changed = Object.entries(patch).map(([k, v]) => `${k} → ${k === 'amount' ? formatINR(v as number) : v === '' ? '(none)' : v}`);
      onChanged(`Edited ${expense.id} (${expense.merchant}, ${expense.date}): ${changed.join(', ')}`);
    } catch (err) {
      setFailure(message(err));
      setSaving(false);
    }
  }

  const field = (name: Field, label: string, control: ReactNode) => (
    <div className="field">
      <label htmlFor={`${id}-${name}`}>{label}</label>
      {control}
      {errors[name] && (
        <p className="field-error" id={`${id}-${name}-error`}>
          {errors[name]}
        </p>
      )}
    </div>
  );
  const aria = (name: Field) => ({ id: `${id}-${name}`, 'aria-invalid': errors[name] ? true : undefined, 'aria-describedby': errors[name] ? `${id}-${name}-error` : undefined });

  return (
    <Modal anchorTop={anchorTop} labelledBy={`${id}-title`} busy={saving} onClose={onClose}>
      <form onSubmit={submit} noValidate>
        <h2 id={`${id}-title`}>Edit expense</h2>
        {field('merchant', 'Merchant', <input type="text" value={values.merchant} onChange={set('merchant')} maxLength={80} autoFocus {...aria('merchant')} />)}
        <div className="field-row">
          {field('amount', 'Amount (₹)', <input type="number" inputMode="decimal" min="0" step="0.01" value={values.amount} onChange={set('amount')} {...aria('amount')} />)}
          {field('date', 'Date', <input type="date" value={values.date} onChange={set('date')} {...aria('date')} />)}
        </div>
        {field(
          'category',
          'Category',
          <select value={values.category} onChange={set('category')} {...aria('category')}>
            {CATEGORIES.map((c) => (
              <option key={c} value={c}>
                {capitalize(c)}
              </option>
            ))}
          </select>
        )}
        {field('note', 'Note (optional)', <input type="text" value={values.note} onChange={set('note')} maxLength={200} {...aria('note')} />)}
        {failure && (
          <p className="state state-error" role="alert">
            {failure}
          </p>
        )}
        <div className="modal-actions">
          <button type="button" className="button" onClick={onClose} disabled={saving}>
            Cancel
          </button>
          <button type="submit" className="button button-primary" disabled={saving}>
            {saving ? 'Saving…' : 'Save changes'}
          </button>
        </div>
      </form>
    </Modal>
  );
}

export function DeleteDialog({ app, expense, anchorTop, onClose, onChanged }: DialogProps) {
  const id = useId();
  const [failure, setFailure] = useState<string | null>(null);
  const [deleting, setDeleting] = useState(false);

  async function confirm() {
    setDeleting(true);
    setFailure(null);
    try {
      await deleteExpense(app, expense.id);
      onChanged(`Deleted ${expense.id}: ${formatINR(expense.amount)} to ${expense.merchant} on ${expense.date} (${expense.category})`);
    } catch (err) {
      setFailure(message(err));
      setDeleting(false);
    }
  }

  return (
    <Modal anchorTop={anchorTop} labelledBy={`${id}-title`} busy={deleting} onClose={onClose}>
      <h2 id={`${id}-title`}>Do you want to delete this expense?</h2>
      <dl className="details">
        <dt>Merchant</dt>
        <dd>{expense.merchant}</dd>
        <dt>Amount</dt>
        <dd>{formatINR(expense.amount)}</dd>
        <dt>Date</dt>
        <dd>{formatDate(expense.date)}</dd>
        <dt>Category</dt>
        <dd>{capitalize(expense.category)}</dd>
        {expense.note && (
          <>
            <dt>Note</dt>
            <dd>{expense.note}</dd>
          </>
        )}
      </dl>
      <p className="modal-hint">This cannot be undone.</p>
      {failure && (
        <p className="state state-error" role="alert">
          {failure}
        </p>
      )}
      <div className="modal-actions">
        {/* Focus starts on Cancel, so a stray Enter never deletes. */}
        <button type="button" className="button" onClick={onClose} disabled={deleting} autoFocus>
          Cancel
        </button>
        <button type="button" className="button button-danger" onClick={confirm} disabled={deleting}>
          {deleting ? 'Deleting…' : 'Delete expense'}
        </button>
      </div>
    </Modal>
  );
}
