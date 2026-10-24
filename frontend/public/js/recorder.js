/**
 * recorder.js — 浏览器录屏（MediaRecorder 封装）
 * screen stream 由回放页「获取录制区域」流程获取（getDisplayMedia + RestrictionTarget 裁剪），
 * 本模块只负责编码与下载：start(stream, baseName) → stop() → onstop 合成 Blob 自动下载。
 *
 * 编码格式：仅 MP4/H.264（Chrome/Edge 107+，兼容性最好、播放器/剪辑软件通用），
 * 按 avc1.42E01E（Baseline）→ avc1 → mp4 优先级探测；浏览器均不支持时拒绝启动，
 * 由调用方提示用户。文件名固定 .mp4，Blob 容器固定 video/mp4。
 *
 * 空数据保护：若整个录制期未收到任何视频数据（常见于「当前标签页」源在页面
 * 静止/切后台时不产帧），不下载 0KB 文件，而是通过 onStateChange(false, 原因)
 * 报告失败；诊断信息（UA/编码支持/分片数字节数）记录在 diag 并输出 console。
 */

// 空数据时的失败原因（展示给用户）
const EMPTY_DATA_MSG =
  '录制失败：未捕获到视频数据。请保持本标签页在前台且画面有变化（可播放回放或拖动地图），' +
  '或重新获取区域时选择「整个屏幕」作为录制源';

const Recorder = {
  mediaRecorder: null,
  chunks: [],
  fileName: 'replay.mp4',
  mimeType: '',           // 实际选定的 mimeType（start 后可用）
  onStateChange: null,    // (recording: boolean, err: string|null) => void
  diag: {},               // 最近一次录制的诊断信息（失败排查用）

  isRecording() {
    return !!this.mediaRecorder && this.mediaRecorder.state === 'recording';
  },

  /** 按优先级选择编码格式：仅 MP4/H.264，均不支持返回空串 */
  pickMimeType() {
    const candidates = [
      'video/mp4;codecs=avc1.42E01E',  // H.264 Baseline（兼容性最好）
      'video/mp4;codecs=avc1',
      'video/mp4',
    ];
    for (const m of candidates) {
      try {
        if (MediaRecorder.isTypeSupported(m)) return m;
      } catch (e) { /* 继续尝试下一个 */ }
    }
    return '';
  },

  /**
   * 用已获取的 screen stream 开始录制（不负责获取 stream）。
   * @param {MediaStream} stream getDisplayMedia 得到的屏幕流
   * @param {string} baseName 下载文件名（不含后缀，如 replay-2-20261023-174210）
   * @returns {boolean} true=已开始录制；false=启动失败（编码不支持/构造异常/流已失效）
   */
  start(stream, baseName) {
    if (this.isRecording()) return false;
    this.mimeType = this.pickMimeType();
    this.diag = {
      ua: navigator.userAgent,
      mimeType: this.mimeType,
      support: {
        avc1e: MediaRecorder.isTypeSupported('video/mp4;codecs=avc1.42E01E'),
        avc1: MediaRecorder.isTypeSupported('video/mp4;codecs=avc1'),
        mp4: MediaRecorder.isTypeSupported('video/mp4'),
      },
      trackStates: stream.getVideoTracks().map(t => t.readyState),
      chunkCount: 0,
      totalBytes: 0,
    };
    if (!this.mimeType) {
      console.error('[Recorder] 浏览器不支持 MP4/H.264 录制', this.diag);
      return false;  // 不支持 MP4/H.264，拒绝启动（不回退 WebM/VP9）
    }
    this.fileName = (baseName || 'replay') + '.mp4';
    try {
      this.mediaRecorder = new MediaRecorder(stream, {
        mimeType: this.mimeType,
        videoBitsPerSecond: 8000000,
      });
    } catch (e) {
      console.error('[Recorder] MediaRecorder 构造失败', e, this.diag);
      this.mediaRecorder = null;
      return false;
    }
    this.chunks = [];
    this.mediaRecorder.ondataavailable = e => {
      if (e.data && e.data.size > 0) this.chunks.push(e.data);
      this.diag.chunkCount = this.chunks.length;
      this.diag.totalBytes = this.chunks.reduce((s, c) => s + c.size, 0);
    };
    this.mediaRecorder.onstop = () => {
      const chunks = this.chunks;
      const bytes = chunks.reduce((s, c) => s + c.size, 0);
      this.diag.chunkCount = chunks.length;
      this.diag.totalBytes = bytes;
      this.mediaRecorder = null;
      this.chunks = [];
      if (bytes <= 0) {
        // 无任何视频数据（如「当前标签页」源在页面静止/后台时不产帧）：
        // 不下载 0KB 文件，报告失败原因与诊断信息
        console.error('[Recorder] 录制结束但无视频数据', this.diag);
        if (this.onStateChange) this.onStateChange(false, EMPTY_DATA_MSG);
        return;
      }
      const blob = new Blob(chunks, { type: 'video/mp4' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = this.fileName;
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 5000);
      if (this.onStateChange) this.onStateChange(false, null);
    };
    try {
      this.mediaRecorder.start(1000);
    } catch (e) {
      console.error('[Recorder] start 失败', e, this.diag);
      this.mediaRecorder = null;
      this.chunks = [];
      return false;
    }
    if (this.onStateChange) this.onStateChange(true, null);
    return true;
  },

  /**
   * 停止录制并触发下载。返回 Promise，在 onstop（下载完成或空数据失败）后 resolve，
   * 便于「退出录制模式」等场景 await 完成后再释放 stream。
   */
  stop() {
    return new Promise((resolve) => {
      const mr = this.mediaRecorder;
      if (!mr || mr.state === 'inactive') { resolve(); return; }
      mr.addEventListener('stop', resolve, { once: true });
      mr.stop();
    });
  },
};
