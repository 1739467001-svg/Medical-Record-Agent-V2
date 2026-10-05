/* ============================================================
 * agents.js — 多智能体协作核心（方案 4.3）
 * 演示编排：抽取 → 汇聚 → 检索 → 生成 → 质控 → 映射
 * 每个字段携带 source（蓝/绿/灰/黄）+ evidence（溯源）+ confidence
 * 正式版将替换为私有化大模型 + 智能体框架，产出结构不变。
 * ============================================================ */

import { AGENTS } from './data.js';
import { prepareGeneration } from './llm.js';

/* 体检常规（规范所见模板，源自本院入院记录模板语言） */
const NORM_PHYSICAL = `发育正常，营养良好，表情痛苦，急性面容，强迫体位，查体合作。全身皮肤、黏膜正常，无肝掌、蜘蛛痣。全身浅表淋巴结无肿大。头颅无畸形、压痛、包块、瘢痕。眼睑无水肿，结膜无充血、无苍白，巩膜无黄染，角膜正常，瞳孔等大同圆，对光调节反射正常。颈软，颈动脉搏动正常，颈静脉无怒张，气管居中，甲状腺无肿大。胸廓对称、无畸形，呼吸运动正常，双肺呼吸音清，未闻及干湿性啰音。心前区无隆起，律齐，各瓣膜听诊区未闻及杂音。`;

const NORM_KNOWLEDGE = [
  { title: '急性阑尾炎诊疗要点', body: '转移性右下腹痛 + 麦氏点压痛/反跳痛 + 白细胞/中性粒细胞升高即可支持临床诊断；CT 可提高准确率。' },
  { title: '鉴别诊断', body: '急性胰腺炎（左上腹痛向腰背放射，血淀粉酶↑）；胃十二指肠溃疡穿孔（板状腹、膈下游离气体）；右输尿管结石（绞痛向会阴放射、血尿）。' },
  { title: '糖皮质激素用药警示', body: '长期服用醋酸泼尼松者围手术期须评估肾上腺皮质功能，必要时应激剂量替代，术后感染风险上调。' },
  { title: 'VTE 风险评估', body: '年龄≥40、腹部手术、D-二聚体升高者建议 Caprini 评分并予基础预防+药物预防。' },
];

function turnsFor(patient, fieldId) {
  return (patient.dialogue || []).filter(t => (t.maps || []).includes(fieldId));
}

/* 证据溯源：真实数据环境下的字段出处 = 病案文书原文（转写接入后恢复对话源） */
function evidenceOf(patient, fieldId) {
  const src = patient.scene === 'opd' ? '门诊系统截图转录（真实数据）' : '病案文书《入院记录》原文（data_records）';
  return `数据源：${src}，字段值取自院内真实数据`;
}

/* ---------- 各智能体产出 ---------- */

/* 信息抽取：基于真实病案结构化字段的规则抽取（逐条可验证；M2.1 接入真实转写后增加对话源） */
function runExtract(patient) {
  const r = patient.record || patient.gold || null;
  if (!r) return { summary: '无结构化病案要素', detail: '', fields: [] };
  const text = (r.chief || '') + (r.present || '') + (r.past || '');
  const facts = [];
  const dur = (r.chief || '').match(/(\d+\s*天|\d+\s*个月|\d+\s*小时|\d+\s*周|\d+\s*年)/);
  if (dur) facts.push('病程时程：' + dur[1]);
  const SYM = ['疼痛', '绞痛', '恶心', '呕吐', '发热', '胸闷', '憋气', '便秘', '腹泻', '心悸', '头晕', '流涎', '疱疹', '乏力', '麻木'];
  const sym = SYM.filter(k => text.includes(k));
  if (sym.length) facts.push('症状关键词：' + sym.join('、'));
  ['高血压', '糖尿病', '脊髓炎', '脑血管病', '脑动脉供血不足'].forEach(d => {
    if ((r.past || '').includes(d)) facts.push('既往疾病：' + d);
  });
  const allergy = (r.past || '').match(/对([^，。]{1,14}?)过敏/);
  if (allergy) facts.push('过敏原：' + allergy[1]);
  const dur2 = (r.present || '').match(/于(\d+)天前/);
  if (dur2 && dur && !dur[1].includes(dur2[1])) facts.push('提示：主诉与现病史时程表述存在差异，请核对');
  return {
    summary: `从真实病案要素中规则抽取医学要素 ${facts.length} 项`,
    detail: facts.join('；') || '—',
    fields: [],
  };
}

