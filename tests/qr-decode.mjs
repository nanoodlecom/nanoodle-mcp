/**
 * Independent QR decoder for tests — the reverse of the trimmed Nayuki
 * byte-mode / ECC-level-M encoder shipped as nanoodle's `qrModules` (see
 * qrSvg / qrTerminal in ../src/http.mjs). It rebuilds the function-module map,
 * recovers the mask from the format info, unmasks, reads codewords in the
 * encoder's zigzag, de-interleaves the blocks, and parses the byte segment.
 *
 * No Reed-Solomon error correction: our encoder emits a pristine matrix, so we
 * read the data codewords straight through. Because this is a genuinely separate
 * implementation (decode, not encode), a round-trip through it proves the exact
 * bytes a phone camera would read back — i.e. that the QR actually scans — and
 * guards the trimmed port against regressions. It is NOT a general-purpose
 * decoder (it assumes clean input and ECC level M) and is never shipped.
 */

const ECC_PER_BLOCK = [-1, 10, 16, 26, 18, 24, 16, 18, 22, 22, 26, 30, 22, 22, 24, 24, 28, 28, 26, 26, 26, 26, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28];
const NUM_BLOCKS   = [-1, 1, 1, 1, 2, 2, 4, 4, 4, 5, 5, 5, 8, 9, 9, 10, 10, 11, 13, 14, 16, 17, 17, 18, 20, 21, 23, 25, 26, 28, 29, 31, 33, 35, 37, 38, 40, 43, 45, 47, 49];

function numRawDataModules(ver) {
  let result = (16 * ver + 128) * ver + 64;
  if (ver >= 2) {
    const numAlign = Math.floor(ver / 7) + 2;
    result -= (25 * numAlign - 10) * numAlign - 55;
    if (ver >= 7) result -= 36;
  }
  return result;
}
function alignmentPatternPositions(version, size) {
  if (version === 1) return [];
  const numAlign = Math.floor(version / 7) + 2;
  const step = version === 32 ? 26 : Math.ceil((version * 4 + 4) / (numAlign * 2 - 2)) * 2;
  const result = [6];
  for (let pos = size - 7; result.length < numAlign; pos -= step) result.splice(1, 0, pos);
  return result;
}

/** Parse a qrSvg() string back into a boolean module matrix (margin stripped). */
export function svgToMatrix(svg) {
  const vb = svg.match(/viewBox="0 0 (\d+) \d+"/);
  if (!vb) throw new Error("no viewBox in svg");
  const margin = 3; // must match qrSvg's margin
  const size = Number(vb[1]) - margin * 2;
  const m = Array.from({ length: size }, () => new Array(size).fill(false));
  for (const mm of svg.matchAll(/M(\d+) (\d+)h1v1h-1z/g)) {
    m[Number(mm[2]) - margin][Number(mm[1]) - margin] = true;
  }
  return m;
}

