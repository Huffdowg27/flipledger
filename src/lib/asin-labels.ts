/**
 * Generate ASIN stickers as a PDF for direct (silent) thermal printing.
 *
 * Same rendering approach as fnsku-labels.ts: an ASIN sticker is a Code 128
 * barcode + text, so we build the PDF ourselves and spool it to the label
 * printer via lib/print.ts — no browser print dialog. Content mirrors the
 * customer-safe "asin" mode of /api/labels/print (barcode = ASIN, no MSKU,
 * no cost): barcode, ASIN text, truncated title, condition + optional bin.
 *
 * One 2"×1" page per copy — copies = units received, one sticker per unit.
 */
// Use the Node-specific entry point — bwip-js's default export resolves to
// the browser build under Next.js's bundler, which doesn't have toBuffer().
import bwipjs from 'bwip-js/node';
import { PDFDocument, StandardFonts, rgb, PDFPage, PDFFont, PDFImage } from 'pdf-lib';

export interface AsinLabelSpec {
  asin: string;
  title?: string;
  condition?: string;
  bin?: string;
  copies?: number; // default 1, clamped to MAX_COPIES_PER_SPEC
}

export const MAX_COPIES_PER_SPEC = 50;

const POINTS_PER_INCH = 72;
const LABEL_WIDTH_PT = 2 * POINTS_PER_INCH;   // 144pt = 2"
const LABEL_HEIGHT_PT = 1 * POINTS_PER_INCH;  // 72pt = 1"

async function generateBarcodePng(asin: string): Promise<Buffer> {
  const png = await bwipjs.toBuffer({
    bcid: 'code128',
    text: asin,
    scale: 3,
    height: 10,
    includetext: false,
    backgroundcolor: 'FFFFFF',
    paddingwidth: 0,
    paddingheight: 0,
  });
  return png;
}

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
 * Layout on a 2"×1" page:
 *   ┌──────────────────────────┐
 *   │   ███▌ ███ ▌█ ████ ███   │  ← Code 128 barcode of the ASIN
 *   │   B0C4LSNFWL             │  ← ASIN (8pt mono, centered)
 *   │   Transformers Legacy…   │  ← title (6pt, centered, truncated)
 *   │   New · Bin S1-B3        │  ← condition + bin (5pt, centered, gray)
 *   └──────────────────────────┘
 */
function drawLabel(
  page: PDFPage,
  barcodePng: PDFImage,
  spec: AsinLabelSpec,
  font: PDFFont,
  fontMono: PDFFont,
) {
  const margin = 4;
  const w = LABEL_WIDTH_PT - 2 * margin;

  const bcWidth = w * 0.85;
  const bcHeight = 30;
  const bcX = (LABEL_WIDTH_PT - bcWidth) / 2;
  const bcY = LABEL_HEIGHT_PT - margin - bcHeight;
  page.drawImage(barcodePng, { x: bcX, y: bcY, width: bcWidth, height: bcHeight });

  const asinSize = 8;
  const asinWidth = fontMono.widthOfTextAtSize(spec.asin, asinSize);
  page.drawText(spec.asin, {
    x: (LABEL_WIDTH_PT - asinWidth) / 2,
    y: bcY - asinSize - 1,
    size: asinSize,
    font: fontMono,
  });

  const titleSize = 6;
  const titleY = bcY - asinSize - 4 - titleSize;
  if (spec.title) {
    const titleText = truncateForWidth(spec.title, font, titleSize, w);
    const titleWidth = font.widthOfTextAtSize(titleText, titleSize);
    page.drawText(titleText, {
      x: (LABEL_WIDTH_PT - titleWidth) / 2,
      y: titleY,
      size: titleSize,
      font,
    });
  }

  const detail = [spec.condition, spec.bin ? `Bin ${spec.bin}` : '']
    .filter(Boolean)
    .join(' · ');
  if (detail) {
    const detailSize = 5;
    const detailText = truncateForWidth(detail, font, detailSize, w);
    const detailWidth = font.widthOfTextAtSize(detailText, detailSize);
    page.drawText(detailText, {
      x: (LABEL_WIDTH_PT - detailWidth) / 2,
      y: titleY - detailSize - 2,
      size: detailSize,
      font,
      color: rgb(0.4, 0.4, 0.4),
    });
  }
}

/**
 * Build a PDF with one 2"×1" page per copy. Copies default to 1 and are
 * clamped to MAX_COPIES_PER_SPEC per spec.
 */
export async function buildAsinLabelPdf(specs: AsinLabelSpec[]): Promise<Buffer> {
  const pdf = await PDFDocument.create();
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  const fontMono = await pdf.embedFont(StandardFonts.Courier);

  // Embed each unique ASIN's barcode once, reuse across copies.
  const barcodeCache = new Map<string, PDFImage>();
  for (const spec of specs) {
    if (!barcodeCache.has(spec.asin)) {
      const png = await generateBarcodePng(spec.asin);
      barcodeCache.set(spec.asin, await pdf.embedPng(png));
    }
  }

  for (const spec of specs) {
    const barcode = barcodeCache.get(spec.asin)!;
    const copies = Math.min(
      MAX_COPIES_PER_SPEC,
      Math.max(1, Math.trunc(Number(spec.copies) || 1)),
    );
    for (let i = 0; i < copies; i++) {
      const page = pdf.addPage([LABEL_WIDTH_PT, LABEL_HEIGHT_PT]);
      drawLabel(page, barcode, spec, font, fontMono);
    }
  }

  return Buffer.from(await pdf.save());
}
