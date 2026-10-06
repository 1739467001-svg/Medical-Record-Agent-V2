/* ============================================================
 * rtasr.js — 讯飞实时语音转写（真实 WS 通道，M2.1 S6）
 * 协议依据官方文档 https://www.xfyun.cn/doc/asr/rtasr/API.html：
 *   · WS：wss://rtasr.xfyun.cn/v1/ws?appid=&ts=&signa=[&pd=medical&vadMdn=2]
 *   · 鉴权：signa = base64(HmacSHA1(key=apiKey, msg=MD5hex(appid+ts)))，
 *     由服务端 /api/asr/sign 计算，密钥明文不出服务器；
 *   · 音频：16kHz / 16bit / 单声道 PCM，每 40ms 发 1280 字节（640 采样），
 *     发送过快引擎报错、超 15s 不发断连；
 *   · 结束：发送二进制帧 {"end": true}，服务端回完最终结果后主动断开；
 *   · 回包：action=started/result/error；result.data 是 JSON 字符串（二次解析），
 *     data.cn.st.rt[].ws[].cw[].w 为词，st.type 0=最终 1=中间。
 * 无任何模拟/桩：连接、鉴权、分帧、解析全部真实；失败如实上报错误。
 * ============================================================ */

/* AudioWorklet 源码（内联注册，无需独立文件）：
 * 输入任意采样率 Float32 → 线性重采样到 16k → Int16 累积成 640 采样（1280 字节）帧 → postFrame */
const WORKLET_SRC = `
class PcmFramer extends AudioWorkletProcessor {
  constructor() {
    super();
    this.RATE = 16000;
    this.FRAME = 640;              // 640 采样 * 2 字节 = 1280 字节 = 40ms
    this.ratio = sampleRate / this.RATE;
    this.inBuf = new Float32Array(0);
    this.outBuf = new Int16Array(this.FRAME);
    this.outFill = 0;
  }
  resample(input) {
    if (Math.abs(this.ratio - 1) < 1e-6) return input;
    const outLen = Math.max(1, Math.floor(input.length / this.ratio));
    const out = new Float32Array(outLen);
    for (let i = 0; i < outLen; i++) {
      const pos = i * this.ratio;
      const i0 = Math.floor(pos), i1 = Math.min(i0 + 1, input.length - 1);
      out[i] = input[i0] + (input[i1] - input[i0]) * (pos - i0);
    }
    return out;
  }
  process(inputs) {
    const ch = inputs[0] && inputs[0][0];
    if (!ch) return true;
    const s = this.resample(ch);
    for (let i = 0; i < s.length; i++) {
      let v = Math.max(-1, Math.min(1, s[i]));
      this.outBuf[this.outFill++] = v < 0 ? v * 0x8000 : v * 0x7fff;
      if (this.outFill === this.FRAME) {
        this.port.postMessage(this.outBuf.buffer.slice(0), [this.outBuf.buffer.slice(0)]);
        this.outFill = 0;
      }
    }
    return true;
  }
}
registerProcessor('pcm-framer', PcmFramer);
`;

function b64ToBuf(b64) {
  const bin = atob(b64);
  const buf = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) buf[i] = bin.charCodeAt(i);
  return buf.buffer;
}

/* 从 result.data（JSON 字符串，二次解析）提取句子文本 */
function extractText(dataObj) {
  const st = dataObj && dataObj.cn && dataObj.cn.st;
  if (!st || !Array.isArray(st.rt)) return null;
  let text = '';
  st.rt.forEach(rt => {
    (rt.ws || []).forEach(ws => {
      (ws.cw || []).forEach(cw => {
        if (cw.w) text += cw.w; // wp='s' 为顺滑词（语气词），默认保留原样交医生核对
      });
    });
  });
  return text;
}

/**
 * 启动讯飞实时转写（真实麦克风 + 真实 WS）。
 * handlers: onProgress(全部文本) / onStatus(状态文案) / onError(msg) / onDone()
 * 返回控制器 { stop() }；stop() 发送结束帧，服务端回完最终结果断开后触发 onDone。
 */