/** Decode a module matrix (from qrModules or svgToMatrix) back to its string. */
export function qrDecode(m) {
  const size = m.length;
  const version = (size - 17) / 4;

  // --- Rebuild the function-module map exactly as the encoder marked it ---
  const isF = Array.from({ length: size }, () => new Array(size).fill(false));
  const setF = (x, y) => { if (x >= 0 && x < size && y >= 0 && y < size) isF[y][x] = true; };
  for (let i = 0; i < size; i++) { setF(6, i); setF(i, 6); }               // timing
  const finder = (x, y) => { for (let dy = -4; dy <= 4; dy++) for (let dx = -4; dx <= 4; dx++) setF(x + dx, y + dy); };
  finder(3, 3); finder(size - 4, 3); finder(3, size - 4);                   // finders + separators
  const ap = alignmentPatternPositions(version, size);
  for (let i = 0; i < ap.length; i++) for (let j = 0; j < ap.length; j++) {
    if (!((i === 0 && j === 0) || (i === 0 && j === ap.length - 1) || (i === ap.length - 1 && j === 0)))
      for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) setF(ap[i] + dx, ap[j] + dy);
  }
  for (let a = 0; a <= 5; a++) setF(8, a);                                  // format info
  setF(8, 7); setF(8, 8); setF(7, 8);
  for (let i = 9; i < 15; i++) setF(14 - i, 8);
  for (let i = 0; i < 8; i++) setF(size - 1 - i, 8);
  for (let i = 8; i < 15; i++) setF(8, size - 15 + i);
  setF(8, size - 8);
  if (version >= 7) {                                                       // version info
    for (let j = 0; j < 18; j++) { const a = size - 11 + j % 3, b = Math.floor(j / 3); setF(a, b); setF(b, a); }
  }

  // --- Recover the mask from the top-left format-info copy ---
  let fbits = 0;
  const put = (i, bit) => { if (bit) fbits |= 1 << i; };
  for (let a = 0; a <= 5; a++) put(a, m[a][8]);
  put(6, m[7][8]); put(7, m[8][8]); put(8, m[8][7]);
  for (let i = 9; i < 15; i++) put(i, m[8][14 - i]);
  const mask = ((fbits ^ 0x5412) >> 10) & 7;

  // --- Undo the data mask (function modules are never masked) ---
  const g = m.map((r) => r.slice());
  const maskFn = (x, y) => {
    switch (mask) {
      case 0: return (x + y) % 2 === 0;
      case 1: return y % 2 === 0;
      case 2: return x % 3 === 0;
      case 3: return (x + y) % 3 === 0;
      case 4: return (Math.floor(x / 3) + Math.floor(y / 2)) % 2 === 0;
      case 5: return (x * y) % 2 + (x * y) % 3 === 0;
      case 6: return ((x * y) % 2 + (x * y) % 3) % 2 === 0;
      default: return ((x + y) % 2 + (x * y) % 3) % 2 === 0;
    }
  };
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++)
    if (!isF[y][x] && maskFn(x, y)) g[y][x] = !g[y][x];

  // --- Read codewords in the same zigzag order the encoder wrote them ---
  const bits = [];
  for (let right = size - 1; right >= 1; right -= 2) {
    if (right === 6) right = 5;
    for (let vert = 0; vert < size; vert++) {
      for (let j = 0; j < 2; j++) {
        const x = right - j;
        const upward = ((right + 1) & 2) === 0;
        const y = upward ? size - 1 - vert : vert;
        if (!isF[y][x]) bits.push(g[y][x] ? 1 : 0);
      }
    }
  }
  const allCw = [];
  for (let i = 0; i + 8 <= bits.length; i += 8) {
    let b = 0;
    for (let k = 0; k < 8; k++) b = (b << 1) | bits[i + k];
    allCw.push(b);
  }

  // --- De-interleave blocks (reverse of the encoder's column-major read) ---
  const numBlocks = NUM_BLOCKS[version];
  const blockEccLen = ECC_PER_BLOCK[version];
  const rawCw = Math.floor(numRawDataModules(version) / 8);
  const numShort = numBlocks - (rawCw % numBlocks);
  const shortLen = Math.floor(rawCw / numBlocks);
  const blocks = Array.from({ length: numBlocks }, () => new Array(shortLen + 1));
  let idx = 0;
  for (let p = 0; p < shortLen + 1; p++) {
    for (let q = 0; q < numBlocks; q++) {
      if (p !== shortLen - blockEccLen || q >= numShort) blocks[q][p] = allCw[idx++];
    }
  }
  const data = [];
  for (let b = 0; b < numBlocks; b++) {
    const dataLen = shortLen - blockEccLen + (b < numShort ? 0 : 1);
    for (let p = 0; p < dataLen; p++) data.push(blocks[b][p]);
  }

  // --- Parse byte-mode segment: 4-bit mode, char count, then UTF-8 bytes ---
  const db = [];
  for (const c of data) for (let k = 7; k >= 0; k--) db.push((c >> k) & 1);
  let bp = 0;
  const take = (n) => { let v = 0; for (let k = 0; k < n; k++) v = (v << 1) | db[bp++]; return v; };
  const mode = take(4);
  if (mode !== 4) throw new Error("not byte mode (mode indicator " + mode + ")");
  const len = take(version < 10 ? 8 : 16);
  const bytes = [];
  for (let i = 0; i < len; i++) bytes.push(take(8));
  return new TextDecoder().decode(Uint8Array.from(bytes));
}
