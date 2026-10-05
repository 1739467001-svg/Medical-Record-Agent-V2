#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
export_records.py — 把医院真实病案（zip 内 XTextDocument XML）提取为纯文本 JSON，
供前端"真实文书原文查看器"按患者加载。可重复执行（幂等）。
输出：medagent/data_records/<患者名>.json
      [{ "doc": "入院记录", "sub": "…", "date": "20231103", "file": "原始文件名", "text": "…" }]
用法：/usr/bin/python3 tools/export_records.py
"""
import json, os, re, sys, zipfile
import xml.etree.ElementTree as ET

BASE = os.path.dirname(os.path.abspath(__file__))
SRC = os.path.abspath(os.path.join(BASE, '..', '..', '病历资料', '住院'))
OUT = os.path.abspath(os.path.join(BASE, '..', 'data_records'))
XSI = '{http://www.w3.org/2001/XMLSchema-instance}type'

DOC_GROUPS = [
    ('入院记录', '入院记录'), ('出院记录', '出院记录'), ('手术记录', '手术记录'),
    ('首次病程记录', '首次病程记录'), ('术前小结', '术前小结'),
    ('查房记录', '查房记录'), ('用药记录', '用药记录'), ('日常病程', '日常病程'),
    ('知情文件', '知情文件'), ('评估文件', '评估文件'), ('同意书', '知情文件'),
]


def classify(name):
    for key, label in DOC_GROUPS:
        if key in name:
            return label
    return '其他文书'


def xml_text(raw):
    """XTextDocument → 按 Element 顺序拼接的纯文本"""
    try:
        root = ET.fromstring(raw)
    except Exception:
        return ''
    parts = []
    for el in root.iter('Element'):
        if el.get(XSI) == 'XString':
            t = el.findtext('Text')
            if t and t.strip():
                parts.append(t.strip())
    # 合并被模板切断的短句（如 主诉/现病史 的字段值），保留段落结构
    text = '\n'.join(parts)
    text = re.sub(r'\n{2,}', '\n', text)
    return text.strip()


def main():
    os.makedirs(OUT, exist_ok=True)
    total_docs = 0
    report = []
    if not os.path.isdir(SRC):
        print('ERR_SRC_MISSING')
        return 1
    for patient in sorted(os.listdir(SRC)):
        pdir = os.path.join(SRC, patient)
        if not os.path.isdir(pdir):
            continue
        docs = []
        for fname in sorted(os.listdir(pdir)):
            if not fname.endswith('.zip'):
                continue
            zpath = os.path.join(pdir, fname)
            try:
                with zipfile.ZipFile(zpath) as z:
                    for info in z.infolist():
                        try:
                            name = info.filename.encode('cp437').decode('gbk')
                        except Exception:
                            name = info.filename
                        if not name.endswith('.xml'):
                            continue
                        raw = z.read(info)
                        text = xml_text(raw)
                        if not text:
                            continue
                        m = re.search(r'(20\d{6})', name)
                        docs.append({
                            'doc': classify(name),
                            'sub': name.rsplit('_', 1)[0] if '_' in name else name,
                            'date': m.group(1) if m else '',
                            'file': name,
                            'text': text,
                        })
                        total_docs += 1
            except zipfile.BadZipFile:
                report.append('BADZIP:' + fname)
        # 按文书类型+日期排序，前端按时间轴展示
        docs.sort(key=lambda d: (d['doc'], d['date']))
        out_path = os.path.join(OUT, patient + '.json')
        with open(out_path, 'w', encoding='utf-8') as f:
            json.dump(docs, f, ensure_ascii=False, indent=1)
        report.append('%s: %d docs' % (patient, len(docs)))
    print('EXPORT_OK total=%d' % total_docs)
    for line in report:
        print(line)
    return 0


if __name__ == '__main__':
    sys.exit(main())
