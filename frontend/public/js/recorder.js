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
 * 报告失败；诊断信息（UA/编码支持/分片数字节数/帧数/后台时长）记录在 diag。
 *
 * 帧观测：MediaRecorder 的 dataavailable 受 timeslice 与编码格式影响（MP4 可能
 * 只在 stop 时产出），不能用来判断「有没有画面」；这里用 MediaStreamTrackProcessor
 * （降级：隐藏 video + rVFC）独立统计真实到达的帧（frameCount），供回放页录制中
 * 看护（watchdog）与失败原因分支使用，与编码/分片机制无关。
 */

// 空数据时的失败原因（展示给用户；未切后台的无帧场景）
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
  frameCount: 0,          // 录制期间实际到达的视频帧数（帧观测器统计）
  frameMonitorActive: false, // 帧观测是否生效（决定了回放页 watchdog 能否工作）
  _monitorReader: null,   // MediaStreamTrackProcessor 的 reader（首选方案）
  _monitorVideo: null,    // 降级方案的隐藏 video
  _hiddenSince: null,     // 进入后台的时刻（performance.now），null=当前在前台

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
   * 记录页面可见性变化（由回放页 visibilitychange 调用），累计录制期间
   * 处于后台的时长，用于失败原因诊断（切后台时 tab capture 不产帧）。
   */
  noteVisibility(hidden) {
    const now = performance.now();
    if (hidden) {
      if (this._hiddenSince == null) this._hiddenSince = now;
    } else {
      this._flushHidden(now);
    }
  },

  /** 把「本次后台区间」累计进 diag.hiddenTotalMs */
  _flushHidden(now) {
    if (this._hiddenSince != null) {
      this.diag.hiddenTotalMs = (this.diag.hiddenTotalMs || 0) + (now - this._hiddenSince);
      this._hiddenSince = null;
    }
  },

  /**
   * 帧观测：统计录制期间真实到达的视频帧。MediaRecorder 的 dataavailable 受
   * timeslice 与编码格式影响（MP4 可能只在 stop 时产出），不能用来判断
   * 「有没有画面」，故独立计数：
   *   首选 MediaStreamTrackProcessor——直接从轨道读帧，不依赖 video 播放，
   *     无帧流下也能正常工作（这正是看护判定 0KB 风险所需要的）；
   *   降级 隐藏 video + requestVideoFrameCallback——需要 video 成功开始播放，
   *     无帧流时 play() 会一直 pending（观测不生效 → watchdog 自动禁用）。
   * 观测器只是轨道的「旁路 tap」：不与 MediaRecorder 争帧，cancel 不会结束轨道。
   */
  _startFrameMonitor(stream) {
    this._stopFrameMonitor();
    this.frameCount = 0;
    this.frameMonitorActive = false;
    const track = stream.getVideoTracks()[0];
    if (!track) return;
    // 首选：MediaStreamTrackProcessor
    if (typeof MediaStreamTrackProcessor !== 'undefined') {
      try {
        const reader = new MediaStreamTrackProcessor(track).readable.getReader();
        this._monitorReader = reader;
        this.frameMonitorActive = true;
        const pump = async () => {
          try {
            while (this._monitorReader) {
              const { value, done } = await reader.read();
              if (done) break;
              this.frameCount++;
              if (value && typeof value.close === 'function') value.close(); // 释放 VideoFrame
            }
          } catch (e) { /* 观测中止（轨道结束/cancel） */ }
        };
        pump();
        return;
      } catch (e) { /* 落到降级方案 */ }
    }
    // 降级：隐藏 video + requestVideoFrameCallback
    let v;
    try {
      v = document.createElement('video');
      v.muted = true;
      v.playsInline = true;
      v.setAttribute('aria-hidden', 'true');
      v.setAttribute('data-recorder-monitor', '1');
      v.style.cssText = 'position:fixed;left:-9999px;top:0;width:1px;height:1px;' +
        'opacity:0;pointer-events:none;';
      v.srcObject = stream;
    } catch (e) { return; }
    if (!v.requestVideoFrameCallback) return; // 老浏览器：放弃帧观测
    this._monitorVideo = v;
    const tick = () => {
      this.frameCount++;
      if (this._monitorVideo) this._monitorVideo.requestVideoFrameCallback(tick);
    };
    v.requestVideoFrameCallback(tick);
    try { document.body.appendChild(v); } catch (e) { /* 不挂 DOM 也能播，继续 */ }
    try {
      const p = v.play();
      if (p && typeof p.then === 'function') {
        p.then(() => { this.frameMonitorActive = true; })
          .catch(() => { this._stopFrameMonitor(); });
      } else {
        this.frameMonitorActive = true;
      }
    } catch (e) { /* play 同步抛错：放弃观测 */ }
  },

  _stopFrameMonitor() {
    const reader = this._monitorReader;
    this._monitorReader = null;
    this.frameMonitorActive = false;
    if (reader) {
      try { reader.cancel(); } catch (e) { /* 忽略 */ }
    }
    const v = this._monitorVideo;
    this._monitorVideo = null;
    if (v) {
      try { v.pause(); } catch (e) { /* 忽略 */ }
      try { v.srcObject = null; } catch (e) { /* 忽略 */ }
      try { v.remove(); } catch (e) { /* 忽略 */ }
    }
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
    this._hiddenSince = null;
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
      frames: 0,
      hiddenTotalMs: 0,
      hiddenAtStop: false,
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
      const wasHidden = this._hiddenSince != null;
      this._flushHidden(performance.now());
      this.diag.chunkCount = chunks.length;
      this.diag.totalBytes = bytes;
      this.diag.frames = this.frameCount;
      this.diag.hiddenAtStop = wasHidden;
      this._stopFrameMonitor();
      this.mediaRecorder = null;
      this.chunks = [];
      if (bytes <= 0) {
        // 无任何视频数据（如「当前标签页」源在页面静止/后台时不产帧）：
        // 不下载 0KB 文件，按帧观测结果给出针对性原因与诊断信息
        const hiddenSec = Math.round((this.diag.hiddenTotalMs || 0) / 1000);
        let msg;
        if (this.frameCount === 0) {
          msg = (hiddenSec > 0 || wasHidden)
            ? '录制失败：录制期间页面有约 ' + hiddenSec + ' 秒处于后台/被其他窗口遮挡，' +
              '「当前标签页」源在此期间不产出画面。请保持本标签页在前台播放，' +
              '或重新获取区域时选择「整个屏幕」作为录制源'
            : EMPTY_DATA_MSG;
        } else {
          msg = '录制失败：已捕获 ' + this.frameCount + ' 帧画面，但浏览器编码器未产出任何视频数据。' +
            '请重试；若持续失败，请更换 Chrome/Edge 107+ 浏览器';
        }
        console.error('[Recorder] 录制结束但无视频数据', this.diag);
        if (this.onStateChange) this.onStateChange(false, msg);
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
    this._startFrameMonitor(stream);
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
