/**
 * "New playlist" form, shown inside L4's `Sheet` by the Library screen. Title (required),
 * description (optional, rendered later through `Markdown` only) and the private toggle —
 * private NIP-51 sets are encrypted to the viewer's key, so the default is private.
 */
import { useEffect, useId, useRef, useState, type ReactElement } from 'react';
import { Button, ErrorState } from '../../components/index.js';
import { describeLibraryError } from './libraryFormat.js';

/** YouTube's limits; long enough for real titles, short enough for a tile. */
export const PLAYLIST_TITLE_MAX = 150;
export const PLAYLIST_DESCRIPTION_MAX = 5000;

export interface PlaylistFormValues {
  readonly title: string;
  readonly description: string;
  readonly isPrivate: boolean;
}

export interface PlaylistFormProps {
  readonly busy: boolean;
  /** The last `savePlaylist` failure, if any; the form keeps what was typed. */
  readonly error: unknown;
  readonly onSubmit: (values: PlaylistFormValues) => void;
  readonly onCancel: () => void;
}

export function PlaylistForm({ busy, error, onSubmit, onCancel }: PlaylistFormProps): ReactElement {
  const id = useId();
  const titleRef = useRef<HTMLInputElement | null>(null);
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [isPrivate, setPrivate] = useState(true);
  const trimmed = title.trim();
  const canSave =
    !busy &&
    trimmed.length > 0 &&
    trimmed.length <= PLAYLIST_TITLE_MAX &&
    description.length <= PLAYLIST_DESCRIPTION_MAX;

  // The Sheet focuses its first control (Close) when it opens; the title field is where the
  // user wants to be, so take focus once the Sheet's own effect has run.
  useEffect(() => {
    const t = setTimeout(() => {
      titleRef.current?.focus();
    }, 0);
    return () => {
      clearTimeout(t);
    };
  }, []);

  const failure = error === undefined ? undefined : describeLibraryError(error);

  return (
    <form
      className="nf-library__form"
      noValidate
      onSubmit={(e) => {
        e.preventDefault();
        if (!canSave) return;
        onSubmit({ title: trimmed, description: description.trim(), isPrivate });
      }}
    >
      <div className="nf-library__field">
        <label className="nf-library__label" htmlFor={`${id}-title`}>
          Title
        </label>
        <input
          ref={titleRef}
          id={`${id}-title`}
          className="nf-library__input"
          type="text"
          value={title}
          maxLength={PLAYLIST_TITLE_MAX}
          required
          autoComplete="off"
          aria-describedby={`${id}-title-count`}
          onChange={(e) => {
            setTitle(e.target.value);
          }}
        />
        <span id={`${id}-title-count`} className="nf-library__counter">
          {title.length}/{PLAYLIST_TITLE_MAX}
        </span>
      </div>

      <div className="nf-library__field">
        <label className="nf-library__label" htmlFor={`${id}-description`}>
          Description <span className="nf-library__optional">(optional)</span>
        </label>
        <textarea
          id={`${id}-description`}
          className="nf-library__input nf-library__textarea"
          rows={4}
          value={description}
          maxLength={PLAYLIST_DESCRIPTION_MAX}
          aria-describedby={`${id}-description-help`}
          onChange={(e) => {
            setDescription(e.target.value);
          }}
        />
        <span id={`${id}-description-help`} className="nf-library__help">
          Supports **bold**, *italic* and links; anything else shows as plain text.
        </span>
      </div>

      <div className="nf-library__field nf-library__field--check">
        <input
          id={`${id}-private`}
          className="nf-library__check"
          type="checkbox"
          checked={isPrivate}
          aria-describedby={`${id}-private-help`}
          onChange={(e) => {
            setPrivate(e.target.checked);
          }}
        />
        <label className="nf-library__label" htmlFor={`${id}-private`}>
          Private playlist
        </label>
        <span id={`${id}-private-help`} className="nf-library__help">
          {isPrivate
            ? 'Encrypted to your key — only you can see it.'
            : 'Public — anyone can see it on your channel.'}
        </span>
      </div>

      {failure ? (
        <ErrorState
          compact
          title="Could not create the playlist"
          description={failure.description}
          detail={failure.detail}
        />
      ) : null}

      <div className="nf-library__form-actions">
        <Button variant="ghost" onClick={onCancel}>
          Cancel
        </Button>
        <Button type="submit" variant="primary" disabled={!canSave} loading={busy}>
          Create
        </Button>
      </div>
    </form>
  );
}
