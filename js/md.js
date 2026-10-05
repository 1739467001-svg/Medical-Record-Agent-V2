/* ============================================================
 * md.js — Markdown 文书生成（用户口述需求："记录到 MD 文档"）
 * ① 入院记录 .md（与院内模板字段一一对应）
 * ② 患者画像报告 .md（跨住院次全流程汇总）
 * ============================================================ */

import { HOSPITAL } from './data.js';

const SRC_NOTE = {
  his: '[系统带入]', dlg: '[对话提炼]', norm: '[规范所见]', miss: '[待补充]',
};

function fmtVitals(v) {
  if (!v) return '';
  return `T ${v.T}℃，P ${v.P}次/分，R ${v.R}次/分，BP ${v.BP}mmHg。`;
}

function fieldLine(f) {
  const v = (f.value || '').trim();
  const tag = SRC_NOTE[f.source] || '';
  if (!v) return `**${f.label}**：＿（待补充——AI 未获依据，严禁臆造）\n`;
  return `**${f.label}**：${v} ${tag}\n`;
}

export function buildAdmissionMD({ patient, fields, doctor, meta }) {
  const get = id => fields.find(f => f.id === id);
  const r = patient.record;
  const now = new Date();
  const ts = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')} ${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;

  const lines = [];
  lines.push(`# ${HOSPITAL} 入院记录`);
  lines.push('');
  lines.push(`> 病案号：${patient.id.replace('P', '')}　|　姓名：${patient.name}　|　性别：${patient.sex}　|　年龄：${patient.age}岁  `);
  lines.push(`> 入院时间：${patient.admittedAt}　|　科别：${patient.ward.split('·')[0]}　|　第 ${patient.visitNo} 次住院`);
  lines.push(`> 本草稿由 AI 病历智能体生成，经医师审核确认。生成时间：${ts}　审核医师：${doctor.name}（${doctor.title}）`);
  lines.push('');
  lines.push('## 主诉');
  lines.push(fieldLine(get('chief')));
  lines.push('## 现病史');
  lines.push(fieldLine(get('present')));
  lines.push('## 既往史');
  lines.push(fieldLine(get('past')));
  lines.push('## 过敏史');
  lines.push(fieldLine(get('allergy')));
  lines.push('## 个人史');
  lines.push(fieldLine(get('personal')));
  lines.push('## 婚育史 / 月经史');
  lines.push(fieldLine(get('marriage')));
  lines.push('## 家族史');
  lines.push(fieldLine(get('family')));
  lines.push('## 体格检查');
  lines.push(`**生命体征**：${fmtVitals(r.vitals)} [系统带入]\n`);
  lines.push(fieldLine(get('physical')));
  lines.push('## 专科情况');
  lines.push(fieldLine(get('specialty')));
  lines.push('## 辅助检查');
  lines.push(fieldLine(get('auxiliary')));
  lines.push('### 本次检验异常项（HIS 汇聚）');
  patient.his.labs.forEach(l => {
    lines.push(`- ${l.item}（${l.code}）：**${l.result} ${l.unit}** ${l.flag === 'H' ? '↑ 偏高' : '↓ 偏低'}（参考 ${l.range}）　${l.time}`);
  });
  lines.push('');
  lines.push('## 初步诊断');
  lines.push(fieldLine(get('diagnosis')));
  lines.push('');
  lines.push('---');
  lines.push('');
  lines.push('### 医师签名与留痕');
  lines.push('');
  lines.push(`| 项目 | 内容 |`);
  lines.push(`| --- | --- |`);
  lines.push(`| 生成引擎 | 演示引擎（多智能体流水线） |`);
  lines.push(`| 转写引擎 | ${meta?.asrName || '演示转写引擎'} |`);
  lines.push(`| 素材来源 | 真实病案文书与 HIS 数据（语音转写接入后：真实转写文本） |`);
  lines.push(`| 医师确认 | ${doctor.name} ${ts} |`);
  lines.push(`| 归档批次 | ${meta?.archiveId || '—'} |`);
  lines.push('');
  lines.push('> 本文档为 AI 生成草稿，归档以院内系统回填版本为准。所有黄色[待补充]字段由医师终审负责。');
  return lines.join('\n');
}

