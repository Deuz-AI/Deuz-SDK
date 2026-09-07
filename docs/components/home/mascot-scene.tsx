'use client';

import { useEffect, useRef } from 'react';
import {
  AnimationClip,
  AnimationMixer,
  Box3,
  CanvasTexture,
  DataTexture,
  DirectionalLight,
  Group,
  HemisphereLight,
  LoopOnce,
  MathUtils,
  Mesh,
  MeshBasicMaterial,
  MeshToonMaterial,
  NearestFilter,
  Object3D,
  PerspectiveCamera,
  Plane,
  PlaneGeometry,
  Raycaster,
  RedFormat,
  Scene,
  SphereGeometry,
  TorusGeometry,
  Vector2,
  Vector3,
  WebGLRenderer,
  type Material,
} from 'three';
import { GLTFLoader, type GLTF } from 'three/addons/loaders/GLTFLoader.js';

type Props = {
  /** URL of the mascot GLB, or `null` to use the built-in placeholder rig. */
  modelUrl: string | null;
  /** Fires once the first frame of the actual content has been drawn. */
  onReady?: () => void;
  className?: string;
};

const INK = '#000000';
const PAPER = '#ffffff';
const BOB_PERIOD = 1.6;
const HOP_DURATION = 0.55;

/**
 * The 3D mascot. Loads `/mascot/deuz-mascot.glb` (see docs/MASCOT-MODEL.md) and,
 * until that file exists or if it fails to load, shows the logo itself in 3D — the
 * ring and the dot at their 4:1 ratio — driven by the same animation code.
 *
 * Everything lives inside one effect so React 19's StrictMode double-invoke in
 * development tears down and rebuilds a whole stage instead of leaking a context.
 */
export default function MascotScene({ modelUrl, onReady, className }: Props) {
  const hostRef = useRef<HTMLDivElement>(null);
  const onReadyRef = useRef(onReady);

  useEffect(() => {
    onReadyRef.current = onReady;
  });

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const stage = createStage(host, modelUrl, () => onReadyRef.current?.());
    return () => stage.dispose();
  }, [modelUrl]);

  return <div ref={hostRef} className={className} />;
}

type Role = 'ink' | 'paper';

