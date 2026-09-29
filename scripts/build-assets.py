"""Build CC0 animated avatars and original colony props; never changes sources.

Run with ordinary Python. Blender is used only to author props and render QA.
"""
from __future__ import annotations
import base64
import copy
import json
import math
from pathlib import Path
import re
import shutil
import struct
import subprocess
import sys

ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / "public/assets"
SOURCE = Path(r"C:\Projects\animegame.ru\public\assets")
BLENDER = Path(r"C:\Program Files\Blender Foundation\Blender 5.1\blender.exe")
CLIPS = {
    "Idle": "Idle_Loop", "Walk": "Walk_Loop", "Run": "Jog_Fwd_Loop",
    "Attack": "Sword_Attack", "Hit": "Hit_Chest", "Death": "Death01",
    "Shoot": "Pistol_Shoot", "Interact": "Interact", "Sprint": "Sprint_Loop",
}

def load_gltf(path):
    data = path.read_bytes()
    if data[:4] == b"glTF":
        length = struct.unpack_from("<I", data, 12)[0]
        doc = json.loads(data[20:20 + length])
        offset = 20 + length
        binary = data[offset + 8:offset + 8 + struct.unpack_from("<I", data, offset)[0]]
        return doc, binary
    doc = json.loads(data)
    return doc, (path.parent / doc["buffers"][0]["uri"]).read_bytes()

def save_glb(doc, binary, path):
    doc["buffers"] = [{"byteLength": len(binary)}]
    js = json.dumps(doc, separators=(",", ":")).encode()
    js += b" " * (-len(js) % 4)
    binary += b"\0" * (-len(binary) % 4)
    total = 12 + 8 + len(js) + 8 + len(binary)
    path.write_bytes(struct.pack("<III", 0x46546C67, 2, total) +
                     struct.pack("<II", len(js), 0x4E4F534A) + js +
                     struct.pack("<II", len(binary), 0x004E4942) + binary)

def strip_textures(doc, binary):
    doc = copy.deepcopy(doc)
    doc["images"] = []
    doc["textures"] = []
    doc["materials"] = []
    for mesh in doc["meshes"]:
        for primitive in mesh["primitives"]:
            primitive.pop("material", None)
    doc["buffers"] = [{"byteLength": len(binary), "uri": "data:application/octet-stream;base64," + base64.b64encode(binary).decode()}]
    return doc

def retarget(hero_path):
    hero, hero_bin = load_gltf(hero_path)
    source, source_bin = load_gltf(SOURCE / "animations/quaternius-universal/UAL1_Standard.glb")
    # SkeletonUtils performs rest-pose retargeting: the two rigs have different
    # limb proportions despite sharing bone names. Copying tracks deforms them.
    stage = ROOT / "artifacts/asset-source/build"
    stage.mkdir(parents=True, exist_ok=True)
    (stage / "hero-retarget.json").write_text(json.dumps(strip_textures(hero, hero_bin)))
    (stage / "source-retarget.json").write_text(json.dumps(strip_textures(source, source_bin)))
    script = r'''
import fs from 'node:fs';
import * as THREE from 'three';
import {GLTFLoader} from 'three/examples/jsm/loaders/GLTFLoader.js';
import {retargetClip} from 'three/examples/jsm/utils/SkeletonUtils.js';
globalThis.ProgressEvent = class ProgressEvent { constructor(type, args) {this.type=type;Object.assign(this,args);} };
const folder = new URL('./', import.meta.url);
const loader = new GLTFLoader();
const target = await loader.parseAsync(fs.readFileSync(new URL('hero-retarget.json',folder),'utf8'),'');
const source = await loader.parseAsync(fs.readFileSync(new URL('source-retarget.json',folder),'utf8'),'');
function mesh(root){let found;root.traverse(n=>{if(!found&&n.isSkinnedMesh)found=n;});return found;}
const targetMesh=mesh(target.scene), sourceMesh=mesh(source.scene);
const wanted=JSON.parse(process.argv[2]);
const result=[];
for(const [name,sourceName] of Object.entries(wanted)){
 const sourceClip=source.animations.find(c=>c.name===sourceName);
 if(!sourceClip)throw new Error('Missing animation '+sourceName);
 targetMesh.skeleton.pose();target.scene.updateMatrixWorld(true);
 sourceMesh.skeleton.pose();source.scene.updateMatrixWorld(true);
 const clip=retargetClip(targetMesh,sourceMesh,sourceClip,{hip:'pelvis',fps:30,getBoneName:b=>b.name});
 clip.name=name;clip.optimize();
 result.push({name,duration:clip.duration,tracks:clip.tracks.map(t=>({name:t.name,times:Array.from(t.times),values:Array.from(t.values)}))});
}
fs.writeFileSync(new URL('clips.json',folder),JSON.stringify(result));
console.log(JSON.stringify(result.map(c=>({name:c.name,duration:c.duration,tracks:c.tracks.length}))));
'''
    (stage / "retarget.mjs").write_text(script)
    subprocess.run(["node", str(stage / "retarget.mjs"), json.dumps(CLIPS)], cwd=ROOT, check=True)
    clips = json.loads((stage / "clips.json").read_text())
    return hero, bytearray(hero_bin), clips

