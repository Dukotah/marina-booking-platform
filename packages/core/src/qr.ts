/**
 * Minimal, dependency-free QR code generator (ISO/IEC 18004).
 *
 * Built for the waiver sign-link flow: staff show a QR at the dock, the guest
 * scans it and signs on their own phone. Scope is deliberately narrow — byte
 * mode, error-correction level M, versions 1–10 (up to 213 bytes of payload:
 * plenty for any customer-portal URL) — so the whole thing stays a small,
 * testable module instead of a dependency.
 *
 * Everything the spec requires for a scannable symbol is here: finder /
 * separator / timing / alignment patterns, the dark module, format info
 * (BCH 15,5), version info for v7+ (Golay 18,6), Reed–Solomon EC over
 * GF(2^8) with block interleaving, and data masking chosen by the standard
 * four penalty rules.
 */

// ---------------------------------------------------------------------------
// GF(2^8) arithmetic (polynomial 0x11D) for Reed–Solomon
// ---------------------------------------------------------------------------

const GF_EXP = new Uint8Array(512);
const GF_LOG = new Uint8Array(256);
{
  let x = 1;
  for (let i = 0; i < 255; i++) {
    GF_EXP[i] = x;
    GF_LOG[x] = i;
    x <<= 1;
    if (x & 0x100) x ^= 0x11d;
  }
  for (let i = 255; i < 512; i++) GF_EXP[i] = GF_EXP[i - 255]!;
}

function gfMul(a: number, b: number): number {
  if (a === 0 || b === 0) return 0;
  return GF_EXP[GF_LOG[a]! + GF_LOG[b]!]!;
}

/**
 * Generator polynomial for `degree` EC codewords — the product of (x − α^d) for
 * d = 0..degree−1, stored little-endian (index k holds the x^k coefficient, so
 * the leading 1 sits at index `degree`).
 */
function rsGenerator(degree: number): Uint8Array {
  let poly = new Uint8Array([1]);
  for (let d = 0; d < degree; d++) {
    const next = new Uint8Array(poly.length + 1);
    for (let i = 0; i < poly.length; i++) {
      next[i] = next[i]! ^ gfMul(poly[i]!, GF_EXP[d]!);
      next[i + 1] = next[i + 1]! ^ poly[i]!;
    }
    poly = next;
  }
  return poly;
}

/** Reed–Solomon EC codewords for one data block (polynomial long division). */
function rsEncode(data: Uint8Array, degree: number): Uint8Array {
  const gen = rsGenerator(degree);
  const remainder = new Uint8Array(degree);
  for (const byte of data) {
    const factor = byte ^ remainder[0]!;
    remainder.copyWithin(0, 1);
    remainder[degree - 1] = 0;
    for (let i = 0; i < degree; i++) {
      // remainder[i] pairs with the x^(degree-1-i) coefficient of the
      // little-endian generator.
      remainder[i] = remainder[i]! ^ gfMul(gen[degree - 1 - i]!, factor);
    }
  }
  return remainder;
}

// ---------------------------------------------------------------------------
// Version tables (EC level M only), versions 1–10
// ---------------------------------------------------------------------------

/**
 * Block structure per version at EC level M:
 * [ecPerBlock, [dataCodewordsPerBlock, blockCount][]]. Straight from the spec's
 * table 9; exported for the round-trip test's de-interleaver.
 */
export const EC_BLOCKS_M: ReadonlyArray<readonly [number, ReadonlyArray<readonly [number, number]>]> = [
  [10, [[16, 1]]], // v1
  [16, [[28, 1]]], // v2
  [26, [[44, 1]]], // v3
  [18, [[32, 2]]], // v4
  [24, [[43, 2]]], // v5
  [16, [[27, 4]]], // v6
  [18, [[31, 4]]], // v7
  [22, [[38, 2], [39, 2]]], // v8
  [22, [[36, 3], [37, 2]]], // v9
  [26, [[43, 4], [44, 1]]], // v10
];

