/**
 * recorder.js — 浏览器录屏（MediaRecorder 封装）
 * screen stream 由回放页「获取录制区域」流程获取（getDisplayMedia + RestrictionTarget 裁剪），
 * 本模块只负责编码与下载：start(stream, baseName) → stop() → onstop 合成 Blob 自动下载。
 *
 * 编码格式：优先 MP4/H.264（Chrome/Edge 107+，兼容性最好、播放器/剪辑软件通用），
 * 不支持则回退 WebM/VP9 → WebM。文件名后缀与 Blob 类型跟随实际选定的容器。
 */

const Recorder = {
  mediaRecorder: null,
  chunks: [],
  fileName: 'replay.mp4',
  mimeType: '',           // 实际选定的 mimeType（start 后可用）
  onStateChange: null,

  isRecording() {
    return !!this.mediaRecorder && this.mediaRecorder.state === 'recording';
  },

  /** 按优先级选择编码格式：MP4/H.264 → WebM/VP9 → WebM */
  pickMimeType() {
    const candidates = [
      'video/mp4;codecs=avc1.42E01E',  // H.264 Baseline（兼容性最好）
      'video/mp4;codecs=avc1',
      'video/mp4',
      'video/webm;codecs=vp9',
      'video/webm',
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
   */
  start(stream, baseName) {
    if (this.isRecording()) return;
    this.mimeType = this.pickMimeType();
    const isMp4 = this.mimeType.indexOf('video/mp4') === 0;
    this.fileName = (baseName || 'replay') + (isMp4 ? '.mp4' : '.webm');
    const opts = this.mimeType ? { mimeType: this.mimeType } : {};
    this.mediaRecorder = new MediaRecorder(stream, Object.assign({
      videoBitsPerSecond: 8000000,
    }, opts));
    this.chunks = [];
    this.mediaRecorder.ondataavailable = e => { if (e.data && e.data.size > 0) this.chunks.push(e.data); };
    this.mediaRecorder.onstop = () => {
      // 合成 Blob 并自动下载；容器类型跟随实际编码（mp4/webm）
      const container = this.mimeType.indexOf('video/mp4') === 0 ? 'video/mp4' : 'video/webm';
      const blob = new Blob(this.chunks, { type: container });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = this.fileName;
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 5000);
      this.mediaRecorder = null;
      this.chunks = [];
      if (this.onStateChange) this.onStateChange(false);
    };
    this.mediaRecorder.start(1000);
    if (this.onStateChange) this.onStateChange(true);
  },

  /**
   * 停止录制并触发下载。返回 Promise，在 onstop（下载完成）后 resolve，
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