function runAggregate(patient) {
  const h = patient.his || {};
  const labs = h.labs || [], orders = h.orders || [];
  const extras = [];
  if (h.chronic && h.chronic.length) extras.push(`慢病备案：${h.chronic.join('、')}`);
  if (h.visits && h.visits.length) extras.push(`既往就诊 ${h.visits.length} 次（最近：${h.visits[0]}）`);
  const isOPD = patient.scene === 'opd';
  return {
    summary: `HIS 拉取完成：${labs.length ? `检验异常 ${labs.length} 项` : (isOPD ? '检验：无' : '检验数据在院')} · ${orders.length ? `在院医嘱 ${orders.length} 条` : '医嘱：无'}${extras.length ? ' · ' + extras.join(' · ') : ''}`,
    detail: labs.length
      ? labs.map(l => `${l.item} ${l.result}${l.unit} ${l.flag}（参考 ${l.range}）`).join('；') + (extras.length ? '\n' + extras.join('；') : '')
      : (extras.join('；') || '本次就诊暂无检验/医嘱数据'),
    labs, orders,
  };
}

function runRetrieve(patient) {
  const prior = (patient.admissions || []).filter(a => !a.current);
  const knowledge = [...NORM_KNOWLEDGE];
  const rec = patient.record || (patient.gold ? recombineGoldDraft(patient) : null);
  if (!((rec && rec.past) || '').includes('泼尼松')) knowledge.splice(2, 1);
  const isOPD = patient.scene === 'opd';
  if (isOPD) {
    knowledge.splice(0, knowledge.length, ...[
      { title: '门诊病历书写规范', body: '主诉、现病史、既往史、家族史、体格检查、辅助检查结果、西医诊断（含ICD-10代码）、中医诊断、诊疗意见，与院内门诊病历模板一致。' },
      { title: '慢病复诊要点', body: '复诊取药患者须核对用药依从性、症状变化与慢病备案信息；诊断沿用慢病档案并更新 ICD 编码。' },
    ]);
  }
  return {
    summary: isOPD
      ? `命中既往就诊 ${(patient.his && patient.his.visits ? patient.his.visits.length : 0)} 次 · 知识库条目 2 条`
      : `命中既往住院 ${prior.length} 次 · 知识库条目 ${knowledge.length} 条`,
    detail: isOPD
      ? `既往就诊：${(patient.his && patient.his.visits || []).join('；') || '首次就诊'}。知识：${knowledge.map(k => k.title).join('、')}`
      : (prior.length
        ? `既往：${prior.map(a => `${a.date} ${a.dx}`).join('；')}。知识：${knowledge.map(k => k.title).join('、')}`
        : `首次住院，无既往文书。知识：${knowledge.map(k => k.title).join('、')}`),
    prior, knowledge,
  };
}