/** Alignment pattern center coordinates per version (1–10). */
const ALIGNMENT_CENTERS: ReadonlyArray<ReadonlyArray<number>> = [
  [],
  [6, 18],
  [6, 22],
  [6, 26],
  [6, 30],
  [6, 34],
  [6, 22, 38],
  [6, 24, 42],
  [6, 26, 46],
  [6, 28, 50],
];

/** Total data codewords available at level M for a version. */
function dataCapacity(version: number): number {
  const [, blocks] = EC_BLOCKS_M[version - 1]!;
  return blocks.reduce((sum, [size, count]) => sum + size * count, 0);
}

/** Smallest version whose byte-mode capacity fits `byteLength` payload bytes. */
function chooseVersion(byteLength: number): number {
  for (let v = 1; v <= 10; v++) {
    const countBits = v <= 9 ? 8 : 16;
    const capacityBits = dataCapacity(v) * 8;
    if (4 + countBits + byteLength * 8 <= capacityBits) return v;
  }
  throw new Error(`QR payload too long: ${byteLength} bytes exceeds version 10-M capacity`);
}

// ---------------------------------------------------------------------------
// Bit assembly
// ---------------------------------------------------------------------------

class BitBuffer {
  bits: number[] = [];
  push(value: number, length: number): void {
    for (let i = length - 1; i >= 0; i--) this.bits.push((value >>> i) & 1);
  }
  toBytes(totalBytes: number): Uint8Array {
    // Terminator (up to 4 zero bits) + pad to a byte boundary.
    const capacity = totalBytes * 8;
    const terminator = Math.min(4, capacity - this.bits.length);
    for (let i = 0; i < terminator; i++) this.bits.push(0);
    while (this.bits.length % 8 !== 0) this.bits.push(0);

    const bytes: number[] = [];
    for (let i = 0; i < this.bits.length; i += 8) {
      let b = 0;
      for (let j = 0; j < 8; j++) b = (b << 1) | this.bits[i + j]!;
      bytes.push(b);
    }
    // Alternating pad codewords per the spec.
    const PADS = [0xec, 0x11];
    let padIndex = 0;
    while (bytes.length < totalBytes) bytes.push(PADS[padIndex++ % 2]!);
    return Uint8Array.from(bytes);
  }
}

/** Data codewords (headers + payload + padding), then EC, interleaved. */
export function buildCodewords(payload: Uint8Array, version: number): Uint8Array {
  const buffer = new BitBuffer();
  buffer.push(0b0100, 4); // byte mode
  buffer.push(payload.length, version <= 9 ? 8 : 16);
  for (const byte of payload) buffer.push(byte, 8);
  const data = buffer.toBytes(dataCapacity(version));

  const [ecPerBlock, blockSpec] = EC_BLOCKS_M[version - 1]!;
  const blocks: Uint8Array[] = [];
  const ecBlocks: Uint8Array[] = [];
  let offset = 0;
  for (const [size, count] of blockSpec) {
    for (let i = 0; i < count; i++) {
      const block = data.slice(offset, offset + size);
      offset += size;
      blocks.push(block);
      ecBlocks.push(rsEncode(block, ecPerBlock));
    }
  }

  // Interleave: data codewords column-by-column across blocks, then EC likewise.
  const out: number[] = [];
  const maxData = Math.max(...blocks.map((b) => b.length));
  for (let i = 0; i < maxData; i++) {
    for (const block of blocks) if (i < block.length) out.push(block[i]!);
  }
  for (let i = 0; i < ecPerBlock; i++) {
    for (const block of ecBlocks) out.push(block[i]!);
  }
  return Uint8Array.from(out);
}

// ---------------------------------------------------------------------------
// Matrix construction
// ---------------------------------------------------------------------------

export interface QrMatrix {
  /** Modules per side (no quiet zone). */
  size: number;
  /** modules[row][col] — true is a dark module. */
  modules: boolean[][];
  version: number;
  /** Mask pattern (0–7) actually applied. */
  mask: number;
}

