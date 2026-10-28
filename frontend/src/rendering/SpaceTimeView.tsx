import { forwardRef, useEffect, useImperativeHandle, useRef } from 'react';
import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import type { ProcessedVideo } from '../services/api';
import { timeCoordinate } from './mapping';
import { cameraPoseAt, renderFrame, type CameraPreset } from './camera';
import { sliceOpacityScale, sliceRenderOrder, stableTimeSide, type TimeSide } from './transparency';
import { createVolumeMaterial } from './volume';

type Props = {
  data: ProcessedVideo | null; mode: 'subject' | 'full'; renderStyle: 'planes' | 'volume'; spacing: number;
  opacity: number; showAxis: boolean; showPlane: boolean; background: string;
  cameraPreset: CameraPreset; cameraPlaying: boolean; onCameraStop: () => void;
  cameraLoop: boolean; playbackTime: number; onPlaybackTime: (time: number) => void;
  videoProgress: number;
  onFps: (fps: number) => void;
};

export type SpaceTimeViewHandle = {
  beginExport: (width: number, height: number, signal: AbortSignal) => Promise<void>;
  renderExportFrame: (timeSeconds: number, preset: CameraPreset) => Promise<Blob>;
  endExport: () => void;
};

function updateSliceView(group: THREE.Group, position: THREE.Vector3, target: THREE.Vector3,
  sideState: { current: TimeSide }, mode: Props['mode'], opacity: number) {
  const direction = position.clone().sub(target);
  const signedFacing = direction.z / Math.max(direction.length(), 0.001);
  sideState.current = stableTimeSide(sideState.current, signedFacing);
  const opacityScale = sliceOpacityScale(signedFacing);
  const count = group.children.length;
  const baseOpacity = mode === 'full' ? opacity : Math.min(1, opacity + 0.12);
  for (const child of group.children) {
    const mesh = child as THREE.Mesh;
    if (mesh.userData.isVolume) continue;
    mesh.renderOrder = sliceRenderOrder(mesh.userData.frameIndex, count, sideState.current);
    (mesh.material as THREE.MeshBasicMaterial).opacity = baseOpacity * opacityScale;
  }
}

function updateVolumeProgress(group: THREE.Group, progress: number) {
  // Scrubbing moves the time boundary without rebuilding or widening the cube.
  const volume = group.children.find((child) => child.userData.isVolume) as THREE.Mesh | undefined;
  if (volume) (volume.material as THREE.RawShaderMaterial).uniforms.uProgress.value = THREE.MathUtils.clamp(progress, 0, 1);
}

function disposeMaterial(material: THREE.Material) {
  const uniforms = (material as THREE.RawShaderMaterial).uniforms;
  const textures = new Set<THREE.Texture | undefined>([
    (material as THREE.MeshBasicMaterial).map ?? undefined,
    uniforms?.uVolume?.value, uniforms?.uFullVolume?.value,
  ]);
  textures.forEach((texture) => texture?.dispose());
  material.dispose();
}

function updateVolumeCamera(group: THREE.Group, camera: THREE.PerspectiveCamera) {
  const volume = group.children.find((child) => child.userData.isVolume) as THREE.Mesh | undefined;
  if (!volume) return;
  const material = volume.material as THREE.RawShaderMaterial;
  const local = volume.worldToLocal(camera.position.clone());
  const { width, height, depth } = volume.userData.dimensions as { width: number; height: number; depth: number };
  (material.uniforms.uCameraLocal.value as THREE.Vector3).set(local.x / width + 0.5, local.y / height + 0.5, local.z / depth + 0.5);
}

function updateGridOpacity(axis: THREE.Group, camera: THREE.PerspectiveCamera, target: THREE.Vector3) {
  const grid = axis.getObjectByName('time-grid') as THREE.GridHelper | undefined;
  if (!grid) return;
  const distance = camera.position.distanceTo(target);
  const opacity = THREE.MathUtils.clamp(0.012 + (distance - 4) * 0.003, 0.012, 0.045);
  (grid.material as THREE.Material & { opacity: number }).opacity = opacity;
}

