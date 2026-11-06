#!/bin/bash
# 交互式录入网页版 DeepSeek 网关账号。支持多账号循环输入，写入权限 600 的文件。
# 重复执行会追加新账号，按邮箱去重，不覆盖已有账号。
set -e

CRED=/data/dsh/home/gateway-credentials.json

echo "=== 设置网页版 DeepSeek 网关账号 ==="
echo "输入密码时不显示字符，属于正常现象。"
echo "每填一组邮箱和密码后可继续填下一组，邮箱直接回车表示结束。"
echo

# 显示现有账号，不显示密码
node -e '
const fs = require("fs");
try {
  const c = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
  const l = Array.isArray(c) ? c : [c];
  const valid = l.filter(a => a && a.email && a.password);
  if (valid.length) console.log("现有账号 " + valid.length + " 个:" + valid.map(a => " " + a.email).join(","));
  else console.log("当前没有已填的有效账号。");
} catch { console.log("当前没有已填的有效账号。"); }
' "$CRED"

TMP=$(mktemp)
trap 'rm -f "$TMP"' EXIT
count=0

while true; do
  read -r -p "新增账号邮箱（直接回车结束）: " EMAIL
  if [ -z "$EMAIL" ]; then
    break
  fi
  read -r -s -p "该账号密码: " PASS
  echo
  if [ -z "$PASS" ]; then
    echo "密码为空，这一组忽略，请重新输入。"
    continue
  fi
  echo "$EMAIL|$PASS" >> "$TMP"
  count=$((count+1))
  echo "已记录第 $count 组"
done

if [ "$count" -eq 0 ]; then
  echo "没有新增账号，现有账号保持不变。"
  bash /data/dsh/home/start-gateway.sh
  exit 0
fi

# 合并写入：保留现有账号加新增账号，按邮箱去重。
# 写入前清洗退格符，防止终端粘贴或退格污染密码。
node -e '
const fs = require("fs");
const path = "/data/dsh/home/gateway-credentials.json";
let existing = [];
try {
  const cfg = JSON.parse(fs.readFileSync(path, "utf8"));
  existing = Array.isArray(cfg) ? cfg : [cfg];
} catch {}
const clean = (s) => {
  const st = [];
  for (const ch of s) { if (ch === "\b") st.pop(); else st.push(ch); }
  return st.join("");
};
const lines = fs.readFileSync(process.argv[1], "utf8").trim().split("\n").filter(Boolean);
const added = lines.map((l) => {
  const i = l.indexOf("|");
  return { email: l.slice(0, i).trim(), password: clean(l.slice(i + 1)) };
}).filter((a) => a.email && a.password);
if (added.length < lines.length) {
  console.log("有 " + (lines.length - added.length) + " 组因密码为空被忽略，请重填");
}
const seen = new Set(existing.filter(a => a && a.email).map(a => a.email));
const merged = [...existing.filter(a => a && a.email && a.password), ...added.filter(a => !seen.has(a.email))];
fs.writeFileSync(path, JSON.stringify(merged, null, 2) + "\n", { mode: 0o600 });
console.log("账号文件现有 " + merged.length + " 个账号（原有 " + existing.length + " 个，新增 " + added.length + " 个）");
' "$TMP"

echo "重启网关以应用新账号..."
bash /data/dsh/home/start-gateway.sh
