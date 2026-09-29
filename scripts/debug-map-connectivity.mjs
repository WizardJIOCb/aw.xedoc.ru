/** Read-only connectivity diagnostics. Door experiment never changes canonical data. */
import { readFile, mkdir, writeFile } from "node:fs/promises";
import { tsImport } from "tsx/esm/api";
const { mapPoint, mapIndex,terrainSegmentClear,terrainWalkable }=await tsImport("../src/shared/canonical-map.ts",import.meta.url);
const map=JSON.parse(await readFile(new URL("../data/canonical-map.json",import.meta.url),"utf8"));
const defs=new Map(map.definitions.map(d=>[d.originalId,d]));
function flood(data){
  const visited=new Uint8Array(512*512),queue=new Int32Array(512*512),start=mapIndex(data.spawn.x,data.spawn.z);
  let head=0,tail=1;queue[0]=start;visited[start]=1;
  while(head<tail){const index=queue[head++],a=mapPoint(index);a.x+=.5;a.z+=.5;
    for(const [dr,dc]of [[-1,0],[0,-1],[0,1],[1,0]]){const b={x:a.x+dr,z:a.z+dc},next=mapIndex(b.x,b.z);if(next<0||visited[next]||!terrainSegmentClear(data,a,b))continue;visited[next]=1;queue[tail++]=next;}
  }
  const reached=map.placements.filter(p=>visited[p.index]&&["npc","monster","station"].includes(defs.get(p.originalId).kind)).map(p=>({...p,...mapPoint(p.index),name:defs.get(p.originalId).name,role:defs.get(p.originalId).role,kind:defs.get(p.originalId).kind}));
  return {cells:tail,visited,reached};
}
const exact=flood(map),experiment={...map,terrain:[...map.terrain]};
const doors=map.placements.filter(p=>defs.get(p.originalId).family==="door");
for(const door of doors)experiment.terrain[door.index]&=~0x00300000;
const withDoorEdgesRemoved=flood(experiment);
const report={spawn:map.spawn,sourceRules:{cells:exact.cells,reached:exact.reached},experiment:{description:"Only remove wall-edge bits at cells containing named original Door objects; no production mutation.",doorPlacements:doors.length,cells:withDoorEdgesRemoved.cells,reached:withDoorEdgesRemoved.reached}};
await mkdir(new URL("../artifacts/map-debug/",import.meta.url),{recursive:true});
await writeFile(new URL("../artifacts/map-debug/connectivity.json",import.meta.url),JSON.stringify(report,null,2));
// PPM is a lossless standard raster; each pixel is one original cell. Green reachable,
// grey other walkable, blue solid. Rows map to new x, columns to new z.
const pixels=Buffer.alloc(512*512*3);
for(let i=0;i<512*512;i++){const p=mapPoint(i),c=exact.visited[i]?[66,175,95]:withDoorEdgesRemoved.visited[i]?[188,155,56]:terrainWalkable(map,p.x+.5,p.z+.5)?[95,104,112]:[30,50,66];pixels.set(c,i*3);}
const ppm=Buffer.concat([Buffer.from("P6\n512 512\n255\n"),pixels]);await writeFile(new URL("../artifacts/map-debug/connectivity.ppm",import.meta.url),ppm);
const nearest=rows=>rows.sort((a,b)=>Math.hypot(a.x-map.spawn.x,a.z-map.spawn.z)-Math.hypot(b.x-map.spawn.x,b.z-map.spawn.z));
console.log(JSON.stringify({exactCells:exact.cells,doorExperimentCells:withDoorEdgesRemoved.cells,npcCount:exact.reached.filter(p=>p.kind==="npc").length,monsterCount:exact.reached.filter(p=>p.kind==="monster").length,nearestServices:nearest(exact.reached.filter(p=>p.role==="bank"||p.role==="trader")).slice(0,4),nearestMonsters:nearest(exact.reached.filter(p=>p.kind==="monster")).slice(0,4)},null,2));
