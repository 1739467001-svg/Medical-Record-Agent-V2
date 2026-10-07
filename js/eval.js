/* ============================================================
 * eval.js — 金标准评测引擎（方案 2.3 评测方法；M2.2 升级：实体级比对）
 * 两把标尺：
 *   ① 字段级（原有）：字符级 bigram F1 相似度 → 一致/基本一致/偏差；
 *   ② 实体级（新增）：从文本抽取医学实体（诊断/药品/生命体征/检验数值），
 *      按集合命中计算召回率/精确率——衡量"事实是否说对"，不受措辞风格影响。
 *   实体抽取为规则法（无需分词/模型），可替换为 NER；抽取结果随对照行展示，
 *   漏报实体逐个列出，直接指出"草稿没写到的事实"。
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

/* ================= 实体抽取（规则法） ================= */

/* 诊断：按分隔符切段，保留"疾病样"片段（ endings 或含 ICD 编码） */
const DX_ENDINGS = /(炎|结石|症|病|综合征|供血不足|反流|感染|溃疡|穿孔|梗阻|息肉|囊肿|肌瘤|瘤|衰竭|功能不全|损伤|骨折|扭转|脱垂|狭窄|闭锁|贫血|结节|硬化|痛|压|热)$/;
export function extractDiagnoses(text) {
  if (!text) return [];
  const src = String(text);
  /* 切分：主分隔符 → "3."式编号（含"炎2.胆囊"这类编号直连：疾病结尾字后紧跟编号） */
  const segs = src.split(/[、；;，,\n。]+/)
    .flatMap(s => s.split(/(?<=[）)】》\s；;，,。、])\s*(?=\d{1,2}[.、])/))
    .flatMap(s => s.split(/(?<=[炎结石症病])\s*(?=\d{1,2}[.、])/))
    .flatMap(s => s.split(/(?<=[级期型])\s*(?=\d{1,2}[.、])/));
  const out = new Set();
  segs.forEach(s => {
    const t = s.replace(/^\s*[0-9１-９①-⑸（(.\s]+/, '').replace(/\s+/g, '')
      .replace(/（[^）]*）|\([^)]*\)/g, m => /[A-Z]\d{2}/.test(m) ? m : '') // 保留 ICD 括注
      .trim();
    if (!t || t.length > 16) return; // 诊断实体一般 ≤16 字；更长的片段是句子残段，不是实体
    if (/^(否认|无|未|不见|排除)/.test(t)) return; // 排除陈述不是诊断实体
    /* 结尾的分级/分期限定词（"2级""III期"）与 ICD 括注不参与疾病样判定，但保留在实体原文里 */
    const core = t.replace(/（[^）]*）|\([^)]*\)/g, '').replace(/\d+\s*级$|[IVX]+\s*期$|\d+\s*期$/, '');
    if (/[A-Z]\d{2}/.test(t) || DX_ENDINGS.test(core)) out.add(t);
  });
  return [...out];
}

/* 药品：剂型后缀 / 注射用前缀 / 常见输液溶媒 */
const DRUG_SUFFIX = /(肠溶胶囊|胶囊|片|注射液|注射用|颗粒|口服液|乳膏|软膏|滴眼液|滴丸|栓|含片|泡腾片|干混悬剂|混悬液|氯化钠注射液|葡萄糖注射液|气雾剂|喷雾剂|贴)/;
export function extractDrugs(text) {
  if (!text) return [];
  const out = new Set();
  const re = /([\u4e00-\u9fa5A-Za-z0-9]{2,14}?(?:肠溶胶囊|胶囊|片|注射液|颗粒|口服液|乳膏|软膏|滴眼液|滴丸|栓|含片|泡腾片|干混悬剂|混悬液|气雾剂|喷雾剂|贴))|注射用([\u4e00-\u9fa5]{2,12})/g;
  let m;
  while ((m = re.exec(String(text))) !== null) {
    let name = (m[1] || ('注射用' + m[2])).replace(/\s+/g, '');
    /* 归一化：循环去除给药途径/叙述性前缀，使"患者口服X胶囊"与"X胶囊"为同一实体 */
    const PREFIX = /^(口服|静滴|静脉滴注|静注|静推|肌注|皮下注射|雾化吸入|含服|外用|po|iv|im|gtt|患者|自行|自服|给予|应用|使用|继续|加用|予以|于|再|并)+/;
    while (PREFIX.test(name)) name = name.replace(PREFIX, '');
    if (name.length >= 3 && !/\d$/.test(name)) out.add(name);
  }
  return [...out];
}

/* 生命体征：T/P/R/BP（含中文标签写法）→ 数值精确比对 */
export function extractVitals(text) {
  const t = String(text || '');
  const out = {};
  const grab = (re) => { const m = t.match(re); return m ? m[1].replace(/℃|°C/g, '') : null; };
  out.T = grab(/(?:T|体温)[:：]?\s*(\d+(?:\.\d+)?)/);
  out.P = grab(/(?:P|脉搏|心率)[:：]?\s*(\d+)/);
  out.R = grab(/(?:R|呼吸)[:：]?\s*(\d+)/);
  out.BP = grab(/(?:BP|血压)[:：]?\s*(\d+(?:\.\d+)?\s*\/\s*\d+(?:\.\d+)?)/);
  Object.keys(out).forEach(k => { if (!out[k]) delete out[k]; });
  return out;
}