const SpaceTimeView = forwardRef<SpaceTimeViewHandle, Props>(function SpaceTimeView({ data, mode, renderStyle, spacing, opacity, showAxis, showPlane, background, cameraPreset, cameraPlaying, onCameraStop, cameraLoop, playbackTime, onPlaybackTime, videoProgress, onFps }, ref) {
  const host = useRef<HTMLDivElement>(null);
  const state = useRef<{ scene: THREE.Scene; camera: THREE.PerspectiveCamera; renderer: THREE.WebGLRenderer; controls: OrbitControls; group: THREE.Group; axis: THREE.Group; plane: THREE.Mesh | null } | null>(null);
  const exporting = useRef(false);
  const loadedScene = useRef<{ key: string | null; count: number; error?: string }>({ key: null, count: 0 });
  const sceneIdentity = useRef<{ data: ProcessedVideo | null; mode: Props['mode']; renderStyle: Props['renderStyle'] }>({ data: null, mode: 'subject', renderStyle: 'planes' });
  const sceneRevision = useRef(0);
  const exportSnapshot = useRef<{ size: THREE.Vector2; pixelRatio: number; position: THREE.Vector3; quaternion: THREE.Quaternion; up: THREE.Vector3; target: THREE.Vector3; enabled: boolean; aspect: number } | null>(null);
  const renderSettings = useRef({ spacing, opacity, showAxis, showPlane, background, mode, renderStyle, videoProgress });
  const timeSide = useRef<TimeSide>(1);
  const initialAspect = data ? data.width / data.height : 16 / 9;
  const initialFrameWidth = Math.min(5, 4.2 * initialAspect);
  const playback = useRef({ preset: cameraPreset, playing: cameraPlaying, loop: cameraLoop, time: playbackTime, duration: 0, depth: 0, frameWidth: initialFrameWidth, frameHeight: initialFrameWidth / initialAspect, onStop: onCameraStop, onTime: onPlaybackTime });
  const playbackStart = useRef<number | null>(null);
  const playbackOffset = useRef(0);
  const lastPlaybackUpdate = useRef(0);
  renderSettings.current = { spacing, opacity, showAxis, showPlane, background, mode, renderStyle, videoProgress };
  const frameAspect = data ? data.width / data.height : 16 / 9;
  const frameWidth = Math.min(5, 4.2 * frameAspect);
  const frameHeight = frameWidth / frameAspect;
  if (sceneIdentity.current.data !== data || sceneIdentity.current.mode !== mode || sceneIdentity.current.renderStyle !== renderStyle) {
    sceneIdentity.current = { data, mode, renderStyle };
    sceneRevision.current += 1;
  }
  const sceneKey = data ? `${data.sessionId}:${mode}:${renderStyle}:${sceneRevision.current}` : null;
  playback.current = { preset: cameraPreset, playing: cameraPlaying, loop: cameraLoop, time: playbackTime, duration: data ? data.frameCount / data.sampleFps : 0, depth: data ? (renderStyle === 'volume' ? frameHeight : Math.max(0, data.frameCount - 1) * spacing) : 0, frameWidth, frameHeight, onStop: onCameraStop, onTime: onPlaybackTime };

  useEffect(() => {
    if (!host.current) return;
    let renderer: THREE.WebGLRenderer;
    try { renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false, preserveDrawingBuffer: true }); }
    catch { host.current.innerHTML = '<div class="webgl-error">当前浏览器无法创建 WebGL 画布，请使用最新版 Chrome。</div>'; return; }
    const scene = new THREE.Scene(); scene.background = new THREE.Color(background);
    const camera = new THREE.PerspectiveCamera(40, 1, 0.1, 1000); camera.position.set(4.8, 3.5, 7.5);
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 1.5)); renderer.outputColorSpace = THREE.SRGBColorSpace;
    renderer.domElement.className = 'three-canvas'; host.current.appendChild(renderer.domElement);
    const controls = new OrbitControls(camera, renderer.domElement); controls.enableDamping = true;
    const resetView = () => { camera.position.set(4.8, 3.5, 7.5); controls.target.set(0, 0, 0); controls.update(); };
    window.addEventListener('st-reset-view', resetView);
    const group = new THREE.Group(); scene.add(group);
    const axis = new THREE.Group(); scene.add(axis);
    const plane = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.045, side: THREE.DoubleSide, depthWrite: false }));
    scene.add(plane);
    const grid = new THREE.GridHelper(8, 16, 0x526276, 0x283241); grid.name = 'time-grid'; grid.rotation.x = Math.PI / 2; grid.position.z = -0.01;
    const gridMaterial = grid.material as THREE.LineBasicMaterial; gridMaterial.transparent = true; gridMaterial.depthWrite = false; axis.add(grid);
    const axisLine = new THREE.Line(new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(-4.4, -1.95, 0), new THREE.Vector3(4.4, -1.95, 0)]), new THREE.LineBasicMaterial({ color: 0x68cfff })); axis.add(axisLine);
    let disposed = false;
    const resize = () => { if (!host.current) return; const w = host.current.clientWidth; const h = host.current.clientHeight; camera.aspect = w / Math.max(h, 1); camera.updateProjectionMatrix(); renderer.setSize(w, h); };
    const observer = new ResizeObserver(resize); observer.observe(host.current); resize();
    let frames = 0;
    let fpsTime = performance.now();
    const animate = (now: number) => {
      if (disposed) return;
      if (exporting.current) { requestAnimationFrame(animate); return; }
      const motion = playback.current;
      if (motion.playing && motion.duration > 0) {
        playbackStart.current ??= now;
        const elapsedRaw = playbackOffset.current + (now - playbackStart.current) / 1000;
        const elapsed = motion.loop ? elapsedRaw % motion.duration : Math.min(elapsedRaw, motion.duration);
        updateVolumeProgress(group, renderSettings.current.videoProgress);
        const pose = cameraPoseAt(motion.preset, elapsed, motion.duration, motion.depth);
        controls.target.copy(pose.target);
        updateSliceView(group, pose.position, pose.target, timeSide, renderSettings.current.mode, renderSettings.current.opacity);
        renderFrame(renderer, scene, camera, motion.preset, elapsed, motion.duration, motion.depth, motion.frameWidth, motion.frameHeight,
          (activeCamera) => { updateGridOpacity(axis, activeCamera, controls.target); updateVolumeCamera(group, activeCamera); });
        if (now - lastPlaybackUpdate.current >= 100) { motion.onTime(elapsed); lastPlaybackUpdate.current = now; }
        if (!motion.loop && elapsedRaw >= motion.duration) {
          motion.onTime(motion.duration);
          motion.playing = false; controls.enabled = true; playbackStart.current = null; motion.onStop();
        }
      } else {
        updateVolumeProgress(group, renderSettings.current.videoProgress);
        controls.update(); updateGridOpacity(axis, camera, controls.target); updateSliceView(group, camera.position, controls.target, timeSide, renderSettings.current.mode, renderSettings.current.opacity);
        updateVolumeCamera(group, camera); renderer.render(scene, camera);
      }
      frames += 1;
      if (now - fpsTime >= 1000) { onFps(Math.round(frames * 1000 / (now - fpsTime))); frames = 0; fpsTime = now; }
      requestAnimationFrame(animate);
    };
    requestAnimationFrame(animate);
    state.current = { scene, camera, renderer, controls, group, axis, plane };
    return () => { disposed = true; window.removeEventListener('st-reset-view', resetView); observer.disconnect(); controls.dispose(); renderer.dispose(); group.traverse((obj) => { const mesh = obj as THREE.Mesh; mesh.geometry?.dispose(); const mats = Array.isArray(mesh.material) ? mesh.material : [mesh.material]; mats.forEach((mat) => { if (mat) disposeMaterial(mat); }); }); scene.clear(); renderer.domElement.remove(); state.current = null; };
  }, []);

  useImperativeHandle(ref, () => ({
    async beginExport(width, height, signal) {
      const current = state.current;
      if (!current || !data) throw new Error('请先生成时空场景。');
      const deadline = Date.now() + 30000;
      const expectedKey = sceneKey;
      while (loadedScene.current.key !== expectedKey || loadedScene.current.count < data.frameCount) {
        if (signal.aborted) throw new DOMException('导出已取消。', 'AbortError');
        if (loadedScene.current.key === expectedKey && loadedScene.current.error) throw new Error(loadedScene.current.error);
        if (Date.now() >= deadline) throw new Error('预览纹理仍未全部载入，请等待后重试。');
        await new Promise((resolve) => window.setTimeout(resolve, 100));
      }
      if (signal.aborted) throw new DOMException('导出已取消。', 'AbortError');
      const { renderer, camera, controls } = current;
      exportSnapshot.current = {
        size: renderer.getSize(new THREE.Vector2()), pixelRatio: renderer.getPixelRatio(),
        position: camera.position.clone(), quaternion: camera.quaternion.clone(),
        up: camera.up.clone(), target: controls.target.clone(), enabled: controls.enabled, aspect: camera.aspect,
      };
      exporting.current = true; controls.enabled = false;
      renderer.setPixelRatio(1); renderer.setSize(width, height, false);
      camera.aspect = width / height; camera.updateProjectionMatrix();
    },
    async renderExportFrame(timeSeconds, preset) {
      const current = state.current;
      if (!current || !data || !exporting.current) throw new Error('导出画布尚未准备好。');
      const sceneDepth = renderStyle === 'volume' ? frameHeight : Math.max(0, data.frameCount - 1) * spacing;
      const pose = cameraPoseAt(preset, timeSeconds, data.frameCount / data.sampleFps, sceneDepth);
      updateVolumeProgress(current.group, timeSeconds / (data.frameCount / data.sampleFps));
      updateSliceView(current.group, pose.position, pose.target, timeSide, mode, renderSettings.current.opacity);
      renderFrame(current.renderer, current.scene, current.camera, preset, timeSeconds,
        data.frameCount / data.sampleFps, sceneDepth, frameWidth, frameHeight,
        (activeCamera) => { updateGridOpacity(current.axis, activeCamera, pose.target); updateVolumeCamera(current.group, activeCamera); });
      return new Promise((resolve, reject) => current.renderer.domElement.toBlob((blob) => {
        if (blob) resolve(blob); else reject(new Error('无法读取 WebGL 画布图像。'));
      }, 'image/png'));
    },
    endExport() {
      const current = state.current;
      const snapshot = exportSnapshot.current;
      if (current && snapshot) {
        const { renderer, camera, controls } = current;
        renderer.setPixelRatio(snapshot.pixelRatio);
        renderer.setSize(snapshot.size.x, snapshot.size.y);
        camera.aspect = snapshot.aspect; camera.updateProjectionMatrix();
        camera.position.copy(snapshot.position); camera.quaternion.copy(snapshot.quaternion); camera.up.copy(snapshot.up);
        controls.target.copy(snapshot.target); controls.enabled = snapshot.enabled; controls.update(); updateVolumeCamera(current.group, camera);
      }
      if (current) updateVolumeProgress(current.group, renderSettings.current.videoProgress);
      exportSnapshot.current = null; exporting.current = false;
    },
  }), [data, mode, renderStyle, spacing]);

  useEffect(() => {
    const current = state.current;
    playbackStart.current = null;
    if (!current) return;
    current.controls.enabled = !cameraPlaying;
    if (!cameraPlaying) return;
    const motion = playback.current;
    current.controls.target.copy(cameraPoseAt(cameraPreset, playbackOffset.current, motion.duration, motion.depth).target);
    renderFrame(current.renderer, current.scene, current.camera, cameraPreset, playbackOffset.current, motion.duration, motion.depth, motion.frameWidth, motion.frameHeight,
      (activeCamera) => { updateGridOpacity(current.axis, activeCamera, current.controls.target); updateVolumeCamera(current.group, activeCamera); });
  }, [cameraPlaying, cameraPreset, data, spacing]);

  useEffect(() => {
    if (!cameraPlaying) {
      playbackOffset.current = playbackTime;
      const current = state.current;
      const motion = playback.current;
      if (current && motion.duration > 0) {
        const pose = cameraPoseAt(cameraPreset, playbackTime, motion.duration, motion.depth);
        current.controls.enabled = true;
        current.controls.target.copy(pose.target);
        renderFrame(current.renderer, current.scene, current.camera, cameraPreset, playbackTime, motion.duration, motion.depth, motion.frameWidth, motion.frameHeight,
          (activeCamera) => updateVolumeCamera(current.group, activeCamera));
      }
    }
  }, [cameraPlaying, playbackTime]);

  useEffect(() => {
    const current = state.current; if (!current) return;
    const loadKey = sceneKey;
    loadedScene.current = { key: loadKey, count: 0 };
    const { group, plane, camera } = current;
    for (const child of [...group.children]) {
      const mesh = child as THREE.Mesh; mesh.geometry?.dispose(); const mats = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
      mats.forEach((mat) => { if (mat) disposeMaterial(mat); });
      group.remove(child);
    }
    if (!data) return;
    const urls = mode === 'subject' ? data.frameUrls : data.fullFrameUrls;
    const loader = new THREE.TextureLoader();
    const aspect = data.width / data.height; const width = Math.min(5, 4.2 * aspect); const height = width / aspect;
    if (plane) { plane.scale.set(width, height, 1); plane.position.set(0, 0, 0); }
    let cancelled = false;
    const currentOpacity = () => renderSettings.current.mode === 'full' ? renderSettings.current.opacity : Math.min(1, renderSettings.current.opacity + 0.12);
    if (renderStyle === 'volume') {
      const maxEdge = 768;
      const scale = Math.min(1, maxEdge / Math.max(data.width, data.height));
      const textureWidth = Math.max(1, Math.round(data.width * scale));
      const textureHeight = Math.max(1, Math.round(data.height * scale));
      const pixelsPerFrame = textureWidth * textureHeight * 4;
      const fullBytes = new Uint8Array(pixelsPerFrame * urls.length);
      const subjectBytes = mode === 'subject' ? new Uint8Array(fullBytes.length) : fullBytes;
      let nextIndex = 0;
      const worker = async () => {
        const canvas = document.createElement('canvas'); canvas.width = textureWidth; canvas.height = textureHeight;
        const context = canvas.getContext('2d', { willReadFrequently: true });
        if (!context) throw new Error('浏览器无法创建 2D 画布来构建三维体纹理。');
        const readFrame = async (url: string, destination: Uint8Array, index: number) => {
          const response = await fetch(url);
          if (!response.ok) throw new Error(`读取第 ${index + 1} 张视频帧失败（HTTP ${response.status}）。`);
          const bitmap = await createImageBitmap(await response.blob());
          try {
            context.clearRect(0, 0, textureWidth, textureHeight);
            context.drawImage(bitmap, 0, 0, textureWidth, textureHeight);
            destination.set(context.getImageData(0, 0, textureWidth, textureHeight).data, index * pixelsPerFrame);
          } finally { bitmap.close(); }
        };
        while (!cancelled) {
          const index = nextIndex++;
          if (index >= urls.length) return;
          await readFrame(data.fullFrameUrls[index], fullBytes, index);
          if (mode === 'subject' && !cancelled) await readFrame(data.frameUrls[index], subjectBytes, index);
        }
      };
      void Promise.all(Array.from({ length: Math.min(4, urls.length) }, () => worker())).then(() => {
        if (cancelled || !state.current || state.current !== current || loadedScene.current.key !== loadKey) return;
        const makeTexture = (bytes: Uint8Array) => {
          const texture = new THREE.Data3DTexture(bytes, textureWidth, textureHeight, urls.length);
          texture.format = THREE.RGBAFormat; texture.type = THREE.UnsignedByteType;
          texture.minFilter = THREE.LinearFilter; texture.magFilter = THREE.LinearFilter;
          texture.wrapS = THREE.ClampToEdgeWrapping; texture.wrapT = THREE.ClampToEdgeWrapping; texture.wrapR = THREE.ClampToEdgeWrapping;
          texture.generateMipmaps = false; texture.unpackAlignment = 1; texture.colorSpace = THREE.SRGBColorSpace; texture.needsUpdate = true;
          return texture;
        };
        const fullTexture = makeTexture(fullBytes);
        const subjectTexture = subjectBytes === fullBytes ? fullTexture : makeTexture(subjectBytes);
        const depth = height;
        const material = createVolumeMaterial(fullTexture, subjectTexture, new THREE.Vector3(width, height, depth), urls.length, currentOpacity(), mode === 'subject');
        const mesh = new THREE.Mesh(new THREE.BoxGeometry(width, height, depth), material);
        mesh.userData.isVolume = true; mesh.userData.dimensions = { width, height, depth };
        group.add(mesh); loadedScene.current.count = urls.length;
        updateVolumeProgress(group, renderSettings.current.videoProgress);
        camera.lookAt(0, 0, 0); current.controls.target.set(0, 0, 0);
      }).catch((e: unknown) => {
        if (!cancelled && loadedScene.current.key === loadKey) loadedScene.current.error = e instanceof Error ? e.message : '构建三维体纹理失败。';
      });
    } else {
      let remaining = urls.length;
      urls.forEach((url, index) => {
        loader.load(url, (texture) => {
          if (cancelled || !state.current || state.current !== current || loadedScene.current.key !== loadKey) { texture.dispose(); return; }
          texture.colorSpace = THREE.SRGBColorSpace;
          const material = new THREE.MeshBasicMaterial({ map: texture, transparent: true, opacity: currentOpacity(), side: THREE.DoubleSide, depthWrite: false, alphaTest: 0.008 });
          const mesh = new THREE.Mesh(new THREE.PlaneGeometry(width, height), material);
          mesh.userData.frameIndex = index;
          mesh.position.z = timeCoordinate(index, urls.length, spacing); group.add(mesh);
          loadedScene.current.count += 1;
          remaining -= 1;
          if (remaining === 0) { camera.lookAt(0, 0, 0); current.controls.target.set(0, 0, 0); }
        }, undefined, (e: unknown) => { if (!cancelled) loadedScene.current.error = e instanceof Error ? e.message : '读取视频帧失败。'; });
      });
    }
    return () => { cancelled = true; };
  }, [data, mode, renderStyle]);

  useEffect(() => {
    const current = state.current; if (!current) return;
    current.scene.background = new THREE.Color(background);
    current.axis.visible = showAxis;
    if (current.plane) current.plane.visible = showPlane;
    for (const child of current.group.children) {
      const mesh = child as THREE.Mesh;
      if (mesh.userData.isVolume) {
        const material = mesh.material as THREE.RawShaderMaterial;
        material.uniforms.uOpacity.value = mode === 'full' ? opacity : Math.min(1, opacity + 0.12);
      } else {
        child.position.z = timeCoordinate(child.userData.frameIndex, current.group.children.length, spacing);
        (mesh.material as THREE.MeshBasicMaterial).opacity = mode === 'full' ? opacity : Math.min(1, opacity + 0.12);
      }
    }
  }, [spacing, opacity, showAxis, showPlane, background, mode, data]);

  return <div className="scene-wrap"><div className="scene-labels">{renderStyle === 'volume' && mode === 'subject' && data ? <><span>已播放 · 主体轨迹</span><span>当前切面 · 完整帧</span><span>未播放 · 完整画面</span></> : <><span>X · 画面宽度</span><span>Y · 画面高度</span><span>Z · 时间</span></>}</div><div className="scene-host" ref={host} /><div className="scene-hint">左键旋转 · 滚轮缩放 · 右键平移</div></div>;
});

export default SpaceTimeView;
