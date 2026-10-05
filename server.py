#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
AI 病历智能体 · BFF 服务（M2.0，方案见 docs/M2构建规划.md）
仅用 Python 标准库（MySQL 驱动以纯 Python pymysql 随项目打包于 vendor/）；
密钥只存服务器（data_server/config.json, 0600），浏览器仅持"已配置"标记；
留痕/归档入库 SQLite（默认）或 MySQL（可选），大模型经本服务代理。

存储后端选择（运维级，浏览器不可配）：
  1. 环境变量 MEDAGENT_DB_BACKEND = mysql | sqlite（优先）
  2. data_server/config.json 的 db 节：
     "db": {"backend": "mysql",
            "mysql": {"host": "127.0.0.1", "port": 3306,
                      "user": "medagent", "password": "***", "database": "medagent"}}
  SQLite 最可迁移（单文件拷贝即搬家）；MySQL 面向生产（医院信息科标准运维/备份体系）。
  切换/迁移/备份见 docs/部署运维手册.md 第八章。
"""
import base64, hashlib, hmac, json, os, re, sqlite3, sys, time
import urllib.request, urllib.error
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

ROOT = os.path.dirname(os.path.abspath(__file__))
DATA_DIR = os.path.join(ROOT, 'data_server')
DB_PATH = os.path.join(DATA_DIR, 'medagent.db')
CFG_PATH = os.path.join(DATA_DIR, 'config.json')
PORT = int(sys.argv[1]) if len(sys.argv) > 1 else 8801

CT = {'.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8',
      '.js': 'text/javascript; charset=utf-8', '.m4a': 'audio/mp4',
      '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png',
      '.svg': 'image/svg+xml', '.md': 'text/markdown; charset=utf-8',
      '.json': 'application/json; charset=utf-8'}

os.makedirs(DATA_DIR, exist_ok=True)
sys.path.insert(0, os.path.join(ROOT, 'vendor'))  # 随项目打包的纯 Python 驱动（pymysql）


def load_cfg():
    try:
        with open(CFG_PATH) as f:
            return json.load(f)
    except Exception:
        return {'asr': {'engine': 'demo', 'iflytek': {}, 'aliyun': {}}, 'llm': {}}


def save_cfg(c):
    with open(CFG_PATH, 'w') as f:
        json.dump(c, f, ensure_ascii=False, indent=1)
    try:
        os.chmod(CFG_PATH, 0o600)
    except Exception:
        pass


def cfg_status(c):
    """只返回掩码状态与非敏感项，密钥明文永不下发"""
    asr = c.get('asr', {})
    llm = c.get('llm', {})
    return {
        'engine': asr.get('engine', 'demo'),
        'iflytek': {'appId': asr.get('iflytek', {}).get('appId', ''),
                    'hasKey': bool(asr.get('iflytek', {}).get('apiKey')),
                    'hasSecret': bool(asr.get('iflytek', {}).get('apiSecret'))},
        'aliyun': {'appKey': asr.get('aliyun', {}).get('appKey', ''),
                   'hasKey': bool(asr.get('aliyun', {}).get('apiKey'))},
        'llm': {'baseUrl': llm.get('baseUrl', ''), 'model': llm.get('model', ''),
                'hasKey': bool(llm.get('apiKey'))},
    }


# ============================ 存储层 ============================
# 两个后端实现同一接口：add_audit / list_audit / put_archive / list_archives / clear / health
# 接口返回的数据形状与 M2.0 SQLite 版完全一致，前端无感知。

SQLITE_SCHEMA = '''
CREATE TABLE IF NOT EXISTS audit_logs(
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    time TEXT, action TEXT, detail TEXT, doctor TEXT);
CREATE TABLE IF NOT EXISTS archives(
    id TEXT PRIMARY KEY, pid TEXT, pname TEXT, doctor TEXT, time TEXT,
    doc TEXT, type TEXT, md TEXT);
'''

MYSQL_SCHEMA_AUDIT = '''
CREATE TABLE IF NOT EXISTS audit_logs(
    id BIGINT AUTO_INCREMENT PRIMARY KEY,
    time VARCHAR(32) DEFAULT '', action VARCHAR(32) DEFAULT '',
    detail VARCHAR(500) DEFAULT '', doctor VARCHAR(32) DEFAULT ''
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci'''

MYSQL_SCHEMA_ARCHIVES = '''
CREATE TABLE IF NOT EXISTS archives(
    id VARCHAR(32) PRIMARY KEY,
    pid VARCHAR(32) DEFAULT '', pname VARCHAR(32) DEFAULT '',
    doctor VARCHAR(32) DEFAULT '', time VARCHAR(32) DEFAULT '',
    doc VARCHAR(32) DEFAULT '', type VARCHAR(16) DEFAULT '',
    md MEDIUMTEXT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci'''


class SQLiteStorage:
    """默认后端：零依赖、单文件、随 data_server/ 目录整体迁移即完成搬家。"""

    def __init__(self, path):
        self.path = path
        os.makedirs(os.path.dirname(path), exist_ok=True)
        conn = sqlite3.connect(path)
        conn.executescript(SQLITE_SCHEMA)
        conn.execute('PRAGMA journal_mode=WAL')      # 断电/崩溃时已提交事务不丢
        conn.execute('PRAGMA busy_timeout=5000')     # 并发写短暂争用时等待而非报错
        conn.commit()
        conn.close()

    def _conn(self):
        conn = sqlite3.connect(self.path)
        conn.execute('PRAGMA busy_timeout=5000')
        return conn

    def add_audit(self, entries):
        conn = self._conn()
        try:
            conn.executemany('INSERT INTO audit_logs(time,action,detail,doctor) VALUES (?,?,?,?)',
                             [(e['time'], e['action'], e['detail'], e['doctor']) for e in entries])
            conn.commit()
        finally:
            conn.close()
        return len(entries)

    def list_audit(self, limit):
        conn = self._conn()
        try:
            rows = conn.execute('SELECT time,action,detail,doctor FROM audit_logs '
                                'ORDER BY id DESC LIMIT ?', (limit,)).fetchall()
        finally:
            conn.close()
        return [{'time': r[0], 'action': r[1], 'detail': r[2], 'doctor': r[3]} for r in rows]

    def put_archive(self, a):
        conn = self._conn()
        try:
            conn.execute('INSERT OR REPLACE INTO archives(id,pid,pname,doctor,time,doc,type,md) '
                         'VALUES (?,?,?,?,?,?,?,?)',
                         (a['id'], a['pid'], a['pname'], a['doctor'], a['time'],
                          a['doc'], a['type'], a['md']))
            conn.commit()
        finally:
            conn.close()

    def list_archives(self):
        conn = self._conn()
        try:
            rows = conn.execute('SELECT id,pid,pname,doctor,time,doc,type,md FROM archives '
                                'ORDER BY rowid DESC').fetchall()
        finally:
            conn.close()
        return [{'id': r[0], 'pid': r[1], 'pname': r[2], 'doctor': r[3],
                 'time': r[4], 'doc': r[5], 'type': r[6], 'md': r[7]} for r in rows]

    def clear(self):
        conn = self._conn()
        try:
            conn.execute('DELETE FROM audit_logs')
            conn.execute('DELETE FROM archives')
            conn.commit()
        finally:
            conn.close()

    def health(self):
        return {'backend': 'sqlite', 'file': os.path.basename(self.path),
                'auditDB': os.path.isfile(self.path)}


class MySQLStorage:
    """生产后端：医院信息科标准运维（mysqldump/主从/账号权限），凭证在 config.json db 节。"""

    def __init__(self, cfg):
        try:
            import pymysql
        except ImportError:
            raise RuntimeError('未找到 pymysql 驱动：项目已随包提供 vendor/pymysql，请勿删除该目录；'
                               '或 python3 -m pip install pymysql')
        self._pymysql = pymysql
        self.cfg = cfg
        try:
            conn = self._conn()
            cur = conn.cursor()
            cur.execute(MYSQL_SCHEMA_AUDIT)
            cur.execute(MYSQL_SCHEMA_ARCHIVES)
            conn.commit()
            cur.close()
            conn.close()
        except Exception as e:
            raise RuntimeError('MySQL 连接失败（%s@%s:%s/%s）：%s' % (
                cfg.get('user'), cfg.get('host'), cfg.get('port'), cfg.get('database'), e))

    def _conn(self):
        return self._pymysql.connect(
            host=self.cfg.get('host', '127.0.0.1'),
            port=int(self.cfg.get('port', 3306)),
            user=self.cfg.get('user', 'medagent'),
            password=self.cfg.get('password', ''),
            database=self.cfg.get('database', 'medagent'),
            charset='utf8mb4', autocommit=True, connect_timeout=5)

    def add_audit(self, entries):
        conn = self._conn()
        try:
            with conn.cursor() as cur:
                cur.executemany('INSERT INTO audit_logs(time,action,detail,doctor) VALUES (%s,%s,%s,%s)',
                                [(e['time'], e['action'], e['detail'], e['doctor']) for e in entries])
        finally:
            conn.close()
        return len(entries)

    def list_audit(self, limit):
        conn = self._conn()
        try:
            with conn.cursor() as cur:
                cur.execute('SELECT time,action,detail,doctor FROM audit_logs ORDER BY id DESC LIMIT %s', (limit,))
                rows = cur.fetchall()
        finally:
            conn.close()
        return [{'time': r[0], 'action': r[1], 'detail': r[2], 'doctor': r[3]} for r in rows]

    def put_archive(self, a):
        conn = self._conn()
        try:
            with conn.cursor() as cur:
                cur.execute('REPLACE INTO archives(id,pid,pname,doctor,time,doc,type,md) '
                            'VALUES (%s,%s,%s,%s,%s,%s,%s,%s)',
                            (a['id'], a['pid'], a['pname'], a['doctor'], a['time'],
                             a['doc'], a['type'], a['md']))
        finally:
            conn.close()

    def list_archives(self):
        conn = self._conn()
        try:
            with conn.cursor() as cur:
                cur.execute('SELECT id,pid,pname,doctor,time,doc,type,md FROM archives ORDER BY id DESC')
                rows = cur.fetchall()
        finally:
            conn.close()
        return [{'id': r[0], 'pid': r[1], 'pname': r[2], 'doctor': r[3],
                 'time': r[4], 'doc': r[5], 'type': r[6], 'md': r[7]} for r in rows]

    def clear(self):
        conn = self._conn()
        try:
            with conn.cursor() as cur:
                cur.execute('DELETE FROM audit_logs')
                cur.execute('DELETE FROM archives')
        finally:
            conn.close()

    def health(self):
        return {'backend': 'mysql', 'host': self.cfg.get('host'), 'database': self.cfg.get('database')}


def db_backend_cfg():
    """后端选择：环境变量 MEDAGENT_DB_BACKEND 优先，其次 config.json 的 db 节。"""
    c = load_cfg().get('db') or {}
    mysql = {'host': '127.0.0.1', 'port': 3306, 'user': 'medagent', 'password': '', 'database': 'medagent'}
    mysql.update(c.get('mysql') or {})
    backend = os.environ.get('MEDAGENT_DB_BACKEND') or c.get('backend') or 'sqlite'
    return backend, mysql


def make_storage():
    backend, mysql_cfg = db_backend_cfg()
    if backend == 'mysql':
        return MySQLStorage(mysql_cfg)
    return SQLiteStorage(DB_PATH)


try:
    STORE = make_storage()
except RuntimeError as e:
    print('存储层初始化失败：', e, file=sys.stderr)
    sys.exit(1)
# ========================== 存储层结束 ==========================


class Handler(BaseHTTPRequestHandler):
    server_version = 'MedAgentBFF/2.1'

    # ---------- helpers ----------
    def _json(self, code, obj):
        body = json.dumps(obj, ensure_ascii=False).encode('utf-8')
        self.send_response(code)
        self.send_header('Content-Type', 'application/json; charset=utf-8')
        self.send_header('Content-Length', str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _body(self):
        n = int(self.headers.get('Content-Length') or 0)
        if n <= 0 or n > 2_000_000:
            return {}
        try:
            return json.loads(self.rfile.read(n).decode('utf-8'))
        except Exception:
            return {}

    def _static(self, path):
        if path == '/':
            path = '/index.html'
        import urllib.parse
        path = urllib.parse.unquote(path)
        fp = os.path.normpath(os.path.join(ROOT, path.lstrip('/')))
        if not fp.startswith(ROOT) or not os.path.isfile(fp):
            self._json(404, {'error': 'not found'})
            return
        with open(fp, 'rb') as f:
            body = f.read()
        ext = os.path.splitext(fp)[1].lower()
        self.send_response(200)
        self.send_header('Content-Type', CT.get(ext, 'application/octet-stream'))
        self.send_header('Content-Length', str(len(body)))
        self.send_header('Cache-Control', 'no-cache')
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, fmt, *args):
        sys.stderr.write('[%s] %s\n' % (time.strftime('%H:%M:%S'), fmt % args))

    # ---------- GET ----------
    def do_GET(self):
        path, _, query = self.path.partition('?')
        try:
            if path.startswith('/api/'):
                self._api_get(path, query)
            else:
                self._static(path)
        except Exception as e:
            self._json(500, {'error': str(e)})

    def _api_get(self, path, query):
        if path == '/api/health':
            self._json(200, {'ok': True, 'server': 'BFF M2.1', 'db': STORE.health(),
                             **cfg_status(load_cfg())})
            return
        if path == '/api/config':
            self._json(200, cfg_status(load_cfg()))
            return
        if path == '/api/audit':
            m = re.search(r'limit=(\d+)', query)
            limit = max(1, min(500, int(m.group(1)))) if m else 200
            self._json(200, STORE.list_audit(limit))
            return
        if path == '/api/archives':
            self._json(200, STORE.list_archives())
            return
        self._json(404, {'error': 'unknown api'})

    # ---------- POST ----------
    def do_POST(self):
        path = self.path.split('?')[0]
        try:
            if path == '/api/audit':
                entries = (self._body().get('entries') or [])[:100]
                clean = [{'time': str(e.get('time', ''))[:32], 'action': str(e.get('action', ''))[:32],
                          'detail': str(e.get('detail', ''))[:500], 'doctor': str(e.get('doctor', ''))[:32]}
                         for e in entries]
                n = STORE.add_audit(clean) if clean else 0
                self._json(200, {'ok': True, 'count': n})
                return
            if path == '/api/archives':
                a = self._body()
                if not a.get('id'):
                    self._json(400, {'error': 'id required'})
                    return
                STORE.put_archive({
                    'id': str(a.get('id', ''))[:32], 'pid': str(a.get('pid', ''))[:32],
                    'pname': str(a.get('pname', ''))[:32], 'doctor': str(a.get('doctor', ''))[:32],
                    'time': str(a.get('time', ''))[:32], 'doc': str(a.get('doc', ''))[:32],
                    'type': str(a.get('type', ''))[:16], 'md': str(a.get('md', ''))[:200000],
                })
                self._json(200, {'ok': True})
                return
            if path == '/api/config':
                data = self._body()
                c = load_cfg()
                asr = data.get('asr') or {}
                if asr.get('engine'):
                    c.setdefault('asr', {})['engine'] = str(asr['engine'])[:32]
                for group, keys in (('iflytek', ('appId', 'apiKey', 'apiSecret')),
                                    ('aliyun', ('appKey', 'apiKey'))):
                    if group in asr:
                        dst = c['asr'].setdefault(group, {})
                        for k in keys:
                            v = str(asr[group].get(k) or '').strip()
                            if v:  # 留空 = 保持服务器现有值
                                dst[k] = v
                llm = data.get('llm') or {}
                dst = c.setdefault('llm', {})
                for k in ('baseUrl', 'apiKey', 'model'):
                    v = str(llm.get(k) or '').strip()
                    if v:
                        dst[k] = v
                save_cfg(c)  # db 节（存储后端）不随浏览器配置改写，仅运维改 config.json/env
                self._json(200, cfg_status(c))
                return
            if path == '/api/demo/clear':
                STORE.clear()
                self._json(200, {'ok': True})
                return
            if path == '/api/llm/test':
                llm = load_cfg().get('llm', {})
                if not (llm.get('baseUrl') and llm.get('apiKey')):
                    self._json(200, {'ok': False, 'msg': '服务端尚未配置大模型（系统设置页填写并保存）'})
                    return
                req = urllib.request.Request(llm['baseUrl'].rstrip('/') + '/models',
                                             headers={'Authorization': 'Bearer ' + llm['apiKey']})
                try:
                    with urllib.request.urlopen(req, timeout=10) as r:
                        self._json(200, {'ok': True, 'msg': '服务端代理连接成功（/models %s）' % r.status})
                except urllib.error.HTTPError as e:
                    self._json(200, {'ok': False, 'msg': '上游响应 %d：请核对地址与密钥' % e.code})
                except Exception as e:
                    self._json(200, {'ok': False, 'msg': '服务端代理无法连接：' + str(e)})
                return
            if path == '/api/llm/chat':
                llm = load_cfg().get('llm', {})
                if not (llm.get('baseUrl') and llm.get('apiKey')):
                    self._json(503, {'error': 'LLM 未配置'})
                    return
                data = self._body()
                payload = json.dumps({
                    'model': data.get('model') or llm.get('model') or 'default',
                    'messages': data.get('messages') or [],
                    'temperature': data.get('temperature', 0.2),
                }).encode('utf-8')
                req = urllib.request.Request(
                    llm['baseUrl'].rstrip('/') + '/chat/completions', data=payload, method='POST',
                    headers={'Authorization': 'Bearer ' + llm['apiKey'],
                             'Content-Type': 'application/json'})
                try:
                    with urllib.request.urlopen(req, timeout=30) as r:
                        out = json.loads(r.read().decode('utf-8'))
                    self._json(200, {'ok': True, 'upstream': out})
                except Exception as e:
                    self._json(502, {'ok': False, 'error': '上游调用失败：' + str(e)})
                return
            if path == '/api/asr/sign':
                data = self._body()
                engine = data.get('engine')
                it = load_cfg().get('asr', {}).get('iflytek', {})
                if engine == 'iflytek':
                    if not (it.get('apiKey') and it.get('apiSecret')):
                        self._json(400, {'error': '讯飞密钥未配置'})
                        return
                    ts = str(int(time.time()))
                    sig = base64.b64encode(hmac.new(
                        it['apiSecret'].encode(), (it['apiKey'] + ts).encode(),
                        hashlib.sha1).digest()).decode()
                    self._json(200, {'engine': 'iflytek', 'appId': it.get('appId', ''),
                                     'ts': ts, 'signature': sig})
                    return
                if engine == 'aliyun':
                    self._json(501, {'error': '阿里云 Token 流程于 M2.1 挂接（密钥可先登记）'})
                    return
                self._json(400, {'error': 'unknown engine'})
                return
            self._json(404, {'error': 'unknown api'})
        except Exception as e:
            self._json(500, {'error': str(e)})


if __name__ == '__main__':
    ThreadingHTTPServer.allow_reuse_address = True
    httpd = ThreadingHTTPServer(('0.0.0.0', PORT), Handler)
    db = STORE.health()
    print('MedAgent BFF 2.1 → http://localhost:%d' % PORT)
    print('  存储：%s%s' % (db['backend'],
                           (' → ' + db['file']) if db['backend'] == 'sqlite'
                           else (' → %s/%s' % (db.get('host'), db.get('database')))))
    httpd.serve_forever()