export async function startRtasrASR(handlers) {
  /* 1. 服务端取签名（密钥不出服务器） */
  let sign;
  try {
    const r = await fetch('/api/asr/sign', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ engine: 'iflytek' }),
    });
    sign = await r.json();
  } catch (e) {
    handlers.onError && handlers.onError('获取讯飞签名失败：' + (e.message || e));
    return null;
  }
  if (!sign || sign.error) {
    handlers.onError && handlers.onError('讯飞签名获取失败：' + ((sign && sign.error) || '服务端不可达'));
    return null;
  }

  /* 2. 真实麦克风采集（先过权限关，失败如实报错） */
  let stream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({
      audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true },
    });
  } catch (e) {
    handlers.onError && handlers.onError('未获得麦克风权限，无法实时转写：' + (e.name || e.message));
    return null;
  }

  /* 3. AudioWorklet：16k/16bit/1280B 分帧 */
  const audioCtx = new (window.AudioContext || window.webkitAudioContext)({ sampleRate: 16000 });
  let node = null;
  try {
    const blobURL = URL.createObjectURL(new Blob([WORKLET_SRC], { type: 'application/javascript' }));
    await audioCtx.audioWorklet.addModule(blobURL);
    URL.revokeObjectURL(blobURL);
    node = new AudioWorkletNode(audioCtx, 'pcm-framer');
  } catch (e) {
    stream.getTracks().forEach(t => t.stop());
    audioCtx.close();
    handlers.onError && handlers.onError('浏览器不支持 AudioWorklet，无法分帧上传：' + (e.message || e));
    return null;
  }
  const src = audioCtx.createMediaStreamSource(stream);
  src.connect(node);
  // 不连 destination：只采集不出声（避免回授）

  /* 4. WS 通道（真实连接 rtasr.xfyun.cn） */
  const url = 'wss://rtasr.xfyun.cn/v1/ws?appid=' + encodeURIComponent(sign.appId) +
    '&ts=' + encodeURIComponent(sign.ts) + '&signa=' + encodeURIComponent(sign.signature) +
    '&pd=medical&vadMdn=2'; // pd=medical 医疗垂直领域；vadMdn=2 近场（问诊场景）
  const ws = new WebSocket(url);
  ws.binaryType = 'arraybuffer';

  let started = false;
  let finalText = '';      // 已定稿句子（st.type=0）
  let midText = '';        // 进行中句子（st.type=1，逐次替换）
  let closedByServer = false;
  let stopped = false;
  let finished = false;    // finish 幂等保护（onclose/error/兜底计时器可能竞争）
  let finishTimer = null;
  const pending = [];      // started 前缓存的帧（启动竞态保护）

  const emit = () => handlers.onProgress && handlers.onProgress(finalText + midText);
  const finish = (errMsg) => {
    if (finished) return;
    finished = true;
    if (finishTimer) { clearTimeout(finishTimer); finishTimer = null; }
    try { node && node.disconnect(); } catch (_) {}
    try { src && src.disconnect(); } catch (_) {}
    try { stream.getTracks().forEach(t => t.stop()); } catch (_) {}
    try { audioCtx.close(); } catch (_) {}
    if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING) {
      try { ws.close(); } catch (_) {}
    }
    if (errMsg) handlers.onError && handlers.onError(errMsg);
    else handlers.onDone && handlers.onDone(finalText);
  };

  node.port.onmessage = (e) => {
    const frame = e.data; // ArrayBuffer 1280B
    if (ws.readyState === WebSocket.OPEN) {
      if (started) ws.send(frame);
      else pending.push(frame);
    }
  };

  ws.onopen = () => handlers.onStatus && handlers.onStatus('已连接讯飞引擎，等待会话启动…');
  ws.onmessage = (ev) => {
    let msg = null;
    try { msg = JSON.parse(ev.data); } catch (_) {}
    if (!msg || !msg.action) return;
    if (msg.action === 'started') {
      started = true;
      handlers.onStatus && handlers.onStatus('会话已启动，实时转写中…');
      while (pending.length && ws.readyState === WebSocket.OPEN) ws.send(pending.shift());
    } else if (msg.action === 'result') {
      let dataObj = null;
      try { dataObj = JSON.parse(msg.data); } catch (_) {}
      const text = extractText(dataObj);
      if (text != null && dataObj.cn && dataObj.cn.st) {
        if (String(dataObj.cn.st.type) === '0') {
          if (midText) { finalText += midText; midText = ''; }
          finalText += text;
        } else {
          midText = text;
        }
        emit();
      }
    } else if (msg.action === 'error') {
      finish('讯飞引擎返回错误（code ' + msg.code + '）：' + (msg.desc || '未知') +
        '——请核对"系统设置"中的讯飞密钥与套餐授权');
    }
  };
  ws.onerror = () => {
    if (!started && !stopped) finish('无法连接讯飞实时转写服务（网络不可达或密钥无效）');
  };
  ws.onclose = () => {
    closedByServer = true;
    if (finishTimer) { clearTimeout(finishTimer); finishTimer = null; }
    if (stopped) finish(); // stop() 后由服务端断开 → 正常收尾
    else if (!started) finish('连接被服务端关闭（鉴权失败或套餐未开通，请核对密钥）');
    else finish();
  };

  return {
    stop() {
      stopped = true;
      // 官方结束方式：发送二进制帧 {"end": true}，等服务端回完最终结果后其主动断开
      if (ws.readyState === WebSocket.OPEN) {
        try { ws.send(new TextEncoder().encode('{"end": true}').buffer); } catch (_) {}
        // 兜底：4s 内服务端未断开则本地收尾（onclose 与此竞争，finish 幂等由 finishTimer 控制）
        finishTimer = setTimeout(() => finish(), 4000);
        handlers.onStatus && handlers.onStatus('录音结束，等待最终转写结果…');
      } else {
        finish();
      }
    },
    get closedByServer() { return closedByServer; },
    _b64ToBuf: b64ToBuf, // 供离线音频测试集复用（测试导出）
  };
}