/* 检验/测量数值：数字 + 医学单位（衡量客观事实是否保留） */
const NUM_UNIT = /(\d+(?:\.\d+)?)\s*(×?\s*10\^?9\/L|×?\s*10\^?12\/L|mmol\/L|μmol\/L|umoL\/L|mmHg|g\/L|mg\/L|mg|ml|mL|U\/L|IU\/L|ng\/L|pg\/ml|fl|%|℃|次\/分|mm|cm)/g;
export function extractNumerics(text) {
  const out = new Set();
  let m;
  const re = new RegExp(NUM_UNIT.source, 'g');
  while ((m = re.exec(String(text || ''))) !== null) {
    /* 归一化：×10^9/L、*10*9/L 等写法统一为 E 记号（12.6E9/L），两侧一致可比 */
    const unit = m[2].replace(/\s/g, '').replace(/×?\*?10\^?\*?/, 'E').replace('umoL', 'umol');
    out.add(m[1] + unit);
  }
  return [...out];
}

/* 实体比对：gold 实体在 ai 中的召回 + ai 实体的精确率 */
function setHit(goldList, aiList) {
  const aiSet = new Set(aiList);
  const hit = goldList.filter(g => aiSet.has(g));
  const missed = goldList.filter(g => !aiSet.has(g));
  return { hit, missed, recall: goldList.length ? hit.length / goldList.length : null,
           precision: aiList.length ? hit.length / aiList.length : null,
           goldCount: goldList.length, aiCount: aiList.length };
}

export function entitiesOf(text) {
  return {
    dx: extractDiagnoses(text),
    drugs: extractDrugs(text),
    vitals: extractVitals(text),
    nums: extractNumerics(text),
  };
}

function compareEntities(aiText, goldText) {
  const ai = entitiesOf(aiText), gd = entitiesOf(goldText);
  const dx = setHit(gd.dx, ai.dx);
  const drugs = setHit(gd.drugs, ai.drugs);
  const nums = setHit(gd.nums, ai.nums);
  /* 体征：逐项数值精确比对 */
  const vKeys = [...new Set([...Object.keys(gd.vitals), ...Object.keys(ai.vitals)])];
  const vHit = [], vMissed = [];
  vKeys.forEach(k => {
    if (gd.vitals[k] && ai.vitals[k] === gd.vitals[k]) vHit.push(k + ' ' + gd.vitals[k]);
    else if (gd.vitals[k]) vMissed.push(k + ' ' + gd.vitals[k] + (ai.vitals[k] ? '（草稿 ' + ai.vitals[k] + '）' : '（草稿缺）'));
  });
  const goldTotal = gd.dx.length + gd.drugs.length + gd.nums.length + vKeys.filter(k => gd.vitals[k]).length;
  const hitTotal = dx.hit.length + drugs.hit.length + nums.hit.length + vHit.length;
  const aiTotal = ai.dx.length + ai.drugs.length + ai.nums.length + Object.keys(ai.vitals).length;
  return {
    dx, drugs, nums,
    vitals: { hit: vHit, missed: vMissed },
    goldCount: goldTotal, aiCount: aiTotal, hitCount: hitTotal,
    recall: goldTotal ? hitTotal / goldTotal : null,   // 金标准事实被草稿覆盖的比例
    precision: aiTotal ? hitTotal / aiTotal : null,    // 草稿事实中可证实的比例（越低越多"无中生有"）
    missedEntities: [...dx.missed, ...drugs.missed, ...nums.missed, ...vMissed], // 逐项点名，直接指出草稿没写到的事实
  };
}

/**
 * @param fields  AI 草稿字段数组（agents.js 产出）
 * @param gold    金标准字段对象 { chief, present, ... }
 * @returns {{rows, metrics}} rows 含实体比对明细，metrics 增加实体口径
 */
export function evaluateAgainstGold(fields, gold) {
  const rows = fields
    .filter(f => gold[f.id] !== undefined)
    .map(f => {
      const ai = (f.value || '').trim();
      const gd = (gold[f.id] || '').trim();
      const sim = similarity(ai, gd);
      const v = verdictOf(sim, ai.length > 0, gd.length > 0);
      const ent = compareEntities(ai, gd);
      return { label: f.label, id: f.id, ai, gold: gd, sim, cls: v.cls, judge: v.label, edited: !!f.edited, ent };
    });
  const total = rows.length;
  const covered = rows.filter(r => r.ai && r.gold).length;
  const usable = rows.filter(r => r.cls === 'dlg' || r.cls === 'his').length;
  const avgSim = covered ? rows.filter(r => r.ai && r.gold).reduce((s, r) => s + r.sim, 0) / covered : 0;
  const goldEnt = rows.reduce((s, r) => s + (r.ai && r.gold ? r.ent.goldCount : 0), 0);
  const hitEnt = rows.reduce((s, r) => s + (r.ai && r.gold ? r.ent.hitCount : 0), 0);
  const aiEnt = rows.reduce((s, r) => s + (r.ai && r.gold ? r.ent.aiCount : 0), 0);
  return {
    rows,
    metrics: {
      total,
      covered,
      coverage: total ? covered / total : 0,
      avgSim,
      usable,
      usableRate: total ? usable / total : 0,
      /* 实体口径（M2.2） */
      entGold: goldEnt, entHit: hitEnt, entAi: aiEnt,
      entRecall: goldEnt ? hitEnt / goldEnt : null,
      entPrecision: aiEnt ? hitEnt / aiEnt : null,
    },
  };
}
