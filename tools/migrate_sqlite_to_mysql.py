#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
SQLite → MySQL 一次性迁移工具（留痕 audit_logs + 归档 archives）
用法：
  python3 tools/migrate_sqlite_to_mysql.py                # 读 data_server/config.json 的 db.mysql 节
  python3 tools/migrate_sqlite_to_mysql.py --host 1.2.3.4 --user medagent --password *** --database medagent
  python3 tools/migrate_sqlite_to_mysql.py --dry-run      # 只统计，不写库
幂等：archives 按 id REPLACE（重跑覆盖）；audit_logs 按自增 id 断点续传（只搬目标库没有的行）。
"""
import argparse, json, os, sqlite3, sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(ROOT, 'vendor'))
DB_PATH = os.path.join(ROOT, 'data_server', 'medagent.db')
CFG_PATH = os.path.join(ROOT, 'data_server', 'config.json')


def mysql_args():
    ap = argparse.ArgumentParser()
    ap.add_argument('--host'); ap.add_argument('--port', type=int)
    ap.add_argument('--user'); ap.add_argument('--password')
    ap.add_argument('--database'); ap.add_argument('--dry-run', action='store_true')
    a = ap.parse_args()
    cfg = {}
    try:
        with open(CFG_PATH) as f:
            cfg = (json.load(f).get('db') or {}).get('mysql') or {}
    except Exception:
        pass
    return {
        'host': a.host or cfg.get('host', '127.0.0.1'),
        'port': a.port or int(cfg.get('port', 3306)),
        'user': a.user or cfg.get('user', 'medagent'),
        'password': a.password if a.password is not None else cfg.get('password', ''),
        'database': a.database or cfg.get('database', 'medagent'),
    }, a.dry_run


def main():
    try:
        import pymysql
    except ImportError:
        print('未找到 pymysql：请保留 vendor/ 目录或 python3 -m pip install pymysql')
        sys.exit(1)
    m, dry = mysql_args()

    if not os.path.isfile(DB_PATH):
        print('SQLite 库不存在：%s（无数据可迁移）' % DB_PATH)
        sys.exit(0)
    src = sqlite3.connect(DB_PATH)
    n_audit_src = src.execute('SELECT COUNT(*) FROM audit_logs').fetchone()[0]
    n_arch_src = src.execute('SELECT COUNT(*) FROM archives').fetchone()[0]
    print('SQLite 源：%d 条留痕，%d 份归档' % (n_audit_src, n_arch_src))
    print('MySQL 目标：%s:%s/%s%s' % (m['host'], m['port'], m['database'], '（dry-run 不写库）' if dry else ''))

    conn = pymysql.connect(charset='utf8mb4', autocommit=False, connect_timeout=5, **m)
    cur = conn.cursor()
    cur.execute('''CREATE TABLE IF NOT EXISTS audit_logs(
        id BIGINT AUTO_INCREMENT PRIMARY KEY, time VARCHAR(32) DEFAULT '',
        action VARCHAR(32) DEFAULT '', detail VARCHAR(500) DEFAULT '',
        doctor VARCHAR(32) DEFAULT '') ENGINE=InnoDB DEFAULT CHARSET=utf8mb4''')
    cur.execute('''CREATE TABLE IF NOT EXISTS archives(
        id VARCHAR(32) PRIMARY KEY, pid VARCHAR(32) DEFAULT '', pname VARCHAR(32) DEFAULT '',
        doctor VARCHAR(32) DEFAULT '', time VARCHAR(32) DEFAULT '', doc VARCHAR(32) DEFAULT '',
        type VARCHAR(16) DEFAULT '', md MEDIUMTEXT) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4''')
    conn.commit()

    # 归档：按 id REPLACE（重跑幂等覆盖）
    cur.execute('SELECT COUNT(*) FROM archives')
    n_arch_dst = cur.fetchone()[0]
    rows = src.execute('SELECT id,pid,pname,doctor,time,doc,type,md FROM archives ORDER BY rowid').fetchall()
    if not dry and rows:
        cur.executemany('REPLACE INTO archives(id,pid,pname,doctor,time,doc,type,md) VALUES (%s,%s,%s,%s,%s,%s,%s,%s)', rows)
        conn.commit()
    print('归档：SQLite %d 份 → MySQL 已有 %d 份，本次 %s%d 份'
          % (len(rows), n_arch_dst, '将写入 ' if dry else '写入 ', len(rows)))

    # 留痕：无自然键，按内容元组 (time,action,detail,doctor) 去重，重跑不重复、不漏行
    cur.execute('SELECT time,action,detail,doctor FROM audit_logs')
    seen = set(cur.fetchall())
    rows = src.execute('SELECT time,action,detail,doctor FROM audit_logs ORDER BY id').fetchall()
    todo = [r for r in rows if r not in seen]
    if not dry and todo:
        cur.executemany('INSERT INTO audit_logs(time,action,detail,doctor) VALUES (%s,%s,%s,%s)', todo)
        conn.commit()
    print('留痕：SQLite 共 %d 条，目标库已有 %d 条，本次 %s%d 条（按内容去重）'
          % (len(rows), len(seen), '将写入 ' if dry else '写入 ', len(todo)))

    # 校验
    if not dry:
        cur.execute('SELECT COUNT(*) FROM audit_logs')
        a = cur.fetchone()[0]
        cur.execute('SELECT COUNT(*) FROM archives')
        b = cur.fetchone()[0]
        conn.commit()
        print('校验：MySQL 现有 %d 条留痕 / %d 份归档' % (a, b))
    src.close()
    conn.close()
    print('完成。服务器切换后端：MEDAGENT_DB_BACKEND=mysql 或 config.json db.backend="mysql" 后重启 server.py')


if __name__ == '__main__':
    main()
