"""Original Bob beard/goggles, preserving hero's complete GLB rig and clips.

Run with Blender 5.1 --background --python scripts/build-npc-bob.py.
The base hero is read only; accessories are authored and rigidly weighted to
its Head joint. No animation is imported/rebaked into the final GLB.
"""
from pathlib import Path
import bpy, math, struct, json, copy
from mathutils import Vector
ROOT=Path(__file__).resolve().parents[1]
ART=ROOT/'artifacts/graphics';ART.mkdir(parents=True,exist_ok=True)
SOURCE=ROOT/'source-art';SOURCE.mkdir(parents=True,exist_ok=True)
bpy.ops.wm.read_factory_settings(use_empty=True)
parts=[]
def material(name,color,rough=.7,metal=0):
 m=bpy.data.materials.new(name);m.diffuse_color=(*color,1);m.use_nodes=True
 p=m.node_tree.nodes['Principled BSDF'];p.inputs['Base Color'].default_value=(*color,1);p.inputs['Roughness'].default_value=rough;p.inputs['Metallic'].default_value=metal
 return m
beard=material('Bob sculpted gray beard',(.24,.27,.25),.89)
frame=material('Bob work goggles frame',(.09,.11,.12),.40,.32)
lens=material('Bob work goggles amber glass',(.33,.19,.065),.18,.25)
def world_to_blender(p):return (p[0],-p[2],p[1])
def sphere(name,center,scale,mat):
 bpy.ops.mesh.primitive_uv_sphere_add(segments=8,ring_count=4,location=world_to_blender(center));o=bpy.context.object;o.name=name
 o.scale=(scale[0],scale[2],scale[1]);bpy.ops.object.transform_apply(location=False,rotation=False,scale=True);o.data.materials.append(mat);parts.append(o)
 return o
def box(name,center,scale,mat):
 bpy.ops.mesh.primitive_cube_add(size=1,location=world_to_blender(center));o=bpy.context.object;o.name=name;o.dimensions=(scale[0],scale[2],scale[1]);bpy.ops.object.transform_apply(location=False,rotation=False,scale=True)
 mod=o.modifiers.new('Rounded work gear','BEVEL');mod.width=.0025;mod.segments=2;bpy.ops.object.modifier_apply(modifier=mod.name);o.data.materials.append(mat);parts.append(o)
 return o
# A contoured cheek/chin shell, open behind the face and curved in front.
verts=[];faces=[];levels=[(1.661,.070,.064,.060),(1.628,.060,.066,.072),(1.603,.044,.065,.063),(1.578,.010,.070,.047)]
for y,w,z,depth in levels:
 for i in range(13):
  a=-math.pi/2+i*math.pi/12;verts.append(world_to_blender((w*math.sin(a),y,z+depth*math.cos(a))))
for r in range(3):
 for i in range(12):a=r*13+i;faces.append((a,a+1,a+14,a+13))
mesh=bpy.data.meshes.new('Hand shaped cheek chin beard');mesh.from_pydata(verts,[],faces);mesh.materials.append(beard)
o=bpy.data.objects.new('Contoured Bob beard',mesh);bpy.context.collection.objects.link(o);parts.append(o)
for side in (-1,1):
 sphere('Gray temple hair',(side*.071,1.745,.009),(.014,.051,.035),beard)
 sphere('Gray rear swept hair',(side*.033,1.760,-.046),(.045,.036,.031),beard)
 sphere('Gray sideburn',(side*.065,1.683,.038),(.016,.040,.018),beard)
 sphere('Sculpted cheek flow',(side*.053,1.646,.096),(.022,.026,.020),beard)
 sphere('Moustache half',(side*.022,1.672,.122),(.027,.009,.012),beard)
 for i in range(3):sphere('Beard curled tip',(side*(.010+i*.013),1.612-i*.004,.128-i*.004),(.011,.021,.010),beard)
 # Work goggles sit on the forehead rather than obscuring the eyes.
 box('Goggle metal frame',(side*.036,1.748,.095),(.064,.029,.018),frame)
 box('Inset amber lens',(side*.036,1.749,.106),(.047,.018,.005),lens)
