import * as THREE from "three";
import { mergeGeometries } from "three/addons/utils/BufferGeometryUtils.js";
import { mapPoint, terrainHeight, type CanonicalMapData, type MapDefinition } from "../shared/canonical-map";

/** Full source grid and placements, rendered with newly authored family models.
 * Materials and architectural heights are reconstruction; original art is not loaded.
 */
export class CanonicalWorld {
  readonly root = new THREE.Group();
  readonly grounds: THREE.Mesh[] = [];
  private readonly definitions: Map<number, MapDefinition>;
  private visibilityBounds = new Map<THREE.Object3D,THREE.Box3>();
  constructor(readonly map: CanonicalMapData) {
    this.root.name = "canonical-map";
    this.definitions = new Map(map.definitions.map(d => [d.originalId,d]));
    this.buildTerrain();
    this.buildWalls();
    this.buildDecor();
    this.root.userData.sourcePlacements = map.placements.length;
    this.root.userData.sourceTypes = map.definitions.length;
    this.cacheVisibilityBounds();
  }
  private buildTerrain() {
    const material = new THREE.MeshStandardMaterial({ vertexColors:true,roughness:.96,metalness:0 });
    // Colours map original tile groups to independently authored surface colours.
    // This does not claim exact original texture names or pixel correspondence.
    const palette = [0xbaa477,0x9c8c61,0x728b4d,0x718451,0x3e5950,0x898479,0x6b716d,0x597875];
    const colours = palette.map(c => new THREE.Color(c));
    for (let row=0;row<511;row+=32) for (let col=0;col<511;col+=32) {
      const rows=Math.min(32,511-row), cols=Math.min(32,511-col), positions:number[]=[], colour:number[]=[], indices:number[]=[];
      for(let r=0;r<=rows;r++) for(let c=0;c<=cols;c++) {
        const index=(row+r)*512+col+c, word=this.map.terrain[index], h=(word&15)*.375;
        positions.push(row+r-256,h,col+c-256);
        const tile=(word>>>8)&255;
        const base=tile>=128 ? new THREE.Color((tile&15)>=8?0x92978d:0xaa937a) : colours[(tile>>>4)&7];
        const variance=.94+((index*1664525>>>0)%100)/800;
        colour.push(base.r*variance,base.g*variance,base.b*variance);
      }
      const stride=cols+1;
      for(let r=0;r<rows;r++) for(let c=0;c<cols;c++) {
        const i=r*stride+c;
        indices.push(i,i+1,i+stride, i+1,i+stride+1,i+stride);
      }
      const geometry=new THREE.BufferGeometry();
      geometry.setAttribute("position",new THREE.Float32BufferAttribute(positions,3));
      geometry.setAttribute("color",new THREE.Float32BufferAttribute(colour,3));
      geometry.setIndex(indices); geometry.computeVertexNormals(); geometry.computeBoundingBox(); geometry.computeBoundingSphere();
      const ground=new THREE.Mesh(geometry,material); ground.receiveShadow=true; ground.userData.canonicalGround=true;
      this.root.add(ground);this.grounds.push(ground);
    }
    const water=new THREE.Mesh(new THREE.PlaneGeometry(256,512),new THREE.MeshPhysicalMaterial({color:0x456f7b,metalness:.15,roughness:.22,transparent:true,opacity:.88}));
    water.rotation.x=-Math.PI/2;water.position.set(-128,.72,-.5);water.receiveShadow=true;water.userData.reconstruction="surface-half water-level .72";
    this.root.add(water);
  }
  private buildWalls() {
    const buckets=new Map<string,THREE.Matrix4[]>();
    const dummy=new THREE.Object3D();
    for(let row=1;row<511;row++)for(let col=1;col<511;col++){
      const word=this.map.terrain[row*512+col];
      for(const [flag,axis]of [[0x00100000,0],[0x00200000,1]])if(word&flag){
        const key=`${Math.floor(row/32)}:${Math.floor(col/32)}`;
        let bucket=buckets.get(key);if(!bucket)buckets.set(key,bucket=[]);
        const x=row-256+(axis? .5:0),z=col-256+(axis?0:.5);
        dummy.position.set(x,terrainHeight(this.map,x+.01,z+.01)+1.05,z);
        dummy.rotation.set(0,axis?Math.PI/2:0,0);dummy.scale.set(1,1,1);dummy.updateMatrix();bucket.push(dummy.matrix.clone());
      }
    }
    const geometry=new THREE.BoxGeometry(.12,2.1,1),material=new THREE.MeshStandardMaterial({color:0xc7c7b3,roughness:.85,metalness:.12});
    for(const [key,matrices]of buckets){const mesh=new THREE.InstancedMesh(geometry,material,matrices.length);matrices.forEach((m,i)=>mesh.setMatrixAt(i,m));mesh.name=`source-wall-edges-${key}`;mesh.castShadow=true;mesh.receiveShadow=true;mesh.computeBoundingBox();mesh.computeBoundingSphere();this.root.add(mesh);}
  }
  installTreeModel(source:THREE.Group){
    for(const child of [...this.root.children])if(child.userData.family==="tree"){this.root.remove(child);if(child instanceof THREE.Mesh)child.geometry.dispose();}
    this.buildDecor(source);
    this.cacheVisibilityBounds();
  }
  private cacheVisibilityBounds(){this.visibilityBounds.clear();for(const child of this.root.children){if(child instanceof THREE.InstancedMesh&&child.boundingBox)this.visibilityBounds.set(child,child.boundingBox);else if(child instanceof THREE.Mesh){child.geometry.computeBoundingBox();const b=child.geometry.boundingBox!.clone();child.updateMatrix();b.applyMatrix4(child.matrix);this.visibilityBounds.set(child,b);}}}
  updateVisibility(x:number,z:number,radius=54){
    for(const [child,b]of this.visibilityBounds){const dx=Math.max(b.min.x-x,0,x-b.max.x),dz=Math.max(b.min.z-z,0,z-b.max.z);child.visible=dx*dx+dz*dz<=radius*radius;}
  }
  private buildDecor(treeSource?:THREE.Group) {
    const buckets=new Map<string,{definition:MapDefinition;matrices:THREE.Matrix4[]}>();
    const dummy=new THREE.Object3D();
    for(const placement of this.map.placements){
      const definition=this.definitions.get(placement.originalId)!;
      if(definition.kind!=="decor")continue;
      if(treeSource&&definition.family!=="tree")continue;
      const p=mapPoint(placement.index), row=Math.floor(placement.index/512),col=placement.index%512;
      const key=`${definition.originalId}:${Math.floor(row/32)}:${Math.floor(col/32)}`;
      let bucket=buckets.get(key);if(!bucket)buckets.set(key,bucket={definition,matrices:[]});
      dummy.position.set(p.x+.5,terrainHeight(this.map,p.x+.5,p.z+.5),p.z+.5);
      // Original rotation flags remain uninterpreted. Decorative rotation belongs to the new art.
      dummy.rotation.set(0,/tree|bush|rock|flower/.test(definition.family)?((placement.index*1103515245>>>0)%628)/100:0,0);
      dummy.scale.set(1,1,1);dummy.updateMatrix();bucket.matrices.push(dummy.matrix.clone());
    }
    const models=new Map<number,THREE.Group>();
    const modelParts=new Map<number,{material:THREE.Material;geometry:THREE.BufferGeometry}[]>();
    for(const [key,bucket]of buckets){
      let model=models.get(bucket.definition.originalId);if(!model){
        if(treeSource){model=treeSource.clone(true);const bounds=new THREE.Box3().setFromObject(model),scale=(2.5+(bucket.definition.originalId%5)*.17)/Math.max(.1,bounds.getSize(new THREE.Vector3()).y);model.scale.setScalar(scale);model.position.y=-bounds.min.y*scale;}else model=familyModel(bucket.definition);
        models.set(bucket.definition.originalId,model);
      }
      let shared=modelParts.get(bucket.definition.originalId);
      if(!shared){
        model.updateMatrixWorld(true);
        const byMaterial=new Map<THREE.Material,THREE.BufferGeometry[]>();
        model.traverse(o=>{if(o instanceof THREE.Mesh && !Array.isArray(o.material)){let geometry=o.geometry.clone().applyMatrix4(o.matrixWorld);if(geometry.index){const expanded=geometry.toNonIndexed();geometry.dispose();geometry=expanded;}let list=byMaterial.get(o.material);if(!list)byMaterial.set(o.material,list=[]);list.push(geometry);}});
        shared=[];for(const [material,parts]of byMaterial){const geometry=mergeGeometries(parts,false);parts.forEach(g=>g.dispose());if(geometry)shared.push({material,geometry});}
        modelParts.set(bucket.definition.originalId,shared);
      }
      for(const {material,geometry}of shared){const mesh=new THREE.InstancedMesh(geometry,material,bucket.matrices.length);bucket.matrices.forEach((m,i)=>mesh.setMatrixAt(i,m));mesh.name=`source-decor-${key}`;mesh.userData.family=bucket.definition.family;mesh.castShadow=true;mesh.receiveShadow=true;mesh.computeBoundingBox();mesh.computeBoundingSphere();this.root.add(mesh);}
    }
  }
  groundHit(ray:THREE.Raycaster):THREE.Intersection|undefined {
    const candidates=this.grounds.filter(mesh=>ray.ray.intersectsBox(mesh.geometry.boundingBox!));
    return ray.intersectObjects(candidates,false)[0];
  }
}

