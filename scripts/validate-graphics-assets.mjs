// Validate final GLB geometry through the runtime Three.js loader. Embedded PBR
// images are checked in the GLB; image decode/render is covered by Blender QA.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { AnimationMixer, Box3, Vector3 } from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
globalThis.ProgressEvent ??= class { constructor(type, fields) { this.type=type;Object.assign(this,fields); } };
const root=path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const reports=[];
for (const name of ['house','tree','npc-bob']) {
  const file=fs.readFileSync(path.join(root,'public/assets',name+'.glb'));
  if(file.readUInt32LE(0)!==0x46546c67)throw Error(name+' invalid magic');
  const jsonSize=file.readUInt32LE(12);
  const doc=JSON.parse(file.subarray(20,20+jsonSize).toString());
  const binary=file.subarray(28+jsonSize);
  let triangles=0,primitives=0,texturedMaterials=0;
  for(const mesh of doc.meshes)for(const p of mesh.primitives){
    triangles+=doc.accessors[p.indices].count/3;primitives++;
    if(name!=='npc-bob'&&!('TEXCOORD_0' in p.attributes))throw Error(name+' missing UVs');
  }
  for(const m of doc.materials){
    if(m.normalTexture){
      if(!m.pbrMetallicRoughness?.baseColorTexture||!m.pbrMetallicRoughness?.metallicRoughnessTexture)throw Error(name+' incomplete PBR maps');
      texturedMaterials++;
    }
  }
  for(const im of doc.images){
    const v=doc.bufferViews[im.bufferView];
    const png=binary.subarray(v.byteOffset,v.byteOffset+v.byteLength);
    if(png.readUInt32BE(0)!==0x89504e47||png.readUInt32BE(4)!==0x0d0a1a0a)throw Error(name+' invalid embedded PNG');
  }
  const geometryDoc=structuredClone(doc);
  delete geometryDoc.images;delete geometryDoc.textures;delete geometryDoc.materials;delete geometryDoc.samplers;
  for(const mesh of geometryDoc.meshes)for(const p of mesh.primitives)delete p.material;
  geometryDoc.buffers[0].uri='data:application/octet-stream;base64,'+binary.toString('base64');
  const parsed=await new GLTFLoader().parseAsync(JSON.stringify(geometryDoc),'');
  parsed.scene.updateMatrixWorld(true);
  parsed.scene.traverse(o=>{
    if(!o.isMesh)return;
    for(const a of Object.values(o.geometry.attributes))for(const x of a.array)if(!Number.isFinite(x))throw Error(name+' nonfinite attribute');
  });
  const bounds=new Box3().setFromObject(parsed.scene);
  const report={asset:name+'.glb',bytes:file.length,triangles,primitives,materials:doc.materials.length,texturedMaterials,images:doc.images.length,bounds:{min:bounds.min.toArray(),max:bounds.max.toArray(),size:bounds.getSize(new Vector3()).toArray()},animations:parsed.animations.map(a=>a.name),threeLoaded:true};
  if(name==='npc-bob'){
    const reference=fs.readFileSync(path.join(root,'public/assets/hero.glb'));const rSize=reference.readUInt32LE(12);const rDoc=JSON.parse(reference.subarray(20,20+rSize).toString());
    if(JSON.stringify(doc.animations)!==JSON.stringify(rDoc.animations)||JSON.stringify(doc.skins)!==JSON.stringify(rDoc.skins))throw Error('NPC changed rig or animation data');
    const mixer=new AnimationMixer(parsed.scene);report.clipSamples=[];
    for(const clip of parsed.animations){
      mixer.stopAllAction();const action=mixer.clipAction(clip);action.play();let maxExtent=0;
      for(const t of [0,.2,.5,.8,1]){
        mixer.setTime(clip.duration*t);parsed.scene.updateMatrixWorld(true);
        parsed.scene.traverse(o=>{if(o.isSkinnedMesh){o.skeleton.update();o.computeBoundingBox();}});
        const size=new Box3().setFromObject(parsed.scene).getSize(new Vector3());
        if(size.toArray().some(v=>!Number.isFinite(v)||v>3))throw Error('NPC exploded in '+clip.name);
        maxExtent=Math.max(maxExtent,...size.toArray());
      }
      report.clipSamples.push({clip:clip.name,duration:clip.duration,maxExtent});
    }
    report.joints=doc.skins[0].joints.length;report.rigAndAnimationsUnchanged=true;
  } else if(file.length>2*1024*1024||triangles>(name==='house'?12000:5000)||primitives>(name==='house'?9:3))throw Error(name+' exceeds runtime budget');
  reports.push(report);
}
fs.mkdirSync(path.join(root,'artifacts/graphics'),{recursive:true});
fs.writeFileSync(path.join(root,'artifacts/graphics/asset-validation.json'),JSON.stringify(reports,null,2)+'\n');
console.log(JSON.stringify(reports,null,2));
