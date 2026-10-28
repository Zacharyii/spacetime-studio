import { useEffect, useRef, useState } from 'react';
import { uploadVideo, type BackgroundMethod, type VideoInfo } from '../services/api';
import type { CameraPreset } from '../rendering/camera';

const STORAGE_KEY = 'space-time-studio-batch-v1';
type ExportAspect = 'portrait' | 'landscape';

export type BatchSettings = {
  mode: 'subject' | 'full'; renderStyle: 'planes' | 'volume'; start: number; end: number; sampleFps: 5 | 10 | 15;
  threshold: number; blur: number; morphSize: number; backgroundMethod: BackgroundMethod; spacing: number; opacity: number;
  background: string; showAxis: boolean; showPlane: boolean; cameraPreset: CameraPreset;
  exportAspect: ExportAspect; exportResolution: 720 | 1080;
};

export type BatchItem = {
  id: string; name: string; info: VideoInfo; settings: BatchSettings;
  status: 'queued' | 'preparing' | 'rendering' | 'encoding' | 'completed' | 'failed' | 'cancelled';
  progress: number; filename?: string; error?: string;
};

type Props = {
  template: BatchSettings;
  onRun: (item: BatchItem, update: (status: 'preparing' | 'rendering' | 'encoding', progress: number) => void, signal: AbortSignal) => Promise<string>;
  onRunningChange: (running: boolean) => void;
};

function readSavedItems(): BatchItem[] {
  try {
    const parsed = JSON.parse(localStorage.getItem(STORAGE_KEY) || '[]') as BatchItem[];
    if (!Array.isArray(parsed)) return [];
    return parsed.map((item) => {
      const normalized = { ...item, settings: { ...item.settings, renderStyle: item.settings.renderStyle ?? 'planes', backgroundMethod: item.settings.backgroundMethod ?? 'median' } };
      return ['preparing', 'rendering', 'encoding'].includes(item.status)
        ? { ...normalized, status: 'queued', progress: 0, error: '检测到上次运行中断，已恢复到队列。' }
        : normalized;
    });
  } catch { return []; }
}

function saveItems(items: BatchItem[]) {
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(items)); } catch { /* Keep the in-memory queue usable if browser storage is unavailable. */ }
}

const statusLabel: Record<BatchItem['status'], string> = {
  queued: '排队中', preparing: '准备中', rendering: '渲染中', encoding: '编码中',
  completed: '已完成', failed: '失败', cancelled: '已取消',
};

