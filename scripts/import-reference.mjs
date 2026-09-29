/** Read public AWPlanet data as bytes. Never executes or copies original artwork. */
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { resolve, dirname } from 'node:path';

const source = process.argv[2];
if (!source) throw new Error('Usage: node scripts/import-reference.mjs <local webdata.data | public HTTP URL> [output directory]');
const out = resolve(process.argv[3] ?? 'data/reference');
const bytes = /^https?:\/\//.test(source)
  ? Buffer.from(await (async () => { const r = await fetch(source); if (!r.ok) throw new Error(`HTTP ${r.status}`); return r.arrayBuffer(); })())
  : await readFile(source);
if (bytes.toString('ascii', 0, 4) !== 'AWP\0') throw new Error('Unsupported archive magic');
const version = bytes.readUInt32LE(4), count = bytes.readUInt32LE(8), dataStart = bytes.readUInt32LE(12);
if (version !== 1 || count > 5000 || dataStart !== 16 + count * 16) throw new Error('Unsupported archive directory');
const chunks = Array.from({length:count}, (_, index) => {
  const p = 16 + index * 16;
  const type = bytes.readUInt32LE(p), offset = bytes.readUInt32LE(p + 4), size = bytes.readUInt32LE(p + 8), unpackedSize = bytes.readUInt32LE(p + 12);
  if (offset < dataStart || offset + size > bytes.length || size !== unpackedSize) throw new Error(`Invalid/compressed chunk ${index}`);
  return {index, type, offset, size, data:bytes.subarray(offset,offset+size)};
});
const cp1251 = new TextDecoder('windows-1251');
const cString = b => cp1251.decode(b.subarray(0,b.indexOf(0)<0?b.length:b.indexOf(0)));
const objectChunk = chunks.find(c => c.type === 4 && c.size === 256000 && cString(c.data.subarray(0,16)) === 'Credits');
if (!objectChunk) throw new Error('Original object directory not found');
const objects=[];
for(let originalId=0;originalId<objectChunk.size/256;originalId++) {
  const r=objectChunk.data.subarray(originalId*256,(originalId+1)*256);
  const name=cString(r.subarray(0,16));
  if(!name) continue;
  const description=cString(r.subarray(16,144));
  // Retain names and numeric facts, not the original descriptive prose.
  const facts={};
  for(const [key,re] of [
    ['combatLevel',/requires\s+(\d+)\s+combat level/i],
    ['intelligence',/requires\s+(\d+)\s+Intelligence/i],
    ['cuttingDamage',/cutting\s+damage\s+(\d+)/i],
    ['miningLevel',/at least\s+level\s+(\d+)/i],
    ['creatureLevel',/\blevel\s+(\d+)/i],
    ['bookExperience',/rise on\s+(\d+)\s+Exp/i]
  ]) {const match=description.match(re);if(match)facts[key]=Number(match[1]);}
  const combat=description.match(/and\s+(\d+)\s+(fencing|heavy weapons|piercing)\s+level/i);
  if(combat) facts.weaponSkill={name:combat[2].toLowerCase(),level:Number(combat[1])};
  objects.push({originalId,name,...(Object.keys(facts).length?{facts}:{})});
}
const actionChunk=chunks.find(c=>c.type===4&&c.size===19200);
const interactions=actionChunk?Array.from({length:600},(_,originalId)=>({originalId,fields:Array.from({length:16},(_,j)=>actionChunk.data.readUInt16LE(originalId*32+j*2))})):[];
// Only first three u16 have corroborated object-ID relationships. Remaining fields
// are kept uninterpreted, not promoted to ingredient quantities or formulas.
const objectIds=new Set(objects.map(x=>x.originalId));
for(const action of interactions) for(const id of action.fields.slice(0,3)) {
  if(id!==65535&&!objectIds.has(id)) throw new Error(`Action ${action.originalId} references unnamed object ${id}`);
}
const textTriples = chunk => {
  const lines=cp1251.decode(chunk.data).split(/\r?\n/).filter(x=>x.length);
  if(lines.length%3)throw new Error(`Invalid localization table ${chunk.index}`);
  const rows=[];
  for(let i=0;i<lines.length;i+=3){if(!/^\d+$/.test(lines[i]))throw new Error('Invalid numeric localization ID');rows.push({originalId:Number(lines[i]),en:lines[i+1],ru:lines[i+2]});}
  return rows;
};
const skillChunk=chunks.find(c=>c.type===4&&c.size===2575);
const skills=skillChunk?textTriples(skillChunk).filter(x=>x.originalId<=60&&x.en!=='r'):[];
const map=chunks.find(c=>c.type===5&&c.data.toString('ascii',0,4)==='MAP\0');
const objectKinds={};for(const r of objects){const name=r.name.replace(/^~/,'');objectKinds[name]=(objectKinds[name]??0)+1;}
const report={
  sourceUrl:'http://site.awplanet.com/client/single/build/webdata.data',
  retrievedAt:'2026-09-30',sha256:createHash('sha256').update(bytes).digest('hex'),bytes:bytes.length,
  archiveVersion:version,chunks:count,objectsSlots:objectChunk.size/256,namedObjects:objects.length,
  uniqueObjectNames:Object.keys(objectKinds).length,interactionSlots:interactions.length,
  activeInteractionTargets:interactions.filter(x=>x.fields[0]!==65535).length,
  map:map?{magic:'MAP',bytes:map.size,payloadBytes:map.size-8,coordinateSchema:'unknown',copied:false}:null,
  notes:[
    'Named objects include NPCs, scenery, creatures, certificates, tools and items. This is not a count of playable items.',
    'Interaction table contains 600 slots; empty slots and runtime-dependent actions exist. Ingredient quantities and field schema are unverified.',
    'The public data predates the current remake. It is a reference snapshot, not proof of complete Classic server state.',
    'Original images, geometry, fonts, full descriptive strings, dialogues and executable code were not imported.'
  ]
};
await mkdir(out,{recursive:true});
for(const [name,value]of Object.entries({'catalog.json':objects,'interactions.json':interactions,'skills.json':skills,'inspection.json':report}))
  await writeFile(resolve(out,name),JSON.stringify(value,null,2)+'\n','utf8');
console.log(JSON.stringify(report,null,2));
