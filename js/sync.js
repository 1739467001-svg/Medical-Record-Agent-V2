/* ============================================================
 * sync.js — 与 BFF 服务端的同步层（M2.0，docs/M2构建规划.md S2）
 * 启动探测 /api/health → 在线则合并服务端留痕/归档；
 * 本地操作异步上报（失败静默）。服务端离线自动降级本机模式。
 * ============================================================ */

export const serverState = { online: false, info: null };

async function jfetch(url, opts) {
  const r = await fetch(url, opts);
  return r.json();
}

export async function bootSync() {
  try {
    const h = await jfetch('/api/health');
    serverState.online = true;
    serverState.info = h;
    const [logs, arcs] = await Promise.all([
      jfetch('/api/audit?limit=300').catch(() => []),
      jfetch('/api/archives').catch(() => []),
    ]);
    try {
      const local = JSON.parse(localStorage.getItem('medagent_archives') || '[]');
      const seen = new Set(local.map(a => a.id));
      const merged = [...(Array.isArray(arcs) ? arcs : []).filter(a => !seen.has(a.id)), ...local];
      localStorage.setItem('medagent_archives', JSON.stringify(merged.slice(0, 200)));
    } catch (_) { /* 存储不可用时跳过合并 */ }
    try {
      const local = JSON.parse(localStorage.getItem('medagent_logs') || '[]');
      const key = l => [l.time, l.action, l.detail, l.doctor].join('|');
      const seen = new Set(local.map(key));
      const merged = [...(Array.isArray(logs) ? logs : []).filter(l => !seen.has(key(l))), ...local];
      localStorage.setItem('medagent_logs', JSON.stringify(merged.slice(0, 400)));
    } catch (_) { /* 同上 */ }
  } catch (_) {
    serverState.online = false;
  }
}

export function postAudit(entries) {
  if (!serverState.online || !entries || !entries.length) return;
  fetch('/api/audit', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ entries }),
  }).catch(() => { /* 离线/失败静默：本地留痕仍在 */ });
}

export function postArchive(a) {
  if (!serverState.online) return Promise.resolve(false);
  return fetch('/api/archives', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(a),
  }).then(r => r.ok).catch(() => false);
}

export async function postConfig(cfg) {
  if (!serverState.online) return null;
  return jfetch('/api/config', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(cfg),
  });
}

export async function serverLLMTest() {
  return jfetch('/api/llm/test', { method: 'POST', body: '{}' });
}

/* 生成智能体的大模型调用（M2.1，经服务端代理 /api/llm/chat；密钥不出服务器）。
 * 返回 {ok, upstream} 或 {ok:false, error}——绝不抛异常，由调用方回落规则引擎。 */
export async function serverLLMChat(body) {
  if (!serverState.online) return { ok: false, error: '服务端离线（本机演示模式）' };
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 40000);
  try {
    const r = await fetch('/api/llm/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: ctrl.signal,
    });
    const j = await r.json();
    if (!r.ok) return { ok: false, error: (j && (j.error || j.msg)) || ('HTTP ' + r.status) };
    return j;
  } catch (e) {
    return { ok: false, error: e.name === 'AbortError' ? '生成超时（40s）' : (e.message || String(e)) };
  } finally {
    clearTimeout(timer);
  }
}
