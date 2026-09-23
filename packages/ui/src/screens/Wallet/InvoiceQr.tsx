/**
 * QR code for a Lightning invoice, drawn as React SVG `<rect>`s from `uqr`'s `encode()`
 * boolean matrix — never from `renderSVG()` markup (nothing here takes HTML).
 *
 * Dark-on-light in BOTH themes: scanners need contrast and many cannot read an inverted
 * code, so the backing is the always-white overlay token and the modules the always-dark
 * one (see Wallet.css), not the themed text/background pair.
 */
import { useMemo, type ReactElement } from 'react';
import { encode } from 'uqr';
import { QR_QUIET_ZONE, invoiceQrPayload, qrRuns } from './invoice.js';

/** Rendered size to aim for; the actual size is a whole number of pixels per module. */
const TARGET_PX = 288;

export interface InvoiceQrProps {
  readonly bolt11: string;
  /** Accessible name, e.g. "Lightning invoice for 5,000 sats". */
  readonly label: string;
  readonly className?: string | undefined;
}

interface Encoded {
  readonly size: number;
  readonly runs: readonly { readonly x: number; readonly y: number; readonly w: number }[];
}

function encodeInvoice(bolt11: string): Encoded | null {
  try {
    // ECC "M" (15 %) — screens glare and phone cameras blur; the alphanumeric payload keeps
    // the version small enough that the extra redundancy costs little.
    const qr = encode(invoiceQrPayload(bolt11), { ecc: 'M', border: 0 });
    return { size: qr.size, runs: qrRuns(qr.data) };
  } catch {
    return null; // too long for version 40, or not encodable: the text + link still work
  }
}

export function InvoiceQr({ bolt11, label, className }: InvoiceQrProps): ReactElement | null {
  const qr = useMemo(() => encodeInvoice(bolt11), [bolt11]);
  if (!qr) return null;
  const n = qr.size + QR_QUIET_ZONE * 2;
  // Whole pixels per module, so `crispEdges` never rounds a row into a hairline gap.
  const px = Math.max(2, Math.floor(TARGET_PX / n)) * n;
  return (
    <svg
      className={className}
      width={px}
      height={px}
      viewBox={`0 0 ${n} ${n}`}
      role="img"
      aria-label={label}
      shapeRendering="crispEdges"
      data-modules={qr.size}
    >
      <rect className="nf-wallet__qr-light" x={0} y={0} width={n} height={n} />
      <g className="nf-wallet__qr-dark">
        {qr.runs.map((r) => (
          <rect
            key={`${r.y}:${r.x}`}
            x={r.x + QR_QUIET_ZONE}
            y={r.y + QR_QUIET_ZONE}
            width={r.w}
            height={1}
          />
        ))}
      </g>
    </svg>
  );
}
