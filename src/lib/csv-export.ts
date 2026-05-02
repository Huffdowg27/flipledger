/**
 * csv-export.ts — Shared CSV download utility.
 * Handles comma escaping, cents→dollars conversion, and Blob download.
 */

/** Format cents as dollar string for CSV (no $ sign, 2 decimals) */
export function centsToDollarStr(cents: number): string {
  return (cents / 100).toFixed(2);
}

/** Download a CSV file in the browser */
export function downloadCsv(filename: string, headers: string[], rows: (string | number)[][]) {
  const escape = (cell: string | number) => {
    const str = String(cell);
    if (str.includes(',') || str.includes('"') || str.includes('\n')) {
      return `"${str.replace(/"/g, '""')}"`;
    }
    return str;
  };

  const csvContent = [
    headers.map(escape).join(','),
    ...rows.map(r => r.map(escape).join(',')),
  ].join('\n');

  const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}
