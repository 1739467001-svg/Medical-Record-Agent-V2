#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Mock LLM（OpenAI 兼容桩）— M2.0 传输链路实测专用，不含真实模型能力。
用法：/usr/bin/python3 tools/mock_llm.py [端口，默认 8899]
"""
import json, sys, time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

PORT = int(sys.argv[1]) if len(sys.argv) > 1 else 8899


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
        content = '（Mock LLM）按本院金标准书写风格生成：' + str(last)[:80]
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
