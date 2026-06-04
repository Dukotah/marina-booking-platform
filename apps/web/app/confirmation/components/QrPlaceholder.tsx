/**
 * Deterministic QR-style placeholder for a booking confirmation.
 *
 * A real QR image will be generated server-side (or via an encoder lib) later;
 * until then we render a stable, scannable-looking matrix derived purely from
 * the order number so staff have a consistent visual to match against the order.
 * It is intentionally NOT a real QR code — the order number is shown in plain
 * text beneath it for check-in, which is the source of truth.
 *
 * Pure/deterministic: the same order number always yields the same pattern, so
 * it is safe to render in a server component without hydration mismatch.
 */

const GRID = 21; // classic QR module count for the smallest version

/**
 * Cheap, dependency-free hash → 32-bit unsigned int. Stable across runtimes so
 * the rendered matrix is identical on server and client.
 */
function hash32(input: string): number {
  let h = 2166136261 >>> 0; // FNV-1a offset basis
  for (let i = 0; i < input.length; i += 1) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 16777619) >>> 0; // FNV prime
  }
  return h >>> 0;
}

/** Whether the module at (row, col) should be filled, derived from the seed. */
function isFilled(seed: number, row: number, col: number): boolean {
  // Mix the seed with the cell coordinates, then take a bit.
  let v = (seed ^ Math.imul(row + 1, 73856093) ^ Math.imul(col + 1, 19349663)) >>> 0;
  v = Math.imul(v ^ (v >>> 13), 0x5bd1e995) >>> 0;
  return ((v >>> 7) & 1) === 1;
}

/** Render a fixed finder square (the three corner squares of a QR code). */
function isFinder(row: number, col: number): boolean {
  const inBox = (r0: number, c0: number) =>
    row >= r0 && row < r0 + 7 && col >= c0 && col < c0 + 7;
  return inBox(0, 0) || inBox(0, GRID - 7) || inBox(GRID - 7, 0);
}

/** A module that belongs to a finder pattern (concentric 7x7 / 5x5 / 3x3). */
function finderFilled(row: number, col: number): boolean {
  const local = (r0: number, c0: number) => {
    const r = row - r0;
    const c = col - c0;
    const ring = Math.max(Math.abs(r - 3), Math.abs(c - 3));
    return ring !== 2; // filled border, gap, filled center
  };
  if (row < 7 && col < 7) return local(0, 0);
  if (row < 7 && col >= GRID - 7) return local(0, GRID - 7);
  if (row >= GRID - 7 && col < 7) return local(GRID - 7, 0);
  return false;
}

export function QrPlaceholder({
  value,
  size = 160,
}: {
  value: string;
  size?: number;
}) {
  const seed = hash32(value);
  const cell = size / GRID;

  const rects: React.ReactNode[] = [];
  for (let row = 0; row < GRID; row += 1) {
    for (let col = 0; col < GRID; col += 1) {
      const finder = isFinder(row, col);
      const filled = finder ? finderFilled(row, col) : isFilled(seed, row, col);
      if (!filled) continue;
      rects.push(
        <rect
          key={`${row}-${col}`}
          x={col * cell}
          y={row * cell}
          width={cell}
          height={cell}
          rx={cell * 0.15}
        />,
      );
    }
  }

  return (
    <svg
      width={size}
      height={size}
      viewBox={`0 0 ${size} ${size}`}
      role="img"
      aria-label={`Check-in code for order ${value}`}
      className="rounded-lg bg-white"
      shapeRendering="crispEdges"
    >
      <rect x={0} y={0} width={size} height={size} fill="#ffffff" />
      <g fill="#0f172a">{rects}</g>
    </svg>
  );
}

export default QrPlaceholder;
