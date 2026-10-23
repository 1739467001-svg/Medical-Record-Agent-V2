/* ============================================================
 * llm.js — 病历生成智能体的大模型 Provider（M2.1 前置骨架，M2构建规划 S5）
 * 职责：把"生成"从规则引擎切换为大模型草稿——
 *   1) 每类文书一次请求，字段级书写要求（含本院金标准文风样例）；
 *   2) JSON 结构化输出（键=字段id），仅接受非空值覆盖规则值，缺失/为空一律回落规则值；
 *   3) 任何失败（未配置/离线/超时/返回非 JSON）整体回落规则引擎，绝不阻断接诊；
 *   4) 铁律进提示词：不臆造——素材没有的事实输出空串，客观字段（HIS 数值）不参与改写。
 * 传输经服务端代理 /api/llm/chat（sync.js serverLLMChat），密钥不出服务器。
 * 真实 Key 登记后自动生效（设置页"生成引擎：自动"），无需改代码。
 * ============================================================ */

import { serverLLMChat } from './sync.js';
import { getConfig, llmServerReady } from './config.js';

/* 用户在设置页选择"规则演示"时强制回落规则引擎 */
export function llmGenMode() {
  const c = getConfig();
  return c.gen === 'rules' ? 'rules' : 'auto';
}

export function llmGenActive() {
  return llmGenMode() === 'auto' && llmServerReady();
}

/* ---------- 字段书写规范（按字段分提示词；仅列"可改写"字段，客观 HIS 字段不在此列） ---------- */
const DOC_SPECS = {
  adm: {
    title: '入院记录',
    fields: [
      { id: 'chief', label: '主诉', how: '症状 + 持续时间，20 字以内，与素材表述的事实完全一致' },
      { id: 'present', label: '现病史', how: '按时间线组织：起病诱因→症状演变→院外诊治→来院目的；只使用素材中的事实与数值；结尾如素材含"发病以来精神/食欲/睡眠/大小便/体重"信息则带一句概括，否则不写' },
      { id: 'past', label: '既往史', how: '只写素材明示的疾病/手术/外伤/输血/传染病史；"否认"句式仅用于素材明示的排除项' },
      { id: 'allergy', label: '过敏史', how: '素材含过敏原才书写；无则输出空串' },
      { id: 'family', label: '家族史', how: '仅限素材范围' },
      { id: 'marriage', label: '婚姻史', how: '仅限素材范围' },
      { id: 'personal', label: '个人史', how: '仅限素材范围；素材无信息时输出规范句"生于原籍、久居本地；否认疫区疫水接触史，无烟酒嗜好"' },
      { id: 'diagnosis', label: '初步诊断', how: '与素材中的诊断原文一致，不新增、不改名' },
    ],
  },
  fc: {
    title: '首次病程记录',
    fields: [
      { id: 'caseFeatures', label: '病例特点', how: '条目式汇总：流行病学→既往史→现病史→查体→辅助检查，全部取自素材' },
      { id: 'diagBasis', label: '诊断依据', how: '主诉 + 查体要点 + 辅助检查三条，与素材一致' },
      { id: 'diffDiagnosis', label: '鉴别诊断', how: '依据素材疾病给出 2-3 个鉴别对象，每个含鉴别要点与依据（检验/体征）；素材不足以支持某鉴别项时省略该条' },
      { id: 'plan', label: '诊疗计划', how: '护理级别、完善检查、对症治疗、拟行方案；素材未提及的操作不写' },
    ],
  },
  dc: {
    title: '出院记录',
    fields: [
      { id: 'admissionSituation', label: '入院情况', how: '主诉 + 现病史要点 + 查体 + 辅助检查，取自素材' },
      { id: 'course', label: '诊疗经过', how: '按素材中的手术/治疗时间线书写；素材无则输出空串' },
      { id: 'dischargeStatus', label: '出院情况', how: '仅限素材范围；无则输出空串' },
      { id: 'dischargeAdvice', label: '出院医嘱', how: '仅限素材范围；无则输出空串' },
    ],
  },
  opd: {
    title: '门诊病历',
    fields: [
      { id: 'opdChief', label: '主诉', how: '症状 + 时间，20 字以内' },
      { id: 'opdPresent', label: '现病史', how: '按时间线组织，仅用素材事实' },
      { id: 'opdPast', label: '既往史', how: '仅限素材范围' },
      { id: 'opdFamily', label: '家族史', how: '仅限素材范围' },
      { id: 'opdPhysical', label: '体格检查', how: '查体所见逐项与素材一致' },
      { id: 'opdDx', label: '西医诊断', how: '与素材诊断原文一致（含 ICD 代码则保留）' },
      { id: 'opdAdvice', label: '诊疗意见', how: '处置/用药/复诊建议，仅限素材范围' },
    ],
  },
};

