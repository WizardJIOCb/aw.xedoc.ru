/** Static public data transformation. Never instantiates original WASM or copies original art. */
import { readFile, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { resolve } from "node:path";

const input = process.argv[2];
if (!input) throw new Error("Usage: node scripts/transform-map.mjs <webdata.data> [output.json]");
const bytes = await readFile(input);
if (bytes.toString("ascii", 0, 4) !== "AWP\0" || bytes.readUInt32LE(4) !== 1) throw new Error("Unsupported AWP archive");
const count = bytes.readUInt32LE(8), start = bytes.readUInt32LE(12);
if (start !== 16 + 16 * count || count > 5000) throw new Error("Invalid directory");
const chunks = Array.from({ length: count }, (_, i) => {
  const at = 16 + i * 16, type = bytes.readUInt32LE(at), offset = bytes.readUInt32LE(at + 4), size = bytes.readUInt32LE(at + 8);
  if (offset < start || offset + size > bytes.length || size !== bytes.readUInt32LE(at + 12)) throw new Error(`Invalid chunk ${i}`);
  return { type, size, data: bytes.subarray(offset, offset + size) };
});
const mapChunk = chunks.find(c => c.type === 5 && c.data.toString("ascii", 0, 4) === "MAP\0");
const objects = chunks.find(c => c.type === 4 && c.size === 256000 && c.data.toString("ascii", 0, 7) === "Credits");
if (!mapChunk || mapChunk.size !== 2097160 || !objects) throw new Error("Confirmed MAP/object layout unavailable");
const catalog = JSON.parse(await readFile(resolve("data/reference/catalog.json"), "utf8"));
const interactions = JSON.parse(await readFile(resolve("data/reference/interactions.json"), "utf8"));
const originalMetadata = new Map(JSON.parse(await readFile(resolve("data/reference/object-metadata.json"), "utf8")).map(r => [r.originalId,r]));
const world = JSON.parse(await readFile(resolve("data/world.json"), "utf8"));
const names = new Map(catalog.map(row => [row.originalId, row]));
const items = new Map(world.items.map(row => [row.originalId, row.id]));
const terrain = Array.from({ length: 512 * 512 }, (_, i) => mapChunk.data.readUInt32LE(8 + i * 4));
const placements = [];
for (let index = 0; index < terrain.length; index++) {
  const packed = mapChunk.data.readUInt32LE(8 + terrain.length * 4 + index * 4), originalId = packed & 65535;
  if (originalId === 65535) continue;
  if (!names.has(originalId)) throw new Error(`Unnamed original ID ${originalId}`);
  placements.push({ index, originalId, flagsRaw: packed >>> 16 });
}
function classify(name, facts, modelId) {
  const n = name.trim().toLowerCase();
  if (/robot seller/.test(n)) return ["npc", "droid"];
  if (modelId >= 40000 && modelId < 50000 && !facts?.creatureLevel) return ["npc", "humanoid"];
  if (/zartul/.test(n) && !facts?.creatureLevel) return ["npc", "humanoid"];
  if (/aw team|jonny/.test(n)) return ["npc", "humanoid"];
  if (/g_knife/.test(n)) return ["decor", "blade"];
  if (/gkey/.test(n)) return ["decor", "key"];
  if (/mine|fish|wheat|flax|rubber tree|cirbango tree|higrim bush|heap of|heap salt/.test(n)) return ["resource", /mine|heap/.test(n) ? "ore" : /fish/.test(n) ? "fish" : /wheat|flax/.test(n) ? "crop" : "tree"];
  if (facts?.creatureLevel && !facts.miningLevel) return ["monster", /droid|loader/.test(n) ? "droid" : /scorpion|spider/.test(n) ? "arachnid" : /rat/.test(n) ? "rat" : /chicken|pheasant|stropterix/.test(n) ? "bird" : /deer|dog|rotoz|shaldar|lonter|globbit/.test(n) ? "quadruped" : "humanoid"];
  if (/furnace|press|microwave|combine|cutting machine|sewing|spectralizer|sink/.test(n)) return ["station", "machine"];
  if (/boat|ladder|gate|portal|hatch/.test(n)) return ["transition", /boat/.test(n) ? "boat" : /ladder/.test(n) ? "ladder" : "gate"];
  if (/tree/.test(n)) return ["decor", /dry|seif/.test(n) ? "dry-tree" : "tree"];
  if (/bush|flower|cactus|mushroom/.test(n)) return ["decor", /cactus/.test(n) ? "cactus" : /mushroom/.test(n) ? "mushroom" : /flower/.test(n) ? "flower" : "bush"];
  if (/boulder/.test(n)) return ["decor", "rock"];
  if (/wall/.test(n)) return ["decor", "wall"];
  if (/door/.test(n)) return ["decor", "door"];
  if (/crate|safe|bedside/.test(n)) return ["decor", "crate"];
  if (/chair/.test(n)) return ["decor", "chair"];
  if (/table/.test(n)) return ["decor", "table"];
  if (/book shelf/.test(n)) return ["decor", "shelf"];
  if (/bed/.test(n)) return ["decor", "bed"];
  if (/hut/.test(n)) return ["decor", "hut"];
  if (/web|cocoon|egg/.test(n)) return ["decor", /web/.test(n) ? "web" : "cocoon"];
  if (/poster|bank|shop|kitchen|farm/.test(n)) return ["decor", "sign"];
  if (/stump|logs/.test(n)) return ["decor", "log"];
  if (/fire/.test(n)) return ["decor", "fire"];
  if (/drain/.test(n)) return ["decor", "drain"];
  if (/showcase|slot machine/.test(n)) return ["decor", "machine"];
  if (/chicken/.test(n)) return ["monster", "bird"];
  if (/ufo/.test(n)) return ["decor", "ufo"];
  return ["unmapped", "unmapped"];
}
const definitions = [...new Set(placements.map(p => p.originalId))].sort((a,b) => a-b).map(originalId => {
  const named = names.get(originalId), record = objects.data.subarray(originalId * 256, (originalId + 1) * 256);
  const modelId = record.readUInt16LE(144), textureId = record.readUInt16LE(148);
  const [kind, family] = classify(named.name, named.facts, modelId), metadata=originalMetadata.get(originalId);
  const stats=metadata ? {hp:metadata.hp,level:metadata.level,range:metadata.range,wanderRadius:metadata.wanderRadius??metadata.behaviorFlags,secondaryFlagsRaw:metadata.secondaryFlagsRaw,aggressive:!!((metadata.secondaryFlagsRaw&2)&&!(metadata.secondaryFlagsRaw&16)),resistances:metadata.resistances,damage:metadata.damage} : undefined;
  const actionRecords = interactions.filter(r => r.fields[0] === originalId);
  const resource = actionRecords.map(r => items.get(r.fields[1])).find(Boolean);
  const role = /banker/i.test(named.name) ? "bank" : /seller|bookseller|barmen/i.test(named.name) ? "trader" : originalId === 285 ? "bob" : undefined;
  return { ...named, modelId, textureId, kind, family, ...(stats?{stats}:{}), ...(role ? { role } : {}), ...(kind === "resource" && resource ? {resource} : {}), ...(actionRecords.length ? {interactionIds: actionRecords.map(r => r.originalId)} : {}) };
});
const bob = placements.find(p => p.originalId === 285);
if (!bob) throw new Error("Bob landmark missing");
const row = Math.floor(bob.index / 512), col = bob.index % 512;
let spawn;
for (const [dr,dc] of [[0,-2],[0,2],[-2,0],[2,0],[-1,-1],[1,1],[0,-1]]) {
  const r = row + dr, c = col + dc;
  if (!(terrain[r * 512 + c] & 0x04000000)) { spawn = { x: r - 256 + .5, z: c - 256 + .5 }; break; }
}
if (!spawn) throw new Error("No walkable reconstructed spawn beside Bob");
const output = {
  version: 1, source: "http://site.awplanet.com/client/single/build/webdata.data", sha256: createHash("sha256").update(bytes).digest("hex"),
  layout: { width:512,height:512,origin:256,limit:255,unit:1 }, spawn, terrain, definitions, placements,
  provenance: {
    grid:"WASM f146: index=(second&511)+((first&511)<<9)", height:"WASM f379: (terrainWord&15)*0.375", materialId:"WASM f381: (terrainWord>>>8)&255",
    coordinates:"First coordinate maps to centered x; second to centered z. Centering and spawn are remake choices.",
    population:"All nonempty object-plane placements retained. Named family/classification are renderer adapters; no original AI, shops, quests, HP or drop is implied.",
    flags:"Original high16 preserved. Unconfirmed fields have no assigned meaning."
  }
};
await writeFile(resolve(process.argv[3] ?? "data/canonical-map.json"), JSON.stringify(output) + "\n", "utf8");
console.log(JSON.stringify({cells:terrain.length,placements:placements.length,types:definitions.length,spawn,unmapped:definitions.filter(d=>d.kind==='unmapped').map(d=>[d.originalId,d.name]),kinds:definitions.reduce((a,d)=>(a[d.kind]=(a[d.kind]??0)+placements.filter(p=>p.originalId===d.originalId).length,a),{})},null,2));