interface Grid {
  size: number;
  modules: boolean[][];
  /** True where a function pattern (or format/version area) owns the module. */
  reserved: boolean[][];
}

function emptyGrid(size: number): Grid {
  return {
    size,
    modules: Array.from({ length: size }, () => Array<boolean>(size).fill(false)),
    reserved: Array.from({ length: size }, () => Array<boolean>(size).fill(false)),
  };
}

function set(grid: Grid, row: number, col: number, dark: boolean): void {
  grid.modules[row]![col] = dark;
  grid.reserved[row]![col] = true;
}

function drawFinder(grid: Grid, top: number, left: number): void {
  for (let r = -1; r <= 7; r++) {
    for (let c = -1; c <= 7; c++) {
      const row = top + r;
      const col = left + c;
      if (row < 0 || row >= grid.size || col < 0 || col >= grid.size) continue;
      const inRing =
        r >= 0 && r <= 6 && c >= 0 && c <= 6 && (r === 0 || r === 6 || c === 0 || c === 6);
      const inCore = r >= 2 && r <= 4 && c >= 2 && c <= 4;
      set(grid, row, col, inRing || inCore); // separators land here as light modules
    }
  }
}

function drawAlignment(grid: Grid, centerRow: number, centerCol: number): void {
  for (let r = -2; r <= 2; r++) {
    for (let c = -2; c <= 2; c++) {
      const dark = Math.max(Math.abs(r), Math.abs(c)) !== 1;
      set(grid, centerRow + r, centerCol + c, dark);
    }
  }
}

function drawFunctionPatterns(grid: Grid, version: number): void {
  const size = grid.size;
  drawFinder(grid, 0, 0);
  drawFinder(grid, 0, size - 7);
  drawFinder(grid, size - 7, 0);

  // Timing patterns.
  for (let i = 8; i < size - 8; i++) {
    if (!grid.reserved[6]![i]) set(grid, 6, i, i % 2 === 0);
    if (!grid.reserved[i]![6]) set(grid, i, 6, i % 2 === 0);
  }

  // Alignment patterns: every centre pair except the three finder corners.
  // (They legitimately overlap the timing lines on v7+, so a "already reserved"
  // check is NOT the right skip rule.)
  const centers = ALIGNMENT_CENTERS[version - 1]!;
  const last = centers.length - 1;
  for (let i = 0; i < centers.length; i++) {
    for (let j = 0; j < centers.length; j++) {
      if ((i === 0 && j === 0) || (i === 0 && j === last) || (i === last && j === 0)) continue;
      drawAlignment(grid, centers[i]!, centers[j]!);
    }
  }

  // Dark module.
  set(grid, size - 8, 8, true);

  // Reserve format-info areas (filled in later, after masking).
  for (let i = 0; i < 9; i++) {
    if (!grid.reserved[8]![i]) set(grid, 8, i, false);
    if (!grid.reserved[i]![8]) set(grid, i, 8, false);
  }
  for (let i = 0; i < 8; i++) {
    if (!grid.reserved[8]![size - 1 - i]) set(grid, 8, size - 1 - i, false);
    if (!grid.reserved[size - 1 - i]![8]) set(grid, size - 1 - i, 8, false);
  }

  // Reserve + draw version info (v7+): two 6×3 blocks, Golay(18,6)-encoded.
  if (version >= 7) {
    let rem = version;
    for (let i = 0; i < 12; i++) rem = (rem << 1) ^ ((rem >>> 11) * 0x1f25);
    const bits = (version << 12) | rem; // 18 bits
    for (let i = 0; i < 18; i++) {
      const bit = ((bits >>> i) & 1) === 1;
      const a = Math.floor(i / 3);
      const b = (i % 3) + size - 11;
      set(grid, b, a, bit); // bottom-left block
      set(grid, a, b, bit); // top-right block
    }
  }
}

