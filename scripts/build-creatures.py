"""Original stylized colony fauna, created in Blender without external assets.

blender --background --python scripts/build-creatures.py
"""
from pathlib import Path
import math
import bpy
from mathutils import Vector

ROOT=Path(__file__).resolve().parents[1]
OUT=ROOT/'public/assets'
OUT.mkdir(parents=True,exist_ok=True)
bpy.ops.wm.read_factory_settings(use_empty=True)
bpy.context.scene.render.fps=30

def material(name,rgb,roughness=.7,metallic=0):
    m=bpy.data.materials.new(name);m.diffuse_color=(*rgb,1);m.use_nodes=True
    n=m.node_tree.nodes.get('Principled BSDF');n.inputs['Base Color'].default_value=(*rgb,1)
    n.inputs['Roughness'].default_value=roughness;n.inputs['Metallic'].default_value=metallic
    return m

ivory=material('Warm ivory feathers',(.65,.58,.43));white=material('Light feather tips',(.82,.75,.57))
orange=material('Ochre beak and feet',(.63,.31,.065));red=material('Red comb',(.53,.055,.028))
eye=material('Polished black eyes',(.006,.010,.009),.18)
fur=material('Warm gray rat fur',(.25,.24,.20));belly=material('Pale rat belly',(.45,.41,.31))
pink=material('Muted rose skin',(.40,.23,.21));nose=material('Dark pink nose',(.23,.085,.065),.4)
armor=material('Scorpion bronze chitin',(.24,.20,.11),.46,.12)
chitin=material('Scorpion dark joints',(.115,.13,.095),.58)
edge=material('Scorpion armor ridges',(.38,.31,.16),.48,.10)
tip=material('Scorpion black stinger',(.025,.041,.033),.26,.14)

