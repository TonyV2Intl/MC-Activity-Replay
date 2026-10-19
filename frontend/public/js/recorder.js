/**
 * recorder.js — 浏览器录屏（getDisplayMedia + MediaRecorder）
 * 流程：进入录制模式（隐藏 UI）→ 用户选择录制源 → 停止后自动下载 webm
 */

const Recorder = {
  mediaRecorder: null,
  chunks: [],
  stream: null,
  onStateChange: null,

  isRecording() {
    return !!this.mediaRecorder && this.mediaRecorder.state === 'recording';
  },

  /** 开始录屏（会弹出浏览器源选择框，用户需选择当前标签页） */
  async start() {
    if (this.isRecording()) return;
    if (!navigator.mediaDevices || !navigator.mediaDevices.getDisplayMedia) {
      throw new Error('当前浏览器不支持屏幕录制 API');
    }
    this.stream = await navigator.mediaDevices.getDisplayMedia({
      video: { frameRate: 30 },
      audio: false,
    });
    // 用户通过浏览器 UI 停止共享时，同步结束录制
    this.stream.getVideoTracks()[0].addEventListener('ended', () => this.stop());

    const mimeType = MediaRecorder.isTypeSupported('video/webm;codecs=vp9')
      ? 'video/webm;codecs=vp9'
      : 'video/webm';
    // 后续步骤（构造 MediaRecorder / 绑定事件 / start）失败时，
    // 必须释放已获取的屏幕流，否则浏览器标签页会一直显示"共享中"
    try {
      this.mediaRecorder = new MediaRecorder(this.stream, { mimeType, videoBitsPerSecond: 8000000 });
      this.chunks = [];
      this.mediaRecorder.ondataavailable = e => { if (e.data && e.data.size > 0) this.chunks.push(e.data); };
      this.mediaRecorder.onstop = () => {
        const blob = new Blob(this.chunks, { type: 'video/webm' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = 'replay-' + new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19) + '.webm';
        document.body.appendChild(a);
        a.click();
        a.remove();
        setTimeout(() => URL.revokeObjectURL(url), 5000);
        this.cleanup();
        if (this.onStateChange) this.onStateChange(false);
      };
      this.mediaRecorder.start(1000);
    } catch (e) {
      this.cleanup();
      throw e;
    }
    if (this.onStateChange) this.onStateChange(true);
  },

  /** 停止录屏并触发下载 */
  stop() {
    if (this.mediaRecorder && this.mediaRecorder.state !== 'inactive') {
      this.mediaRecorder.stop();
    }
  },

  cleanup() {
    if (this.stream) {
      this.stream.getTracks().forEach(t => t.stop());
      this.stream = null;
    }
    this.mediaRecorder = null;
    this.chunks = [];
  },
};
