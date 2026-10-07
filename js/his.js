/* ============================================================
 * his.js — 患者与诊疗数据源 Provider（M3 前置骨架，接口约定见
 * docs/接口与字段映射说明.md 第二节 I-1）
 * 双模式同构：
 *   · export（默认）：本地真实导出数据（js/data.js，程序化生成）——同步可用，
 *     服务端 /api/his/patient 仅返回模式标记；
 *   · api：服务端代理拉取医院 HIS（/api/his/patient），返回数据**权威覆盖**
 *     导出数据的 labs/orders/vitals/history 与基本信息——医生在患者核对页
 *     看到的即实时 HIS 数据；
 *   · api 模式拉取失败：如实提示并回落导出数据（不阻断接诊，不虚构）。
 * 前端视图不感知模式差异（enrichPatient 返回同构患者对象）。
 * ============================================================ */

import { serverState } from './sync.js';

let _statusCache = null;

/* 服务端 HIS 模式状态：{mode, baseUrl, hasToken}；BFF 离线 → {mode:'offline'} */
export async function hisStatus(force) {
  if (_statusCache && !force) return _statusCache;
  if (!serverState.online) { _statusCache = { mode: 'offline' }; return _statusCache; }
  try {
    _statusCache = await fetch('/api/his/status').then(r => r.json());
  } catch (_) {
    _statusCache = { mode: 'offline' };
  }
  return _statusCache;
}

export function hisSourceLabel(st) {
  if (!st || st.mode === 'offline') return '导出数据（本机模式）';
  if (st.mode === 'api') return 'HIS 实时接口' + (st.baseUrl ? '（' + st.baseUrl.replace(/^https?:\/\//, '').slice(0, 30) + '）' : '');
  return '导出数据（真实病案/HIS 导出）';
}

/**
 * 患者数据增强：api 模式下拉取实时 HIS 并覆盖导出数据；其余模式原样返回。
 * @returns Promise<{patient, source:'export'|'api', error?}> —— 永不 reject
 */
export async function enrichPatient(patient) {
  const st = await hisStatus();
  if (st.mode !== 'api') return { patient, source: 'export' };
  try {
    const q = '?pid=' + encodeURIComponent(patient.id) +
      (patient.visitNo ? '&visit=' + encodeURIComponent(patient.visitNo) : '');
    const r = await fetch('/api/his/patient' + q);
    const j = await r.json();
    if (!r.ok) return { patient, source: 'export', error: (j && (j.error || j.note)) || ('HTTP ' + r.status) };
    if (j.mode !== 'api') return { patient, source: 'export' };
    /* API 数据权威覆盖导出数据（结构同约定 I-1，服务端已归一化） */
    const p = { ...patient };
    const bp = j.patient || {};
    ['marriage', 'birthplace', 'ward', 'admittedAt', 'allergies'].forEach(k => {
      if (bp[k]) p[k] = bp[k];
    });
    if (bp.name && bp.name !== patient.name) p.nameFromHIS = bp.name; // 姓名不一致仅提示，不静默改
    p.his = {
      ...(p.his || {}),
      labs: Array.isArray(j.labs) ? j.labs : (p.his && p.his.labs) || [],
      orders: Array.isArray(j.orders) ? j.orders : (p.his && p.his.orders) || [],
      vitals: (j.vitals && j.vitals.T) ? j.vitals : (p.his && p.his.vitals) || {},
      visits: Array.isArray(j.history)
        ? j.history.map(h => h.date + ' ' + (h.dx || '')).filter(Boolean)
        : (p.his && p.his.visits) || [],
    };
    p.hisHistory = Array.isArray(j.history) ? j.history : undefined;
    p.hisSource = 'api';
    return { patient: p, source: 'api' };
  } catch (e) {
    return { patient, source: 'export', error: e.message || String(e) };
  }
}
