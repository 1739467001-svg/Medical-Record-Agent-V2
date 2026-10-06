/* ============================================================
 * asr.js — 方言语音识别（ASR）可替换模块（方案 4.2）
 * 真实数据环境：本模块不内置任何演示转写脚本。
 *  - 浏览器引擎：真实麦克风录音 + 实时识别（Chrome，普通话）；
 *  - 讯飞：实时语音转写 WS 通道已接通（js/rtasr.js，按官方协议实现），
 *    密钥经"系统设置"登记即就绪，签名由服务端 /api/asr/sign 计算；
 *  - 阿里：Token 流程与 WS 通道 M2.1 挂接；
 *  - 转写不可用时，病历生成素材自动切换为真实病案文书（数据汇聚），
 *    界面明示素材源，不生成任何虚构转写文本。
 * ============================================================ */

import { asrConfigured } from './config.js';

export const ASR_ENGINES = [
  {
    id: 'webspeech',
    name: '浏览器语音引擎',
    desc: '真实麦克风录音 + 实时识别（Chrome，普通话）；不支持方言对照轨',
  },
  {
    id: 'iflytek',
    name: '科大讯飞',
    desc: '实时语音转写（真实 WS 通道已接通）：密钥就绪后麦克风 16k PCM 实时上行，医疗垂直领域（pd=medical）+ 近场模式；签名由服务端计算',
  },
  {
    id: 'aliyun',
    name: '阿里云',
    desc: '智能语音交互；密钥已在"系统设置"登记即就绪，Token 流程与 WS 通道 M2.1 挂接',
  },
];

export function engineReady(id) {
  if (id === 'webspeech') return 'SpeechRecognition' in window || 'webkitSpeechRecognition' in window;
  return asrConfigured(id);
}

/**
 * 浏览器语音引擎（真实麦克风，识别普通话）。返回同构控制器。
 */
export function startWebSpeechASR(handlers) {
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!SR) {
    handlers.onError && handlers.onError('当前浏览器不支持 Web Speech API，请改用 Chrome，或等待云端引擎接入');
    return null;
  }
  const rec = new SR();
  rec.lang = 'zh-CN';
  rec.continuous = true;
  rec.interimResults = true;

  let finalText = '';
  rec.onresult = (e) => {
    let interim = '';
    for (let k = e.resultIndex; k < e.results.length; k++) {
      const t = e.results[k][0].transcript;
      if (e.results[k].isFinal) finalText += t;
      else interim += t;
    }
    handlers.onProgress && handlers.onProgress(finalText + interim, -1);
  };
  rec.onerror = (e) => handlers.onError && handlers.onError('语音识别错误：' + e.error);
  rec.onend = () => { handlers.onDone && handlers.onDone(); };

  try { rec.start(); } catch (err) { handlers.onError && handlers.onError('无法启动麦克风：' + err.message); return null; }

  return {
    stop() { try { rec.stop(); } catch (_) {} },
  };
}