def add_accessor(doc, binary, values, components):
    binary += b"\0" * (-len(binary) % 4)
    offset = len(binary)
    binary += struct.pack("<" + "f" * len(values), *values)
    view = len(doc.setdefault("bufferViews", []))
    doc["bufferViews"].append({"buffer": 0, "byteOffset": offset, "byteLength": len(values) * 4})
    accessor = len(doc.setdefault("accessors", []))
    a = {"bufferView": view, "componentType": 5126, "count": len(values) // components,
         "type": {1: "SCALAR", 3: "VEC3", 4: "VEC4"}[components]}
    if components == 1:
        a.update(min=[min(values)], max=[max(values)])
    doc["accessors"].append(a)
    return accessor

def embed_images(doc, binary, source_folder, lightweight=True):
    # Preserve the CC0 supplied color maps. Drop high-resolution normal/ORM
    # maps to keep this browser prototype small; meshes retain smooth normals.
    if lightweight:
        for material in doc.get("materials", []):
            material.pop("normalTexture", None)
            material.pop("occlusionTexture", None)
            pbr = material.setdefault("pbrMetallicRoughness", {})
            pbr.pop("metallicRoughnessTexture", None)
            pbr["roughnessFactor"] = 0.72
            pbr["metallicFactor"] = 0.12 if "Superhero" in material.get("name", "") else 0
    refs = set()
    def scan(value):
        if isinstance(value, dict):
            for key, child in value.items():
                if key.endswith("Texture") and isinstance(child, dict) and "index" in child:
                    refs.add(child["index"])
                scan(child)
        elif isinstance(value, list):
            for child in value: scan(child)
    scan(doc.get("materials", []))
    old_textures = doc.get("textures", [])
    textures, images, tex_map, image_map = [], [], {}, {}
    for old in sorted(refs):
        t = copy.deepcopy(old_textures[old])
        old_image = t["source"]
        if old_image not in image_map:
            image_map[old_image] = len(images)
            im = copy.deepcopy(doc["images"][old_image])
            raw = (source_folder / im.pop("uri")).read_bytes()
            binary += b"\0" * (-len(binary) % 4)
            im["bufferView"] = len(doc["bufferViews"])
            im["mimeType"] = "image/png"
            doc["bufferViews"].append({"buffer": 0, "byteOffset": len(binary), "byteLength": len(raw)})
            binary += raw
            images.append(im)
        t["source"] = image_map[old_image]
        tex_map[old] = len(textures)
        textures.append(t)
    def replace(value):
        if isinstance(value, dict):
            for key, child in value.items():
                if key.endswith("Texture") and isinstance(child, dict) and "index" in child:
                    child["index"] = tex_map[child["index"]]
                replace(child)
        elif isinstance(value, list):
            for child in value: replace(child)
    replace(doc.get("materials", []))
    doc["textures"], doc["images"] = textures, images

