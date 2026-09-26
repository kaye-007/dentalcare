import { useMemo } from 'react';
import qrcode from 'qrcode-generator';

/**
 * A QR code as SVG squares — no innerHTML, so nothing here needs a CSP
 * exception. Medium error correction, which survives a thermal printer.
 */
export default function QrCode({
  text,
  label = 'Verification QR code',
}: {
  text: string;
  label?: string;
}) {
  const cells = useMemo(() => {
    const qr = qrcode(0, 'M');
    qr.addData(text);
    qr.make();
    const n = qr.getModuleCount();
    const out: [number, number][] = [];
    for (let r = 0; r < n; r++)
      for (let c = 0; c < n; c++) if (qr.isDark(r, c)) out.push([c, r]);
    return { n, out };
  }, [text]);
  return (
    <svg
      viewBox={`-2 -2 ${cells.n + 4} ${cells.n + 4}`}
      role="img"
      aria-label={label}
      shapeRendering="crispEdges"
    >
      <rect x={-2} y={-2} width={cells.n + 4} height={cells.n + 4} fill="#fff" />
      <path d={cells.out.map(([x, y]) => `M${x} ${y}h1v1h-1z`).join('')} fill="#000" />
    </svg>
  );
}
