// The 3D Camp view ("Campfire View"): a real Three.js forest rendered behind
// the 2D hunt loop. Opened from the Camp card's "Enter the deepwood" button.
//
// Design rules:
//  - three.js is LAZY-loaded via dynamic import, so the main game bundle never
//    pays for it; the 2D Phaser loop is untouched while this view is closed.
//  - The scene is derived from the SAME season seed as the 2D forest
//    (src/pois.js): biome of the player's chunk + POI gates in the 3x3 ring.
//    Clicking a gate closes the view and pans the 2D camera to that POI.
//  - No game state changes here; settlement stays on-chain via existing paths.
//
// Verification hooks: window.__camp3d = { open, close, isOpen } for e2e.

import { chunkOf } from './chunks.js';
import { BIOMES, biomeOfChunk, poisAround } from './pois.js';

let active = null; // { renderer, scene, camera, raf, overlay, dispose() }

const CSS = `
#camp3d-overlay{position:fixed;inset:0;z-index:900;background:#0b120c}
#camp3d-overlay canvas{display:block}
#camp3d-vignette{position:absolute;inset:0;pointer-events:none;
  background:radial-gradient(ellipse at center, transparent 55%, rgba(4,10,6,.55) 100%)}
#camp3d-hud{position:absolute;left:18px;top:14px;color:#e8dfc8;text-shadow:0 1px 3px #000;pointer-events:none}
#camp3d-hud h1{margin:0;font-size:20px;letter-spacing:2px;font-family:Georgia,serif}
#camp3d-hud p{margin:4px 0 0;font-size:12px;opacity:.85}
#camp3d-btns{position:absolute;right:14px;top:12px;display:flex;gap:8px}
#camp3d-btns button{background:rgba(10,20,12,.75);color:#e8dfc8;border:1px solid #4a7c59;
  border-radius:8px;padding:7px 12px;font-size:12px;cursor:pointer}
#camp3d-btns button:hover{background:rgba(30,50,34,.85)}
#camp3d-keys{position:absolute;right:16px;bottom:12px;color:#cfc7ad;font-size:11px;opacity:.75;text-shadow:0 1px 2px #000}
#camp3d-poi{position:absolute;left:50%;bottom:18px;transform:translateX(-50%);color:#ffe9b0;
  font-size:13px;text-shadow:0 1px 3px #000;opacity:0;transition:opacity .3s;pointer-events:none}
`;

function ensureStyle() {
  if (document.getElementById('camp3d-style')) return;
  const s = document.createElement('style');
  s.id = 'camp3d-style';
  s.textContent = CSS;
  document.head.appendChild(s);
}

// cheap deterministic value noise (same shape as the prototype)
function noise(x, z) {
  const s = Math.sin(x * 12.9898 + z * 78.233) * 43758.5453;
  return s - Math.floor(s);
}
function groundHeightFn(x, z) {
  const r = Math.hypot(x, z);
  const t = Math.max(0, Math.min(1, 1 - r / 60));
  return ((noise(x * 0.05, z * 0.05) - 0.5) * 3 + (noise(x * 0.15, z * 0.15) - 0.5) * 1.2) * t * t;
}

/**
 * Open the 3D camp view.
 * @param {object} o
 * @param {string} o.seedHex     season seed (same one the 2D forest uses)
 * @param {number} o.playerX     player world x (2D pixels)
 * @param {number} o.playerY     player world y
 * @param {(poi:object) => void} [o.onEnterPOI]  gate clicked → pan 2D camera
 */
