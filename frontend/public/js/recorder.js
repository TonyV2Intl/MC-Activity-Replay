/**
 * recorder.js — 浏览器录屏（MediaRecorder 封装）
 * screen stream 由回放页「获取录制区域」流程获取（getDisplayMedia + RestrictionTarget 裁剪），
 * 本模块只负责编码与下载：start(stream, baseName) → stop() → onstop 合成 Blob 自动下载。
 *
 * 编码格式：仅 MP4/H.264（Chrome/Edge 107+，兼容性最好、播放器/剪辑软件通用），
 * 按 avc1.42E01E（Baseline）→ avc1 → mp4 优先级探测；浏览器均不支持时拒绝启动，
 * 由调用方提示用户。文件名固定 .mp4，Blob 容器固定 video/mp4。
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
   * @returns {boolean} true=已开始录制；false=浏览器不支持 MP4/H.264，未启动
   */
  start(stream, baseName) {
    if (this.isRecording()) return false;
    this.mimeType = this.pickMimeType();
    if (!this.mimeType) return false;  // 不支持 MP4/H.264，拒绝启动（不回退 WebM/VP9）
    this.fileName = (baseName || 'replay') + '.mp4';
    this.mediaRecorder = new MediaRecorder(stream, {
      mimeType: this.mimeType,
      videoBitsPerSecond: 8000000,
    });
    this.chunks = [];
    this.mediaRecorder.ondataavailable = e => { if (e.data && e.data.size > 0) this.chunks.push(e.data); };
    this.mediaRecorder.onstop = () => {
      // 合成 Blob 并自动下载；容器固定 MP4
      const blob = new Blob(this.chunks, { type: 'video/mp4' });
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
    return true;
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