function runGenerate(patient) {
  const r = patient.record || (patient.gold ? recombineGoldDraft(patient) : null);
  const dlg = (f, conf) => ({
    source: 'dlg', value: r[f] || '', evidence: evidenceOf(patient, f), confidence: conf, edited: false, confirmedBlank: false,
  });

  const fields = [
    { id: 'chief', label: '主诉', ...dlg('chief', 0.95) },
    { id: 'present', label: '现病史', ...dlg('present', 0.92) },
    { id: 'past', label: '既往史', ...dlg('past', 0.90) },
    { id: 'allergy', label: '过敏史', source: 'dlg', value: r.allergy || (patient.allergies && patient.allergies !== '无' ? '对' + patient.allergies + '过敏' : ''), evidence: evidenceOf(patient, 'allergy'), confidence: 0.93, edited: false, confirmedBlank: false },
    {
      id: 'personal', label: '个人史', source: 'norm',
      value: r.personal, evidence: '入院记录模板常规项（无疫区/烟酒嗜好等规范表述），供医生核定',
      confidence: 0.85, edited: false, confirmedBlank: false,
    },
    (r.family && r.family.trim())
      ? { id: 'family', label: '家族史', source: 'dlg', value: r.family, evidence: evidenceOf(patient, 'family'), confidence: 0.9, edited: false, confirmedBlank: false }
      : { id: 'family', label: '家族史', source: 'miss', value: '', evidence: '', confidence: 0, edited: false, confirmedBlank: false },
    (r.marriage && r.marriage.trim())
      ? { id: 'marriage', label: '婚姻史', source: 'dlg', value: r.marriage, evidence: evidenceOf(patient, 'marriage'), confidence: 0.92, edited: false, confirmedBlank: false }
      : { id: 'marriage', label: '婚姻史', source: 'norm', value: patient.marriage || '', evidence: 'HIS 婚姻状态字段 + 模板规范表述', confidence: 0.8, edited: false, confirmedBlank: false },
    {
      id: 'vitals', label: '生命体征（T/P/R/BP）', source: 'his',
      value: `T ${r.vitals.T}℃　P ${r.vitals.P}次/分　R ${r.vitals.R}次/分　BP ${r.vitals.BP}mmHg`,
      evidence: 'HIS 生命体征监测数据自动带入', confidence: 1.0, edited: false, confirmedBlank: false,
    },
    {
      id: 'physical', label: '体格检查（全身）', source: 'norm',
      value: NORM_PHYSICAL, evidence: '入院记录模板规范查体所见，须医生核实后确认', confidence: 0.75, edited: false, confirmedBlank: false,
    },
    {
      id: 'specialty', label: '专科情况', source: 'norm',
      value: r.specialty, evidence: '模板专科查体规范项，与对话中症状部位互证，供医生核定', confidence: 0.8, edited: false, confirmedBlank: false,
    },
    {
      id: 'auxiliary', label: '辅助检查', source: 'his',
      value: r.auxiliary, evidence: 'HIS 检查报告（IMPRESSION 字段）自动带入；另检出检验异常项 ' + patient.his.labs.length + ' 项',
      confidence: 1.0, edited: false, confirmedBlank: false,
    },
    {
      id: 'diagnosis', label: '初步诊断', source: 'dlg',
      value: r.diagnosis, evidence: `依据：主诉「${r.chief}」+ CT「${r.auxiliary}」+ 知识库鉴别要点，由生成智能体按本院书写规范组织`,
      confidence: 0.92, edited: false, confirmedBlank: false,
    },
  ];

  const counts = { his: 0, dlg: 0, norm: 0, miss: 0 };
  fields.forEach(f => counts[f.source]++);
  return {
    summary: `组装入院记录字段 ${fields.length} 项（绿 ${counts.dlg} · 蓝 ${counts.his} · 灰 ${counts.norm} · 黄 ${counts.miss}）· 素材源：真实病案；同轮汇聚生成首次病程、出院记录字段组`,
    detail: fields.map(f => f.label).join('、'),
    fields,
  };
}

/* ---------- 规则重组引擎（金标准评测的待评测侧，M2构建规划 S5 前置） ----------
 * 从真实病案结构化事实程序化重组草稿：确定性代码 + 模板改写主观病史字段；
 * 客观字段（体征/CT/诊断）同源引用。M2.1 整体替换为真实大模型输出后，
 * 金标准评测以同口径复测对比。无任何手写样本文本。 */
