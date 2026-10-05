#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
build_data.py — 从医院真实数据（病案 XML + HIS xls + 门诊截图转录）程序化生成 js/data.js。
真实口径：字段值逐字取自院内数据；不生成任何对话/转写脚本（待真实 ASR 接入后填充）。
可重复执行；修改解析逻辑后重跑即可。用法：/usr/bin/python3 tools/build_data.py
"""
import datetime, glob, io, json, os, re, sys, zipfile
import xml.etree.ElementTree as ET
import xlrd

BASE = os.path.dirname(os.path.abspath(__file__))
SRC = os.path.abspath(os.path.join(BASE, '..', '..', '病历资料', '住院'))
OUT = os.path.abspath(os.path.join(BASE, '..', 'js', 'data.js'))
XSI = '{http://www.w3.org/2001/XMLSchema-instance}type'


def xd(v):
    try:
        return datetime.datetime(1899, 12, 30) + datetime.timedelta(days=float(v)) if v else None
    except Exception:
        return None


def collapse(s):
    return re.sub(r'\s+', '', s or '')


def xml_parts(raw):
    try:
        root = ET.fromstring(raw)
    except Exception:
        return []
    parts = []
    for el in root.iter('Element'):
        if el.get(XSI) == 'XString':
            t = el.findtext('Text')
            if t and t.strip():
                parts.append(t.strip())
    return parts


def read_zip_admission(zpath):
    """读取 zip 内标准入院记录 → (文件日期, 字段dict, 全部文书类型清单)"""
    docs_labels = set()
    adm = None
    adm_date = ''
    with zipfile.ZipFile(zpath) as z:
        for info in z.infolist():
            try:
                name = info.filename.encode('cp437').decode('gbk')
            except Exception:
                name = info.filename
            if not name.endswith('.xml'):
                continue
            label = classify_doc(name)
            docs_labels.add(label)
            m = re.search(r'(20\d{6})', name)
            if m and (not adm_date or m.group(1) < adm_date):
                adm_date = m.group(1)
            if adm is None and '入院记录' in name and '产科' not in name:
                raw = z.read(info)
                adm = parse_admission(xml_parts(raw))
            elif adm is None and '入院记录' in name and '产科' in name:
                m0 = re.search(r'(20\d{6})', name)
                if m0 and (not adm_date or m0.group(1) < adm_date):
                    adm_date = m0.group(1)
    return adm_date, adm, docs_labels


def classify_doc(name):
    for key, label in (('入院记录', '入院记录'), ('出院记录', '出院记录'), ('手术记录', '手术记录'),
                       ('首次病程', '首次病程记录'), ('术前小结', '术前小结'), ('查房', '查房记录'),
                       ('用药记录', '用药记录'), ('日常病程', '日常病程'), ('TIA', '日常病程'),
                       ('知情', '知情文件'), ('评估', '评估文件')):
        if key in name:
            return label
    return '其他文书'


HEADER_LABELS = ['姓名：', '性别：', '年龄：', '婚姻：', '职业：', '出生地：', '民族：',
                 '入院时间：', '记录时间：', '病史陈述者：', '病案号：']


def parse_admission(parts):
    t = '\n'.join(parts)
    f = {}

    def grab(label, nxt=None):
        i = t.find(label)
        if i < 0:
            return ''
        seg = t[i + len(label):]
        if nxt:
            j = seg.find(nxt)
            if j >= 0:
                seg = seg[:j]
        return collapse(seg)

    def header(label):
        """头部字段：值以下一个已知头部标签为界（防吞整篇文档）"""
        positions = []
        for lab in HEADER_LABELS:
            p = t.find(lab)
            if p >= 0:
                positions.append((p, lab))
        positions.sort()
        for idx, (p, lab) in enumerate(positions):
            if lab == label:
                start = p + len(lab)
                end = positions[idx + 1][0] if idx + 1 < len(positions) else len(t)
                return re.sub(r'\s+', ' ', t[start:end]).strip()
        return ''

    f['chief'] = grab('主诉：', '现病史：')
    f['present'] = grab('现病史：', '既往史：')
    past = grab('既往史：', '个人史：')
    f['past'] = past
    m = re.search(r'对(海鲜、花粉|[^，。]{1,12})过敏', past)
    f['allergy'] = ('对' + m.group(1) + '过敏') if m else ''
    f['personal'] = grab('个人史：', '婚育史：')
    f['marriage'] = grab('婚育史：', '家族史：')
    f['family'] = grab('家族史：', '体    格    检    查')
    body = grab('体    格    检    查', '专科情况：')
    f['specialty'] = grab('专科情况：', '辅    助    检    查')
    f['auxiliary'] = grab('辅    助    检    查', '初步诊断：')
    dx = grab('初步诊断：')
    f['diagnosis'] = re.sub(r'第.*页$', '', dx)
    vm = re.search(r'T：\s*([\d.]+)\s*P：\s*(\d+)\s*R：\s*(\d+)\s*Bp：\s*(\d+)\s*/\s*(\d+)', body)
    f['vitals'] = {'T': vm.group(1), 'P': vm.group(2), 'R': vm.group(3), 'BP': vm.group(4) + '/' + vm.group(5)} if vm else None
    f['name'] = header('姓名：')
    f['sex'] = header('性别：')
    mage = re.search(r'(\d+)岁', header('年龄：'))
    f['age'] = int(mage.group(1)) if mage else 0
    f['marriage'] = header('婚姻：')
    f['job'] = header('职业：')
    f['birthplace'] = header('出生地：')
    f['nation'] = header('民族：')
    at = header('入院时间：')
    mAt = re.search(r'(\d{4}-\d{2}-\d{2})(\d{2}:\d{2})', at.replace(' ', ''))
    f['admittedAt'] = (mAt.group(1) + ' ' + mAt.group(2)) if mAt else at
    mno = re.search(r'病案号[:：]\s*\n?(\d{6,})', t)
    f['pid'] = mno.group(1) if mno else ''
    mvis = re.search(r'第\s*(\d+)\s*次住院', t)
    f['visitNo'] = int(mvis.group(1)) if mvis else 1
    return f


def load_xls(patient, adm_date):
    """当前住院窗口内的检验异常与药嘱（真实 HIS 导出）"""
    pdir = os.path.join(SRC, patient)
    labs, orders = [], []
    try:
        sh = xlrd.open_workbook(os.path.join(pdir, '检验结果.xls')).sheet_by_index(0)
        seen = set()
        for r in range(1, sh.nrows):
            t = xd(sh.cell_value(r, 10))
            if not t or t < adm_date:
                continue
            flag = str(sh.cell_value(r, 8)).strip()
            if flag in ('H', 'L'):
                key = str(sh.cell_value(r, 4))
                if key in seen:
                    continue
                seen.add(key)
                labs.append({'item': str(sh.cell_value(r, 4)), 'code': str(sh.cell_value(r, 5)),
                             'result': str(sh.cell_value(r, 6)), 'unit': str(sh.cell_value(r, 7)),
                             'flag': flag, 'range': str(sh.cell_value(r, 11)),
                             'time': t.strftime('%m-%d %H:%M')})
    except Exception as e:
        print('WARN labs %s %s' % (patient, e))
    try:
        sh = xlrd.open_workbook(os.path.join(pdir, '医嘱.xls')).sheet_by_index(0)
        seen = set()
        for r in range(1, sh.nrows):
            t = xd(sh.cell_value(r, 14))
            if not t or t < adm_date:
                continue
            cls = str(sh.cell_value(r, 6))
            txt = str(sh.cell_value(r, 7)).strip()
            if cls == 'A' and txt and txt not in seen:
                seen.add(txt)
                dose = str(sh.cell_value(r, 9))
                try:
                    dose = str(int(float(dose)))
                except Exception:
                    pass
                orders.append({'text': txt, 'dose': dose + str(sh.cell_value(r, 10)),
                               'route': str(sh.cell_value(r, 11)), 'freq': str(sh.cell_value(r, 16))})
    except Exception as e:
        print('WARN orders %s %s' % (patient, e))
    return labs[:8], orders[:8]


def build_patient(patient, zips):
    """最新一次住院为当前接诊对象；其余为既往住院时间轴"""
    adm_items = []
    for zp in zips:
        date, adm, labels = read_zip_admission(zp)
        if adm:
            adm_items.append({'date': '%s-%s-%s' % (date[:4], date[4:6], date[6:8]),
                              'adm': adm, 'labels': labels, 'zip': os.path.basename(zp)})
        elif date:
            # 产科等非标准模板：仍纳入住院时间轴（文书清单为真实内容，字段不解析）
            adm_items.append({'date': '%s-%s-%s' % (date[:4], date[4:6], date[6:8]),
                              'adm': {'diagnosis': '产科入院（非标准模板，字段未解析）', 'pid': ''},
                              'labels': labels, 'zip': os.path.basename(zp)})
    adm_items.sort(key=lambda x: x['date'])
    cur = adm_items[-1]['adm']
    labs, orders = load_xls(patient, datetime.datetime.strptime(adm_items[-1]['date'], '%Y-%m-%d'))
    admissions = []
    for it in adm_items:
        admissions.append({'date': it['date'], 'type': '住院', 'dept': '普外科',
                           'dx': collapse(it['adm']['diagnosis'])[:40] or '详见病案',
                           'docs': sorted(it['labels']),
                           'current': it is adm_items[-1]})
    return {
        'id': 'P' + cur['pid'], 'name': patient, 'sex': cur['sex'], 'age': cur['age'],
        'marriage': cur['marriage'], 'job': cur['job'], 'birthplace': cur['birthplace'],
        'nation': cur['nation'], 'ward': '普外科', 'admittedAt': cur['admittedAt'],
        'visitNo': cur['visitNo'], 'chiefView': collapse(cur['chief']),
        'dxPreview': collapse(cur['diagnosis'])[:20], 'allergies': cur['allergy'],
        'admissions': admissions, 'record': cur, 'his': {'labs': labs, 'orders': orders},
        'dialogue': [],
    }, adm_items


def build_gold(patient='闫秋荣'):
    """金标准：闫秋荣 2023-11 住院（入院记录 + 首次病程 + 出院记录，逐字取自 XML）"""
    pdir = os.path.join(SRC, patient)
    docs = {}
    with zipfile.ZipFile(os.path.join(pdir, '2000979429_闫秋荣(20260921145048).zip')) as z:
        for info in z.infolist():
            try:
                name = info.filename.encode('cp437').decode('gbk')
            except Exception:
                name = info.filename
            raw = z.read(info)
            parts = xml_parts(raw)
            if '入院记录' in name:
                docs['adm'] = parse_admission(parts)
            elif '首次病程' in name:
                docs['fc_text'] = collapse('\n'.join(p for p in parts if p.strip() != '：'))
            elif '出院记录' in name:
                docs['dc_text'] = collapse('\n'.join(p for p in parts if p.strip() != '：'))
    adm = docs['adm']
    gold = {
        'chief': adm['chief'], 'present': adm['present'], 'past': adm['past'],
        'allergy': adm['allergy'], 'personal': adm['personal'],
        'marriage': collapse(re.sub(r'月经史：?.*', '', adm['marriage'])) or collapse(adm['marriage']),
        'family': adm['family'],
        'vitals': 'T %s℃　P %s次/分　R %s次/分　BP %smmHg' % (
            adm['vitals']['T'], adm['vitals']['P'], adm['vitals']['R'], adm['vitals']['BP']),
        'specialty': adm['specialty'], 'auxiliary': adm['auxiliary'],
        'diagnosis': adm['diagnosis'],
    }
    def seg(t, a, b=None):
        i = t.find(a)
        if i < 0:
            return ''
        i += len(a)
        j = t.find(b, i) if b else -1
        return t[i: j if j > 0 else len(t)]
    fc_t, dc_t = docs.get('fc_text', ''), docs.get('dc_text', '')
    goldFC = {
        'caseFeatures': seg(fc_t, '病例特点', '初步诊断').lstrip('：'),
        'fcDiagnosis': seg(fc_t, '初步诊断', '诊断依据').lstrip('：'),
        'diagBasis': seg(fc_t, '诊断依据', '鉴别诊断').lstrip('：'),
        'diffDiagnosis': seg(fc_t, '鉴别诊断', '诊疗计划').lstrip('：'),
        'plan': seg(fc_t, '诊疗计划').lstrip('：'),
    }
    goldDC = {
        'admissionSituation': seg(dc_t, '入院情况：', '入院诊断：'),
        'admissionDx': seg(dc_t, '入院诊断：', '诊疗经过：'),
        'course': seg(dc_t, '诊疗经过：', '出院诊断：'),
        'dischargeDx': seg(dc_t, '出院诊断：', '出院情况：'),
        'dischargeStatus': seg(dc_t, '出院情况：', '出院医嘱：'),
        'dischargeAdvice': seg(dc_t, '出院医嘱：', '医师签名'),
    }
    treatment = None
    m = re.search(r'于(\d{4}-\d{2}-\d{2})在(全麻|局麻|静脉麻醉|椎管内麻醉|全凭静脉麻醉)?下?[行]?(.+?术)[。.，]', dc_t)
    if m:
        treatment = {
            'surgeryDate': m.group(1), 'anesthesia': m.group(2) or '麻醉下',
            'surgery': m.group(3),
            'postopCare': (seg(dc_t, '手术顺利', '。').replace('手术顺利', '').lstrip('，并给予患者') or '对症支持治疗'),
            'source': '汇聚自出院记录·诊疗经过（真实文书）',
        }
    # 该次住院的真实文书清单（从 zip 实际内容统计）
    labels, doc_total = {}, 0
    with zipfile.ZipFile(os.path.join(pdir, '2000979429_闫秋荣(20260921145048).zip')) as z:
        for info in z.infolist():
            try:
                name = info.filename.encode('cp437').decode('gbk')
            except Exception:
                name = info.filename
            if name.endswith('.xml'):
                doc_total += 1
                lab = classify_doc(name)
                labels[lab] = labels.get(lab, 0) + 1
    doc_list = [k + ('×' + str(v) if v > 1 else '') for k, v in labels.items()]

    labs, orders = load_xls(patient, datetime.datetime(2023, 11, 1))
    return {'gold': gold, 'goldFC': goldFC, 'goldDC': goldDC, 'treatment': treatment,
            'adm': adm, 'docCount': doc_total, 'docList': doc_list,
            'his': {'labs': labs, 'orders': orders}}


def j(obj):
    return json.dumps(obj, ensure_ascii=False, indent=2)


def main():
    out = io.StringIO()
    W = out.write
    W('''/* ============================================================
 * AI 病历智能体 · 医生端网页 MVP
 * data.js — 真实数据集（由 tools/build_data.py 从医院原始数据程序化生成，勿手改）
 * 来源：病案 zip 内 XTextDocument XML（逐字提取）+ HIS SQL 导出 xls + 门诊系统截图转录
 * 不含任何 AI 编造的病史/转写/对话：对话与转写待真实 ASR（M2.1）转写真实音频后填充
 * 病案文书原文全文见 data_records/<患者>.json（tools/export_records.py 提取）
 * ⚠ 内部数据：仅限演示环境，禁止外传；正式部署前须脱敏
 * ============================================================ */

export const HOSPITAL = '东阿县人民医院';
export const SYSTEM_NAME = 'AI 病历智能体';

export const DOCTORS = [
  { id: 'doc001', name: '张岩', dept: '普外科', title: '副主任医师', code: '51403', role: 'doctor' },
  { id: 'doc002', name: '刘博', dept: '神经内科', title: '主治医师', code: '51120', role: 'doctor' },
  { id: 'admin001', name: '医务科管理员', dept: '医务科', title: '质控管理（演示账号，非真实人员）', code: '90001', role: 'admin' },
];

/* 四色来源体系（方案 2.2；转写接入后"智能体提炼"恢复为"对话提炼"） */
export const SOURCE_META = {
  his:   { label: 'HIS 带入', desc: '系统接口自动获取，不依赖语音', color: 'his' },
  dlg:   { label: '智能体提炼', desc: '由病案文书/HIS 数据程序化汇聚（真实数据源）', color: 'dlg' },
  norm:  { label: '规范所见', desc: '模板常规项与知识库辅助，供核定', color: 'norm' },
  miss:  { label: '待补充',   desc: '未获取且无法判定，严禁臆造',     color: 'miss' },
};

''')

    # ---- PATIENTS ----
    patients_src = sorted(os.listdir(SRC))
    pats = []
    gold_patient = '闫秋荣'
    for patient in patients_src:
        pdir = os.path.join(SRC, patient)
        if not os.path.isdir(pdir):
            continue
        zips = sorted(glob.glob(os.path.join(pdir, '*.zip')))
        p, adm_items = build_patient(patient, zips)
        pats.append((patient, p, adm_items))
    W('export const PATIENTS = ' + json.dumps([p for _, p, _ in pats], ensure_ascii=False, indent=2) + ';\n\n')

    # ---- GOLD_CASE ----
    g = build_gold(gold_patient)
    adm = g['adm']
    admissions = []
    for patient, p, adm_items in pats:
        if patient != gold_patient:
            continue
        admissions = [
            {'date': it['date'], 'type': '住院', 'dept': '普外科' if '普' in collapse(it['adm']['diagnosis']) or True else '普外科',
             'dx': collapse(it['adm']['diagnosis'])[:40] or '详见病案',
             'docs': sorted(it['labels']), 'current': it is adm_items[-1]}
            for it in adm_items
        ]
    gold_case = {
        'id': 'GOLD-' + adm['pid'], 'name': gold_patient, 'sex': adm['sex'], 'age': adm['age'],
        'marriage': adm['marriage'], 'job': adm['job'], 'birthplace': adm['birthplace'],
        'nation': adm['nation'], 'ward': '普外科·金标准案例', 'admittedAt': adm['admittedAt'],
        'visitNo': adm['visitNo'], 'chiefView': collapse(adm['chief']),
        'dxPreview': collapse(adm['diagnosis'])[:24], 'allergies': adm['allergy'],
        'docCount': g['docCount'],
        'docList': g['docList'],
        'admissions': admissions,
        'record': None,
        'gold': g['gold'], 'goldFC': g['goldFC'], 'goldDC': g['goldDC'],
        'treatment': g['treatment'], 'his': g['his'],
    }
    W('/* ============================================================\n')
    W(' * 金标准评测案例（方案 2.3）：医生真实书写的入院/首次病程/出院记录，逐字取自院内 XML 病案。\n')
    W(' * gold/goldFC/goldDC = 金标准原文（真实）；record = 运行时由规则重组引擎生成（agents.js recombineGoldDraft）。\n')
    W(' * ============================================================ */\n')
    W('export const GOLD_CASE = ' + json.dumps(gold_case, ensure_ascii=False, indent=2) + ';\n\n')

    # ---- 尾部：AGENTS / ASR_TESTSET / OPD_PATIENTS（真实截图转录） / 常量 ----
    W('''/* ---------- 六智能体定义（方案 4.3.1） ---------- */
export const AGENTS = [
  { id: 'extract',   name: '信息抽取智能体', role: '从真实病案要素中识别主诉、症状、时程、过敏等医学要素并归类', icon: 'extract' },
  { id: 'aggregate', name: '数据汇聚智能体', role: '对接 HIS，拉取基本信息、检验检查、医嘱等结构化数据', icon: 'aggregate' },
  { id: 'retrieve',  name: '知识检索智能体', role: '检索既往病历与医学知识库（诊疗规范、鉴别诊断）', icon: 'retrieve' },
  { id: 'generate',  name: '病历生成智能体', role: '按模板字段生成规范、专业、贴近本院风格的内容', icon: 'generate' },
  { id: 'qc',        name: '质控校验智能体', role: '校验完整性与逻辑一致性，标注缺失项，杜绝臆造', icon: 'qc' },
  { id: 'mapping',   name: '字段映射智能体', role: '内容精确映射到院内模板字段，生成可归档数据包', icon: 'mapping' },
];

/* ASR 选型测试集：门诊真实音频（密钥经"系统设置"登记后挂接） */
export const ASR_TESTSET = {
  audios: [
    { id: 1, file: '1.m4a', photo: '1.jpg', note: '门诊医患对话录音 #1（神经内科·脑血管病复诊取药）' },
    { id: 2, file: '2.m4a', photo: '2.jpg', note: '门诊医患对话录音 #2（骨科·颈椎病）' },
    { id: 3, file: '3.m4a', photo: '3.jpg', note: '门诊医患对话录音 #3（神经内科·脑血管病复诊）' },
    { id: 4, file: '4.m4a', photo: '4.jpg', note: '门诊医患对话录音 #4（妇科·复诊）' },
    { id: 5, file: '5.m4a', photo: '5.jpg', note: '门诊医患对话录音 #5（儿科·疱疹性咽峡炎）' },
  ],
  dimensions: ['普通话及山东方言字准率/句准率', '医学术语、药品名、检查名识别与热词定制', '实时转写时延与长录音稳定性', '调用成本与私有化部署可行性'],
  source: '病历资料/门诊/（音频为东阿县人民医院真实门诊录音，选型测试横向比选引擎）',
};

/* 门诊接诊场景：5 例字段值均转录自真实门诊系统截图（病历资料/门诊/*.jpg），
 * 音频为真实门诊原声（opd/*.m4a）；对话/转写内容待真实 ASR 转写后填充，不预置脚本。 */
export const OPD_PATIENTS = ''' + json.dumps(OPD, ensure_ascii=False, indent=2) + ''';

export const OPD_NOTE = '门诊场景依赖真实 ASR 引擎转写真实音频（M2.1 挂接），当前可核对患者档案与生成流程。';

export const DEMO_BANNER = '真实数据环境 · 患者数据源自院内病历导出，仅供研发验证，请勿外传';
''')

    io.open(OUT, 'w', encoding='utf-8').write(out.getvalue())
    print('BUILD_OK patients=%d gold_adm_date=%s treatment=%s' % (
        len(pats), adm['admittedAt'], bool(g['treatment'])))


# ---------- 门诊（真实截图转录，无对话） ----------
OPD = [
  {
    "id": "C001311681", "name": "秦道秋", "sex": "男", "age": 55, "scene": "opd",
    "dept": "神经内科1门诊", "visitAt": "2026-09-09 09:51", "fee": "普通",
    "chiefView": "脑血管病取药", "dxPreview": "脑血管病（复诊取药）", "icd": "I67.900",
    "allergies": "无", "audio": "opd/1.m4a", "photo": "opd/1.jpg",
    "his": {"chronic": ["高血压", "2型糖尿病"], "visits": ["2026-08 神经内科门诊", "2026-07 神经内科门诊"]},
    "record": {
      "opdChief": "脑血管病取药。",
      "opdPresent": "患者既往患脑血管病、高血压，平素坚持口服药物，今日来院取药。",
      "opdPast": "脑血管病、高血压、2型糖尿病病史，平素口服药物治疗。",
      "opdFamily": "无特殊家族史。",
      "opdPhysical": "高级皮层功能正常，颅神经正常，四肢肌力5级，肌张力正常，共济运动正常，双侧深浅感觉对称正常，双侧病理征（-），脑膜刺激征（-）。",
      "opdAuxiliary": "无。",
      "opdDx": "脑血管病 I67.900；高血压病2级（中危）I10.x00x026；便秘 K59.000；2型糖尿病 E11.900",
      "opdAdvice": "口服药物，不适随诊。"
    },
    "dialogue": []
  },
  {
    "id": "2000700050", "name": "付德山", "sex": "男", "age": 86, "scene": "opd",
    "dept": "骨科门诊", "visitAt": "2026-09-09", "fee": "城镇居民",
    "chiefView": "颈部僵痛复查", "dxPreview": "颈椎病（依诊疗意见推断）", "icd": "",
    "allergies": "无", "audio": "opd/2.m4a", "photo": "opd/2.jpg",
    "his": {"chronic": [], "visits": ["既往多次骨科/中医科门诊"]},
    "record": {
      "opdChief": "颈部僵硬伴上肢麻木，劳累后加重。",
      "opdPresent": "患者颈部发僵，低头后酸胀疼痛，偶伴右上肢麻木，低头时间久后轻度头晕。曾行针灸理疗后减轻。今日来院复诊。",
      "opdPast": "颈椎病病史多年，否认高血压、糖尿病史。",
      "opdFamily": "无特殊家族史。",
      "opdPhysical": "颈部活动轻度受限，颈椎棘突旁压痛（±），双上肢皮肤感觉正常，握力正常，病理征未引出。",
      "opdAuxiliary": "无（本次未行辅助检查）。",
      "opdDx": "颈椎病",
      "opdAdvice": "注意休息，避免长时间低头及颈椎过伸过屈等不良刺激；适度功能锻炼；针灸理疗随诊。"
    },
    "dialogue": []
  },
  {
    "id": "2000708512", "name": "刘焕玉", "sex": "女", "age": 72, "scene": "opd",
    "dept": "神经内科1门诊", "visitAt": "2026-09-09", "fee": "城镇居民",
    "chiefView": "脑血管病复诊", "dxPreview": "脑血管病（陈旧性脑梗死）", "icd": "I67.900",
    "allergies": "无", "audio": "opd/3.m4a", "photo": "opd/3.jpg",
    "his": {"chronic": ["高血压"], "visits": ["2026-09-03 颅脑MR 检查", "既往神经内科门诊多次"]},
    "record": {
      "opdChief": "脑血管病复诊，右侧肢体乏力。",
      "opdPresent": "患者既往脑血管病、高血压病史，现口角偏斜，右下肢乏力，行走拖拽。平素口服药物治疗，血压偶有偏高。今日复诊。",
      "opdPast": "高血压病史，脑血管病史。",
      "opdFamily": "无特殊可述。",
      "opdPhysical": "口角偏斜，左上肢肌力5级，右下肢肌力4级，肌张力正常，双侧深浅感觉对称正常，左侧病理征（+），脑膜刺激征（-）。",
      "opdAuxiliary": "颅脑MR（2026-09-03）：右侧脑内陈旧性梗死灶；缺血性白质病变（改良Fazekas分级2级）；部分空泡蝶鞍；鼻窦炎；颅内动脉粥样硬化；右侧大脑中动脉闭塞，建议结合CTA；左侧大脑后动脉纤细、迂曲，局部狭窄。",
      "opdDx": "脑血管病 I67.900",
      "opdAdvice": "继续口服药物，不适随诊；建议住院完善CTA及脑血管评估。"
    },
    "dialogue": []
  },
  {
    "id": "2000785147", "name": "姜淑君", "sex": "女", "age": 41, "scene": "opd",
    "dept": "妇科门诊", "visitAt": "2026-09-09 14:37", "fee": "城镇居民",
    "chiefView": "妇科复诊", "dxPreview": "妇科门诊复诊（诊断待查）", "icd": "",
    "allergies": "无", "audio": "opd/4.m4a", "photo": "opd/4.jpg",
    "his": {"chronic": [], "visits": ["2026-08-29 妇科门诊", "2025-06-21 手足外科门诊", "2025-05-09 急诊科", "2025-01-05 妇科门诊"]},
    "record": {
      "opdChief": "下腹坠胀伴白带异常，复诊。",
      "opdPresent": "患者下腹坠胀，白带异常，无发热。既往多次妇科门诊就诊。今日来院复诊。",
      "opdPast": "既往妇科炎症病史（具体诊疗经过见历史病历）。",
      "opdFamily": "无特殊。",
      "opdPhysical": "（妇科查体见专科记录，演示环境略）",
      "opdAuxiliary": "白带常规待查。",
      "opdDx": "",
      "opdAdvice": "完善白带常规等检查，结果回报后随诊。"
    },
    "dialogue": []
  },
  {
    "id": "2001560743", "name": "陶奕可", "sex": "女", "age": 1, "ageText": "1岁1月", "scene": "opd",
    "dept": "儿科门诊", "visitAt": "2026-09-09 14:52", "fee": "自费",
    "chiefView": "手足臀部疱疹2天", "dxPreview": "疱疹性咽峡炎", "icd": "B08.501",
    "allergies": "无食物及药物过敏", "audio": "opd/5.m4a", "photo": "opd/5.jpg",
    "his": {"chronic": [], "visits": ["首次就诊"]},
    "record": {
      "opdChief": "手足臀部疱疹2天。",
      "opdPresent": "患儿2天前出现流涎，家属发现口腔疱疹，无咳嗽、咳痰，手足可见疱疹。为进一步治疗，来我院就诊。发病以来精神可，进食稍差。",
      "opdPast": "既往体健，无食物及药物过敏史。",
      "opdFamily": "否认家族遗传病史。",
      "opdPhysical": "咽部充血，咽后壁、上颚可见疱疹，部分融合成片，手足可见疱疹。",
      "opdAuxiliary": "无。",
      "opdDx": "疱疹性咽峡炎 B08.501",
      "opdAdvice": "1.口服药物，对症治疗，注意保暖，避免受凉；2.不适随诊。"
    },
    "dialogue": []
  }
]

if __name__ == '__main__':
    sys.exit(main())
