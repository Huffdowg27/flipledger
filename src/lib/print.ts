/**
 * macOS print helper. Spools a PDF buffer to a CUPS printer via the
 * standard `lpr` command. Used by the listing tool to send Amazon labels
 * straight to Parker's Rollo thermal printer.
 *
 * The printer name comes from settings.listing_rollo_printer_name (defaults
 * to "Printer_ThermalPrinter" — the CUPS queue name, not the display name).
 *
 * Failure modes — all caught and returned cleanly so the UI can fall back to
 * "download PDF" if printing breaks:
 *   - Printer offline / not reachable
 *   - Printer name doesn't match a CUPS queue
 *   - PDF is malformed
 *   - User on Linux/Windows (lpr command differs or absent)
 *
 * On Linux: lpr usually exists with the same flags via cups-bsd, so this
 * happens to work there too. On Windows it would need a different shim;
 * not implemented since FlipLedger is macOS-only for now.
 */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs/promises';

const execFileAsync = promisify(execFile);

export interface PrintResult {
  success: boolean;
  printer: string;
  jobId?: string;
  error?: string;
  bytesQueued?: number;
}

/**
 * Print a PDF buffer to a named CUPS printer. Returns success/error info
 * so the caller can decide whether to retry, fall back to download, etc.
 */
export async function printPdfBuffer(
  pdfBuffer: Buffer,
  printerName: string,
  jobTitle: string = 'FlipLedger Label'
): Promise<PrintResult> {
  // Write the PDF to a tempfile first — `lpr` reads from stdin too, but
  // some CUPS configs choke on large PDFs piped via stdin. Using a real file
  // is more reliable.
  const tmpDir = os.tmpdir();
  const safeTitle = jobTitle.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 60);
  const tmpFile = path.join(tmpDir, `flipledger-label-${Date.now()}-${safeTitle}.pdf`);

  try {
    // Resolve the target queue: the configured name if it matches, otherwise
    // auto-pick the first detected 4x6 label printer. This means direct print
    // works the moment any 4x6 printer is installed, with no manual queue name.
    const { queue: queueName, detected } = await resolveLabelPrinter(printerName);
    if (!queueName) {
      const available = detected.length > 0 ? detected.map((p) => p.name).join(', ') : 'none';
      return {
        success: false,
        printer: printerName,
        error: printerName.trim()
          ? `Printer queue "${printerName}" was not found and no 4x6 label printer was detected. Available printers: ${available}.`
          : `No 4x6 label printer detected. Install a thermal/label printer (Rollo, Zebra, DYMO, …) in macOS, then it will be picked automatically. Available printers: ${available}.`,
      };
    }

    await fs.writeFile(tmpFile, pdfBuffer);

    // `lpr -P <queue> -T <title> <file>` — standard CUPS submit
    const { stdout, stderr } = await execFileAsync('lpr', [
      '-P', queueName,
      '-T', jobTitle,
      tmpFile,
    ]);

    // lpr is silent on success; any output to stderr is usually a warning
    if (stderr && stderr.trim()) {
      console.warn('[print] lpr stderr:', stderr.trim());
    }

    // Try to read job id back from `lpq` (best-effort)
    let jobId: string | undefined;
    try {
      const { stdout: lpq } = await execFileAsync('lpq', ['-P', queueName]);
      const match = lpq.match(/(\d+)\s+\d+\s+\d+\s+bytes/);
      if (match) jobId = match[1];
    } catch { /* best-effort */ }

    return {
      success: true,
      printer: queueName,
      jobId,
      bytesQueued: pdfBuffer.length,
    };
  } catch (err: unknown) {
    const errorMsg = err instanceof Error ? err.message : String(err);
    return {
      success: false,
      printer: printerName,
      error: errorMsg,
    };
  } finally {
    // Clean up tempfile (don't fail on unlink errors)
    fs.unlink(tmpFile).catch(() => {});
  }
}

/**
 * Verify a printer name matches a known CUPS queue. Used by the API to
 * give a clearer error than "lpr: unknown destination" when the user's
 * configured printer name is wrong.
 */
export async function listAvailablePrinters(): Promise<string[]> {
  try {
    const { stdout } = await execFileAsync('lpstat', ['-p']);
    // Output: "printer Printer_ThermalPrinter is idle..."
    const printers: string[] = [];
    for (const line of stdout.split('\n')) {
      const match = line.match(/^printer\s+(\S+)/);
      if (match) printers.push(match[1]);
    }
    return printers;
  } catch {
    return [];
  }
}