/* 各文书参与 LLM 改写的字段 id（客观字段如 vitals/auxiliary/physical/specialty 永不改写） */
const ELIGIBLE = {
  adm: ['chief', 'present', 'past', 'allergy', 'family', 'marriage', 'personal', 'diagnosis'],
  fc: ['caseFeatures', 'diagBasis', 'diffDiagnosis', 'plan'],
  dc: ['admissionSituation', 'course', 'dischargeStatus', 'dischargeAdvice'],
  opd: ['opdChief', 'opdPresent', 'opdPast', 'opdFamily', 'opdPhysical', 'opdDx', 'opdAdvice'],
};

/* ---------- 素材组装（真实数据环境：病案要素/HIS/转写/金标准要素，无任何虚构） ---------- */
function materialOf(patient, docKey) {
  const parts = [];
  if (patient.scene === 'opd') {
    parts.push('场景：门诊接诊（素材=门诊系统截图转录的结构化要素，真实数据）');
  } else if (patient.gold) {
    parts.push('场景：金标准评测（素材=该次住院病案的结构化要素，真实数据）');
  } else if (patient.rec) {
    parts.push('场景：住院接诊·录音优先（素材=真实 HIS 导出结构化要素 + 真实问诊转写文本）');
  } else {
    parts.push('场景：住院接诊（素材=真实病案文书《入院记录》结构化要素，data_records）');
  }
  /* 问诊转写（现场录音实时转写，或上传的"ASR 原文+纠错后"双重验证文本）：问诊类字段核心素材 */
  if (patient.transcript) {
    parts.push(`【问诊转写原文（${patient.transcriptSource || '真实转写'}；主诉/现病史/既往史/过敏史/个人史/家族史优先以此对话内容组织）】${patient.transcript}`);
    if (patient.transcriptRaw) parts.push('【ASR 原文（纠错前，含方言口语）】' + patient.transcriptRaw);
  }
  const facts = patient.gold || patient.record || {};
  const factsCopy = { ...facts };
  delete factsCopy.vitals; // 体征在下方单列（客观字段，不参与改写但供模型理解语境）
  parts.push('【病案/HIS 结构化要素 JSON】' + JSON.stringify(factsCopy, null, 0));
  if (facts.vitals) parts.push('【生命体征（客观，禁止改写数值）】' + JSON.stringify(facts.vitals));
  /* 录音优先患者：病案未书写，但 HIS 导出的客观要素（申请单/CT/体征）必须进素材——
   * 与规则引擎蓝字段同源；入院/首次病程素材按"入院时刻快照"裁剪（术后病理/手术日期
   * 属出院记录素材，提前出现即时序错误——对照 10.17 外部基线的同类缺陷）。 */
  if (patient.rec) {
    const rc = patient.rec;
    const recFacts = {};
    if (rc.clinSymp) recFacts['申请单主诉'] = rc.clinSymp;
    if (rc.ctSymp) recFacts['申请单现病史'] = rc.ctSymp;
    if (rc.clinDiag) recFacts['门诊诊断'] = rc.clinDiag;
    if (rc.ctImpression) recFacts['CT印象'] = rc.ctImpression;
    if (rc.ctDesc) recFacts['CT所见'] = rc.ctDesc;
    if (rc.vitalsStr) recFacts['入院体征'] = rc.vitalsStr;
    if (docKey === 'dc') {
      if (rc.surgeryDate) recFacts['手术日期'] = rc.surgeryDate;
      if (rc.pathology) recFacts['术后病理'] = rc.pathology;
      if (rc.postop) recFacts['术后所见'] = rc.postop;
    }
    parts.push('【HIS 客观要素（真实导出，客观字段禁止改写数值；问诊类字段以转写对话为准）】' +
               JSON.stringify(recFacts, null, 0));
  }
  const h = patient.his || {};
  if (h.labs && h.labs.length) {
    parts.push('【HIS 检验异常（客观）】' + h.labs.map(l => `${l.item} ${l.result}${l.unit || ''}${l.flag || ''}`).join('；'));
  }
  if (h.chronic && h.chronic.length) parts.push('【HIS 慢病备案】' + h.chronic.join('、'));
  return parts.join('\n');
}

/* 本院文风样例：取患者病案原文片段（内部真实数据，仅作风格参照） */
function styleSample(patient) {
  const r = patient.gold || patient.record || {};
  const s = (r.present || r.chief || '').slice(0, 160);
  return s ? `\n【本院书写风格样例（仅供文风参照，禁止照抄内容）】${s}…` : '';
}