def build_avatars():
    hero_path = SOURCE / "models/quaternius-characters/Superhero_Male_FullBody.gltf"
    doc, binary, clips = retarget(hero_path)
    node_map = {node["name"]: index for index, node in enumerate(doc["nodes"])}
    doc["animations"] = []
    for clip in clips:
        animation = {"name": clip["name"], "channels": [], "samplers": []}
        for track in clip["tracks"]:
            match = re.search(r"\.bones\[([^]]+)\]\.(position|quaternion|scale)$", track["name"])
            if not match: raise ValueError("Unexpected retarget track " + track["name"])
            bone, prop = match.groups()
            values = track["values"]
            # Locomotion is in place. The server/client controller owns XZ travel.
            if bone == "pelvis" and prop == "position" and clip["name"] in ("Idle", "Walk", "Run", "Sprint"):
                values = list(values)
                for i in range(0, len(values), 3):
                    values[i], values[i + 2] = values[0], values[2]
            i = add_accessor(doc, binary, track["times"], 1)
            o = add_accessor(doc, binary, values, 4 if prop == "quaternion" else 3)
            animation["channels"].append({"sampler": len(animation["samplers"]), "target": {"node": node_map[bone], "path": {"position": "translation", "quaternion": "rotation", "scale": "scale"}[prop]}})
            animation["samplers"].append({"input": i, "output": o, "interpolation": "LINEAR"})
        doc["animations"].append(animation)
    doc.setdefault("extras", {}).update({"prototypeAsset": "Colony explorer", "sourceAuthor": "Quaternius", "sourceLicense": "CC0-1.0", "clipsRetargeted": True})
    embed_images(doc, binary, hero_path.parent)
    save_glb(doc, bytes(binary), OUT / "hero.glb")
    drone_path = SOURCE / "models/quaternius-scifi/Enemy_EyeDrone.gltf"
    drone, drone_bin = load_gltf(drone_path)
    drone_bin = bytearray(drone_bin)
    embed_images(drone, drone_bin, drone_path.parent)
    save_glb(drone, bytes(drone_bin), OUT / "drone.glb")
    licenses = OUT / "licenses"
    licenses.mkdir(exist_ok=True)
    for name, source in {
        "quaternius-characters.txt": SOURCE / "models/quaternius-characters/License_Standard.txt",
        "quaternius-animations.txt": SOURCE / "animations/quaternius-universal/LICENSE.txt",
        "quaternius-scifi.txt": SOURCE / "models/quaternius-scifi/LICENSE.txt",
    }.items(): shutil.copyfile(source, licenses / name)