function createStage(host: HTMLElement, modelUrl: string | null, onReady: () => void) {
  let disposed = false;

  const renderer = new WebGLRenderer({
    alpha: true,
    antialias: true,
    powerPreference: 'low-power',
  });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.setClearColor(0x000000, 0);
  renderer.domElement.style.display = 'block';
  host.appendChild(renderer.domElement);

  const scene = new Scene();
  const camera = new PerspectiveCamera(28, 1, 0.1, 100);
  scene.add(new HemisphereLight(0xffffff, 0x8a8a8a, 2.2));
  const key = new DirectionalLight(0xffffff, 1.4);
  key.position.set(-2, 3, 4);
  scene.add(key);

  // Two shared materials. Every part of the mascot is one or the other, so a theme
  // change is two colour assignments — the drawing inverts the way the PNG does.
  const ink = new MeshBasicMaterial({ color: INK });
  const ramp = toonRamp();
  const paper = new MeshToonMaterial({ color: PAPER, gradientMap: ramp });
  const shadowMap = shadowTexture();
  const shadow = new Mesh(
    new PlaneGeometry(1, 1),
    new MeshBasicMaterial({ map: shadowMap, color: INK, transparent: true, depthWrite: false }),
  );
  scene.add(shadow);

  const root = new Group();
  scene.add(root);

  let head: Object3D | null = null;
  let pupil: Object3D | null = null;
  const pupilRest = new Vector3();
  let gazeRadius = 0;
  let mixer: AnimationMixer | null = null;
  let hopClip: AnimationClip | null = null;
  let height = 1;
  let contentReady = false;
  let ready = false;

  // Theme — the `.dark` class on <html>, flipped by the nav toggle.
  function applyTheme() {
    const dark = document.documentElement.classList.contains('dark');
    ink.color.set(dark ? PAPER : INK);
    paper.color.set(dark ? INK : PAPER);
    (shadow.material as MeshBasicMaterial).color.set(dark ? PAPER : INK);
  }
  applyTheme();
  const themeObserver = new MutationObserver(applyTheme);
  themeObserver.observe(document.documentElement, { attributes: true, attributeFilter: ['class'] });

  // Desktop shows the mascot beside the headline, mirrored so the raised finger points at it.
  const desktop = window.matchMedia('(min-width: 1024px)');
  const applyMirror = () => {
    root.scale.x = desktop.matches ? -1 : 1;
  };
  desktop.addEventListener('change', applyMirror);

  // Gaze — the pupil follows the pointer anywhere on the page.
  const raycaster = new Raycaster();
  const pointer = new Vector2();
  const gazePlane = new Plane(new Vector3(0, 0, 1), 0);
  const hit = new Vector3();
  const headWorld = new Vector3();
  const gazeTarget = new Vector3();
  let hasPointer = false;
  const onPointerMove = (event: PointerEvent) => {
    const rect = renderer.domElement.getBoundingClientRect();
    if (!rect.width || !rect.height) return;
    pointer.set(
      ((event.clientX - rect.left) / rect.width) * 2 - 1,
      -((event.clientY - rect.top) / rect.height) * 2 + 1,
    );
    hasPointer = true;
  };
  window.addEventListener('pointermove', onPointerMove, { passive: true });

  // One small hop on entrance and on click.
  let hopStart = -1;
  let elapsed = 0;
  const onClick = () => {
    if (mixer && hopClip) {
      const action = mixer.clipAction(hopClip);
      action.reset().setLoop(LoopOnce, 1);
      action.clampWhenFinished = false;
      action.play();
    } else {
      hopStart = elapsed;
    }
  };
  host.addEventListener('click', onClick);

  function frameCamera() {
    const hostWidth = host.clientWidth;
    const hostHeight = host.clientHeight;
    if (!hostWidth || !hostHeight || !contentReady) return;
    renderer.setSize(hostWidth, hostHeight);
    camera.aspect = hostWidth / hostHeight;

    const box = new Box3().setFromObject(root);
    const size = box.getSize(new Vector3());
    const center = box.getCenter(new Vector3());
    const halfFov = MathUtils.degToRad(camera.fov / 2);
    const fitHeight = size.y / 2 / Math.tan(halfFov);
    const fitWidth = size.x / 2 / (Math.tan(halfFov) * camera.aspect);
    const distance = Math.max(fitHeight, fitWidth) * 1.14 + size.z / 2;
    camera.position.set(center.x, center.y, center.z + distance);
    camera.lookAt(center);
    camera.updateProjectionMatrix();
  }

  function setContent(object: Object3D, clips: AnimationClip[]) {
    if (disposed) {
      disposeObject(object);
      return;
    }
    root.add(object);

    // Stand it on the ground plane, centred, and size the shadow to it.
    const box = new Box3().setFromObject(object);
    const size = box.getSize(new Vector3());
    const center = box.getCenter(new Vector3());
    object.position.sub(center);
    object.position.y += size.y / 2;
    height = size.y;
    shadow.scale.set(size.x * 1.25, size.x * 0.3, 1);
    shadow.position.set(0, 0, -size.z / 2 - 0.05);

    head = object.getObjectByName('Head') ?? null;
    pupil = object.getObjectByName('Pupil') ?? null;
    if (head && pupil) {
      pupilRest.copy(pupil.position);
      const headSize = new Box3().setFromObject(head).getSize(new Vector3());
      gazeRadius = Math.min(headSize.x, headSize.y) * 0.16;
    }

    if (clips.length > 0) {
      mixer = new AnimationMixer(object);
      const idle = AnimationClip.findByName(clips, 'Idle');
      const point = AnimationClip.findByName(clips, 'Point');
      hopClip = AnimationClip.findByName(clips, 'Hop') ?? null;
      if (idle) mixer.clipAction(idle).play();
      if (point) {
        const action = mixer.clipAction(point);
        action.setLoop(LoopOnce, 1);
        action.clampWhenFinished = true;
        action.play();
      }
    }

    contentReady = true;
    applyMirror();
    frameCamera();
    hopStart = 0;
    start();
  }

  function update(dt: number) {
    elapsed += dt;
    if (mixer) {
      mixer.update(dt);
      root.position.y = 0;
      root.rotation.y = 0;
    } else {
      root.position.y = Math.sin((elapsed / BOB_PERIOD) * Math.PI * 2) * height * 0.015;
      root.rotation.y = Math.sin(elapsed * 0.7) * MathUtils.degToRad(6);
    }

    if (hopStart >= 0) {
      const progress = (elapsed - hopStart) / HOP_DURATION;
      if (progress >= 1) {
        hopStart = -1;
        root.scale.y = 1;
      } else {
        root.position.y += Math.sin(progress * Math.PI) * height * 0.06;
        root.scale.y = 1 + Math.sin(progress * Math.PI * 2) * 0.04;
      }
    }

    if (head && pupil) {
      if (hasPointer) {
        raycaster.setFromCamera(pointer, camera);
        head.getWorldPosition(headWorld);
        gazePlane.constant = -headWorld.z;
        if (raycaster.ray.intersectPlane(gazePlane, hit)) {
          head.worldToLocal(hit);
          gazeTarget.copy(hit).sub(pupilRest);
          gazeTarget.z = 0;
          if (gazeTarget.length() > gazeRadius) gazeTarget.setLength(gazeRadius);
          gazeTarget.add(pupilRest);
        } else {
          gazeTarget.copy(pupilRest);
        }
      } else {
        gazeTarget.copy(pupilRest);
      }
      pupil.position.lerp(gazeTarget, 1 - Math.exp(-dt * 10));
    }
  }

  // Render loop — only while the hero is on screen and the tab is visible.
  let raf = 0;
  let running = false;
  let inView = true;
  let last = 0;
  const shouldRun = () =>
    contentReady && inView && document.visibilityState === 'visible' && !disposed;
  const tick = (now: number) => {
    if (!running) return;
    raf = requestAnimationFrame(tick);
    const dt = last ? Math.min((now - last) / 1000, 0.1) : 0;
    last = now;
    update(dt);
    renderer.render(scene, camera);
    if (!ready) {
      ready = true;
      onReady();
    }
  };
  function start() {
    if (running || !shouldRun()) return;
    running = true;
    last = 0;
    raf = requestAnimationFrame(tick);
  }
  function stop() {
    if (!running) return;
    running = false;
    cancelAnimationFrame(raf);
  }
  const onVisibility = () => (document.visibilityState === 'visible' ? start() : stop());
  document.addEventListener('visibilitychange', onVisibility);
  const intersection = new IntersectionObserver(([entry]) => {
    inView = Boolean(entry?.isIntersecting);
    if (inView) start();
    else stop();
  });
  intersection.observe(host);
  const resize = new ResizeObserver(() => frameCamera());
  resize.observe(host);

  // Content.
  if (modelUrl) {
    new GLTFLoader().load(
      modelUrl,
      (gltf: GLTF) => {
        if (disposed) {
          disposeObject(gltf.scene);
          return;
        }
        retargetMaterials(gltf.scene);
        setContent(gltf.scene, gltf.animations);
      },
      undefined,
      () => {
        if (!disposed) setContent(placeholderRig(), []);
      },
    );
  } else {
    setContent(placeholderRig(), []);
  }

  /** The logo in 3D: ring, domed face and pupil at the brand's 4:1 ratio, named like the GLB contract. */
  function placeholderRig(): Object3D {
    const headGroup = new Group();
    headGroup.name = 'Head';
    const ring = new Mesh(new TorusGeometry(1, 0.125, 24, 96), ink);
    const face = new Mesh(new SphereGeometry(0.96, 48, 24), paper);
    face.scale.z = 0.3;
    face.position.z = -0.14;
    const dot = new Mesh(new SphereGeometry(0.25, 32, 16), ink);
    dot.name = 'Pupil';
    dot.position.z = 0.16;
    headGroup.add(face, ring, dot);
    const rig = new Group();
    rig.add(headGroup);
    return rig;
  }

  /** Swap whatever Blender exported for the two shared materials, by name first, by lightness otherwise. */
  function retargetMaterials(object: Object3D) {
    object.traverse((child) => {
      const mesh = child as Partial<Mesh>;
      if (!mesh.isMesh || !mesh.material) return;
      const materials = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
      const replaced = materials.map((material) => {
        const role = roleOf(material);
        disposeMaterial(material);
        return role === 'ink' ? ink : paper;
      });
      (child as Mesh).material = Array.isArray(mesh.material) ? replaced : replaced[0]!;
    });
  }

  function dispose() {
    disposed = true;
    stop();
    themeObserver.disconnect();
    intersection.disconnect();
    resize.disconnect();
    desktop.removeEventListener('change', applyMirror);
    window.removeEventListener('pointermove', onPointerMove);
    document.removeEventListener('visibilitychange', onVisibility);
    host.removeEventListener('click', onClick);
    mixer?.stopAllAction();
    disposeObject(scene);
    ink.dispose();
    paper.dispose();
    ramp.dispose();
    shadowMap.dispose();
    (shadow.material as Material).dispose();
    renderer.dispose();
    renderer.forceContextLoss();
    renderer.domElement.remove();
  }

  return { dispose };
}

