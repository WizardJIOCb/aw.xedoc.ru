import * as THREE from "three";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import { clone } from "three/addons/utils/SkeletonUtils.js";
import type { Entity, Player } from "../shared/types";
import { NavigationGrid, screenRelativeMovement, type Point } from "./navigation";
import { PlanetGraphics } from "./graphics";
import { CanonicalWorld, familyModel } from "./canonical-world";
import { terrainHeight, terrainWalkable, terrainSegmentClear, type CanonicalMapData, type MapDefinition } from "../shared/canonical-map";

type Avatar = {
  root: THREE.Group;
  mixer?: THREE.AnimationMixer;
  actions: Record<string, THREE.AnimationAction>;
  current: string;
  target: THREE.Vector3;
  rotation: number;
  hand?: THREE.Object3D;
  weapon?: THREE.Group;
  equipped?: string | null;
};
const colors = {
  sand: 0xd0c7a8,
  wall: 0xe2ddc6,
  roof: 0x3f5553,
  steel: 0x607575,
  grass: 0x769365,
};
export class PlanetScene {
  scene = new THREE.Scene();
  camera = new THREE.PerspectiveCamera(35, 1, 0.1, 380);
  renderer: THREE.WebGLRenderer;
  player = new THREE.Vector3(0, 0, 8);
  yaw = Math.PI / 4;
  readonly pitch = THREE.MathUtils.degToRad(55);
  distance = 28;
  keys = new Set<string>();
  moving = false;
  focused = true;
  bounds: THREE.Box3[] = [];
  avatars = new Map<string, Avatar>();
  objects = new Map<string, THREE.Group>();
  private destinationPoint?: Point;
  private route: Point[] = [];
  private navigation!: NavigationGrid;
  private destinationMarker!: THREE.Group;
  private pendingEntity?: string;
  private entityPlannedAt = 0;
  private graphics!: PlanetGraphics;
  private readonly clickRay = new THREE.Raycaster();
  get destination(): Point | undefined { return this.destinationPoint; }
  set destination(point: Point | undefined) {
    this.onNavigate?.();
    this.pendingEntity = undefined;
    if (point) this.planDestination(point); else this.clearNavigation();
  }
  entities: Entity[] = [];
  selfId = "";
  model?: THREE.Group;
  clips: THREE.AnimationClip[] = [];
  drone?: THREE.Group;
  droneClips: THREE.AnimationClip[] = [];
  onMove?: (x: number, z: number, rotation: number, running?: boolean) => void;
  onInteract?: () => void;
  onAttack?: () => void;
  onEntityClick?: (entity: Entity) => void;
  onNavigate?: () => void;
  onShortcut?: (key: string) => void;
  last = performance.now();
  sendAt = 0;
  clock = 0;
  quality = "high";
  private dragging = false;
  private pointerStart?: { x: number; y: number; button: number };
  private lastPointer = { x: 0, y: 0 };
  private sun: THREE.DirectionalLight;
  private water!: THREE.Mesh;
  private ready = false;
  private canonical?: CanonicalMapData;
  private canonicalWorld?: CanonicalWorld;
  private mapDefinitions = new Map<number,MapDefinition>();
  private worldNodes: THREE.Object3D[] = [];
  private bob?: {model:THREE.Group;clips:THREE.AnimationClip[]};
  private sceneryTree?:THREE.Group;
  private stamina=100;
  private houses: THREE.Group[] = [];
  private trees: THREE.Group[] = [];
  private entityMixers = new Map<string, THREE.AnimationMixer>();
  private creatures = new Map<
    string,
    { model: THREE.Group; clips: THREE.AnimationClip[] }
  >();
  private creatureActions = new Map<
    string,
    { actions: Record<string, THREE.AnimationAction>; current: string }
  >();
  private frameCount = 0;
  private frameAt = performance.now();
  constructor(public host: HTMLElement, map?: CanonicalMapData) {
    this.canonical=map;
    if(map){this.mapDefinitions=new Map(map.definitions.map(d=>[d.originalId,d]));this.player.set(map.spawn.x,terrainHeight(map,map.spawn.x,map.spawn.z),map.spawn.z);}
    if(map){this.camera.far=110;this.camera.updateProjectionMatrix();}
    this.renderer = new THREE.WebGLRenderer({
      antialias: true,
      powerPreference: "high-performance",
    });
    this.renderer.setPixelRatio(Math.min(devicePixelRatio, 1.75));
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFShadowMap;
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.1;
    host.append(this.renderer.domElement);
    this.renderer.domElement.dataset.viewMode = "isometric";
    this.scene.background = new THREE.Color(0xa8c7c6);
    this.scene.fog = new THREE.FogExp2(0xa8c7c6, 0.0055);
    this.scene.add(new THREE.HemisphereLight(0xdbe9ee, 0x526044, 1.55));
    this.sun = new THREE.DirectionalLight(0xffe3b5, 3.7);
    this.sun.position.set(-30, 55, 24);
    this.sun.castShadow = true;
    this.sun.shadow.mapSize.set(2048, 2048);
    this.sun.shadow.camera.left = -60;
    this.sun.shadow.camera.right = 60;
    this.sun.shadow.camera.top = 60;
    this.sun.shadow.camera.bottom = -60;
    this.sun.shadow.normalBias = 0.03;
    this.sun.shadow.bias = -0.0001;
    this.scene.add(this.sun, this.sun.target);
    const before=new Set(this.scene.children);
    this.buildWorld();
    this.worldNodes=this.scene.children.filter(o=>!before.has(o));
    this.installNavigation();
    this.graphics = new PlanetGraphics(this.renderer, this.scene, this.camera);
    this.destinationMarker = this.makeDestinationMarker();
    this.scene.add(this.destinationMarker);
    this.camera.position.copy(this.player).add(new THREE.Vector3(Math.sin(this.yaw) * Math.cos(this.pitch), Math.sin(this.pitch), Math.cos(this.yaw) * Math.cos(this.pitch)).multiplyScalar(this.distance));
    this.camera.lookAt(this.player);
    this.avatar("preview", this.player.x, this.player.z);
    this.resize();
    window.addEventListener("resize", () => this.resize());
    window.addEventListener("keydown", (e) => {
      if (this.typing()) return;
      const k = e.key.toLowerCase();
      if (!this.focused) {
        if (k === "escape" && !e.repeat) this.onShortcut?.(k);
        return;
      }
      this.keys.add(k);
      if (["w", "a", "s", "d", "ц", "ф", "ы", "в", "arrowup", "arrowdown", "arrowleft", "arrowright"].includes(k) && !e.repeat) {
        this.onNavigate?.();
        this.clearNavigation();
      }
      if ([" ", "arrowup", "arrowdown", "arrowleft", "arrowright"].includes(k))
        e.preventDefault();
      if (!e.repeat) {
        if (k === "e") this.onInteract?.();
        else if (k === " " || k === "1") this.onAttack?.();
        else if (["i", "c", "k", "m", "b", "escape"].includes(k))
          this.onShortcut?.(k);
      }
    });
    window.addEventListener("keyup", (e) =>
      this.keys.delete(e.key.toLowerCase()),
    );
    window.addEventListener("blur", () => {
      this.keys.clear();
      this.dragging = false;
      this.pointerStart = undefined;
    });
    this.renderer.domElement.addEventListener("pointerdown", (e) => {
      if (!this.focused) return;
      this.pointerStart = { x: e.clientX, y: e.clientY, button: e.button };
      this.dragging = e.button === 2;
      this.lastPointer = { x: e.clientX, y: e.clientY };
      if (this.dragging) {
        e.preventDefault();
        this.renderer.domElement.setPointerCapture(e.pointerId);
      }
    });
    this.renderer.domElement.addEventListener("pointermove", (e) => {
      if (this.dragging) {
        this.yaw -= (e.clientX - this.lastPointer.x) * 0.005;
        this.lastPointer = { x: e.clientX, y: e.clientY };
      }
    });
    this.renderer.domElement.addEventListener(
      "pointerup",
      (e) => {
        const click = this.pointerStart;
        this.pointerStart = undefined;
        this.dragging = false;
        if (this.renderer.domElement.hasPointerCapture(e.pointerId)) this.renderer.domElement.releasePointerCapture(e.pointerId);
        if (click?.button === 0 && Math.hypot(e.clientX - click.x, e.clientY - click.y) < 6 && this.ready && this.focused) this.clickDestination(e.clientX, e.clientY);
      },
    );
    this.renderer.domElement.addEventListener("contextmenu", (e) =>
      e.preventDefault(),
    );
    this.renderer.domElement.addEventListener("pointercancel", () => { this.dragging = false; this.pointerStart = undefined; });
    this.renderer.domElement.addEventListener(
      "wheel",
      (e) => {
        this.distance = THREE.MathUtils.clamp(
          this.distance + e.deltaY * 0.015,
          18,
          42,
        );
        e.preventDefault();
      },
      { passive: false },
    );
    new GLTFLoader().load(
      `/assets/hero.glb?v=${__ASSET_VERSION__}`,
      (g) => {
        this.model = g.scene;
        this.clips = g.animations;
        for (const [id, a] of this.avatars) {
          a.root.remove(...a.root.children);
          this.installModel(a, this.model, this.clips);
        }
        this.rebuildEntities();
      },
      undefined,
      () => {},
    );
    new GLTFLoader().load(`/assets/npc-bob.glb?v=${__ASSET_VERSION__}`,(g)=>{this.bob={model:g.scene,clips:g.animations};this.rebuildEntities();},undefined,()=>{});
    new GLTFLoader().load(
      `/assets/drone.glb?v=${__ASSET_VERSION__}`,
      (g) => {
        this.drone = g.scene;
        this.droneClips = g.animations;
        this.rebuildEntities();
      },
      undefined,
      () => {},
    );
    void Promise.all(
      ["chicken", "rat", "scorpion", "deer", "dog", "spider"].map(async (name) => {
        try {
          const g = await new GLTFLoader().loadAsync(
            `/assets/${name}.glb?v=${__ASSET_VERSION__}`,
          );
          this.creatures.set(name, { model: g.scene, clips: g.animations });
        } catch {}
      }),
    ).then(() => this.rebuildEntities());
    new GLTFLoader().load(
      `/assets/house.glb?v=${__ASSET_VERSION__}`,
      (g) => {
        for (const h of this.houses) {
          const model = g.scene.clone(true);
          model.scale.set(h.userData.w / 4.8, 1.2, h.userData.d / 3.95);
          h.remove(...h.children);
          h.add(model);
          model.traverse((o) => {
            if (o instanceof THREE.Mesh) {
              o.castShadow = true;
              o.receiveShadow = true;
            }
          });
        }
      },
      undefined,
      () => {},
    );
    new GLTFLoader().load(
      `/assets/tree.glb?v=${__ASSET_VERSION__}`,
      (g) => {
        this.sceneryTree=g.scene;
        this.canonicalWorld?.installTreeModel(g.scene);
        if(this.canonical)this.rebuildEntities();
        for (const t of this.trees) {
          t.remove(...t.children);
          const model = g.scene.clone(true);
          t.add(model);
          model.traverse((o) => {
            if (o instanceof THREE.Mesh) {
              o.castShadow = true;
              o.receiveShadow = true;
            }
          });
        }
      },
      undefined,
      () => {},
    );
    this.tick();
  }
  private installNavigation() {
    this.navigation=this.canonical
      ? new NavigationGrid([],this.canonical.layout.limit,1,0,{walkable:p=>terrainWalkable(this.canonical!,p.x,p.z),segmentClear:(a,b)=>terrainSegmentClear(this.canonical!,a,b)})
      : new NavigationGrid(this.bounds.map(b=>({minX:b.min.x,maxX:b.max.x,minZ:b.min.z,maxZ:b.max.z})));
  }
  loadCanonicalMap(map:CanonicalMapData) {
    this.clearNavigation();
    for(const node of this.worldNodes)this.scene.remove(node);
    this.houses=[];this.trees=[];this.bounds=[];
    this.canonical=map;this.mapDefinitions=new Map(map.definitions.map(d=>[d.originalId,d]));
    const before=new Set(this.scene.children);this.buildWorld();this.worldNodes=this.scene.children.filter(o=>!before.has(o));
    this.installNavigation();this.rebuildEntities();
    if(!this.ready)this.player.set(map.spawn.x,terrainHeight(map,map.spawn.x,map.spawn.z),map.spawn.z);
  }
  private groundHeight(x:number,z:number){return this.canonical?terrainHeight(this.canonical,x,z):0;}
  private interactionDistance(entity:Entity){return this.canonical&&entity.type==="monster"?.9:3.4;}
  private entityDefinition(e:Entity){const id=(e as Entity&{originalId?:number}).originalId??Number(e.id.match(/^aw_\d+_(\d+)/)?.[1]);return this.mapDefinitions.get(id);}
  typing() {
    const el = document.activeElement;
    return (
      el instanceof HTMLInputElement ||
      el instanceof HTMLTextAreaElement ||
      el instanceof HTMLSelectElement
    );
  }
  moveTo(x: number, z: number) { this.destination = { x, z }; }
  confirmTeleport(x: number, z: number) {
    // Called only for the server's teleport acknowledgement, never a map click.
    this.clearNavigation();
    this.keys.clear();
    this.moving = false;
    this.player.set(x, this.groundHeight(x, z), z);
    const own = this.avatars.get(this.selfId);
    if (own) {
      own.target.copy(this.player);
      own.root.position.copy(this.player);
      this.animation(own, "idle");
    }
    const target = this.player.clone().add(new THREE.Vector3(0, .9, 0));
    const offset = new THREE.Vector3(
      Math.sin(this.yaw) * Math.cos(this.pitch),
      Math.sin(this.pitch),
      Math.cos(this.yaw) * Math.cos(this.pitch),
    ).multiplyScalar(this.distance);
    this.camera.position.copy(target).add(offset);
    this.camera.lookAt(target);
    this.canonicalWorld?.updateVisibility(x, z, this.quality === "low" ? 30 : this.quality === "medium" ? 42 : 54);
    this.sendAt = performance.now();
    this.renderer.domElement.dataset.routeState = "teleported";
  }
  private clearNavigation() {
    this.route = [];
    this.destinationPoint = undefined;
    this.pendingEntity = undefined;
    if (this.destinationMarker) this.destinationMarker.visible = false;
    this.renderer.domElement.dataset.routePoints = "0";
  }
  private planDestination(point: Point) {
    this.route = this.navigation.findRoute(this.player, point);
    if(this.canonical&&this.pendingEntity&&this.route.length){
      const entity=this.entities.find(e=>e.id===this.pendingEntity);
      if(entity?.type==="monster"){
        const end=this.route.at(-1)!,distance=Math.hypot(end.x-entity.x,end.z-entity.z);
        if(distance>.8&&distance<1.6){const standOff={x:entity.x+(end.x-entity.x)/distance*.8,z:entity.z+(end.z-entity.z)/distance*.8};if(this.navigation.segmentClear(end,standOff)){this.route.push(standOff);}}
      }
    }
    this.destinationPoint = this.route.at(-1);
    if (!this.destinationPoint) {
      this.clearNavigation();
      this.renderer.domElement.dataset.routeState = "blocked";
      return;
    }
    this.destinationMarker.position.set(this.destinationPoint.x, this.groundHeight(this.destinationPoint.x,this.destinationPoint.z)+.08, this.destinationPoint.z);
    this.destinationMarker.visible = true;
    this.renderer.domElement.dataset.routeState = "moving";
    this.renderer.domElement.dataset.routePoints = String(this.route.length);
  }
  private makeDestinationMarker() {
    const marker = new THREE.Group();
    const material = new THREE.MeshBasicMaterial({ color: 0xb3e9d2, transparent: true, opacity: .85, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2 });
    for (const [inside, outside] of [[.68, .75], [.33, .36]]) {
      const ring = new THREE.Mesh(new THREE.RingGeometry(inside, outside, 64), material);
      ring.rotation.x = -Math.PI / 2;
      ring.renderOrder = 3;
      marker.add(ring);
    }
    for (let i = 0; i < 4; i++) {
      const line = new THREE.Mesh(new THREE.PlaneGeometry(.1, .22), material);
      line.rotation.x = -Math.PI / 2;
      line.rotation.z = i * Math.PI / 2;
      line.position.set(Math.sin(i * Math.PI / 2) * .88, .004, Math.cos(i * Math.PI / 2) * .88);
      line.renderOrder = 3;
      marker.add(line);
    }
    marker.visible = false;
    return marker;
  }
  private clickDestination(clientX: number, clientY: number) {
    const rect = this.renderer.domElement.getBoundingClientRect();
    const pointer = new THREE.Vector2(((clientX - rect.left) / rect.width) * 2 - 1, -((clientY - rect.top) / rect.height) * 2 + 1);
    this.scene.updateMatrixWorld(true);
    this.clickRay.setFromCamera(pointer, this.camera);
    // Only interactive groups are traversed; scenery, vegetation and all world meshes are excluded.
    const hits = this.clickRay.intersectObjects([...this.objects.values()].filter(o => o.visible), true);
    for (const hit of hits) {
      let ancestor: THREE.Object3D | null = hit.object;
      while (ancestor && !ancestor.userData.entityId) ancestor = ancestor.parent;
      if (!ancestor) continue;
      const entity = this.entities.find(e => e.id === ancestor!.userData.entityId && e.alive !== false && e.stock !== 0);
      if (!entity) continue;
      const occluded = this.bounds.some(b => {
        const point = this.clickRay.ray.intersectBox(b, new THREE.Vector3());
        return point && point.distanceTo(this.clickRay.ray.origin) < hit.distance - .05;
      });
      if (!occluded) { this.approachEntity(entity); return; }
    }
    const ground = this.canonicalWorld?.groundHit(this.clickRay)?.point ?? (!this.canonical ? this.clickRay.ray.intersectPlane(new THREE.Plane(new THREE.Vector3(0, 1, 0), 0), new THREE.Vector3()) : undefined);
    if (ground) this.moveTo(ground.x, ground.z);
  }
  private approachEntity(entity: Entity) {
    this.onNavigate?.();
    this.clearNavigation();
    this.pendingEntity = entity.id;
    this.entityPlannedAt = performance.now();
    if (Math.hypot(entity.x - this.player.x, entity.z - this.player.z) <= this.interactionDistance(entity)) this.finishEntityApproach(entity);
    else this.planDestination(entity);
  }
  private finishEntityApproach(entity: Entity) {
    this.clearNavigation();
    const avatar = this.avatars.get(this.selfId);
    if (avatar) {
      avatar.rotation = Math.atan2(entity.x - this.player.x, entity.z - this.player.z);
      this.onMove?.(this.player.x, this.player.z, avatar.rotation,false);
      this.sendAt = performance.now();
    }
    if (this.onEntityClick) this.onEntityClick(entity);
    else this.onInteract?.();
  }
  mat(color: number, roughness = 0.82, metalness = 0) {
    return new THREE.MeshStandardMaterial({ color, roughness, metalness });
  }
  mesh(
    geo: THREE.BufferGeometry,
    mat: THREE.Material,
    parent: THREE.Object3D,
    x = 0,
    y = 0,
    z = 0,
  ) {
    const m = new THREE.Mesh(geo, mat);
    m.position.set(x, y, z);
    m.castShadow = true;
    m.receiveShadow = true;
    parent.add(m);
    return m;
  }
  box(
    parent: THREE.Object3D,
    w: number,
    h: number,
    d: number,
    color: number,
    x = 0,
    y = 0,
    z = 0,
  ) {
    return this.mesh(
      new THREE.BoxGeometry(w, h, d),
      this.mat(color),
      parent,
      x,
      y,
      z,
    );
  }
  instances(
    geometry: THREE.BufferGeometry,
    material: THREE.Material,
    positions: THREE.Vector3[],
  ) {
    const mesh = new THREE.InstancedMesh(geometry, material, positions.length);
    const matrix = new THREE.Matrix4();
    positions.forEach((p, i) =>
      mesh.setMatrixAt(i, matrix.makeTranslation(p.x, p.y, p.z)),
    );
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    this.scene.add(mesh);
    return mesh;
  }
  tree(x: number, z: number, scale = 1) {
    const g = new THREE.Group();
    g.position.set(x, 0, z);
    g.scale.setScalar(scale);
    this.mesh(
      new THREE.CylinderGeometry(0.14, 0.25, 3.3, 9),
      this.mat(0x74624d),
      g,
      0,
      1.65,
    );
    for (let i = 0; i < 3; i++) {
      const m = this.mesh(
        new THREE.IcosahedronGeometry(1.45 - i * 0.18, 1),
        this.mat([0x486c52, 0x59845a, 0x6b8d61][i]),
        g,
        0.25 * Math.sin(x + i),
        3.1 + i * 0.7,
        0,
      );
      m.scale.set(1, 1.25, 1);
    }
    this.scene.add(g);
    this.trees.push(g);
  }
  house(x: number, z: number, w: number, d: number, rotation = 0, sign = "") {
    const g = new THREE.Group();
    g.position.set(x, 0, z);
    g.rotation.y = rotation;
    this.box(g, w + 0.4, 0.35, d + 0.4, 0x9c9e8d, 0, 0.17);
    this.box(g, w, 3.5, d, colors.wall, 0, 1.95);
    const roof = this.mesh(
      new THREE.CylinderGeometry(0, 1, 1, 4),
      this.mat(colors.roof),
      g,
      0,
      4.15,
    );
    roof.rotation.y = Math.PI / 4;
    roof.scale.set(w * 0.82, 1.1, d * 0.82);
    this.box(g, w + 0.45, 0.16, d + 0.45, 0x344747, 0, 3.72);
    this.box(g, 1.2, 2.3, 0.14, 0x304d4c, 0, 1.45, d / 2 + 0.05);
    this.box(g, 0.07, 2.3, 0.19, 0xc2c6b4, 0.65, 1.45, d / 2 + 0.08);
    for (const side of [-1, 1]) {
      this.box(g, 1.15, 1.3, 0.16, 0x41656a, side * w * 0.3, 2.3, d / 2 + 0.03);
      this.box(g, 1.3, 0.12, 0.3, 0xbdc2b0, side * w * 0.3, 1.61, d / 2 + 0.1);
      this.box(
        g,
        0.045,
        1.3,
        0.18,
        0xb2bcae,
        side * w * 0.3,
        2.3,
        d / 2 + 0.14,
      );
    }
    this.box(g, 1.6, 0.1, 1.5, 0xb5b49d, 0, 0.42, d / 2 + 0.6);
    this.box(g, 1.9, 0.12, 1.8, 0xc6c5b0, 0, 0.16, d / 2 + 1);
    this.box(g, 0.7, 0.75, 0.7, 0x98a99e, w * 0.3, 4.3, -d * 0.2);
    this.scene.add(g);
    g.userData = { w, d };
    this.houses.push(g);
    g.updateMatrixWorld(true);
    const box = new THREE.Box3().setFromCenterAndSize(
      new THREE.Vector3(x, 1.7, z),
      new THREE.Vector3(rotation ? d : w, 3.5, rotation ? w : d),
    );
    box.expandByScalar(0.35);
    this.bounds.push(box);
    if (sign) this.label(sign, x, 4.9, z);
  }
  label(text: string, x: number, y: number, z: number) {
    const c = document.createElement("canvas");
    c.width = 512;
    c.height = 80;
    const cx = c.getContext("2d")!;
    cx.fillStyle = "rgba(14,35,35,.86)";
    cx.roundRect(4, 5, 504, 70, 14);
    cx.fill();
    cx.fillStyle = "#e4e9ce";
    cx.font = "500 26px sans-serif";
    cx.textAlign = "center";
    cx.fillText(text, 256, 49);
    const spr = new THREE.Sprite(
      new THREE.SpriteMaterial({
        map: new THREE.CanvasTexture(c),
        transparent: true,
        depthTest: true,
      }),
    );
    spr.position.set(x, y, z);
    spr.scale.set(4.8, 0.75, 1);
    this.scene.add(spr);
  }
  buildWorld() {
    const sky = new THREE.Mesh(
      new THREE.SphereGeometry(this.canonical?650:350, 24, 16),
      new THREE.ShaderMaterial({
        side: THREE.BackSide,
        depthWrite: false,
        uniforms: {
          top: { value: new THREE.Color(0x548f9b) },
          bottom: { value: new THREE.Color(0xc1d2bf) },
        },
        vertexShader:
          "varying vec3 vWorld;void main(){vWorld=(modelMatrix*vec4(position,1.0)).xyz;gl_Position=projectionMatrix*modelViewMatrix*vec4(position,1.0);}",
        fragmentShader:
          "uniform vec3 top;uniform vec3 bottom;varying vec3 vWorld;void main(){float h=normalize(vWorld).y;gl_FragColor=vec4(mix(bottom,top,pow(max(h,0.0),0.7)),1.0);\n#include <tonemapping_fragment>\n#include <colorspace_fragment>\n}",
      }),
    );
    this.scene.add(sky);
    const moon = this.mesh(
      new THREE.SphereGeometry(28, 32, 24),
      new THREE.MeshBasicMaterial({
        color: 0xd8d8bd,
        transparent: true,
        opacity: 0.6,
      }),
      this.scene,
      110,
      115,
      -230,
    );
    moon.castShadow = false;
    if(this.canonical){
      this.canonicalWorld=new CanonicalWorld(this.canonical);this.scene.add(this.canonicalWorld.root);
      if(this.sceneryTree)this.canonicalWorld.installTreeModel(this.sceneryTree);
      this.renderer.domElement.dataset.mapMode="original-grid";
      this.renderer.domElement.dataset.mapPlacements=String(this.canonical.placements.length);
      this.renderer.domElement.dataset.mapObjectTypes=String(this.canonical.definitions.length);
      return;
    }
    const textureCanvas = document.createElement("canvas");
    textureCanvas.width = 512;
    textureCanvas.height = 512;
    const tc = textureCanvas.getContext("2d")!;
    tc.fillStyle = "#7d9167";
    tc.fillRect(0, 0, 512, 512);
    let seed = 19;
    const rnd = () => {
      seed = (seed * 1664525 + 1013904223) >>> 0;
      return seed / 4294967296;
    };
    for (let i = 0; i < 30000; i++) {
      tc.fillStyle =
        rnd() > 0.5 ? "rgba(185,184,121,.2)" : "rgba(49,80,51,.22)";
      tc.fillRect(rnd() * 512, rnd() * 512, 1 + rnd() * 3, 1 + rnd() * 4);
    }
    const grassTexture = new THREE.CanvasTexture(textureCanvas);
    grassTexture.wrapS = grassTexture.wrapT = THREE.RepeatWrapping;
    grassTexture.repeat.set(45, 45);
    grassTexture.colorSpace = THREE.SRGBColorSpace;
    grassTexture.anisotropy = 4;
    const ground = this.mesh(
      new THREE.PlaneGeometry(310, 310, 1, 1),
      new THREE.MeshStandardMaterial({ map: grassTexture, roughness: 1 }),
      this.scene,
    );
    ground.rotation.x = -Math.PI / 2;
    ground.userData.surface = "grass";
    ground.castShadow = false;
    const road = this.mat(colors.sand);
    for (const [w, d, x, z] of [
      [9, 110, 0, 10],
      [95, 6, 0, -7],
      [65, 5, 0, 21],
      [5, 60, 24, 0],
    ]) {
      const m = this.mesh(
        new THREE.PlaneGeometry(w, d),
        road,
        this.scene,
        x,
        0.012,
        z,
      );
      m.rotation.x = -Math.PI / 2;
      m.userData.surface = "road";
      m.castShadow = false;
    }
    const plaza = this.mesh(
      new THREE.CircleGeometry(14, 48),
      this.mat(0xbdbda3),
      this.scene,
      0,
      0.02,
      0,
    );
    plaza.rotation.x = -Math.PI / 2;
    plaza.userData.surface = "plaza";
    plaza.castShadow = false;
    this.house(0, -15, 10, 8, 0, "Банк Фармуна");
    this.house(14, -16, 8, 7, 0, "Мастерские");
    this.house(-13, -12, 8, 7, 0, "Торговая лавка");
    this.house(-16, 7, 7, 6);
    this.house(15, 8, 7, 6);
    this.house(-12, 28, 8, 6);
    this.house(32, 15, 7, 7);
    const monument = new THREE.Group();
    this.box(monument, 2.5, 0.45, 2.5, 0x8d9b91, 0, 0.22);
    this.mesh(
      new THREE.CylinderGeometry(0.35, 0.55, 4, 10),
      this.mat(0x6c8585, 0.3, 0.6),
      monument,
      0,
      2.4,
    );
    const ring = this.mesh(
      new THREE.TorusGeometry(1.25, 0.075, 12, 40),
      this.mat(0xc7dab7, 0.2, 0.7),
      monument,
      0,
      4,
    );
    ring.rotation.y = 0.5;
    this.mesh(
      new THREE.SphereGeometry(0.3, 20, 12),
      new THREE.MeshStandardMaterial({
        color: 0xd7f3bc,
        emissive: 0x8ead6e,
        emissiveIntensity: 1,
      }),
      monument,
      0,
      4,
    );
    monument.position.z = -4;
    this.scene.add(monument);
    for (let n = 0; n < 52; n++) {
      const x = Math.sin(n * 8.54) * 35 - 44,
        z = Math.cos(n * 4.17) * 39 + 18;
      if (x < -20) this.tree(x, z, 0.8 + (n % 7) / 8);
    }
    for (let n = 0; n < 16; n++)
      this.tree(
        36 + Math.sin(n * 13) * 28,
        50 + Math.cos(n * 3) * 16,
        0.8 + (n % 3) * 0.2,
      );
    for (let n = 0; n < 24; n++) {
      const x = 40 + Math.sin(n * 10.81) * 14,
        z = -43 + Math.cos(n * 17.31) * 16;
      const rock = this.mesh(
        new THREE.IcosahedronGeometry(1.3 + (n % 4) * 0.6, 1),
        this.mat(n % 3 ? 0x8e968c : 0x7998a0, 0.9),
        this.scene,
        x,
        0.4,
        z,
      );
      rock.scale.set(1, 1 + (n % 4) * 0.5, 1.2);
      rock.rotation.set(n, 0.3 * n, 0);
    }
    for (let n = 0; n < 6; n++) {
      const hill = this.mesh(
        new THREE.SphereGeometry(20, 24, 16),
        this.mat(0x70816e),
        this.scene,
        Math.sin(n * 1.6) * 115,
        -11,
        Math.cos(n * 1.6) * 115,
      );
      hill.scale.set(1.8, 1, 1.1);
    }
    const river = this.mesh(
      new THREE.PlaneGeometry(18, 230, 16, 48),
      new THREE.MeshPhysicalMaterial({
        color: 0x478b96,
        metalness: 0.2,
        roughness: 0.28,
        transparent: true,
        opacity: 0.88,
      }),
      this.scene,
      -63,
      0.04,
      0,
    );
    river.rotation.x = -Math.PI / 2;
    this.water = river;
    river.castShadow = false;
    for (let n = 0; n < 10; n++)
      this.box(this.scene, 3, 0.13, 1.08, 0x837762, -48, 0.16, -16 + n * 1.1);
    for (let n = 0; n < 14; n++) {
      this.box(this.scene, 0.12, 1.1, 0.13, 0x8b8168, 9 + n * 1.6, 0.55, 27);
      if (n < 13) {
        this.box(this.scene, 1.6, 0.1, 0.1, 0xaa9a7d, 9.8 + n * 1.6, 0.85, 27);
        this.box(this.scene, 1.6, 0.1, 0.1, 0xaa9a7d, 9.8 + n * 1.6, 0.42, 27);
      }
    }
    const stalks: THREE.Vector3[] = [],
      grains: THREE.Vector3[] = [],
      grasses: THREE.Vector3[] = [];
    for (let n = 0; n < 160; n++) {
      const x = 10 + (n % 16) * 1.1,
        z = 17 + Math.floor(n / 16) * 0.7;
      stalks.push(new THREE.Vector3(x, 0.35, z));
      grains.push(new THREE.Vector3(x, 0.75, z));
    }
    this.instances(
      new THREE.CylinderGeometry(0.025, 0.035, 0.7, 4),
      this.mat(0xc6bc69),
      stalks,
    ).castShadow = false;
    this.instances(
      new THREE.CapsuleGeometry(0.07, 0.15, 2, 4),
      this.mat(0xddcd7d),
      grains,
    ).castShadow = false;
    for (let n = 0; n < 75; n++) {
      const x = Math.sin(n * 12.85) * 86,
        z = Math.cos(n * 5.1) * 82;
      if (Math.abs(x) < 28 && Math.abs(z) < 35) continue;
      grasses.push(new THREE.Vector3(x, 0.25, z));
    }
    this.instances(
      new THREE.ConeGeometry(0.3, 0.5, 4),
      this.mat(0x587d54),
      grasses,
    ).castShadow = false;
    for (const [x, z] of [
      [-5, 13],
      [5, -8],
      [20, -7],
      [-26, -7],
    ]) {
      const g = new THREE.Group();
      this.mesh(
        new THREE.CylinderGeometry(0.06, 0.09, 3.4, 8),
        this.mat(0x65766c, 0.4, 0.5),
        g,
        0,
        1.7,
      );
      this.box(g, 0.5, 0.25, 0.5, 0xaac1b4, 0, 3.3);
      this.mesh(
        new THREE.BoxGeometry(0.3, 0.12, 0.3),
        new THREE.MeshStandardMaterial({
          color: 0xffd58b,
          emissive: 0xffcc77,
          emissiveIntensity: 2,
        }),
        g,
        0,
        3.2,
      );
      g.position.set(x, 0, z);
      this.scene.add(g);
    }
    this.label("ФАРМУН · КОЛОНИЯ", 0, 7, -19);
  }
  fallback(): THREE.Group {
    const g = new THREE.Group();
    this.mesh(
      new THREE.CapsuleGeometry(0.28, 0.55, 4, 10),
      this.mat(0x385453, 0.4, 0.25),
      g,
      0,
      1.15,
    );
    this.mesh(
      new THREE.SphereGeometry(0.21, 14, 10),
      this.mat(0xdbb891),
      g,
      0,
      1.87,
    );
    this.box(g, 0.24, 0.16, 0.3, 0x6c8d85, 0, 1.99, 0);
    for (const s of [-1, 1]) {
      this.box(g, 0.18, 0.7, 0.2, 0x354848, s * 0.16, 0.5);
      this.box(g, 0.14, 0.66, 0.17, 0x64776b, s * 0.39, 1.13);
      this.box(g, 0.22, 0.15, 0.36, 0x243a37, s * 0.16, 0.08, 0.06);
    }
    this.box(g, 0.43, 0.55, 0.17, 0x8e9a75, 0, 1.25, -0.24);
    return g;
  }
  installModel(a: Avatar, model: THREE.Group, clips: THREE.AnimationClip[]) {
    const obj = clone(model) as THREE.Group;
    const b = new THREE.Box3().setFromObject(obj);
    const size = b.getSize(new THREE.Vector3());
    obj.scale.setScalar(1.95 / Math.max(size.y, 0.1));
    obj.position.y = -b.min.y * obj.scale.y;
    obj.traverse((o) => {
      if (o instanceof THREE.Mesh) {
        o.castShadow = true;
        o.receiveShadow = true;
      }
      if (o.name === "hand_r") a.hand = o;
    });
    a.equipped = undefined;
    a.root.add(obj);
    a.mixer = new THREE.AnimationMixer(obj);
    a.actions = {};
    for (const clip of clips) {
      const name = clip.name.toLowerCase(),
        action = a.mixer.clipAction(clip);
      if (/attack|hit|death|interact|shoot/.test(name)) {
        action.setLoop(THREE.LoopOnce, 1);
        action.clampWhenFinished = true;
      }
      a.actions[name] = action;
    }
    a.mixer.addEventListener("finished", () => this.animation(a, "idle"));
    a.current = "";
    this.animation(a, "idle");
  }
  animation(a: Avatar, state: string) {
    const name =
      Object.keys(a.actions).find((n) => n === state) ||
      Object.keys(a.actions).find((n) => n.includes(state));
    if (!name || name === a.current) return;
    const old = a.actions[a.current];
    old?.fadeOut(0.18);
    a.actions[name].reset().fadeIn(0.18).play();
    a.current = name;
  }
  triggerAttack(e: Entity) {
    const a = this.avatars.get(this.selfId);
    if (!a) return;
    a.rotation = Math.atan2(e.x - this.player.x, e.z - this.player.z);
    if (a.current === "attack") {
      a.actions.attack?.reset().play();
    } else this.animation(a, "attack");
  }
  equipment(a: Avatar, id: string | null) {
    if (a.equipped === id) return;
    a.weapon?.removeFromParent();
    a.equipped = id;
    if (!id || !a.hand) return;
    const g = new THREE.Group();
    if (/bow|gun|pistol|laser|rifle/.test(id)) {
      this.box(g, 0.07, 0.12, 0.55, 0x465f5b, 0, 0.08, 0.2);
      this.box(g, 0.06, 0.06, 0.25, 0x899b86, 0, 0.1, 0.58);
    } else {
      this.box(g, 0.055, 0.15, 0.055, 0x524a39, 0, 0.05, 0);
      this.box(g, 0.28, 0.045, 0.08, 0x998561, 0, 0.15, 0);
      this.box(
        g,
        0.065,
        0.65,
        0.025,
        /bronze/.test(id) ? 0xa69769 : 0xb3c4b8,
        0,
        0.5,
        0,
      );
    }
    g.rotation.z = 0;
    g.position.set(0, 0.05, 0.02);
    a.hand.add(g);
    a.weapon = g;
  }
  avatar(id: string, x: number, z: number, rotation = 0) {
    const root = new THREE.Group();
    root.position.set(x, this.groundHeight(x,z), z);
    const a: Avatar = {
      root,
      actions: {},
      current: "",
      target: new THREE.Vector3(x, this.groundHeight(x,z), z),
      rotation,
    };
    if (this.model) this.installModel(a, this.model, this.clips);
    else root.add(this.fallback());
    this.scene.add(root);
    this.avatars.set(id, a);
    return a;
  }
  updatePlayers(self: Player, players: Player[]) {
    this.stamina=self.stamina;
    if (this.selfId !== self.id) {
      this.selfId = self.id;
      this.player.set(self.x, this.groundHeight(self.x,self.z), self.z);
      this.clearNavigation();
      this.ready = true;
    }
    const a =
      this.avatars.get(self.id) ||
      this.avatar(self.id, self.x, self.z, self.rotation);
    if (Math.hypot(this.player.x-self.x,this.player.z-self.z) > 3) {
      this.player.set(self.x, this.groundHeight(self.x,self.z), self.z);
      this.clearNavigation();
      this.onNavigate?.();
    }
    a.target.copy(this.player);
    this.equipment(a, self.equipped);
    if (self.action === "attack") this.animation(a, "attack");
    for (const p of players) {
      if (p.id === self.id) continue;
      const other = this.avatars.get(p.id) || this.avatar(p.id, p.x, p.z);
      other.target.set(p.x, this.groundHeight(p.x,p.z), p.z);
      other.rotation = p.rotation;
      this.equipment(other, p.equipped);
      this.animation(
        other,
        other.root.position.distanceTo(other.target) > 0.1 ? "walk" : "idle",
      );
    }
    const ids = new Set([self.id, ...players.map((p) => p.id)]);
    for (const [id, other] of this.avatars) {
      if (!ids.has(id)) {
        this.scene.remove(other.root);
        this.avatars.delete(id);
      }
    }
  }
  updateEntities(entities: Entity[]) {
    entities=entities.filter(e=>this.entityDefinition(e)?.kind!=="decor"&&(!this.canonical||Math.hypot(e.x-this.player.x,e.z-this.player.z)<52));
    this.entities = entities;
    const ids = new Set(entities.map((e) => e.id));
    for (const [id, o] of this.objects) {
      if (!ids.has(id)) {
        this.scene.remove(o);
        this.objects.delete(id);
        this.entityMixers.delete(id);
        this.creatureActions.delete(id);
      }
    }
    for (const e of entities) {
      let o = this.objects.get(e.id);
      if (!o) {
        o = this.entityObject(e);
        this.objects.set(e.id, o);
        this.scene.add(o);
      }
      const moved = Math.hypot(o.position.x - e.x, o.position.z - e.z) > 0.05;
      if (moved && o.position.x !== 0 && o.position.z !== 0)
        o.rotation.y = Math.atan2(e.x - o.position.x, e.z - o.position.z);
      const animation = this.creatureActions.get(e.id);
      if (animation) {
        const state = moved ? "walk" : "idle";
        if (animation.current !== state) {
          animation.actions[animation.current]?.fadeOut(0.15);
          animation.actions[state]?.reset().fadeIn(0.15).play();
          animation.current = state;
        }
      }
      o.position.set(e.x, this.groundHeight(e.x,e.z), e.z);
      o.visible = e.alive !== false && e.stock !== 0;
    }
  }
  rebuildEntities() {
    for (const o of this.objects.values()) this.scene.remove(o);
    this.objects.clear();
    this.entityMixers.clear();
    this.creatureActions.clear();
    this.updateEntities(this.entities);
  }
  private installEntityModel(root:THREE.Group,entity:Entity,source:THREE.Group,clips:THREE.AnimationClip[],height:number){
    const model=clone(source) as THREE.Group,bounds=new THREE.Box3().setFromObject(model);
    model.scale.setScalar(height/Math.max(.1,bounds.getSize(new THREE.Vector3()).y));
    model.position.y=-bounds.min.y*model.scale.y;
    model.traverse(o=>{if(o instanceof THREE.Mesh){o.castShadow=true;o.receiveShadow=true;}});
    root.add(model);
    const mixer=new THREE.AnimationMixer(model),actions:Record<string,THREE.AnimationAction>={};
    for(const clip of clips){const key=clip.name.toLowerCase(),action=mixer.clipAction(clip);actions[key]=action;if(/attack|hit|death/.test(key)){action.setLoop(THREE.LoopOnce,1);action.clampWhenFinished=true;}}
    const idle=Object.keys(actions).find(k=>k.includes("idle"));if(idle)actions[idle].play();
    this.entityMixers.set(entity.id,mixer);this.creatureActions.set(entity.id,{actions,current:idle??""});
    mixer.addEventListener("finished",()=>{const state=this.creatureActions.get(entity.id);if(state&&idle){state.actions[state.current]?.fadeOut(.12);state.actions[idle].reset().fadeIn(.12).play();state.current=idle;}});
  }
  triggerEntityAttack(id:string){
    const state=this.creatureActions.get(id);if(!state)return;
    const attack=Object.keys(state.actions).find(k=>/attack|bite|hit/.test(k));if(!attack)return;
    state.actions[state.current]?.fadeOut(.1);const action=state.actions[attack];action.setLoop(THREE.LoopOnce,1);action.clampWhenFinished=true;action.reset().fadeIn(.1).play();state.current=attack;
  }
  entityObject(e: Entity) {
    const g = new THREE.Group();
    g.userData.entityId = e.id;
    const definition=this.entityDefinition(e);
    const descriptiveId=definition?`${e.id} ${definition.name.toLowerCase()}`:e.id;
    if(definition&&(e.type==="station"||e.type==="transition"||e.type==="resource"||e.type==="decor")){
      if(definition.family==="tree"&&this.sceneryTree){const model=this.sceneryTree.clone(true),bounds=new THREE.Box3().setFromObject(model),scale=2.8/Math.max(.1,bounds.getSize(new THREE.Vector3()).y);model.scale.setScalar(scale);model.position.y=-bounds.min.y*scale;model.traverse(o=>{if(o instanceof THREE.Mesh){o.castShadow=true;o.receiveShadow=true;}});g.add(model);return g;}
      g.add(familyModel(definition));return g;
    }
    if(e.type==="npc"&&((definition?.originalId===285&&this.bob)||this.model)){
      const source=definition?.originalId===285&&this.bob?this.bob:{model:this.model!,clips:this.clips};
      this.installEntityModel(g,e,source.model,source.clips,1.8);return g;
    }
    if (e.type === "monster") {
      const kind = /chicken|hen|pheasant|stropterix/.test(descriptiveId)
        ? "chicken"
        : /spider/.test(descriptiveId) && this.creatures.has("spider")?"spider"
        : /deer/.test(descriptiveId)&&this.creatures.has("deer")?"deer"
        : /dog|rotoz|globbit|shaldar|lonter/.test(descriptiveId)&&this.creatures.has("dog")?"dog"
        : /scorpion|spider/.test(descriptiveId)
          ? "scorpion"
          : /rat/.test(descriptiveId)
            ? "rat"
            : "";
      const creature = this.creatures.get(kind);
      if (creature) {
        const model = clone(creature.model);
        const b = new THREE.Box3().setFromObject(model);
        const scale =
          (
            { chicken: 0.8, rat: 0.55, scorpion: 0.65,spider:.9,deer:1.55,dog:1.2 } as Record<
              string,
              number
            >
          )[kind] / Math.max(0.1, b.getSize(new THREE.Vector3()).y);
        model.scale.setScalar(scale);
        model.position.y = -b.min.y * scale;
        model.traverse((o) => {
          if (o instanceof THREE.Mesh) {
            o.castShadow = true;
            o.receiveShadow = true;
          }
        });
        g.add(model);
        const mixer = new THREE.AnimationMixer(model),
          actions: Record<string, THREE.AnimationAction> = {};
        for (const clip of creature.clips)
          actions[clip.name.toLowerCase()] = mixer.clipAction(clip);
        actions.idle?.play();
        this.entityMixers.set(e.id, mixer);
        this.creatureActions.set(e.id, { actions, current: "idle" });
      } else if (/drone|droid|loader/i.test(descriptiveId) && this.drone) {
        const d = clone(this.drone);
        const b = new THREE.Box3().setFromObject(d);
        d.scale.setScalar(
          1.4 / Math.max(b.getSize(new THREE.Vector3()).y, 0.1),
        );
        d.position.y = 1.4;
        g.add(d);
        d.traverse((o) => {
          if (o instanceof THREE.Mesh) o.castShadow = true;
        });
        const mixer = new THREE.AnimationMixer(d);
        const clip = this.droneClips.find((c) => /idle/i.test(c.name));
        if (clip) mixer.clipAction(clip).play();
        this.entityMixers.set(e.id, mixer);
      } else if(definition?.family==="humanoid"&&this.model){this.installEntityModel(g,e,this.model,this.clips,1.8);
      } else if(definition){g.add(familyModel(definition));
      } else if (/chicken|hen/i.test(descriptiveId)) {
        this.mesh(
          new THREE.SphereGeometry(0.28, 12, 10),
          this.mat(0xe3dac3),
          g,
          0,
          0.42,
        );
        this.mesh(
          new THREE.SphereGeometry(0.14, 10, 8),
          this.mat(0xe6dfc7),
          g,
          0,
          0.7,
          0.21,
        );
        this.mesh(
          new THREE.ConeGeometry(0.075, 0.17, 4),
          this.mat(0xd7a65d),
          g,
          0,
          0.64,
          0.35,
        ).rotation.x = Math.PI / 2;
        this.mesh(
          new THREE.SphereGeometry(0.06, 8, 6),
          this.mat(0xb75c43),
          g,
          0,
          0.83,
          0.2,
        );
        for (const s of [-1, 1])
          this.box(g, 0.025, 0.25, 0.03, 0x9e7852, s * 0.09, 0.16);
      } else {
        this.mesh(
          new THREE.SphereGeometry(0.45, 12, 10),
          this.mat(/scorpion/i.test(e.id) ? 0x786852 : 0x79796d),
          g,
          0,
          0.3,
        );
        for (let n = 0; n < 6; n++) {
          const s = n % 2 ? -1 : 1;
          this.box(
            g,
            0.55,
            0.08,
            0.1,
            0x5d6256,
            s * 0.35,
            0.18,
            (Math.floor(n / 2) - 1) * 0.25,
          );
        }
        this.mesh(
          new THREE.SphereGeometry(0.18, 10, 8),
          this.mat(0x535f52),
          g,
          0,
          0.32,
          0.45,
        );
      }
    } else if (e.type === "loot") {
      this.box(g, 0.6, 0.38, 0.45, 0x9c9974, 0, 0.23);
      this.box(g, 0.08, 0.42, 0.47, 0x435e53, 0, 0.24);
      const halo = this.mesh(
        new THREE.TorusGeometry(0.45, 0.025, 8, 24),
        new THREE.MeshBasicMaterial({ color: 0xd4c681 }),
        g,
        0,
        0.06,
      );
      halo.rotation.x = -Math.PI / 2;
    } else if (e.type === "npc") {
      if (e.id === "bank") {
        this.box(g, 1.5, 0.65, 1.1, 0x71867a, 0, 0.4);
        this.box(g, 1.1, 1.2, 0.4, 0x355a54, 0, 1.35);
        this.mesh(
          new THREE.PlaneGeometry(0.8, 0.4),
          new THREE.MeshBasicMaterial({ color: 0xb6dab4 }),
          g,
          0,
          1.55,
          0.21,
        );
      } else {
        g.add(this.fallback());
        const halo = this.mesh(
          new THREE.TorusGeometry(0.5, 0.025, 8, 24),
          new THREE.MeshBasicMaterial({ color: 0xd4c681 }),
          g,
          0,
          0.08,
        );
        halo.rotation.x = -Math.PI / 2;
      }
    } else if (e.type === "resource") {
      const id = e.resource || e.id;
      if (
        /ore|stone|coal|iron|copper|tin|quartz|ruby|emerald|sapphire|diamond|crystal/i.test(
          id,
        )
      ) {
        this.mesh(
          new THREE.IcosahedronGeometry(0.8, 1),
          this.mat(/copper/i.test(id) ? 0xa68460 : 0x81938b, 0.7, 0.12),
          g,
          0,
          0.45,
        );
        this.mesh(
          new THREE.IcosahedronGeometry(0.35, 0),
          this.mat(0xb8c6b2, 0.3, 0.5),
          g,
          0.4,
          0.8,
          0.2,
        );
      } else if (/wood|log/i.test(id)) {
        this.mesh(
          new THREE.CylinderGeometry(0.18, 0.27, 2.5, 8),
          this.mat(0x76614c),
          g,
          0,
          1.25,
        );
        this.mesh(
          new THREE.IcosahedronGeometry(1.25, 1),
          this.mat(0x557950),
          g,
          0,
          2.9,
        );
      } else if (/fish|shrimp|trout|carp|perch|salmon|water/i.test(id)) {
        const ring = this.mesh(
          new THREE.TorusGeometry(0.85, 0.05, 6, 24),
          this.mat(0xa4d9cf, 0.4),
          g,
          0,
          0.12,
        );
        ring.rotation.x = -Math.PI / 2;
      } else {
        for (let i = 0; i < 4; i++)
          this.mesh(
            new THREE.ConeGeometry(0.16, 0.6, 5),
            this.mat(0xa8bd69),
            g,
            (i % 2) * 0.3,
            0.3,
            Math.floor(i / 2) * 0.3,
          );
      }
    } else if (e.type === "station") {
      this.box(g, 1.5, 0.65, 1.1, 0x71867a, 0, 0.4);
      this.box(g, 1.3, 0.15, 0.95, 0xadb99a, 0, 0.8);
      this.box(g, 0.6, 0.8, 0.4, 0x426b64, 0, 1.2, -0.25);
      const light = this.mesh(
        new THREE.PlaneGeometry(0.4, 0.25),
        new THREE.MeshBasicMaterial({ color: 0xb6dab4 }),
        g,
        0,
        1.25,
        -0.04,
      );
      light.rotation.y = 0;
    }
    return g;
  }
  nearest(): Entity | undefined {
    return this.entities
      .filter((e) => e.alive !== false && e.stock !== 0)
      .map((e) => ({
        e,
        d: Math.hypot(e.x - this.player.x, e.z - this.player.z),
      }))
      .filter((o) => o.d < 4.5)
      .sort(
        (a, b) =>
          a.d -
          (a.e.type === "loot" ? 1.5 : 0) -
          (b.d - (b.e.type === "loot" ? 1.5 : 0)),
      )[0]?.e;
  }
  resize() {
    const w = this.host.clientWidth,
      h = this.host.clientHeight;
    this.renderer.setSize(w, h);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    this.graphics?.resize(w, h);
  }
  setQuality(q: string) {
    this.quality = q;
    this.renderer.setPixelRatio(
      q === "low" ? 1 : Math.min(devicePixelRatio, 1.75),
    );
    this.renderer.shadowMap.enabled = q !== "low";
    this.graphics.setQuality(q);
    this.resize();
  }
  tick = () => {
    requestAnimationFrame(this.tick);
    const now = performance.now(),
      dt = Math.min((now - this.last) / 1000, 0.05);
    this.last = now;
    this.clock += dt;
    if (this.pendingEntity && this.ready && this.focused && !this.typing()) {
      const target = this.entities.find(e => e.id === this.pendingEntity && e.alive !== false && e.stock !== 0);
      if (!target) this.clearNavigation();
      else if (Math.hypot(target.x - this.player.x, target.z - this.player.z) <= this.interactionDistance(target)) this.finishEntityApproach(target);
      else if (this.destinationPoint && Math.hypot(target.x - this.destinationPoint.x, target.z - this.destinationPoint.z) > 1.2 && now - this.entityPlannedAt > 500) {
        this.entityPlannedAt = now;
        this.planDestination(target);
      }
    }
    let dx = 0,
      dz = 0;
    if (this.ready && this.focused && !this.typing()) {
      if (this.keys.has("w") || this.keys.has("ц") || this.keys.has("arrowup")) dz -= 1;
      if (this.keys.has("s") || this.keys.has("ы") || this.keys.has("arrowdown")) dz += 1;
      if (this.keys.has("a") || this.keys.has("ф") || this.keys.has("arrowleft")) dx -= 1;
      if (this.keys.has("d") || this.keys.has("в") || this.keys.has("arrowright")) dx += 1;
    }
    let direction: THREE.Vector3 | undefined;
    let remaining = Infinity;
    if (dx || dz) {
      this.clearNavigation();
      const movement = screenRelativeMovement(dx, dz, this.yaw);
      direction = new THREE.Vector3(movement.x, 0, movement.z);
    } else if (this.route.length && this.ready && this.focused && !this.typing()) {
      while (this.route.length > 1 && Math.hypot(this.route[0].x - this.player.x, this.route[0].z - this.player.z) < .16 && this.navigation.segmentClear(this.player, this.route[1])) this.route.shift();
      const waypoint = this.route[0];
      const diff = new THREE.Vector3(waypoint.x - this.player.x, 0, waypoint.z - this.player.z);
      remaining = diff.length();
      if (this.route.length === 1 && remaining < (this.pendingEntity?.length ? .04 : .35)) {
        this.clearNavigation();
        this.renderer.domElement.dataset.routeState = "complete";
      } else if (remaining > .001) direction = diff.normalize();
      else this.route.shift();
    }
    this.moving = !!direction;
    if (direction) {
      const running=this.keys.has("shift")&&this.stamina>0;
      const speed = this.canonical ? (running ? 2 : 1) : (running ? 6.5 : 3.6);
      const next = this.player.clone().addScaledVector(direction, Math.min(speed * dt, remaining));
      const limit=this.canonical?.layout.limit??119;
      next.x = THREE.MathUtils.clamp(next.x, -limit, limit);
      next.z = THREE.MathUtils.clamp(next.z, -limit, limit);
      if (this.navigation.segmentClear(this.player, next)) this.player.copy(next);
      else if (dx || dz) {
        const slideX = new THREE.Vector3(next.x, 0, this.player.z), slideZ = new THREE.Vector3(this.player.x, 0, next.z);
        const candidates = Math.abs(direction.x) > Math.abs(direction.z) ? [slideX, slideZ] : [slideZ, slideX];
        const slide = candidates.find(point => this.navigation.segmentClear(this.player, point));
        if (slide) this.player.copy(slide); else this.moving = false;
      } else if (this.destinationPoint) this.planDestination(this.destinationPoint);
      const a = this.avatars.get(this.selfId);
      if (a) {
        a.rotation = Math.atan2(direction.x, direction.z);
        this.animation(a, running ? "run" : "walk");
      }
    }
    const own = this.avatars.get(this.selfId);
    this.player.y=this.groundHeight(this.player.x,this.player.z);
    if (own) {
      own.target.copy(this.player);
      const current = own.actions[own.current];
      if (
        !this.moving &&
        !(
          own.current.includes("attack") &&
          current?.time < current?.getClip().duration
        )
      )
        this.animation(own, "idle");
      if (now - this.sendAt > 75) {
        this.onMove?.(this.player.x, this.player.z, own.rotation,this.keys.has("shift")&&this.stamina>0);
        this.sendAt = now;
      }
    }
    for (const a of this.avatars.values()) {
      a.root.position.lerp(a.target, Math.min(1, dt * 14));
      const delta = Math.atan2(
        Math.sin(a.rotation - a.root.rotation.y),
        Math.cos(a.rotation - a.root.rotation.y),
      );
      a.root.rotation.y += delta * Math.min(1, dt * 12);
      a.mixer?.update(dt);
    }
    for (const mixer of this.entityMixers.values()) mixer.update(dt);
    for (const e of this.entities) {
      if (e.type === "monster" && /drone|droid|loader/i.test(this.entityDefinition(e)?.name??e.id)) {
        const o = this.objects.get(e.id);
        if (o) {
          o.rotation.y = Math.sin(this.clock * 0.5) * 0.8;
          o.position.y = this.groundHeight(e.x,e.z)+Math.sin(this.clock * 1.8) * 0.12;
        }
      }
    }
    const target = this.player.clone().add(new THREE.Vector3(0, .9, 0));
    if (!this.ready&&!this.canonical) target.set(0, 1, 2);
    const camYaw = this.yaw,
      camPitch = this.pitch,
      camDistance = this.distance;
    const offset = new THREE.Vector3(
      Math.sin(camYaw) * Math.cos(camPitch),
      Math.sin(camPitch),
      Math.cos(camYaw) * Math.cos(camPitch),
    ).multiplyScalar(camDistance);
    // An overhead camera keeps its height; roof intersections must never shorten it into a shoulder view.
    const desired = target.clone().add(offset);
    this.camera.position.lerp(desired, 1 - Math.exp(-dt * 9));
    this.camera.lookAt(target);
    this.sun.position.set(this.player.x - 30, 55, this.player.z + 24);
    this.sun.target.position.copy(this.player);
    this.sun.target.updateMatrixWorld();
    if (this.destinationMarker.visible) this.destinationMarker.rotation.y = this.clock * .55;
    if(this.canonicalWorld)this.canonicalWorld.updateVisibility(this.player.x,this.player.z,this.quality==="low"?30:this.quality==="medium"?42:54);
    this.graphics.render(dt);
    this.frameCount++;
    if (now - this.frameAt >= 1000) {
      this.renderer.domElement.dataset.fps = String(
        Math.round((this.frameCount * 1000) / (now - this.frameAt)),
      );
      this.renderer.domElement.dataset.drawCalls = String(
        this.renderer.info.render.calls,
      );
      this.renderer.domElement.dataset.triangles = String(
        this.renderer.info.render.triangles,
      );
      this.renderer.domElement.dataset.cameraElevation = "55";
      this.renderer.domElement.dataset.cameraDistance = this.distance.toFixed(1);
      this.renderer.domElement.dataset.routePoints = String(this.route.length);
      this.frameCount = 0;
      this.frameAt = now;
    }
  };
}