/** Place codeword bits in the standard upward/downward zigzag, right to left. */
function placeData(grid: Grid, codewords: Uint8Array): void {
  const size = grid.size;
  let bitIndex = 0;
  const totalBits = codewords.length * 8;
  let upward = true;
  for (let right = size - 1; right >= 1; right -= 2) {
    if (right === 6) right = 5; // vertical timing column is skipped entirely
    for (let vert = 0; vert < size; vert++) {
      const row = upward ? size - 1 - vert : vert;
      for (const col of [right, right - 1]) {
        if (grid.reserved[row]![col]) continue;
        let dark = false;
        if (bitIndex < totalBits) {
          const byte = codewords[bitIndex >>> 3]!;
          dark = ((byte >>> (7 - (bitIndex & 7))) & 1) === 1;
          bitIndex++;
        }
        grid.modules[row]![col] = dark; // remainder bits stay light
      }
    }
    upward = !upward;
  }
}

/** The 8 standard mask predicates. */
function maskBit(mask: number, row: number, col: number): boolean {
  switch (mask) {
    case 0: return (row + col) % 2 === 0;
    case 1: return row % 2 === 0;
    case 2: return col % 3 === 0;
    case 3: return (row + col) % 3 === 0;
    case 4: return (Math.floor(row / 2) + Math.floor(col / 3)) % 2 === 0;
    case 5: return ((row * col) % 2) + ((row * col) % 3) === 0;
    case 6: return (((row * col) % 2) + ((row * col) % 3)) % 2 === 0;
    default: return (((row + col) % 2) + ((row * col) % 3)) % 2 === 0;
  }
}

function applyMask(grid: Grid, mask: number): void {
  for (let r = 0; r < grid.size; r++) {
    for (let c = 0; c < grid.size; c++) {
      if (!grid.reserved[r]![c] && maskBit(mask, r, c)) {
        grid.modules[r]![c] = !grid.modules[r]![c];
      }
    }
  }
}

/** BCH(15,5)-encoded format info for EC level M + a mask, XORed per spec. */
export function formatInfoBits(mask: number): number {
  const data = (0b00 << 3) | mask; // '00' is EC level M
  let rem = data;
  for (let i = 0; i < 10; i++) rem = (rem << 1) ^ ((rem >>> 9) * 0x537);
  return (((data << 10) | rem) ^ 0x5412) & 0x7fff;
}

function drawFormatInfo(grid: Grid, mask: number): void {
  const bits = formatInfoBits(mask);
  const size = grid.size;
  const bit = (i: number): boolean => ((bits >>> i) & 1) === 1;

  // Copy 1, around the top-left finder (bit 14 first).
  const coords: Array<[number, number]> = [
    [8, 0], [8, 1], [8, 2], [8, 3], [8, 4], [8, 5], [8, 7], [8, 8],
    [7, 8], [5, 8], [4, 8], [3, 8], [2, 8], [1, 8], [0, 8],
  ];
  coords.forEach(([r, c], i) => {
    grid.modules[r]![c] = bit(14 - i);
  });

  // Copy 2: bits 0–7 right-to-left under the top-right finder, bits 8–14 down
  // the left of the bottom-left finder.
  for (let i = 0; i <= 7; i++) grid.modules[8]![size - 1 - i] = bit(i);
  for (let i = 8; i <= 14; i++) grid.modules[size - 15 + i]![8] = bit(i);
}

// ---------------------------------------------------------------------------
// Mask selection (standard penalty rules N1–N4)
// ---------------------------------------------------------------------------