class Creature:
    def __init__(self,name,bones):
        self.name=name;self.parts=[]
        arm=bpy.data.armatures.new(name+' skeleton');self.rig=bpy.data.objects.new(name+' rig',arm)
        bpy.context.collection.objects.link(self.rig);bpy.context.view_layer.objects.active=self.rig;self.rig.select_set(True)
        bpy.ops.object.mode_set(mode='EDIT')
        for name,head,tail,parent in bones:
            b=arm.edit_bones.new(name);b.head=head;b.tail=tail
            if parent:b.parent=arm.edit_bones[parent]
        bpy.ops.object.mode_set(mode='OBJECT');self.rig.select_set(False)
    def bind(self,o,name,bone,mat):
        o.name=name;o.data.materials.append(mat)
        group=o.vertex_groups.new(name=bone);group.add(list(range(len(o.data.vertices))),1,'REPLACE')
        mod=o.modifiers.new('Creature skin','ARMATURE');mod.object=self.rig
        self.parts.append(o);return o
    def sphere(self,name,loc,scale,mat,bone='Body',segments=12,rings=8):
        bpy.ops.mesh.primitive_uv_sphere_add(segments=segments,ring_count=rings,radius=1,location=loc)
        o=bpy.context.object;o.scale=scale;bpy.ops.object.transform_apply(location=False,rotation=False,scale=True)
        for p in o.data.polygons:p.use_smooth=True
        return self.bind(o,name,bone,mat)
    def segment(self,name,a,b,radius,mat,bone='Body',end_radius=None,vertices=8):
        a,b=Vector(a),Vector(b);mid=(a+b)/2
        bpy.ops.mesh.primitive_cone_add(vertices=vertices,radius1=radius,radius2=radius if end_radius is None else end_radius,depth=(b-a).length,location=mid)
        o=bpy.context.object;o.rotation_euler=(b-a).to_track_quat('Z','Y').to_euler()
        return self.bind(o,name,bone,mat)
    def box(self,name,loc,size,mat,bone='Body'):
        bpy.ops.mesh.primitive_cube_add(size=1,location=loc);o=bpy.context.object;o.dimensions=size
        bpy.ops.object.transform_apply(location=False,rotation=False,scale=True)
        return self.bind(o,name,bone,mat)
    def finish(self,style):
        bpy.ops.object.select_all(action='DESELECT')
        for o in self.parts:o.select_set(True)
        bpy.context.view_layer.objects.active=self.parts[0];bpy.ops.object.join()
        self.mesh=bpy.context.object;self.mesh.name=self.name+' skinned mesh';self.mesh.parent=self.rig
        self.mesh.matrix_parent_inverse=self.rig.matrix_world.inverted()
        self.animate(style)
        bpy.ops.object.select_all(action='DESELECT');self.rig.select_set(True);self.mesh.select_set(True)
        bpy.ops.export_scene.gltf(filepath=str(OUT/(self.name+'.glb')),export_format='GLB',use_selection=True,export_yup=True,export_animation_mode='NLA_TRACKS',export_frame_range=False)
        for t in self.rig.animation_data.nla_tracks:t.mute=True
    def animate(self,style):
        self.rig.animation_data_create()
        for clip,length in [('Idle',60),('Walk',30),('Attack',24)]:
            action=bpy.data.actions.new(self.name+' '+clip);self.rig.animation_data.action=action
            for frame in range(0,length+1,3):
                phase=frame/length*math.tau
                for bone in self.rig.pose.bones:bone.rotation_mode='XYZ';bone.rotation_euler=(0,0,0);bone.location=(0,0,0)
                body=self.rig.pose.bones['Body'];head=self.rig.pose.bones.get('Head')
                if clip=='Idle':
                    body.location.y=.007*math.sin(phase)
                    if head:head.rotation_euler.z=.07*math.sin(phase);head.rotation_euler.x=.035*math.cos(phase)
                    for bn in self.rig.pose.bones:
                        if bn.name.startswith('Tail'):bn.rotation_euler.y=.07*math.sin(phase+int(bn.name[-1])*.5)
                        if bn.name.startswith('Wing'):bn.rotation_euler.z=.035*math.sin(phase)
                elif clip=='Walk':
                    body.location.y=.022*abs(math.sin(phase));body.rotation_euler.z=.025*math.sin(phase)
                    for i,bn in enumerate([b for b in self.rig.pose.bones if b.name.startswith('Leg')]):
                        offset=math.pi*(i%2);bn.rotation_euler.x=.34*math.sin(phase+offset)
                    for bn in self.rig.pose.bones:
                        if bn.name.startswith('Tail'):bn.rotation_euler.y=.10*math.sin(phase+int(bn.name[-1])*.5)
                else:
                    impulse=math.sin(frame/length*math.pi)
                    if style=='chicken':
                        body.rotation_euler.x=.22*impulse
                        head.rotation_euler.x=.65*impulse
                        self.rig.pose.bones['WingL'].rotation_euler.y=-.45*impulse
                        self.rig.pose.bones['WingR'].rotation_euler.y=.45*impulse
                    elif style=='rat':
                        body.rotation_euler.x=-.13*impulse;head.rotation_euler.x=.35*impulse
                        body.location.y=.045*impulse
                    else:
                        self.rig.pose.bones['ClawL'].rotation_euler.z=.20*impulse
                        self.rig.pose.bones['ClawR'].rotation_euler.z=-.20*impulse
                        for bn in self.rig.pose.bones:
                            if bn.name.startswith('Tail'):bn.rotation_euler.x=-.33*impulse
                for bone in self.rig.pose.bones:
                    bone.keyframe_insert(data_path='rotation_euler',frame=frame)
                    bone.keyframe_insert(data_path='location',frame=frame)
            track=self.rig.animation_data.nla_tracks.new();track.name=clip
            strip=track.strips.new(clip,0,action);strip.name=clip
            track.mute=True;self.rig.animation_data.action=None
        for bone in self.rig.pose.bones:bone.rotation_euler=(0,0,0);bone.location=(0,0,0)