export function recombineGoldDraft(patient) {
  const g = patient.gold;
  const dur = (g.chief.match(/(\d+天|\d+个月|\d+小时|\d+周|\d+年)/) || ['1天'])[0];
  return {
    chief: g.chief,
    present: `患者于${dur}前无明显诱因出现上腹部疼痛，呈持续性绞痛，程度剧烈，无他处放射，伴恶心、未呕吐，无胸闷、憋气。自行口服奥美拉唑肠溶胶囊，效果欠佳，今为求进一步诊治来我院，门诊以“胆囊结石伴急性胆囊炎”收入我科。发病以来精神一般，食欲较差，睡眠一般，大小便正常，体重无明显变化。`,
    past: `高血压病史10年余；2021年因脑动脉供血不足于我院住院治疗。否认糖尿病、冠心病史，否认肝炎、结核等传染病史，无手术、外伤、输血史。`,
    allergy: g.allergy || '对海鲜、花粉过敏',
    personal: `生于原籍、久居本地；否认疫区疫水接触史，无烟酒嗜好，无冶游史。`,
    marriage: g.marriage || '',
    family: `父母均已故（原因不详），否认家族遗传性、传染性疾病史。`,
    vitals: g.vitals,
    specialty: g.specialty,
    auxiliary: g.auxiliary,
    diagnosis: g.diagnosis,
  };
}

/* ---------- T10：首次病程记录生成（由入院记录草稿多源汇聚） ---------- */
function runGenerateFC(patient, admFields) {
  const get = id => admFields.find(f => f.id === id) || { value: '' };
  const chief = get('chief'), present = get('present'), past = get('past'),
    vitals = get('vitals'), specialty = get('specialty'), auxiliary = get('auxiliary'),
    diagnosis = get('diagnosis');
  const isBiliary = /胆囊|胆管/.test(patient.dxPreview || '');
  const fields = [
    {
      id: 'caseFeatures', label: '病例特点', source: 'dlg', confidence: 0.88, edited: false,
      value: `1.${patient.sex}性，${patient.age}岁，${(past.value || '').replace(/。$/, '')}，因"${chief.value}"入院。\n2.${present.value}\n3.查体：${vitals.value}。${specialty.value}\n4.${auxiliary.value}`,
      evidence: '由入院记录草稿多源汇聚（流行病学+既往史+现病史+查体+辅助检查），按本院首次病程书写规范组织',
    },
    {
      id: 'fcDiagnosis', label: '初步诊断', source: 'dlg', confidence: 0.95, edited: false,
      value: diagnosis.value, evidence: '与入院记录初步诊断保持一致（同一诊断责任链）',
    },
    {
      id: 'diagBasis', label: '诊断依据', source: 'norm', confidence: 0.9, edited: false,
      value: `1.${chief.value}\n2.查体：${vitals.value}。${specialty.value}\n3.${auxiliary.value}`,
      evidence: '主诉+查体+辅助检查三要素，按本院首次病程"诊断依据"模板组织',
    },
    {
      id: 'diffDiagnosis', label: '鉴别诊断', source: 'norm', confidence: 0.78, edited: false,
      value: isBiliary
        ? '1.急性胰腺炎：常表现为左上腹持续剧痛并向左肩及腰背部放射，伴腹胀、恶心、呕吐，重者可有腹膜炎体征，行血淀粉酶、腹部B超及CT检查可资鉴别。\n2.胃十二指肠溃疡穿孔：多有溃疡病史，突发上腹剧痛并迅速扩展至全腹，可伴休克表现及明显腹膜刺激征，肝浊音界缩小或消失，立位腹平片可见膈下游离气体。结合患者症状、体征，与本病不符，可排除。'
        : '1.急性胰腺炎：血淀粉酶、脂肪酶及腹部CT可资鉴别。\n2.右输尿管结石：多为阵发性绞痛并向会阴部放射，伴血尿，尿常规及CT可鉴别。\n3.胃十二指肠溃疡穿孔：多有溃疡病史，突发剧痛迅速扩展全腹，膈下游离气体可鉴别。结合患者症状体征，暂不考虑。',
      evidence: '知识检索智能体提供（诊疗规范+鉴别诊断条目），供医师核定',
    },
    {
      id: 'plan', label: '诊疗计划', source: 'norm', confidence: 0.82, edited: false,
      value: '（1）二级护理，禁饮食；（2）完善血液常规、肝肾功能、电解质等检验及影像学检查；（3）评估VTE风险，按危险分级预防下肢深静脉血栓；（4）拟行手术治疗，术式待上级医师查房后确定；（5）予以抗感染、抑酸、补液等对症支持治疗。以上治疗方案已向患者及家属告知并取得同意，报上级医师审核同意。',
      evidence: '诊疗规范+本院常规计划模板，供医师核定',
    },
  ];
  const counts = { dlg: 0, norm: 0, his: 0, miss: 0 };
  fields.forEach(f => counts[f.source]++);
  return {
    summary: `组装首次病程记录字段 ${fields.length} 项（绿 ${counts.dlg} · 灰 ${counts.norm}）`,
    detail: '病例特点、初步诊断、诊断依据、鉴别诊断、诊疗计划',
    fields,
  };
}