/* 首次病程记录 MD（T14：接诊向导多文书归档） */
export function buildFCMD({ patient, fields, doctor, meta }) {
  const get = id => fields.find(f => f.id === id);
  const ts = new Date().toLocaleString('zh-CN', { hour12: false });
  const lines = [];
  lines.push(`# ${HOSPITAL} 首次病程记录`);
  lines.push('');
  lines.push(`> 姓名：${patient.name}　|　性别：${patient.sex}　|　年龄：${patient.age}岁　|　病案号：${patient.id.replace('P', '')}  `);
  lines.push(`> 科别：${patient.ward.split('·')[0]}　|　入院时间：${patient.admittedAt}　|　第 ${patient.visitNo} 次住院`);
  lines.push(`> 本记录由 AI 病历智能体生成，经医师审核确认。生成时间：${ts}　审核医师：${doctor.name}（${doctor.title}）`);
  lines.push('');
  ['caseFeatures', 'fcDiagnosis', 'diagBasis', 'diffDiagnosis', 'plan'].forEach(id => {
    lines.push(`## ${get(id).label}`);
    lines.push(fieldLine(get(id)));
  });
  lines.push('');
  lines.push('---');
  lines.push('');
  lines.push('### 医师签名与留痕');
  lines.push('');
  lines.push(`| 项目 | 内容 |`);
  lines.push(`| --- | --- |`);
  lines.push(`| 生成引擎 | 演示引擎（多智能体流水线 · 入院记录草稿多源汇聚） |`);
  lines.push(`| 医师确认 | ${doctor.name} ${ts} |`);
  lines.push(`| 归档批次 | ${meta?.archiveId || '—'} |`);
  lines.push('');
  lines.push('> 本文档为 AI 生成草稿，归档以院内系统回填版本为准。黄色[待补充]字段由医师终审负责。');
  return lines.join('\n');
}

/* 出院记录 MD（T14：全程数据汇总路径） */
export function buildDCMD({ patient, fields, doctor, meta }) {
  const get = id => fields.find(f => f.id === id);
  const ts = new Date().toLocaleString('zh-CN', { hour12: false });
  const lines = [];
  lines.push(`# ${HOSPITAL} 出院记录`);
  lines.push('');
  lines.push(`> 姓名：${patient.name}　|　性别：${patient.sex}　|　年龄：${patient.age}岁　|　病案号：${patient.id.replace('P', '')}  `);
  lines.push(`> 入院日期：${patient.admittedAt.slice(0, 10)}　|　出院日期：＿（出院时由医师补录）　|　第 ${patient.visitNo} 次住院`);
  lines.push(`> 本记录由 AI 病历智能体汇聚住院全程数据生成，经医师审核确认。生成时间：${ts}　审核医师：${doctor.name}（${doctor.title}）`);
  lines.push('');
  ['admissionSituation', 'admissionDx', 'course', 'dischargeDx', 'dischargeStatus', 'dischargeAdvice'].forEach(id => {
    const f = get(id);
    lines.push(`## ${f.label}`);
    lines.push(fieldLine(f));
  });
  lines.push('');
  lines.push('---');
  lines.push('');
  lines.push('### 医师签名与留痕');
  lines.push('');
  lines.push(`| 项目 | 内容 |`);
  lines.push(`| --- | --- |`);
  lines.push(`| 生成引擎 | 演示引擎（手术记录/查房/出院评估文书汇聚） |`);
  lines.push(`| 医师确认 | ${doctor.name} ${ts} |`);
  lines.push(`| 归档批次 | ${meta?.archiveId || '—'} |`);
  lines.push('');
  lines.push('> 出院日期、住院天数以院内系统归档版本为准。黄色[待补充]字段由医师终审负责。');
  return lines.join('\n');
}