chicken=Creature('chicken',[
    ('Root',(0,0,0),(0,0,.1),None),('Body',(0,0,.36),(0,0,.59),'Root'),
    ('Head',(0,-.17,.56),(0,-.19,.76),'Body'),('WingL',(-.19,0,.43),(-.32,0,.43),'Body'),('WingR',(.19,0,.43),(.32,0,.43),'Body'),
    ('LegL',(-.09,0,.28),(-.09,0,.05),'Root'),('LegR',(.09,0,.28),(.09,0,.05),'Root')])
chicken.sphere('Round feathered body',(0,.04,.42),(.225,.29,.25),ivory)
chicken.sphere('Breast',(0,-.145,.43),(.18,.18,.215),white)
chicken.sphere('Neck',(0,-.16,.59),(.09,.10,.15),ivory,'Head')
chicken.sphere('Head',(0,-.205,.70),(.115,.12,.12),white,'Head')
chicken.segment('Pointed beak',(0,-.30,.69),(0,-.445,.66),.064,orange,'Head',0,8)
chicken.sphere('Wattle',(0,-.285,.60),(.042,.041,.064),red,'Head',8,6)
for i in range(4):chicken.sphere('Comb lobe',(0,-.255+i*.052,.825+i*.003),(.034,.045,.060),red,'Head',8,6)
for sign,bone in [(-1,'WingL'),(1,'WingR')]:
    wing=chicken.sphere('Feathered wing',(sign*.21,.07,.44),(.065,.24,.15),ivory,bone);wing.rotation_euler.z=sign*.15
    for j in range(3):chicken.sphere('Flight feather',(sign*(.225+j*.012),.19+j*.025,.42-j*.04),(.026,.14,.034),white,bone,8,6)
    chicken.sphere('Black eye',(sign*.096,-.261,.724),(.018,.023,.024),eye,'Head',8,6)
    chicken.segment('Shin',(sign*.09,0,.27),(sign*.09,-.014,.065),.026,orange,'LegL' if sign<0 else 'LegR',.019)
    for j in (-1,0,1):chicken.segment('Three-toed foot',(sign*.09,-.01,.049),(sign*.09+j*.060,-.155,.038),.011,orange,'LegL' if sign<0 else 'LegR',.006,6)
for i in range(3):
    o=chicken.sphere('Tail feather',((i-1)*.075,.32,.51),(.044,.17,.065),white,segments=8,rings=6);o.rotation_euler.x=.6
chicken.finish('chicken')

rat=Creature('rat',[
    ('Root',(0,0,0),(0,0,.1),None),('Body',(0,0,.20),(0,0,.38),'Root'),('Head',(0,-.31,.23),(0,-.31,.39),'Body'),
    ('LegFL',(-.12,-.20,.19),(-.12,-.20,.055),'Root'),('LegFR',(.12,-.20,.19),(.12,-.20,.055),'Root'),
    ('LegBL',(-.15,.24,.20),(-.15,.24,.055),'Root'),('LegBR',(.15,.24,.20),(.15,.24,.055),'Root'),
    ('Tail0',(0,.34,.15),(0,.53,.09),'Body'),('Tail1',(0,.53,.09),(.17,.75,.06),'Tail0'),('Tail2',(.17,.75,.06),(.39,.99,.05),'Tail1')])