def build_blender():
    import bpy
    from mathutils import Vector
    bpy.ops.wm.read_factory_settings(use_empty=True)
    def mat(name, color, roughness=.7, metallic=0, emission=0):
        m = bpy.data.materials.new(name); m.diffuse_color = (*color, 1); m.use_nodes = True
        n=m.node_tree.nodes.get('Principled BSDF');n.inputs['Base Color'].default_value=(*color,1)
        n.inputs['Roughness'].default_value=roughness;n.inputs['Metallic'].default_value=metallic
        if emission:n.inputs['Emission Color'].default_value=(*color,1);n.inputs['Emission Strength'].default_value=emission
        return m
    plaster=mat('Warm colony plaster',(.62,.55,.40));roof=mat('Charcoal ceramic',(.055,.083,.10),.55)
    metal=mat('Weathered bronze fittings',(.25,.30,.31),.5,.55);wood=mat('Dark oak',(.17,.10,.055))
    window=mat('Warm illuminated glass',(.94,.55,.17),.35,0,1.5);cyan=mat('Colony cyan indicator',(.07,.70,.86),.2,0,2)
    bark=mat('Bark',(.21,.13,.065));leaf=mat('Leaves',(.12,.26,.16));leaf2=mat('Sunlit leaves',(.24,.39,.17))
    stone=mat('Foundation stone',(.32,.34,.29));ground=mat('Preview ground',(.105,.14,.135))
    def cube(name,location,size,material,bevel=.03):
        bpy.ops.mesh.primitive_cube_add(size=1,location=location);o=bpy.context.object;o.name=name;o.dimensions=size
        bpy.ops.object.transform_apply(location=False,rotation=False,scale=True)
        if bevel:
            m=o.modifiers.new('Edge wear','BEVEL');m.width=bevel;m.segments=2
            bpy.context.view_layer.objects.active=o;bpy.ops.object.modifier_apply(modifier=m.name)
        o.data.materials.append(material);return o
    def cylinder(name,location,radius,depth,material,vertices=12):
        bpy.ops.mesh.primitive_cylinder_add(vertices=vertices,radius=radius,depth=depth,location=location)
        o=bpy.context.object;o.name=name;o.data.materials.append(material);return o
    def export(name, objects):
        bpy.ops.object.select_all(action='DESELECT')
        for o in objects:o.select_set(True)
        bpy.ops.export_scene.gltf(filepath=str(OUT/(name+'.glb')),export_format='GLB',use_selection=True,export_yup=True)
    before=set(bpy.data.objects)
    cube('Stone plinth',(0,0,.17),(4.8,3.9,.34),stone)
    cube('Stucco walls',(0,0,1.6),(4.4,3.5,2.7),plaster)
    cube('Roof cornice',(0,0,3.03),(4.8,3.95,.24),roof)
    # Close the gables under the sloping roof, rather than leaving an open attic.
    verts=[(-2.2,-1.75,3.06),(2.2,-1.75,3.06),(0,-1.75,4.17),
           (-2.2,1.75,3.06),(2.2,1.75,3.06),(0,1.75,4.17)]
    mesh=bpy.data.meshes.new('Gable mesh');mesh.from_pydata(verts,[],[(0,1,2),(5,4,3),(0,3,4,1),(1,4,5,2),(2,5,3,0)])
    gable=bpy.data.objects.new('Closed plaster gable',mesh);bpy.context.collection.objects.link(gable);mesh.materials.append(plaster)
    for sign in (-1,1):
        o=cube('Sloping roof',(sign*1.13,0,3.65),(2.55,4.05,.22),roof);o.rotation_euler[1]=sign*math.radians(24)
    cube('Door',(0,-1.765,1.17),(.94,.10,1.96),wood)
    cube('Door lintel',(0,-1.86,2.25),(1.25,.25,.20),metal)
    cube('Front step',(0,-2.04,.25),(1.5,.58,.25),stone)
    for x in (-1.48,1.48):
        cube('Window bronze surround',(x,-1.79,1.75),(.82,.12,1.07),metal)
        cube('Window glow',(x,-1.86,1.75),(.64,.04,.86),window)
        cube('Window upright',(x,-1.90,1.75),(.055,.03,.9),wood)
        cube('Window crossbar',(x,-1.90,1.72),(.68,.03,.055),wood)
        cube('Window sill',(x,-1.92,1.18),(.95,.30,.09),stone)
    for sign in (-1,1):
        for y in (-.65,.65):
            cube('Side window surround',(sign*2.24,y,1.8),(.10,.82,1.03),metal)
            cube('Side amber pane',(sign*2.30,y,1.8),(.035,.68,.86),window)
    cylinder('Exhaust stack',(1.4,.85,3.80),.16,1.32,metal)
    cylinder('Exhaust cap',(1.4,.85,4.48),.26,.14,roof)
    cube('Power controller',(-2.27,.7,1.1),(.21,.55,.75),metal)
    cube('Status indicator',(-2.39,.7,1.3),(.025,.30,.055),cyan)
    cylinder('Antenna pole',(-1.45,1.3,4.15),.025,1.4,metal,8)
    cube('Antenna crossbar',(-1.45,1.3,4.70),(.75,.05,.04),metal,.01)
    house=list(set(bpy.data.objects)-before);export('house',house)
    before=set(bpy.data.objects)
    cylinder('Trunk',(0,0,1.7),.18,3.4,bark,9)
    for i in range(5):
        angle=i*math.tau/5
        branch=cylinder('Branch',(math.cos(angle)*.45,math.sin(angle)*.45,2.35+i*.10),.07,1.2,bark,7)
        branch.rotation_euler=(math.sin(angle)*.75,math.cos(angle)*.75,0)
    for i,(x,y,z,scale) in enumerate([(0,0,3.9,1.35),(-.95,0,3.35,1.0),(.9,.1,3.45,1.1),(0,.8,3.3,1),(0,-.8,3.45,1)]):
        bpy.ops.mesh.primitive_ico_sphere_add(subdivisions=2,radius=1,location=(x,y,z))
        o=bpy.context.object;o.name='Canopy';o.scale=(scale,scale*.85,scale*.92);o.data.materials.append(leaf if i%2 else leaf2)
    tree=list(set(bpy.data.objects)-before);export('tree',tree)
    # Preview models in a measured studio/colony scene. Hero animation is
    # imported from the generated GLB, so the preview verifies the final rig.
    for o in house:o.location.x+=5
    for o in tree:o.location.x-=4;o.location.y+=2
    bpy.ops.import_scene.gltf(filepath=str(OUT/'hero.glb'))
    rig=next(o for o in bpy.context.selected_objects if o.type=='ARMATURE')
    # Outfit uses the actual humanoid topology and original normalized weights.
    # Every garment follows the same 65-joint armature, including bent knees,
    # elbows and shoulders. The body underneath remains the CC0 source mesh.
    body=max((o for o in bpy.context.selected_objects if o.type=='MESH'),key=lambda o:len(o.data.vertices))
    suit=mat('Colony expedition suit',(.055,.105,.15),.82)
    boots=mat('Expedition boots and gloves',(.025,.034,.043),.65)
    panel=mat('Light ceramic armor',(.45,.50,.46),.45,.16)
    import bmesh
    def garment(name,material,accept,offset=.008):
        o=body.copy();o.data=body.data.copy();o.name=name;bpy.context.collection.objects.link(o)
        bm=bmesh.new();bm.from_mesh(o.data)
        # The glTF importer changes coordinate axes to Blender Z-up.
        rejected=[v for v in bm.verts if not accept(v.co.x,v.co.y,v.co.z)]
        bmesh.ops.delete(bm,geom=rejected,context='VERTS')
        bm.normal_update()
        for v in bm.verts:v.co+=v.normal*offset
        bm.to_mesh(o.data);bm.free();o.data.materials.clear();o.data.materials.append(material)
        for face in o.data.polygons:face.material_index=0
        return o
    jacket=garment('Expedition jacket',suit,lambda x,y,z:.92<z<1.53 and abs(x)<.77)
    trousers=garment('Utility trousers',suit,lambda x,y,z:.16<z<1.01)
    footwear=garment('Expedition boots',boots,lambda x,y,z:z<.30,offset=.018)
    gloves=garment('Work gloves',boots,lambda x,y,z:abs(x)>.72)
    chest=garment('Ceramic vest panels',panel,lambda x,y,z:1.10<z<1.41 and abs(x)<.25 and y<-.045,offset=.016)
    def attach(o,bone):
        world=o.matrix_world.copy();o.parent=rig;o.parent_type='BONE';o.parent_bone=bone;o.matrix_world=world
    pack=cube('Compact field backpack',(0,.17,1.20),(.30,.18,.43),metal,.045);attach(pack,'spine_02')
    badge=cube('Field pack power strip',(0,.273,1.28),(.15,.018,.025),cyan,.006);attach(badge,'spine_02')
    # Export every imported animation as its own named NLA track. Exporting only
    # the active action would silently discard the movement/combat clips.
    hero_objects=[rig,body,jacket,trousers,footwear,gloves,chest,pack,badge]
    hero_objects += [o for o in bpy.context.scene.objects if o.type=='MESH' and o.parent==rig and o not in hero_objects]
    bpy.ops.object.select_all(action='DESELECT')
    for o in hero_objects:o.select_set(True)
    for track in rig.animation_data.nla_tracks:track.mute=False
    rig.animation_data.action=None
    bpy.ops.export_scene.gltf(filepath=str(OUT/'hero.glb'),export_format='GLB',use_selection=True,export_yup=True,export_animation_mode='NLA_TRACKS')
    for track in rig.animation_data.nla_tracks:track.mute=True
    idle=next(a for a in bpy.data.actions if a.name=='Idle' or a.name.startswith('Idle_'))
    rig.animation_data.action=idle
    if hasattr(idle,'slots') and len(idle.slots):rig.animation_data.action_slot=idle.slots[0]
    bpy.context.scene.frame_set(12)
    rig.rotation_euler[2]=math.radians(-12)
    bpy.ops.import_scene.gltf(filepath=str(OUT/'drone.glb'))
    drone_rigs=[o for o in bpy.context.selected_objects if o.type=='ARMATURE']
    if drone_rigs:
        dr=drone_rigs[0];dr.location=(1.9,-1.0,1.0)
        for tr in dr.animation_data.nla_tracks:tr.mute=True
    cube('Studio ground',(0,0,-.12),(200,200,.2),ground,0)
    bpy.context.scene.render.engine='CYCLES';bpy.context.scene.cycles.samples=24
    bpy.context.scene.render.resolution_x=1280;bpy.context.scene.render.resolution_y=800;bpy.context.scene.render.resolution_percentage=100
    bpy.context.scene.world=bpy.data.worlds.new('Sky');bpy.context.scene.world.use_nodes=True
    bpy.context.scene.world.node_tree.nodes['Background'].inputs[0].default_value=(.32,.42,.54,1)
    bpy.context.scene.world.node_tree.nodes['Background'].inputs[1].default_value=.4
    def area(loc,power,size):
        bpy.ops.object.light_add(type='AREA',location=loc);o=bpy.context.object;o.data.energy=power;o.data.shape='DISK';o.data.size=size
        o.rotation_euler=(Vector((0,0,1.4))-o.location).to_track_quat('-Z','Y').to_euler()
    area((2,-6,9),1600,7);area((-6,-1,5),950,6);area((3,6,6),1400,5)
    bpy.ops.object.camera_add(location=(9,-15,8));camera=bpy.context.object
    camera.rotation_euler=(Vector((.8,0,1.9))-camera.location).to_track_quat('-Z','Y').to_euler();camera.data.type='ORTHO';camera.data.ortho_scale=13
    bpy.context.scene.camera=camera;bpy.context.scene.render.filepath=str(OUT/'preview.png');bpy.ops.render.render(write_still=True)
    (ROOT/'source-art').mkdir(exist_ok=True)
    bpy.ops.wm.save_as_mainfile(filepath=str(ROOT/'source-art/colony-assets.blend'))

if __name__ == '__main__':
    OUT.mkdir(parents=True, exist_ok=True)
    if '--blender' in sys.argv:
        build_blender()
    else:
        build_avatars()
        subprocess.run([str(BLENDER),'--background','--python',str(Path(__file__).resolve()),'--','--blender'],check=True)
        print('Built hero.glb, drone.glb, house.glb, tree.glb, preview.png')