/* 门诊病历 MD（对齐院内门诊病历结构：主诉/现病史/既往史/家族史/体格检查/辅助检查/西医诊断含ICD/中医诊断/诊疗意见） */
export function buildOPMD({ patient, fields, doctor, meta }) {
  const get = id => fields.find(f => f.id === id);
  const now = new Date();
  const ts = now.toLocaleString('zh-CN', { hour12: false });
  const lines = [];
  lines.push(`# ${HOSPITAL} 门诊病历`);
  lines.push('');
  lines.push(`> 姓名：${patient.name}　|　性别：${patient.sex}　|　年龄：${patient.ageText || patient.age + '岁'}　|　门诊病案号：${patient.id}  `);
  lines.push(`> 就诊时间：${patient.visitAt}　|　就诊科室：${patient.dept}　|　费别：${patient.fee || '—'}`);
  lines.push(`> 本病历由 AI 病历智能体生成，经医师审核确认。生成时间：${ts}　审核医师：${doctor.name}（${doctor.title}）`);
  lines.push('');
  ['opdChief', 'opdPresent', 'opdPast', 'opdFamily', 'opdPhysical', 'opdAuxiliary'].forEach(id => {
    lines.push(`## ${get(id).label}`);
    lines.push(fieldLine(get(id)));
  });
  lines.push('## 西医诊断（含 ICD 代码）');
  lines.push(fieldLine(get('opdDx')));
  lines.push('## 中医诊断');
  lines.push(fieldLine(get('opdTcm')));
  lines.push('## 诊疗意见');
  lines.push(fieldLine(get('opdAdvice')));
  lines.push('');
  lines.push('---');
  lines.push('');
  lines.push('### 医师签名与留痕');
  lines.push('');
  lines.push(`| 项目 | 内容 |`);
  lines.push(`| --- | --- |`);
  lines.push(`| 生成引擎 | 演示引擎（多智能体流水线） |`);
  lines.push(`| 转写引擎 | ${meta?.asrName || '演示转写引擎'} |`);
  lines.push(`| 素材来源 | 真实门诊截图转录 + 真实原声回放（转写文本待正式引擎生成） |`);
  lines.push(`| 医师确认 | ${doctor.name} ${ts} |`);
  lines.push(`| 归档批次 | ${meta?.archiveId || '—'} |`);
  lines.push('');
  lines.push('> 本文档为 AI 生成草稿，归档以院内门诊系统回填版本为准。黄色[待补充]字段由医师终审负责。');
  return lines.join('\n');
}

export function buildProfileMD({ patient, doctor, archiveLogs }) {
  const now = new Date();
  const ts = now.toLocaleString('zh-CN', { hour12: false });
  const lines = [];
  lines.push(`# 患者画像与病例报告 · ${patient.name}`);
  lines.push('');
  lines.push(`> 病案号：${patient.id.replace('P','')}　|　${patient.sex} / ${patient.age}岁　|　${patient.job}　|　${patient.marriage}  `);
  lines.push(`> 出生地：${patient.birthplace}　|　当前科室：${patient.ward}`);
  lines.push(`> 生成时间：${ts}　生成医师：${doctor.name}`);
  lines.push('');
  lines.push('## 一、基本信息与过敏警示');
  lines.push(`- **过敏史**：${patient.allergies ? '⚠ 对' + patient.allergies + '过敏' : '无已知过敏'}（跨文书核验）`);
  lines.push(`- **累计住院**：${patient.admissions.length} 次（${patient.admissions[0].date} 至今）`);
  lines.push('');
  lines.push('## 二、就诊时间轴（全流程文书汇聚）');
  patient.admissions.forEach(a => {
    lines.push(`### ${a.date} · ${a.dept} · ${a.dx}${a.current ? '（本次住院）' : ''}`);
    lines.push(`- 文书：${a.docs.join('、')}`);
    lines.push('');
  });
  lines.push('## 三、诊断演变与既往要点');
  const priorDx = patient.admissions.filter(a => !a.current).map(a => `${a.date} ${a.dx}`);
  lines.push(priorDx.length ? priorDx.map(d => `- ${d}`).join('\n') : '- 首次住院，无既往诊断');
  if (/泼尼松/.test(patient.record.past)) lines.push('- ⚠ 长期糖皮质激素（醋酸泼尼松、甲钴胺）用药中，围手术期须评估');
  if (/高血压/.test(patient.record.past)) lines.push('- 高血压病史，入院血压监测与降压用药（苯磺酸氨氯地平）已纳入医嘱');
  lines.push('');
  lines.push('## 四、本次住院概况');
  lines.push(`- 主诉：${patient.record.chief}`);
  lines.push(`- 初步诊断：${patient.record.diagnosis}`);
  lines.push(`- 关键检验异常：${patient.his.labs.slice(0, 4).map(l => `${l.item} ${l.result}${l.unit} ${l.flag === 'H' ? '↑' : '↓'}`).join('；')}`);
  lines.push(`- 在院医嘱（药品）：${patient.his.orders.map(o => o.text).join('、')}`);
  lines.push('');
  lines.push('## 五、留痕记录');
  if (archiveLogs && archiveLogs.length) {
    lines.push('| 时间 | 操作 | 医师 | 详情 |');
    lines.push('| --- | --- | --- | --- |');
    archiveLogs.slice(0, 30).forEach(l => {
      lines.push(`| ${l.time} | ${l.action} | ${l.doctor} | ${l.detail} |`);
    });
  } else {
    lines.push('- 暂无归档留痕');
  }
  lines.push('');
  lines.push('> 本画像报告由多份文书与 HIS 数据汇聚生成，供接诊医生快速掌握患者全貌；正式版将随每次归档自动更新。');
  return lines.join('\n');
}

