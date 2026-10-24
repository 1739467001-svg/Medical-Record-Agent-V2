#!/usr/bin/env node
/* fc/dc 草稿产品路径验证（Node 直驱，绕开 IAB 不稳定环境）
 * 与浏览器完全同一代码路径：agents.js runPipeline（rules 底稿 → llm.js prepareGeneration
 * 三文书并行请求 qwen → 安全合并 → QC/映射），仅 shim localStorage 与服务端状态标记。 */
import { readFileSync } from 'node:fs';

const shim = { store: {} };
globalThis.localStorage = {
  getItem: k => (k in shim.store ? shim.store[k] : null),
  setItem: (k, v) => { shim.store[k] = String(v); },
  removeItem: k => { delete shim.store[k]; },
};
/* Node fetch 不支持相对 URL（浏览器同源语义）：为 /api/* 补 BFF 源 */
const realFetch = globalThis.fetch.bind(globalThis);
globalThis.fetch = (url, opts) =>
  realFetch(String(url).startsWith('/') ? 'http://127.0.0.1:8801' + url : url, opts);

const ROOT = new URL('..', import.meta.url).pathname;
const { serverState } = await import(ROOT + 'js/sync.js');
serverState.online = true;
serverState.info = { ok: true, db: { backend: 'mysql' } };
const { adoptServerStatus } = await import(ROOT + 'js/config.js');
adoptServerStatus({ engine: 'demo', llm: { hasKey: true, baseUrl: 'qwen', model: 'qwen3.8-max' } });

const { PATIENTS } = await import(ROOT + 'js/data.js');
const { runPipeline } = await import(ROOT + 'js/agents.js');

const p = JSON.parse(JSON.stringify(PATIENTS.find(x => x.id === 'P2001390150')));
const raw = readFileSync('/Users/mac/Documents/李晓林导师/AI病历第二版本-glm5.3flash/会议对齐信息/这是若雨处理后的数据，你可以去借鉴一下它的二次验证思路，至于质量嘛，你必须比他做的更好/patient01录音文本.txt', 'utf8');
const m = raw.match(/^-{3,}\s*ASR 原文\s*-{3,}([\s\S]*?)-{3,}\s*纠错后\s*-{3,}([\s\S]*)$/m);
p.transcript = m[2].trim();
p.transcriptRaw = m[1].trim();
p.transcriptSource = '上传转写文本（双重验证后）';

const t0 = Date.now();
const ctx = await new Promise((resolve, reject) => {
  const h = runPipeline(p, { onStep() {}, onDone: resolve });
  h.skipAll();
  setTimeout(() => reject(new Error('pipeline 120s 超时')), 120000);
});
console.log('流水线耗时 %ds，genEngine=%s', Math.round((Date.now() - t0) / 1000), ctx.genEngine);

const show = (label, doc) => {
  console.log('\n===== %s（%s）=====', label, doc.fields.__tag || '');
  for (const f of doc.fields) {
    const mark = f.gen === 'llm' ? '[LLM]' : f.source === 'miss' ? '[黄]' : '[' + f.source + ']';
    console.log(' %s %s：%.110s', mark, f.label, (f.value || '(空)').replace(/\n/g, ' '));
  }
};
show('首次病程记录', ctx.generateFC);
show('出院记录', ctx.generateDC);

/* 断言 */
const fc = Object.fromEntries(ctx.generateFC.fields.map(f => [f.id, f.value]));
const dc = Object.fromEntries(ctx.generateDC.fields.map(f => [f.id, f.value]));
const checks = {
  'fc 全部字段已生成（无空）': ctx.generateFC.fields.every(f => f.value.trim()),
  'fc 诊断依据无越界"右下腹压痛"': !/右下腹/.test(fc.diagBasis || ''),
  'fc 鉴别诊断含依据': (fc.diffDiagnosis || '').length > 60,
  'fc 生命体征数值与 HIS 一致': fc.caseFeatures.includes('36.6') && fc.caseFeatures.includes('103'),
  'dc 诊疗经过含术后病理(时序正确)': /坏疽|病理/.test(dc.course || ''),
  'dc 手术日期真实(2026-10-02)': (dc.course || '').includes('2026-10-02') || (dc.course || '').includes('10-02'),
  'dc 出院情况诚实留空(黄)': !(dc.dischargeStatus || '').trim(),
  'dc 出院医嘱诚实留空(黄)': !(dc.dischargeAdvice || '').trim(),
  'admission 现病史无病理(对照)': !/坏疽|病理/.test((Object.fromEntries(ctx.generate.fields.map(f => [f.id, f.value]))).present || ''),
};
console.log('\n===== 断言 =====');
let fail = 0;
for (const [k, v] of Object.entries(checks)) { console.log((v ? '✓' : '✗'), k); if (!v) fail++; }
process.exit(fail ? 1 : 0);