function buildMessages(spec, patient, docKey) {
  const eligible = spec.fields;
  const hows = eligible.map(f => `- ${f.id}（${f.label}）：${f.how}`).join('\n');
  const template = {};
  eligible.forEach(f => { template[f.id] = ''; });
  const user =
    materialOf(patient, docKey) + styleSample(patient) +
    `\n【字段书写要求】\n${hows}` +
    `\n【输出 JSON 模板】${JSON.stringify(template)}`;
  const system =
    `你是东阿县人民医院的病历生成智能体，起草${spec.title}的指定字段。铁律：\n` +
    `1) 严禁臆造：素材中没有的事实输出空字符串，不得编造数值、日期、诊断、用药；\n` +
    `2) 客观一致：检验/检查/体征数值与素材完全一致；\n` +
    `3) 文风：参照本院风格样例，专业、简洁、书面化医学用语；\n` +
    `4) 输出：只输出一个 JSON 对象（键=字段id，值=中文字符串），不要解释、不要 markdown 代码块标记。`;
  return [
    { role: 'system', content: system },
    { role: 'user', content: user },
  ];
}

/* 从模型返回文本中稳健提取 JSON（容忍 ``` 包裹/前后缀话） */
function extractJSON(text) {
  if (!text) return null;
  const t = String(text).replace(/```(json)?/g, '');
  const start = t.indexOf('{');
  const end = t.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  try {
    const obj = JSON.parse(t.slice(start, end + 1));
    return obj && typeof obj === 'object' ? obj : null;
  } catch (_) {
    return null;
  }
}

/* 把 LLM 输出合并到规则字段上：仅覆盖"非空且原值非空"的可改写字段（黄项/客观字段永不被模型触碰） */
function mergeFields(rulesFields, out, spec, docKey) {
  const fields = JSON.parse(JSON.stringify(rulesFields));
  const eligible = ELIGIBLE[docKey] || [];
  let hit = 0;
  fields.forEach(f => {
    if (!eligible.includes(f.id)) return;
    const v = out && typeof out[f.id] === 'string' ? out[f.id].trim() : '';
    if (v && f.value && f.value.trim()) {
      f.value = v;
      f.gen = 'llm';
      f.confidence = Math.min(f.confidence || 0.9, 0.92);
      hit += 1;
    }
  });
  const tag = hit ? `· 生成引擎：大模型草稿（改写 ${hit}/${eligible.length} 字段）`
                  : '· 生成引擎：规则引擎（大模型未返回有效内容，已回落）';
  fields.__tag = tag;
  return { fields, tag, llm: hit > 0 };
}

async function generateDoc(docKey, patient, rulesObj) {
  const spec = DOC_SPECS[docKey];
  const messages = buildMessages(spec, patient, docKey);
  const res = await serverLLMChat({ messages, temperature: 0.2 });
  if (!res || !res.ok) {
    return { ...rulesObj, tag: `· 生成引擎：规则引擎（大模型不可用：${(res && res.error) || '未知'}，已回落）`, llm: false };
  }
  const content = res.upstream && res.upstream.choices && res.upstream.choices[0]
    && res.upstream.choices[0].message ? res.upstream.choices[0].message.content : '';
  const out = extractJSON(content);
  if (!out) {
    return { ...rulesObj, tag: '· 生成引擎：规则引擎（大模型返回无法解析为 JSON，已回落）', llm: false };
  }
  const merged = mergeFields(rulesObj.fields, out, spec, docKey);
  return { fields: merged.fields, summary: rulesObj.summary + ' ' + merged.tag, detail: rulesObj.detail, llm: merged.llm };
}

/**
 * 生成大模型草稿（或整体回落规则引擎）。
 * @param patient 患者数据
 * @param rulesFabrics {adm,fc,dc,opd} 规则引擎先行算好的同构产出（作底稿与兜底）
 * @returns Promise<{engine:'llm'|'rules', adm?,fc?,dc?,opd?}> 永不 reject
 */
export async function prepareGeneration(patient, rulesFabrics) {
  if (!llmGenActive()) return { engine: 'rules' };
  /* 录音优先患者（无病案素材）：转写文本就绪（现场录音或上传）即解除守卫，
   * 大模型以"真实转写对话 + HIS 结构化要素"为素材改写；无转写时仍走规则
   * （仅有的 HIS 症状短句不足以支撑改写，避免扩写臆造） */
  if (!patient.record && !patient.gold && patient.rec && !patient.transcript) return { engine: 'rules' };
  try {
    const keys = patient.scene === 'opd' ? ['opd'] : ['adm', 'fc', 'dc'];
    const bundle = { engine: 'llm' };
    for (const k of keys) {
      const rules = rulesFabrics[k];
      if (!rules) continue;
      // eslint-disable-next-line no-await-in-loop
      const r = await generateDoc(k, patient, rules);
      bundle[k] = r;
    }
    const any = keys.some(k => bundle[k] && bundle[k].llm);
    if (!any) return { engine: 'rules' };
    return bundle;
  } catch (_) {
    return { engine: 'rules' };
  }
}
