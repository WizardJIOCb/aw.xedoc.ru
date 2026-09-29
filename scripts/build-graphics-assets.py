"""Author detailed original colony architecture and leaf geometry in Blender.

blender --background --python scripts/build-graphics-assets.py
Pass -- --textures-only to generate and inspect PBR maps before modelling.
"""
from pathlib import Path
import math
import random
import sys
import json
import struct
import bpy
import numpy as np
from mathutils import Vector

ROOT=Path(__file__).resolve().parents[1]
OUT=ROOT/'public/assets'
SOURCE=ROOT/'source-art/graphics-textures'
ART=ROOT/'artifacts/graphics'
for p in [OUT,SOURCE,ART]:p.mkdir(parents=True,exist_ok=True)
bpy.ops.wm.read_factory_settings(use_empty=True)
rng=np.random.default_rng(72217)

def noise(n,cells):
    """Periodic smooth value noise, authored here rather than downloaded."""
    grid=rng.random((cells,cells));x=np.arange(n)*cells/n
    a=np.floor(x).astype(int);f=x-a;f=f*f*(3-2*f)
    v00=grid[a[:,None]%cells,a[None,:]%cells]
    v01=grid[a[:,None]%cells,(a[None,:]+1)%cells]
    v10=grid[(a[:,None]+1)%cells,a[None,:]%cells]
    v11=grid[(a[:,None]+1)%cells,(a[None,:]+1)%cells]
    return (v00*(1-f)[None,:]+v01*f[None,:])*(1-f)[:,None]+(v10*(1-f)[None,:]+v11*f[None,:])*f[:,None]

def image(name,array,noncolor=False):
    h,w=array.shape[:2];im=bpy.data.images.new(name,width=w,height=h,alpha=False)
    # Changing color space after writing generated pixels clears their Blender
    # buffer; establish the data color space before populating normal/roughness.
    if noncolor:im.colorspace_settings.name='Non-Color'
    if array.ndim==2:array=np.repeat(array[...,None],3,axis=-1)
    rgba=np.ones((h,w,4),dtype=np.float32);rgba[:,:,:3]=np.clip(array,0,1)
    im.pixels.foreach_set(rgba.ravel());im.update()
    im.filepath_raw=str(SOURCE/(name+'.png'));im.file_format='PNG';im.save()
    return im

def normal_from_height(height,strength):
    du=(np.roll(height,-1,axis=1)-np.roll(height,1,axis=1))*strength
    dv=(np.roll(height,-1,axis=0)-np.roll(height,1,axis=0))*strength
    normal=np.stack((-du,-dv,np.ones_like(height)),axis=-1)
    normal/=np.linalg.norm(normal,axis=-1)[...,None]
    return normal*.5+.5

def textures():
    n=512;u,v=np.meshgrid(np.arange(n)/n,np.arange(n)/n)
    grain=noise(n,100);broad=noise(n,7);patch=noise(n,21);fine=rng.random((n,n))
    # Aged mineral plaster: fine trowel grain, pinholes and exposed aggregate.
    chips=np.clip((.31-patch)*7,0,1);pores=np.clip((fine-.945)*14,0,1)
    streak=np.sin(u*math.tau*25+noise(n,9)*2)*.5+.5
    height=.50+.12*grain+.025*fine-.16*chips-.10*pores
    tint=.94+.045*broad+.035*grain+.012*fine-.085*chips-.018*streak*noise(n,5)
    base=np.stack((.84*tint,.795*tint,.66*tint),axis=-1)
    image('plaster-base',base);image('plaster-normal',normal_from_height(height,3.1),True)
    image('plaster-roughness',.77+.12*grain+.08*chips,True)
    n=256;u,v=np.meshgrid(np.arange(n)/n,np.arange(n)/n)
    grain=noise(n,36);large=noise(n,7)
    # Vertical bark fissures, with slightly wandering ridges.
    ridges=(np.sin(u*math.tau*19+np.sin(v*math.tau*3)*1.1+large*1.4)*.5+.5)**3
    bark_height=.22*ridges+.07*grain+.04*large
    bark_tint=.65+.48*ridges+.12*grain
    image('bark-base',np.stack((.265*bark_tint,.175*bark_tint,.086*bark_tint),axis=-1))
    image('bark-normal',normal_from_height(bark_height,2.8),True)
    image('bark-roughness',.74+.20*(1-ridges),True)
    # Roof: small mineral specks and longitudinal sheet ridges.
    metalheight=.06*noise(n,80)+.008*np.sin(u*math.tau*8)
    mottled=.85+.15*noise(n,9)
    image('roof-base',np.stack((.025*mottled,.036*mottled,.040*mottled),axis=-1))
    image('roof-normal',normal_from_height(metalheight,2),True)
    image('roof-roughness',.77+.12*grain,True)
    # Warp/weft fibers for the expedition suit; repeat using glTF UV transform.
    weave=.018*np.sin(u*math.tau*8)*np.cos(v*math.tau*8)+.004*noise(n,64)
    image('cloth-normal',normal_from_height(weave,5),True)

