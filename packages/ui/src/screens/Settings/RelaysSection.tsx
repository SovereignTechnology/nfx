/**
 * Settings › Relays: the relay list with read/write toggles, remove, and an "Add relay" form
 * that accepts `wss://` only (anything else is rejected inline, nothing is saved).
 * Every change is one optimistic `updateSettings({ relays })` through the save queue.
 */
import { useState, type SubmitEvent, type ReactElement } from 'react';
import type { RelayConfig, RelayUrl, Settings } from '@sovit/core';
import { Button, EmptyState, IconButton } from '../../components/index.js';
import { FieldError, Note, SectionFrame, useAlive, type SectionProps } from './controls.js';
import { normaliseRelayUrl, validateRelayUrl } from './model.js';

const LABEL = 'your relay list';

export function RelaysSection({
  id,
  view,
  saved,
  pending,
  save,
  signedOut,
  headingRef,
}: SectionProps & {
  readonly id: string;
  readonly signedOut: boolean;
  readonly headingRef?: ((el: HTMLHeadingElement | null) => void) | undefined;
}): ReactElement {
  const alive = useAlive();
  const [draft, setDraft] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);

  const relays = view.relays;
  const readers = relays.filter((r) => r.read).length;
  const writers = relays.filter((r) => r.write).length;
  const savedUrls = new Set(saved.relays.map((r) => r.url));

  const update = (fn: (list: readonly RelayConfig[]) => readonly RelayConfig[]): Promise<boolean> =>
    save({
      field: 'relays',
      label: LABEL,
      patch: (base: Settings) => ({ relays: fn(base.relays) }),
    });

  const setFlag = (url: RelayUrl, flag: 'read' | 'write', on: boolean): void => {
    void update((list) => list.map((r) => (r.url === url ? { ...r, [flag]: on } : r)));
  };
  const remove = (url: RelayUrl): void => {
    void update((list) => list.filter((r) => r.url !== url));
  };

  const onSubmit = (e: SubmitEvent<HTMLFormElement>): void => {
    e.preventDefault();
    const result = validateRelayUrl(
      draft,
      relays.map((r) => r.url),
    );
    if (!result.ok) {
      setError(result.error);
      return;
    }
    const url = result.value;
    const submitted = draft;
    setError(null);
    setAdding(true);
    void update((list) =>
      list.some((r) => normaliseRelayUrl(r.url) === url)
        ? list
        : [...list, { url, read: true, write: true }],
    ).then((ok) => {
      if (!alive.current) return;
      setAdding(false);
      if (ok) {
        // Clear only what was submitted — never text typed while the save was in flight.
        setDraft((cur) => (cur === submitted ? '' : cur));
      } else {
        setError('Not saved — your relays could not be updated. Your address is kept; try again.');
      }
    });
  };

  const inputId = `${id}-add`;
  const guardId = `${id}-guard`;

  return (
    <SectionFrame
      id={id}
      title="Relays"
      description={
        signedOut
          ? 'Where Nutflix reads and publishes Nostr events. Connect a signer to publish this list (kind 10002) for your other Nostr apps.'
          : 'Where Nutflix reads and publishes Nostr events. Saved as your relay list (kind 10002), so other Nostr apps use the same relays.'
      }
      busy={pending.has('relays')}
      headingRef={headingRef}
    >
      {relays.length === 0 ? (
        <EmptyState
          compact
          className="nf-settings__state-card"
          icon="cloudOff"
          title="No relays yet"
          description="Add a relay so Nutflix can load videos, comments and your library."
        />
      ) : (
        <table className="nf-settings__table">
          <caption className="nf-settings__sr">Your relays</caption>
          <thead>
            <tr>
              <th scope="col">Relay</th>
              <th scope="col" className="nf-settings__cell-flag">
                Read
              </th>
              <th scope="col" className="nf-settings__cell-flag">
                Write
              </th>
              <th scope="col" className="nf-settings__cell-action">
                <span className="nf-settings__sr">Remove</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {relays.map((r) => {
              const lastReader = r.read && readers <= 1;
              const lastWriter = r.write && writers <= 1;
              const unsaved = !savedUrls.has(r.url);
              return (
                <tr key={r.url} className={unsaved ? 'nf-settings__row--pending' : undefined}>
                  <th scope="row" className="nf-settings__cell-url">
                    <span className="nf-settings__mono">{r.url}</span>
                    {unsaved ? <span className="nf-settings__saving"> Saving…</span> : null}
                  </th>
                  <td className="nf-settings__cell-flag">
                    <input
                      type="checkbox"
                      className="nf-settings__check"
                      checked={r.read}
                      disabled={lastReader}
                      aria-label={`Read from ${r.url}`}
                      aria-describedby={lastReader ? guardId : undefined}
                      onChange={(e) => {
                        setFlag(r.url, 'read', e.currentTarget.checked);
                      }}
                    />
                  </td>
                  <td className="nf-settings__cell-flag">
                    <input
                      type="checkbox"
                      className="nf-settings__check"
                      checked={r.write}
                      disabled={lastWriter}
                      aria-label={`Write to ${r.url}`}
                      aria-describedby={lastWriter ? guardId : undefined}
                      onChange={(e) => {
                        setFlag(r.url, 'write', e.currentTarget.checked);
                      }}
                    />
                  </td>
                  <td className="nf-settings__cell-action">
                    <IconButton
                      icon="close"
                      size="sm"
                      label={`Remove ${r.url}`}
                      disabled={lastReader || lastWriter}
                      aria-describedby={lastReader || lastWriter ? guardId : undefined}
                      onClick={() => {
                        remove(r.url);
                      }}
                    />
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
      {relays.length > 0 ? (
        <Note id={guardId}>Keep at least one relay for reading and one for writing.</Note>
      ) : null}
      {relays.length > 0 && readers === 0 ? (
        <Note tone="warning">
          No relay is set to read — feeds, comments and your library cannot load.
        </Note>
      ) : null}
      {relays.length > 0 && writers === 0 ? (
        <Note tone="warning">
          No relay is set to write — comments, reactions and subscriptions cannot be published.
        </Note>
      ) : null}

      <form className="nf-settings__add" onSubmit={onSubmit} noValidate>
        <label htmlFor={inputId} className="nf-settings__label">
          Add a relay
        </label>
        <div className="nf-settings__add-line">
          <input
            id={inputId}
            type="url"
            inputMode="url"
            autoComplete="off"
            spellCheck={false}
            className="nf-settings__input nf-settings__mono"
            placeholder="wss://relay.example"
            value={draft}
            aria-invalid={error !== null || undefined}
            aria-describedby={error !== null ? `${inputId}-error` : `${inputId}-hint`}
            onChange={(e) => {
              setDraft(e.currentTarget.value);
              if (error !== null) setError(null);
            }}
          />
          <Button type="submit" variant="secondary" loading={adding}>
            Add
          </Button>
        </div>
        {error !== null ? (
          <FieldError id={`${inputId}-error`}>{error}</FieldError>
        ) : (
          <p id={`${inputId}-hint`} className="nf-settings__desc">
            Secure wss:// relays only. New relays are used for reading and writing.
          </p>
        )}
      </form>
    </SectionFrame>
  );
}