export async function openCamp3D(o) {
  if (active) closeCamp3D();
  ensureStyle();
  const THREE = await import('three');
  const { seedHex, playerX, playerY, onEnterPOI } = o;
  const [cx, cy] = chunkOf(playerX, playerY);
  const biomeIdx = biomeOfChunk(seedHex, cx, cy);
  const pois = poisAround(seedHex, playerX, playerY);

  // ---------- DOM ----------
  const overlay = document.createElement('div');
  overlay.id = 'camp3d-overlay';
  overlay.innerHTML = `
    <div id="camp3d-vignette"></div>
    <div id="camp3d-hud"><h1>DEEPWOOD · CAMP</h1><p id="camp3d-biome"></p></div>
    <div id="camp3d-btns">
      <button type="button" id="camp3d-quality" title="Toggle render quality">Quality: High</button>
      <button type="button" id="camp3d-close" title="Back to the forest (Esc)">✕ Back</button>
    </div>
    <div id="camp3d-keys">drag to orbit · wheel to zoom · click a glowing arch to visit</div>
    <div id="camp3d-poi"></div>`;
  document.body.appendChild(overlay);

  // ---------- renderer ----------
  const renderer = new THREE.WebGLRenderer({ antialias: true });
  let highQ = true;
  renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
  renderer.setSize(innerWidth, innerHeight);
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.05;
  overlay.prepend(renderer.domElement);

  const scene = new THREE.Scene();
  scene.fog = new THREE.Fog(0x9db8a0, 30, 130);
  const camera = new THREE.PerspectiveCamera(55, innerWidth / innerHeight, 0.1, 400);

  const hemi = new THREE.HemisphereLight(0xcfe8d8, 0x2a3a24, 0.9);
  scene.add(hemi);
  const sun = new THREE.DirectionalLight(0xfff2d8, 2.2);
  sun.position.set(40, 60, 25);
  sun.castShadow = true;
  sun.shadow.mapSize.set(2048, 2048);
  Object.assign(sun.shadow.camera, { left: -70, right: 70, top: 70, bottom: -70, far: 200 });
  sun.shadow.bias = -0.0004;
  scene.add(sun);

  // ---------- ground ----------
  const G = 220, SEG = 110;
  const groundGeo = new THREE.PlaneGeometry(G, G, SEG, SEG);
  groundGeo.rotateX(-Math.PI / 2);
  {
    const pos = groundGeo.attributes.position;
    for (let i = 0; i < pos.count; i++) {
      const x = pos.getX(i), z = pos.getZ(i);
      pos.setY(i, groundHeightFn(x, z));
    }
    groundGeo.computeVertexNormals();
  }
  const ground = new THREE.Mesh(groundGeo, new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 1 }));
  ground.receiveShadow = true;
  scene.add(ground);
  function recolorGround(b) {
    const pos = groundGeo.attributes.position;
    let col = groundGeo.attributes.color;
    if (!col) {
      col = new THREE.Float32BufferAttribute(new Float32Array(pos.count * 3), 3);
      groundGeo.setAttribute('color', col);
    }
    const c = new THREE.Color();
    for (let i = 0; i < pos.count; i++) {
      const x = pos.getX(i), z = pos.getZ(i), y = pos.getY(i);
      const n = noise(x * 0.3 + 9, z * 0.3 + 4);
      c.setHex(b.ground[Math.floor(n * b.ground.length) % b.ground.length]);
      c.offsetHSL(0, 0, (noise(x, z) - 0.5) * 0.06 + y * 0.008);
      col.setXYZ(i, c.r, c.g, c.b);
    }
    col.needsUpdate = true;
  }

  // ---------- trees (instanced) ----------
  const TREE_N = 420;
  const trunkMesh = new THREE.InstancedMesh(
    new THREE.CylinderGeometry(0.22, 0.34, 2.4, 6),
    new THREE.MeshStandardMaterial({ color: 0x6b4a2f, roughness: 1 }), TREE_N);
  const pineMesh = new THREE.InstancedMesh(
    new THREE.ConeGeometry(1.7, 4.6, 7),
    new THREE.MeshStandardMaterial({ color: 0x2e6b2f, roughness: 0.9, flatShading: true }), TREE_N);
  const pine2Mesh = new THREE.InstancedMesh(
    new THREE.ConeGeometry(1.25, 3.4, 7),
    new THREE.MeshStandardMaterial({ color: 0x3d7d38, roughness: 0.9, flatShading: true }), TREE_N);
  const leafMesh = new THREE.InstancedMesh(
    new THREE.IcosahedronGeometry(1.6, 0),
    new THREE.MeshStandardMaterial({ color: 0x24591f, roughness: 0.9, flatShading: true }), TREE_N);
  for (const m of [trunkMesh, pineMesh, pine2Mesh, leafMesh]) {
    m.castShadow = true; m.receiveShadow = true; scene.add(m);
  }
  const m4 = new THREE.Matrix4(), q4 = new THREE.Quaternion(), v3 = new THREE.Vector3(), s3 = new THREE.Vector3();
  const hide = new THREE.Matrix4().makeScale(0, 0, 0);
  const treeSpots = [];
  {
    let placed = 0, guard = 0;
    while (placed < TREE_N && guard++ < 20000) {
      const x = (noise(placed, 1) - 0.5) * 210;
      const z = (noise(placed, 2) - 0.5) * 210;
      if (Math.hypot(x, z) < 9) continue;
      treeSpots.push({ x, z, y: groundHeightFn(x, z), sc: 0.8 + noise(placed, 3) * 0.9, kind: noise(placed, 4), rot: noise(placed, 5) * Math.PI * 2 });
      placed++;
    }
  }
  function layoutTrees(b) {
    trunkMesh.material.color.setHex(b.trunk);
    leafMesh.material.color.setHex(b.leaf[2]);
    pineMesh.material.color.setHex(b.leaf[0]);
    pine2Mesh.material.color.setHex(b.leaf[1]);
    treeSpots.forEach((t, i) => {
      q4.setFromAxisAngle(v3.set(0, 1, 0), t.rot);
      m4.compose(v3.set(t.x, t.y + 1.2 * t.sc, t.z), q4, s3.set(t.sc, t.sc, t.sc));
      trunkMesh.setMatrixAt(i, m4);
      if (t.kind < 0.55) {
        m4.compose(v3.set(t.x, t.y + 4.4 * t.sc, t.z), q4, s3.set(t.sc, t.sc, t.sc));
        pineMesh.setMatrixAt(i, m4);
        m4.compose(v3.set(t.x, t.y + 6.4 * t.sc, t.z), q4, s3.set(t.sc * 0.9, t.sc * 0.9, t.sc * 0.9));
        pine2Mesh.setMatrixAt(i, m4);
        leafMesh.setMatrixAt(i, hide);
      } else {
        m4.compose(v3.set(t.x, t.y + 3.6 * t.sc, t.z), q4, s3.set(t.sc, t.sc * 0.85, t.sc));
        leafMesh.setMatrixAt(i, m4);
        pineMesh.setMatrixAt(i, hide);
        pine2Mesh.setMatrixAt(i, hide);
      }
    });
    for (const m of [trunkMesh, pineMesh, pine2Mesh, leafMesh]) m.instanceMatrix.needsUpdate = true;
  }

  // ---------- camp props ----------
  const camp = new THREE.Group();
  scene.add(camp);
  const woodMat = new THREE.MeshStandardMaterial({ color: 0x7a5535, roughness: 0.95 });
  const darkWood = new THREE.MeshStandardMaterial({ color: 0x54371f, roughness: 1 });
  {
    const ty = groundHeightFn(-3.4, -1.5);
    const tent = new THREE.Mesh(
      new THREE.CylinderGeometry(0.1, 2.2, 1.6, 3, 1),
      new THREE.MeshStandardMaterial({ color: 0xb8894f, roughness: 0.9, flatShading: true }));
    tent.rotation.y = Math.PI / 2; tent.rotation.z = Math.PI / 2;
    tent.position.set(-3.4, ty + 0.75, -1.5); tent.castShadow = true;
    camp.add(tent);
    const flap = new THREE.Mesh(new THREE.ConeGeometry(0.9, 1.0, 3), darkWood);
    flap.rotation.z = -Math.PI / 2; flap.position.set(-2.55, ty + 0.45, -1.5);
    camp.add(flap);
  }
  let fireLight, flame, flame2, embers;
  {
    const fy = groundHeightFn(0.6, 0.4);
    const ring = new THREE.Group();
    for (let i = 0; i < 8; i++) {
      const st = new THREE.Mesh(new THREE.DodecahedronGeometry(0.16, 0),
        new THREE.MeshStandardMaterial({ color: 0x8a8a8a, roughness: 1, flatShading: true }));
      const a = (i / 8) * Math.PI * 2;
      st.position.set(Math.cos(a) * 0.7, 0.1, Math.sin(a) * 0.7);
      st.castShadow = true; ring.add(st);
    }
    for (let i = 0; i < 3; i++) {
      const log = new THREE.Mesh(new THREE.CylinderGeometry(0.09, 0.09, 1.0, 6), woodMat);
      log.rotation.z = Math.PI / 2.4; log.rotation.y = i * 2.1;
      log.position.y = 0.28; log.castShadow = true; ring.add(log);
    }
    ring.position.set(0.6, fy, 0.4);
    camp.add(ring);
    flame = new THREE.Mesh(new THREE.ConeGeometry(0.32, 0.9, 7), new THREE.MeshBasicMaterial({ color: 0xff9a3d }));
    flame.position.set(0.6, fy + 0.75, 0.4);
    flame2 = new THREE.Mesh(new THREE.ConeGeometry(0.16, 0.55, 6), new THREE.MeshBasicMaterial({ color: 0xffe08a }));
    flame2.position.set(0.6, fy + 0.68, 0.4);
    camp.add(flame, flame2);
    fireLight = new THREE.PointLight(0xff8a3d, 30, 22, 2);
    fireLight.position.set(0.6, fy + 1.2, 0.4);
    camp.add(fireLight);
    const n = 40;
    const eg = new THREE.BufferGeometry();
    const ep = new Float32Array(n * 3);
    for (let i = 0; i < n; i++) { ep[i * 3] = 0.6; ep[i * 3 + 1] = fy + 0.5; ep[i * 3 + 2] = 0.4; }
    eg.setAttribute('position', new THREE.BufferAttribute(ep, 3));
    embers = new THREE.Points(eg, new THREE.PointsMaterial({
      color: 0xffa050, size: 0.09, transparent: true, opacity: 0.9,
      blending: THREE.AdditiveBlending, depthWrite: false }));
    camp.add(embers);
  }
  {
    const seat = new THREE.Mesh(new THREE.CylinderGeometry(0.32, 0.32, 2.2, 8), woodMat);
    seat.rotation.z = Math.PI / 2; seat.position.set(-1.6, groundHeightFn(-1.6, 1.6) + 0.32, 1.6);
    seat.castShadow = true; camp.add(seat);
    const crate = new THREE.Mesh(new THREE.BoxGeometry(0.9, 0.9, 0.9), darkWood);
    crate.position.set(2.6, groundHeightFn(2.6, -1.8) + 0.45, -1.8); crate.rotation.y = 0.4;
    crate.castShadow = true; camp.add(crate);
    const post = new THREE.Mesh(new THREE.CylinderGeometry(0.07, 0.09, 2.6, 6), darkWood);
    post.position.set(2.2, groundHeightFn(2.2, 1.4) + 1.3, 1.4); post.castShadow = true; camp.add(post);
    const lamp = new THREE.Mesh(new THREE.SphereGeometry(0.16, 8, 6),
      new THREE.MeshStandardMaterial({ color: 0xffd98a, emissive: 0xffb347, emissiveIntensity: 2 }));
    lamp.position.set(2.2, groundHeightFn(2.2, 1.4) + 2.55, 1.4); camp.add(lamp);
    const lampLight = new THREE.PointLight(0xffc36b, 8, 9, 2);
    lampLight.position.copy(lamp.position); camp.add(lampLight);
  }

  // ---------- POI gates ----------
  const gates = [];
  {
    pois.forEach((poi, gi) => {
      // map world-px offset into the 3D scene, clamped to the vista ring
      const dx = Math.max(-20, Math.min(20, (poi.x - playerX) / 32));
      const dz = Math.max(-20, Math.min(20, (poi.y - playerY) / 32));
      const g = new THREE.Group();
      const b = BIOMES[biomeIdx];
      const arch = new THREE.Mesh(new THREE.TorusGeometry(1.6, 0.12, 8, 24),
        new THREE.MeshStandardMaterial({ color: 0x777777, emissive: b.glow, emissiveIntensity: 1.6, roughness: 0.6 }));
      arch.position.y = 2.2; arch.castShadow = true;
      arch.userData.poi = poi;
      g.add(arch);
      const glow = new THREE.PointLight(b.glow, 6, 12, 2);
      glow.position.y = 2.2; g.add(glow);
      g.position.set(dx, groundHeightFn(dx, dz), dz);
      scene.add(g); gates.push(g);
      void gi;
    });
  }

  // ---------- fireflies ----------
  const nF = 120;
  const fg = new THREE.BufferGeometry();
  const fp = new Float32Array(nF * 3);
  for (let i = 0; i < nF; i++) {
    fp[i * 3] = (Math.random() - 0.5) * 80;
    fp[i * 3 + 1] = 0.5 + Math.random() * 6;
    fp[i * 3 + 2] = (Math.random() - 0.5) * 80;
  }
  fg.setAttribute('position', new THREE.BufferAttribute(fp, 3));
  const fireflies = new THREE.Points(fg, new THREE.PointsMaterial({
    color: 0xcfff7a, size: 0.12, transparent: true, opacity: 0.85,
    blending: THREE.AdditiveBlending, depthWrite: false }));
  scene.add(fireflies);

  // ---------- biome ----------
  function applyBiome(i) {
    const b = BIOMES[i];
    scene.fog.color.setHex(b.fog);
    scene.fog.far = b.fogFar;
    scene.background = new THREE.Color(b.sky);
    sun.color.setHex(b.light); sun.intensity = b.sun;
    hemi.color.setHex(b.sky); hemi.groundColor.setHex(b.ground[2]);
    document.getElementById('camp3d-biome').textContent = `Biome: ${b.name} · chunk ${cx},${cy}`;
    recolorGround(b); layoutTrees(b);
  }
  applyBiome(biomeIdx);

  // ---------- orbit ----------
  let theta = 2.4, phi = 0.98, radius = 14, dragging = false, pX = 0, pY = 0;
  const target = new THREE.Vector3(0, 1.6, 0);
  const onDown = (e) => { dragging = true; pX = e.clientX; pY = e.clientY; };
  const onUp = () => { dragging = false; };
  const onMove = (e) => {
    if (!dragging) return;
    theta -= (e.clientX - pX) * 0.005;
    phi = Math.max(0.25, Math.min(1.45, phi - (e.clientY - pY) * 0.005));
    pX = e.clientX; pY = e.clientY;
  };
  const onWheel = (e) => { radius = Math.max(7, Math.min(30, radius + e.deltaY * 0.01)); };
  const onResize = () => {
    camera.aspect = innerWidth / innerHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(innerWidth, innerHeight);
  };
  const onKey = (e) => { if (e.key === 'Escape') closeCamp3D(); };
  renderer.domElement.addEventListener('pointerdown', onDown);
  window.addEventListener('pointerup', onUp);
  window.addEventListener('pointermove', onMove);
  window.addEventListener('wheel', onWheel, { passive: true });
  window.addEventListener('resize', onResize);
  window.addEventListener('keydown', onKey);

  // ---------- gate picking ----------
  const ray = new THREE.Raycaster();
  const ndc = new THREE.Vector2();
  const poiLabel = overlay.querySelector('#camp3d-poi');
  let downAt = 0;
  const onTap = (e) => {
    downAt = performance.now();
    void e;
  };
  const onClick = (e) => {
    if (performance.now() - downAt > 250) return; // it was a drag
    const r = renderer.domElement.getBoundingClientRect();
    ndc.set(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1);
    ray.setFromCamera(ndc, camera);
    const hits = ray.intersectObjects(gates.map((g) => g.children[0]), false);
    if (hits.length) {
      const poi = hits[0].object.userData.poi;
      poiLabel.textContent = `⛺ ${poi.name} — returning to the forest…`;
      poiLabel.style.opacity = '1';
      onEnterPOI?.(poi);
      setTimeout(() => closeCamp3D(), 450);
    }
  };
  renderer.domElement.addEventListener('pointerdown', onTap);
  renderer.domElement.addEventListener('click', onClick);

  // ---------- quality toggle ----------
  const qBtn = overlay.querySelector('#camp3d-quality');
  qBtn.addEventListener('click', () => {
    highQ = !highQ;
    qBtn.textContent = `Quality: ${highQ ? 'High' : 'Low'}`;
    renderer.setPixelRatio(highQ ? Math.min(devicePixelRatio, 2) : 1);
    renderer.shadowMap.enabled = highQ;
    sun.castShadow = highQ;
    for (const m of [trunkMesh, pineMesh, pine2Mesh, leafMesh]) {
      m.count = highQ ? TREE_N : Math.floor(TREE_N / 2);
    }
    for (const m of scene.children) if (m.material) m.material.needsUpdate = true;
  });

  overlay.querySelector('#camp3d-close').addEventListener('click', () => closeCamp3D());

  // ---------- loop ----------
  const clock = new THREE.Clock();
  let raf = 0;
  const tick = () => {
    if (!active) return;
    const t = clock.getElapsedTime();
    if (!dragging) theta += 0.0016;
    camera.position.set(
      target.x + radius * Math.sin(phi) * Math.sin(theta),
      target.y + radius * Math.cos(phi),
      target.z + radius * Math.sin(phi) * Math.cos(theta));
    camera.lookAt(target);
    fireLight.intensity = 30 + Math.sin(t * 11) * 6 + Math.sin(t * 23) * 3;
    flame.scale.y = 1 + Math.sin(t * 13) * 0.18;
    flame2.scale.y = 1 + Math.cos(t * 17) * 0.22;
    const ep = embers.geometry.attributes.position;
    for (let i = 0; i < ep.count; i++) {
      let y = ep.getY(i) + 0.02 + Math.sin(t * 3 + i) * 0.004;
      if (y > 3.2) y = 0.5;
      ep.setY(i, y);
      ep.setX(i, 0.6 + Math.sin(t * 2 + i * 1.7) * 0.25);
      ep.setZ(i, 0.4 + Math.cos(t * 1.6 + i) * 0.25);
    }
    ep.needsUpdate = true;
    const fpp = fireflies.geometry.attributes.position;
    for (let i = 0; i < fpp.count; i++) {
      fpp.setX(i, fpp.getX(i) + Math.sin(t * 0.7 + i) * 0.012);
      fpp.setY(i, fpp.getY(i) + Math.cos(t * 0.9 + i * 2) * 0.008);
      fpp.setZ(i, fpp.getZ(i) + Math.cos(t * 0.6 + i * 3) * 0.012);
    }
    fpp.needsUpdate = true;
    for (const g of gates) g.children[0].rotation.y = t * 0.4;
    renderer.render(scene, camera);
    raf = requestAnimationFrame(tick);
  };

  active = {
    renderer, scene, camera, raf,
    dispose() {
      cancelAnimationFrame(raf);
      renderer.domElement.removeEventListener('pointerdown', onDown);
      renderer.domElement.removeEventListener('pointerdown', onTap);
      renderer.domElement.removeEventListener('click', onClick);
      window.removeEventListener('pointerup', onUp);
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('wheel', onWheel);
      window.removeEventListener('resize', onResize);
      window.removeEventListener('keydown', onKey);
      scene.traverse((obj) => {
        if (obj.geometry) obj.geometry.dispose();
        if (obj.material) {
          for (const m of Array.isArray(obj.material) ? obj.material : [obj.material]) m.dispose();
        }
      });
      renderer.dispose();
      overlay.remove();
    },
  };
  tick();
  return active;
}

export function closeCamp3D() {
  if (!active) return;
  const a = active;
  active = null;
  a.dispose();
}

export function isCamp3DOpen() {
  return !!active;
}

// e2e / console hook
if (typeof window !== 'undefined') {
  window.__camp3d = {
    isOpen: isCamp3DOpen,
    close: closeCamp3D,
    open: (o) => openCamp3D(o ?? {
      seedHex: window.__scene?.seasonSeed ?? '0x5eed',
      playerX: window.__scene?.player?.x ?? 0,
      playerY: window.__scene?.player?.y ?? 0,
      onEnterPOI: (poi) => window.__scene?.focusPOI?.(poi),
    }),
  };
}