box('Goggles bridge',(0,1.748,.096),(.018,.009,.015),frame)
box('Goggle forehead strap',(0,1.746,.030),(.147,.017,.026),frame)
bpy.ops.object.select_all(action='DESELECT')
for o in parts:o.select_set(True)
bpy.context.view_layer.objects.active=parts[0];bpy.ops.object.join();bpy.ops.object.transform_apply(location=True,rotation=True,scale=True)
accessory=bpy.context.object;accessory.name='Original Bob facial hair and work goggles'
bpy.ops.export_scene.gltf(filepath=str(ART/'bob-accessories.glb'),export_format='GLB',use_selection=True,export_yup=True,export_animations=False)

def read_glb(path):
 b=path.read_bytes();n=struct.unpack_from('<I',b,12)[0];return json.loads(b[20:20+n]),bytearray(b[28+n:])
doc,binary=read_glb(ROOT/'public/assets/hero.glb')
add,add_binary=read_glb(ART/'bob-accessories.glb')
def append_data(data,target=None):
 while len(binary)%4:binary.append(0)
 off=len(binary);binary.extend(data);view={'buffer':0,'byteOffset':off,'byteLength':len(data)}
 if target:view['target']=target
 doc['bufferViews'].append(view);return len(doc['bufferViews'])-1
view_offset=len(doc['bufferViews'])
for v in add['bufferViews']:
 start=v.get('byteOffset',0);append_data(add_binary[start:start+v['byteLength']],v.get('target'))
accessor_offset=len(doc['accessors'])
for a in add['accessors']:
 a=copy.deepcopy(a);a['bufferView']+=view_offset;doc['accessors'].append(a)
mat_offset=len(doc['materials']);doc['materials']+=add['materials']
head=next(i for i,n in enumerate(doc['nodes'])if n.get('name')=='Head')
head_joint=doc['skins'][0]['joints'].index(head)
new_mesh=copy.deepcopy(add['meshes'][0]);new_mesh['name']='Bob beard and forehead goggles'
for p in new_mesh['primitives']:
 p['indices']+=accessor_offset;p['material']+=mat_offset
 p['attributes']={k:v+accessor_offset for k,v in p['attributes'].items()}
 count=doc['accessors'][p['attributes']['POSITION']]['count']
 joints=append_data(struct.pack('<4H',head_joint,0,0,0)*count,34962)
 weights=append_data(struct.pack('<4f',1,0,0,0)*count,34962)
 p['attributes']['JOINTS_0']=len(doc['accessors']);doc['accessors'].append({'bufferView':joints,'componentType':5123,'count':count,'type':'VEC4'})
 p['attributes']['WEIGHTS_0']=len(doc['accessors']);doc['accessors'].append({'bufferView':weights,'componentType':5126,'count':count,'type':'VEC4'})
mesh_id=len(doc['meshes']);doc['meshes'].append(new_mesh)
node_id=len(doc['nodes']);doc['nodes'].append({'name':'Bob animated beard and goggles','mesh':mesh_id,'skin':0})
armature=next(n for n in doc['nodes']if n.get('name')=='Armature');armature.setdefault('children',[]).append(node_id)
# Materials become a worker uniform; untouched rig/accessors/animation remain.
for m in doc['materials']:
 p=m.setdefault('pbrMetallicRoughness',{});name=m.get('name','')
 if name=='Light ceramic armor':m['name']='Bob ochre work vest';p['baseColorFactor']=[.42,.23,.065,1];p['roughnessFactor']=.77;p['metallicFactor']=.03
 if name=='Colony expedition suit':m['name']='Bob dark blue work uniform';p['baseColorFactor']=[.027,.058,.092,1];p['roughnessFactor']=.86
 if name=='MI_Hair_1':m['name']='Bob gray eyebrows';p.pop('baseColorTexture',None);p['baseColorFactor']=[.19,.22,.20,1];p['roughnessFactor']=.9
 if name=='Weathered bronze fittings':p['baseColorFactor']=[.16,.18,.17,1];p['roughnessFactor']=.64
# Cover exposed shoulder/finger polygons with the same actual cloth material.
# The lower base body uses uniform; face/neck above the collar keeps source skin.
# Separate index subsets reuse exactly the original vertices, weights and rig.
uniform_id=next(i for i,m in enumerate(doc['materials'])if m.get('name')=='Bob dark blue work uniform')
body_mesh=doc['meshes'][next(n['mesh']for n in doc['nodes']if n.get('name')=='SuperHero_Male')]
def values(accessor_id):
 a=doc['accessors'][accessor_id];v=doc['bufferViews'][a['bufferView']];start=v.get('byteOffset',0)+a.get('byteOffset',0)
 components={'SCALAR':1,'VEC3':3}[a['type']];code={5123:'H',5125:'I',5126:'f'}[a['componentType']];size=struct.calcsize('<'+code)*components;stride=v.get('byteStride',size)
 return [struct.unpack_from('<'+code*components,binary,start+i*stride)for i in range(a['count'])]
