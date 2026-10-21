/**
 * recorder.js — 浏览器录屏（MediaRecorder 封装）
 * screen stream 由回放页「获取录制区域」流程获取（getDisplayMedia + RestrictionTarget 裁剪），
 * 本模块只负责编码与下载：start(stream, fileName) → stop() → onstop 合成 Blob 自动下载
 */

const Recorder = {
  mediaRecorder: null,
  chunks: [],
  fileName: 'replay.webm',
  onStateChange: null,

  isRecording() {
    return !!this.mediaRecorder && this.mediaRecorder.state === 'recording';
  },

  /**
   * 用已获取的 screen stream 开始录制（不负责获取 stream）。
   * @param {MediaStream} stream getDisplayMedia 得到的屏幕流
   * @param {string} fileName 下载文件名（如 replay-2-20261022-001712.webm）
   */
  start(stream, fileName) {
    if (this.isRecording()) return;
    this.fileName = fileName || 'replay.webm';
    const mimeType = MediaRecorder.isTypeSupported('video/webm;codecs=vp9')
      ? 'video/webm;codecs=vp9'
      : 'video/webm';
    this.mediaRecorder = new MediaRecorder(stream, { mimeType, videoBitsPerSecond: 8000000 });
    this.chunks = [];
    this.mediaRecorder.ondataavailable = e => { if (e.data && e.data.size > 0) this.chunks.push(e.data); };
    this.mediaRecorder.onstop = () => {
      const blob = new Blob(this.chunks, { type: 'video/webm' });
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
