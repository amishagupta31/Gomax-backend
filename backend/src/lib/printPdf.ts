import PDFDocument from 'pdfkit';
import QRCode from 'qrcode';

// D2: print-ready coupon sheet — 48 per A4 (6 × 8) with dashed cut lines.
// Each coupon: GoMax + points, a QR of the printed code, the code itself
// (GMX-XXXX-XXXX, what the applicator types) and the small admin reference.
// The app's scanner accepts the printed form (normalizeCode drops "GMX").
const MM = 72 / 25.4;
const PAGE = { w: 210 * MM, h: 297 * MM };
const MARGIN = 10 * MM;
const COLS = 6;
const ROWS = 8;
export const PER_PAGE = COLS * ROWS;

export type PrintCoupon = { code: string; ref: string };
export const printed = (c: string) => `GMX-${c.slice(0, 4)}-${c.slice(4)}`;

function drawQr(doc: PDFKit.PDFDocument, text: string, x: number, y: number, size: number) {
  const qr = QRCode.create(text, { errorCorrectionLevel: 'M' });
  const n = qr.modules.size;
  const cell = size / n;
  doc.save().fillColor('#000');
  for (let r = 0; r < n; r++) for (let c = 0; c < n; c++) if (qr.modules.get(r, c)) doc.rect(x + c * cell, y + r * cell, cell, cell);
  doc.fill().restore();
}

export function couponSheetPdf(batch: { ref: string; valuePoints: number; expiresAt: Date }, coupons: PrintCoupon[]): Promise<Buffer> {
  const doc = new PDFDocument({ size: 'A4', margin: 0, info: { Title: `GoMax coupons ${batch.ref}`, Author: 'GoMax' } });
  const chunks: Buffer[] = [];
  doc.on('data', (c: Buffer) => chunks.push(c));
  const done = new Promise<Buffer>((resolve) => doc.on('end', () => resolve(Buffer.concat(chunks))));

  const cw = (PAGE.w - 2 * MARGIN) / COLS;
  const ch = (PAGE.h - 2 * MARGIN) / ROWS;
  const pages = Math.max(1, Math.ceil(coupons.length / PER_PAGE));
  for (let p = 0; p < pages; p++) {
    if (p > 0) doc.addPage();
    // Cut lines.
    doc.save().lineWidth(0.4).strokeColor('#9aa4b5').dash(2, { space: 2 });
    for (let i = 0; i <= COLS; i++) doc.moveTo(MARGIN + i * cw, MARGIN - 4 * MM).lineTo(MARGIN + i * cw, PAGE.h - MARGIN + 4 * MM).stroke();
    for (let j = 0; j <= ROWS; j++) doc.moveTo(MARGIN - 4 * MM, MARGIN + j * ch).lineTo(PAGE.w - MARGIN + 4 * MM, MARGIN + j * ch).stroke();
    doc.restore().undash();
    doc.fontSize(6).fillColor('#71717a').text(`${batch.ref} · ${batch.valuePoints} pt · page ${p + 1} of ${pages} · valid till ${batch.expiresAt.toISOString().slice(0, 10)}`, MARGIN, 3.5 * MM, { lineBreak: false });

    coupons.slice(p * PER_PAGE, (p + 1) * PER_PAGE).forEach((c, i) => {
      const x = MARGIN + (i % COLS) * cw;
      const y = MARGIN + Math.floor(i / COLS) * ch;
      const pad = 2 * MM;
      doc.fillColor('#c05336').font('Helvetica-Bold').fontSize(7).text('GoMax', x + pad, y + pad, { lineBreak: false });
      doc.fillColor('#0a1628').fontSize(7).text(`${batch.valuePoints} PTS`, x + pad, y + pad, { width: cw - 2 * pad, align: 'right', lineBreak: false });
      // QR with a clear margin (quiet zone) of ≥ 3 modules on every side so phone scanners lock on.
      const q = Math.min(cw, ch) - 18 * MM;
      drawQr(doc, printed(c.code), x + (cw - q) / 2, y + 6.5 * MM, q);
      doc.font('Courier-Bold').fontSize(7.5).fillColor('#0a1628').text(printed(c.code), x, y + 8.5 * MM + q, { width: cw, align: 'center', lineBreak: false });
      doc.font('Helvetica').fontSize(5).fillColor('#71717a').text(`Ref ${c.ref}`, x, y + 11.8 * MM + q, { width: cw, align: 'center', lineBreak: false });
      doc.fontSize(4).text('Scan in the GoMax app · one time only', x, y + ch - 4 * MM, { width: cw, align: 'center', lineBreak: false });
    });
  }
  doc.end();
  return done;
}