textures()
if '--textures-only' in sys.argv:
    print('TEXTURES_READY',SOURCE)
    raise SystemExit(0)

def mat(name,color,roughness=.7,metallic=0,texture=None,emissive=0):
    m=bpy.data.materials.new(name);m.diffuse_color=(*color,1);m.use_nodes=True
    nt=m.node_tree;bsdf=nt.nodes.get('Principled BSDF')
    bsdf.inputs['Base Color'].default_value=(*color,1);bsdf.inputs['Roughness'].default_value=roughness
    bsdf.inputs['Metallic'].default_value=metallic
    if texture:
        for suffix,socket in [('base','Base Color'),('roughness','Roughness')]:
            im=bpy.data.images.get(texture+'-'+suffix)
            if im:
                tex=nt.nodes.new('ShaderNodeTexImage');tex.image=im;nt.links.new(tex.outputs['Color'],bsdf.inputs[socket])
        im=bpy.data.images.get(texture+'-normal')
        if im:
            tex=nt.nodes.new('ShaderNodeTexImage');tex.image=im
            normal=nt.nodes.new('ShaderNodeNormalMap');normal.inputs['Strength'].default_value=.5
            nt.links.new(tex.outputs['Color'],normal.inputs['Color']);nt.links.new(normal.outputs['Normal'],bsdf.inputs['Normal'])
    if emissive:
        bsdf.inputs['Emission Color'].default_value=(*color,1);bsdf.inputs['Emission Strength'].default_value=emissive
    return m

plaster=mat('Aged mineral plaster',(.84,.795,.66),texture='plaster')
roof=mat('Individual oxidized roof panels',(.025,.036,.040),.82,.05,texture='roof')
metal=mat('Deep petrol painted metal',(.055,.12,.13),.40,.42)
wood=mat('Rough colony hardwood',(.24,.16,.085),texture='bark')
glass=mat('Recessed warm glass',(.39,.27,.13),.15,.28,emissive=.18)
stone=mat('Weathered foundation stone',(.29,.315,.29),.89)
copper=mat('Oxidized copper fittings',(.34,.23,.115),.48,.50)
screen=mat('Cyan controller display',(.035,.48,.58),.22,.05,emissive=1.1)
bark=mat('Ridged brown bark',(.24,.16,.08),texture='bark')
leaves=mat('Living leaves with vertex shade',(.26,.47,.16),.8)
leaves.use_nodes=True
attr=leaves.node_tree.nodes.new('ShaderNodeVertexColor');attr.layer_name='Foliage color'
leaves.node_tree.links.new(attr.outputs['Color'],leaves.node_tree.nodes['Principled BSDF'].inputs['Base Color'])
leaves.surface_render_method='DITHERED'
leaves.use_backface_culling=False

def uv_world(obj,scale=.5):
    """World-coherent texture scale across separate plaster/trim pieces."""
    uv=obj.data.uv_layers.active or obj.data.uv_layers.new(name='UVMap')
    for poly in obj.data.polygons:
        normal=poly.normal;axis=max(range(3),key=lambda i:abs(normal[i]))
        dimensions=[i for i in range(3) if i!=axis]
        for li in poly.loop_indices:
            co=obj.matrix_world@obj.data.vertices[obj.data.loops[li].vertex_index].co
            uv.data[li].uv=(co[dimensions[0]]*scale,co[dimensions[1]]*scale)

