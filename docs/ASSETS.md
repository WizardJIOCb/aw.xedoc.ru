# Prototype 3D assets

The browser loads self-contained GLBs from `/assets/`. Coordinates are glTF
Y-up, in metres. These are assets for the current playable concept, not a
reconstruction of the original AWPlanet art library.

| File        | Contents                                                                                                     | Geometry                                              | Size            |
| ----------- | ------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------- | --------------- |
| `hero.glb`  | Human colony explorer, expedition suit, gloves, boots, ceramic vest, field backpack                          | 25,020 triangles; 8 skinned meshes; one 65-joint skin | 4,932,552 bytes |
| `drone.glb` | Animated Quaternius Eye Drone                                                                                | 3,530 triangles; one 8-joint skin                     | 1,334,536 bytes |
| `house.glb` | Detailed original colony building with plaster PBR, recessed windows, separate roofing panels, services     | 9,696 triangles; 8 material primitives                | 1,925,924 bytes |
| `tree.glb`  | Original curved branching tree with bark PBR and 430 individual leaves                                       | 3,936 triangles; 2 material primitives                | 558,804 bytes   |
| `npc-bob.glb` | Colony worker with original sculpted gray beard, hair and forehead goggles                               | 26,508 triangles; one 65-joint skin                   | 5,275,440 bytes |

`asset-manifest.json` records the generated files' structural measurements.
`source-art/colony-assets.blend` preserves the editable Blender scene, lighting and
garment meshes. `preview.png` is a Blender Cycles render inspected after build.

## Hero rig and animation

Base: the **free standard** Quaternius Universal Base Characters Kit,
`Superhero_Male_FullBody.gltf` from the existing local asset library:

`C:\Projects\animegame.ru\public\assets\models\quaternius-characters\`

The supplied base has a proper humanoid mesh, face, UVs and 65-joint skeleton;
it contains no animation itself. Its source `License_Standard.txt` explicitly
dedicates the standard kit to **CC0 1.0 Universal**. The copied licence is
`public/assets/licenses/quaternius-characters.txt`.

Animation source: Quaternius Universal Animation Library's
`UAL1_Standard.glb`, from:

`C:\Projects\animegame.ru\public\assets\animations\quaternius-universal\`

Its `LICENSE.txt` states CC0 1.0 Universal; copied as
`public/assets/licenses/quaternius-animations.txt`.

The animation and character rigs share bone names but have different rest
proportions. `SkeletonUtils.retargetClip` retargets each selected clip at 30
samples per second before the clip is embedded and baked in Blender.
Locomotion pelvis X/Z travel is removed, so movement is owned by the game
controller. Clothing duplicates selected body surfaces with an outward offset
and retains the original normalized vertex weights. The backpack is attached
to a spine bone and moves with the character.

| Game clip  | Source animation | Exported duration |
| ---------- | ---------------- | ----------------- |
| `Idle`     | `Idle_Loop`      | 2.542 s           |
| `Walk`     | `Walk_Loop`      | 1.375 s           |
| `Run`      | `Jog_Fwd_Loop`   | 0.958 s           |
| `Sprint`   | `Sprint_Loop`    | 0.708 s           |
| `Attack`   | `Sword_Attack`   | 1.542 s           |
| `Shoot`    | `Pistol_Shoot`   | 0.667 s           |
| `Hit`      | `Hit_Chest`      | 0.375 s           |
| `Death`    | `Death01`        | 2.417 s           |
| `Interact` | `Interact`       | 2.042 s           |

Loop Idle/Walk/Run/Sprint. Play Attack/Shoot/Hit/Death/Interact once; set
`clampWhenFinished` for Death. The exported durations include the Blender NLA
end frame. `Attack` provides a melee swing; the game supplies the weapon model.

At unit scale the hero is approximately 1.82 m tall, faces **+Z**, and has feet
very close to Y=0. Character clones must use `SkeletonUtils.clone` so separate
players do not share a skeleton. Use an `AnimationMixer` rooted at the loaded
scene and select clips by these exact names.

## Drone

Source: the **free standard** Quaternius Sci-Fi Essentials Kit,
`Enemy_EyeDrone.gltf` in:

`C:\Projects\animegame.ru\public\assets\models\quaternius-scifi\`

Its `LICENSE.txt` explicitly states CC0 1.0 Universal; copied as
`public/assets/licenses/quaternius-scifi.txt`. The source eight-bone rig and
native clips are retained: `Attack`, `BackFlip`, `Charging`, `Hit`, `Idle`,
`Look`. Place the drone above ground with a controller-owned hover height.
Native mesh orientation is preserved; check rotation against the scene's
desired attack direction.

Hero and drone retained colour maps are embedded in their GLBs. Their large
source normal and ORM maps were omitted for this browser prototype; smooth mesh normals and material
roughness remain. The original local source files were not edited.

## Original props

The props were replaced by the detailed graphics build. Current dimensions,
PBR provenance, measured draw counts, Bob rig checks and reproduction commands
are documented in [GRAPHICS-ASSETS.md](GRAPHICS-ASSETS.md). The description below
records the preserved earlier source scene.

House and tree geometry are authored by `scripts/build-assets.py` using
Blender 5.1. House facade faces **+Z**, footprint is about 4.8 by 3.95 m, roof
ridge is about 4.17 m and antenna reaches about 4.72 m. Its ground-level
origin is centred on the footprint. The tree origin is the trunk base; its
height is about 5.15 m. The current foliage is intentionally low polygon.

No externally sourced foliage textures or building meshes are used.

## Build and checks

```powershell
python .\scripts\build-assets.py
```

Requires the original local library paths above, Node with this project's
Three.js dependency, and:

`C:\Program Files\Blender Foundation\Blender 5.1\blender.exe`

The final hero GLB was loaded with Three.js and each of its nine clips was
sampled at five points. All skinned bounding boxes were finite, with maximum
extent between 1.64 and 2.22 m; no exploded or stretched rig was observed in
that check. Results are retained in `public/assets/animation-check.json`.
The dressed Idle pose, drone and props were also rendered in Blender and
visually inspected. Integration in the browser game is a separate check.

Asset publisher: [Quaternius](https://quaternius.com/).
Source licence: [CC0 1.0 Universal](https://creativecommons.org/publicdomain/zero/1.0/).
