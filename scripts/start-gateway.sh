#!/bin/bash
# 启动网页版 DeepSeek 网关。不依赖 pgrep/pkill/ps，DSH 重启后执行一次即可。

if curl -s --max-time 2 http://127.0.0.1:8787/health > /dev/null 2>&1; then
  echo "网关已在运行，无需重复启动。"
  curl -s http://127.0.0.1:8787/health
  echo
  exit 0
fi

nohup node /data/dsh/home/deepseek-web-gateway.mjs > /data/dsh/home/gateway.log 2>&1 &
sleep 1

if curl -s --max-time 3 http://127.0.0.1:8787/health > /dev/null 2>&1; then
  echo "网关已启动。"
  curl -s http://127.0.0.1:8787/health
  echo
  echo "日志: /data/dsh/home/gateway.log"
else
  echo "网关启动失败，查看日志: tail /data/dsh/home/gateway.log"
  exit 1
fi