house_parts=[]
def cube(name,loc,size,material,bevel=.016,parts=house_parts):
    bpy.ops.mesh.primitive_cube_add(size=1,location=loc);o=bpy.context.object;o.name=name;o.dimensions=size
    bpy.ops.object.transform_apply(location=False,rotation=False,scale=True)
    if bevel:
        mod=o.modifiers.new('Worn edges','BEVEL');mod.width=bevel;mod.segments=1
        bpy.context.view_layer.objects.active=o;bpy.ops.object.modifier_apply(modifier=mod.name)
    o.data.materials.append(material);uv_world(o);parts.append(o);return o

def tube(name,points,radii,material,segments=8,parts=house_parts,uv_scale=1):
    verts=[];faces=[]
    for i,point in enumerate(points):
        p=Vector(point);direction=Vector(points[min(i+1,len(points)-1)])-Vector(points[max(0,i-1)])
        direction.normalize();ref=Vector((0,0,1))
        if abs(direction.dot(ref))>.92:ref=Vector((0,1,0))
        right=direction.cross(ref).normalized();up=right.cross(direction).normalized()
        for j in range(segments):
            angle=j/segments*math.tau;radius=radii[i]*(1+.04*math.sin(j*2.7+i))
            verts.append(p+(right*math.cos(angle)+up*math.sin(angle))*radius)
    for i in range(len(points)-1):
        for j in range(segments):
            a=i*segments+j;b=i*segments+(j+1)%segments;c=b+segments;d=a+segments
            faces.append((a,b,c,d))
    faces.append(tuple(range(segments-1,-1,-1)))
    faces.append(tuple((len(points)-1)*segments+j for j in range(segments)))
    mesh=bpy.data.meshes.new(name);mesh.from_pydata(verts,[],faces);mesh.materials.append(material)
    o=bpy.data.objects.new(name,mesh);bpy.context.collection.objects.link(o)
    uv=mesh.uv_layers.new(name='UVMap')
    for poly in mesh.polygons:
        poly.use_smooth=True
        for li in poly.loop_indices:
            idx=mesh.loops[li].vertex_index;ring,j=divmod(idx,segments)
            uv.data[li].uv=(j/segments,ring/max(1,len(points)-1)*uv_scale)
    parts.append(o);return o

# Footprint and facade match the previous runtime model: 4.8 x 3.95, +Z glTF.
# Blender front is -Y. The actual wall holes give the windows recessed frames.
cube('Deep stone plinth',(0,0,.16),(4.65,3.80,.32),stone,.035)
for x in (-1.80,-.60,.60,1.80):
    cube('Foundation front block',(x,-1.83,.19),(1.15,.18,.33),stone,.025)
cube('Back plaster wall',(0,1.70,1.68),(4.40,.18,2.76),plaster)

def wall_segment(name,start,end,axis,level=(.32,3.05)):
    center=(start+end)/2;height=level[1]-level[0];z=(level[0]+level[1])/2
    if axis=='front':return cube(name,(center,-1.70,z),(end-start,.20,height),plaster,.009)
    x=float(axis)
    return cube(name,(x,center,z),(.20,end-start,height),plaster,.009)

for a,b in [(-2.2,-1.82),(-1.02,-.52),(.52,1.02),(1.82,2.2)]:wall_segment('Facade plaster pier',a,b,'front')
for center in (-1.42,1.42):
    wall_segment('Plaster below window',center-.40,center+.40,'front',(.32,1.18))
    wall_segment('Plaster above window',center-.40,center+.40,'front',(2.28,3.05))
wall_segment('Door lintel wall',-.52,.52,'front',(2.36,3.05))
for side in (-2.10,2.10):
    for a,b in [(-1.7,-1.08),(-.24,.24),(1.08,1.7)]:wall_segment('Side plaster pier',a,b,str(side))
    for cy in (-.66,.66):
        wall_segment('Side wall below glass',cy-.42,cy+.42,str(side),(.32,1.20))
        wall_segment('Side wall above glass',cy-.42,cy+.42,str(side),(2.30,3.05))