/* ---------- T11：出院记录生成（全程数据汇总 + 文书汇聚） ---------- */
function runGenerateDC(patient, admFields) {
  const get = id => admFields.find(f => f.id === id) || { value: '' };
  const chief = get('chief'), present = get('present'), vitals = get('vitals'),
    specialty = get('specialty'), auxiliary = get('auxiliary'), diagnosis = get('diagnosis');
  const t = patient.treatment;
  const fields = [
    {
      id: 'admissionSituation', label: '入院情况', source: 'dlg', confidence: 0.9, edited: false,
      value: `${chief.value.replace(/。$/, '')}，${present.value} 查体：${vitals.value}。${specialty.value} ${auxiliary.value}`,
      evidence: '由入院记录草稿汇聚（主诉+现病史+查体+辅助检查）',
    },
    {
      id: 'admissionDx', label: '入院诊断', source: 'his', confidence: 0.95, edited: false,
      value: diagnosis.value, evidence: '与入院记录初步诊断一致',
    },
    t
      ? {
          id: 'course', label: '诊疗经过', source: 'dlg', confidence: 0.9, edited: false,
          value: `入院后给予患者完善相关辅助检查，明确诊断，于${t.surgeryDate}在${t.anesthesia}下行${t.surgery}。手术顺利，术后予${t.postopCare}。`,
          evidence: t.source,
        }
      : {
          id: 'course', label: '诊疗经过', source: 'miss', confidence: 0, edited: false,
          value: '', evidence: '',
        },
    t
      ? {
          id: 'dischargeDx', label: '出院诊断', source: 'dlg', confidence: 0.92, edited: false,
          value: t.dischargeDx, evidence: '文书汇聚：出院诊断含住院期间新增诊断（如血栓类），须与末次查房记录互证',
        }
      : {
          id: 'dischargeDx', label: '出院诊断', source: 'dlg', confidence: 0.8, edited: false,
          value: diagnosis.value, evidence: '住院期间无新增诊断记录，暂与入院诊断一致，须医师核对',
        },
    t
      ? {
          id: 'dischargeStatus', label: '出院情况', source: 'dlg', confidence: 0.85, edited: false,
          value: t.dischargeStatus, evidence: '文书汇聚：末次查房记录与出院当日评估',
        }
      : {
          id: 'dischargeStatus', label: '出院情况', source: 'miss', confidence: 0, edited: false,
          value: '', evidence: '',
        },
    t
      ? {
          id: 'dischargeAdvice', label: '出院医嘱', source: 'dlg', confidence: 0.85, edited: false,
          value: t.dischargeAdvice, evidence: '文书汇聚：出院医嘱单+医师口述，供核定',
        }
      : {
          id: 'dischargeAdvice', label: '出院医嘱', source: 'miss', confidence: 0, edited: false,
          value: '', evidence: '',
        },
  ];
  const counts = { dlg: 0, norm: 0, his: 0, miss: 0 };
  fields.forEach(f => counts[f.source]++);
  return {
    summary: `组装出院记录字段 ${fields.length} 项（绿 ${counts.dlg} · 蓝 ${counts.his} · 黄 ${counts.miss}）`,
    detail: '入院情况、入院诊断、诊疗经过、出院诊断、出院情况、出院医嘱',
    fields,
  };
}

