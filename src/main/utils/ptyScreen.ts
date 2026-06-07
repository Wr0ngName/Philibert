/**
 * Minimal PTY screen buffer renderer.
 *
 * Processes raw PTY output through a virtual screen buffer, tracking cursor
 * movements and character writes. Unlike stripAnsi (which discards cursor
 * movement sequences), this preserves characters that were written in
 * previous rendering frames and later skipped via ESC[nC (cursor-forward)
 * by the CLI's Ink differential renderer.
 *
 * Used as a fallback for OAuth token extraction when stripAnsi-based
 * extraction loses characters due to cursor-forward sequences.
 */

/**
 * Render raw PTY output through a virtual screen buffer and return the
 * final screen content as plain text (one string per row, joined by \n).
 */
export function renderPtyScreen(raw: string): string {
  // Screen buffer: row → (col → character)
  const screen = new Map<number, Map<number, string>>();
  let row = 1;
  let col = 1;

  const setCell = (r: number, c: number, ch: string): void => {
    let rowMap = screen.get(r);
    if (!rowMap) {
      rowMap = new Map();
      screen.set(r, rowMap);
    }
    rowMap.set(c, ch);
  };

  let i = 0;
  while (i < raw.length) {
    const ch = raw[i];

    if (ch === '\x1b' && i + 1 < raw.length && raw[i + 1] === '[') {
      // CSI sequence: ESC [ <params> <final>
      i += 2;
      let params = '';
      while (i < raw.length && (raw[i] >= '0' && raw[i] <= '9' || raw[i] === ';' || raw[i] === '?')) {
        params += raw[i];
        i++;
      }
      if (i >= raw.length) break;
      const final = raw[i];
      i++;

      const numParams = params.replace(/^\?/, '').split(';').map(s => parseInt(s || '1', 10));

      switch (final) {
        case 'H': case 'f':
          row = numParams[0] || 1;
          col = (numParams.length > 1 ? numParams[1] : 1) || 1;
          break;
        case 'A':
          row = Math.max(1, row - (numParams[0] || 1));
          break;
        case 'B':
          row += (numParams[0] || 1);
          break;
        case 'C':
          col += (numParams[0] || 1);
          break;
        case 'D':
          col = Math.max(1, col - (numParams[0] || 1));
          break;
        case 'E':
          row += (numParams[0] || 1);
          col = 1;
          break;
        case 'F':
          row = Math.max(1, row - (numParams[0] || 1));
          col = 1;
          break;
        case 'G':
          col = numParams[0] || 1;
          break;
        case 'd':
          row = numParams[0] || 1;
          break;
        case 'J': {
          const mode = numParams[0] || 0;
          if (mode === 2 || mode === 3) {
            screen.clear();
          } else if (mode === 0) {
            // Erase below: clear current row from col onward, clear all rows below
            const rowMap = screen.get(row);
            if (rowMap) for (const c of [...rowMap.keys()]) { if (c >= col) rowMap.delete(c); }
            for (const r of [...screen.keys()]) { if (r > row) screen.delete(r); }
          }
          break;
        }
        case 'K': {
          const mode = numParams[0] || 0;
          const rowMap = screen.get(row);
          if (rowMap) {
            if (mode === 0) {
              for (const c of [...rowMap.keys()]) { if (c >= col) rowMap.delete(c); }
            } else if (mode === 1) {
              for (const c of [...rowMap.keys()]) { if (c <= col) rowMap.delete(c); }
            } else if (mode === 2) {
              rowMap.clear();
            }
          }
          break;
        }
        // All other CSI sequences (SGR colors, modes, etc.) — ignore
      }
    } else if (ch === '\x1b' && i + 1 < raw.length && raw[i + 1] === ']') {
      // OSC sequence: ESC ] ... BEL or ST
      i += 2;
      while (i < raw.length) {
        if (raw[i] === '\x07') { i++; break; }
        if (raw[i] === '\x1b' && i + 1 < raw.length && raw[i + 1] === '\\') { i += 2; break; }
        i++;
      }
    } else if (ch === '\x1b') {
      // Other escape (2-byte) — skip both bytes
      i += 2;
    } else if (ch === '\r') {
      col = 1;
      i++;
    } else if (ch === '\n') {
      row++;
      col = 1;
      i++;
    } else if (ch === '\x08') {
      if (col > 1) col--;
      i++;
    } else if (ch < '\x20' && ch !== '\t') {
      // Other control characters — skip
      i++;
    } else {
      // Printable character — write to screen buffer
      setCell(row, col, ch);
      col++;
      i++;
    }
  }

  // Convert screen buffer to text lines
  if (screen.size === 0) return '';
  const sortedRows = [...screen.keys()].sort((a, b) => a - b);
  const lines: string[] = [];
  for (const r of sortedRows) {
    const rowMap = screen.get(r)!;
    const cols = [...rowMap.keys()];
    if (cols.length === 0) continue;
    cols.sort((a, b) => a - b);
    const maxCol = cols[cols.length - 1];
    let line = '';
    for (let c = 1; c <= maxCol; c++) {
      line += rowMap.get(c) ?? ' ';
    }
    lines.push(line.trimEnd());
  }
  return lines.join('\n');
}