# Gable plaster ends, roof underlayers, fascia and visible supports.
verts=[(-2.2,-1.7,3.05),(2.2,-1.7,3.05),(0,-1.7,4.17),(-2.2,1.7,3.05),(2.2,1.7,3.05),(0,1.7,4.17)]
mesh=bpy.data.meshes.new('Plaster gables');mesh.from_pydata(verts,[],[(0,1,2),(5,4,3),(0,3,4,1),(1,4,5,2),(2,5,3,0)]);mesh.materials.append(plaster)
o=bpy.data.objects.new('Closed textured gables',mesh);bpy.context.collection.objects.link(o);uv_world(o);house_parts.append(o)
for side in (-1,1):
    under=cube('Roof underlayer',(side*1.14,0,3.63),(2.56,3.94,.09),metal,.005);under.rotation_euler.y=side*math.radians(25)
    # 64 individually modelled overlapping roof panels with visible seams.
    for row in range(4):
        x=side*(.30+row*.575);z=4.17-abs(x)*math.tan(math.radians(25))+.072
        for col in range(8):
            y=-1.765+col*.505
            panel=cube('Roof panel %d %d %d'%(side,row,col),(x,y,z),(.665,.527,.045),roof,.009)
            panel.rotation_euler.y=side*math.radians(25)
    cube('Outer gutter',(side*2.38,0,3.16),(.10,4.0,.13),copper,.011)
    tube('Gutter downpipe',[(side*2.25,1.65,3.14),(side*2.28,1.71,2.9),(side*2.28,1.71,.5),(side*2.03,1.71,.30)],[.035]*4,copper,8)
    for y in (-1.96,1.96):
        fascia=cube('Sloped end fascia',(side*1.13,y,3.65),(2.63,.10,.13),metal,.01);fascia.rotation_euler.y=side*math.radians(25)
    for y in (-1.44,-.36,.72,1.53):cube('Visible rafter end',(side*2.16,y,3.13),(.24,.12,.12),wood,.012)
cube('Ridgeline cap',(0,0,4.25),(.18,4.08,.11),copper,.015)
cube('Horizontal facade trim',(0,-1.85,3.04),(4.65,.15,.12),metal,.012)

def front_window(x):
    # Dark reveal surrounds an inset single glass face; sill and muntins are geometry.
    cube('Window recessed backing',(x,-1.715,1.73),(.83,.05,1.10),metal,.004)
    cube('Inset amber glass',(x,-1.763,1.73),(.66,.026,.91),glass,.003)
    for sx in (-1,1):cube('Window vertical trim',(x+sx*.405,-1.817,1.73),(.09,.10,1.15),wood,.008)
    for z in (1.18,2.28):cube('Window horizontal trim',(x,-1.817,z),(.90,.10,.09),wood,.008)
    cube('Window mullion',(x,-1.80,1.73),(.035,.035,.94),metal,.004)
    cube('Window crossbar',(x,-1.80,1.73),(.68,.035,.035),metal,.004)
    cube('Weathered projecting sill',(x,-1.90,1.11),(.99,.39,.13),stone,.025)
    cube('Small window hood',(x,-1.92,2.37),(.99,.37,.07),metal,.010)
for x in (-1.42,1.42):front_window(x)
for side in (-1,1):
    for cy in (-.66,.66):
        x=side*2.125
        cube('Side window inset',(x,cy,1.75),(.04,.70,.94),glass,.003)
        for y in (cy-.42,cy+.42):cube('Side frame upright',(side*2.22,y,1.75),(.11,.08,1.14),wood,.006)
        for z in (1.2,2.3):cube('Side frame crosspiece',(side*2.22,cy,z),(.11,.92,.08),wood,.006)
        cube('Side window sill',(side*2.29,cy,1.12),(.35,1.0,.12),stone,.02)
        cube('Side glazing crossbar',(side*2.16,cy,1.75),(.03,.70,.03),metal,.003)