rat.sphere('Rat body',(0,.04,.23),(.21,.38,.20),fur)
rat.sphere('Pale underside',(0,-.04,.105),(.165,.30,.075),belly)
rat.sphere('Rat head',(0,-.32,.25),(.16,.20,.14),fur,'Head')
rat.segment('Tapered snout',(0,-.39,.26),(0,-.64,.19),.105,fur,'Head',.030,12)
rat.sphere('Pink nose',(0,-.653,.195),(.040,.024,.029),nose,'Head',8,6)
for s in (-1,1):
    rat.sphere('Round ear',(s*.125,-.31,.423),(.084,.039,.090),fur,'Head')
    rat.sphere('Inner ear',(s*.125,-.345,.425),(.061,.011,.064),pink,'Head')
    rat.sphere('Black eye',(s*.119,-.438,.32),(.027,.029,.029),eye,'Head',8,6)
    for j in range(3):rat.segment('Whisker',(s*.044,-.588,.222),(s*(.22+j*.03),-.56-j*.065,.22+j*.027),.0035,belly,'Head',.0017,5)
    rat.box('Incisor',(s*.018,-.598,.15),(.016,.040,.037),white,'Head')
    for label,y,x in [('F',-.20,.13),('B',.235,.15)]:
        bn='Leg'+label+('L' if s<0 else 'R')
        rat.sphere('Haunch',(s*x,y,.155),(.095,.115,.11),fur,bn)
        rat.segment('Lower leg',(s*x,y,.17),(s*x,y-.025,.048),.027,pink,bn,.018)
        rat.sphere('Rat foot',(s*x,y-.071,.032),(.040,.080,.025),pink,bn,8,6)
        for j in (-1,0,1):rat.segment('Rat toe',(s*x+j*.02,y-.1,.025),(s*x+j*.021,y-.165,.023),.005,pink,bn,.003,5)