export function familyModel(def:MapDefinition):THREE.Group {
  const root=new THREE.Group(),family=def.family;
  const stone=new THREE.MeshStandardMaterial({color:0x777c6c,roughness:.95});
  const wood=new THREE.MeshStandardMaterial({color:0x76664e,roughness:.9});
  const leaf=new THREE.MeshStandardMaterial({color:new THREE.Color().setHSL(.25+(def.originalId%7)*.008,.28,.28+(def.originalId%5)*.017),roughness:.94});
  const metal=new THREE.MeshStandardMaterial({color:0x778c89,metalness:.48,roughness:.55});
  const cloth=new THREE.MeshStandardMaterial({color:0x6b8873,roughness:.95});
  const light=new THREE.MeshStandardMaterial({color:0xe5b063,emissive:0xa54313,emissiveIntensity:1.8,roughness:.55});
  const add=(geometry:THREE.BufferGeometry,material:THREE.Material,x=0,y=0,z=0)=>{const mesh=new THREE.Mesh(geometry,material);mesh.position.set(x,y,z);mesh.castShadow=true;mesh.receiveShadow=true;root.add(mesh);return mesh;};
  const box=(w:number,h:number,d:number,mat:THREE.Material,x=0,y=0,z=0)=>add(new THREE.BoxGeometry(w,h,d),mat,x,y,z);
  const cylinder=(r:number,h:number,mat:THREE.Material,x=0,y=0,z=0)=>add(new THREE.CylinderGeometry(r*.85,r,h,8),mat,x,y,z);
  const sphere=(r:number,mat:THREE.Material,x=0,y=0,z=0)=>add(new THREE.IcosahedronGeometry(r,1),mat,x,y,z);
  if(family==="tree"||family==="dry-tree"){
    const height=2.3+(def.originalId%5)*.22;cylinder(.13,height,wood,0,height/2);
    for(let i=0;i<3;i++){const angle=i*2.1+(def.originalId%5);const branch=cylinder(.05,.9,wood,Math.sin(angle)*.3,height*.65,Math.cos(angle)*.3);branch.rotation.z=Math.sin(angle)*.7;branch.rotation.x=Math.cos(angle)*.7;if(family==="tree"){const crown=sphere(.8,leaf,Math.sin(angle)*.45,height*.85+i*.14,Math.cos(angle)*.45);crown.scale.set(1,.78,1);}}
  }else if(family==="bush"||family==="flower"||family==="crop"){
    for(let i=0;i<5;i++){const x=Math.sin(i*2.4)*.25,z=Math.cos(i*2.4)*.25;cylinder(.022,.45,wood,x,.22,z);if(family==="flower")sphere(.11,light,x,.47,z);else sphere(family==="crop"?.1:.22,leaf,x,.4,z);}
  }else if(family==="rock"||family==="ore"){
    for(let i=0;i<3;i++){const rock=sphere(.35+i*.08,stone,Math.sin(i*3)*.2,.25,Math.cos(i*3)*.15);rock.scale.set(1,.8,1);}
  }else if(family==="fish"){
    const ripple=new THREE.MeshBasicMaterial({color:0xb6d5cd,transparent:true,opacity:.6,depthWrite:false});
    for(let n=0;n<2;n++){const ring=add(new THREE.TorusGeometry(.22+n*.17,.013,5,20),ripple,0,.78+n*.003);ring.rotation.x=Math.PI/2;}
    const fish=sphere(.13,metal,0,.66);fish.scale.set(.6,.5,1.8);const fin=add(new THREE.ConeGeometry(.09,.16,4),metal,0,.66,-.23);fin.rotation.x=Math.PI/2;
  }else if(family==="cactus"){
    cylinder(.16,1.5,leaf,0,.75);for(const s of [-1,1]){const arm=cylinder(.09,.55,leaf,s*.23,.75);arm.rotation.z=s*.85;cylinder(.08,.48,leaf,s*.4,1);}
  }else if(family==="mushroom"){
    cylinder(.08,.35,wood,0,.18);const cap=add(new THREE.SphereGeometry(.27,10,6,0,Math.PI*2,0,Math.PI/2),stone,0,.36);cap.scale.y=.5;
  }else if(family==="wall"||family==="door"||family==="gate"){
    for(const s of [-1,1])box(.12,2.05,.13,metal,s*.46,1);box(1.05,.15,.18,metal,0,2.03);if(family!=="gate"){box(.81,1.94,.075,family==="door"?wood:stone,0,.97);if(family==="door"){box(.05,.25,.07,metal,.3,1.05,.08);for(let n=0;n<3;n++)box(.035,1.85,.08,metal,-.25+n*.25,.98);}}
  }else if(family==="crate"||family==="shelf"){
    const h=family==="shelf"?1.7:.72,w=family==="shelf"?.9:.74;
    for(const s of [-1,1])box(.07,h,.65,wood,s*w/2,h/2);for(let i=0;i<4;i++)box(w,.075,.64,wood,0,i*(h-.07)/3+.035);box(w,h,.04,wood,0,h/2,-.32);
    if(family==="shelf")for(let i=0;i<6;i++)box(.08,.22,.23,i%2?cloth:stone,-.3+i*.12,1.28,.1);else{for(const z of [-.32,.32])for(let i=0;i<5;i++)box(w,.08,.04,wood,0,.09+i*.13,z);box(w+.03,.06,.7,wood,0,h+.035);}
  }else if(family==="table"||family==="chair"||family==="bed"){
    const w=family==="bed"?.8:family==="table"?.9:.4,d=family==="bed"?1.7:family==="table"?.8:.4,h=family==="chair"?.46:.7;
    box(w,.09,d,wood,0,h);for(const x of [-w*.4,w*.4])for(const z of [-d*.4,d*.4])box(.055,h,.055,wood,x,h/2,z);
    if(family==="chair"){for(const x of [-.16,.16])box(.05,.55,.05,wood,x,.75,-.16);box(.4,.12,.05,wood,0,.98,-.16);}if(family==="bed"){box(w*.95,.18,d*.9,cloth,0,.84);box(.6,.12,.32,stone,0,.98,-.5);}
  }else if(family==="ladder"){
    for(const x of [-.3,.3])cylinder(.035,1.8,metal,x,.9);for(let i=0;i<7;i++)box(.65,.05,.06,metal,0,.15+i*.23);
  }else if(family==="sign"){
    cylinder(.04,1.5,metal,0,.75);box(.7,.44,.05,wood,0,1.4);box(.5,.035,.06,light,0,1.44,.03);
  }else if(family==="log"){
    const log=cylinder(.17,.7,wood,0,.19);log.rotation.z=Math.PI/2;
  }else if(family==="fire"){
    for(let i=0;i<3;i++){const log=cylinder(.06,.7,wood,0,.09);log.rotation.z=Math.PI/2;log.rotation.y=i*1.1;add(new THREE.ConeGeometry(.15,.6,7),light,Math.sin(i*2)*.14,.34,Math.cos(i*2)*.14);}
  }else if(family==="cocoon"){
    const cocoon=sphere(.34,cloth,0,.4);cocoon.scale.set(.8,1.5,.8);for(let n=0;n<3;n++){const ring=add(new THREE.TorusGeometry(.27,.016,5,12),stone,0,.2+n*.15);ring.rotation.x=Math.PI/2;}
  }else if(family==="web"){
    const mat=new THREE.MeshBasicMaterial({color:0xa9b3a1,transparent:true,opacity:.55});for(let n=1;n<4;n++){const ring=add(new THREE.TorusGeometry(n*.16,.009,3,8),mat,0,.055);ring.rotation.x=Math.PI/2;}for(let n=0;n<4;n++){const spoke=box(.018,.012,1,mat,0,.055);spoke.rotation.y=n*Math.PI/4;}
  }else if(family==="machine"||family==="drain"){
    box(.7,.12,.7,metal,0,.06);box(.58,.65,.48,metal,0,.44);box(.44,.08,.46,stone,0,.82);box(.23,.23,.025,cloth,0,.54,.25);for(let n=0;n<3;n++)sphere(.035,light,-.16+n*.16,.32,.27);if(def.name.toLowerCase().includes("furnace")){cylinder(.13,.9,metal,.15,1.22);box(.3,.2,.035,light,0,.4,.25);}
  }else if(family==="boat"){
    const hull=add(new THREE.SphereGeometry(.72,12,8),wood,0,.12);hull.scale.set(.65,.3,1.7);for(const x of [-.38,.38])box(.07,.22,1.7,wood,x,.27);for(const z of [-.4,.4])box(.8,.08,.17,wood,0,.3,z);
  }else if(family==="hut"){
    for(const x of [-.43,.43])for(const z of [-.43,.43])cylinder(.045,1.3,wood,x,.65,z);const roof=add(new THREE.ConeGeometry(.78,.45,4),cloth,0,1.46);roof.rotation.y=Math.PI/4;
  }else if(family==="blade"||family==="key"){
    box(.045,.04,.6,metal,0,.09);if(family==="blade"){box(.14,.07,.23,wood,0,.11,-.28);box(.3,.04,.04,metal,0,.1,-.15);}else{const ring=add(new THREE.TorusGeometry(.13,.028,6,12),metal,0,.08,-.3);ring.rotation.x=Math.PI/2;box(.17,.045,.04,metal,.04,.08,.23);}
  }else if(family==="ufo"){
    const body=sphere(.55,metal,0,.7);body.scale.set(1,.3,1);sphere(.25,cloth,0,.9);for(let n=0;n<6;n++)sphere(.03,light,Math.sin(n)*.48,.68,Math.cos(n)*.48);
  }else if(family==="quadruped"){
    const body=sphere(.32,wood,0,.62);body.scale.set(.85,.85,1.6);sphere(.2,wood,0,.93,.4);const muzzle=sphere(.13,wood,0,.88,.6);muzzle.scale.z=1.3;
    for(const x of [-.18,.18])for(const z of [-.32,.32])cylinder(.042,.56,wood,x,.3,z);
    for(const x of [-.12,.12]){add(new THREE.ConeGeometry(.065,.19,5),wood,x,1.1,.4);sphere(.025,metal,x,.98,.54);}
    const tail=cylinder(.034,.4,wood,0,.7,-.63);tail.rotation.x=-.7;
    if(/deer/i.test(def.name))for(const s of [-1,1]){const antler=cylinder(.018,.4,stone,s*.12,1.29,.35);antler.rotation.z=s*.4;for(let n=0;n<2;n++){const branch=cylinder(.011,.17,stone,s*(.17+n*.055),1.28+n*.1,.34);branch.rotation.z=s*.8;}}
  }else if(family==="bird"){
    const body=sphere(.22,cloth,0,.38);body.scale.set(1,1.1,1.35);sphere(.12,cloth,0,.64,.22);const beak=add(new THREE.ConeGeometry(.045,.15,5),light,0,.61,.35);beak.rotation.x=Math.PI/2;for(const s of [-1,1]){cylinder(.017,.23,wood,s*.09,.15);const wing=sphere(.12,cloth,s*.19,.39);wing.scale.set(.5,1,1.6);}
  }else if(family==="droid"){
    sphere(.25,metal,0,1.1);box(.52,.42,.45,metal,0,.72);box(.25,.1,.035,light,0,1.1,.25);for(const s of [-1,1]){box(.14,.65,.16,metal,s*.18,.29);box(.12,.53,.12,metal,s*.37,.73);}
  }else if(family==="arachnid"){
    const body=sphere(.27,wood,0,.32);body.scale.set(1,.6,1.4);sphere(.16,wood,0,.28,.3);for(const s of [-1,1])for(let n=0;n<4;n++){const leg=cylinder(.025,.5,wood,s*.3,.18,(n-1.5)*.16);leg.rotation.z=s*1.15;leg.rotation.x=(n-1.5)*.25;const foot=cylinder(.018,.25,wood,s*.52,.11,(n-1.5)*.2);foot.rotation.z=s*.3;}
  }else if(family==="humanoid"){
    box(.42,.56,.23,cloth,0,1.16);sphere(.18,wood,0,1.69);for(const s of [-1,1]){cylinder(.065,.68,cloth,s*.13,.48);cylinder(.053,.62,cloth,s*.3,1.11);box(.16,.13,.27,wood,s*.13,.1,.04);}
  }
  root.userData.originalModelId=def.modelId;root.userData.originalObjectId=def.originalId;return root;
}
