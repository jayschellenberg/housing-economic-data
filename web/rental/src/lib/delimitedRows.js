/*
 * Quote-aware CSV helpers, ported from the parcel search's
 * lib/delimitedRows.js (the paste/upload tokenizer that survived the
 * stacked-cell bug). The export writes RFC-style CSV with
 * QUOTE_MINIMAL, so a title containing a comma arrives quoted and a
 * quote inside a field arrives doubled — both handled here.
 */

/** DATA rows in a CSV (header excluded), counted without tokenizing. */
export function countDataRows(text) {
  const src = String(text || '');
  let rows = 0;
  let inQuotes = false;
  let seen = false;
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    if (inQuotes) {
      if (c === '"') {
        if (src[i + 1] === '"') i++;
        else inQuotes = false;
      }
      seen = true;
      continue;
    }
    if (c === '"') { inQuotes = true; seen = true; continue; }
    if (c === '\n' || c === '\r') {
      if (seen) rows++;
      seen = false;
      if (c === '\r' && src[i + 1] === '\n') i++;
      continue;
    }
    if (!seen && c.trim() !== '') seen = true;
  }
  if (seen) rows++;
  return Math.max(0, rows - 1);
}

/**
 * Quote-aware row tokenizer. Handles quoted fields with embedded
 * delimiters and newlines, escaped double-quotes (""), and \r\n / \n /
 * \r line endings. Completely empty rows are dropped.
 */
export function tokenizeRows(text, delimiter = ',') {
  const src = String(text || '');
  const rows = [];
  let row = [];
  let field = '';
  let inQuotes = false;
  let i = 0;
  const pushField = () => { row.push(field); field = ''; };
  const pushRow = () => {
    if (row.length > 1 || row[0] !== '') rows.push(row);
    row = [];
  };
  while (i < src.length) {
    const c = src[i];
    if (inQuotes) {
      if (c === '"') {
        if (src[i + 1] === '"') { field += '"'; i += 2; }
        else { inQuotes = false; i++; }
      } else { field += c; i++; }
    } else if (c === '"') {
      inQuotes = true; i++;
    } else if (c === delimiter) {
      pushField(); i++;
    } else if (c === '\r' || c === '\n') {
      pushField(); pushRow();
      if (c === '\r' && src[i + 1] === '\n') i += 2; else i++;
    } else {
      field += c; i++;
    }
  }
  if (field !== '' || row.length > 0) { pushField(); pushRow(); }
  return rows;
}