# Door panels, bronze handle, control screen and individual stair treads.
cube('Heavy door recessed frame',(0,-1.73,1.30),(1.03,.13,2.10),metal,.01)
for i in range(5):cube('Hardwood door plank',(-.38+i*.19,-1.812,1.30),(.182,.045,1.91),wood,.004)
for z in (.61,1.10,1.99):cube('Door steel strap',(0,-1.85,z),(.86,.022,.065),metal,.004)
tube('Bronze handle',[(.30,-1.86,1.30),(.30,-1.92,1.30),(.30,-1.92,1.44),(.30,-1.86,1.44)],[.013]*4,copper,8)
cube('Door control casing',(.76,-1.83,1.55),(.26,.11,.45),metal,.020)
cube('Controller cyan screen',(.76,-1.895,1.63),(.19,.018,.19),screen,.005)
for dx in (-.05,.05):cube('Controller button',(.76+dx,-1.90,1.43),(.028,.019,.028),copper,.004)
for i in range(3):
    y=-1.95-i*.22;height=.31-i*.08
    cube('Stair tread',(0,y,height/2),(1.40,.40,height),stone,.022)
    cube('Step bronze edge',(0,y-.205,height),(.98,.026,.025),copper,.004)
cube('Door rain shelter',(0,-2.01,2.48),(1.30,.62,.11),metal,.016)
for s in (-1,1):tube('Canopy bracket',[(s*.55,-1.81,2.11),(s*.55,-2.16,2.42)],[.018,.018],copper,8)

# A real colony utility assembly on the rear side, with pipes/cable loops.
cube('Exterior utility housing',(-1.18,1.90,1.14),(1.05,.40,.75),metal,.035)
cube('Utility access panel',(-1.18,2.118,1.14),(.83,.027,.57),roof,.009)
for i in range(6):cube('Vent louvre',(-1.18,2.143,.99+i*.055),(.63,.023,.017),copper,.002)
for x in (-1.55,-.80):tube('Power conduit',[(x,1.92,.76),(x,1.92,.40),(x+.16,1.80,.25)],[.025]*3,copper,8)
tube('Roof cable run',[(-1.69,1.83,1.48),(-1.69,1.83,2.57),(-1.62,1.79,2.93),(-1.31,1.68,3.36)],[.016]*4,metal,7)
tube('Tall exhaust stack',[(1.35,.94,3.52),(1.35,.94,4.51)],[.105,.105],metal,12)
cube('Exhaust cap',(1.35,.94,4.53),(.38,.38,.06),copper,.01)
for z in (3.82,4.14):cube('Exhaust clamp',(1.35,.94,z),(.25,.25,.05),roof,.006)
tube('Antenna mast',[(-1.40,1.02,3.72),(-1.40,1.02,4.72)],[.018,.018],metal,8)
for z,w in [(4.44,.55),(4.58,.79),(4.72,.95)]:cube('Antenna cross-element',(-1.40,1.02,z),(w,.028,.026),metal,.003)

# Chips at base/corners are actual aggregate geometry in addition to PBR pores.
random.seed(920)
for i in range(17):
    x=random.uniform(-2.12,2.12);z=random.uniform(.34,.65)
    o=cube('Exposed aggregate chip',(x,-1.811,z),(random.uniform(.035,.09),.016,random.uniform(.025,.06)),stone,.003)
    o.rotation_euler.y=random.uniform(-.6,.6)

def joined_export(name,parts):
    bpy.ops.object.select_all(action='DESELECT')
    for o in parts:o.select_set(True)
    bpy.context.view_layer.objects.active=parts[0];bpy.ops.object.join();o=bpy.context.object;o.name=name
    # One mesh with one primitive for each material, enabling actual batching.
    bpy.ops.object.transform_apply(location=True,rotation=True,scale=True)
    bpy.ops.export_scene.gltf(filepath=str(OUT/(name+'.glb')),export_format='GLB',use_selection=True,export_yup=True,export_image_format='AUTO')
    return o

house=joined_export('house',house_parts)

