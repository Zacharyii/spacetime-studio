import { useEffect, useMemo, useRef, useState } from 'react';
import BatchQueue, { type BatchItem, type BatchSettings } from './components/BatchQueue';
import SpaceTimeView, { type SpaceTimeViewHandle } from './rendering/SpaceTimeView';
import { estimateTextureMiB } from './rendering/mapping';
import type { CameraPreset } from './rendering/camera';
import { cancelExport as cancelExportRequest, finishExport, getExportStatus, getSampleFrameLimit, processVideo, startExport, uploadExportFrames, uploadVideo, type BackgroundMethod, type ProcessedVideo, type VideoInfo } from './services/api';

export default function App() {
  const [video, setVideo] = useState<VideoInfo | null>(null);
  const [sourcePreviewUrl, setSourcePreviewUrl] = useState<string | null>(null);
  const [processed, setProcessed] = useState<ProcessedVideo | null>(null);
  const [mode, setMode] = useState<'subject' | 'full'>('subject');
  const [renderStyle, setRenderStyle] = useState<'planes' | 'volume'>('planes');
  const [sampleFps, setSampleFps] = useState(10);
  const [sampleFrameLimit, setSampleFrameLimit] = useState<number | null>(null);
  const [sampleLimitError, setSampleLimitError] = useState('');
  const [threshold, setThreshold] = useState(28);
  const [blur, setBlur] = useState(5);
  const [morphSize, setMorphSize] = useState(3);
  const [backgroundMethod, setBackgroundMethod] = useState<BackgroundMethod>('median');
  const [spacing, setSpacing] = useState(0.12);
  const [opacity, setOpacity] = useState(0.68);
  const [start, setStart] = useState(0);
  const [end, setEnd] = useState(5);
  const [background, setBackground] = useState('#101722');
  const [showAxis, setShowAxis] = useState(true);
  const [showPlane, setShowPlane] = useState(true);
  const [busy, setBusy] = useState(false);
  const [batchRunning, setBatchRunning] = useState(false);
  const [message, setMessage] = useState('导入视频，生成可旋转的时空轨迹');
  const [error, setError] = useState('');
  const [renderFps, setRenderFps] = useState(0);
  const [cameraPreset, setCameraPreset] = useState<CameraPreset>('side-reveal');
  const [cameraPlaying, setCameraPlaying] = useState(false);
  const [cameraLoop, setCameraLoop] = useState(true);
  const [playbackTime, setPlaybackTime] = useState(0);
  const [videoProgress, setVideoProgress] = useState(0);
  const [exportAspect, setExportAspect] = useState<'portrait' | 'landscape'>('portrait');
  const [exportResolution, setExportResolution] = useState<720 | 1080>(1080);
  const [exportStatus, setExportStatus] = useState<'idle' | 'rendering' | 'encoding' | 'completed' | 'cancelled' | 'failed'>('idle');
  const [exportProgress, setExportProgress] = useState(0);
  const [exportMessage, setExportMessage] = useState('导出使用当前模式与相机预设，不含音频');
  const [lastExport, setLastExport] = useState<{ exportId: string; filename: string } | null>(null);
  const viewRef = useRef<SpaceTimeViewHandle>(null);
  const exportController = useRef<AbortController | null>(null);
  const activeExportId = useRef<string | null>(null);
  const presetInput = useRef<HTMLInputElement>(null);
  const sourceVideoRef = useRef<HTMLVideoElement>(null);
  const memoryMiB = useMemo(() => {
    if (!processed) return 0;
    const scale = renderStyle === 'volume' ? Math.min(1, 768 / Math.max(processed.width, processed.height)) : 1;
    const textures = renderStyle === 'volume' && mode === 'subject' ? 2 : 1;
    return textures * estimateTextureMiB(Math.max(1, Math.round(processed.width * scale)), Math.max(1, Math.round(processed.height * scale)), processed.frameCount);
  }, [processed, renderStyle, mode]);
  const batchTemplate: BatchSettings = { mode, renderStyle, start, end, sampleFps: sampleFps as BatchSettings['sampleFps'], threshold, blur, morphSize, backgroundMethod, spacing, opacity, background, showAxis, showPlane, cameraPreset, exportAspect, exportResolution };

  useEffect(() => {
    return () => { if (sourcePreviewUrl) URL.revokeObjectURL(sourcePreviewUrl); };
  }, [sourcePreviewUrl]);

  useEffect(() => {
    const currentTime = sourceVideoRef.current?.currentTime ?? start;
    setVideoProgress(Math.max(0, Math.min(1, (currentTime - (processed?.times[0] ?? start)) / Math.max(0.001, processed ? processed.frameCount / processed.sampleFps : end - start))));
  }, [start, end, processed]);

  useEffect(() => {
    let cancelled = false;
    const refreshLimit = () => getSampleFrameLimit().then((limit) => {
      if (!cancelled) { setSampleFrameLimit(limit); setSampleLimitError(''); }
    }).catch((e: unknown) => {
      if (!cancelled) setSampleLimitError(e instanceof Error ? e.message : '无法读取后端采样上限。');
    });
    refreshLimit();
    window.addEventListener('focus', refreshLimit);
    return () => { cancelled = true; window.removeEventListener('focus', refreshLimit); };
  }, []);

  function syncVideoProgress() {
    const currentTime = sourceVideoRef.current?.currentTime ?? start;
    setVideoProgress(Math.max(0, Math.min(1, (currentTime - (processed?.times[0] ?? start)) / Math.max(0.001, processed ? processed.frameCount / processed.sampleFps : end - start))));
  }

  async function handleUpload(file?: File) {
    if (!file || batchRunning) return;
    setCameraPlaying(false);
    setPlaybackTime(0);
    setVideoProgress(0);
    setSourcePreviewUrl(null);
    setLastExport(null); setExportStatus('idle');
    setBusy(true); setError(''); setProcessed(null); setMessage('正在读取视频信息…');
    try {
      const info = await uploadVideo(file); setVideo(info); setSourcePreviewUrl(URL.createObjectURL(file)); setStart(0); setEnd(Math.min(5, info.duration)); setMessage('预览原片并选好固定机位片段，再构建 3D 轨迹。');
    } catch (e) { setVideo(null); setError(e instanceof Error ? e.message : '上传失败'); setMessage('导入未完成'); }
    finally { setBusy(false); }
  }

  function savePreset() {
    const preset = { version: 1, mode, renderStyle, sampleFps, threshold, blur, morphSize, backgroundMethod, spacing, opacity, start, end, background, showAxis, showPlane, cameraPreset, cameraLoop, exportAspect, exportResolution };
    const url = URL.createObjectURL(new Blob([JSON.stringify(preset, null, 2)], { type: 'application/json' }));
    const link = document.createElement('a'); link.href = url; link.download = 'space-time-preset.json'; link.click();
    window.setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  async function loadPreset(file?: File) {
    if (!file) return;
    try {
      const value = JSON.parse(await file.text());
      if (value.version !== 1 || !['subject', 'full'].includes(value.mode) || ![5, 10, 15].includes(value.sampleFps) || !['orbit', 'fly-through', 'side-reveal'].includes(value.cameraPreset) || !['portrait', 'landscape'].includes(value.exportAspect) || ![720, 1080].includes(value.exportResolution)) throw new Error('预设版本或选项不受支持。');
      const presetRenderStyle = value.renderStyle ?? 'planes';
      if (!['planes', 'volume'].includes(presetRenderStyle)) throw new Error('预设中的渲染方式无效。');
      const numeric = ['threshold', 'blur', 'morphSize', 'spacing', 'opacity', 'start', 'end'];
      if (numeric.some((key) => typeof value[key] !== 'number' || !Number.isFinite(value[key]))) throw new Error('预设中的数值无效。');
      const presetBackgroundMethod = value.backgroundMethod ?? 'median';
      if (!['median', 'mog2'].includes(presetBackgroundMethod)) throw new Error('预设中的背景模型无效。');
      if (typeof value.background !== 'string' || !/^#[0-9a-f]{6}$/i.test(value.background) || typeof value.showAxis !== 'boolean' || typeof value.showPlane !== 'boolean' || typeof value.cameraLoop !== 'boolean') throw new Error('预设中的显示选项无效。');
      setMode(value.mode); setRenderStyle(presetRenderStyle); setSampleFps(value.sampleFps); setThreshold(value.threshold); setBlur(value.blur); setMorphSize(value.morphSize); setBackgroundMethod(presetBackgroundMethod); setSpacing(value.spacing); setOpacity(value.opacity); setStart(value.start); setEnd(value.end); setBackground(value.background); setShowAxis(value.showAxis); setShowPlane(value.showPlane); setCameraPreset(value.cameraPreset); setCameraLoop(value.cameraLoop); setExportAspect(value.exportAspect); setExportResolution(value.exportResolution); setCameraPlaying(false); setPlaybackTime(0);
      setMessage(`已载入参数预设：${file.name}`); setError('');
    } catch (e) { setError(e instanceof Error ? e.message : '无法读取参数预设。'); }
  }

  async function buildScene() {
    if (!video || start < 0 || end > video.duration || end - start < 0.2) return;
    setCameraPlaying(false);
    setPlaybackTime(0);
    setBusy(true); setError(''); setMessage('正在按时间采样、估计固定背景并生成透明前景帧…');
    try {
      const limit = await getSampleFrameLimit();
      setSampleFrameLimit(limit); setSampleLimitError('');
      const count = Math.ceil((end - start) * sampleFps);
      if (count > limit) throw new Error(`当前范围将生成 ${count} 帧，超过 ${limit} 帧限制。请缩短范围或降低采样率。`);
      const result = await processVideo({ sessionId: video.sessionId, start, end, sampleFps, threshold, blur, morphSize, backgroundMethod });
      const modelName = backgroundMethod === 'mog2' ? '动态背景 MOG2' : '固定背景';
      setProcessed(result); setMessage(`已用${modelName}生成 ${result.frameCount} 张时间切片。拖动画面可旋转观察运动轨迹。`);
    } catch (e) { setError(e instanceof Error ? e.message : '处理失败'); setMessage('场景构建未完成'); }
    finally { setBusy(false); }
  }

  async function runBatchItem(item: BatchItem, onProgress: (status: 'preparing' | 'rendering' | 'encoding', progress: number) => void, signal: AbortSignal): Promise<string> {
    const settings = item.settings;
    const info = item.info;
    setBusy(true); setCameraPlaying(false); setPlaybackTime(0); setVideo(info); setProcessed(null);
    setMode(settings.mode); setRenderStyle(settings.renderStyle ?? 'planes'); setSpacing(settings.spacing); setOpacity(settings.opacity); setThreshold(settings.threshold);
    setBlur(settings.blur); setMorphSize(settings.morphSize); setBackground(settings.background);
    setBackgroundMethod(settings.backgroundMethod);
    setShowAxis(settings.showAxis); setShowPlane(settings.showPlane); setCameraPreset(settings.cameraPreset);
    setExportAspect(settings.exportAspect); setExportResolution(settings.exportResolution);
    onProgress('preparing', 0.02);
    let jobId: string | null = null;
    try {
      const data = await processVideo({ sessionId: info.sessionId, start: settings.start, end: settings.end, sampleFps: settings.sampleFps, threshold: settings.threshold, blur: settings.blur, morphSize: settings.morphSize, backgroundMethod: settings.backgroundMethod });
      if (signal.aborted) throw new DOMException('队列任务已取消。', 'AbortError');
      setProcessed(data);
      const fps = 30;
      const frameCount = Math.round(data.frameCount / data.sampleFps * fps);
      const width = settings.exportAspect === 'portrait' ? settings.exportResolution : settings.exportResolution === 1080 ? 1920 : 1280;
      const height = settings.exportAspect === 'portrait' ? settings.exportResolution === 1080 ? 1920 : 1280 : settings.exportResolution;
      const job = await startExport({ sessionId: info.sessionId, frameCount, width, height, fps, outputName: item.name.replace(/\.[^.]+$/, '') });
      jobId = job.exportId; activeExportId.current = jobId;
      const view = viewRef.current;
      if (!view) throw new Error('3D 预览尚未就绪。');
      await view.beginExport(width, height, signal);
      onProgress('rendering', 0);
      for (let startIndex = 0; startIndex < frameCount; startIndex += 5) {
        const batch: Blob[] = [];
        const endIndex = Math.min(startIndex + 5, frameCount);
        for (let index = startIndex; index < endIndex; index += 1) {
          if (signal.aborted) throw new DOMException('队列任务已取消。', 'AbortError');
          batch.push(await view.renderExportFrame(index / fps, settings.cameraPreset));
          onProgress('rendering', (index + 1) / frameCount * 0.8);
        }
        await uploadExportFrames(job.exportId, startIndex, batch, signal);
      }
      if (signal.aborted) throw new DOMException('队列任务已取消。', 'AbortError');
      await finishExport(job.exportId);
      onProgress('encoding', 0.82);
      let status = await getExportStatus(job.exportId, signal);
      while (status.status === 'encoding') {
        onProgress('encoding', 0.8 + status.progress * 0.2);
        await new Promise((resolve) => window.setTimeout(resolve, 300));
        status = await getExportStatus(job.exportId, signal);
      }
      if (status.status !== 'completed' || !status.filename) throw new Error(status.error || '视频编码未完成。');
      onProgress('encoding', 1);
      setLastExport({ exportId: job.exportId, filename: status.filename });
      return status.filename;
    } catch (e) {
      if (jobId && signal.aborted) await cancelExportRequest(jobId).catch(() => undefined);
      throw e;
    } finally {
      viewRef.current?.endExport(); activeExportId.current = null; setBusy(false);
    }
  }

  async function handleExport() {
    if (!video || !processed || !viewRef.current || exportController.current || batchRunning) return;
    const controller = new AbortController(); exportController.current = controller;
    const width = exportAspect === 'portrait' ? exportResolution : exportResolution === 1080 ? 1920 : 1280;
    const height = exportAspect === 'portrait' ? exportResolution === 1080 ? 1920 : 1280 : exportResolution;
    const fps = 30;
    const duration = processed.frameCount / processed.sampleFps;
    const frameCount = Math.round(duration * fps);
    setCameraPlaying(false); setLastExport(null); setExportStatus('rendering'); setExportProgress(0);
    setExportMessage('正在准备高分辨率导出画布…'); setError('');
    try {
      const job = await startExport({ sessionId: video.sessionId, frameCount, width, height, fps });
      activeExportId.current = job.exportId;
      await viewRef.current.beginExport(width, height, controller.signal);
      for (let startIndex = 0; startIndex < frameCount; startIndex += 5) {
        const batch: Blob[] = [];
        const endIndex = Math.min(startIndex + 5, frameCount);
        for (let index = startIndex; index < endIndex; index += 1) {
          if (controller.signal.aborted) throw new DOMException('导出已取消。', 'AbortError');
          batch.push(await viewRef.current.renderExportFrame(index / fps, cameraPreset));
          setExportProgress((index + 1) / frameCount * 0.8);
          setExportMessage(`正在逐帧渲染 ${index + 1} / ${frameCount}`);
        }
        await uploadExportFrames(job.exportId, startIndex, batch, controller.signal);
      }
      if (controller.signal.aborted) throw new DOMException('导出已取消。', 'AbortError');
      await finishExport(job.exportId);
      setExportStatus('encoding'); setExportMessage('图像帧已交给 FFmpeg，正在编码 H.264 MP4…');
      let status = await getExportStatus(job.exportId, controller.signal);
      while (status.status === 'encoding') {
        setExportProgress(0.8 + status.progress * 0.2);
        await new Promise((resolve) => window.setTimeout(resolve, 300));
        status = await getExportStatus(job.exportId, controller.signal);
      }
      if (status.status !== 'completed' || !status.filename) throw new Error(status.error || '视频编码未完成。');
      setExportProgress(1); setExportStatus('completed'); setExportMessage(`已保存：outputs/${status.filename}`);
      setLastExport({ exportId: job.exportId, filename: status.filename });
    } catch (e) {
      if (e instanceof DOMException && e.name === 'AbortError') {
        setExportStatus('cancelled'); setExportMessage('导出已取消。');
      } else {
        setExportStatus('failed'); setExportMessage(e instanceof Error ? e.message : '导出失败。');
      }
    } finally {
      viewRef.current?.endExport();
      activeExportId.current = null; exportController.current = null;
    }
  }

  async function handleCancelExport() {
    exportController.current?.abort();
    const exportId = activeExportId.current;
    if (exportId) await cancelExportRequest(exportId).catch(() => undefined);
  }

  return <main className="app-shell">
    <header className="topbar"><div className="brand-mark">ST</div><div><div className="brand-name">SPACE-TIME STUDIO</div><div className="brand-sub">时空可视化视频生成器 <span>· 本地原型</span></div></div><div className="local-badge"><i /> 本地处理</div></header>
    <div className={`workspace ${batchRunning ? 'batch-running' : ''}`}>
      <aside className="panel controls-panel">
        <fieldset disabled={batchRunning} className="batch-lock">
        <div className="panel-title"><span className="step">01</span><div><h1>素材与参数</h1><p>固定机位效果最佳</p></div></div>
        <label className="upload-zone"><input type="file" accept="video/mp4,video/quicktime,.mp4,.mov,.m4v" onChange={(e) => handleUpload(e.target.files?.[0])} /><span className="upload-icon">＋</span><strong>{video ? '更换视频素材' : '选择本地视频'}</strong><small>MP4 / MOV · 最大 500 MB</small></label>
        {video && <div className="video-meta"><strong>{video.width} × {video.height}</strong><span>{video.duration.toFixed(1)} 秒 · {video.fps.toFixed(1)} FPS</span></div>}
        {sourcePreviewUrl && <section className="source-preview"><video ref={sourceVideoRef} src={sourcePreviewUrl} controls preload="metadata" playsInline onTimeUpdate={syncVideoProgress} onSeeking={syncVideoProgress} onSeeked={syncVideoProgress} /><div className="source-preview-actions"><span>选择“整体三维体”后，拖动原片进度条可定位当前帧</span><div><button type="button" onClick={() => { const time = sourceVideoRef.current?.currentTime ?? 0; setStart(Math.min(time, Math.max(0, (video?.duration ?? 0) - 0.2))); }}>设为开始</button><button type="button" onClick={() => { const time = sourceVideoRef.current?.currentTime ?? 0; setEnd(Math.max(0.2, Math.min(time, video?.duration ?? time))); }}>设为结束</button></div></div></section>}
        <section className="control-section"><div className="section-head"><h2>处理范围</h2><span>建议 5–10 秒</span></div><div className="range-row"><label>开始 <input type="number" min="0" max={video?.duration ?? 600} step="0.1" value={start} onChange={(e) => setStart(Number(e.target.value))} /></label><label>结束 <input type="number" min="0.2" max={video?.duration ?? 600} step="0.1" value={end} onChange={(e) => setEnd(Number(e.target.value))} /></label></div>{video && (start < 0 || end > video.duration || end - start < 0.2) && <div className="range-error">范围需在 0–{video.duration.toFixed(1)} 秒内，且至少 0.2 秒。</div>}</section>
        <section className="control-section"><div className="section-head"><h2>可视化内容</h2></div><div className="segmented"><button className={mode === 'subject' ? 'active' : ''} onClick={() => setMode('subject')}>主体轨迹</button><button className={mode === 'full' ? 'active' : ''} onClick={() => setMode('full')}>完整画面</button></div></section>
        <section className="control-section"><div className="section-head"><h2>三维渲染方式</h2></div><div className="segmented"><button className={renderStyle === 'planes' ? 'active' : ''} onClick={() => setRenderStyle('planes')}>卡片堆叠</button><button className={renderStyle === 'volume' ? 'active' : ''} onClick={() => setRenderStyle('volume')}>整体三维体</button></div><div className="notice">{mode === 'subject' && renderStyle === 'volume' ? '拖动左上角原片进度条：已播放部分变为主体轨迹，未播放部分保留完整画面，移动切面显示当前完整帧。' : '整体三维体把视频映射到一个紧凑的时空盒中，时间深度按画面高度归一化；纹理最长边限制为 768 像素。'}</div></section>
        {mode === 'subject' && <section className="control-section"><div className="section-head"><h2>背景模型</h2></div><div className="segmented"><button className={backgroundMethod === 'median' ? 'active' : ''} onClick={() => setBackgroundMethod('median')}>固定背景</button><button className={backgroundMethod === 'mog2' ? 'active' : ''} onClick={() => setBackgroundMethod('mog2')}>动态背景 MOG2</button></div><div className="notice">MOG2 可尝试处理缓慢变化或周期性背景；主体停留太久时可能被学习进背景。切换后重新构建场景生效。</div></section>}
        <section className="control-section"><div className="section-head"><h2>采样率</h2><span title={sampleLimitError || undefined}>{sampleFrameLimit === null ? (sampleLimitError ? '上限读取失败' : '正在读取上限…') : `上限 ${sampleFrameLimit} 帧`}</span></div><div className="segmented compact">{[5, 10, 15].map((value) => <button className={sampleFps === value ? 'active' : ''} key={value} onClick={() => setSampleFps(value)}>{value} FPS</button>)}</div></section>
        {renderStyle === 'planes' && <section className="control-section slider-section"><div className="section-head"><h2>时间轴间距</h2><output>{spacing.toFixed(2)}</output></div><input type="range" min="0.04" max="0.3" step="0.01" value={spacing} onChange={(e) => setSpacing(Number(e.target.value))} /><div className="scale-note"><span>紧凑</span><span>拉伸</span></div></section>}
        {mode === 'subject' && <section className="control-section slider-section"><div className="section-head"><h2>前景阈值</h2><output>{threshold}</output></div><input type="range" min="8" max="80" step="1" value={threshold} onChange={(e) => setThreshold(Number(e.target.value))} /><div className="scale-note"><span>更敏感</span><span>更严格</span></div></section>}
        {mode === 'subject' && <section className="control-section slider-section"><div className="section-head"><h2>蒙版羽化</h2><output>{blur} px</output></div><input type="range" min="1" max="15" step="2" value={blur} onChange={(e) => setBlur(Number(e.target.value))} /></section>}
        {mode === 'subject' && <section className="control-section slider-section"><div className="section-head"><h2>形态学清噪</h2><output>{morphSize} px</output></div><input type="range" min="1" max="9" step="2" value={morphSize} onChange={(e) => setMorphSize(Number(e.target.value))} /></section>}
        <section className="control-section slider-section"><div className="section-head"><h2>轨迹透明度</h2><output>{Math.round(opacity * 100)}%</output></div><input type="range" min="0.15" max="1" step="0.01" value={opacity} onChange={(e) => setOpacity(Number(e.target.value))} /></section>
        <section className="control-section options"><label><input type="checkbox" checked={showAxis} onChange={(e) => setShowAxis(e.target.checked)} /> 显示时间轴与网格</label><label><input type="checkbox" checked={showPlane} onChange={(e) => setShowPlane(e.target.checked)} /> 显示参考平面</label><label>背景颜色 <input type="color" value={background} onChange={(e) => setBackground(e.target.value)} /></label></section>
        <button className="build-button" disabled={!video || busy || start < 0 || end > video.duration || end - start < 0.2} onClick={buildScene}>{busy ? <><span className="spinner" /> 正在处理…</> : '提取主体并构建 3D 轨迹'}</button>
        <div className="notice">{message}{error && <div className="error-text">{error}</div>}</div>
        </fieldset>
        <BatchQueue template={batchTemplate} onRun={runBatchItem} onRunningChange={setBatchRunning} />
      </aside>
      <section className="preview-panel"><div className="preview-header"><div><div className="preview-kicker"><span className="live-dot" /> INTERACTIVE PREVIEW</div><h2>时空轨迹预览</h2></div><div className="preview-actions"><select aria-label="相机预设" value={cameraPreset} onChange={(e) => setCameraPreset(e.target.value as CameraPreset)}><option value="side-reveal">侧向掠过</option><option value="orbit">环绕 Orbit</option><option value="fly-through">时间轴推进</option></select><button disabled={!processed} onClick={() => setCameraPlaying((value) => !value)}>{cameraPlaying ? '暂停镜头' : '播放镜头'}</button><button title="复位视角" onClick={() => { setCameraPlaying(false); setPlaybackTime(0); window.dispatchEvent(new Event('st-reset-view')); }}>复位视角</button></div></div>
        <div className="playback-controls"><label><input type="checkbox" checked={cameraLoop} onChange={(e) => setCameraLoop(e.target.checked)} /> 循环播放</label><input aria-label="镜头播放进度" type="range" min="0" max={processed ? processed.frameCount / processed.sampleFps : 1} step="0.01" value={playbackTime} disabled={!processed || cameraPlaying} onChange={(e) => setPlaybackTime(Number(e.target.value))} /><span>{playbackTime.toFixed(1)} s</span><div className="preset-actions"><button onClick={savePreset}>保存参数 JSON</button><button onClick={() => presetInput.current?.click()}>加载参数 JSON</button><input ref={presetInput} type="file" accept="application/json,.json" hidden onChange={(e) => { loadPreset(e.target.files?.[0]); e.target.value = ''; }} /></div></div>
        <SpaceTimeView ref={viewRef} data={processed} mode={mode} renderStyle={renderStyle} spacing={spacing} opacity={opacity} showAxis={showAxis} showPlane={showPlane} background={background} cameraPreset={cameraPreset} cameraPlaying={cameraPlaying} cameraLoop={cameraLoop} playbackTime={playbackTime} onPlaybackTime={setPlaybackTime} videoProgress={videoProgress} onCameraStop={() => setCameraPlaying(false)} onFps={setRenderFps} />
        <div className="preview-footer"><div><strong>{processed ? processed.frameCount : '—'}</strong><span>时间切片</span></div><div><strong>{processed ? `${memoryMiB.toFixed(1)} MiB` : '—'}</strong><span>纹理估算</span></div><div><strong>{processed ? `${(processed.frameCount / processed.sampleFps).toFixed(1)} s` : '—'}</strong><span>已采样时长</span></div><div className="fps-readout"><strong>{renderFps || '—'} FPS</strong><span>实时渲染</span></div></div>
        <section className="export-panel"><div className="section-head"><h2>视频导出</h2><span>H.264 · 30 FPS · 无音频</span></div><div className="export-options"><div className="segmented"><button className={exportAspect === 'portrait' ? 'active' : ''} onClick={() => setExportAspect('portrait')}>9:16 竖版</button><button className={exportAspect === 'landscape' ? 'active' : ''} onClick={() => setExportAspect('landscape')}>16:9 横版</button></div><select aria-label="导出分辨率" value={exportResolution} onChange={(e) => setExportResolution(Number(e.target.value) as 720 | 1080)}><option value={1080}>1080P</option><option value={720}>720P</option></select></div><div className="export-actions"><button className="build-button" disabled={!processed || exportStatus === 'rendering' || exportStatus === 'encoding'} onClick={handleExport}>{exportStatus === 'rendering' ? '正在渲染…' : exportStatus === 'encoding' ? '正在编码…' : '导出 MP4'}</button>{(exportStatus === 'rendering' || exportStatus === 'encoding') && <button className="cancel-button" onClick={handleCancelExport}>取消</button>}</div>{exportStatus !== 'idle' && <progress className="export-progress" max="1" value={exportProgress} />}<div className={exportStatus === 'failed' ? 'export-message error-text' : 'export-message'}>{exportMessage}</div>{lastExport && <a className="download-link" href={`/api/export/${lastExport.exportId}/download`} download={lastExport.filename}>下载 {lastExport.filename}</a>}</section>
        {processed?.warnings.map((warning) => <div className="warning" key={warning}>{warning}</div>)}
      </section>
    </div>
    <footer className="bottom-note"><span>单视频时空轨迹</span><span>本地浏览器 + OpenCV 固定背景差分</span><span>视频仅保存在本机临时目录</span></footer>
  </main>;
}
