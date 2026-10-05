#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Mock LLM（OpenAI 兼容桩）— M2.0/M2.1 传输与解析链路实测专用，不含真实模型能力。
用法：/usr/bin/python3 tools/mock_llm.py [端口，默认 8899]
行为：
  · /models → 200 模型列表（连通性测试用）
  · /chat/completions → 从请求末条消息中提取【输出 JSON 模板】（llm.js 约定），
    回填"（大模型桩）"标记值，验证前端 JSON 解析/合并链路；
  · 环境变量 MOCK_LLM_FAIL=1 → 返回非 JSON 文本，用于验证前端失败回落规则引擎。
生产环境禁止启动本桩。
"""
import json, os, re, sys, time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

PORT = int(sys.argv[1]) if len(sys.argv) > 1 else 8899
FAIL = os.environ.get('MOCK_LLM_FAIL') == '1'


class H(BaseHTTPRequestHandler):
    def _j(self, code, obj):
        b = json.dumps(obj, ensure_ascii=False).encode()
        self.send_response(code)
        self.send_header('Content-Type', 'application/json; charset=utf-8')
        self.send_header('Content-Length', str(len(b)))
        self.end_headers()
        self.wfile.write(b)

    def do_GET(self):
        if self.path.rstrip('/').endswith('/models'):
            self._j(200, {'object': 'list', 'data': [{'id': 'mock-gold-style', 'object': 'model'}]})
        else:
            self._j(404, {'error': 'not found'})

    def do_POST(self):
        n = int(self.headers.get('Content-Length') or 0)
        try:
            req = json.loads(self.rfile.read(n).decode('utf-8'))
        except Exception:
            req = {}
        last = (req.get('messages') or [{}])[-1].get('content', '')
        if FAIL:
            content = '（Mock LLM FAIL 模式）这段文本不是 JSON，用于验证前端回落规则引擎。' + str(last)[:60]
        else:
            templates = re.findall(r'\{[^{}]*\}', str(last))
            if templates:
                try:
                    tpl = json.loads(templates[-1])
                    content = json.dumps(
                        {k: f'（大模型桩草稿）{k}：按本院书写风格依素材改写。' for k in tpl},
                        ensure_ascii=False)
                except Exception:
                    content = '（Mock LLM）模板解析失败：' + str(last)[:80]
            else:
                content = '（Mock LLM）未在请求中找到 JSON 模板：' + str(last)[:80]
        self._j(200, {'id': 'mock', 'object': 'chat.completion',
                      'created': int(time.time()), 'model': 'mock-gold-style',
                      'choices': [{'index': 0,
                                   'message': {'role': 'assistant', 'content': content},
                                   'finish_reason': 'stop'}],
                      'usage': {'total_tokens': 42}})

    def log_message(self, *a):
        pass


if __name__ == '__main__':
    ThreadingHTTPServer.allow_reuse_address = True
    ThreadingHTTPServer(('127.0.0.1', PORT), H).serve_forever()