tail=[(0,.34,.15),(.01,.46,.10),(.08,.62,.065),(.19,.77,.05),(.34,.88,.05),(.44,1.03,.05)]
for i in range(len(tail)-1):rat.segment('Segmented tail',tail[i],tail[i+1],.027-i*.004,pink,'Tail'+str(min(2,i//2)),.023-i*.004,8)
rat.finish('rat')

bones=[('Root',(0,0,0),(0,0,.1),None),('Body',(0,0,.20),(0,0,.36),'Root'),
       ('ClawL',(-.21,-.23,.23),(-.31,-.48,.23),'Body'),('ClawR',(.21,-.23,.23),(.31,-.48,.23),'Body'),
       ('Tail0',(0,.30,.22),(0,.49,.43),'Body'),('Tail1',(0,.49,.43),(0,.48,.71),'Tail0'),
       ('Tail2',(0,.48,.71),(0,.29,.95),'Tail1'),('Tail3',(0,.29,.95),(0,.07,.94),'Tail2')]
for i in range(4):
    for s,label in [(-1,'L'),(1,'R')]:bones.append(('Leg'+label+str(i),(s*.18,-.20+i*.145,.21),(s*.48,-.26+i*.185,.10),'Root'))
scorpion=Creature('scorpion',bones)
scorpion.sphere('Armored head',(0,-.18,.24),(.25,.23,.15),armor)
scorpion.sphere('Abdomen core',(0,.17,.23),(.20,.32,.13),chitin)
for i in range(5):scorpion.sphere('Abdomen armor plate',(0,.015+i*.075,.27),(.215-i*.014,.06,.13-i*.009),armor)
for s in (-1,1):
    for j in range(3):scorpion.sphere('Small black eye',(s*(.05+j*.042),-.355,.29+j*.007),(.013,.015,.013),eye,segments=8,rings=6)
    claw='ClawL' if s<0 else 'ClawR'
    scorpion.segment('Claw arm',(s*.20,-.25,.23),(s*.37,-.43,.20),.05,chitin,claw,.040)
    scorpion.segment('Claw forearm',(s*.37,-.43,.20),(s*.36,-.65,.24),.06,armor,claw,.08)
    scorpion.sphere('Claw palm',(s*.35,-.70,.245),(.11,.12,.083),armor,claw)
    scorpion.segment('Outer claw finger',(s*.41,-.75,.25),(s*.405,-.92,.25),.041,edge,claw,.018)
    scorpion.segment('Outer claw hook',(s*.405,-.92,.25),(s*.34,-.965,.25),.018,tip,claw,.003)
    scorpion.segment('Inner claw finger',(s*.285,-.75,.25),(s*.275,-.875,.25),.032,armor,claw,.011)
    scorpion.segment('Inner claw hook',(s*.275,-.875,.25),(s*.325,-.93,.25),.011,tip,claw,.003)
    for i in range(4):
        bn='Leg'+('L' if s<0 else 'R')+str(i);y=-.20+i*.145
        knee=(s*(.46+abs(i-1.5)*.045),y+(i-1.5)*.06,.17)
        foot=(s*(.64+abs(i-1.5)*.055),y+(i-1.5)*.16,.028)
        scorpion.segment('Leg upper',(s*.18,y,.22),knee,.035,chitin,bn,.025)
        scorpion.segment('Leg lower',knee,foot,.025,armor,bn,.009)
tail=[(0,.32,.23),(0,.44,.36),(0,.51,.54),(0,.47,.75),(0,.32,.94),(0,.13,1.00),(0,-.01,.91)]
for i in range(len(tail)-1):
    bn='Tail'+str(min(3,i//2))
    scorpion.segment('Tail armor segment',tail[i],tail[i+1],.093-i*.008,armor,bn,.082-i*.008,10)
    scorpion.sphere('Tail joint',tail[i+1],(.068-i*.005,.073-i*.005,.070-i*.005),chitin,bn,10,6)
scorpion.sphere('Venom bulb',(0,-.035,.915),(.073,.080,.073),edge,'Tail3')
scorpion.segment('Curved venom stinger',(0,-.09,.91),(0,-.16,.80),.037,tip,'Tail3',.006,8)
scorpion.finish('scorpion')

# Measured preview of final exported files. Load them afresh so the screenshot
# includes the actual GLB skinning and native animation data used by the game.
bpy.ops.wm.read_factory_settings(use_empty=True)
creatures=[]
for name,x in [('chicken',-1.5),('rat',0),('scorpion',1.55)]:
    before=set(bpy.data.actions);bpy.ops.import_scene.gltf(filepath=str(OUT/(name+'.glb')))
    rig=next(o for o in bpy.context.selected_objects if o.type=='ARMATURE');rig.location.x=x;rig.rotation_euler.z=-.10
    for track in rig.animation_data.nla_tracks:track.mute=True
    idle=next(a for a in set(bpy.data.actions)-before if 'Idle' in a.name)
    rig.animation_data.action=idle
    if idle.slots:rig.animation_data.action_slot=idle.slots[0]
    creatures.append(rig)
bpy.context.scene.frame_set(12)
floor=material('Neutral colony ground',(.12,.16,.145))
bpy.ops.mesh.primitive_plane_add(size=200);bpy.context.object.data.materials.append(floor)
bpy.context.scene.render.engine='CYCLES';bpy.context.scene.cycles.samples=32
bpy.context.scene.render.resolution_x=1400;bpy.context.scene.render.resolution_y=850;bpy.context.scene.render.resolution_percentage=100
world=bpy.data.worlds.new('Studio sky');world.use_nodes=True;bpy.context.scene.world=world
world.node_tree.nodes['Background'].inputs[0].default_value=(.34,.43,.48,1);world.node_tree.nodes['Background'].inputs[1].default_value=.5
for loc,energy,size in [((1,-4,6),900,5),((-4,-1,4),650,4),((2,4,5),1100,4)]:
    bpy.ops.object.light_add(type='AREA',location=loc);o=bpy.context.object;o.data.energy=energy;o.data.size=size
    o.rotation_euler=(Vector((0,0,.4))-o.location).to_track_quat('-Z','Y').to_euler()
bpy.ops.object.camera_add(location=(3,-7,4.2));cam=bpy.context.object;cam.data.type='ORTHO';cam.data.ortho_scale=5.5
cam.rotation_euler=(Vector((0,.05,.42))-cam.location).to_track_quat('-Z','Y').to_euler();bpy.context.scene.camera=cam
bpy.context.scene.render.filepath=str(OUT/'creatures-preview.png');bpy.ops.render.render(write_still=True)
(ROOT/'source-art').mkdir(exist_ok=True)
bpy.ops.wm.save_as_mainfile(filepath=str(ROOT/'source-art/creatures.blend'))
print('CREATURES_READY chicken rat scorpion')
