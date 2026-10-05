#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
留痕/归档库自动备份（SQLite 与 MySQL 双后端）
用法：
  python3 tools/backup_db.py            # 按当前后端备份一次到 data_server/backups/
  python3 tools/backup_db.py --keep 30  # 保留最近 30 份（默认 14）
建议 crontab（医院服务器每日凌晨备份）：
  30 2 * * * cd /path/to/medagent && /usr/bin/python3 tools/backup_db.py >> data_server/backups/backup.log 2>&1
"""
import argparse, datetime, glob, gzip, json, os, sqlite3, subprocess, sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(ROOT, 'vendor'))
DB_PATH = os.path.join(ROOT, 'data_server', 'medagent.db')
CFG_PATH = os.path.join(ROOT, 'data_server', 'config.json')
BK_DIR = os.path.join(ROOT, 'data_server', 'backups')


def backend_cfg():
    try:
        with open(CFG_PATH) as f:
            cfg = json.load(f)
    except Exception:
        cfg = {}
    db = cfg.get('db') or {}
    mysql = {'host': '127.0.0.1', 'port': 3306, 'user': 'medagent', 'password': '', 'database': 'medagent'}
    mysql.update(db.get('mysql') or {})
    return os.environ.get('MEDAGENT_DB_BACKEND') or db.get('backend') or 'sqlite', mysql


def prune(prefix, keep):
    files = sorted(glob.glob(os.path.join(BK_DIR, prefix + '*')), reverse=True)
    for old in files[keep:]:
        os.remove(old)
        print('清理过期备份：' + os.path.basename(old))


def backup_sqlite():
    stamp = datetime.datetime.now().strftime('%Y%m%d-%H%M%S')
    dest = os.path.join(BK_DIR, 'medagent-%s.db' % stamp)
    src = sqlite3.connect(DB_PATH)
    dst = sqlite3.connect(dest)
    with dst:
        src.backup(dst)  # 在线备份，服务运行中也可执行（WAL 安全）
    dst.close()
    src.close()
    print('SQLite 备份完成：%s' % dest)
    return 'medagent-'


def backup_mysql(m):
    stamp = datetime.datetime.now().strftime('%Y%m%d-%H%M%S')
    dest = os.path.join(BK_DIR, 'medagent-mysql-%s.sql.gz' % stamp)
    cmd = ['mysqldump', '-h', m['host'], '-P', str(m['port']), '-u', m['user'],
           '--single-transaction', '--default-character-set=utf8mb4', m['database']]
    env = dict(os.environ, MYSQL_PWD=m['password'])  # 密码经环境变量传递，不出现在进程列表
    r = subprocess.run(cmd, env=env, capture_output=True)
    if r.returncode != 0:
        print('mysqldump 失败：%s' % r.stderr.decode('utf-8', 'replace').strip())
        sys.exit(1)
    with gzip.open(dest, 'wb') as f:
        f.write(r.stdout)
    print('MySQL 备份完成：%s（%d KB）' % (dest, len(r.stdout) // 1024))
    return 'medagent-mysql-'


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--keep', type=int, default=14)
    a = ap.parse_args()
    os.makedirs(BK_DIR, exist_ok=True)
    backend, m = backend_cfg()
    if backend == 'mysql':
        prefix = backup_mysql(m)
    else:
        if not os.path.isfile(DB_PATH):
            print('SQLite 库不存在：%s' % DB_PATH)
            sys.exit(0)
        prefix = backup_sqlite()
    prune(prefix, a.keep)


if __name__ == '__main__':
    main()
