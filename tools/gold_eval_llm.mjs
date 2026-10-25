#!/usr/bin/env node
/* 金标准同口径复测：规则引擎 vs 千问（产品同路径）
 * 复刻 app.js 金标准评测驱动（bindGoldEval）：runPipeline(GOLD_CASE) →
 * evaluateAgainstGold(ctx.generate.fields, p.gold|goldFC|goldDC)，
 * 同一进程两轮：第一轮 _srv.llm.hasKey=false（规则底稿），第二轮 =true（千问改写）。
 * 产出 tools/gold_eval_out/{rules,llm}.json 与控制台对照表。 */
import { writeFileSync, mkdirSync } from 'node:fs';

const shim = { store: {} };
globalThis.localStorage = {
  getItem: k => (k in shim.store ? shim.store[k] : null),
  setItem: (k, v) => { shim.store[k] = String(v); },
  removeItem: k => { delete shim.store[k]; },
};
const realFetch = globalThis.fetch.bind(globalThis);
globalThis.fetch = (url, opts) =>
  realFetch(String(url).startsWith('/') ? 'http://127.0.0.1:8801' + url : url, opts);

const ROOT = new URL('..', import.meta.url).pathname;
const { serverState } = await import(ROOT + 'js/sync.js');
serverState.online = true;
const { adoptServerStatus } = await import(ROOT + 'js/config.js');
const { PATIENTS, GOLD_CASE } = await import(ROOT + 'js/data.js');
const { runPipeline } = await import(ROOT + 'js/agents.js');
const { evaluateAgainstGold } = await import(ROOT + 'js/eval.js');

async function oneRun(label) {
  adoptServerStatus({ engine: 'demo', llm: { hasKey: label === 'llm', baseUrl: 'qwen', model: 'qwen3.8-max' } });
  const p = JSON.parse(JSON.stringify(GOLD_CASE));
  const t0 = Date.now();
  const ctx = await new Promise((resolve, reject) => {
    const h = runPipeline(p, { onStep() {}, onDone: resolve });
    h.skipAll();
    setTimeout(() => reject(new Error(label + ' 120s 超时')), 120000);
  });
  const secs = Math.round((Date.now() - t0) / 1000);
  const out = { engine: ctx.genEngine, secs, docs: {} };
  for (const [k, gk] of [['adm', 'gold'], ['fc', 'goldFC'], ['dc', 'goldDC']]) {
    out.docs[k] = evaluateAgainstGold(ctx[k === 'adm' ? 'generate' : 'generate' + k.toUpperCase()].fields, p[gk]);
  }
  console.log('\n[%s] 引擎=%s 耗时=%ds', label, ctx.genEngine, secs);
  const pct = v => (v * 100).toFixed(0) + '%';
  for (const k of ['adm', 'fc', 'dc']) {
    const m = out.docs[k].metrics;
    console.log('  %s 可用率 %s (%d/%d) 平均相似度 %s 实体召回 %s 精确 %s', k, pct(m.usableRate),
      m.usable, m.total, m.avgSim.toFixed(2),
      m.entRecall === null ? '—' : pct(m.entRecall),
      m.entPrecision === null ? '—' : pct(m.entPrecision));
  }
  return out;
}

mkdirSync(ROOT + 'tools/gold_eval_out', { recursive: true });
const rules = await oneRun('rules');
const llm = await oneRun('llm');
for (const [label, data] of [['rules', rules], ['llm', llm]]) {
  writeFileSync(`${ROOT}tools/gold_eval_out/${label}.json`,
    JSON.stringify({ engine: data.engine, secs: data.secs,
      docs: Object.fromEntries(Object.entries(data.docs).map(([k, v]) => [k, v.metrics])),
      rows: Object.fromEntries(Object.entries(data.docs).map(([k, v]) => [k, v.rows.map(r => ({ id: r.id, label: r.label, judge: r.judge, sim: +r.sim.toFixed(2) }))])) },
      null, 1));
}
/* 逐字段差异（llm 相对 rules 的判定变化） */
console.log('\n===== 逐字段变化（千问 vs 规则） =====');
for (const k of ['adm', 'fc', 'dc']) {
  const diff = llm.docs[k].rows.filter((r, i) => {
    const o = rules.docs[k].rows[i];
    return o && (r.judge !== o.judge || Math.abs(r.sim - o.sim) > 0.05);
  });
  console.log(`-- ${k}: ${diff.length} 项变化`);
  for (const r of diff.slice(0, 12)) {
    const o = rules.docs[k].rows.find(x => x.id === r.id);
    console.log('   %s %s→%s (相似度 %s→%s)', r.label.padEnd(10), o && o.judge, r.judge,
      o ? o.sim.toFixed(2) : '-', r.sim.toFixed(2));
  }
}
