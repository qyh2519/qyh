# 网页版 DeepSeek 网关使用说明

把 chat.deepseek.com 网页版封装成 OpenAI 兼容接口，让 DSH 的模型列表里多出「网页版DS」选项。

## 文件位置

| 文件 | 作用 |
|---|---|
| `/data/dsh/home/deepseek-web-gateway.mjs` | 网关程序，不需要修改 |
| `/data/dsh/home/gateway-credentials.json` | 账号文件，密码明文存储，权限 600 |
| `/data/dsh/settings.yaml` | DSH 配置，已含网页版DS provider |

以上都是容器内路径。SSH 登录宿主机时，直接执行 `bash /data/dsh/home/...` 会报 No such file or directory，因为 DSH 跑在 Docker 容器里。需要先进入容器：

```bash
docker ps                                    # 查容器 ID
docker exec -it <容器ID> bash                # 进入容器
```

进入容器后就能直接用上述路径。也可以不进入容器，用一条命令执行：

```bash
docker exec -it <容器ID> bash /data/dsh/home/setup-gateway.sh
docker exec -it <容器ID> bash /data/dsh/home/start-gateway.sh
docker exec -it <容器ID> tail -f /data/dsh/home/gateway.log
```

## 开始使用

### 1. 录入账号

```bash
bash /data/dsh/home/setup-gateway.sh
```

按提示输入账号邮箱和密码。密码输入时不显示。脚本会写入 `gateway-credentials.json`，权限 600。网关若在运行会自动重启。

支持多个账号，重复执行本脚本会追加新账号，按邮箱去重，不覆盖已有的。

### 2. 启动网关

```bash
bash /data/dsh/home/start-gateway.sh
```

健康检查通过会输出 `{"status":"ok","accountConfigured":true,...}`。DSH 重启后执行这一条即可。

停止网关：

```bash
bash /data/dsh/home/stop-gateway.sh
```

### 3. 在 DSH 里选择模型

1. 刷新 DSH 网页
2. 输入框上方打开模型选择，或输入 `/model`
3. 在「网页版DS」分组里选 `DeepSeek 网页版` 或 `DeepSeek 网页版(思考)`
4. 发送消息即可，首次发送时网关会自动登录账号，登录过程见 gateway.log

网页版账号免费，登录和聊天走网页版额度，与官方 API 计费无关。

## 风控规避

网关内置模拟真人的机制，降低被风控的概率：

| 机制 | 默认值 | 作用 |
|---|---|---|
| 请求间随机延迟 | 1 到 4 秒 | 两次提问之间随机停顿 |
| 流式输出速度 | 每块 60 到 220 毫秒 | 接近真人打字速度 |
| 账号冷却 | 15 秒 | 同一账号 15 秒内不重复使用 |
| 被禁言账号 | 自动跳过 | 禁言到期自动恢复 |

参数可通过环境变量调整：

```bash
HUMAN_DELAY_MIN=2000 HUMAN_DELAY_MAX=6000 ACCOUNT_COOLDOWN_MS=30000 \
  nohup node /data/dsh/home/deepseek-web-gateway.mjs > /data/dsh/home/gateway.log 2>&1 &
```

| 变量 | 说明 |
|---|---|
| `HUMAN_DELAY_MIN` / `HUMAN_DELAY_MAX` | 请求间延迟范围，毫秒 |
| `STREAM_PAUSE_MIN` / `STREAM_PAUSE_MAX` | 流式输出块间隔，毫秒 |
| `ACCOUNT_COOLDOWN_MS` | 账号冷却时间，毫秒 |
| `HUMANIZE=0` | 关闭全部拟人化 |

## 工具调用

网关可以把 OpenAI 格式的 `tools` 传给网页版，并容错解析模型的各种输出格式，包括 `<bash>`、`<execute_command>`、`<execute_ipython>`、代码块和 DSML。

网页版模型的工具调用不稳定，每次输出方式可能不同，有时直接回答而不调用工具。需要工具的任务建议用官方 API 模型。

## 模型选择建议

| 场景 | 选哪个模型 |
|---|---|
| 聊想法、讨论方案、列要点 | 网页版DS |
| 生成代码 | 百炼免费额度或 DeepSeek-V4-Flash |
| 运行验证 | 官方模型 |

切换模型后同一会话的历史内容会保留。在某个会话里切过模型后，它会成为默认模型。

## 独立测试网关

不经过 DSH 直接测：

```bash
curl http://127.0.0.1:8787/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{"model":"deepseek-chat","messages":[{"role":"user","content":"你好"}]}'
```

正常返回 JSON，`choices[0].message.content` 是回答内容。

## 故障排查

**提示未配置账号**：第 1 步没执行，或 `gateway-credentials.json` 内容不对。

**登录失败，提示响应中没有找到 token**：网页版登录接口可能已变更，或账号密码错误，或触发了风控。查看 `gateway.log` 最近几行。

**聊天报 HTTP 4xx 或 5xx**：查看日志定位。

**模型列表里看不到网页版DS**：刷新页面。仍然没有的话，检查 `settings.yaml` 里 `llm-pi-ai.providers.deepseek-web` 是否还在。
