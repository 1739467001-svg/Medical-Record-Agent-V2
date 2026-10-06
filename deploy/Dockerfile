# AI 病历智能体 BFF · 生产镜像
# 构建：docker build -t medagent .
# 运行：见 docker-compose.yml（数据卷持久化 data_server/）
# 说明：项目零第三方依赖（pymysql 已随 vendor/ 打包），基础镜像无需额外安装
FROM python:3.11-slim

WORKDIR /app

# 先拷贝依赖目录利用层缓存，再拷贝应用
COPY vendor/ ./vendor/
COPY server.py start.sh ./
COPY index.html css js opd data_records tools docs ./

# 非 root 运行
RUN useradd -r -u 10001 medagent && mkdir -p /app/data_server && chown -R medagent /app
USER medagent

# 存储后端：默认 sqlite；切 MySQL 设 MEDAGENT_DB_BACKEND=mysql（db 节配置见运维手册第八章）
ENV MEDAGENT_DB_BACKEND=sqlite
EXPOSE 8801

HEALTHCHECK --interval=30s --timeout=5s --retries=3 \
  CMD python3 -c "import urllib.request;urllib.request.urlopen('http://127.0.0.1:8801/api/health',timeout=3)"

CMD ["python3", "server.py", "8801"]