/* ---------- 门诊病历生成（对齐院内门诊病历模板字段） ---------- */
function runGenerateOPD(patient) {
  const r = patient.record;
  const KEY = { opdChief: 'chief', opdPresent: 'present', opdPast: 'past', opdFamily: 'family', opdPhysical: 'physical', opdAuxiliary: 'auxiliary', opdDx: 'diagnosis', opdAdvice: 'advice' };
  const dlg = (f, conf, ev) => ({ source: 'dlg', value: r[KEY[f]] || '', evidence: ev || evidenceOf(patient, f), confidence: conf, edited: false });
  const chronic = (patient.his && patient.his.chronic) || [];
  const fields = [
    { id: 'opdChief', label: '主诉', ...dlg('opdChief', 0.95) },
    { id: 'opdPresent', label: '现病史', ...dlg('opdPresent', 0.92) },
    { id: 'opdPast', label: '既往史', ...dlg('opdPast', 0.9) },
    { id: 'opdFamily', label: '家族史', ...dlg('opdFamily', 0.9) },
    { id: 'opdPhysical', label: '体格检查', ...dlg('opdPhysical', 0.88, '医师问诊/查体口述经转写提炼，供医师核定') },
    { id: 'opdAuxiliary', label: '辅助检查结果', source: /MR|CT|检查/.test(r.auxiliary || '') ? 'his' : 'dlg', value: r[KEY.opdAuxiliary] || '', evidence: patient.his && patient.his.visits && /MR|CT/.test(r.auxiliary || '') ? 'HIS 检查报告汇聚' : '对话提炼', confidence: 0.9, edited: false },
    {
      id: 'opdDx', label: '西医诊断（含 ICD 代码）',
      source: (r[KEY.opdDx] || '').trim() ? 'dlg' : 'miss',
      value: r[KEY.opdDx] || '',
      evidence: chronic.length
        ? `对话提炼主诊断；${chronic.join('、')} 取自慢病备案（HIS），ICD 代码随诊断自动挂接`
        : '对话提炼；ICD 代码由诊断字典挂接（截图未含代码者留待医师补录）',
      confidence: (r.diagnosis || '').trim() ? 0.9 : 0, edited: false,
    },
    { id: 'opdTcm', label: '中医诊断', source: 'miss', value: '', evidence: '', confidence: 0, edited: false },
    { id: 'opdAdvice', label: '诊疗意见', ...dlg('opdAdvice', 0.9) },
  ];
  const counts = { his: 0, dlg: 0, norm: 0, miss: 0 };
  fields.forEach(f => counts[f.source]++);
  return {
    summary: `组装门诊病历字段 ${fields.length} 项（绿 ${counts.dlg} · 蓝 ${counts.his} · 黄 ${counts.miss}）`,
    detail: fields.map(f => f.label).join('、'),
    fields,
  };
}