new_primitives=[]
for p in body_mesh['primitives']:
 positions=values(p['attributes']['POSITION']);indices=[x[0]for x in values(p['indices'])];cloth_indices=[];skin_indices=[]
 for i in range(0,len(indices),3):
  tri=indices[i:i+3];(cloth_indices if min(positions[n][1]for n in tri)<1.57 else skin_indices).extend(tri)
 for subset,mat_id in [(skin_indices,p['material']),(cloth_indices,uniform_id)]:
  if not subset:continue
  view_id=append_data(struct.pack('<'+'I'*len(subset),*subset),34963)
  a_id=len(doc['accessors']);doc['accessors'].append({'bufferView':view_id,'componentType':5125,'count':len(subset),'type':'SCALAR'})
  new_p=copy.deepcopy(p);new_p['indices']=a_id;new_p['material']=mat_id;new_primitives.append(new_p)
body_mesh['primitives']=new_primitives
doc.setdefault('extras',{})['originalBobAccessories']='Sculpted beard and forehead goggles; original project artwork, full Head weights'
doc['buffers'][0]['byteLength']=len(binary)
out_json=json.dumps(doc,separators=(',',':')).encode();out_json+=b' '*((-len(out_json))%4);binary+=b'\0'*((-len(binary))%4)
blob=struct.pack('<III',0x46546c67,2,28+len(out_json)+len(binary))+struct.pack('<II',len(out_json),0x4e4f534a)+out_json+struct.pack('<II',len(binary),0x004e4942)+binary
(ROOT/'public/assets/npc-bob.glb').write_bytes(blob)

# Independently import final skinned GLB to preview material and Head attachment.
bpy.ops.wm.read_factory_settings(use_empty=True)
bpy.ops.import_scene.gltf(filepath=str(ROOT/'public/assets/npc-bob.glb'))
arm=next(o for o in bpy.context.scene.objects if o.type=='ARMATURE')
arm.animation_data_create()
for track in arm.animation_data.nla_tracks:track.mute=True
idle=next((a for a in bpy.data.actions if 'Idle' in a.name),None)
if idle:arm.animation_data.action=idle
bpy.context.scene.frame_set(18)
world=bpy.data.worlds.new('Worker portrait sky');world.use_nodes=True;world.node_tree.nodes['Background'].inputs[0].default_value=(.19,.24,.26,1);world.node_tree.nodes['Background'].inputs[1].default_value=.50;bpy.context.scene.world=world
bpy.ops.mesh.primitive_plane_add(size=30);floor=bpy.context.object;floor.name='Preview studio floor';floor.data.materials.append(material('Neutral floor',(.17,.21,.20),.9))
for loc,power,size in [((2,-3,4),500,4),((-3,-1,3),220,3),((0,3,4),400,3)]:
 bpy.ops.object.light_add(type='AREA',location=loc);o=bpy.context.object;o.data.energy=power;o.data.shape='DISK';o.data.size=size;o.rotation_euler=(Vector((0,0,1))-o.location).to_track_quat('-Z','Y').to_euler()
bpy.ops.object.camera_add(location=(2.0,-4,2.1));cam=bpy.context.object;cam.rotation_euler=(Vector((0,0,.96))-cam.location).to_track_quat('-Z','Y').to_euler();cam.data.type='ORTHO';cam.data.ortho_scale=2.35;bpy.context.scene.camera=cam
scene=bpy.context.scene;scene.render.engine='CYCLES';scene.cycles.samples=32;scene.render.resolution_x=900;scene.render.resolution_y=1100;scene.render.resolution_percentage=100;scene.render.image_settings.file_format='PNG';scene.render.filepath=str(ART/'npc-bob-preview.png');bpy.ops.render.render(write_still=True)
bpy.ops.wm.save_as_mainfile(filepath=str(SOURCE/'npc-bob.blend'))
print('BOB_READY',ROOT/'public/assets/npc-bob.glb',len(blob),'clips',[a['name']for a in doc['animations']])