export default function BatchQueue({ template, onRun, onRunningChange }: Props) {
  const [items, setItems] = useState<BatchItem[]>(readSavedItems);
  const [adding, setAdding] = useState(false);
  const [addMessage, setAddMessage] = useState('');
  const [running, setRunning] = useState(false);
  const [summary, setSummary] = useState('');
  const input = useRef<HTMLInputElement>(null);
  const itemsRef = useRef(items);
  const controller = useRef<AbortController | null>(null);

  useEffect(() => { saveItems(items); }, [items]);

  function updateItems(transform: (current: BatchItem[]) => BatchItem[]) {
    setItems((current) => {
      const next = transform(current);
      itemsRef.current = next;
      saveItems(next);
      return next;
    });
  }

  function updateItem(id: string, patch: Partial<BatchItem>) {
    updateItems((current) => current.map((item) => item.id === id ? { ...item, ...patch } : item));
  }

  async function addFiles(files: FileList | null) {
    if (!files?.length) return;
    setAdding(true); setAddMessage(''); setSummary('');
    for (const file of Array.from(files)) {
      try {
        const info = await uploadVideo(file);
        const start = Math.min(template.start, Math.max(0, info.duration - 0.2));
        const end = Math.max(start + 0.2, Math.min(template.end, info.duration));
        const settings = { ...template, start, end };
        const item: BatchItem = {
          id: crypto.randomUUID(), name: file.name, info, settings,
          status: 'queued', progress: 0,
        };
        updateItems((current) => [...current, item]);
      } catch (e) {
        setAddMessage(`${file.name}：${e instanceof Error ? e.message : '导入失败'}`);
      }
    }
    setAdding(false);
  }

  async function runItems(ids: string[]) {
    if (running || adding || !ids.length) return;
    setRunning(true); onRunningChange(true); setSummary('');
    const active = new AbortController(); controller.current = active;
    let completed = 0; let failed = 0; let cancelled = false;
    try {
      for (const id of ids) {
        const item = itemsRef.current.find((candidate) => candidate.id === id);
        if (!item || !['queued', 'failed', 'cancelled'].includes(item.status)) continue;
        updateItem(id, { status: 'preparing', progress: 0, filename: undefined, error: undefined });
        try {
          const filename = await onRun(item, (status, progress) => updateItem(id, { status, progress }), active.signal);
          updateItem(id, { status: 'completed', progress: 1, filename, error: undefined });
          completed += 1;
        } catch (e) {
          if (active.signal.aborted || (e instanceof DOMException && e.name === 'AbortError')) {
            updateItem(id, { status: 'cancelled', error: '本项已取消。' }); cancelled = true; break;
          }
          updateItem(id, { status: 'failed', error: e instanceof Error ? e.message : '任务失败。' });
          failed += 1;
        }
      }
    } finally {
      controller.current = null; setRunning(false); onRunningChange(false);
      const queued = itemsRef.current.filter((item) => item.status === 'queued').length;
      setSummary(`本次完成 ${completed} 项，失败 ${failed} 项${cancelled ? '，已取消当前项' : ''}${queued ? `，${queued} 项仍在队列` : ''}。`);
    }
  }

  function downloadManifest() {
    const manifest = {
      createdAt: new Date().toISOString(),
      totals: {
        total: items.length,
        completed: items.filter((item) => item.status === 'completed').length,
        failed: items.filter((item) => item.status === 'failed').length,
        cancelled: items.filter((item) => item.status === 'cancelled').length,
        queued: items.filter((item) => item.status === 'queued').length,
      },
      items: items.map(({ id, name, info, settings, status, filename, error }) => ({ id, name, sessionId: info.sessionId, settings, status, filename: filename ?? null, error: error ?? null })),
    };
    const url = URL.createObjectURL(new Blob([JSON.stringify(manifest, null, 2)], { type: 'application/json' }));
    const link = document.createElement('a'); link.href = url; link.download = 'space-time-batch-manifest.json'; link.click();
    window.setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  const queuedCount = items.filter((item) => item.status === 'queued').length;
  const completedCount = items.filter((item) => item.status === 'completed').length;
  const failedCount = items.filter((item) => item.status === 'failed').length;

  return <section className="batch-panel">
    <div className="section-head"><h2>批量队列</h2><span>单任务串行处理</span></div>
    <button className="batch-add" disabled={adding || running} onClick={() => input.current?.click()}>{adding ? '正在导入素材…' : '添加多个视频'}</button>
    <input ref={input} type="file" accept="video/mp4,video/quicktime,.mp4,.mov,.m4v" multiple hidden onChange={(e) => { void addFiles(e.target.files); e.target.value = ''; }} />
    <div className="batch-stats">共 {items.length} 项 · 完成 {completedCount} · 失败 {failedCount} · 待处理 {queuedCount}</div>
    {items.map((item) => <article className="batch-item" key={item.id}>
      <div className="batch-item-head"><strong title={item.name}>{item.name}</strong><span className={`batch-status ${item.status}`}>{statusLabel[item.status]}</span></div>
      <div className="batch-item-meta">{item.info.width}×{item.info.height} · {item.info.duration.toFixed(1)} 秒 · {item.settings.sampleFps} FPS</div>
      {(item.status === 'preparing' || item.status === 'rendering' || item.status === 'encoding') && <progress max="1" value={item.progress} />}
      {item.filename && <a className="download-link" href={`/api/output/${encodeURIComponent(item.filename)}`} download={item.filename}>{item.filename}</a>}
      {item.error && <div className="batch-error">{item.error}</div>}
      <details className="batch-overrides"><summary>单项参数覆盖</summary>
        <div className="batch-fields">
          <label>开始秒<input type="number" min="0" max={item.info.duration} step="0.1" value={item.settings.start} onChange={(e) => updateItem(item.id, { settings: { ...item.settings, start: Number(e.target.value) } })} /></label>
          <label>结束秒<input type="number" min="0.2" max={item.info.duration} step="0.1" value={item.settings.end} onChange={(e) => updateItem(item.id, { settings: { ...item.settings, end: Number(e.target.value) } })} /></label>
          <label>采样率<select value={item.settings.sampleFps} onChange={(e) => updateItem(item.id, { settings: { ...item.settings, sampleFps: Number(e.target.value) as BatchSettings['sampleFps'] } })}><option value={5}>5 FPS</option><option value={10}>10 FPS</option><option value={15}>15 FPS</option></select></label>
          <label>阈值<input type="number" min="8" max="80" value={item.settings.threshold} onChange={(e) => updateItem(item.id, { settings: { ...item.settings, threshold: Number(e.target.value) } })} /></label>
          <label>羽化像素<input type="number" min="1" max="15" step="2" value={item.settings.blur} onChange={(e) => updateItem(item.id, { settings: { ...item.settings, blur: Number(e.target.value) } })} /></label>
          <label>清噪尺寸<input type="number" min="1" max="9" step="2" value={item.settings.morphSize} onChange={(e) => updateItem(item.id, { settings: { ...item.settings, morphSize: Number(e.target.value) } })} /></label>
          <label>背景模型<select value={item.settings.backgroundMethod} onChange={(e) => updateItem(item.id, { settings: { ...item.settings, backgroundMethod: e.target.value as BackgroundMethod } })}><option value="median">固定背景</option><option value="mog2">动态背景 MOG2</option></select></label>
          <label>时间间距<input type="number" min="0.04" max="0.3" step="0.01" value={item.settings.spacing} onChange={(e) => updateItem(item.id, { settings: { ...item.settings, spacing: Number(e.target.value) } })} /></label>
          <label>轨迹透明度<input type="number" min="0.15" max="1" step="0.01" value={item.settings.opacity} onChange={(e) => updateItem(item.id, { settings: { ...item.settings, opacity: Number(e.target.value) } })} /></label>
          <label>模式<select value={item.settings.mode} onChange={(e) => updateItem(item.id, { settings: { ...item.settings, mode: e.target.value as BatchSettings['mode'] } })}><option value="subject">主体轨迹</option><option value="full">完整帧堆叠</option></select></label>
          <label>渲染方式<select value={item.settings.renderStyle} onChange={(e) => updateItem(item.id, { settings: { ...item.settings, renderStyle: e.target.value as BatchSettings['renderStyle'] } })}><option value="planes">卡片堆叠</option><option value="volume">整体三维体</option></select></label>
          <label>相机<select value={item.settings.cameraPreset} onChange={(e) => updateItem(item.id, { settings: { ...item.settings, cameraPreset: e.target.value as CameraPreset } })}><option value="side-reveal">侧向掠过</option><option value="orbit">环绕</option><option value="fly-through">时间轴推进</option></select></label>
          <label>画幅<select value={item.settings.exportAspect} onChange={(e) => updateItem(item.id, { settings: { ...item.settings, exportAspect: e.target.value as ExportAspect } })}><option value="portrait">9:16</option><option value="landscape">16:9</option></select></label>
          <label>分辨率<select value={item.settings.exportResolution} onChange={(e) => updateItem(item.id, { settings: { ...item.settings, exportResolution: Number(e.target.value) as 720 | 1080 } })}><option value={720}>720P</option><option value={1080}>1080P</option></select></label>
        </div>
      </details>
      {(item.status === 'failed' || item.status === 'cancelled') && <button className="batch-retry" disabled={running || adding} onClick={() => void runItems([item.id])}>重试此项</button>}
    </article>)}
    <div className="batch-actions">
      <button className="build-button" disabled={!queuedCount || running || adding} onClick={() => void runItems(itemsRef.current.filter((item) => item.status === 'queued').map((item) => item.id))}>开始队列（{queuedCount}）</button>
      {running && <button className="cancel-button" onClick={() => controller.current?.abort()}>取消当前项并暂停队列</button>}
    </div>
    {items.length > 0 && <button className="batch-manifest" onClick={downloadManifest}>下载导出清单 JSON</button>}
    {summary && <div className="batch-message">{summary}</div>}
    {addMessage && <div className="batch-error">{addMessage}</div>}
  </section>;
}