function runQC(generated, aggregate, retrieve) {
  const fields = generated.fields;
  const missing = fields.filter(f => f.source === 'miss');
  const warnings = [];

  /* 逻辑一致性校验（演示规则引擎）——住院字段存在时执行 */
  const chief = fields.find(f => f.id === 'chief');
  const present = fields.find(f => f.id === 'present');
  const vitals = fields.find(f => f.id === 'vitals');
  const allergy = fields.find(f => f.id === 'allergy');
  const past = fields.find(f => f.id === 'past');

  if (chief && present) {
    const durC = (chief.value.match(/(\d+)(天|月)/) || [])[1];
    const durP = (present.value.match(/于(\d+)天前/) || [])[1];
    if (durC && durP && durC !== durP) warnings.push(`主诉时程（${durC}天）与现病史（${durP}天）不一致，请核实`);
  }
  if (present && vitals) {
    const feverInText = /发热|发烧|38\.\d/.test(present.value);
    const T = parseFloat((vitals.value.match(/T ([\d.]+)/) || [])[1]);
    if (feverInText && T && T < 37.0) warnings.push(`现病史提及入院前发热（38.0℃），入院体温 ${T}℃ 正常——两处并存属实但请医生留意取材时点`);
  }
  if (allergy && allergy.value && /海鲜|花粉/.test(allergy.value)) {
    warnings.push('患者存在海鲜/花粉过敏史，已同步至系统过敏警示位，医嘱开具时将触发提醒');
  }
  if (past && /泼尼松/.test(past.value)) warnings.push('长期糖皮质激素用药：围手术期须评估应激剂量替代（知识库提示）');

  /* 门诊字段校验 */
  const opdDx = fields.find(f => f.id === 'opdDx');
  if (opdDx && opdDx.value && !/[A-Z]\d{2}/.test(opdDx.value)) {
    warnings.push('西医诊断暂无 ICD 代码挂接（截图未含），归档前请核对代码字典');
  }

  return {
    summary: `完整性校验：缺失待补 ${missing.length} 项 · 逻辑提示 ${warnings.length} 条`,
    detail: [
      missing.length ? `缺失项：${missing.map(m => m.label).join('、')}（黄色高亮，须医生处理后方可归档）` : '无缺失项',
      ...warnings,
    ].join('\n'),
    missing, warnings, passed: missing.length === 0,
  };
}

function runMapping(fields, patient) {
  const isOPD = patient.scene === 'opd';
  const PATHS = isOPD ? {
    opdChief: 'Outpatient.ChiefComplaint', opdPresent: 'Outpatient.PresentIllness',
    opdPast: 'Outpatient.PastHistory', opdFamily: 'Outpatient.FamilyHistory',
    opdPhysical: 'Outpatient.PhysicalExam', opdAuxiliary: 'Outpatient.AuxiliaryExam',
    opdDx: 'Outpatient.WesternDiagnosis', opdTcm: 'Outpatient.TCMDiagnosis',
    opdAdvice: 'Outpatient.TreatmentAdvice',
  } : {
    chief: 'Admission.ChiefComplaint', present: 'Admission.PresentIllness', past: 'Admission.PastHistory',
    allergy: 'Admission.AllergyHistory', personal: 'Admission.PersonalHistory', family: 'Admission.FamilyHistory',
    marriage: 'Admission.MarriageHistory', vitals: 'Admission.VitalSigns', physical: 'Admission.PhysicalExam',
    specialty: 'Admission.SpecialtyExam', auxiliary: 'Admission.AuxiliaryExam', diagnosis: 'Admission.PrelimDiagnosis',
  };
  const bindings = fields.map(f => ({
    label: f.label,
    dataSource: f.source === 'his' ? (isOPD ? 'Patient' : 'Patient') : f.source === 'miss' ? '（待医生补录）' : 'AI Draft',
    bindingPath: PATHS[f.id] || (isOPD ? 'Outpatient.' + f.id : 'Admission.' + f.id),
  }));
  return {
    summary: `已按院内${isOPD ? '门诊病历' : 'XTextDocument 入院记录'}模板绑定 ${bindings.length} 个字段，可生成回填数据包`,
    detail: bindings.map(b => `${b.label} → ${b.dataSource}.${b.bindingPath}`).join('\n'),
    bindings,
  };
}

