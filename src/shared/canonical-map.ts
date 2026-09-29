/** Coordinate adapter for the source-confirmed 512 x 512 MAP storage grid.
 * Original first coordinate is the row, second coordinate is the column.
 * Centering the grid and the spawn beside Bob belong to this remake.
 */
export type MapPoint = { x: number; z: number };
export type MapDefinition = {
  originalId: number;
  name: string;
  modelId: number;
  textureId: number;
  kind: "npc" | "monster" | "resource" | "station" | "transition" | "decor" | "unmapped";
  family: string;
  role?: string;
  resource?: string;
  facts?: Record<string, unknown>;
  interactionIds?: number[];
  stats?: { hp: number; level: number; range: number; wanderRadius: number; secondaryFlagsRaw:number; aggressive:boolean; resistances: number[]; damage: { type: number; amount: number }[] };
};
export type MapPlacement = { index: number; originalId: number; flagsRaw: number };
export type CanonicalMapData = {
  version: 1;
  source: string;
  sha256: string;
  layout: { width: 512; height: 512; origin: 256; limit: 255; unit: 1 };
  spawn: MapPoint;
  terrain: number[];
  definitions: MapDefinition[];
  placements: MapPlacement[];
};
export const MAP_WIDTH = 512;
export const MAP_ORIGIN = 256;
export const MAP_LIMIT = 255;
export function mapPoint(index: number): MapPoint {
  return { x: Math.floor(index / MAP_WIDTH) - MAP_ORIGIN, z: index % MAP_WIDTH - MAP_ORIGIN };
}
export function mapIndex(x: number, z: number): number {
  const row = Math.floor(x + MAP_ORIGIN), column = Math.floor(z + MAP_ORIGIN);
  return row >= 0 && row < MAP_WIDTH && column >= 0 && column < MAP_WIDTH ? row * MAP_WIDTH + column : -1;
}
export function terrainHeight(map: Pick<CanonicalMapData, "terrain">, x: number, z: number): number {
  const row = Math.floor(x + MAP_ORIGIN), col = Math.floor(z + MAP_ORIGIN);
  if (row < 0 || row >= MAP_WIDTH - 1 || col < 0 || col >= MAP_WIDTH - 1) return 0;
  const dx = x + MAP_ORIGIN - row, dz = z + MAP_ORIGIN - col;
  const h = (r: number, c: number) => (map.terrain[r * MAP_WIDTH + c] & 15) * .375;
  // Matches the two triangles used by the new renderer; no claim about Classic interpolation.
  return dx + dz <= 1
    ? h(row, col) + (h(row + 1, col) - h(row, col)) * dx + (h(row, col + 1) - h(row, col)) * dz
    : h(row + 1, col + 1) + (h(row, col + 1) - h(row + 1, col + 1)) * (1 - dx) + (h(row + 1, col) - h(row + 1, col + 1)) * (1 - dz);
}
export function terrainWalkable(map: Pick<CanonicalMapData, "terrain">, x: number, z: number): boolean {
  if (!Number.isFinite(x) || !Number.isFinite(z) || Math.abs(x) > MAP_LIMIT || Math.abs(z) > MAP_LIMIT) return false;
  const index = mapIndex(x, z);
  // Original movement masks test bit 26 for solid cells. Tile walls are also checked
  // by terrainSegmentClear; object-high16 has not been promoted to collision flags.
  return index >= 0 && !(map.terrain[index] & 0x04000000);
}
export function terrainSegmentClear(map: Pick<CanonicalMapData, "terrain">, a: MapPoint, b: MapPoint): boolean {
  // Frame-sized steps can land a few ulps on either side of a tile vertex.
  // Treat those representations as the same boundary before traversing cells.
  const epsilon = 1e-9;
  const snap = (value: number) => Math.abs(value - Math.round(value)) <= epsilon ? Math.round(value) : value;
  a = { x: snap(a.x), z: snap(a.z) };
  b = { x: snap(b.x), z: snap(b.z) };
  if (!terrainWalkable(map, a.x, a.z) || !terrainWalkable(map, b.x, b.z)) return false;
  // The original renderer separates first-coordinate halves at 256. Walking across
  // this storage seam would join distinct areas until their transitions are decoded.
  if ((a.x < 0) !== (b.x < 0)) return false;
  const dx = b.x - a.x, dz = b.z - a.z;
  if (!dx && !dz) return true;
  const rowStep = Math.sign(dx), colStep = Math.sign(dz);
  const gridX = a.x + MAP_ORIGIN, gridZ = a.z + MAP_ORIGIN;
  let row = Math.floor(gridX), col = Math.floor(gridZ);
  const cellClear = (r: number, c: number) => r >= 0 && r < MAP_WIDTH && c >= 0 && c < MAP_WIDTH && !(map.terrain[r * MAP_WIDTH + c] & 0x04000000);
  const crossingClear = (r: number, c: number, nextRow: number, nextCol: number) => {
    if (!cellClear(r, c) || !cellClear(nextRow, nextCol)) return false;
    if (nextRow !== r && nextCol !== c && (!cellClear(nextRow, c) || !cellClear(r, nextCol))) return false;
    if (nextRow !== r && ((map.terrain[Math.max(r, nextRow) * MAP_WIDTH + c] | map.terrain[Math.max(r, nextRow) * MAP_WIDTH + nextCol]) & 0x00100000)) return false;
    if (nextCol !== c && ((map.terrain[r * MAP_WIDTH + Math.max(c, nextCol)] | map.terrain[nextRow * MAP_WIDTH + Math.max(c, nextCol)]) & 0x00200000)) return false;
    return true;
  };
  // Splitting a diagonal exactly at its vertex must keep the same four-cell
  // corner check as one uninterrupted segment, irrespective of floor()'s side.
  if (dx && dz && Number.isInteger(gridX) && Number.isInteger(gridZ)) {
    const beforeRow = row - (rowStep > 0 ? 1 : 0), beforeCol = col - (colStep > 0 ? 1 : 0);
    if (!crossingClear(beforeRow, beforeCol, beforeRow + rowStep, beforeCol + colStep)) return false;
  }
  const rowDelta = dx ? 1 / Math.abs(dx) : Infinity;
  const colDelta = dz ? 1 / Math.abs(dz) : Infinity;
  let rowAt = dx ? (rowStep > 0 ? row + 1 - gridX : gridX - row) / Math.abs(dx) : Infinity;
  let colAt = dz ? (colStep > 0 ? col + 1 - gridZ : gridZ - col) / Math.abs(dz) : Infinity;
  const timeTolerance = epsilon / Math.max(Math.abs(dx), Math.abs(dz), 1);
  // Exact grid DDA checks every crossed edge once, including endpoint contact.
  // Fixed-distance samples can disagree with shorter pieces of the same path.
  while (Math.min(rowAt, colAt) <= 1 + timeTolerance) {
    const simultaneous = Math.abs(rowAt - colAt) <= timeTolerance;
    const crossRow = simultaneous || rowAt < colAt;
    const crossCol = simultaneous || colAt < rowAt;
    const nextRow = row + (crossRow ? rowStep : 0), nextCol = col + (crossCol ? colStep : 0);
    if (!crossingClear(row, col, nextRow, nextCol)) return false;
    row = nextRow;
    col = nextCol;
    if (crossRow) rowAt += rowDelta;
    if (crossCol) colAt += colDelta;
  }
  return true;
}