function resolvePrinterQueue(configuredName: string, availablePrinters: string[]): string | null {
  const trimmed = configuredName.trim();
  if (!trimmed) return null;

  const candidates = [
    trimmed,
    trimmed.replace(/\s+/g, '_'),
    trimmed.replace(/_+/g, ' '),
  ];

  for (const candidate of candidates) {
    const exact = availablePrinters.find((printer) => printer === candidate);
    if (exact) return exact;
  }

  const normalizedCandidates = candidates.map(normalizePrinterName);
  return availablePrinters.find((printer) =>
    normalizedCandidates.includes(normalizePrinterName(printer))
  ) || null;
}

function normalizePrinterName(name: string): string {
  return name.toLowerCase().replace(/[\s_-]+/g, '');
}

// ── 4x6 label-printer detection ───────────────────────────────────────────

export interface PrinterInfo {
  name: string;          // CUPS queue name
  makeModel: string;     // printer-make-and-model, if known
  pageSizes: string[];   // supported PageSize tokens
  fourBySix: boolean;    // looks like a 4x6 thermal label printer
}

// A media token that means ~4x6 inches (either orientation). Covers PostScript
// point sizes (4in=288pt, 6in=432pt), inch labels, and 102x152mm.
const FOUR_BY_SIX_MEDIA = /w288h432|w432h288|(?:\b|_)(?:4(?:\.0+)?x6|6x4(?:\.0+)?)(?:in)?\b|10[12](?:\.\d+)?x15[24]/i;
// Make/model (or queue name) hints for thermal label printers.
const THERMAL_HINT = /rollo|zebra|dymo|munbyn|thermal|\blabel\b|zpl|\btsc\b|brother\s*ql|godex|bixolon|phomemo|polono|arkscan|jadens/i;

function looksFourBySix(pageSizes: string[], makeModel: string, name: string): boolean {
  if (pageSizes.some((s) => FOUR_BY_SIX_MEDIA.test(s))) return true;
  return THERMAL_HINT.test(makeModel) || THERMAL_HINT.test(name);
}

/**
 * Detect installed CUPS queues with their media capabilities, flagging which
 * look like 4x6 thermal label printers (by supported media size, with a
 * make/model fallback). Used to auto-pick a label printer and to drive the
 * Settings printer picker.
 */
export async function listDetectedPrinters(): Promise<PrinterInfo[]> {
  const names = await listAvailablePrinters();
  const out: PrinterInfo[] = [];
  for (const name of names) {
    let pageSizes: string[] = [];
    let makeModel = '';
    try {
      const { stdout } = await execFileAsync('lpoptions', ['-p', name, '-l']);
      const line = stdout.split('\n').find((l) => /^PageSize/i.test(l)) || '';
      pageSizes = line.replace(/^PageSize[^:]*:/i, '').trim().split(/\s+/)
        .filter(Boolean).map((s) => s.replace(/^\*/, ''));
    } catch { /* queue without a PPD — leave empty */ }
    try {
      const { stdout } = await execFileAsync('lpoptions', ['-p', name]);
      const m = stdout.match(/printer-make-and-model='([^']*)'/);
      makeModel = m ? m[1] : '';
    } catch { /* best-effort */ }
    out.push({ name, makeModel, pageSizes, fourBySix: looksFourBySix(pageSizes, makeModel, name) });
  }
  return out;
}

/**
 * Decide which CUPS queue to print labels to:
 *  - the configured name if it matches an installed queue, else
 *  - the first detected 4x6 label printer (auto), else
 *  - null (nothing usable).
 */
export async function resolveLabelPrinter(
  configuredName: string | null | undefined,
): Promise<{ queue: string | null; auto: boolean; detected: PrinterInfo[] }> {
  const detected = await listDetectedPrinters();
  const names = detected.map((p) => p.name);
  const configured = (configuredName || '').trim();
  const matched = configured ? resolvePrinterQueue(configured, names) : null;
  if (matched) return { queue: matched, auto: false, detected };
  const fourBySix = detected.find((p) => p.fourBySix);
  if (fourBySix) return { queue: fourBySix.name, auto: true, detected };
  return { queue: null, auto: false, detected };
}
