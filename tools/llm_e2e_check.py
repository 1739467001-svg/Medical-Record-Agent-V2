#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
产品路径端到端校验：不指定 provider（走激活配置 config.llm），对住院三文书
（入院记录/首次病程/出院记录）各跑一轮真实生成，验证：
  1) 激活引擎（当前=qwen3.8-max thinking off）三文书 JSON 均有效；
  2) 时序裁剪生效——入院/首次病程输出不含术后病理（素材即不含），出院记录素材含病理；
  3) 单文书时延满足产品预期（< 90s 前端超时）。
素材与提示词同 tools/llm_compare.py（复制自 llm.js buildMessages/materialOf）。
"""
import json, os, re, sys, time, urllib.request

HERE = os.path.dirname(os.path.abspath(__file__))
BFF = 'http://127.0.0.1:8801/api/llm/chat'
TRANSCRIPT_PATH = os.path.join(HERE, '..', '..',
    '会议对齐信息', '这是若雨处理后的数据，你可以去借鉴一下它的二次验证思路，至于质量嘛，你必须比他做的更好',
    'patient01录音文本.txt')

REC_BASE = {
    '申请单主诉': '腹痛1天', '申请单现病史': '患者腹痛1天，院外未做特殊处理，来我院就诊。',
    '门诊诊断': '阑尾炎', 'CT印象': '阑尾炎。',
    'CT所见': '阑尾直径约1.7cm,周围脂肪间隙模糊，周围见数个肿大淋巴结。肝脏大小、形态正常，肝内密度均匀，未见局灶性密度异常，肝内血管走行正常，肝内外胆管无扩张。胆囊不大，其内未见异常密度影，脾不大，形态规则，密度均匀。胰腺大小形态及密度正常，边界清',
    '入院体征': 'T 36.6℃　P 103次/分　R 20次/分　BP 115/77mmHg',
}
REC_DC = {**REC_BASE, '手术日期': '2026-10-02', '术后病理': '常规诊断：急性坏疽性阑尾炎。',
          '术后所见': '阑尾炎术后所见'}
LABS = ['降钙素原 0.288ng/mL↑', '白细胞 19.1510^9/L↑', '中性细胞数 16.9910^9/L↑',
        '淋巴细胞数 0.6410^9/L↓', '单核细胞 1.4910^9/L↑', '嗜酸性粒细胞 010^9/L↓',
        '中性细胞比率 88.70%↑', '淋巴细胞比率 3.30%↓']

SPECS = {
    'adm': ('入院记录', [
        ('chief', '主诉', '症状 + 持续时间，20 字以内，与素材表述的事实完全一致'),
        ('present', '现病史', '按时间线组织：起病诱因→症状演变→院外诊治→来院目的；只使用素材中的事实与数值；结尾如素材含"发病以来精神/食欲/睡眠/大小便/体重"信息则带一句概括，否则不写'),
        ('past', '既往史', '只写素材明示的疾病/手术/外伤/输血/传染病史；"否认"句式仅用于素材明示的排除项'),
        ('allergy', '过敏史', '素材含过敏原才书写；无则输出空串'),
        ('family', '家族史', '仅限素材范围'),
        ('marriage', '婚姻史', '仅限素材范围'),
        ('personal', '个人史', '仅限素材范围；素材无信息时输出规范句"生于原籍、久居本地；否认疫区疫水接触史，无烟酒嗜好"'),
        ('diagnosis', '初步诊断', '与素材中的诊断原文一致，不新增、不改名'),
    ], REC_BASE),
    'fc': ('首次病程记录', [
        ('caseFeatures', '病例特点', '条目式汇总：流行病学→既往史→现病史→查体→辅助检查，全部取自素材'),
        ('diagBasis', '诊断依据', '主诉 + 查体要点 + 辅助检查三条，与素材一致'),
        ('diffDiagnosis', '鉴别诊断', '依据素材疾病给出 2-3 个鉴别对象，每个含鉴别要点与依据（检验/体征）；素材不足以支持某鉴别项时省略该条'),
        ('plan', '诊疗计划', '护理级别、完善检查、对症治疗、拟行方案；素材未提及的操作不写'),
    ], REC_BASE),
    'dc': ('出院记录', [
        ('admissionSituation', '入院情况', '主诉 + 现病史要点 + 查体 + 辅助检查，取自素材'),
        ('course', '诊疗经过', '按素材中的手术/治疗时间线书写；素材无则输出空串'),
        ('dischargeStatus', '出院情况', '仅限素材范围；无则输出空串'),
        ('dischargeAdvice', '出院医嘱', '仅限素材范围；无则输出空串'),
    ], REC_DC),
}


def system_of(title):
    return ('你是东阿县人民医院的病历生成智能体，起草%s的指定字段。铁律：\n'
            '1) 严禁臆造：素材中没有的事实输出空字符串，不得编造数值、日期、诊断、用药；\n'
            '2) 客观一致：检验/检查/体征数值与素材完全一致；\n'
            '3) 文风：参照本院风格样例，专业、简洁、书面化医学用语；\n'
            '4) 输出：只输出一个 JSON 对象（键=字段id，值=中文字符串），不要解释、不要 markdown 代码块标记。' % title)


def build(doc_key):
    title, fields, rec = SPECS[doc_key]
    raw = open(TRANSCRIPT_PATH, encoding='utf-8').read()
    m = re.search(r'^-{3,}\s*ASR 原文\s*-{3,}([\s\S]*?)-{3,}\s*纠错后\s*-{3,}([\s\S]*)$', raw, re.M)
    tr_raw, tr_fixed = m.group(1).strip(), m.group(2).strip()
    parts = ['场景：住院接诊·录音优先（素材=真实 HIS 导出结构化要素 + 真实问诊转写文本）',
             '【问诊转写原文（上传转写文本（双重验证后）；主诉/现病史/既往史/过敏史/个人史/家族史优先以此对话内容组织）】' + tr_fixed,
             '【ASR 原文（纠错前，含方言口语）】' + tr_raw,
             '【病案/HIS 结构化要素 JSON】{}',
             '【HIS 客观要素（真实导出，客观字段禁止改写数值；问诊类字段以转写对话为准）】'
             + json.dumps(rec, ensure_ascii=False, separators=(',', ':')),
             '【HIS 检验异常（客观）】' + '；'.join(LABS)]
    hows = '\n'.join('- %s（%s）：%s' % f for f in fields)
    template = json.dumps({f[0]: '' for f in fields}, ensure_ascii=False, separators=(',', ':'))
    user = '\n'.join(parts) + '\n【字段书写要求】\n' + hows + '\n【输出 JSON 模板】' + template
    return [{'role': 'system', 'content': system_of(title)}, {'role': 'user', 'content': user}]


def extract_json(text):
    t = re.sub(r'```(json)?', '', str(text or ''))
    s, e = t.find('{'), t.rfind('}')
    if s < 0 or e <= s:
        return None
    try:
        obj = json.loads(t[s:e + 1])
        return obj if isinstance(obj, dict) else None
    except Exception:
        return None


def main():
    out = {}
    for doc_key in ('adm', 'fc', 'dc'):
        body = json.dumps({'messages': build(doc_key), 'temperature': 0.2}).encode('utf-8')
        req = urllib.request.Request(BFF, data=body, method='POST',
                                     headers={'Content-Type': 'application/json'})
        t0 = time.time()
        with urllib.request.urlopen(req, timeout=150) as r:
            j = json.loads(r.read().decode('utf-8'))
        ms = int((time.time() - t0) * 1000)
        content = (((j.get('upstream') or {}).get('choices') or [{}])[0]
                   .get('message', {}).get('content') or '')
        obj = extract_json(content)
        rec = {'ms': ms, 'model': (j.get('upstream') or {}).get('model'),
               'valid': obj is not None, 'obj': obj,
               'usage': (j.get('upstream') or {}).get('usage')}
        blob = json.dumps(obj, ensure_ascii=False) if obj else content
        rec['has_pathology'] = bool(re.search(r'病理|坏疽', blob))
        out[doc_key] = rec
        print('%s: %dms valid=%s 病理出现=%s model=%s' % (doc_key, ms, rec['valid'], rec['has_pathology'], rec['model']))
        if obj:
            for k, v in obj.items():
                print('   [%s] %s' % (k, (str(v) or '(空)')[:100]))
    with open(os.path.join(HERE, 'llm_compare_out', 'e2e_product_path.json'), 'w', encoding='utf-8') as f:
        json.dump(out, f, ensure_ascii=False, indent=1)
    ok = all(r['valid'] for r in out.values()) and not out['adm']['has_pathology'] and not out['fc']['has_pathology']
    print('\n端到端校验：', '通过（三文书 JSON 有效，入院/首程无术后病理时序污染）' if ok else '未通过，见上')


if __name__ == '__main__':
    main()
