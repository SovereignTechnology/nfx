import { Fragment, useMemo, type ReactElement, type ReactNode } from 'react';
import { cx } from '../shared/format.js';
import {
  MARKDOWN_MAX_CHARS,
  parseMarkdown,
  type InlineToken,
  type MarkdownTree,
  type NostrEntity,
} from './parse.js';

export interface NostrRef {
  readonly uri: string;
  readonly entity: NostrEntity;
  readonly bech32: string;
  readonly label?: string | undefined;
}

export interface MarkdownProps {
  /** Raw content (description / comment). Never HTML; never trusted. */
  readonly source: string;
  /**
   * Slot for `nostr:` references. The screen resolves the entity (profile lookup via
   * `NetworkAdapter`) and returns a chip; when omitted a neutral text chip is rendered.
   */
  readonly renderNostr?: ((ref: NostrRef) => ReactNode) | undefined;
  /** Called when an http(s) link is activated, in addition to the browser's default. */
  readonly onLinkClick?: ((href: string) => void) | undefined;
  readonly maxChars?: number;
  readonly className?: string;
}

/** Shorten `npub1abcdef…xyz` for the default chip. */
function shortBech32(b: string): string {
  return b.length <= 16 ? b : `${b.slice(0, 9)}…${b.slice(-4)}`;
}

function DefaultNostrChip({ ref }: { readonly ref: NostrRef }): ReactElement {
  return (
    <span className="nf-md__nostr" title={ref.uri} data-entity={ref.entity}>
      {ref.label ?? shortBech32(ref.bech32)}
    </span>
  );
}

function renderTokens(
  tokens: readonly InlineToken[],
  renderNostr: MarkdownProps['renderNostr'],
  onLinkClick: MarkdownProps['onLinkClick'],
  keyPrefix: string,
): ReactNode[] {
  return tokens.map((t, i) => {
    const key = `${keyPrefix}${i}`;
    switch (t.type) {
      case 'text':
        return <Fragment key={key}>{t.value}</Fragment>;
      case 'br':
        return <br key={key} />;
      case 'strong':
        return <strong key={key}>{renderTokens(t.children, renderNostr, onLinkClick, key)}</strong>;
      case 'em':
        return <em key={key}>{renderTokens(t.children, renderNostr, onLinkClick, key)}</em>;
      case 'link':
        return (
          <a
            key={key}
            className="nf-md__link"
            href={t.href}
            target="_blank"
            rel="noopener noreferrer"
            onClick={
              onLinkClick
                ? () => {
                    onLinkClick(t.href);
                  }
                : undefined
            }
          >
            {renderTokens(t.children, renderNostr, onLinkClick, key)}
          </a>
        );
      case 'nostr': {
        const ref: NostrRef = { uri: t.uri, entity: t.entity, bech32: t.bech32, label: t.label };
        const custom = renderNostr?.(ref);
        return <Fragment key={key}>{custom ?? <DefaultNostrChip ref={ref} />}</Fragment>;
      }
    }
  });
}

/** Renders a parsed tree. Exported so screens can parse once and render many times. */
export function MarkdownTreeView({
  tree,
  renderNostr,
  onLinkClick,
  className,
}: {
  readonly tree: MarkdownTree;
  readonly renderNostr?: MarkdownProps['renderNostr'];
  readonly onLinkClick?: MarkdownProps['onLinkClick'];
  readonly className?: string | undefined;
}): ReactElement {
  return (
    <div className={cx('nf-md', className)}>
      {tree.map((p, i) => (
        <p key={i} className="nf-md__p">
          {renderTokens(p.children, renderNostr, onLinkClick, `${i}.`)}
        </p>
      ))}
    </div>
  );
}

/**
 * Markdown-subset renderer. Text is always text: the source is parsed to a token tree and
 * rendered as React elements — no innerHTML-style API is used anywhere in this package
 * (a test greps for them).
 */
export function Markdown({
  source,
  renderNostr,
  onLinkClick,
  maxChars = MARKDOWN_MAX_CHARS,
  className,
}: MarkdownProps): ReactElement {
  const tree = useMemo(() => parseMarkdown(source, maxChars), [source, maxChars]);
  return (
    <MarkdownTreeView
      tree={tree}
      renderNostr={renderNostr}
      onLinkClick={onLinkClick}
      className={className}
    />
  );
}
