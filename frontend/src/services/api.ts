export type VideoInfo = { sessionId: string; duration: number; width: number; height: number; fps: number };
export type BackgroundMethod = 'median' | 'mog2';
export type ProcessedVideo = {
  sessionId: string; width: number; height: number; frameCount: number; sampleFps: number;
  times: number[]; maskAreas: number[]; warnings: string[]; frameUrls: string[]; fullFrameUrls: string[];
};
export type ExportJob = {
  exportId: string; status: 'receiving' | 'encoding' | 'completed' | 'failed' | 'cancelled';
  progress: number; receivedFrames: number; frameCount: number; error: string; filename: string | null;
};

async function request<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, init);
  if (!response.ok) {
    const body = await response.json().catch(() => ({}));
    throw new Error(body.detail || `本地服务返回错误（${response.status}）`);
  }
  return response.json() as Promise<T>;
}

export async function uploadVideo(file: File): Promise<VideoInfo> {
  const body = new FormData(); body.append('file', file);
  return request('/api/upload', { method: 'POST', body });
}

export async function getSampleFrameLimit(): Promise<number> {
  const health = await request<{ maxSampleFrames?: number }>('/api/health', { cache: 'no-store' });
  const limit = health.maxSampleFrames;
  if (typeof limit !== 'number' || !Number.isInteger(limit) || limit <= 0) {
    throw new Error('后端未提供采样上限，请重新启动本地服务。');
  }
  return limit;
}

export async function processVideo(params: {
  sessionId: string; start: number; end: number; sampleFps: number; threshold: number; blur: number; morphSize: number; backgroundMethod: BackgroundMethod;
}): Promise<ProcessedVideo> {
  const body = new FormData();
  for (const [key, value] of Object.entries(params)) body.append(key, String(value));
  return request('/api/process', { method: 'POST', body });
}

export async function startExport(params: { sessionId: string; frameCount: number; width: number; height: number; fps: number; outputName?: string }): Promise<ExportJob> {
  return request('/api/export/start', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(params) });
}

export async function uploadExportFrames(exportId: string, startIndex: number, frames: Blob[], signal: AbortSignal): Promise<void> {
  const body = new FormData();
  frames.forEach((frame, index) => body.append('files', frame, `frame_${startIndex + index}.png`));
  await request(`/api/export/${exportId}/frames/${startIndex}`, { method: 'POST', body, signal });
}

export async function finishExport(exportId: string): Promise<ExportJob> {
  return request(`/api/export/${exportId}/finish`, { method: 'POST' });
}

export async function getExportStatus(exportId: string, signal: AbortSignal): Promise<ExportJob> {
  return request(`/api/export/${exportId}/status`, { signal });
}

export async function cancelExport(exportId: string): Promise<void> {
  await request(`/api/export/${exportId}`, { method: 'DELETE' });
}
