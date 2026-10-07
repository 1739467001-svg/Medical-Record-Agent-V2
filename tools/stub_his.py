#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""HIS 开发桩（模拟医院 I-1 接口）— 验证 BFF 代理与归一化链路专用，不含真实数据。
用法：/usr/bin/python3 tools/stub_his.py [端口，默认 8890]
契约（docs/接口与字段映射说明.md 第二节 I-1）：
  GET /his/api/patient/{patientId}?visitId=...   Header: Authorization: Bearer <token>
约定测试 token：his-stub-token（token 不符返回 401，用于验证鉴权链路）
返回结构化演示数据（患者甲——虚构标识，无真实患者信息）。生产环境禁止启动本桩。
"""
import json, sys, time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

PORT = int(sys.argv[1]) if len(sys.argv) > 1 else 8890
TOKEN = 'his-stub-token'

FAKE = {
    'patient': {'id': 'PAT-STUB-001', 'name': '患者甲（HIS桩）', 'sex': '女', 'age': '58',
                'marriage': '已婚', 'birthplace': '山东省聊城市', 'ward': '普外科',
                'admittedAt': '2026-08-26 09:26', 'visitNo': '8', 'allergies': '青霉素'},
    'labs': [
        {'item': '白细胞计数', 'code': 'WBC', 'result': '12.6', 'unit': '×10^9/L', 'flag': 'H', 'range': '3.5-9.5', 'time': '2026-08-26'},
        {'item': '中性粒细胞比例', 'code': 'NEUT%', 'result': '0.86', 'unit': '%', 'flag': 'H', 'range': '0.40-0.75', 'time': '2026-08-26'},
        {'item': 'C反应蛋白', 'code': 'CRP', 'result': '58.3', 'unit': 'mg/L', 'flag': 'H', 'range': '<10', 'time': '2026-08-26'},
    ],
    'orders': [
        {'text': '注射用头孢曲松钠', 'dose': '2.0g', 'route': '静脉滴注', 'freq': 'qd'},
        {'text': '奥美拉唑肠溶胶囊', 'dose': '20mg', 'route': '口服', 'freq': 'bid'},
    ],
    'vitals': {'T': '38.2', 'P': '96', 'R': '20', 'BP': '138/86'},
    'history': [
        {'date': '2023-03-14', 'dept': '普外科', 'dx': '急性阑尾炎', 'docs': ['入院记录', '出院记录']},
        {'date': '2024-11-02', 'dept': '普外科', 'dx': '胆囊结石伴急性胆囊炎', 'docs': ['入院记录']},
    ],
}


class H(BaseHTTPRequestHandler):
    def _j(self, code, obj):
        b = json.dumps(obj, ensure_ascii=False).encode()
        self.send_response(code)
        self.send_header('Content-Type', 'application/json; charset=utf-8')
        self.send_header('Content-Length', str(len(b)))
        self.end_headers()
        self.wfile.write(b)

    def do_GET(self):
        auth = self.headers.get('Authorization') or ''
        if auth != 'Bearer ' + TOKEN:
            self._j(401, {'error': 'unauthorized（stub 校验 Bearer token）'})
            return
        if '/his/api/patient/' in self.path:
            self._j(200, dict(FAKE, fetchedAt=time.strftime('%Y-%m-%d %H:%M:%S')))
        else:
            self._j(404, {'error': 'not found'})

    def log_message(self, *a):
        pass


if __name__ == '__main__':
    ThreadingHTTPServer.allow_reuse_address = True
    ThreadingHTTPServer(('127.0.0.1', PORT), H).serve_forever()
