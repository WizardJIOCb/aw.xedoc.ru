/** Static data inspection only. No client code or original artwork is loaded. */
import { readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { resolve } from 'node:path';

const input=process.argv[2];
if(!input)throw new Error('Usage: node scripts/inspect-map.mjs <local webdata.data> [--export]');
const bytes=await readFile(input);
if(bytes.toString('ascii',0,4)!=='AWP\0')throw new Error('AWP magic missing');
const count=bytes.readUInt32LE(8);
if(bytes.readUInt32LE(12)!==16+16*count)throw new Error('Invalid archive directory');
const chunks=Array.from({length:count},(_,i)=>{
  const p=16+i*16,type=bytes.readUInt32LE(p),offset=bytes.readUInt32LE(p+4),size=bytes.readUInt32LE(p+8);
  if(offset+size>bytes.length)throw new Error('Invalid chunk bounds');
  return {index:i,type,offset,size,data:bytes.subarray(offset,offset+size)};
});
const map=chunks.find(c=>c.type===5&&c.data.toString('ascii',0,4)==='MAP\0');
if(!map||map.size!==2097160)throw new Error('Known MAP layout not found');
const catalog=JSON.parse(await readFile(resolve('data/reference/catalog.json'),'utf8'));
const names=new Map(catalog.map(r=>[r.originalId,r.name]));
const cells=(map.size-8)/8,planeA=[],planeB=[];
for(let i=0;i<cells;i++){
  planeA.push(map.data.readUInt32LE(8+i*4));
  planeB.push(map.data.readUInt32LE(8+cells*4+i*4));
}
const placements=[];
for(let index=0;index<cells;index++){
  const raw=planeB[index],originalObjectId=raw&65535;
  if(originalObjectId===65535)continue;
  if(!names.has(originalObjectId))throw new Error(`Unknown object ${originalObjectId} at ${index}`);
  placements.push({index,originalObjectId,flagsRaw:raw>>>16});
}
const candidates=[64,128,256,512,1024,2048].map(width=>{
  let matches=0,adjacentObjects=0;
  for(let i=0;i<cells-width;i++){
    if((planeA[i]&255)===(planeA[i+width]&255))matches++;
    if((planeB[i]&65535)!==65535&&(planeB[i+width]&65535)!==65535)adjacentObjects++;
  }
  return {width,height:cells/width,terrainLowByteAgreement:matches/(cells-width),adjacentOccupiedCells:adjacentObjects};
}).sort((a,b)=>b.terrainLowByteAgreement-a.terrainLowByteAgreement);
const frequencies=new Map();for(const p of placements)frequencies.set(p.originalObjectId,(frequencies.get(p.originalObjectId)??0)+1);
const sampleIds=[285,10,440,318,11,631,835,834,430,439,171,172,248,249];
const samples=sampleIds.map(originalObjectId=>({originalObjectId,name:names.get(originalObjectId),indices:placements.filter(x=>x.originalObjectId===originalObjectId).map(x=>x.index)}));
const interactionsChunk=chunks.find(c=>c.type===4&&c.size===19200);
const interactionExamples=[45,61,98,176,177,315,331,332,391].map(index=>{
  const fields=Array.from({length:16},(_,j)=>interactionsChunk.data.readUInt16LE(index*32+j*2));
  return {index,fields,target:{id:fields[0],name:names.get(fields[0])},success:{id:fields[1],name:names.get(fields[1])},failure:fields[2]===65535?null:{id:fields[2],name:names.get(fields[2])},extraObjectCandidates:fields.slice(4,6).filter(x=>x!==65535).map(id=>({id,name:names.get(id)})),quantityBytesCandidate:[fields[6]&255,fields[6]>>>8]};
});
const summary={
  sha256:createHash('sha256').update(bytes).digest('hex'),mapChunk:map.index,headerHex:map.data.subarray(0,8).toString('hex'),
  cellsPerPlane:cells,planes:2,bytesPerCellPerPlane:4,occupiedObjectCells:placements.length,
  distinctPlacedObjectIds:frequencies.size,allObjectIdsResolve:true,
  widthCandidates:candidates,
  samples,interactionExamples,
  status:'provisional schema: storage fields verified; width inferred by spatial correlation; game coordinate transform and flags undecoded'
};
if(process.argv.includes('--export')){
  const exported={
    source:'http://site.awplanet.com/client/single/build/webdata.data',sha256:summary.sha256,
    status:summary.status,
    layout:{headerBytes:8,planes:2,wordBits:32,cellsPerPlane:cells,widthCandidate:512,heightCandidate:512,widthEvidence:'low-byte spatial correlation maximum at stride512; no explicit dimensions in header'},
    fields:{planeA:'packed terrain/geometry candidate, raw u32; schema unknown',planeB:'low16: originalObjectId or65535empty; high16:flagsRaw, semantics unknown'},
    coordinateTransform:'Unverified. index%512 and floor(index/512) are candidate storage coordinates, not verified world positions or separate surface/underground coordinates.',
    planeARaw:planeA,placements
  };
  await writeFile(resolve('data/reference/map-layout.json'),JSON.stringify(exported)+'\n','utf8');
}
console.log(JSON.stringify(summary,null,2));