export function buildEvalMD({ patient, result, doctor, asrName, docLabel }) {
  const { rows, metrics } = result;
  const ts = new Date().toLocaleString('zh-CN', { hour12: false });
  const lines = [];
  lines.push(`# 金标准评测报告 · ${patient.name} ${patient.admittedAt.slice(0, 10)} ${docLabel || '入院记录'}`);
  lines.push('');
  lines.push(`> 依据《AI 病历智能体系统建设实施规划方案 1.0》2.3 评测方法：以医生真实书写版本为金标准，`);
  lines.push(`> 将原始素材输入系统生成草稿，逐字段比对。评测时间：${ts}　执行医师：${doctor.name}`);
  lines.push(`> 转写引擎：${asrName || '演示转写引擎'}　相似度算法：字符级 bigram F1（正式版换用医学实体级比对）`);
  lines.push('');
  lines.push('## 一、总体指标');
  lines.push('');
  lines.push(`| 指标 | 数值 | 口径 |`);
  lines.push(`| --- | --- | --- |`);
  lines.push(`| 字段覆盖率 | ${(metrics.coverage * 100).toFixed(1)}%（${metrics.covered}/${metrics.total}） | AI 有内容且金标准有内容 |`);
  lines.push(`| 平均相似度 | ${(metrics.avgSim * 100).toFixed(1)}% | 已覆盖字段 bigram F1 均值 |`);
  lines.push(`| 可用率 | ${(metrics.usableRate * 100).toFixed(1)}%（${metrics.usable}/${metrics.total}） | 一致 + 基本一致（确认修改为主） |`);
  lines.push('');
  lines.push(`## 二、${docLabel || '入院记录'}逐字段比对`);
  lines.push('');
  lines.push(`| 字段 | AI 草稿 | 金标准 | 相似度 | 判定 |`);
  lines.push(`| --- | --- | --- | --- | --- |`);
  rows.forEach(r => {
    const ai = r.ai ? (r.ai.length > 60 ? r.ai.slice(0, 60) + '…' : r.ai) : '（空）';
    const gd = r.gold ? (r.gold.length > 60 ? r.gold.slice(0, 60) + '…' : r.gold) : '（金标准缺项）';
    lines.push(`| ${r.label} | ${ai.replace(/\|/g, '/')} | ${gd.replace(/\|/g, '/')} | ${(r.sim * 100).toFixed(0)}% | ${r.judge} |`);
  });
  lines.push('');
  lines.push('## 三、结论与改进项');
  lines.push('');
  const weak = rows.filter(r => r.gold && (!r.ai || r.sim < 0.6));
  if (weak.length) {
    weak.forEach(w => lines.push(`- **${w.label}**（${(w.sim * 100).toFixed(0)}%）：表述与金标准存在偏差，提示词/模板需向本院书写风格对齐。`));
  } else {
    lines.push('- 全部字段达到"基本一致"以上，草稿可用。');
  }
  lines.push('- 本报告为演示引擎（规则+模板）产出；接入真实大模型后（M2）以同口径复测并追踪指标变化。');
  lines.push('');
  lines.push('> 评测以演示转写脚本为输入源；正式版将直接使用真实录音转写文本。');
  return lines.join('\n');
}

export function downloadMD(filename, content) {
  const blob = new Blob([content], { type: 'text/markdown;charset=utf-8' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 400);
}
