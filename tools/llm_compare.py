#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
LLM 选型对比测试（2026-10-23）
================================
任务：与产品完全同口径——用若雨的双重验证转写文本（patient01=房传虎）+ HIS 客观要素，
      按 llm.js DOC_SPECS.adm 的入院记录字段级提示词生成 JSON 草稿。
模型：deepseek(deepseek-v4-pro) / deepseek-flash / qwen(qwen3.8-max)，各 N 轮。
评测：事实覆盖率（15 项可核查事实）· 零编造（硬编造/软编造分级计数）·
      结构化稳定性（JSON 有效/泄漏标记）· 时延 · token 成本 · 轮间一致性。
提示词与素材组装逐行复制自 medagent/js/llm.js（buildMessages + materialOf(patient,'adm')，
2026-10-23 版），确保测试即产品路径；上游经 BFF /api/llm/chat（密钥不出服务器）。
用法：python3 tools/llm_compare.py [runs=3]
输出：tools/llm_compare_out/runs/*.json + summary.json + 控制台汇总表。
"""
import json, os, re, sys, time, urllib.request

HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(HERE, 'llm_compare_out')
RUNS_DIR = os.path.join(OUT, 'runs')
BFF = 'http://127.0.0.1:8801/api/llm/chat'
TRANSCRIPT_PATH = os.path.join(HERE, '..', '..',
    '会议对齐信息', '这是若雨处理后的数据，你可以去借鉴一下它的二次验证思路，至于质量嘛，你必须比他做的更好',
    'patient01录音文本.txt')
PROVIDERS = [
    ('deepseek', 'deepseek-v4-pro'),
    ('deepseek-flash', 'deepseek-flash'),
    ('qwen', 'qwen3.8-max'),
]
# 模式矩阵：think=推理型默认（开思考，max_tokens 16384 覆盖思考+正文）；
#           fast=thinking disabled（结构化 JSON 场景，max_tokens 4096）
MODES = [('think', None, 16384), ('fast', 'off', 4096)]

# ---- 房传虎 HIS 客观要素（摘自 js/data.js P2001390150，真实导出，勿改） ----
REC = {
    '申请单主诉': '腹痛1天',
    '申请单现病史': '患者腹痛1天，院外未做特殊处理，来我院就诊。',
    '门诊诊断': '阑尾炎',
    'CT印象': '阑尾炎。',
    'CT所见': '阑尾直径约1.7cm,周围脂肪间隙模糊，周围见数个肿大淋巴结。肝脏大小、形态正常，肝内密度均匀，未见局灶性密度异常，肝内血管走行正常，肝内外胆管无扩张。胆囊不大，其内未见异常密度影，脾不大，形态规则，密度均匀。胰腺大小形态及密度正常，边界清',
    '入院体征': 'T 36.6℃　P 103次/分　R 20次/分　BP 115/77mmHg',
}
LABS = ['降钙素原 0.288ng/mL↑', '白细胞 19.1510^9/L↑', '中性细胞数 16.9910^9/L↑',
        '淋巴细胞数 0.6410^9/L↓', '单核细胞 1.4910^9/L↑', '嗜酸性粒细胞 010^9/L↓',
        '中性细胞比率 88.70%↑', '淋巴细胞比率 3.30%↓']

# ---- DOC_SPECS.adm（逐行复制自 llm.js） ----
ADM_FIELDS = [
    ('chief', '主诉', '症状 + 持续时间，20 字以内，与素材表述的事实完全一致'),
    ('present', '现病史', '按时间线组织：起病诱因→症状演变→院外诊治→来院目的；只使用素材中的事实与数值；结尾如素材含"发病以来精神/食欲/睡眠/大小便/体重"信息则带一句概括，否则不写'),
    ('past', '既往史', '只写素材明示的疾病/手术/外伤/输血/传染病史；"否认"句式仅用于素材明示的排除项'),
    ('allergy', '过敏史', '素材含过敏原才书写；无则输出空串'),
    ('family', '家族史', '仅限素材范围'),
    ('marriage', '婚姻史', '仅限素材范围'),
    ('personal', '个人史', '仅限素材范围；素材无信息时输出规范句"生于原籍、久居本地；否认疫区疫水接触史，无烟酒嗜好"'),
    ('diagnosis', '初步诊断', '与素材中的诊断原文一致，不新增、不改名'),
]

SYSTEM = ('你是东阿县人民医院的病历生成智能体，起草入院记录的指定字段。铁律：\n'
          '1) 严禁臆造：素材中没有的事实输出空字符串，不得编造数值、日期、诊断、用药；\n'
          '2) 客观一致：检验/检查/体征数值与素材完全一致；\n'
          '3) 文风：参照本院风格样例，专业、简洁、书面化医学用语；\n'
          '4) 输出：只输出一个 JSON 对象（键=字段id，值=中文字符串），不要解释、不要 markdown 代码块标记。')


def load_transcript():
    raw = open(TRANSCRIPT_PATH, encoding='utf-8').read()
    m = re.search(r'^-{3,}\s*ASR 原文\s*-{3,}([\s\S]*?)-{3,}\s*纠错后\s*-{3,}([\s\S]*)$', raw, re.M)
    if not m:
        raise SystemExit('转写文件双段解析失败：' + TRANSCRIPT_PATH)
    return m.group(1).strip(), m.group(2).strip()


def build_prompt(tr_fixed, tr_raw):
    """逐行复制 llm.js materialOf(patient,'adm') + buildMessages 的素材顺序。"""
    parts = ['场景：住院接诊·录音优先（素材=真实 HIS 导出结构化要素 + 真实问诊转写文本）']
    parts.append('【问诊转写原文（上传转写文本（双重验证后）；主诉/现病史/既往史/过敏史/个人史/家族史优先以此对话内容组织）】' + tr_fixed)
    parts.append('【ASR 原文（纠错前，含方言口语）】' + tr_raw)
    parts.append('【病案/HIS 结构化要素 JSON】{}')
    parts.append('【HIS 客观要素（真实导出，客观字段禁止改写数值；问诊类字段以转写对话为准）】' + json.dumps(REC, ensure_ascii=False, separators=(',', ':')))
    parts.append('【HIS 检验异常（客观）】' + '；'.join(LABS))
    hows = '\n'.join('- %s（%s）：%s' % f for f in ADM_FIELDS)
    template = json.dumps({f[0]: '' for f in ADM_FIELDS}, ensure_ascii=False, separators=(',', ':'))
    user = '\n'.join(parts) + '\n【字段书写要求】\n' + hows + '\n【输出 JSON 模板】' + template
    return user


def extract_json(text):
    """llm.js extractJSON 的 Python 等价实现。"""
    if not text:
        return None
    t = re.sub(r'```(json)?', '', str(text))
    s, e = t.find('{'), t.rfind('}')
    if s < 0 or e <= s:
        return None
    try:
        obj = json.loads(t[s:e + 1])
        return obj if isinstance(obj, dict) else None
    except Exception:
        return None


def call_bff(provider, messages, thinking=None, max_tokens=4096):
    body = {'provider': provider, 'messages': messages,
            'temperature': 0.2, 'max_tokens': max_tokens}
    if thinking:
        body['thinking'] = thinking
    req = urllib.request.Request(BFF, data=json.dumps(body).encode('utf-8'), method='POST',
                                 headers={'Content-Type': 'application/json'})
    t0 = time.time()
    with urllib.request.urlopen(req, timeout=280) as r:
        j = json.loads(r.read().decode('utf-8'))
    return j, int((time.time() - t0) * 1000)


# ---- 事实清单：15 项可核查事实（转写+HIS 双源；scope=参与比对的字段，+号多字段） ----
FACTS = [
    ('chief+present', '起病时间"昨天下午/1天"', ['昨天下午', '1天', '一天', '昨日']),
    ('present', '夜间两点加重', [r'[两2]点', r'夜间加重', '凌晨', r'夜间.{0,8}加重']),
    ('present', '恶心呕吐 2-3 次', [r'2[-~～—–至到]{1,2}3次', '两三次', '二三次', '吐了2']),
    ('present', '院外镇卫生院就诊', ['镇', '卫生院', '当地', '诊所']),
    ('present', '院外注射(消炎针)治疗', ['针', '肌注', '注射']),
    ('present', '治疗后曾缓解', ['缓解', '管点用', '好转']),
    ('present', '无发热（否认发烧）', ['发热', '发烧']),
    ('past', '既往体健/从未类似发作', ['体健', '没痛过', '无类似']),
    ('past', '否认心脏病', ['心脏', '心里没']),
    ('allergy', '否认药物过敏', ['过敏']),
    ('personal', '无饮酒（这两天没喝）', ['酒']),
    ('past+personal', '平时体格尚可', ['体格', '体健', '平素']),
    ('marriage', '育 2 子（两个男孩）', ['2子', '两子', '2个男孩', '两个男孩', '育有2', '二子', '两个儿子']),
    ('chief', '主诉含"腹痛"', ['腹痛']),
    ('diagnosis', '初步诊断=阑尾炎', ['阑尾炎']),
]
# 硬编造：素材中完全不存在（出现即判臆造）
HARD_FABRIC = [
    ('anywhere', '“转移性”（素材无迁移性疼痛表述）', ['转移性']),
    ('anywhere', '术后病理/坏疽（入院时刻快照不含术后信息）', ['坏疽', '术后病理', '病理']),
    ('anywhere', '具体日期（素材无日期）', [r'20\d{2}', r'\d+月\d+日', r'10-0\d']),
]
# 软编造：规范模板句式但素材未明示（违反"否认句式仅用于素材明示排除项"）。
# 注：个人史规范句（含"无烟酒嗜好"）是 DOC_SPECS 明文允许的兜底输出，不计软编造。
SOFT_FABRIC = [
    ('past', '否认高血压/糖尿病/冠心病', ['高血压', '糖尿病', '冠心病']),
    ('past', '否认肝炎/结核', ['肝炎', '结核']),
    ('past', '手术/外伤/输血史表述', ['手术史', '外伤史', '输血']),
]


def scope_text(obj, scope):
    if scope == 'anywhere' or obj is None:
        return json.dumps(obj, ensure_ascii=False) if obj else ''
    ks = scope.split('+')
    return ' '.join(str(obj.get(k) or '') for k in ks)


def evaluate(obj):
    hits = []
    for scope, label, pats in FACTS:
        text = scope_text(obj, scope)
        ok = any(re.search(p, text) for p in pats)
        hits.append({'label': label, 'ok': ok})
    hard = []
    for scope, label, pats in HARD_FABRIC:
        text = scope_text(obj, scope)
        if any(re.search(p, text) for p in pats):
            hard.append(label)
    soft = []
    for scope, label, pats in SOFT_FABRIC:
        text = scope_text(obj, scope)
        if any(re.search(p, text) for p in pats):
            soft.append(label)
    return hits, hard, soft


def bigram_sim(a, b):
    if a == b:
        return 1.0
    A = {a[i:i + 2] for i in range(len(a) - 1)} or {a}
    B = {b[i:i + 2] for i in range(len(b) - 1)} or {b}
    return len(A & B) / max(len(A | B), 1)


def reval():
    """离线重评：核查口径修正后，对已保存的轮次文件重新打分并重建 summary（不再调用上游）。"""
    import glob
    runs = 3
    summary = {'ts': time.strftime('%Y-%m-%d %H:%M:%S') + ' (reval)', 'runs': runs, 'providers': {}}
    files = sorted(glob.glob(os.path.join(RUNS_DIR, '*.json')))
    by_key = {}
    for fp in files:
        r = json.load(open(fp, encoding='utf-8'))
        if r.get('fields') is not None:
            hits, hard, soft = evaluate(r['fields'])
            r['fact_hits'] = sum(1 for h in hits if h['ok'])
            r['facts'] = hits
            r['hard_fabric'] = hard
            r['soft_fabric'] = soft
            with open(fp, 'w', encoding='utf-8') as f:
                json.dump(r, f, ensure_ascii=False, indent=1)
        key = '%s:%s' % (r['provider'], r.get('mode', 'think'))
        by_key.setdefault(key, []).append(r)
    for key, rows in by_key.items():
        runs = len(rows)
        good = [r for r in rows if r.get('valid_json')]
        cons = pair = 0
        for a in range(len(good)):
            for b in range(a + 1, len(good)):
                ta = ''.join(str(v) for v in (good[a].get('fields') or {}).values())
                tb = ''.join(str(v) for v in (good[b].get('fields') or {}).values())
                cons += bigram_sim(ta, tb)
                pair += 1
        summary['providers'][key] = {
            'model': rows[0].get('model'), 'success': sum(1 for r in rows if r.get('ok')),
            'valid_json': len(good), 'leak_runs': sum(1 for r in rows if r.get('leak_markers')),
            'avg_ms': round(sum(r.get('ms', 0) for r in rows if r.get('ok')) / max(sum(1 for r in rows if r.get('ok')), 1)),
            'avg_prompt_tokens': round(sum(r.get('prompt_tokens') or 0 for r in rows) / runs),
            'avg_completion_tokens': round(sum(r.get('completion_tokens') or 0 for r in rows) / runs),
            'fact_hits_by_run': [r.get('fact_hits') for r in rows],
            'avg_fact_hits': round(sum(r.get('fact_hits') or 0 for r in good) / max(len(good), 1), 2) if good else 0,
            'hard_fabric_all': sorted({x for r in good for x in (r.get('hard_fabric') or [])}),
            'soft_fabric_by_run': [len(r.get('soft_fabric') or []) for r in rows],
            'soft_fabric_detail': sorted({x for r in good for x in (r.get('soft_fabric') or [])}),
            'consistency': round(cons / pair, 3) if pair else None,
        }
    with open(os.path.join(OUT, 'summary.json'), 'w', encoding='utf-8') as f:
        json.dump(summary, f, ensure_ascii=False, indent=1)
    print('\n===== 重评汇总（事实满分 15） =====')
    for key, a in summary['providers'].items():
        print('%-22s %-16s JSON有效%d/%d | 均时延%6dms | 事实%.1f/15 | 硬编造%s | 软编造/轮%.1f | 一致性%s' % (
            key, a['model'], a['valid_json'], runs, a['avg_ms'], a['avg_fact_hits'],
            a['hard_fabric_all'] or '无', (sum(a['soft_fabric_by_run']) / runs), a['consistency']))


def main():
    runs = int(sys.argv[1]) if len(sys.argv) > 1 else 3
    os.makedirs(RUNS_DIR, exist_ok=True)
    tr_raw, tr_fixed = load_transcript()
    user = build_prompt(tr_fixed, tr_raw)
    with open(os.path.join(OUT, 'prompt.txt'), 'w', encoding='utf-8') as f:
        f.write(user)
    messages = [{'role': 'system', 'content': SYSTEM}, {'role': 'user', 'content': user}]

    summary = {'ts': time.strftime('%Y-%m-%d %H:%M:%S'), 'runs': runs, 'providers': {}}
    for prov, model in PROVIDERS:
        for mode, thinking, mtok in MODES:
            key = '%s:%s' % (prov, mode)
            rows = []
            for i in range(1, runs + 1):
                rec = {'provider': prov, 'model': model, 'mode': mode, 'run': i}
                try:
                    j, ms = call_bff(prov, messages, thinking=thinking, max_tokens=mtok)
                    rec['ms'] = ms
                    rec['ok'] = bool(j.get('ok'))
                    up = j.get('upstream') or {}
                    u = up.get('usage') or {}
                    rec['prompt_tokens'] = u.get('prompt_tokens')
                    rec['completion_tokens'] = u.get('completion_tokens')
                    rec['stop_reason'] = ((up.get('choices') or [{}])[0].get('finish_reason'))
                    content = (((up.get('choices') or [{}])[0].get('message') or {}).get('content') or '')
                    rec['content_len'] = len(content)
                    obj = extract_json(content)
                    rec['valid_json'] = obj is not None
                    rec['leak_markers'] = sorted(set(re.findall(r'```|Let me|Wait,|reconsider|The exam|首先我需要|让我', content)))
                    if obj is not None:
                        rec['fields'] = {k: obj.get(k) for k in [f[0] for f in ADM_FIELDS]}
                        hits, hard, soft = evaluate(obj)
                        rec['fact_hits'] = sum(1 for h in hits if h['ok'])
                        rec['facts'] = hits
                        rec['hard_fabric'] = hard
                        rec['soft_fabric'] = soft
                    else:
                        rec['content_head'] = content[:300]
                except Exception as e:
                    rec['ok'] = False
                    rec['error'] = str(e)[:300]
                rows.append(rec)
                with open(os.path.join(RUNS_DIR, '%s_%s_%d.json' % (prov, mode, i)), 'w', encoding='utf-8') as f:
                    json.dump(rec, f, ensure_ascii=False, indent=1)
                print('  %-22s run%d: %s %6dms valid=%s stop=%s facts=%s hard=%s soft=%s' % (
                    key, i, 'OK' if rec.get('ok') else 'FAIL', rec.get('ms', -1),
                    rec.get('valid_json'), rec.get('stop_reason'), rec.get('fact_hits'),
                    len(rec.get('hard_fabric') or []), len(rec.get('soft_fabric') or [])), flush=True)
        # 汇总
            good = [r for r in rows if r.get('valid_json')]
            cons = 0.0
            pair = 0
            for a in range(len(good)):
                for b in range(a + 1, len(good)):
                    ta = ''.join(str(v) for v in (good[a].get('fields') or {}).values())
                    tb = ''.join(str(v) for v in (good[b].get('fields') or {}).values())
                    cons += bigram_sim(ta, tb)
                    pair += 1
            agg = {
                'model': model,
                'success': sum(1 for r in rows if r.get('ok')),
                'valid_json': len(good),
                'leak_runs': sum(1 for r in rows if r.get('leak_markers')),
                'avg_ms': round(sum(r.get('ms', 0) for r in rows) / max(len(rows), 1)),
                'avg_prompt_tokens': round(sum(r.get('prompt_tokens') or 0 for r in rows) / max(len(rows), 1)),
                'avg_completion_tokens': round(sum(r.get('completion_tokens') or 0 for r in rows) / max(len(rows), 1)),
                'fact_hits_by_run': [r.get('fact_hits') for r in rows],
                'avg_fact_hits': round(sum(r.get('fact_hits') or 0 for r in good) / max(len(good), 1), 2) if good else 0,
                'hard_fabric_all': sorted({x for r in good for x in (r.get('hard_fabric') or [])}),
                'soft_fabric_by_run': [len(r.get('soft_fabric') or []) for r in rows],
                'soft_fabric_detail': sorted({x for r in good for x in (r.get('soft_fabric') or [])}),
                'consistency': round(cons / pair, 3) if pair else None,
            }
            summary['providers'][key] = agg
    with open(os.path.join(OUT, 'summary.json'), 'w', encoding='utf-8') as f:
        json.dump(summary, f, ensure_ascii=False, indent=1)
    print('\n===== 汇总（事实满分 15；一致性=轮间 bigram 相似度均值） =====')
    for prov, a in summary['providers'].items():
        print('%-22s %-16s 成功%d/%d JSON有效%d/%d 泄漏%d轮 | 均时延%6dms | 均出token%5d | 事实%.1f/15 | 硬编造%s | 软编造/轮%.1f | 一致性%s' % (
            prov, a['model'], a['success'], runs, a['valid_json'], runs, a['leak_runs'],
            a['avg_ms'], a['avg_completion_tokens'], a['avg_fact_hits'], a['hard_fabric_all'] or '无',
            (sum(a['soft_fabric_by_run']) / runs), a['consistency']))


if __name__ == '__main__':
    if len(sys.argv) > 1 and sys.argv[1] == '--reval':
        reval()
    else:
        main()
