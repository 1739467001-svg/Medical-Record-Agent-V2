/* ============================================================
 * app.js — 医生端网页应用（视图与交互）
 * 视图：登录 / 工作台 / 接诊向导 / 患者画像 / 留痕审计
 * ============================================================ */

import { HOSPITAL, SYSTEM_NAME, DOCTORS, PATIENTS, OPD_PATIENTS, AGENTS, SOURCE_META, OPD_NOTE, DEMO_BANNER, GOLD_CASE, ASR_TESTSET } from './data.js';
import { ASR_ENGINES, engineReady, startWebSpeechASR } from './asr.js';
import { startRtasrASR } from './rtasr.js';
import { getConfig, saveConfig, testLLM, asrConfigured, adoptServerStatus, llmServerReady } from './config.js';
import { serverState, bootSync, postAudit, postArchive, postConfig, serverLLMTest } from './sync.js';
import { llmGenActive, llmGenMode } from './llm.js';
import { runPipeline } from './agents.js';
import { evaluateAgainstGold } from './eval.js';
import { buildAdmissionMD, buildFCMD, buildDCMD, buildOPMD, buildProfileMD, buildEvalMD, downloadMD } from './md.js';

/* ---------- 持久化（MVP：localStorage；正式版替换服务端审计库） ---------- */
const store = {
  logs: JSON.parse(localStorage.getItem('medagent_logs') || '[]'),
  archives: JSON.parse(localStorage.getItem('medagent_archives') || '[]'),
  save() {
    localStorage.setItem('medagent_logs', JSON.stringify(this.logs.slice(0, 400)));
    localStorage.setItem('medagent_archives', JSON.stringify(this.archives.slice(0, 200)));
  },
};
function audit(action, detail) {
  const entry = {
    time: new Date().toLocaleString('zh-CN', { hour12: false }),
    action, detail, doctor: state.doctor ? state.doctor.name : '—',
  };
  store.logs.unshift(entry);
  store.save();
  postAudit([entry]); // 服务端在线时入库（M2.0 S2），失败静默
}

/* ---------- 全局状态 ---------- */
const state = {
  doctor: null,
  view: 'dashboard',
  profilePid: null,
  consult: null,
  goldEval: null, // { running, steps:[], done, results, docType }
  mask: localStorage.getItem('medagent_mask') === '1', // T12 脱敏开关
  bigFont: localStorage.getItem('medagent_bigfont') === '1', // 适老：大字号模式
};
/* 患者姓名显示层脱敏（真实数据不改动，仅展示替换） */
const N = p => state.mask ? String(p.name || '').slice(0, 1) + '某某' : p.name;