/** Forever f573: tile range and wall edges, without movement's solid-cell rule.
 * Bounds and the separate-area seam remain constraints of this coordinate adapter.
 * Pass the original weapon range to include f573's Chebyshev range check.
 */
export function terrainCombatClear(map: Pick<CanonicalMapData, "terrain">, a: MapPoint, b: MapPoint, range = Infinity): boolean {
  if (![a.x, a.z, b.x, b.z].every(v => Number.isFinite(v) && Math.abs(v) <= MAP_LIMIT) || Number.isNaN(range) || range < 0) return false;
  if ((a.x < 0) !== (b.x < 0)) return false;
  let row = Math.floor(a.x + MAP_ORIGIN), col = Math.floor(a.z + MAP_ORIGIN);
  const endRow = Math.floor(b.x + MAP_ORIGIN), endCol = Math.floor(b.z + MAP_ORIGIN);
  const rowDistance = Math.abs(endRow - row), colDistance = Math.abs(endCol - col);
  const distance = Math.max(rowDistance, colDistance);
  if (distance > range) return false;
  if (distance === 0) return true;
  const rowStep = Math.fround((endRow - row) / distance), colStep = Math.fround((endCol - col) / distance);
  let floatRow = row, floatCol = col;
  const blocked = (r: number, c: number, mask: number) => {
    const word = map.terrain[r * MAP_WIDTH + c];
    // f573 treats both high bits together as a wall override, not as solidness.
    return (word >>> 30) !== 3 && !!(word & mask);
  };
  for (let step = 0; step < distance; step++) {
    floatRow = Math.fround(floatRow + rowStep);
    floatCol = Math.fround(floatCol + colStep);
    const nextRow = Math.trunc(floatRow), nextCol = Math.trunc(floatCol);
    // A diagonal follows one L-shaped pair of edges, chosen by the dominant
    // original axis. Testing both alternatives would reject valid source shots.
    if (colDistance > rowDistance) {
      if (nextCol !== col && blocked(row, Math.max(col, nextCol), 0x00200000)) return false;
      if (nextRow !== row && blocked(Math.max(row, nextRow), nextCol, 0x00100000)) return false;
    } else {
      if (nextRow !== row && blocked(Math.max(row, nextRow), col, 0x00100000)) return false;
      if (nextCol !== col && blocked(nextRow, Math.max(col, nextCol), 0x00200000)) return false;
    }
    row = nextRow;
    col = nextCol;
  }
  return true;
}
