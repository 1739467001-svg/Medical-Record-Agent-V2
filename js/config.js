/* ============================================================
 * config.js — 系统配置存储（M2.0：密钥服务端存储，docs/M2构建规划.md S1/S3）
 * 服务端在线：密钥经 /api/config 存 data_server/config.json（0600），
 * 浏览器仅持 _srv"已配置"标记（不含任何密钥明文）；
 * 服务端离线：回退本机 localStorage 模式（演示用，界面有明示）。
 * ============================================================ */

const KEY = 'medagent_cfg';

export function defaults() {
  return {
    asr: {
      engine: 'demo',
      iflytek: { appId: '', apiKey: '', apiSecret: '' },
      aliyun: { appKey: '', apiKey: '' },
    },
    llm: { baseUrl: '', apiKey: '', model: '' },
    gen: 'auto', // 生成引擎：auto=大模型就绪即启用（失败回落规则）| rules=强制规则演示
    _srv: null, // 服务端状态标记（由 adoptServerStatus 写入）
  };
}

export function getConfig() {
  try {
    const raw = JSON.parse(localStorage.getItem(KEY));
    if (!raw || !raw.asr) return defaults();
    return { ...defaults(), ...raw };
  } catch (_) {
    return defaults();
  }
}

export function saveConfig(cfg) {
  localStorage.setItem(KEY, JSON.stringify(cfg));
}

/* 服务端状态落地为本地"已配置"标记（不含密钥明文） */
export function adoptServerStatus(st) {
  const c = getConfig();
  c._srv = {
    engine: st.engine || 'demo',
    iflytek: {
      appId: st.iflytek?.appId || '',
      hasKey: !!st.iflytek?.hasKey,
      hasSecret: !!st.iflytek?.hasSecret,
    },
    aliyun: {
      appKey: st.aliyun?.appKey || '',
      hasKey: !!st.aliyun?.hasKey,
    },
    llm: {
      baseUrl: st.llm?.baseUrl || '',
      model: st.llm?.model || '',
      hasKey: !!st.llm?.hasKey,
    },
  };
  saveConfig(c);
}

export function asrConfigured(id) {
  const c = getConfig();
  if (id === 'iflytek') {
    // rtasr 签名需要 appId+apiKey+apiSecret 三项齐备
    return !!(c.asr.iflytek.appId && c.asr.iflytek.apiKey && c.asr.iflytek.apiSecret) ||
           !!(c._srv?.iflytek?.hasKey && c._srv?.iflytek?.hasSecret);
  }
  if (id === 'aliyun') {
    return !!(c.asr.aliyun.appKey && c.asr.aliyun.apiKey) || !!c._srv?.aliyun?.hasKey;
  }
  return true; // demo / webspeech 无需配置
}

export function llmConfigured() {
  const c = getConfig();
  return !!(c.llm.baseUrl && c.llm.apiKey);
}

export function llmServerReady() {
  return !!getConfig()._srv?.llm?.hasKey;
}

/* 大模型连通性测试（本机直连模式，OpenAI 兼容 /models 端点；服务端在线时改走 /api/llm/test） */
export async function testLLM() {
  const c = getConfig();
  if (!llmConfigured()) return { ok: false, msg: '请先填写 Base URL 与 API Key' };
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 8000);
  try {
    const url = c.llm.baseUrl.replace(/\/+$/, '') + '/models';
    const r = await fetch(url, { headers: { Authorization: 'Bearer ' + c.llm.apiKey }, signal: ctrl.signal });
    clearTimeout(timer);
    if (r.ok) return { ok: true, msg: '连接成功（/models 可访问）' };
    return { ok: false, msg: `服务响应 ${r.status}：请核对地址与密钥` };
  } catch (e) {
    clearTimeout(timer);
    return {
      ok: false,
      msg: e.name === 'AbortError'
        ? '连接超时（8s）：请核对地址网络可达性'
        : `无法连接：${e.message}（服务端在线时可经 BFF 代理避免 CORS）`,
    };
  }
}