function roleOf(material: Material): Role {
  const name = material.name.toLowerCase();
  if (name.includes('ink')) return 'ink';
  if (name.includes('paper')) return 'paper';
  const color = (material as { color?: { r: number; g: number; b: number } }).color;
  if (!color) return 'ink';
  const luminance = 0.2126 * color.r + 0.7152 * color.g + 0.0722 * color.b;
  return luminance < 0.5 ? 'ink' : 'paper';
}

function disposeMaterial(material: Material) {
  const map = (material as { map?: { dispose(): void } | null }).map;
  map?.dispose();
  material.dispose();
}

/** Geometry only — materials are shared and owned by the stage. */
function disposeObject(object: Object3D) {
  object.traverse((child) => {
    const mesh = child as Partial<Mesh>;
    if (mesh.isMesh) mesh.geometry?.dispose();
  });
}

/** Three hard steps: a cel-shaded terminator instead of a smooth gradient. */
function toonRamp() {
  const texture = new DataTexture(new Uint8Array([150, 215, 255]), 3, 1, RedFormat);
  texture.minFilter = NearestFilter;
  texture.magFilter = NearestFilter;
  texture.needsUpdate = true;
  return texture;
}

/** A soft white disc with alpha; the material tints it with the current ink colour. */
function shadowTexture() {
  const canvas = document.createElement('canvas');
  canvas.width = 256;
  canvas.height = 256;
  const context = canvas.getContext('2d');
  if (context) {
    const gradient = context.createRadialGradient(128, 128, 0, 128, 128, 128);
    gradient.addColorStop(0, 'rgba(255,255,255,0.34)');
    gradient.addColorStop(0.55, 'rgba(255,255,255,0.12)');
    gradient.addColorStop(1, 'rgba(255,255,255,0)');
    context.fillStyle = gradient;
    context.fillRect(0, 0, 256, 256);
  }
  return new CanvasTexture(canvas);
}