# Organic tree: curving trunk/root tubes, branching twigs and individual leaves.
tree_parts=[]
main=[(0,0,0),(.025,.006,.65),(-.035,.025,1.3),(.025,-.008,2.0),(.055,.015,2.7),(-.02,.035,3.40),(.035,.05,4.1)]
tube('Curving ridged trunk',main,[.235,.205,.173,.142,.11,.077,.028],bark,12,tree_parts,3.5)
for i in range(5):
    a=i*math.tau/5
    tube('Buttress root',[(0,0,.32),(.25*math.cos(a),.25*math.sin(a),.12),(.58*math.cos(a),.58*math.sin(a),.02)],[.11,.070,.014],bark,8,tree_parts,1.4)
clusters=[]
random.seed(771)
for i in range(9):
    a=i*math.tau/9+.2;start=(.02,0,2.02+i*.18)
    center=(math.cos(a)*(1.0 if i<6 else .72),math.sin(a)*(.86 if i<6 else .62),3.25+i*.16)
    midpoint=(center[0]*.51,center[1]*.45,center[2]-.29)
    tube('Major branch',[start,midpoint,center],[.075-i*.004,.040,.017],bark,8,tree_parts,1.8)
    for j in range(2):
        delta=(random.uniform(-.30,.30),random.uniform(-.28,.28),random.uniform(.20,.44))
        end=tuple(center[k]+delta[k] for k in range(3))
        tube('Leaf twig',[midpoint,center,end],[.024,.017,.0045],bark,6,tree_parts,1)
    clusters.append(center)
clusters.extend([(0,0,4.75),(.22,-.12,4.18)])
verts=[];faces=[];colors=[]
random.seed(67122)
for i in range(430):
    center=Vector(clusters[i%len(clusters)])
    # Thin leaves populate a volume; the canopy is not a faceted solid shell.
    direction=Vector((random.uniform(-1,1),random.uniform(-1,1),random.uniform(-.7,1))).normalized()
    pos=center+direction*random.uniform(.10,.73)
    pos.z=min(pos.z,5.02)
    length=random.uniform(.20,.33);width=length*random.uniform(.43,.61)
    normal=Vector((random.uniform(-.6,.6),random.uniform(-.6,.6),random.uniform(.40,1))).normalized()
    axis=Vector((random.uniform(-1,1),random.uniform(-1,1),random.uniform(-.25,.25))).normalized()
    side=axis.cross(normal).normalized();axis=normal.cross(side).normalized()
    # Six vertices / six triangles: pointed leaf, raised midrib and curled edges.
    local=[(0,-.50,0),(-.46,-.12,-.025),(-.31,.29,-.020),(0,.50,0),(.38,.23,-.019),(.44,-.18,-.026),(0,.04,.038)]
    index=len(verts)
    shade=random.uniform(.65,1.15);color=(.105*shade,.245*shade,.065*shade,1)
    for x,y,z in local:verts.append(pos+side*(x*width)+axis*(y*length)+normal*z);colors.append(color)
    for j in range(6):faces.append((index+j,index+(j+1)%6,index+6))
mesh=bpy.data.meshes.new('Individual curved leaf mesh');mesh.from_pydata(verts,[],faces);mesh.materials.append(leaves)
col=mesh.color_attributes.new(name='Foliage color',type='FLOAT_COLOR',domain='POINT')
for i,color in enumerate(colors):col.data[i].color=color
o=bpy.data.objects.new('430 individual leaves',mesh);bpy.context.collection.objects.link(o);tree_parts.append(o)
tree=joined_export('tree',tree_parts)

