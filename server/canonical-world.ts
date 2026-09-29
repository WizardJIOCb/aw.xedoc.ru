import type { CanonicalMapData, MapPoint } from "../src/shared/canonical-map.js";
import { mapPoint, terrainWalkable } from "../src/shared/canonical-map.js";
import type { Entity, WorldData } from "../src/shared/types.js";
import metadata from "../data/reference/object-metadata.json";

export const mapVersion = (map: CanonicalMapData) => `${map.sha256}:centered-v1`;
export function closestWalkable(map: CanonicalMapData, point: MapPoint): MapPoint {
  if (terrainWalkable(map, point.x, point.z)) return point;
  for (let radius = 1; radius <= 12; radius++)
    for (let dx = -radius; dx <= radius; dx++)
      for (let dz = -radius; dz <= radius; dz++) {
        if (Math.max(Math.abs(dx), Math.abs(dz)) !== radius) continue;
        const candidate = { x: Math.floor(point.x) + dx + .5, z: Math.floor(point.z) + dz + .5 };
        if (terrainWalkable(map, candidate.x, candidate.z)) return candidate;
      }
  return { ...map.spawn };
}

/** Retains every interactive placement. AI, HP, stocks and drops below are remake rules. */
export function populateCanonicalWorld(world: WorldData, map: CanonicalMapData): WorldData {
  const definitions = new Map(map.definitions.map(d => [d.originalId, d]));
  const originalObjects = new Map(metadata.map(d => [d.originalId, d]));
  const itemIds = new Set(world.items.map(i => i.id));
  const stationAliases: Record<string, string> = { "furnace": "furnace", "press": "press", "microwave oven": "kitchen", "sewing machine": "loom", "cutting machine": "cutting_machine", "spectralizer": "spectralizer", "combine": "combine", "sink": "sink" };
  const entities: Entity[] = [];
  for (const placement of map.placements) {
    const definition = definitions.get(placement.originalId)!;
    const original = originalObjects.get(placement.originalId);
    if (["decor", "unmapped"].includes(definition.kind)) continue;
    const position = mapPoint(placement.index);
    position.x += .5; position.z += .5;
    const role = definition.role;
    const entity: Entity = {
      id: `aw:${placement.index}`, type: definition.kind,
      name: role === "bob" ? "Отшельник Боб" : role === "bank" ? "Банкир" : role === "trader" ? definition.family === "droid" ? "Робот-торговец" : "Торговец" : definition.name.trim(),
      ...position, originalId: placement.originalId, placementIndex: placement.index,
      family: definition.family, role, modelId: definition.modelId,
      state: definition.kind === "station" ? stationAliases[definition.name.trim().toLowerCase().replace(/\s+/g, " ")] ?? definition.name.trim().toLowerCase().replace(/\s+/g, "_") : undefined,
    };
    if (definition.kind === "monster") {
      entity.level = original?.level || Number(definition.facts?.creatureLevel) || 1;
      entity.hp = entity.maxHp = original && original.hp > 0 && original.hp < 65535 ? original.hp : 18 + entity.level * 5;
      entity.attackRange = original?.range || 1;
      entity.resistances = original?.resistances;
      entity.damage = original?.damage;
      entity.alive = true;
      const flags = original?.secondaryFlagsRaw ?? 0;
      entity.state = ((flags & 16 ? flags & 253 : flags) & 2) ? "aggressive" : "passive";
      const drop = definition.family === "bird" ? "raw_chicken" : "raw_meat";
      if (itemIds.has(drop)) entity.resource = drop;
    } else if (definition.kind === "resource") {
      entity.resource = definition.resource && itemIds.has(definition.resource) ? definition.resource : undefined;
      entity.stock = 30; entity.alive = true;
      entity.level = Number(definition.facts?.miningLevel) || 1;
    }
    if (entity.type === "station") {
      const compatibility: Record<string, string[]> = { press: ["press", "forge"], cutting_machine: ["cutting_machine", "workbench"], loom: ["loom"], spectralizer: ["spectralizer", "laboratory"], kitchen: ["kitchen", "campfire"], combine: ["combine", "kitchen"] };
      entity.capabilities = compatibility[entity.state!] ?? [entity.state!];
    }
    entities.push(entity);
  }
  return { ...world, entities };
}