function penalty(grid: Grid): number {
  const { size, modules } = grid;
  let score = 0;

  // N1: runs of 5+ same-colour modules, rows and columns.
  for (let axis = 0; axis < 2; axis++) {
    for (let i = 0; i < size; i++) {
      let run = 1;
      let prev = axis === 0 ? modules[i]![0]! : modules[0]![i]!;
      for (let j = 1; j < size; j++) {
        const cur = axis === 0 ? modules[i]![j]! : modules[j]![i]!;
        if (cur === prev) {
          run++;
          if (j === size - 1 && run >= 5) score += 3 + (run - 5);
        } else {
          if (run >= 5) score += 3 + (run - 5);
          run = 1;
          prev = cur;
        }
      }
    }
  }

  // N2: 2×2 blocks of one colour.
  for (let r = 0; r < size - 1; r++) {
    for (let c = 0; c < size - 1; c++) {
      const v = modules[r]![c]!;
      if (v === modules[r]![c + 1] && v === modules[r + 1]![c] && v === modules[r + 1]![c + 1]) {
        score += 3;
      }
    }
  }

  // N3: finder-like 1:1:3:1:1 pattern with 4 light modules on either side.
  const PATTERN = [true, false, true, true, true, false, true];
  const lightRun = (cells: (i: number) => boolean, start: number, len: number): boolean => {
    for (let i = 0; i < len; i++) {
      const idx = start + i;
      if (idx < 0 || idx >= size) continue; // outside the symbol counts as light
      if (cells(idx)) return false;
    }
    return true;
  };
  for (let axis = 0; axis < 2; axis++) {
    for (let i = 0; i < size; i++) {
      const cells = (j: number): boolean => (axis === 0 ? modules[i]![j]! : modules[j]![i]!);
      for (let j = 0; j <= size - 7; j++) {
        let match = true;
        for (let k = 0; k < 7; k++) {
          if (cells(j + k) !== PATTERN[k]) {
            match = false;
            break;
          }
        }
        if (match && (lightRun(cells, j - 4, 4) || lightRun(cells, j + 7, 4))) score += 40;
      }
    }
  }

  // N4: dark-module proportion, 10 points per 5% step away from 50%.
  let dark = 0;
  for (const row of modules) for (const m of row) if (m) dark++;
  const percent = (dark * 100) / (size * size);
  score += Math.floor(Math.abs(percent - 50) / 5) * 10;

  return score;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Encode text (UTF-8, byte mode, EC level M) into a QR module matrix. Picks the
 * smallest version 1–10 that fits and the mask with the lowest penalty score.
 */
export function encodeQr(text: string): QrMatrix {
  const payload = new TextEncoder().encode(text);
  const version = chooseVersion(payload.length);
  const size = version * 4 + 17;
  const codewords = buildCodewords(payload, version);

  let best: { grid: Grid; mask: number; score: number } | null = null;
  for (let mask = 0; mask < 8; mask++) {
    const grid = emptyGrid(size);
    drawFunctionPatterns(grid, version);
    placeData(grid, codewords);
    applyMask(grid, mask);
    drawFormatInfo(grid, mask);
    const score = penalty(grid);
    if (!best || score < best.score) best = { grid, mask, score };
  }

  return { size, modules: best!.grid.modules, version, mask: best!.mask };
}

export interface QrSvgOptions {
  /** Quiet-zone width in modules (spec minimum is 4). */
  margin?: number;
  /** Dark-module colour. */
  dark?: string;
  /** Background colour; 'none' for transparent. */
  light?: string;
}

/**
 * Render a QR matrix as a standalone SVG string (viewBox in module units, so it
 * scales crisply to any CSS size with `shape-rendering: crispEdges`).
 */
export function qrToSvg(matrix: QrMatrix, options: QrSvgOptions = {}): string {
  const margin = options.margin ?? 4;
  const dark = options.dark ?? '#0f172a';
  const light = options.light ?? '#ffffff';
  const total = matrix.size + margin * 2;

  let path = '';
  for (let r = 0; r < matrix.size; r++) {
    for (let c = 0; c < matrix.size; c++) {
      if (matrix.modules[r]![c]) path += `M${c + margin} ${r + margin}h1v1h-1z`;
    }
  }

  return (
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${total} ${total}" ` +
    `shape-rendering="crispEdges" role="img" aria-label="QR code">` +
    (options.light === 'none' ? '' : `<rect width="${total}" height="${total}" fill="${light}"/>`) +
    `<path d="${path}" fill="${dark}"/></svg>`
  );
}

/** Convenience: encode text straight to an SVG string. */
export function qrSvg(text: string, options?: QrSvgOptions): string {
  return qrToSvg(encodeQr(text), options);
}
