import * as THREE from 'three';

export type CameraPreset = 'orbit' | 'fly-through' | 'side-reveal';

export function cameraPoseAt(preset: CameraPreset, timeSeconds: number, durationSeconds: number, depth: number) {
  const u = THREE.MathUtils.clamp(timeSeconds / Math.max(durationSeconds, 0.001), 0, 1);
  const eased = u * u * (3 - 2 * u);
  const radius = Math.max(7, depth * 0.85);
  const target = new THREE.Vector3(0, 0, 0);
  const up = new THREE.Vector3(0, 1, 0);

  if (preset === 'orbit') {
    const angle = THREE.MathUtils.lerp(-0.18, Math.PI * 0.72, eased);
    return { position: new THREE.Vector3(Math.sin(angle) * radius, 2.4, Math.cos(angle) * radius), target, up };
  }

  if (preset === 'fly-through') {
    const z = THREE.MathUtils.lerp(-depth / 2 - 3, depth / 2 + 3, eased);
    return { position: new THREE.Vector3(0, 0.9, z), target: new THREE.Vector3(0, 0, z + 2.5), up };
  }

  const front = new THREE.Vector3(0, 0.5, radius);
  const side = new THREE.Vector3(0, radius, 0.2);
  const position = front.lerp(side, eased);
  const sideUp = new THREE.Vector3(0, position.z, -position.y).normalize();
  return { position, target, up: sideUp };
}

export function renderFrame(
  renderer: THREE.WebGLRenderer,
  scene: THREE.Scene,
  camera: THREE.PerspectiveCamera,
  preset: CameraPreset,
  timeSeconds: number,
  durationSeconds: number,
  depth: number,
  frameWidth = 4.2,
  frameHeight = 2.36,
  beforeRender?: (camera: THREE.PerspectiveCamera) => void,
): HTMLCanvasElement {
  const pose = cameraPoseAt(preset, timeSeconds, durationSeconds, depth);
  const position = pose.position.clone();
  const distance = position.distanceTo(pose.target);
  const tangent = Math.tan(THREE.MathUtils.degToRad(camera.fov / 2));
  const sphereRadius = Math.sqrt(frameWidth ** 2 + frameHeight ** 2 + depth ** 2) / 2;
  const fitDistance = sphereRadius * 1.15 / Math.max(Math.min(tangent, tangent * camera.aspect), 0.001);
  const fit = Math.max(1, fitDistance / Math.max(distance, 0.001));
  position.sub(pose.target).multiplyScalar(fit).add(pose.target);
  camera.up.copy(pose.up);
  camera.position.copy(position);
  camera.lookAt(pose.target);
  beforeRender?.(camera);
  renderer.render(scene, camera);
  return renderer.domElement;
}