const $app = document.getElementById('app');
const esc = s => String(s == null ? '' : s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

/* ---------- 接诊会话恢复（防误刷新丢失进度，医院级可靠性） ---------- */
function persistConsult() {
  try {
    const c = state.consult;
    if (!c || c.archived) { sessionStorage.removeItem('medagent_consult'); return; }
    const snap = {
      scene: c.scene || 'ipd', patientId: c.patientId, step: c.step, engine: c.engine, asrName: c.asrName,
      turns: c.turns, pipeSteps: c.pipeSteps, pipelineDone: c.pipelineDone,
      drafts: c.drafts, docType: c.docType, archivedDocs: c.archivedDocs, visitedDocs: c.visitedDocs, qc: c.qc, mapping: c.mapping,
    };
    if (c.step === 3 && !c.pipelineDone) snap.step = 2; // 编排中断则退回转写完成态，可一键重启
    sessionStorage.setItem('medagent_consult', JSON.stringify(snap));
  } catch (_) { /* 存储不可用时静默降级 */ }
}
function restoreConsult() {
  try {
    const raw = sessionStorage.getItem('medagent_consult');
    if (!raw) return;
    const snap = JSON.parse(raw);
    if (!snap || !snap.patientId) return;
    newConsult(snap.scene || 'ipd', snap.patientId);
    if (snap.engine === 'demo') snap.engine = 'webspeech';
    Object.assign(state.consult, snap, {
      recording: false, asrHandle: null, pipeHandle: null, timerHandle: null, editingId: null,
    });
    // 兼容防御：草稿结构缺失/不兼容（如版本升级）时退回转写完成态，避免渲染崩溃
    if (state.consult.step >= 4 && !state.consult.drafts) state.consult.step = 2;
    state.view = 'consult';
  } catch (_) { sessionStorage.removeItem('medagent_consult'); }
}

const icons = {
  dash: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><rect x="3" y="3" width="8" height="8" rx="1.5"/><rect x="13" y="3" width="8" height="8" rx="1.5"/><rect x="3" y="13" width="8" height="8" rx="1.5"/><rect x="13" y="13" width="8" height="8" rx="1.5"/></svg>',
  stetho: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M5 3v6a5 5 0 0 0 10 0V3"/><path d="M10 14v2a5 5 0 0 0 10 0v-3"/><circle cx="20" cy="9" r="2.4"/><path d="M3.5 3h3M13.5 3h3"/></svg>',
  mic: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><rect x="9" y="2.5" width="6" height="12" rx="3"/><path d="M5 11a7 7 0 0 0 14 0M12 18v3.5"/></svg>',
  user: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><circle cx="12" cy="8" r="4"/><path d="M4 20c1.6-3.6 4.5-5.5 8-5.5s6.4 1.9 8 5.5"/></svg>',
  file: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M6 2.5h8L19 8v13a1.5 1.5 0 0 1-1.5 1.5h-11A1.5 1.5 0 0 1 5 21V4A1.5 1.5 0 0 1 6.5 2.5z"/><path d="M14 2.5V8h5"/></svg>',
  shield: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M12 2.5 20 6v6c0 5-3.5 8-8 9.5C7.5 20 4 17 4 12V6z"/><path d="m9 12 2 2 4-4"/></svg>',
  gear: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><circle cx="12" cy="12" r="3.2"/><path d="M19 12a7 7 0 0 0-.1-1.2l2-1.5-2-3.4-2.3 1a7 7 0 0 0-2-1.2L14.2 3h-4l-.4 2.5a7 7 0 0 0-2 1.2l-2.3-1-2 3.4 2 1.5A7 7 0 0 0 5 12c0 .4 0 .8.1 1.2l-2 1.5 2 3.4 2.3-1a7 7 0 0 0 2 1.2l.4 2.5h4l.4-2.5a7 7 0 0 0 2-1.2l2.3 1 2-3.4-2-1.5c.1-.4.1-.8.1-1.2z"/></svg>',
};

const STEP_LABELS = ['患者核对', '问诊录音', '智能体生成', '分色确认', '签名归档'];

/* ================= 渲染框架 ================= */
function render() {
  // 同一视图/步骤重渲染时保持滚动位置（医生编辑字段保存后不跳顶）
  const scrollKey = state.view + ':' + (state.consult ? state.consult.step + ':' + (state.consult.docType || '') + ':' + (state.profilePid || '') : 'x');
  const savedY = (state._lastRender && state._lastRender.key === scrollKey) ? state._lastRender.y : 0;
  persistConsult();
  if (!state.doctor) { renderLogin(); return; }
  const nav = state.view === 'consult' ? (state.consult && state.consult.scene === 'opd' ? 'opd' : 'consult') : state.view;
  $app.innerHTML = `
  <aside class="sidebar">
    <div class="brand">
      <div class="org">${HOSPITAL}</div>
      <div class="name">AI<em>·</em>病历智能体</div>
      <div class="sub">语音驱动 · 多智能体协作</div>
    </div>
    <nav class="nav">
      ${(state.doctor.role === 'admin'
        ? [
            ['dashboard', icons.dash, '管理总览'],
            ['profile', icons.user, '患者画像'],
            ['gold', icons.file, '金标准评测（研发）'],
            ['opd', icons.stetho, '接诊（门诊）'],
            ['audit', icons.shield, '留痕与审计'],
            ['settings', icons.gear, '系统设置'],
          ]
        : [
            ['dashboard', icons.dash, '医生工作台'],
            ['consult', icons.mic, '接诊（住院）', state.consult && state.consult.step < 5],
            ['opd', icons.stetho, '接诊（门诊）'],
            ['profile', icons.user, '患者画像'],
            ['audit', icons.shield, '我的操作记录'],
          ]
      ).map(([v, ic, t, badge]) => `<div class="nav-item ${nav === v ? 'active' : ''}" data-nav="${v}">${ic}<span class="t">${t}</span>${badge ? '<span class="badge">进行中</span>' : ''}</div>`).join('')}
    </nav>
    <div class="sidebar-foot">
      <b>${state.doctor.name}</b> ${state.doctor.title}<br>
      工号 ${state.doctor.code} · ${state.doctor.dept}<br>
      <span style="opacity:.75">${serverState.online ? 'BFF 在线 · 留痕/归档入库 SQLite' : '本机演示模式（服务端离线）'}</span>
    </div>
  </aside>
  <div class="main">
    <div class="topbar">
      <div class="crumb">${crumbTitle()}<small>AI 起草 · 医生签发</small></div>
      <div class="spacer"></div>
      <span class="demo-chip">${esc(DEMO_BANNER)}</span>
      <div class="doctor-chip"><div class="avatar">${esc(state.doctor.name[0])}</div><div class="meta">${esc(state.doctor.name)}<small>${esc(state.doctor.dept)} · 在线</small></div></div>
      <button class="btn ghost" id="btn-mask">${state.mask ? '脱敏：开' : '脱敏：关'}</button>
      <button class="btn ghost" id="btn-bigfont" title="适合年长医生的大字号显示模式">${state.bigFont ? '字号：大' : '字号：标准'}</button>
      <button class="btn ghost" id="btn-logout">退出</button>
    </div>
    <div class="content" id="view"></div>
  </div>
  <div class="toast-wrap" id="toast-wrap"></div>`;
  document.querySelectorAll('[data-nav]').forEach(el => el.addEventListener('click', () => {
    const v = el.dataset.nav;
    if (el.classList.contains('disabled')) { toast('门诊场景按分期策略于二期开放', 'err'); return; }
    if (v === 'consult' && (!state.consult || state.consult.scene !== 'ipd')) newConsult('ipd');
    if (v === 'opd' && (!state.consult || state.consult.scene !== 'opd')) newConsult('opd');
    state.view = v === 'opd' ? 'consult' : v;
    render();
  }));
  const bf = document.getElementById('btn-bigfont');
  if (bf) bf.onclick = () => {
    state.bigFont = !state.bigFont;
    localStorage.setItem('medagent_bigfont', state.bigFont ? '1' : '0');
    document.body.classList.toggle('large-font', state.bigFont);
    render();
    toast(state.bigFont ? '已切换为大字号模式' : '已恢复标准字号');
  };
  document.getElementById('btn-mask').onclick = () => {
    state.mask = !state.mask;
    localStorage.setItem('medagent_mask', state.mask ? '1' : '0');
    audit('脱敏开关', state.mask ? '开启演示数据脱敏（姓名显示为化名）' : '关闭演示数据脱敏');
    render();
    toast(state.mask ? '已开启脱敏：患者姓名显示为化名' : '已关闭脱敏');
  };
  document.getElementById('btn-logout').onclick = () => {
    audit('退出登录', `${state.doctor.name} 退出系统`);
    state.doctor = null; state.consult = null;
    render();
  };
  if (nav === 'dashboard') (state.doctor.role === 'admin' ? renderAdminDashboard() : renderDashboard());
  if (nav === 'consult' || nav === 'opd') renderConsult();
  if (nav === 'profile') renderProfile();
  if (nav === 'gold') renderGoldEval();
  if (nav === 'audit') renderAudit();
  if (nav === 'settings') renderSettings();
  window.scrollTo(0, savedY);
  state._lastRender = { key: scrollKey, y: window.scrollY };
}

function crumbTitle() {
  if (state.view === 'consult') return state.consult && state.consult.scene === 'opd' ? '门诊病历生成' : '住院病历生成';
  const isAdmin = state.doctor && state.doctor.role === 'admin';
  return {
    dashboard: isAdmin ? '管理总览' : '医生工作台',
    profile: '患者画像与病例报告',
    gold: '金标准评测（研发工具）',
    audit: isAdmin ? '留痕与审计' : '我的操作记录',
    settings: '系统设置',
  }[state.view] || '';
}

function toast(msg, type = 'ok') {
  const w = document.getElementById('toast-wrap');
  if (!w) return;
  const t = document.createElement('div');
  t.className = 'toast ' + type;
  t.textContent = msg;
  w.appendChild(t);
  setTimeout(() => { t.style.opacity = '0'; t.style.transition = 'opacity .4s'; setTimeout(() => t.remove(), 400); }, 2600);
}

/* ================= 登录 ================= */
function renderLogin() {
  $app.innerHTML = `
  <div class="login-wrap">
    <div class="login-card">
      <div class="org">${HOSPITAL}</div>
      <h1>AI<em>·</em>病历智能体</h1>
      <div class="slogan">语音驱动 · 多智能体协作 · 人在回路确认</div>
      ${DOCTORS.map((d, i) => `
      <div class="login-doctor ${i === 0 ? 'sel' : ''}" data-doc="${d.id}">
        <div class="avatar">${esc(d.name[0])}</div>
        <div><b>${esc(d.name)}${d.role === 'admin' ? ' <span class="tag-dept">管理入口</span>' : ''}</b><small>${esc(d.dept)} · ${esc(d.title)} · 工号 ${esc(d.code)}</small></div>
      </div>`).join('')}
      <button class="btn primary lg" id="btn-login" style="width:100%;justify-content:center;margin-top:14px">登录 · 进入工作台</button>
      <div class="login-foot">
        <b>约法三章</b>（贯穿全项目）—— ① 医院级系统：AI 仅生成草稿，经医生确认方可归档，缺失字段留空警示、严禁臆造；② 全程留痕可审计；③ 演示环境数据源自院内真实病历导出，请勿外传。
      </div>
    </div>
  </div>`;
  let sel = DOCTORS[0].id;
  document.querySelectorAll('.login-doctor').forEach(el => el.onclick = () => {
    document.querySelectorAll('.login-doctor').forEach(x => x.classList.remove('sel'));
    el.classList.add('sel');
    sel = el.dataset.doc;
  });
  document.getElementById('btn-login').onclick = () => {
    state.doctor = DOCTORS.find(d => d.id === sel);
    audit('登录', `${state.doctor.name}（${state.doctor.dept}）登录医生端`);
    state.view = 'dashboard';
    render();
    toast('欢迎使用 AI 病历智能体');
  };
}

/* 统一进入接诊：同患者未完成→续接；他患者未完成→拦截提示；否则新建 */
function enterConsult(pid, scene = 'ipd') {
  const c = state.consult;
  if (c && c.patientId === pid && c.scene === scene && !c.archived) {
    state.view = 'consult';
    render();
    toast('继续上次的接诊进度');
    return true;
  }
  if (c && c.patientId && c.patientId !== pid && !c.archived && c.step > 1) {
    const other = (c.scene === 'opd' ? OPD_PATIENTS : PATIENTS).find(x => x.id === c.patientId) || { name: '?' };
    toast('当前有未完成的接诊（' + N(other) + '），请先完成或归档后再发起新接诊', 'err');
    return false;
  }
  newConsult(scene, pid);
  state.view = 'consult';
  render();
  return true;
}

/* 未完成接诊提醒（医生端工作台顶部） */
function resumeBanner() {
  const c = state.consult;
  if (!c || !c.patientId || c.step === 1) return '';
  const p = (c.scene === 'opd' ? OPD_PATIENTS : PATIENTS).find(x => x.id === c.patientId);
  if (!p) return '';
  const sceneLabel = c.scene === 'opd' ? '门诊病历' : '住院病历';
  const doneDocs = c.archivedDocs ? Object.keys(c.archivedDocs).length : 0;
  return `<div class="alert-band" style="background:var(--teal-soft);border-color:#a9cbc9;color:var(--teal-deep);cursor:pointer" id="resume-band">
    ✎ <b>您有一份未完成的接诊</b>：${esc(N(p))} · ${sceneLabel}（已归档 ${doneDocs} 份文书，当前进行到“${STEP_LABELS[c.step - 1]}”）——点击此处继续
  </div>`;
}

/* ================= 工作台 ================= */
function renderDashboard() {
  const abnPatients = PATIENTS.filter(p => p.his.labs.length).length;
  const todayArchives = store.archives.length;
  const inProgress = (state.consult && state.consult.patientId && !state.consult.archived) ? 1 : 0;
  const view = document.getElementById('view');
  view.innerHTML = `
    <h1 class="page-title">医生工作台</h1>
    <p class="page-desc">在院患者一览 · 点“开始接诊”，问诊录音后自动起草病历，核对签名即可归档</p>
    ${resumeBanner()}
    <div class="stat-grid">
      <div class="stat"><div class="num">${PATIENTS.length}</div><div class="lbl">在院患者（点“开始接诊”起草病历）</div><div class="trend">真实数据</div></div>
      <div class="stat"><div class="num">${abnPatients}</div><div class="lbl">有检验异常的患者（人）</div><div class="trend">进画像页查看详情</div></div>
      <div class="stat"><div class="num">${inProgress}</div><div class="lbl">进行中的接诊</div><div class="trend">${inProgress ? '见上方提醒' : '无'}</div></div>
      <div class="stat"><div class="num">${todayArchives}</div><div class="lbl">已归档病历（份）</div><div class="trend">我的操作记录可查</div></div>
    </div>
    <div class="card">
      <div class="card-head"><h3>在院患者</h3><span class="hint">点击任意患者可直接查看其跨住院次画像</span></div>
      <table class="pt-table">
        <thead><tr><th>患者</th><th>病案号</th><th>第 N 次住院</th><th>入院主诉</th><th>初步诊断</th><th>病历状态</th><th style="width:120px">操作</th></tr></thead>
        <tbody>
        ${PATIENTS.map(p => {
          const n = store.archives.filter(a => a.pid === p.id).length;
          const ongoing = state.consult && state.consult.patientId === p.id && !state.consult.archived;
          const st = ongoing
            ? '<span class="pill his"><span class="dot"></span>进行中</span>'
            : (n ? `<span class="pill dlg"><span class="dot"></span>已归档 ${n} 份</span>` : '<span class="pill miss"><span class="dot"></span>未开始</span>');
          return `
          <tr class="rowlink" data-profile="${p.id}">
            <td><div class="pt-name"><div class="avatar">${esc(N(p)[0])}</div><div><b>${esc(N(p))}</b><small>${p.sex} · ${p.age}岁 · ${esc(p.ward)}</small></div></div></td>
            <td class="num-serif">${esc(p.id.replace('P', ''))}</td>
            <td class="num-serif">第 ${p.visitNo} 次</td>
            <td>${esc(p.chiefView)}</td>
            <td><span class="tag-dept">${esc(p.dxPreview)}</span></td>
            <td>${st}${p.allergies && p.allergies !== '无' ? '<br><span class="allergy-flag" style="font-size:11px">⚠ ' + esc(p.allergies) + '</span>' : ''}</td>
            <td><button class="btn" data-consult="${p.id}">${ongoing ? '继续接诊' : '开始接诊'}</button></td>
          </tr>`;
        }).join('')}
        </tbody>
      </table>
    </div>`;
  view.querySelectorAll('[data-profile]').forEach(tr => tr.addEventListener('click', e => {
    if (e.target.closest('button')) return;
    state.profilePid = tr.dataset.profile; state.view = 'profile'; render();
  }));
  view.querySelectorAll('[data-consult]').forEach(b => b.addEventListener('click', () => {
    enterConsult(b.dataset.consult, 'ipd');
  }));
  const rb = view.querySelector('#resume-band');
  if (rb) rb.onclick = () => { state.view = 'consult'; render(); };
}

/* ================= 管理总览（管理后台，数据全部来自系统真实操作记录） ================= */
const DOC_LABELS = { adm: '入院记录', fc: '首次病程记录', dc: '出院记录', opd: '门诊病历' };

function renderAdminDashboard() {
  const view = document.getElementById('view');
  const arcs = store.archives;
  const logs = store.logs;
  const byType = {};
  arcs.forEach(a => { const k = a.doc || DOC_LABELS[a.type] || '其他'; byType[k] = (byType[k] || 0) + 1; });
  const qcBlanks = logs.filter(l => l.action === '确认留空').length;
  const qcEdits = logs.filter(l => l.action === '修改字段').length;
  const doctors = {};
  logs.forEach(l => {
    if (!l.doctor || l.doctor === '—') return;
    const d = (doctors[l.doctor] = doctors[l.doctor] || { total: 0, archive: 0, edit: 0, blank: 0, run: 0 });
    d.total++;
    if (l.action === '签名归档') d.archive++;
    if (l.action === '修改字段') d.edit++;
    if (l.action === '确认留空') d.blank++;
    if (l.action === '启动多智能体' || l.action === '启动多智能体生成') d.run++;
  });
  const docs = Object.entries(byType).sort((a, b) => b[1] - a[1]);
  const maxType = docs.length ? docs[0][1] : 1;

  view.innerHTML = `
    <h1 class="page-title">管理总览</h1>
    <p class="page-desc">系统运行情况与病历质量追溯（数据来自真实操作记录，非演示数字）</p>
    <div class="stat-grid">
      <div class="stat"><div class="num">${arcs.length}</div><div class="lbl">累计归档病历（份）</div><div class="trend">SQLite + 本机</div></div>
      <div class="stat"><div class="num">${logs.length}</div><div class="lbl">操作留痕（条）</div><div class="trend">全程可追溯</div></div>
      <div class="stat"><div class="num">${qcBlanks}</div><div class="lbl">质控"确认留空"（次）</div><div class="trend">不臆造机制运行记录</div></div>
      <div class="stat"><div class="num">${qcEdits}</div><div class="lbl">医师修改字段（次）</div><div class="trend">医生主导的体现</div></div>
    </div>
    <div class="row">
      <div class="card col">
        <div class="card-head"><h3>归档文书分布</h3><span class="hint">按文书类型</span></div>
        <div class="card-body">
          ${docs.length ? docs.map(([k, v]) => `
            <div style="margin-bottom:12px">
              <div style="display:flex;font-size:13px;margin-bottom:4px"><b>${esc(k)}</b><span class="right num-serif">${v} 份</span></div>
              <div style="height:8px;border-radius:99px;background:#efe9da"><div style="width:${(v / maxType * 100).toFixed(0)}%;height:100%;border-radius:99px;background:linear-gradient(90deg,var(--teal),#5fa3ad)"></div></div>
            </div>`).join('') : '<div class="empty-hint">暂无归档记录</div>'}
        </div>
      </div>
      <div class="card col">
        <div class="card-head"><h3>医师使用统计</h3><span class="hint">按操作留痕汇总</span></div>
        <div class="card-body" style="padding-top:8px">
          <table class="audit-table">
            <thead><tr><th>医师</th><th>操作</th><th>归档</th><th>修改</th><th>留空</th></tr></thead>
            <tbody>
              ${Object.entries(doctors).length ? Object.entries(doctors).sort((a, b) => b[1].total - a[1].total).map(([d, s]) => `
                <tr><td><b>${esc(d)}</b></td><td class="num-serif">${s.total}</td><td class="num-serif">${s.archive}</td><td class="num-serif">${s.edit}</td><td class="num-serif">${s.blank}</td></tr>`).join('')
                : '<tr><td colspan="5"><div class="empty-hint">暂无数据</div></td></tr>'}
            </tbody>
          </table>
        </div>
      </div>
    </div>
    <div class="card">
      <div class="card-head"><h3>最近归档</h3><span class="hint">最新 8 份</span></div>
      <table class="audit-table">
        <thead><tr><th style="width:160px">时间</th><th>患者</th><th>文书</th><th>医师</th><th style="width:110px">批次</th><th style="width:96px"></th></tr></thead>
        <tbody>
          ${arcs.length ? arcs.slice(0, 8).map(a => `
            <tr><td class="num-serif">${esc(a.time)}</td><td><b>${esc(N({ name: a.pname }))}</b></td><td>${esc(a.doc || DOC_LABELS[a.type] || '')}</td><td>${esc(a.doctor)}</td><td class="num-serif">${esc(a.id)}</td>
            <td><button class="mini-btn" data-aview-md="${a.id}">查看 MD</button></td></tr>`).join('')
            : '<tr><td colspan="6"><div class="empty-hint">暂无归档</div></td></tr>'}
        </tbody>
      </table>
    </div>
    <div class="mt-16" style="display:flex;gap:10px">
      <button class="btn" data-nav="gold">▶ 金标准评测（研发）</button>
      <button class="btn" data-nav="settings">▶ 系统设置</button>
      <button class="btn" data-nav="audit">▶ 留痕与审计</button>
    </div>`;
  view.querySelectorAll('[data-aview-md]').forEach(b => b.onclick = () => {
    const a = store.archives.find(x => x.id === b.dataset.aviewMd);
    if (a) openMDModal(`已归档 · ${N({ name: a.pname })} · ${a.doc || ''}`, a.md, `${a.pname}_${a.doc || '病历'}_${a.id}.md`);
  });
  view.querySelectorAll('[data-nav]').forEach(el => el.addEventListener('click', () => { state.view = el.dataset.nav; render(); }));
}

/* ================= 接诊向导 ================= */
function newConsult(scene = 'ipd', patientId = null) {
  state.consult = {
    scene, patientId, step: 1, engine: 'webspeech',
    recording: false, timer: 0, timerHandle: null,
    turns: [], liveText: '', asrHandle: null, asrName: '浏览器语音引擎',
    pipelineDone: false, pipeSteps: [], drafts: null, docType: 'adm', archivedDocs: {}, visitedDocs: {}, qc: null, mapping: null,
    editingId: null, archived: false,
  };
}

function consultHead() {
  return `<div class="wizard-rail">
    ${STEP_LABELS.map((t, i) => {
      const n = i + 1;
      const cls = n === state.consult.step ? 'active' : (n < state.consult.step ? 'done' : '');
      return `<div class="wstep ${cls}"><div class="n">${n < state.consult.step ? '✓' : n}</div><div class="t">${t}</div></div>${n < 5 ? `<div class="wline ${n < state.consult.step ? 'done' : ''}"></div>` : ''}`;
    }).join('')}
  </div>`;
}

function renderConsult() {
  const c = state.consult;
  const view = document.getElementById('view');
  const p = (c.scene === 'opd' ? OPD_PATIENTS : PATIENTS).find(x => x.id === c.patientId);
  const isOPD = c.scene === 'opd';
  view.innerHTML = `<h1 class="page-title">接诊 · ${isOPD ? '门诊病历' : '住院病历'}生成</h1><p class="page-desc">${isOPD
    ? '按院内《门诊病历》模板生成草稿；音频为本次真实原声，可回放核对'
    : '按院内《入院记录》模板生成草稿，您核对签名后归档'}</p>${consultHead()}<div id="cstep"></div>`;
  const step = document.getElementById('cstep');
  if (c.step === 1) renderStep1(step, c);
  if (c.step === 2) renderStep2(step, c, p);
  if (c.step === 3) renderStep3(step, c, p);
  if (c.step === 4) renderStep4(step, c);
  if (c.step === 5) renderStep5(step, c, p);
}

/* ---- Step 1 患者核对（住院/门诊双场景） ---- */
function renderStep1(el, c) {
  const isOPD = c.scene === 'opd';
  const LIST = isOPD ? OPD_PATIENTS : PATIENTS;
  const sel = c.patientId ? LIST.find(p => p.id === c.patientId) : null;
  el.innerHTML = `
    <div class="card">
      <div class="card-head"><h3>① 患者核对</h3><span class="hint">蓝色信息由系统自动带入，请确认是眼前这位患者</span></div>
      <div class="card-body">
        <div class="engine-row gap-b">
          <span class="engine-chip ${!isOPD ? 'sel' : ''}" data-scene="ipd">住院场景 · 入院记录</span>
          <span class="engine-chip ${isOPD ? 'sel' : ''}" data-scene="opd">门诊场景 · 门诊病历</span>
        </div>
        <div class="pick-list">
          ${LIST.map(p => `
          <div class="pick ${c.patientId === p.id ? 'sel' : ''}" data-pick="${p.id}">
            <div class="avatar">${esc(N(p)[0])}</div>
            <div>
              <b>${esc(N(p))}</b> <span class="muted">${p.sex} · ${p.ageText || p.age + '岁'}</span>
              <div class="meta">${isOPD
                ? `门诊号 <span class="num-serif">${esc(p.id)}</span> · ${esc(p.dept)} · 费别 ${esc(p.fee || '—')}<br>就诊时间 <span class="num-serif">${esc(p.visitAt)}</span>`
                : `病案号 <span class="num-serif">${esc(p.id.replace('P', ''))}</span> · 第 ${p.visitNo} 次住院 · ${esc(p.ward)}<br>入院时间 <span class="num-serif">${esc(p.admittedAt)}</span>`}</div>
              <div class="dx">${isOPD ? '本次就诊：' : '门诊/急诊拟诊：'}${esc(p.dxPreview)}</div>
            </div>
          </div>`).join('')}
        </div>
        <div id="his-preview">${sel ? (isOPD ? opdPreview(sel) : hisPreview(sel)) : '<div class="empty-hint">选择患者后，此处展示 HIS 自动带入的患者信息（蓝色 = 系统数据，不依赖语音）</div>'}</div>
        <div class="mt-16" style="display:flex">
          <button class="btn primary lg" id="btn-to2" ${sel ? '' : 'disabled'}>确认患者，进入问诊录音 →</button>
        </div>
      </div>
    </div>`;
  el.querySelectorAll('[data-scene]').forEach(ch => ch.onclick = () => {
    newConsult(ch.dataset.scene);
    renderConsult();
  });
  el.querySelectorAll('[data-pick]').forEach(pk => pk.onclick = () => {
    c.patientId = pk.dataset.pick;
    renderConsult();
  });
  const b = el.querySelector('#btn-to2');
  if (b) b.onclick = () => {
    audit('患者核对', isOPD
      ? `确认门诊患者 ${sel.name}（门诊号 ${sel.id}），门诊档案与慢病备案拉取完成`
      : `确认患者 ${sel.name}（病案号 ${sel.id.replace('P', '')}），HIS 主索引与检验检查医嘱拉取完成`);
    c.step = 2; renderConsult();
  };
}

/* 门诊档案预览（蓝 · HIS 带入） */
function opdPreview(p) {
  return `<div class="his-panel mt-16"><div class="card-body">
    <div style="display:flex;align-items:center;gap:10px;margin-bottom:12px">
      <span class="pill his"><span class="dot"></span>HIS 带入</span>
      <b>${esc(N(p))}</b><span class="muted">${p.sex} · ${p.ageText || p.age + '岁'} · 费别 ${esc(p.fee || '—')}</span>
      <span class="right allergy-flag">过敏：${p.allergies && p.allergies !== '无' ? '⚠ ' + esc(p.allergies) : '无'}</span>
    </div>
    <div class="kv">
      <div class="item"><div class="k">门诊病案号</div><div class="v num-serif">${esc(p.id)}</div></div>
      <div class="item"><div class="k">就诊时间</div><div class="v num-serif">${esc(p.visitAt)}</div></div>
      <div class="item"><div class="k">就诊科室</div><div class="v">${esc(p.dept)}</div></div>
      <div class="item"><div class="k">慢病备案</div><div class="v">${(p.his.chronic || []).length ? esc(p.his.chronic.join('、')) : '无'}</div></div>
      <div class="item"><div class="k">既往就诊</div><div class="v">${esc((p.his.visits || [])[0] || '首次就诊')}</div></div>
      <div class="item"><div class="k">拟诊</div><div class="v">${esc(p.dxPreview)}</div></div>
    </div>
    <div class="mt-10" style="font-size:12.5px;color:var(--ink-soft)">本次门诊含真实录音原声，问诊录音步骤可回放对照（文件：${esc(p.audio)}）</div>
  </div></div>`;
}

function hisPreview(p) {
  return `<div class="his-panel mt-16"><div class="card-body">
    <div style="display:flex;align-items:center;gap:10px;margin-bottom:12px">
      <span class="pill his"><span class="dot"></span>HIS 带入</span>
      <b>${esc(N(p))}</b><span class="muted">${p.sex} · ${p.age}岁 · ${esc(p.marriage)} · ${esc(p.job)}</span>
      <span class="right allergy-flag">过敏：⚠ ${esc(p.allergies)}</span>
    </div>
    <div class="kv">
      <div class="item"><div class="k">病案号</div><div class="v num-serif">${esc(p.id.replace('P', ''))}</div></div>
      <div class="item"><div class="k">入院时间</div><div class="v num-serif">${esc(p.admittedAt)}</div></div>
      <div class="item"><div class="k">住院次数</div><div class="v">第 ${p.visitNo} 次</div></div>
      <div class="item"><div class="k">出生地</div><div class="v">${esc(p.birthplace)}</div></div>
      <div class="item"><div class="k">当前科室</div><div class="v">${esc(p.ward)}</div></div>
      <div class="item"><div class="k">拟诊</div><div class="v">${esc(p.dxPreview)}</div></div>
    </div>
    <div class="mt-10" style="font-size:12.5px;color:var(--ink-soft)">既往住院 ${p.admissions.length - 1} 次（知识检索智能体将自动关联，详见患者画像）</div>
  </div></div>`;
}

/* ---- Step 2 问诊录音（真实数据环境：无演示转写脚本） ---- */
function renderStep2(el, c, p) {
  const hasTranscript = c.turns.length && (c.turns[c.turns.length - 1].mandarin || c.transcriptText);
  el.innerHTML = `
    <div class="row">
      <div class="card col">
        <div class="card-head"><h3>② 问诊录音</h3><span class="hint">正常问诊即可；可说方言，由语音引擎转成文字</span></div>
        <div class="card-body">
          <div class="engine-row">
            ${ASR_ENGINES.map(e => `<span class="engine-chip ${c.engine === e.id ? 'sel' : ''} ${engineReady(e.id) ? '' : 'off'}" data-eng="${e.id}" title="${esc(e.desc)}">${esc(e.name)}${engineReady(e.id) ? (e.id === 'webspeech' ? ' · 就绪' : ' · 密钥就绪') : ' · 未配置'}</span>`).join('')}
          </div>
          <div class="muted" style="font-size:12px;line-height:1.7" id="eng-desc">${esc((ASR_ENGINES.find(e => e.id === c.engine) || ASR_ENGINES[0]).desc)}</div>
          <div class="record-stage">
            <button class="rec-btn ${c.recording ? 'recording' : ''}" id="btn-rec">
              ${c.recording ? '<svg viewBox="0 0 24 24" fill="currentColor"><rect x="6" y="6" width="12" height="12" rx="2"/></svg>' : icons.mic}
            </button>
            <div class="rec-timer" id="rec-timer">${fmtTime(c.timer)}</div>
            <div class="wave ${c.recording ? '' : 'idle'}" id="wave">${waveBars()}</div>
            <div class="muted" style="font-size:12px;margin-top:10px" id="rec-hint">
              ${c.recording ? '正在录音（真实麦克风）…' : '点击开始真实录音；实时转写能力取决于所选引擎'}
            </div>
            ${c.recording ? '<button class="btn danger-outline" id="btn-stop" style="margin-top:12px">■ 结束录音</button>' : ''}
            ${c.scene === 'opd' && p.audio ? `
            <div class="mt-16" style="width:100%">
              <audio controls preload="none" src="${p.audio}" style="width:100%;height:34px"></audio>
              <div class="muted" style="font-size:11.5px;margin-top:5px;line-height:1.7">真实门诊原声回放（本例音频）· 转写文本将由正式引擎转写生成，系统不预置任何脚本</div>
            </div>` : ''}
          </div>
        </div>
      </div>
      <div class="card col">
        <div class="card-head"><h3>转写情况</h3><span class="hint">${c.transcriptText ? '已获得转写文本' : (c.audioUrl ? '录音完成 · 可回放' : '等待真实转写')}</span></div>
        <div class="card-body" style="padding-top:8px">
          ${c.audioUrl ? `
          <div style="margin-bottom:12px">
            <div style="font-size:12px;color:var(--teal);letter-spacing:.08em;margin-bottom:5px">本次录音回放（时长 ${fmtTime(c.timer)} · 已存本地，引擎接入后可补转写）</div>
            <audio controls src="${c.audioUrl}" style="width:100%;height:34px"></audio>
          </div>` : ''}
          ${c.transcriptText
            ? `<div style="font-size:13.8px;line-height:1.9;white-space:pre-wrap">${esc(c.transcriptText)}</div>`
            : `<div class="empty-hint" style="padding:22px 8px;line-height:2.1">
                 本系统为<b>真实数据环境</b>：不预置任何演示转写文本。<br>
                 语音转写将在以下任一条件就绪后可用：<br>
                 ① 选择"浏览器语音引擎"并授权麦克风（普通话）；<br>
                 ② 在"系统设置"登记讯飞密钥（实时转写通道已接通：医疗领域优化 + 近场模式，签名由服务端计算）。<br>
                 <span class="muted">当前生成素材源：真实病案文书与 HIS 数据（下一步自动汇聚）。</span>
               </div>`}
        </div>
      </div>
    </div>
    <div class="mt-16" style="display:flex;gap:10px">
      <button class="btn" id="btn-back1">← 上一步</button>
      <button class="btn primary lg" id="btn-to3">启动多智能体生成（素材源：${c.transcriptText ? '真实转写 + 病案文书' : '真实病案文书'}）→</button>
    </div>`;
  bindStep2(el, c, p);
}

function fmtTime(s) {
  return `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
}
function waveBars() {
  let h = '';
  for (let i = 0; i < 26; i++) {
    h += `<i style="animation-delay:${(Math.random() * 0.9).toFixed(2)}s;animation-duration:${(0.7 + Math.random() * 0.6).toFixed(2)}s"></i>`;
  }
  return h;
}

function bindStep2(el, c, p) {
  el.querySelectorAll('[data-eng]').forEach(ch => ch.onclick = () => {
    const e = ASR_ENGINES.find(x => x.id === ch.dataset.eng);
    if (!engineReady(e.id)) { toast('该引擎尚未配置密钥，请到"系统设置"页填写', 'err'); return; }
    if (c.recording) { toast('录音中不可切换引擎', 'err'); return; }
    c.engine = e.id;
    c.asrName = e.name;
    renderConsult();
  });
  const engDesc = el.querySelector('#eng-desc');
  if (engDesc) engDesc.textContent = (ASR_ENGINES.find(e => e.id === c.engine) || ASR_ENGINES[0]).desc;

  el.querySelector('#btn-back1').onclick = () => { c.step = 1; renderConsult(); };

  el.querySelector('#btn-rec').onclick = () => {
    if (c.recording) return;
    c.recording = true;
    c.timer = 0;
    audit('开始录音', `患者 ${N(p)} · ASR 引擎：${c.asrName}`);
    startASR();
    renderConsult();
  };

  const btnStop = el.querySelector('#btn-stop');
  if (btnStop) btnStop.onclick = () => {
    if (c.asrHandle && c.asrHandle.stop) {
      // 引擎自主收尾：rtasr 发结束帧等服务端回终稿，webspeech 停识别器，二者经 onDone/onError 回到 finishRecording
      c.asrHandle.stop();
    } else {
      finishRecording();
    }
  };

  function startASR() {
    c.timerHandle = setInterval(() => {
      c.timer++;
      const t = document.getElementById('rec-timer');
      if (t) t.textContent = fmtTime(c.timer);
    }, 1000);
    // 真实音频采集（与转写引擎并行）：录完可回放，也为 M2.1 补转写留存素材
    if (navigator.mediaDevices && navigator.mediaDevices.getUserMedia && window.MediaRecorder) {
      navigator.mediaDevices.getUserMedia({ audio: true }).then(stream => {
        try {
          c._chunks = [];
          const rec = new MediaRecorder(stream);
          c._recorder = rec;
          rec.ondataavailable = e => { if (e.data.size) c._chunks.push(e.data); };
          rec.start();
        } catch (e) { toast('音频采集不可用：' + e.message, 'err'); }
      }).catch(() => toast('未获得麦克风权限：本次仅计时，无法录音与转写', 'err'));
    }

    const handlers = {
      onProgress(text) { c.transcriptText = text; updateTranscript(); },
      onDone() { finishRecording(); },
      onError(msg) { toast(msg, 'err'); finishRecording(); },
    };

    function updateTranscript() {
      const box = document.getElementById('view');
      if (box && c.transcriptText) renderConsult();
    }

    if (c.engine === 'webspeech') {
      c.asrHandle = startWebSpeechASR(handlers);
      if (!c.asrHandle) { finishRecording(); return; }
    } else if (c.engine === 'iflytek') {
      /* 讯飞实时语音转写（真实 WS 通道，M2.1 S6）：签名服务端计算，麦克风 16k PCM 分帧上行 */
      startRtasrASR({
        onProgress(text) { c.transcriptText = text; updateTranscript(); },
        onStatus(msg) { const h = document.getElementById('rec-hint'); if (h) h.textContent = msg; },
        onError(msg) { toast(msg, 'err'); finishRecording(); },
        onDone() { finishRecording(); },
      }).then(handle => {
        // 启动是异步的：用户若已结束/出错收尾，则立即停掉刚起的会话，避免悬挂
        if (c.recording && !c.asrHandle) c.asrHandle = handle;
        else if (handle && handle.stop) handle.stop();
        if (!handle) finishRecording();
      });
    } else {
      // 阿里云：Token 流程待挂接——仅真实录音留存，不虚构转写
      c.asrHandle = null;
    }
  }

  let finishing = false;
  function finishRecording() {
    if (finishing) return; // onerror 与 onend 可能同时触发
    finishing = true;
    clearInterval(c.timerHandle);
    c.recording = false;
    c.asrHandle = null;
    if (c._recorder && c._recorder.state !== 'inactive') {
      const rec = c._recorder;
      rec.onstop = () => {
        try {
          c.audioUrl = URL.createObjectURL(new Blob(c._chunks, { type: rec.mimeType || 'audio/webm' }));
        } catch (_) {}
        c._recorder = null;
        if (c._mediaStream) { c._mediaStream.getTracks().forEach(t => t.stop()); c._mediaStream = null; }
        renderConsult();
      };
      rec.stop();
    }
    if (c.transcriptText) {
      audit('转写完成', `录音 ${fmtTime(c.timer)}，获得真实转写文本（引擎：${c.asrName}）`);
    } else {
      audit('录音完成', `录音 ${fmtTime(c.timer)}（无实时转写：生成素材源为真实病案文书）`);
    }
    renderConsult();
    toast(c.transcriptText ? '录音完成，已获得转写文本' : '录音完成（生成将以真实病案文书为素材源）');
  }

  el.querySelector('#btn-to3').onclick = () => {
    c.step = 3;
    c.pipeSteps = [];
    renderConsult();
  };
}

/* ---- Step 3 智能体流水线 ---- */
function renderStep3(el, c, p) {
  const done = c.pipelineDone;
  el.innerHTML = `
    <div class="card">
      <div class="card-head"><h3>③ AI 起草病历</h3>
        <span class="hint">六个 AI 助手分工起草，每句话都标明出处</span></div>
      <div class="card-body">
        <div class="pipe" id="pipe">
          ${AGENTS.map((a, i) => {
            const st = c.pipeSteps[i];
            const cls = st ? 'done' : (i === c.pipeSteps.length && !done ? 'active' : 'pending');
            return `<div class="agent-row ${cls}" data-agent="${a.id}">
              <div class="agent-node">${st ? '✓' : i + 1}</div>
              <div>
                <div class="a-name">${esc(a.name)} ${st ? '<span class="pill dlg" style="margin-left:4px"><span class="dot"></span>完成</span>' : (cls === 'active' ? '<span class="pill his"><span class="dot"></span>运行中…</span>' : '')}</div>
                <div class="a-role">${esc(a.role)}</div>
                ${st ? `<div class="agent-out"><div class="sum">${esc(st.summary)}</div><div class="det">${esc(st.detail)}</div></div>` : ''}
              </div>
            </div>`;
          }).join('')}
        </div>
        <div class="mt-16" style="display:flex;gap:10px">
          <button class="btn" id="btn-back2">← 上一步</button>
          ${done
            ? '<button class="btn primary lg" id="btn-to4">生成完毕，查看分色草稿 →</button>'
            : '<button class="btn ghost" id="btn-skip">快进（跳过演示动画）</button>'}
        </div>
      </div>
    </div>`;
  el.querySelector('#btn-back2').onclick = () => { c.step = 2; renderConsult(); };
  if (done) {
    el.querySelector('#btn-to4').onclick = () => { c.step = 4; renderConsult(); };
  } else if (!c.pipeHandle) {
    startPipeline();
  }
  const skip = el.querySelector('#btn-skip');
  if (skip) skip.onclick = () => {
    if (c.pipeHandle) { c.pipeHandle.skipAll(); c.pipeHandle = null; }
  };
}

function startPipeline() {
  const c = state.consult;
  if (c.pipeHandle) return;
  const p = (c.scene === 'opd' ? OPD_PATIENTS : PATIENTS).find(x => x.id === c.patientId);
  audit('启动多智能体', `${p.name} · ${c.scene === 'opd' ? '门诊病历' : '入院记录'} · 编排 6 智能体 · 生成引擎：${llmGenActive() ? '大模型' : '规则演示'}`);
  c.pipeHandle = runPipeline(p, {
    onStep(agent, output, i, total) {
      c.pipeSteps[i] = output;
      const row = document.querySelector(`[data-agent="${agent.id}"]`);
      if (!row) { renderConsult(); return; }
      row.classList.remove('active', 'pending');
      row.classList.add('done');
      row.querySelector('.agent-node').textContent = '✓';
      row.querySelector('.a-name').innerHTML = `${esc(agent.name)} <span class="pill dlg" style="margin-left:4px"><span class="dot"></span>完成</span>`;
      const div = document.createElement('div');
      div.className = 'agent-out';
      div.innerHTML = `<div class="sum">${esc(output.summary)}</div><div class="det">${esc(output.detail)}</div>`;
      row.querySelector('.a-role').after(div);
      row.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    },
    onDone(ctx) {
      c.pipelineDone = true;
      c.drafts = {
        adm: JSON.parse(JSON.stringify(ctx.generate.fields)),
        fc: ctx.generateFC ? JSON.parse(JSON.stringify(ctx.generateFC.fields)) : null,
        dc: ctx.generateDC ? JSON.parse(JSON.stringify(ctx.generateDC.fields)) : null,
      };
      c.docType = 'adm';
      c.archivedDocs = {};
      c.qc = ctx.qc;
      c.mapping = ctx.mapping;
      c.pipeHandle = null;
      audit('智能体完成', `六智能体流水线执行完毕：${ctx.qc.summary}`);
      renderConsult();
      toast('六智能体流水线执行完毕');
    },
  });
}

/* ---- Step 4 分色草稿 ---- */
const CONSULT_DOCS = {
  ipd: [
    { id: 'adm', label: '入院记录', metric: '首期主攻文书' },
    { id: 'fc', label: '首次病程记录', metric: 'T10 · 多源汇聚' },
    { id: 'dc', label: '出院记录', metric: 'T11 · 全程汇总' },
  ],
  opd: [{ id: 'adm', label: '门诊病历', metric: '原始口述场景' }],
};

function renderStep4(el, c) {
  const isOPD = c.scene === 'opd';
  const docs = CONSULT_DOCS[isOPD ? 'opd' : 'ipd'];
  const f = (c.drafts && c.drafts[c.docType]) || [];
  const missCount = f.filter(x => x.source === 'miss' && !x.value.trim() && !x.confirmedBlank).length;
  el.innerHTML = `
    ${docs.length > 1 ? `<div class="engine-row gap-b">${docs.map(d => {
      const unreadMark = (!c.visitedDocs[d.id] && !c.archivedDocs[d.id]) ? '<span class="unread-dot" title="待核对"></span>' : '';
      return `<span class="engine-chip ${c.docType === d.id ? 'sel' : ''}" data-cdoc="${d.id}">${d.label}${unreadMark}${c.archivedDocs[d.id] ? ' · 已归档✓' : ''}</span>`;
    }).join('')}</div>` : ''}
    <div class="legend gap-b">
      <b>四色来源图例（方案 2.2）：</b>
      <span class="pill dlg"><span class="dot"></span>绿 · 智能体提炼（真实数据源）</span>
      <span class="pill his"><span class="dot"></span>蓝 · HIS 带入</span>
      <span class="pill norm"><span class="dot"></span>灰 · 规范所见</span>
      <span class="pill miss"><span class="dot"></span>黄 · 待补充（重点核对）</span>
      <span class="right muted">双击字段内容可直接编辑；修改后自动标记“医师已修改”</span>
    </div>
    ${missCount ? `<div class="qc-banner warn"><b>质控校验（质控智能体）：</b>当前文书（${(CONSULT_DOCS[isOPD ? 'opd' : 'ipd'].find(d => d.id === c.docType) || {}).label}）有 ${missCount} 个字段对话中未获取、系统无法判定，已按“不臆造”原则留空（黄色虚线框）。请医生补充，或在字段内选择“确认留空归档”并承担记录责任。</div>`
      : '<div class="qc-banner ok"><b>质控校验通过：</b>当前文书无缺失待补字段。请核对绿色（对话提炼）与灰色（规范所见）内容后进入归档。</div>'}
    <div class="field-grid">
      ${f.map((fd, i) => fieldCard(fd, i, c)).join('')}
    </div>
    <div class="mt-16" style="display:flex;gap:10px;flex-wrap:wrap">
      <button class="btn" id="btn-back3">← 上一步</button>
      <button class="btn primary lg" id="btn-to5">核对完毕，进入签名归档（${(CONSULT_DOCS[isOPD ? 'opd' : 'ipd'].find(d => d.id === c.docType) || {}).label}）→</button>
      ${docs.length > 1 ? '<span class="muted" style="font-size:12px;align-self:center">同一接诊可分别归档三类文书，切换上方页签继续</span>' : ''}
    </div>`;
  bindStep4(el, c);
  if (c._gotoMissing) {
    c._gotoMissing = false;
    const cur = (c.drafts && c.drafts[c.docType]) || [];
    const firstMiss = [...el.querySelectorAll('.fcard.miss')].find(k => {
      const fd = cur.find(f => f.id === k.querySelector('.f-body')?.dataset.fid);
      return fd && !fd.confirmedBlank;
    }) || el.querySelector('.fcard.miss');
    if (firstMiss) {
      setTimeout(() => {
        firstMiss.scrollIntoView({ behavior: 'smooth', block: 'center' });
        firstMiss.classList.add('flash');
        setTimeout(() => firstMiss.classList.remove('flash'), 2600);
      }, 120);
    }
  }
}

function fieldCard(fd, i, c) {
  const meta = SOURCE_META[fd.source];
  const empty = !fd.value.trim();
  const editing = c.editingId === fd.id;
  return `<div class="fcard ${fd.source}">
    <div class="f-head">
      <b>${esc(fd.label)}</b>
      <span class="pill ${fd.source}"><span class="dot"></span>${meta.label}</span>
      ${fd.edited ? '<span class="edited-badge">医师已修改</span>' : ''}
      <span class="conf" title="生成模型自评置信度">${fd.source === 'miss' ? '—' : (Math.round(fd.confidence * 100) + '%')}</span>
    </div>
    <div class="f-body ${empty ? 'empty' : ''}" data-fid="${fd.id}" data-dbedit="${i}" title="双击可直接编辑">${empty ? '（待补充——AI 未获依据，严禁臆造，请医生录入）' : esc(fd.value)}</div>
    ${fd.evidence && fd.source !== 'his' ? `<div class="f-evid"><span class="ev-t">来源溯源</span>${esc(fd.evidence)}</div>` : (fd.source === 'his' ? `<div class="f-evid"><span class="ev-t">来源溯源</span>${esc(fd.evidence)}</div>` : '')}
    <div class="f-edit">
      ${editing
        ? `<textarea id="ta-${fd.id}">${esc(fd.value)}</textarea><button class="mini-btn" data-save="${i}">保存</button><button class="mini-btn" data-cancel="1">取消</button>`
        : `<button class="mini-btn" data-edit="${i}">✎ 医师编辑</button>
           ${fd.source === 'miss' ? (fd.confirmedBlank ? '<span class="pill miss"><span class="dot"></span>医师已确认留空</span>' : `<button class="mini-btn warn" data-blank="${i}">确认留空归档（我已知情）</button>`) : ''}`}
    </div>
  </div>`;
}

function bindStep4(el, c) {
  const F = () => (c.drafts && c.drafts[c.docType]) || [];
  c.visitedDocs = c.visitedDocs || {};
  c.visitedDocs[c.docType] = true;
  el.querySelectorAll('[data-dbedit]').forEach(body => body.ondblclick = () => {
    const idx = F().findIndex(f => f.id === body.dataset.fid);
    if (idx >= 0) { c.editingId = F()[idx].id; renderConsult(); }
  });
  const ta0 = el.querySelector('.fcard textarea');
  if (ta0) ta0.focus();
  el.querySelectorAll('[data-cdoc]').forEach(ch => ch.onclick = () => {
    c.docType = ch.dataset.cdoc;
    c.editingId = null;
    renderConsult();
  });
  el.querySelectorAll('[data-edit]').forEach(b => b.onclick = () => { c.editingId = F()[b.dataset.edit].id; renderConsult(); });
  el.querySelectorAll('[data-cancel]').forEach(b => b.onclick = () => { c.editingId = null; renderConsult(); });
  el.querySelectorAll('[data-save]').forEach(b => b.onclick = () => {
    const fd = F()[b.dataset.save];
    const ta = el.querySelector('#ta-' + fd.id);
    const old = fd.value;
    fd.value = ta.value.trim();
    if (fd.value && fd.value !== old) { fd.edited = true; audit('修改字段', `${fd.label}：医师编辑并保存`); }
    if (fd.value) fd.confirmedBlank = false;
    c.editingId = null;
    renderConsult();
    toast('已保存修改');
  });
  el.querySelectorAll('[data-blank]').forEach(b => b.onclick = () => {
    const fd = F()[b.dataset.blank];
    fd.confirmedBlank = true;
    audit('确认留空', `${fd.label}：医师确认留空归档（不臆造原则）`);
    renderConsult();
  });
  el.querySelector('#btn-back3').onclick = () => { c.step = 3; renderConsult(); };
  el.querySelector('#btn-to5').onclick = () => { c.step = 5; renderConsult(); };
}

/* ---- Step 5 签名归档 ---- */
function renderStep5(el, c) {
  const p = (c.scene === 'opd' ? OPD_PATIENTS : PATIENTS).find(x => x.id === c.patientId);
  const isOPD = c.scene === 'opd';
  const docs = CONSULT_DOCS[isOPD ? 'opd' : 'ipd'];
  const docMeta = docs.find(d => d.id === c.docType);
  const allArchived = docs.every(d => c.archivedDocs && c.archivedDocs[d.id]);
  if (allArchived) {
    el.innerHTML = `
      <div class="card" style="max-width:680px;margin:0 auto;text-align:center;padding:38px 30px">
        <div style="font-size:44px;line-height:1">✓</div>
        <h1 class="page-title" style="margin-top:14px">本次接诊完成</h1>
        <p class="page-desc" style="margin-top:8px">${esc(N(p))} · ${docs.map(d => d.label).join('、')} 已全部签名归档，记录已写入“我的操作记录”</p>
        <div class="mt-16" style="display:flex;gap:10px;justify-content:center">
          <button class="btn" id="btn-finish-profile">查看患者画像</button>
          <button class="btn primary" id="btn-finish-new">开始下一位接诊</button>
        </div>
      </div>`;
    el.querySelector('#btn-finish-profile').onclick = () => { state.profilePid = p.id; state.view = 'profile'; render(); };
    el.querySelector('#btn-finish-new').onclick = () => { newConsult(c.scene); state.view = 'consult'; render(); }; // 从完成态新建无需守卫
    return;
  }
  const F = (c.drafts && c.drafts[c.docType]) || [];
  const unresolved = F.filter(fd => fd.source === 'miss' && !fd.value.trim() && !fd.confirmedBlank);
  const edited = F.filter(fd => fd.edited).length;
  el.innerHTML = `
    <div class="archive-summary">
      <div class="card"><div class="card-head"><h3>归档前最后核对</h3></div><div class="card-body">
        <div class="kv" style="grid-template-columns:1fr 1fr">
          <div class="item"><div class="k">患者</div><div class="v">${esc(N(p))} · ${p.sex} · ${p.age}岁</div></div>
          <div class="item"><div class="k">文书类型</div><div class="v">${docMeta.label}${c.archivedDocs[c.docType] ? ' · 已归档✓' : ''}</div></div>
          <div class="item"><div class="k">字段统计</div><div class="v">共 ${F.length} 项 · 医师修改 ${edited} 项</div></div>
          <div class="item"><div class="k">转写引擎</div><div class="v">${esc(c.asrName)} · ${c.turns.length || 1} 句对话</div></div>
        </div>
        ${unresolved.length
          ? `<div class="qc-banner warn mt-10"><b>归档被质控拦截：</b>以下字段既无内容也未确认留空——<ul>${unresolved.map(u => `<li>${esc(u.label)}</li>`).join('')}</ul>请回到上一步处理（不臆造原则：宁缺毋造）。
             <button class="mini-btn warn" id="btn-goto-missing" style="margin-top:6px">→ 去处理缺失项（自动定位）</button></div>`
          : '<div class="qc-banner ok mt-10"><b>质控通过：</b>无未处理缺失项，可以归档。</div>'}
        ${docs.length > 1 ? `<div class="muted" style="font-size:12px;margin-top:8px">本次接诊共 ${docs.length} 类文书：${docs.map(d => `${d.label}${c.archivedDocs[d.id] ? '✓' : ''}`).join(' / ')}——切换“返回修改”中的文书页签可分别归档。</div>` : ''}
      </div></div>
      <div class="card"><div class="card-head"><h3>签名确认</h3></div><div class="card-body">
        <div class="sign-box">
          <div style="font-size:12px;color:var(--ink-soft);margin-bottom:8px">签名（输入姓名即视为确认本草稿全部内容并对其负责）</div>
          <input id="sign-input" placeholder="请输入医师姓名" value="${esc(state.doctor.name)}">
          <div class="sign-line">确认后系统将：① 生成 Markdown 病历文档；② 写入留痕审计日志；③ 按院内模板字段回填归档（演示环境模拟回填）。</div>
        </div>
        <div class="mt-16" style="display:flex;gap:10px">
          <button class="btn" id="btn-back4">← 返回修改</button>
          <button class="btn gold lg" id="btn-archive" ${unresolved.length ? 'disabled' : ''}>签名并归档</button>
        </div>
      </div></div>
    </div>`;
  el.querySelector('#btn-goto-missing')?.addEventListener('click', () => {
    c._gotoMissing = true;
    c.step = 4;
    renderConsult();
  });
  el.querySelector('#btn-back4').onclick = () => { c.step = 4; renderConsult(); };
  el.querySelector('#btn-archive').onclick = () => {
    const sign = el.querySelector('#sign-input').value.trim();
    if (!sign) { toast('请输入医师签名', 'err'); return; }
    doArchive(c, p, sign);
  };
}

function doArchive(c, p, sign) {
  const meta = { asrName: c.asrName, archiveId: 'AR' + Date.now().toString().slice(-8) };
  const isOPD = c.scene === 'opd';
  const docLabel = (CONSULT_DOCS[isOPD ? 'opd' : 'ipd'].find(d => d.id === c.docType) || {}).label;
  const F = (c.drafts && c.drafts[c.docType]) || [];
  const pOut = { ...p, name: N(p) };
  const md = isOPD
    ? buildOPMD({ patient: pOut, fields: F, doctor: { ...state.doctor, name: sign }, meta })
    : c.docType === 'fc'
      ? buildFCMD({ patient: pOut, fields: F, doctor: { ...state.doctor, name: sign }, meta })
      : c.docType === 'dc'
        ? buildDCMD({ patient: pOut, fields: F, doctor: { ...state.doctor, name: sign }, meta })
        : buildAdmissionMD({ patient: pOut, fields: F, doctor: { ...state.doctor, name: sign }, meta });
  const archTime = new Date().toLocaleString('zh-CN', { hour12: false });
  store.archives.unshift({ id: meta.archiveId, pid: p.id, pname: p.name, doctor: sign, time: archTime, md, type: isOPD ? 'opd' : c.docType, doc: docLabel });
  store.save();
  postArchive({ id: meta.archiveId, pid: p.id, pname: p.name, doctor: sign, time: archTime, doc: docLabel, type: isOPD ? 'opd' : c.docType, md });
  audit('签名归档', `${p.name} ${docLabel}已归档（批次 ${meta.archiveId}），签名：${sign}；MD 文档已生成`);
  c.archivedDocs[c.docType] = true;
  c.archived = true;
  openMDModal(`${docLabel} · ${N(p)}`, md, `${N(p)}_${docLabel}_${meta.archiveId}.md`);
  const allDone = Object.keys(c.archivedDocs).length >= (CONSULT_DOCS[isOPD ? 'opd' : 'ipd'].length);
  toast(allDone ? '本次接诊全部文书已归档' : '归档成功，可切换文书页签继续归档');
  render();
}

/* ---- MD 预览弹层 ---- */
function openMDModal(title, md, filename) {
  const mask = document.createElement('div');
  mask.className = 'modal-mask';
  mask.innerHTML = `<div class="modal">
    <div class="modal-head"><h3>${esc(title)} · Markdown 文档</h3><div class="x" data-x>×</div></div>
    <div class="modal-body"><div class="md-preview">${esc(md)}</div></div>
    <div class="modal-foot">
      <button class="btn" data-print>🖨 打印</button>
      <button class="btn" data-copy>复制内容</button>
      <button class="btn primary" data-dl>下载 .md 文件</button>
    </div>
  </div>`;
  document.body.appendChild(mask);
  mask.querySelector('[data-x]').onclick = () => mask.remove();
  mask.querySelector('[data-dl]').onclick = () => downloadMD(filename, md);
  mask.querySelector('[data-print]').onclick = () => {
    const iframe = document.createElement('iframe');
    iframe.style.display = 'none';
    document.body.appendChild(iframe);
    const d = iframe.contentDocument;
    const escMd = md.replace(/[&<>]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
    d.open();
    d.write('<html><head><title>' + filename + '</title></head><body style="font-family:SimSun,serif">' +
      '<pre style="font-size:13px;line-height:1.85;white-space:pre-wrap;font-family:inherit">' + escMd + '</pre></body></html>');
    d.close();
    iframe.contentWindow.focus();
    iframe.contentWindow.print();
    setTimeout(() => iframe.remove(), 2000);
  };
  mask.querySelector('[data-copy]').onclick = async () => {
    try { await navigator.clipboard.writeText(md); toast('已复制到剪贴板'); }
    catch { toast('复制失败，请手动选择复制', 'err'); }
  };
}

/* ================= 患者画像 ================= */
function renderProfile() {
  const p = PATIENTS.find(x => x.id === state.profilePid) || PATIENTS[0];
  state.profilePid = p.id;
  const archives = store.archives.filter(a => a.pid === p.id);
  const view = document.getElementById('view');
  view.innerHTML = `
    <h1 class="page-title">患者画像与病例报告</h1>
    <p class="page-desc">把患者历次住院的病历、检验、用药汇总成一页，接诊前看一眼即掌握全貌</p>
    <div class="engine-row gap-b">
      ${PATIENTS.map(x => `<span class="engine-chip ${x.id === p.id ? 'sel' : ''}" data-pp="${x.id}">${esc(N(x))} · ${esc(x.dxPreview)}</span>`).join('')}
    </div>
    ${p.allergies ? `<div class="alert-band">⚠ <b>过敏警示：</b>患者对「${esc((p.allergies.match(/对(.+?)过敏/) || [null, p.allergies])[1])}」过敏（跨住院文书核验一致）——开具相关医嘱时系统将强制提醒。</div>` : ''}
    ${(() => {
      /* 阳性判定（子句级）：关键词所在逗号子句（自上一个 ，。； 起）不含"无/否认/不"。
       * 处理列举式否定："无A、B、C史" 中 C 距"无"很远，6 字窗口会漏判。 */
      const positive = (text, kw) => {
        let i = text.indexOf(kw);
        while (i !== -1) {
          const head = text.lastIndexOf('，', i) !== -1 ? Math.max(text.lastIndexOf('，', i), text.lastIndexOf('。', i), text.lastIndexOf('；', i)) : Math.max(text.lastIndexOf('。', i), text.lastIndexOf('；', i));
          const seg = text.slice(head + 1, i);
          if (!/[无否认]/.test(seg)) return true;
          i = text.indexOf(kw, i + 1);
        }
        return false;
      };
      const past = p.record.past || '';
      const pts = [];
      if (positive(past, '高血压')) pts.push('高血压');
      if (positive(past, '糖尿病')) pts.push('糖尿病');
      if (positive(past, '脊髓炎')) pts.push('脊髓炎');
      if (positive(past, '泼尼松')) pts.push('长期服用醋酸泼尼松（激素）');
      if (positive(past, '脑血管病') || positive(past, '脑动脉供血不足')) pts.push('脑血管病史');
      /* 在用药品佐证（HIS 医嘱）：弥补自述遗漏，如病历写"无高血压史"但医嘱在用降压药 */
      const orderText = ((p.his || {}).orders || []).map(o => o.text).join('、');
      const antiHtn = orderText.match(/(氨氯地平|硝苯地平|缬沙坦|卡托普利|洛尔片?|氯沙坦)/);
      if (antiHtn) pts.push('在用降压药（' + antiHtn[1] + '）');
      const antiDb = orderText.match(/胰岛素|二甲双胍|格列[美奇]/);
      if (antiDb) pts.push('在用降糖药（' + antiDb[1] + '）');
      if ((p.admissions || []).some(a => /手术记录/.test((a.docs || []).join()))) pts.push('既往有手术史（见时间轴）');
      return pts.length ? `<div class="alert-band" style="background:var(--teal-soft);border-color:#a9cbc9;color:var(--teal-deep)">ℹ <b>接诊速览：</b>${pts.map(s => esc(s)).join('；')}——源自真实病案记录</div>` : '';
    })()}
    <div class="row">
      <div class="card col">
        <div class="card-head"><h3>就诊时间轴</h3><span class="hint">共 ${p.admissions.length} 次住院</span></div>
        <div class="card-body">
          <div class="timeline">
            ${p.admissions.map(a => `
              <div class="tl-item ${a.current ? 'current' : ''}">
                <div class="tl-date">${esc(a.date)} · ${esc(a.dept)}${a.current ? ' · <b style="color:var(--gold)">本次住院</b>' : ''}</div>
                <div class="tl-title">${esc(a.dx)}</div>
                <div class="tl-docs">${a.docs.map(d => `<span class="doc-chip">${esc(d)}</span>`).join('')}</div>
              </div>`).join('')}
          </div>
          <div class="divider-v" style="margin:14px 0"></div>
          <div style="font-size:13px;line-height:1.9">
            <b>本次住院概况</b><br>
            主诉：${esc(p.record.chief)}<br>
            初步诊断：${esc(p.record.diagnosis)}<br>
            生命体征：<span class="num-serif">T ${p.record.vitals.T}℃ · P ${p.record.vitals.P} · R ${p.record.vitals.R} · BP ${p.record.vitals.BP}mmHg</span>
          </div>
        </div>
      </div>
      <div class="card col">
        <div class="card-head"><h3>真实病案文书（原文）</h3><span class="hint">逐字取自院内 XML 病案 · data_records</span></div>
        <div class="card-body" id="docs-viewer"><div class="empty-hint">加载中…</div></div>
      </div>
      <div class="col">
        <div class="card">
          <div class="card-head"><h3>检验异常项（HIS 汇聚）</h3><span class="hint">本次住院</span></div>
          <div class="card-body"><div class="lab-strip">
            ${p.his.labs.map(l => `<span class="lab-chip">${esc(l.item)} <b class="flag-${l.flag}">${l.flag === 'H' ? '↑' : '↓'} ${esc(l.result)}</b> <small>${esc(l.unit)}（${esc(l.range)}）</small></span>`).join('')}
          </div></div>
        </div>
        <div class="card">
          <div class="card-head"><h3>在院医嘱（药品）</h3><span class="hint">蓝色 · HIS 带入</span></div>
          <div class="card-body">${p.his.orders.map(o => `<div style="font-size:13.2px;padding:6px 0;border-bottom:1px dashed #eee7d6"><b>${esc(o.text)}</b>　<span class="muted">${esc(o.dose)} ${esc(o.route)} ${esc(o.freq)}</span></div>`).join('') || '<div class="empty-hint">暂无</div>'}</div>
        </div>
        <div class="card">
          <div class="card-head"><h3>AI 归档病历</h3><span class="hint">${archives.length ? archives.length + ' 份' : '尚未生成'}</span></div>
          <div class="card-body">
            ${archives.length ? archives.map(a => `
              <div style="display:flex;align-items:center;gap:10px;padding:7px 0;border-bottom:1px dashed #eee7d6;font-size:13px">
                ${icons.file}<span><b>${esc(N({ name: a.pname }))} · ${a.doc || (a.type === 'opd' ? '门诊病历' : '入院记录')}</b><br><span class="muted" style="font-size:11.5px">${esc(a.time)} · 批次 ${esc(a.id)} · 医师 ${esc(a.doctor)}</span></span>
                <button class="mini-btn right" data-view-md="${a.id}">查看 MD</button>
              </div>`).join('') : '<div class="empty-hint">完成一次“接诊 → 归档”后在此查看 Markdown 病历</div>'}
            ${state.doctor.role === 'doctor' ? '<button class="btn gold mt-16" id="btn-start-consult" style="width:100%;justify-content:center">对此患者发起接诊（住院）</button>' : ''}
            <button class="btn primary mt-16" id="btn-profile-md" style="width:100%;justify-content:center">生成患者画像报告（MD）</button>
          </div>
        </div>
      </div>
    </div>`;
  view.querySelectorAll('[data-pp]').forEach(ch => ch.onclick = () => { state.profilePid = ch.dataset.pp; renderProfile(); });
  view.querySelectorAll('[data-view-md]').forEach(b => b.onclick = () => {
    const a = store.archives.find(x => x.id === b.dataset.viewMd);
    openMDModal(`已归档 · ${N({ name: a.pname })} 入院记录`, a.md, `${a.pname}_入院记录_${a.id}.md`);
  });
  const scBtn = view.querySelector('#btn-start-consult');
  if (scBtn) scBtn.onclick = () => {
    if (enterConsult(p.id, 'ipd')) toast('已进入 ' + N(p) + ' 的接诊流程');
  };
  loadDocViewer(view, p);
  view.querySelector('#btn-profile-md').onclick = () => {
    const md = buildProfileMD({ patient: { ...p, name: N(p) }, doctor: state.doctor, archiveLogs: store.logs });
    openMDModal(`患者画像报告 · ${N(p)}`, md, `${N(p)}_患者画像报告.md`);
    audit('画像报告', `生成 ${p.name} 患者画像与病例报告（MD）`);
  };
}


/* 真实病案文书原文查看器（data_records/<患者>.json，tools/export_records.py 生成） */
let _docsCache = {};
async function loadDocViewer(view, p) {
  const box = view.querySelector('#docs-viewer');
  if (!box) return;
  try {
    if (!_docsCache[p.name]) {
      const r = await fetch('data_records/' + encodeURIComponent(p.name) + '.json');
      if (!r.ok) throw new Error('HTTP ' + r.status);
      _docsCache[p.name] = await r.json();
    }
    const docs = _docsCache[p.name];
    const groups = {};
    docs.forEach(d => { (groups[d.doc] = groups[d.doc] || []).push(d); });
    box.innerHTML = Object.keys(groups).map(type => `
      <div style="margin-bottom:12px">
        <b style="font-size:13px">${esc(type)}</b> <span class="muted" style="font-size:11.5px">${groups[type].length} 份</span>
        <div style="margin-top:5px">${groups[type].map((d, i) => `
          <span class="doc-chip" data-docview="${esc(type)}|${i}" style="cursor:pointer">${esc(d.sub.replace(type, '') || d.date || d.file)}</span>`).join('')}</div>
      </div>`).join('');
    box.querySelectorAll('[data-docview]').forEach(ch => ch.onclick = () => {
      const [type, idx] = ch.dataset.docview.split('|');
      const d = groups[type][+idx];
      openMDModal(`真实病案 · ${N(p)} · ${d.sub}`, d.text, `${p.name}_${d.sub}.txt`);
      audit('查阅文书', `${N(p)} 真实病案原文：${d.sub}（${d.date || '无日期'}）`);
    });
  } catch (e) {
    box.innerHTML = '<div class="empty-hint">文书数据加载失败：' + esc(e.message) + '</div>';
  }
}

/* ================= 金标准评测（T8/T9，方案 2.3） ================= */
function renderGoldEval() {
  const view = document.getElementById('view');
  const ev = state.goldEval;
  view.innerHTML = `
    <h1 class="page-title">金标准评测（研发工具）</h1>
    <p class="page-desc">方案 2.3 验收方法：以医生真实书写的病案原文为"标准答案"，与系统生成的草稿逐字段比对，量化覆盖率/相似度/可用率——用于接入真实大模型前后的效果对比与迭代回归，不面向接诊流程</p>
    <div class="qc-banner warn gap-b"><b>当前评测口径（如实说明）：</b>待评测侧为<b>规则重组引擎</b>（确定性代码+模板，从真实病案事实程序化重组，无任何手写样本）；客观字段（体征/CT/诊断）与金标准同源引用，主观病史字段为模板改写。当前分数是规则引擎的基线——M2.1 替换为真实大模型后以同口径复测，届时指标才有采购验收意义。</div>
    <div class="row">
      <div class="card col">
        <div class="card-head"><h3>金标准案例</h3><span class="hint">字段值逐字取自院内 XML 病案</span></div>
        <div class="card-body">
          <div class="kv" style="grid-template-columns:1fr 1fr">
            <div class="item"><div class="k">案例</div><div class="v">${esc(N(GOLD_CASE))} · ${GOLD_CASE.sex} · ${GOLD_CASE.age}岁</div></div>
            <div class="item"><div class="k">住院时间</div><div class="v num-serif">${esc(GOLD_CASE.admittedAt)}</div></div>
            <div class="item"><div class="k">出院诊断</div><div class="v">${esc(GOLD_CASE.dxPreview)}</div></div>
            <div class="item"><div class="k">文书全集</div><div class="v">${GOLD_CASE.docCount} 份（完整住院病历）</div></div>
          </div>
          <div class="mt-10" style="font-size:12.5px;line-height:2">
            ${GOLD_CASE.docList.map(d => `<span class="doc-chip">${esc(d)}</span>`).join('')}
          </div>
          <div class="mt-16" style="display:flex;gap:10px">
            <button class="btn primary lg" id="btn-gold-run" ${ev && ev.running ? 'disabled' : ''}>${ev && ev.done ? '重新运行评测' : '运行规则重组引擎并评测'}</button>
            ${ev && ev.done ? '<button class="btn gold" id="btn-gold-md">导出评测报告（MD）</button>' : ''}
          </div>
        </div>
      </div>
      <div class="card col">
        <div class="card-head"><h3>ASR 选型测试准备（T9）</h3><span class="hint">方案 4.2 · 引擎可替换</span></div>
        <div class="card-body">
          <div style="font-size:13px;line-height:1.9">
            ${ASR_TESTSET.audios.map(a => `<div style="display:flex;gap:9px;align-items:center;padding:6px 0;border-bottom:1px dashed #eee7d6">${icons.file}<span><b>门诊录音 ${esc(a.file)}</b> <span class="muted" style="font-size:11.5px">配对截图 ${esc(a.photo)}</span><br><span class="muted" style="font-size:12px">${esc(a.note)}</span></span></div>`).join('')}
          </div>
          <div class="mt-10" style="font-size:12.5px;color:var(--ink-soft);line-height:1.8">比选维度：${ASR_TESTSET.dimensions.map(d => esc(d)).join('；')}</div>
          <div class="mt-10" style="font-size:12px;color:var(--ink-soft)">音频源：${esc(ASR_TESTSET.source)}</div>
          <div class="engine-row mt-10">
            ${ASR_ENGINES.map(e => `<span class="engine-chip ${engineReady(e.id) ? '' : 'off'}">${esc(e.name)}${engineReady(e.id) ? ' · 就绪' : ' · 待Key'}</span>`).join('')}
          </div>
        </div>
      </div>
    </div>
    <div id="gold-result" class="mt-16">${ev && ev.done ? goldResultHTML(ev) : (ev && ev.running ? goldRunningHTML(ev) : '<div class="card"><div class="card-body empty-hint" style="line-height:2.2">点击"运行规则重组引擎并评测"：系统以真实病案结构化事实为素材生成三类文书草稿，与医生真实书写版本（金标准，逐字取自院内 XML 病案）逐字段比对。<br>金标准 = 本案医生的原文（真实）；待评测侧 = 规则重组引擎（M2.1 后为真实大模型）。</div></div>')}</div>`;
  bindGoldEval(view);
}

function goldRunningHTML(ev) {
  return `<div class="card"><div class="card-head"><h3>六智能体流水线执行中…</h3>
    <button class="btn ghost right" id="btn-gold-skip">快进（跳过演示动画）</button></div><div class="card-body pipe">
    ${AGENTS.map((a, i) => {
      const st = ev.steps[i];
      return `<div class="agent-row ${st ? 'done' : (i === ev.steps.length ? 'active' : 'pending')}">
        <div class="agent-node">${st ? '✓' : i + 1}</div>
        <div><div class="a-name">${esc(a.name)}</div><div class="a-role">${esc(a.role)}</div>
        ${st ? `<div class="agent-out"><div class="sum">${esc(st.summary)}</div></div>` : ''}</div>
      </div>`;
    }).join('')}
  </div></div>`;
}

const GOLD_DOCS = [
  { id: 'adm', label: '入院记录', metric: '与院内模板对应' },
  { id: 'fc', label: '首次病程记录', metric: 'T10 · 多源汇聚生成' },
  { id: 'dc', label: '出院记录', metric: 'T11 · 全程数据汇总' },
];

function goldResultHTML(ev) {
  const docType = ev.docType || 'adm';
  const { rows, metrics } = ev.results[docType];
  const docMeta = GOLD_DOCS.find(d => d.id === docType);
  const pill = cls => ({ dlg: ['dlg', '一致'], his: ['his', '基本一致'], miss: ['miss', '偏差/缺失'], norm: ['norm', '金标准缺项'] }[cls] || ['norm', '—']);
  return `
    <div class="engine-row gap-b">
      ${GOLD_DOCS.map(d => `<span class="engine-chip ${docType === d.id ? 'sel' : ''}" data-gdoc="${d.id}">${d.label} · ${(ev.results[d.id].metrics.usableRate * 100).toFixed(0)}%可用</span>`).join('')}
    </div>
    <div class="stat-grid">
      <div class="stat"><div class="num">${(metrics.coverage * 100).toFixed(0)}%</div><div class="lbl">字段覆盖率（${metrics.covered}/${metrics.total}）</div><div class="trend">AI有内容∩金标准有内容</div></div>
      <div class="stat"><div class="num">${(metrics.avgSim * 100).toFixed(0)}%</div><div class="lbl">平均相似度（bigram F1）</div><div class="trend">已覆盖字段</div></div>
      <div class="stat"><div class="num">${(metrics.usableRate * 100).toFixed(0)}%</div><div class="lbl">可用率（一致+基本一致）</div><div class="trend">对应"确认修改为主"</div></div>
      <div class="stat"><div class="num">${rows.length}</div><div class="lbl">比对字段数（${docMeta.label}）</div><div class="trend">${docMeta.metric}</div></div>
    </div>
    <div class="card">
      <div class="card-head"><h3>${docMeta.label} · 逐字段比对</h3><span class="hint">AI 草稿 vs 医生金标准</span>
        <button class="btn right" id="btn-gold-md2">导出评测报告（MD）</button></div>
      <div class="card-body" style="padding-top:10px">
        ${rows.map(r => {
          const [pc, pl] = pill(r.cls);
          return `<div class="g-row">
            <div class="g-head">
              <b>${esc(r.label)}</b>
              <span class="pill ${pc}"><span class="dot"></span>${pl}</span>
              <span class="conf num-serif">${(r.sim * 100).toFixed(0)}%</span>
              ${r.edited ? '<span class="edited-badge">医师已修改</span>' : ''}
            </div>
            <div class="g-cols">
              <div class="g-ai"><span class="g-tag">AI 草稿</span>${r.ai ? esc(r.ai) : '<i class="muted">（空）</i>'}</div>
              <div class="g-gold"><span class="g-tag gold">金标准</span>${r.gold ? esc(r.gold) : '<i class="muted">（金标准缺项）</i>'}</div>
            </div>
          </div>`;
        }).join('')}
      </div>
    </div>`;
}

function bindGoldEval(view) {
  const runBtn = view.querySelector('#btn-gold-run');
  if (runBtn) runBtn.onclick = () => {
    state.goldEval = { running: true, steps: [], done: false, results: null, docType: 'adm', handle: null };
    audit('金标准评测', `启动${llmGenActive() ? '大模型' : '规则重组引擎'}评测：${N(GOLD_CASE)} ${GOLD_CASE.admittedAt.slice(0, 10)} 三类文书`);
    renderGoldEval();
    const p = GOLD_CASE;
    state.goldEval.handle = runPipeline(p, {
      onStep(agent, output, i) {
        state.goldEval.steps[i] = output;
        renderGoldEval();
      },
      onDone(ctx) {
        const results = {
          adm: evaluateAgainstGold(ctx.generate.fields, p.gold),
          fc: evaluateAgainstGold(ctx.generateFC.fields, p.goldFC),
          dc: evaluateAgainstGold(ctx.generateDC.fields, p.goldDC),
        };
        state.goldEval = { running: false, steps: state.goldEval.steps, done: true, results, docType: 'adm', handle: null };
        const rate = k => (results[k].metrics.usableRate * 100).toFixed(0);
        audit('评测完成', `${ctx.genEngine === 'llm' ? '大模型' : '规则引擎'}口径：入院 ${rate('adm')}% · 首次病程 ${rate('fc')}% · 出院 ${rate('dc')}% 可用率`);
        renderGoldEval();
        toast('三类文书评测完成');
      },
    });
  };
  const skipBtn = view.querySelector('#btn-gold-skip');
  if (skipBtn) skipBtn.onclick = () => {
    if (state.goldEval && state.goldEval.handle) state.goldEval.handle.skipAll();
  };
  view.querySelectorAll('[data-gdoc]').forEach(ch => ch.onclick = () => {
    state.goldEval.docType = ch.dataset.gdoc;
    renderGoldEval();
  });
  const mdBtns = view.querySelectorAll('#btn-gold-md, #btn-gold-md2');
  mdBtns.forEach(b => b.onclick = () => {
    const ev = state.goldEval;
    if (!ev || !ev.done) return;
    const docLabel = GOLD_DOCS.find(d => d.id === (ev.docType || 'adm')).label;
    const md = buildEvalMD({ patient: { ...GOLD_CASE, name: N(GOLD_CASE) }, result: ev.results[ev.docType || 'adm'], doctor: state.doctor, docLabel });
    openMDModal(`金标准评测报告 · ${N(GOLD_CASE)} · ${docLabel}`, md, `金标准评测报告_${N(GOLD_CASE)}_${docLabel}.md`);
    audit('评测报告', `导出 ${GOLD_CASE.name} ${docLabel} 评测报告（MD）`);
  });
}


/* ================= 系统设置（T15 + M2.0 服务端模式） ================= */
function renderSettings() {
  const view = document.getElementById('view');
  const cfg = getConfig();
  const srv = cfg._srv || {};
  const srvChip = serverState.online
    ? `<span class="pill dlg"><span class="dot"></span>服务端在线 · 留痕/归档入库 ${serverState.info && serverState.info.db && serverState.info.db.backend === 'mysql' ? 'MySQL' : 'SQLite'} · 密钥仅存服务器</span>`
    : '<span class="pill miss"><span class="dot"></span>服务端离线 · 本机演示模式（密钥暂存本机浏览器）</span>';
  view.innerHTML = `
    <h1 class="page-title">系统设置</h1>
    <p class="page-desc">M2 接入配置台（docs/M2构建规划.md S1/S3）：密钥经服务端 /api/config 存储，浏览器不落明文</p>
    <div class="legend gap-b">${srvChip}</div>
    <div class="row">
      <div class="card col">
        <div class="card-head"><h3>① 方言语音识别（ASR）引擎</h3><span class="hint">方案 4.2 · 配置即就绪</span></div>
        <div class="card-body">
          <div class="engine-row">
            ${ASR_ENGINES.map(e => `<span class="engine-chip ${cfg.asr.engine === e.id ? 'sel' : ''}" data-cfg-eng="${e.id}">${esc(e.name)}${engineReady(e.id) ? ' · 就绪' : ' · 未配置'}</span>`).join('')}
          </div>
          <div id="asr-forms">
            <div class="form-grid" data-form="iflytek" style="${cfg.asr.engine === 'iflytek' ? '' : 'display:none'}">
              <label>AppID</label><input id="ifly-appid" value="${esc(srv.iflytek?.appId || '')}" placeholder="讯飞开放平台 AppID">
              <label>APIKey</label><input id="ifly-apikey" value="" placeholder="${srv.iflytek?.hasKey ? '已配置（仅存服务器，留空保持不变）' : 'APIKey'}" type="password">
              <label>APISecret</label><input id="ifly-secret" value="" placeholder="${srv.iflytek?.hasSecret ? '已配置（仅存服务器，留空保持不变）' : 'APISecret'}" type="password">
            </div>
            <div class="form-grid" data-form="aliyun" style="${cfg.asr.engine === 'aliyun' ? '' : 'display:none'}">
              <label>AppKey</label><input id="ali-appkey" value="${esc(srv.aliyun?.appKey || '')}" placeholder="智能语音交互 AppKey">
              <label>APIKey</label><input id="ali-apikey" value="" placeholder="${srv.aliyun?.hasKey ? '已配置（仅存服务器，留空保持不变）' : 'AccessKey/Token'}" type="password">
            </div>
            <div class="form-grid" data-form="demo" style="${cfg.asr.engine === 'demo' ? '' : 'display:none'}">
              <div class="muted" style="font-size:12.5px;line-height:1.8">演示引擎无需配置。选中讯飞/阿里并保存密钥后，接诊录音页对应引擎芯片立即"就绪"。</div>
            </div>
            <div class="form-grid" data-form="webspeech" style="${cfg.asr.engine === 'webspeech' ? '' : 'display:none'}">
              <div class="muted" style="font-size:12.5px;line-height:1.8">浏览器引擎无需配置（Chrome 下可用，识别普通话）。方言对照轨需正式云端引擎。</div>
            </div>
          </div>
          <div class="mt-16"><button class="btn primary" id="btn-save-asr">保存 ASR 配置${serverState.online ? '（至服务端）' : ''}</button></div>
        </div>
      </div>
      <div class="col">
        <div class="card">
          <div class="card-head"><h3>② 大模型 API（OpenAI 兼容）</h3><span class="hint">生成智能体过渡接入（问题 #2）</span></div>
          <div class="card-body">
            <div class="form-grid">
              <label>Base URL</label><input id="llm-url" value="${esc(srv.llm?.baseUrl || cfg.llm.baseUrl || '')}" placeholder="https://…/v1（OpenAI 兼容）">
              <label>API Key</label><input id="llm-key" value="" placeholder="${srv.llm?.hasKey ? '已配置（仅存服务器，留空保持不变）' : 'sk-…'}" type="password">
              <label>Model</label><input id="llm-model" value="${esc(srv.llm?.model || cfg.llm.model || '')}" placeholder="模型名（如 qwen-plus / glm-4）">
            </div>
            <div class="mt-16" style="display:flex;gap:10px;align-items:center;flex-wrap:wrap">
              <button class="btn primary" id="btn-save-llm">保存大模型配置${serverState.online ? '（至服务端）' : ''}</button>
              <button class="btn" id="btn-test-llm">测试连接${serverState.online ? '（服务端代理）' : '（本机直连）'}</button>
              <span id="llm-test-result" style="font-size:12.5px"></span>
            </div>
            <div class="engine-row mt-10">
              <span class="engine-chip ${llmGenMode() === 'auto' ? 'sel' : ''}" data-gen="auto">生成引擎：自动（大模型就绪即启用）</span>
              <span class="engine-chip ${llmGenMode() === 'rules' ? 'sel' : ''}" data-gen="rules">生成引擎：规则演示（强制）</span>
              <span id="gen-status" class="muted" style="font-size:12px"></span>
            </div>
            <div class="muted mt-10" style="font-size:12px;line-height:1.8">测试经 ${serverState.online ? '服务端 /api/llm/test 代理（无 CORS 限制）' : '浏览器直连 /models'}。"自动"模式下，服务端大模型配置就绪后生成智能体即刻切换为大模型草稿（按字段书写要求 + JSON 结构化输出），任何失败自动回落规则引擎，不阻断接诊；金标准评测同口径复测。</div>
          </div>
        </div>
        <div class="card">
          <div class="card-head"><h3>③ 数据与合规</h3></div>
          <div class="card-body">
            <div style="display:flex;gap:10px;flex-wrap:wrap">
              <button class="btn ${state.mask ? 'primary' : ''}" id="btn-mask2">${state.mask ? '脱敏：开（点击关闭）' : '脱敏：关（点击开启）'}</button>
              <button class="btn danger-outline" id="btn-clear-demo">清空演示归档与留痕</button>
            </div>
            <div class="muted mt-10" style="font-size:12px;line-height:1.8">脱敏开启后所有界面与 MD 导出的患者姓名显示为化名。${serverState.online ? `清空将同时清除服务端 ${serverState.info && serverState.info.db && serverState.info.db.backend === 'mysql' ? 'MySQL' : 'SQLite'} 中的演示数据。` : ''}</div>
          </div>
        </div>
        <div class="card">
          <div class="card-head"><h3>④ 接入自检</h3><span class="hint">外部资源登记后一键体检（对应 docs/接入准备清单.md）</span></div>
          <div class="card-body">
            <div style="display:flex;gap:10px;flex-wrap:wrap;align-items:center">
              <button class="btn primary" id="btn-preflight">运行自检</button>
              <span class="muted" style="font-size:12px">检查 BFF / 数据库 / ASR 密钥（真实签名请求）/ 大模型（真实连通测试）/ 数据层完整性</span>
            </div>
            <div id="preflight-out" class="mt-10" style="font-size:13px;line-height:2.1"></div>
          </div>
        </div>
      </div>
    </div>`;
  bindSettings(view, cfg);
}

function bindSettings(view, cfg) {
  /* 生成引擎偏好（本机偏好项，非密钥）：auto=大模型就绪即启用 / rules=强制规则演示 */
  const genStatus = () => {
    const el = view.querySelector('#gen-status');
    if (!el) return;
    el.textContent = llmGenMode() === 'rules'
      ? '当前生效：规则引擎（演示）'
      : (llmServerReady() ? '当前生效：大模型草稿（服务端已配置，失败自动回落规则）' : '当前生效：规则引擎（服务端大模型未配置，登记后自动启用）');
  };
  view.querySelectorAll('[data-gen]').forEach(ch => ch.onclick = () => {
    cfg.gen = ch.dataset.gen;
    saveConfig(cfg);
    view.querySelectorAll('[data-gen]').forEach(x => x.classList.toggle('sel', x.dataset.gen === cfg.gen));
    genStatus();
    audit('系统设置', '生成引擎切换为' + (cfg.gen === 'rules' ? '规则演示（强制）' : '自动（大模型就绪即启用）'));
  });
  genStatus();

  /* 接入自检（docs/接入准备清单.md 的机检面）：每项真实探测，未登记项显示"待交付"而非失败 */
  const pfBtn = view.querySelector('#btn-preflight');
  if (pfBtn) pfBtn.onclick = async () => {
    const out = view.querySelector('#preflight-out');
    pfBtn.disabled = true;
    out.innerHTML = '<span class="muted">自检中…</span>';
    const row = (ok, label, note) => `<div><span class="pill ${ok === true ? 'dlg' : ok === false ? 'miss' : 'norm'}"><span class="dot"></span>${ok === true ? '通过' : ok === false ? '异常' : '待交付'}</span> <b>${label}</b> <span class="muted" style="font-size:12px">${note}</span></div>`;
    const lines = [];
    // 1) BFF + 数据库
    try {
      const h = await fetch('/api/health').then(r => r.json());
      const db = h.db || {};
      lines.push(row(true, 'BFF 服务端', `在线 · ${h.server || ''}`));
      lines.push(row(!!db, '数据库后端', db.backend === 'mysql' ? `MySQL → ${db.host}/${db.database}` : `SQLite → data_server/${db.file || 'medagent.db'}（单文件可迁移）`));
      // 2) ASR 讯飞（已登记才做真实签名请求）
      if (h.iflytek && h.iflytek.hasKey && h.iflytek.hasSecret) {
        try {
          const s = await fetch('/api/asr/sign', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ engine: 'iflytek' }) }).then(r => r.json());
          lines.push(row(!!s.signature, 'ASR · 科大讯飞（rtasr）', s.signature ? '签名服务端计算成功，通道就绪（录音页真实 WS 转写）' : '签名失败：' + (s.error || '未知')));
        } catch (e) { lines.push(row(false, 'ASR · 科大讯飞（rtasr）', '签名请求异常：' + e.message)); }
      } else {
        lines.push(row(null, 'ASR · 科大讯飞（rtasr）', '密钥未登记（docs/接入准备清单.md 第一节）'));
      }
      lines.push(row(null, 'ASR · 阿里云（备选比对）', h.aliyun && h.aliyun.hasKey ? '密钥已登记，Token 流程 M2.1 挂接' : '密钥未登记'));
      // 3) 大模型（已登记才做真实连通测试）
      if (h.llm && h.llm.hasKey) {
        const t = await serverLLMTest();
        lines.push(row(!!t.ok, '大模型（OpenAI 兼容）', t.ok ? '服务端代理连通成功，生成引擎自动生效' : (t.msg || t.error || '连通失败')));
      } else {
        lines.push(row(null, '大模型（OpenAI 兼容）', '密钥未登记（docs/接入准备清单.md 第二节）'));
      }
    } catch (e) {
      lines.push(row(false, 'BFF 服务端', '离线：' + e.message + '（bash start.sh 启动）'));
    }
    // 4) 数据层完整性（真实取数）
    try {
      const n = PATIENTS.length, m = OPD_PATIENTS.length;
      const rec = await fetch('/data_records/' + encodeURIComponent(PATIENTS[0].name) + '.json').then(r => r.json());
      lines.push(row(Array.isArray(rec) && rec.length > 0, '数据层', `住院患者 ${n} 位 · 门诊 ${m} 例 · ${PATIENTS[0].name} 病案文书 ${Array.isArray(rec) ? rec.length : 0} 份（data_records 真实原文）`));
    } catch (e) {
      lines.push(row(false, '数据层', 'data_records 读取失败：' + e.message));
    }
    out.innerHTML = lines.join('');
    pfBtn.disabled = false;
    audit('接入自检', '运行接入自检（' + lines.length + ' 项）');
  };

  view.querySelectorAll('[data-cfg-eng]').forEach(ch => ch.onclick = () => {
    cfg.asr.engine = ch.dataset.cfgEng;
    view.querySelectorAll('[data-form]').forEach(f => { f.style.display = f.dataset.form === cfg.asr.engine ? '' : 'none'; });
    view.querySelectorAll('[data-cfg-eng]').forEach(x => x.classList.toggle('sel', x.dataset.cfgEng === cfg.asr.engine));
  });

  view.querySelector('#btn-save-asr').onclick = async () => {
    const payload = { asr: { engine: cfg.asr.engine } };
    const appId = view.querySelector('#ifly-appid')?.value.trim();
    const apiKey = view.querySelector('#ifly-apikey')?.value.trim();
    const secret = view.querySelector('#ifly-secret')?.value.trim();
    if (appId || apiKey || secret) payload.asr.iflytek = {};
    if (appId) payload.asr.iflytek.appId = appId;
    if (apiKey) payload.asr.iflytek.apiKey = apiKey;
    if (secret) payload.asr.iflytek.apiSecret = secret;
    const aliAppKey = view.querySelector('#ali-appkey')?.value.trim();
    const aliKey = view.querySelector('#ali-apikey')?.value.trim();
    if (aliAppKey || aliKey) payload.asr.aliyun = {};
    if (aliAppKey) payload.asr.aliyun.appKey = aliAppKey;
    if (aliKey) payload.asr.aliyun.apiKey = aliKey;

    if (serverState.online) {
      const st = await postConfig(payload);
      if (st && st.iflytek) {
        adoptServerStatus({ ...serverState.info, ...st });
        audit('系统设置', 'ASR 配置已保存至服务端（密钥不落浏览器）');
        toast('已保存到服务端，引擎状态已更新');
        renderSettings();
        return;
      }
    }
    /* 服务端离线：本机兜底（密钥暂存浏览器，界面已明示） */
    const c = getConfig();
    if (payload.asr.iflytek) Object.assign(c.asr.iflytek, payload.asr.iflytek);
    if (payload.asr.aliyun) Object.assign(c.asr.aliyun, payload.asr.aliyun);
    saveConfig(c);
    audit('系统设置', 'ASR 配置已保存（本机模式）');
    toast('已保存（本机模式）');
    renderSettings();
  };

  view.querySelector('#btn-save-llm').onclick = async () => {
    const payload = { llm: {} };
    const url = view.querySelector('#llm-url').value.trim();
    const key = view.querySelector('#llm-key').value.trim();
    const model = view.querySelector('#llm-model').value.trim();
    if (url) payload.llm.baseUrl = url;
    if (key) payload.llm.apiKey = key;
    if (model) payload.llm.model = model;
    if (serverState.online) {
      const st = await postConfig(payload);
      if (st && st.llm) {
        adoptServerStatus({ ...serverState.info, ...st });
        audit('系统设置', '大模型配置已保存至服务端');
        toast('已保存到服务端');
        renderSettings();
        return;
      }
    }
    const c = getConfig();
    Object.assign(c.llm, payload.llm);
    saveConfig(c);
    audit('系统设置', '大模型配置已保存（本机模式）');
    toast('已保存（本机模式）');
    renderSettings();
  };

  view.querySelector('#btn-test-llm').onclick = async () => {
    const el = view.querySelector('#llm-test-result');
    el.textContent = '测试中…';
    el.style.color = '';
    let r;
    if (serverState.online) {
      r = await serverLLMTest();
    } else {
      const c = getConfig();
      c.llm.baseUrl = view.querySelector('#llm-url').value.trim();
      const k = view.querySelector('#llm-key').value.trim();
      if (k) c.llm.apiKey = k;
      c.llm.model = view.querySelector('#llm-model').value.trim();
      saveConfig(c);
      r = await testLLM();
    }
    el.textContent = r.msg || (r.ok ? '连接成功' : '连接失败');
    el.style.color = r.ok ? 'var(--c-dlg)' : 'var(--danger)';
    audit('系统设置', '大模型连通性测试（' + (serverState.online ? '服务端代理' : '本机直连') + '）：' + (r.ok ? '成功' : '失败') + ' — ' + (r.msg || r.error || ''));
  };

  view.querySelector('#btn-mask2').onclick = () => {
    state.mask = !state.mask;
    localStorage.setItem('medagent_mask', state.mask ? '1' : '0');
    audit('系统设置', '脱敏开关：' + (state.mask ? '开' : '关'));
    render();
    toast(state.mask ? '已开启脱敏' : '已关闭脱敏');
  };

  view.querySelector('#btn-clear-demo').onclick = async () => {
    store.logs = []; store.archives = []; store.save();
    if (serverState.online) {
      try { await fetch('/api/demo/clear', { method: 'POST' }); } catch (_) { /* 静默 */ }
    }
    audit('系统设置', '演示归档与留痕已清空' + (serverState.online ? '（含服务端）' : ''));
    toast('演示数据已清空');
    render();
  };
}

/* ================= 留痕审计（管理端可筛选；医生端为"我的操作记录"） ================= */
function renderAudit() {
  const view = document.getElementById('view');
  const isAdmin = state.doctor.role === 'admin';
  const f = state.auditFilter || { doctor: '', action: '' };
  const allDoctors = [...new Set(store.logs.map(l => l.doctor).filter(Boolean))];
  const allActions = [...new Set(store.logs.map(l => l.action).filter(Boolean))];
  const rows = store.logs.filter(l =>
    (!f.doctor || l.doctor === f.doctor) && (!f.action || l.action === f.action));

  view.innerHTML = `
    <h1 class="page-title">${isAdmin ? '留痕与审计' : '我的操作记录'}</h1>
    <p class="page-desc">${isAdmin
      ? '生成、修改、确认、归档全程留痕，可按医师与操作类型检索（正式版写入院内审计库）'
      : '您的每一步操作都会自动记录，用于医疗质量追溯'}</p>
    <div class="card">
      <div class="card-head"><h3>操作日志</h3><span class="hint">${rows.length} 条 · 最新在前</span>
        ${isAdmin ? `
          <select id="f-doctor" class="mini-select"><option value="">全部医师</option>${allDoctors.map(d => `<option ${f.doctor === d ? 'selected' : ''}>${esc(d)}</option>`).join('')}</select>
          <select id="f-action" class="mini-select"><option value="">全部操作</option>${allActions.map(a => `<option ${f.action === a ? 'selected' : ''}>${esc(a)}</option>`).join('')}</select>
          <button class="mini-btn right" id="btn-clear">清空演示日志</button>`
        : ''}
      </div>
      <table class="audit-table">
        <thead><tr><th style="width:170px">时间</th><th style="width:110px">操作</th><th>详情</th><th style="width:90px">医师</th></tr></thead>
        <tbody>
          ${rows.length ? rows.map(l => `
            <tr><td class="num-serif">${esc(l.time)}</td><td class="act">${esc(l.action)}</td><td>${esc(l.detail)}</td><td>${esc(l.doctor)}</td></tr>`).join('')
            : '<tr><td colspan="4"><div class="empty-hint">暂无留痕记录</div></td></tr>'}
        </tbody>
      </table>
    </div>`;
  if (isAdmin) {
    view.querySelector('#f-doctor').onchange = e => { state.auditFilter = { ...f, doctor: e.target.value }; renderAudit(); };
    view.querySelector('#f-action').onchange = e => { state.auditFilter = { ...f, action: e.target.value }; renderAudit(); };
    view.querySelector('#btn-clear').onclick = () => {
      store.logs = []; store.archives = []; store.save();
      fetch('/api/demo/clear', { method: 'POST' }).catch(() => {});
      toast('演示日志已清空');
      render();
    };
  }
}

/* ---------- 启动 ---------- */
if (state.bigFont) document.body.classList.add('large-font');
bootSync().then(() => {
  if (serverState.online) adoptServerStatus(serverState.info);
  // 服务端合并结果回灌内存 store（store 在模块加载时已从 localStorage 快照）
  store.logs = JSON.parse(localStorage.getItem('medagent_logs') || '[]');
  store.archives = JSON.parse(localStorage.getItem('medagent_archives') || '[]');
  restoreConsult();
  render();
});
