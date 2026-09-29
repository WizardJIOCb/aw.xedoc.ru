import * as THREE from "three";
import { EffectComposer } from "three/addons/postprocessing/EffectComposer.js";
import { RenderPass } from "three/addons/postprocessing/RenderPass.js";
import { GTAOPass } from "three/addons/postprocessing/GTAOPass.js";
import { UnrealBloomPass } from "three/addons/postprocessing/UnrealBloomPass.js";
import { OutputPass } from "three/addons/postprocessing/OutputPass.js";

/** Original procedural surface art, with linear HDR lighting and restrained AO/bloom. */
export class PlanetGraphics {
  private composer: EffectComposer;
  private ao: GTAOPass;
  private bloom: UnrealBloomPass;
  constructor(
    private renderer: THREE.WebGLRenderer,
    scene: THREE.Scene,
    camera: THREE.Camera,
  ) {
    renderer.toneMappingExposure = 0.96;
    renderer.info.autoReset = false;
    let groundMaterial: THREE.MeshStandardMaterial | undefined;
    scene.traverse((o) => {
      if (o instanceof THREE.HemisphereLight) {
        o.intensity = 1.0;
        o.color.set(0xd5e3ec);
        o.groundColor.set(0x393e30);
      }
      if (o instanceof THREE.DirectionalLight) {
        o.intensity = 3.2;
        o.color.set(0xffe5be);
        o.shadow.radius = 3;
      }
      if (!(o instanceof THREE.Mesh)) return;
      if (o.userData.canonicalGround) {
        groundMaterial ??= surfaceMaterial("terrain");
        groundMaterial.vertexColors = true;
        const positions = o.geometry.getAttribute("position"), uv = new Float32Array(positions.count * 2);
        for (let i = 0; i < positions.count; i++) { uv[i * 2] = positions.getX(i) / 8; uv[i * 2 + 1] = positions.getZ(i) / 8; }
        o.geometry.setAttribute("uv", new THREE.BufferAttribute(uv, 2));
        o.material = groundMaterial;
        return;
      }
      if (!o.userData.surface) return;
      const surface = o.userData.surface as "grass" | "road" | "plaza";
      o.material = surfaceMaterial(surface);
      o.receiveShadow = true;
    });
    this.composer = new EffectComposer(renderer);
    this.composer.addPass(new RenderPass(scene, camera));
    this.ao = new GTAOPass(scene, camera, 512, 512);
    this.ao.blendIntensity = 0.65;
    this.ao.updateGtaoMaterial({
      radius: 0.7,
      thickness: 0.4,
      distanceFallOff: 1.0,
      samples: 8,
    });
    this.ao.updatePdMaterial({ samples: 8, radius: 3, rings: 2 });
    this.composer.addPass(this.ao);
    this.bloom = new UnrealBloomPass(
      new THREE.Vector2(512, 512),
      0.14,
      0.35,
      1.2,
    );
    this.composer.addPass(this.bloom);
    this.composer.addPass(new OutputPass());
  }
  resize(width: number, height: number) {
    this.composer.setPixelRatio(this.renderer.getPixelRatio());
    this.composer.setSize(width, height);
  }
  setQuality(quality: string) {
    this.ao.enabled = quality !== "low";
    this.bloom.enabled = quality !== "low";
  }
  render(delta: number) {
    this.renderer.info.reset();
    this.composer.render(delta);
  }
}

function surfaceMaterial(kind: "grass" | "road" | "plaza" | "terrain") {
  const size = 512;
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = size;
  const context = canvas.getContext("2d")!;
  const data = context.createImageData(size, size);
  const heights = new Float32Array(size * size);
  const base =
    kind === "terrain" ? [235, 235, 235] : kind === "grass"
      ? [94, 111, 68]
      : kind === "road"
        ? [151, 137, 107]
        : [128, 132, 126];
  let seed = 319;
  const random = () => {
    seed = (seed * 1664525 + 1013904223) >>> 0;
    return seed / 4294967296;
  };
  for (let y = 0; y < size; y++)
    for (let x = 0; x < size; x++) {
      const i = y * size + x;
      const fine = (random() - 0.5) * 22;
      const broad =
        Math.sin(x * 0.035) * Math.sin(y * 0.023) * 11 +
        Math.sin((x + y) * 0.091) * 4;
      const seam =
        kind === "plaza" &&
        (x % 64 < 3 || (y + (Math.floor(x / 64) % 2) * 32) % 64 < 3);
      heights[i] = seam ? 0 : 0.5 + (fine + broad) / 75;
      const variation = fine + broad + (seam ? -38 : 0);
      for (let c = 0; c < 3; c++)
        data.data[i * 4 + c] = Math.max(0, Math.min(255, base[c] + variation));
      data.data[i * 4 + 3] = 255;
    }
  context.putImageData(data, 0, 0);
  const normalCanvas = document.createElement("canvas");
  normalCanvas.width = normalCanvas.height = size;
  const nc = normalCanvas.getContext("2d")!,
    nd = nc.createImageData(size, size);
  for (let y = 0; y < size; y++)
    for (let x = 0; x < size; x++) {
      const i = y * size + x,
        h = (xx: number, yy: number) =>
          heights[((yy + size) % size) * size + ((xx + size) % size)];
      const n = new THREE.Vector3(
        (h(x - 1, y) - h(x + 1, y)) * 0.8,
        (h(x, y - 1) - h(x, y + 1)) * 0.8,
        1,
      ).normalize();
      nd.data[i * 4] = (n.x * 0.5 + 0.5) * 255;
      nd.data[i * 4 + 1] = (n.y * 0.5 + 0.5) * 255;
      nd.data[i * 4 + 2] = (n.z * 0.5 + 0.5) * 255;
      nd.data[i * 4 + 3] = 255;
    }
  nc.putImageData(nd, 0, 0);
  const map = new THREE.CanvasTexture(canvas),
    normalMap = new THREE.CanvasTexture(normalCanvas);
  for (const texture of [map, normalMap]) {
    texture.wrapS = texture.wrapT = THREE.RepeatWrapping;
    texture.repeat.set(
      kind === "terrain" ? 1 : kind === "grass" ? 52 : kind === "road" ? 10 : 7,
      kind === "terrain" ? 1 : kind === "grass" ? 52 : kind === "road" ? 10 : 7,
    );
    texture.anisotropy = 8;
  }
  map.colorSpace = THREE.SRGBColorSpace;
  return new THREE.MeshStandardMaterial({
    map,
    normalMap,
    normalScale: new THREE.Vector2(0.32, 0.32),
    roughness: 0.94,
  });
}
