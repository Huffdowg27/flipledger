/**
 * Generate FNSKU labels client-side as a PDF.
 *
 * Amazon's v2024 Inbound Plans API only exposes labels per-shipment AFTER
 * placement is confirmed — which forces an unnatural workflow (pack boxes,
 * confirm packing, confirm placement, THEN print labels, then unpack and
 * re-pack to apply labels). Tools like Inventory Lab work around this by
 * generating labels CLIENT-SIDE: an FNSKU is just a Code 128 barcode + text,
 * and any barcode lib can produce the PDF independently.
 *
 * This module renders 2"×1" thermal labels with:
 *   - Code 128 barcode of the FNSKU (e.g. X0053IIN6N)
 *   - FNSKU text underneath (human-readable backup)
 *   - Product title (truncated to fit)
 *   - Condition (New / Used / etc.)
 *
 * The PDF has one page per unit. If you have 12 of a SKU, you get 12 pages,
 * which is what you want — one page per Rollo label, which prints one label
 * per unit.
 */
// Use the Node-specific entry point — bwip-js's default export resolves to
// the browser build under Next.js's bundler, which doesn't have toBuffer().
import bwipjs from 'bwip-js/node';
import { PDFDocument, StandardFonts, rgb, PDFPage, PDFFont, PDFImage } from 'pdf-lib';

export interface LabelInput {
  fnsku: string;
  productTitle: string;
  condition?: string;     // "New", "Used Like New", etc.
  quantity: number;       // produces this many copies of this label
}

const POINTS_PER_INCH = 72;
const LABEL_WIDTH_PT = 2 * POINTS_PER_INCH;   // 144pt = 2"
const LABEL_HEIGHT_PT = 1 * POINTS_PER_INCH;  // 72pt = 1"

/**
 * Generate a Code 128 barcode for the FNSKU and return as PNG bytes.
 * bwip-js renders SVG natively but PDF-lib needs PNG/JPEG, so we use the
 * PNG output. Density chosen so the barcode is sharp at 2"×1" thermal printing.
 */
async function generateBarcodePng(fnsku: string): Promise<Buffer> {
  // bwip-js options: code128 is the standard FNSKU barcode format
  const png = await bwipjs.toBuffer({
    bcid: 'code128',
    text: fnsku,
    scale: 3,            // density
    height: 10,          // mm
    includetext: false,  // we render text separately for finer control
    backgroundcolor: 'FFFFFF',
    paddingwidth: 0,
    paddingheight: 0,
  });
  return png;
}

/**
 * Truncate text to fit a target width in points at a given font size. Falls
 * back to character-count truncation if measurement fails.
 */
function truncateForWidth(text: string, font: PDFFont, fontSize: number, maxWidth: number): string {
  if (!text) return '';
  if (font.widthOfTextAtSize(text, fontSize) <= maxWidth) return text;
  let truncated = text;
  while (truncated.length > 4 && font.widthOfTextAtSize(truncated + '…', fontSize) > maxWidth) {
    truncated = truncated.slice(0, -1);
  }
  return truncated + '…';
}

/**
 * Lay out a single label on a 2"×1" page. Layout:
 *   ┌──────────────────────────┐
 *   │   ███▌ ███ ▌█ ████ ███   │  ← barcode (centered, ~75% of width, ~45% of height)
 *   │   X0053IIN6N             │  ← FNSKU text (8pt mono, centered)
 *   │   Sonic 3 Movie - 5"…    │  ← product title (6pt, centered, truncated)
 *   │   New                    │  ← condition (5pt, centered, gray)
 *   └──────────────────────────┘
 */
function drawLabel(
  page: PDFPage,
  barcodePng: PDFImage,
  label: LabelInput,
  font: PDFFont,
  fontMono: PDFFont
) {
  const margin = 4;
  const w = LABEL_WIDTH_PT - 2 * margin;

  // Barcode area — top 50% of label
  const bcWidth = w * 0.85;
  const bcHeight = 30;
  const bcX = (LABEL_WIDTH_PT - bcWidth) / 2;
  const bcY = LABEL_HEIGHT_PT - margin - bcHeight;
  page.drawImage(barcodePng, { x: bcX, y: bcY, width: bcWidth, height: bcHeight });

  // FNSKU text — directly below barcode
  const fnskuSize = 8;
  const fnskuWidth = fontMono.widthOfTextAtSize(label.fnsku, fnskuSize);
  page.drawText(label.fnsku, {
    x: (LABEL_WIDTH_PT - fnskuWidth) / 2,
    y: bcY - fnskuSize - 1,
    size: fnskuSize,
    font: fontMono,
  });

  // Product title — truncated to fit
  const titleSize = 6;
  const titleY = bcY - fnskuSize - 4 - titleSize;
  const titleText = truncateForWidth(label.productTitle, font, titleSize, w);
  const titleWidth = font.widthOfTextAtSize(titleText, titleSize);
  page.drawText(titleText, {
    x: (LABEL_WIDTH_PT - titleWidth) / 2,
    y: titleY,
    size: titleSize,
    font,
  });

  // Condition — bottom, gray
  if (label.condition) {
    const condSize = 5;
    const condText = label.condition;
    const condWidth = font.widthOfTextAtSize(condText, condSize);
    page.drawText(condText, {
      x: (LABEL_WIDTH_PT - condWidth) / 2,
      y: titleY - condSize - 2,
      size: condSize,
      font,
      color: rgb(0.4, 0.4, 0.4),
    });
  }
}

/**
 * Build a PDF with one page per unit. Returns the PDF binary as a Buffer.
 *
 * Example: passing 3 LabelInputs with quantities [12, 1, 5] produces an
 * 18-page PDF (12 + 1 + 5).
 */
export async function generateFnskuLabelPdf(labels: LabelInput[]): Promise<Buffer> {
  const pdf = await PDFDocument.create();
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  const fontMono = await pdf.embedFont(StandardFonts.Courier);

  // Embed each unique FNSKU's barcode once (then re-use across copies)
  const barcodeCache: Map<string, PDFImage> = new Map();
  for (const label of labels) {
    if (!barcodeCache.has(label.fnsku)) {
      const png = await generateBarcodePng(label.fnsku);
      const img = await pdf.embedPng(png);
      barcodeCache.set(label.fnsku, img);
    }
  }

  for (const label of labels) {
    const barcode = barcodeCache.get(label.fnsku)!;
    for (let i = 0; i < label.quantity; i++) {
      const page = pdf.addPage([LABEL_WIDTH_PT, LABEL_HEIGHT_PT]);
      drawLabel(page, barcode, label, font, fontMono);
    }
  }

  const bytes = await pdf.save();
  return Buffer.from(bytes);
}