# Add fine original cloth normals to existing hero materials without changing
# its skeleton, mesh data or animation tracks. Rebuilding this is idempotent.
def upgrade_hero():
    path=OUT/'hero.glb'
    raw=path.read_bytes();length=struct.unpack_from('<I',raw,12)[0];doc=json.loads(raw[20:20+length]);offset=20+length
    binary=bytearray(raw[offset+8:offset+8+struct.unpack_from('<I',raw,offset)[0]])
    if doc.get('extras',{}).get('colonyGraphicsClothNormal'):
        return
    normal=(SOURCE/'cloth-normal.png').read_bytes();binary+=b'\0'*(-len(binary)%4)
    view=len(doc['bufferViews']);doc['bufferViews'].append({'buffer':0,'byteOffset':len(binary),'byteLength':len(normal)})
    binary+=normal;im=len(doc.setdefault('images',[]));doc['images'].append({'name':'Original woven expedition fabric','mimeType':'image/png','bufferView':view})
    texture=len(doc.setdefault('textures',[]));doc['textures'].append({'source':im})
    for m in doc['materials']:
        name=m.get('name','')
        if 'expedition suit' in name.lower() or 'boots and gloves' in name.lower():
            m['normalTexture']={'index':texture,'scale':.28,'extensions':{'KHR_texture_transform':{'scale':[12,12]}}}
            m.setdefault('pbrMetallicRoughness',{})['roughnessFactor']=.76 if 'suit' in name.lower() else .58
        elif 'ceramic armor' in name.lower():
            m.setdefault('pbrMetallicRoughness',{}).update({'roughnessFactor':.49,'metallicFactor':.13})
    doc.setdefault('extensionsUsed',[])
    if 'KHR_texture_transform' not in doc['extensionsUsed']:doc['extensionsUsed'].append('KHR_texture_transform')
    doc.setdefault('extras',{})['colonyGraphicsClothNormal']=True
    doc['buffers']=[{'byteLength':len(binary)}]
    js=json.dumps(doc,separators=(',',':')).encode();js+=b' '*(-len(js)%4);binary+=b'\0'*(-len(binary)%4)
    path.write_bytes(struct.pack('<III',0x46546C67,2,12+8+len(js)+8+len(binary))+struct.pack('<II',len(js),0x4E4F534A)+js+struct.pack('<II',len(binary),0x004E4942)+binary)
# Hero animation and material ownership remains with the scene integration task.
# The optional upgrade helper is retained as editable source but is not invoked.

# Independent final-GLB preview, with geometry and PBR textures imported anew.
bpy.ops.wm.read_factory_settings(use_empty=True)
for name,x in [('house',2.1),('tree',-2.25)]:
    bpy.ops.import_scene.gltf(filepath=str(OUT/(name+'.glb')))
    for o in bpy.context.selected_objects:
        if o.parent is None:o.location.x+=x
floor=mat('Dark mineral ground',(.105,.135,.12),.85)
bpy.ops.mesh.primitive_plane_add(size=200);bpy.context.object.data.materials.append(floor)
world=bpy.data.worlds.new('Neutral studio sky');world.use_nodes=True;bpy.context.scene.world=world
world.node_tree.nodes['Background'].inputs[0].default_value=(.34,.43,.50,1);world.node_tree.nodes['Background'].inputs[1].default_value=.45
for pos,energy,size in [((1,-5,8),1400,7),((-5,-1,6),900,5),((4,6,8),1700,6)]:
    bpy.ops.object.light_add(type='AREA',location=pos);o=bpy.context.object;o.data.energy=energy;o.data.size=size
    o.rotation_euler=(Vector((0,0,2))-o.location).to_track_quat('-Z','Y').to_euler()
bpy.ops.object.camera_add(location=(10,-15,9));cam=bpy.context.object;cam.data.type='ORTHO';cam.data.ortho_scale=11.3
cam.rotation_euler=(Vector((0,0,2.10))-cam.location).to_track_quat('-Z','Y').to_euler();bpy.context.scene.camera=cam
bpy.context.scene.render.engine='CYCLES';bpy.context.scene.cycles.samples=40
bpy.context.scene.render.resolution_x=1600;bpy.context.scene.render.resolution_y=1100;bpy.context.scene.render.resolution_percentage=100
bpy.context.scene.render.filepath=str(ART/'colony-detailed-preview.png');bpy.ops.render.render(write_still=True)
cam.location=(6.8,-8.8,5.2);cam.rotation_euler=(Vector((2.1,-.15,2.0))-cam.location).to_track_quat('-Z','Y').to_euler();cam.data.ortho_scale=6.1
bpy.context.scene.render.resolution_x=1400;bpy.context.scene.render.resolution_y=1200
bpy.context.scene.render.filepath=str(ART/'house-detail-preview.png');bpy.ops.render.render(write_still=True)
bpy.ops.wm.save_as_mainfile(filepath=str(ROOT/'source-art/colony-detailed.blend'))
print('DETAILED_GRAPHICS_READY',OUT)
