import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import type { CanonicalMapData } from "../shared/canonical-map";
import { mapIndex, mapPoint, terrainCombatClear, terrainHeight, terrainSegmentClear, terrainWalkable } from "../shared/canonical-map";
import { NavigationGrid } from "./navigation";
const empty = () => ({ terrain: new Array<number>(512 * 512).fill(0) });
test("canonical coordinates preserve original row-first indexing and Bob landmark", () => {
  assert.deepEqual(mapPoint(58407), { x:-142,z:-217 });
  assert.equal(mapIndex(-142,-217),58407);
  assert.equal(mapIndex(-257,0),-1);
});
test("terrain height follows renderer triangles without flattening slopes", () => {
  const m=empty(), i=mapIndex(-5,-5);
  m.terrain[i]=0; m.terrain[i+512]=4; m.terrain[i+1]=8; m.terrain[i+513]=12;
  assert.equal(terrainHeight(m,-4.75,-4.75),1.125);
  assert.equal(terrainHeight(m,-4.25,-4.25),3.375);
});
test("solid cells, wall edges and storage seam reject movement in either direction", () => {
  const m=empty(), a={x:-4.5,z:-4.5}, b={x:-3.5,z:-4.5};
  m.terrain[mapIndex(b.x,b.z)] = 0x00100000;
  assert.equal(terrainWalkable(m,b.x,b.z),true);
  assert.equal(terrainSegmentClear(m,a,b),false);
  assert.equal(terrainSegmentClear(m,b,a),false);
  m.terrain[mapIndex(b.x,b.z)] = 0x04000000;
  assert.equal(terrainWalkable(m,b.x,b.z),false);
  assert.equal(terrainSegmentClear(m,{x:-.5,z:10},{x:.5,z:10}),false);
});
test("combat can reach a monster on a solid cell without making the cell walkable", () => {
  const m=empty(), a={x:-4.5,z:-4.5}, mob={x:-3.5,z:-4.5};
  m.terrain[mapIndex(mob.x,mob.z)]=0x04000000;
  assert.equal(terrainSegmentClear(m,a,mob),false);
  assert.equal(terrainWalkable(m,mob.x,mob.z),false);
  assert.equal(terrainCombatClear(m,a,mob,1),true);
  assert.equal(terrainCombatClear(m,mob,a,1),true);
  m.terrain[mapIndex(a.x,a.z)]=0x04000000;
  assert.equal(terrainCombatClear(m,a,mob,1),true);
});
test("combat rejects closed row and column walls in both cardinal directions", () => {
  const m=empty(), a={x:-4.5,z:-4.5}, row={x:-3.5,z:-4.5}, col={x:-4.5,z:-3.5};
  m.terrain[mapIndex(row.x,row.z)]=0x00100000;
  m.terrain[mapIndex(col.x,col.z)]=0x00200000;
  for(const target of [row,col]) {
    assert.equal(terrainCombatClear(m,a,target,1),false);
    assert.equal(terrainCombatClear(m,target,a,1),false);
  }
});
test("the source combat wall override requires both high bits on the checked tile", () => {
  const m=empty(), a={x:-4.5,z:-4.5}, b={x:-3.5,z:-4.5}, i=mapIndex(b.x,b.z);
  for(const word of [0x00100000,0x40100000,0x80100000]) {
    m.terrain[i]=word;
    assert.equal(terrainCombatClear(m,a,b,1),false);
  }
  m.terrain[i]=0xc4100000;
  assert.equal(terrainWalkable(m,b.x,b.z),false);
  assert.equal(terrainCombatClear(m,a,b,1),true);
  assert.equal(terrainCombatClear(m,b,a,1),true);
});
test("source melee accepts an adjacent diagonal and ranged combat checks intervening walls", () => {
  const m=empty(), a={x:-6.5,z:-6.5}, diagonal={x:-5.5,z:-5.5}, distant={x:-3.5,z:-6.5};
  assert.equal(terrainCombatClear(m,a,diagonal,1),true);
  assert.equal(terrainCombatClear(m,a,distant,2),false);
  assert.equal(terrainCombatClear(m,a,distant,3),true);
  m.terrain[mapIndex(-4.5,-6.5)]=0x04100000;
  assert.equal(terrainCombatClear(m,a,distant,3),false);
  m.terrain[mapIndex(-4.5,-6.5)]=0x04000000;
  assert.equal(terrainCombatClear(m,a,distant,3),true);
});
test("source diagonal combat uses the dominant-axis edge pair rather than both routes", () => {
  const m=empty(), a={x:-6.5,z:-6.5}, equal={x:-5.5,z:-5.5}, colMajor={x:-5.5,z:-4.5};
  // Equal distances choose row-first: this col-first alternative is not crossed.
  m.terrain[mapIndex(-6.5,-5.5)]=0x00200000;
  assert.equal(terrainCombatClear(m,a,equal,1),true);
  // Reversing the ray selects its row-first pair from the other endpoint.
  assert.equal(terrainCombatClear(m,equal,a,1),false);
  m.terrain[mapIndex(-5.5,-6.5)]=0x00100000;
  assert.equal(terrainCombatClear(m,a,equal,1),false);
  m.terrain.fill(0);
  // Column-major's final diagonal crosses column first, then this row edge.
  m.terrain[mapIndex(-5.5,-4.5)]=0x00100000;
  assert.equal(terrainCombatClear(m,a,colMajor,2),false);
  m.terrain.fill(0);
  m.terrain[mapIndex(-5.5,-5.5)]=0x00100000;
  assert.equal(terrainCombatClear(m,a,colMajor,2),true);
});
test("combat keeps coordinate adapter bounds and area separation", () => {
  const m=empty();
  assert.equal(terrainCombatClear(m,{x:NaN,z:0},{x:0,z:0}),false);
  assert.equal(terrainCombatClear(m,{x:-256,z:0},{x:-255,z:0}),false);
  assert.equal(terrainCombatClear(m,{x:-.5,z:10},{x:.5,z:10}),false);
});
test("navigation uses the same terrain rules and detours around an occupied cell", () => {
  const m=empty(); m.terrain[mapIndex(-4,0)]=0x04000000;
  const rules={walkable:(p:{x:number;z:number})=>terrainWalkable(m,p.x,p.z),segmentClear:(a:{x:number;z:number},b:{x:number;z:number})=>terrainSegmentClear(m,a,b)};
  const grid=new NavigationGrid([],12,1,0,rules), start={x:-7,z:0}, end={x:-1,z:0};
  const route=grid.findRoute(start,end);
  assert.ok(route.length>1); assert.deepEqual(route.at(-1),end);
  let previous=start; for(const next of route){ assert.equal(rules.segmentClear(previous,next),true); previous=next; }
});
test("the real canonical grid retains every placement and routes from Bob to an original bank", () => {
  const map:CanonicalMapData=JSON.parse(readFileSync(new URL("../../data/canonical-map.json",import.meta.url),"utf8"));
  assert.equal(map.terrain.length,512*512);assert.equal(map.placements.length,13085);assert.equal(map.definitions.length,214);
  const definitions=new Map(map.definitions.map(d=>[d.originalId,d]));
  for(const placement of map.placements){assert.ok(definitions.has(placement.originalId));const p=mapPoint(placement.index);assert.equal(mapIndex(p.x,p.z),placement.index);}
  assert.equal(definitions.get(70)?.kind,"npc","Fisherman must remain a human NPC");
  assert.equal(definitions.get(529)?.kind,"npc","special Zartul without combat HP must remain an NPC");
  const loader=map.placements.find(p=>p.index===53350)!;
  assert.equal(loader.originalId,374);
  assert.equal(definitions.get(loader.originalId)?.kind,"monster");
  const mob=mapPoint(loader.index);mob.x+=.5;mob.z+=.5;
  const attacker={x:mob.x-1,z:mob.z};
  assert.equal(terrainWalkable(map,attacker.x,attacker.z),true);
  assert.equal(terrainWalkable(map,mob.x,mob.z),false);
  assert.equal(terrainSegmentClear(map,attacker,mob),false);
  assert.equal(terrainCombatClear(map,attacker,mob,1),true,"original solid-cell Loader must remain attackable through the source wall override");
  const bank=map.placements.find(p=>p.index===64614)!;assert.equal(definitions.get(bank.originalId)?.role,"bank");
  const target=mapPoint(bank.index);target.x+=.5;target.z+=.5;
  const rules={walkable:(p:{x:number;z:number})=>terrainWalkable(map,p.x,p.z),segmentClear:(a:{x:number;z:number},b:{x:number;z:number})=>terrainSegmentClear(map,a,b)};
  const route=new NavigationGrid([],255,1,0,rules).findRoute(map.spawn,target);
  assert.ok(route.length>0,"cell-centred navigation must not isolate the source map");
  assert.ok(Math.hypot(route.at(-1)!.x-target.x,route.at(-1)!.z-target.z)<3.4);
  let previous=map.spawn;for(const next of route){assert.ok(rules.segmentClear(previous,next));previous=next;}
});
