/* ============================================================
 * eval.js — 金标准评测引擎（方案 2.3 评测方法）
 * 以医生真实书写的入院记录为金标准，与 AI 草稿逐字段比对：
 *   相似度 = 字符级 bigram F1（对中文医学表述稳健，无需分词）
 *   判定   = ≥0.85 一致 / ≥0.60 基本一致 / >0 偏差 / 空白 缺失
 *   覆盖率 = AI 有内容且金标准有内容的字段占比
 *   可用率 = "一致 + 基本一致"字段占比（对应"确认修改为主"的可用定义）
 * 算法可替换：正式版将换用医学命名实体级比对。
 * ============================================================ */

function bigrams(s) {
  const t = String(s).replace(/\s+/g, '');
  const m = new Map();
  for (let i = 0; i < t.length - 1; i++) {
    const g = t.slice(i, i + 2);
    m.set(g, (m.get(g) || 0) + 1);
  }
  return m;
}

export function similarity(a, b) {
  if (!a || !b) return 0;
  const A = bigrams(a), B = bigrams(b);
  let ta = 0, tb = 0, overlap = 0;
  A.forEach(v => ta += v);
  B.forEach(v => tb += v);
  A.forEach((v, g) => { if (B.has(g)) overlap += Math.min(v, B.get(g)); });
  return ta + tb === 0 ? 0 : 2 * overlap / (ta + tb);
}

export function verdictOf(sim, aiFilled, goldFilled) {
  if (!goldFilled) return { cls: 'norm', label: '金标准缺项' };
  if (!aiFilled) return { cls: 'miss', label: '缺失' };
  if (sim >= 0.85) return { cls: 'dlg', label: '一致' };
  if (sim >= 0.60) return { cls: 'his', label: '基本一致' };
  return { cls: 'miss', label: '偏差' };
}

/**
 * @param fields  AI 草稿字段数组（agents.js 产出）
 * @param gold    金标准字段对象 { chief, present, ... }
 * @returns {{rows, metrics}}
 */
export function evaluateAgainstGold(fields, gold) {
  const rows = fields
    .filter(f => gold[f.id] !== undefined)
    .map(f => {
      const ai = (f.value || '').trim();
      const gd = (gold[f.id] || '').trim();
      const sim = similarity(ai, gd);
      const v = verdictOf(sim, ai.length > 0, gd.length > 0);
      return { label: f.label, id: f.id, ai, gold: gd, sim, cls: v.cls, judge: v.label, edited: !!f.edited };
    });
  const total = rows.length;
  const covered = rows.filter(r => r.ai && r.gold).length;
  const usable = rows.filter(r => r.cls === 'dlg' || r.cls === 'his').length;
  const avgSim = covered ? rows.filter(r => r.ai && r.gold).reduce((s, r) => s + r.sim, 0) / covered : 0;
  return {
    rows,
    metrics: {
      total,
      covered,
      coverage: total ? covered / total : 0,
      avgSim,
      usable,
      usableRate: total ? usable / total : 0,
    },
  };
}
