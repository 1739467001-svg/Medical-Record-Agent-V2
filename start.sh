#!/bin/bash
# AI 病历智能体 · 启动脚本（M2.0：默认 BFF 服务端模式）
cd "$(dirname "$0")"
PORT=${1:-8801}
echo "=============================================="
echo "  AI 病历智能体 · 医生端（演示环境）"
echo "  http://localhost:${PORT}"
echo "=============================================="
if [ -f server.py ]; then
  echo "模式：BFF 服务端（留痕/归档入库 data_server/medagent.db，密钥仅存 data_server/config.json）"
  echo "演示账号：张岩（普外科）/ 刘博（神经内科）｜ 停止：Ctrl+C"
  exec /usr/bin/python3 server.py "$PORT"
fi
echo "（未找到 server.py，退回纯静态模式：数据仅存本机浏览器）"
/usr/bin/python3 -m http.server "$PORT"