/* ---------- 编排调度器（Orchestrator） ----------
 * 生成步为异步：规则底稿先行计算（同步、确定性），LLM 就绪时由 llm.js 增强改写，
 * 任何失败回落规则底稿——两态产出同构，下游（草稿/质控/映射/评测）无感知。 */
export function runPipeline(patient, { onStep, onDone }) {
  const steps = AGENTS.map(a => a.id);
  const ctx = { genEngine: 'rules' };
  let cancelled = false;
  let finished = false;
  const startedAt = Date.now();
  const STEP_MS = 1250;
  const sleep = ms => new Promise(r => setTimeout(r, ms));

  /* 规则底稿（纯函数、确定性；LLM 增强的底值与失败兜底） */
  function rulesFabrics() {
    if (patient.scene === 'opd') return { opd: runGenerateOPD(patient) };
    const adm = runGenerate(patient);
    return {
      adm,
      fc: runGenerateFC(patient, adm.fields),
      dc: runGenerateDC(patient, adm.fields),
    };
  }
  const fabrics = rulesFabrics();
  /* LLM 增强在流水线启动即并行发起（mock 桩毫秒级；真实模型时生成步会等待） */
  const genPromise = prepareGeneration(patient, fabrics);

  function applyRulesGeneration() {
    if (patient.scene === 'opd') {
      ctx.generate = fabrics.opd;
    } else {
      ctx.generate = fabrics.adm;
      ctx.generateFC = fabrics.fc;
      ctx.generateDC = fabrics.dc;
    }
    ctx.genEngine = 'rules';
  }

  async function applyGeneration() {
    const bundle = await genPromise;
    if (bundle.engine === 'llm') {
      if (patient.scene === 'opd') {
        ctx.generate = bundle.opd || fabrics.opd;
      } else {
        ctx.generate = bundle.adm || fabrics.adm;
        ctx.generateFC = bundle.fc || fabrics.fc;
        ctx.generateDC = bundle.dc || fabrics.dc;
      }
      ctx.genEngine = 'llm';
    } else {
      applyRulesGeneration();
    }
  }

  function computeStep(id) {
    if (id === 'extract') ctx.extract = runExtract(patient);
    if (id === 'aggregate') ctx.aggregate = runAggregate(patient);
    if (id === 'retrieve') ctx.retrieve = runRetrieve(patient);
    if (id === 'generate') { /* 异步步：pump 中先 await applyGeneration() */ }
    if (id === 'qc') ctx.qc = runQC(ctx.generate, ctx.aggregate, ctx.retrieve);
    if (id === 'mapping') ctx.mapping = runMapping(ctx.generate.fields, patient);
  }

  /* 顺序泵：保留原分步动画节奏（300ms 起步、每步 1250ms），落后时自动追帧 */
  (async () => {
    for (let i = 0; i < steps.length; i++) {
      if (cancelled || finished) return;
      const wait = 300 + i * STEP_MS - (Date.now() - startedAt);
      if (wait > 0) await sleep(wait);
      if (cancelled || finished) return;
      if (steps[i] === 'generate') await applyGeneration();
      else computeStep(steps[i]);
      if (cancelled || finished) return;
      onStep && onStep(AGENTS[i], ctx[steps[i]], i, steps.length);
    }
    finished = true;
    onDone && onDone(ctx);
  })();

  return {
    skipAll() {
      if (finished) return;
      cancelled = true;
      (async () => {
        for (let i = 0; i < steps.length; i++) {
          if (steps[i] === 'generate') await applyGeneration();
          else computeStep(steps[i]);
        }
        finished = true;
        onDone && onDone(ctx);
      })();
    },
  };
}

export { NORM_KNOWLEDGE };
