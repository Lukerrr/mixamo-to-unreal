// 3D preview of a converted FBX: skinned mesh (or skeleton), root marker and root path.
// three.js is loaded on first use only.

let lib;
async function loadThree() {
  if (!lib) {
    const [THREE, { FBXLoader }, { OrbitControls }] = await Promise.all([
      import('three'),
      import('three/addons/loaders/FBXLoader.js'),
      import('three/addons/controls/OrbitControls.js'),
    ]);
    lib = { THREE, FBXLoader, OrbitControls };
  }
  return lib;
}

const css = (name) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();

export async function createPreview(container) {
  const { THREE, FBXLoader, OrbitControls } = await loadThree();

  const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
  renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
  container.append(renderer.domElement);

  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(35, 1, 1, 20000);
  const controls = new OrbitControls(camera, renderer.domElement);
  controls.enableDamping = true;
  controls.enablePan = false;

  scene.add(new THREE.HemisphereLight(0xffffff, 0x2a2622, 2.2));
  const sun = new THREE.DirectionalLight(0xffffff, 1.6);
  sun.position.set(200, 400, 300);
  scene.add(sun);

  const accent = new THREE.Color(css('--accent') || '#ff8a5c');
  const soft = new THREE.Color(css('--soft') || '#8f8a83');
  const grid = new THREE.GridHelper(2000, 40, new THREE.Color(css('--line') || '#2e2c29'), new THREE.Color(css('--line') || '#2e2c29'));
  scene.add(grid);

  // Root marker: a ring on the floor plus a small arrow pointing where the root faces
  const marker = new THREE.Group();
  const ring = new THREE.Mesh(
    new THREE.RingGeometry(14, 18, 48),
    new THREE.MeshBasicMaterial({ color: accent, side: THREE.DoubleSide }),
  );
  ring.rotation.x = -Math.PI / 2;
  const arrow = new THREE.Mesh(new THREE.ConeGeometry(6, 14, 16), new THREE.MeshBasicMaterial({ color: accent }));
  arrow.rotation.x = Math.PI / 2;
  arrow.position.set(0, 0, 28);
  marker.add(ring, arrow);
  marker.position.y = 0.5;
  scene.add(marker);

  // Axes gizmo in the corner, turns together with the camera
  const GIZMO = 110;
  const gizmoScene = new THREE.Scene();
  const gizmoCam = new THREE.OrthographicCamera(-1.6, 1.6, 1.6, -1.6, 0.1, 10);
  const axes = [
    ['X', new THREE.Vector3(1, 0, 0), '#ff6b6f'],
    ['Y', new THREE.Vector3(0, 1, 0), '#5cc98e'],
    ['Z', new THREE.Vector3(0, 0, 1), '#5b9dff'],
  ];
  for (const [name, dir, color] of axes) {
    const c = new THREE.Color(color);
    gizmoScene.add(new THREE.Line(
      new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(), dir.clone().multiplyScalar(0.95)]),
      new THREE.LineBasicMaterial({ color: c }),
    ));
    const tip = new THREE.Mesh(new THREE.ConeGeometry(0.09, 0.28, 12), new THREE.MeshBasicMaterial({ color: c }));
    tip.position.copy(dir).multiplyScalar(1.0);
    tip.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), dir);
    gizmoScene.add(tip);
    const canvas = document.createElement('canvas');
    canvas.width = canvas.height = 64;
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = color;
    ctx.font = '600 40px "DM Sans", system-ui, sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(name, 32, 34);
    const label = new THREE.Sprite(new THREE.SpriteMaterial({ map: new THREE.CanvasTexture(canvas), depthTest: false }));
    label.position.copy(dir).multiplyScalar(1.38);
    label.scale.setScalar(0.5);
    gizmoScene.add(label);
  }

  let model, mixer, rootBone, skeletonHelper, joints, trail, lastRoot;
  const clock = new THREE.Clock();
  const tmp = new THREE.Vector3();
  const quat = new THREE.Quaternion();
  const fwd = new THREE.Vector3();

  function clear() {
    for (const o of [model, skeletonHelper, joints, trail]) if (o) scene.remove(o);
    model = mixer = rootBone = skeletonHelper = joints = trail = lastRoot = null;
  }

  function bonesOf(obj) {
    const bones = [];
    obj.traverse((o) => { if (o.isBone) bones.push(o); });
    return bones;
  }

  function show(bytes) {
    clear();
    const buffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
    model = new FBXLoader().parse(buffer, '');
    let hasMesh = false;
    const skin = new THREE.MeshStandardMaterial({ color: 0xbdb6ac, roughness: 0.85, metalness: 0 });
    model.traverse((o) => {
      if (o.isMesh) { hasMesh = true; o.material = skin; o.frustumCulled = false; }
    });
    scene.add(model);

    const bones = bonesOf(model);
    rootBone = bones.find((b) => b.name === 'root') || bones[0];

    // Skeleton is always drawn, on top of the mesh when there is one
    skeletonHelper = new THREE.SkeletonHelper(model);
    skeletonHelper.material.vertexColors = false;
    skeletonHelper.material.color = hasMesh ? accent.clone() : soft.clone().lerp(new THREE.Color(0xffffff), 0.5);
    skeletonHelper.material.depthTest = false;
    skeletonHelper.material.transparent = true;
    skeletonHelper.material.opacity = hasMesh ? 0.9 : 1;
    skeletonHelper.renderOrder = 10;
    scene.add(skeletonHelper);
    joints = new THREE.Points(
      new THREE.BufferGeometry().setAttribute('position', new THREE.BufferAttribute(new Float32Array(bones.length * 3), 3)),
      new THREE.PointsMaterial({ color: hasMesh ? accent : 0xffffff, size: hasMesh ? 3 : 4, sizeAttenuation: false, depthTest: false, transparent: true }),
    );
    joints.userData.bones = bones;
    joints.frustumCulled = false;
    joints.renderOrder = 11;
    scene.add(joints);

    mixer = new THREE.AnimationMixer(model);
    const clip = model.animations[0];
    if (clip) mixer.clipAction(clip).play();

    // Sample the root path once over the whole clip
    const points = [];
    const box = new THREE.Box3();
    const steps = clip ? Math.max(2, Math.min(600, Math.ceil(clip.duration * 30))) : 1;
    for (let i = 0; i <= steps; i++) {
      if (clip) mixer.setTime((clip.duration * i) / steps);
      model.updateMatrixWorld(true);
      rootBone.getWorldPosition(tmp);
      points.push(new THREE.Vector3(tmp.x, 0.6, tmp.z));
      if (i === 0) for (const b of bones) box.expandByPoint(b.getWorldPosition(tmp));
    }
    trail = new THREE.Line(
      new THREE.BufferGeometry().setFromPoints(points),
      new THREE.LineBasicMaterial({ color: accent, transparent: true, opacity: 0.45 }),
    );
    scene.add(trail);
    mixer.setTime(0);
    model.updateMatrixWorld(true);

    // Frame the character from a 3/4 front view
    const size = box.getSize(new THREE.Vector3());
    const center = box.getCenter(new THREE.Vector3());
    const h = Math.max(size.y, 100);
    controls.target.copy(center);
    camera.position.set(center.x + h * 1.1, center.y + h * 0.35, center.z + h * 2.1);
    controls.update();
    lastRoot = rootBone.getWorldPosition(new THREE.Vector3());
    clock.getDelta();
  }

  function frame() {
    const dt = Math.min(clock.getDelta(), 0.1);
    if (mixer) {
      mixer.update(dt);
      model.updateMatrixWorld(true);
      rootBone.getWorldPosition(tmp);
      marker.position.set(tmp.x, 0.5, tmp.z);
      rootBone.getWorldQuaternion(quat);
      fwd.set(0, 0, 1).applyQuaternion(quat);
      marker.rotation.y = Math.atan2(fwd.x, fwd.z);
      // Camera follows the root so walking animations stay in view
      const dx = tmp.x - lastRoot.x, dz = tmp.z - lastRoot.z;
      camera.position.x += dx; camera.position.z += dz;
      controls.target.x += dx; controls.target.z += dz;
      lastRoot.copy(tmp);
      if (joints) {
        const pos = joints.geometry.attributes.position;
        joints.userData.bones.forEach((b, i) => { b.getWorldPosition(tmp); pos.setXYZ(i, tmp.x, tmp.y, tmp.z); });
        pos.needsUpdate = true;
      }
    }
    controls.update();
    renderer.render(scene, camera);

    gizmoCam.position.copy(camera.position).sub(controls.target).normalize().multiplyScalar(4);
    gizmoCam.quaternion.copy(camera.quaternion);
    const w = container.clientWidth;
    renderer.autoClear = false;
    renderer.clearDepth();
    renderer.setScissorTest(true);
    renderer.setScissor(w - GIZMO, 0, GIZMO, GIZMO);
    renderer.setViewport(w - GIZMO, 0, GIZMO, GIZMO);
    renderer.render(gizmoScene, gizmoCam);
    renderer.setScissorTest(false);
    renderer.setViewport(0, 0, w, container.clientHeight);
    renderer.autoClear = true;
  }

  function resize() {
    const w = container.clientWidth, h = container.clientHeight;
    if (!w || !h) return;
    renderer.setSize(w, h, false);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
  }
  const ro = new ResizeObserver(resize);
  ro.observe(container);
  resize();
  renderer.setAnimationLoop(frame);

  return {
    show,
    dispose() {
      clear();
      ro.disconnect();
      renderer.setAnimationLoop(null);
      renderer.dispose();
      renderer.domElement.remove();
    },
  };
}
