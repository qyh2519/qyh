#!/bin/bash
# 停止网页版 DeepSeek 网关。不依赖 pgrep/pkill，用 node 扫描 /proc 定位进程。

node -e '
const fs = require("fs");
let found = false;
for (const pid of fs.readdirSync("/proc")) {
  if (!/^\d+$/.test(pid)) continue;
  try {
    const cmd = fs.readFileSync(`/proc/${pid}/cmdline`, "utf8").replace(/\0/g, " ").trim();
    // 只匹配 node 网关进程，避免误杀命令行里含文件名的 shell
    const parts = cmd.split(" ");
    const isNode = parts[0] && parts[0].endsWith("node");
    if (isNode && parts.includes("deepseek-web-gateway.mjs")) {
      try {
        process.kill(+pid, "SIGTERM");
        found = true;
        console.log("已发送停止信号给进程", pid);
      } catch (e) {
        console.log("停止进程", pid, "失败:", e.message);
      }
    }
  } catch {}
}
if (!found) console.log("没有发现运行中的网关进程。");
'

sleep 1
if curl -s --max-time 2 http://127.0.0.1:8787/health > /dev/null 2>&1; then
  echo "网关仍在响应，稍等几秒再试，或手动 kill。"
else
  echo "网关已停止。"
fi
