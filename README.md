# 网页版 DeepSeek 网关

把 chat.deepseek.com 网页版封装成 OpenAI 兼容接口。

## 目录结构

### scripts/

| 文件 | 作用 |
|---|---|
| `deepseek-web-gateway.mjs` | 网关主程序，负责登录、会话、PoW、聊天，支持多账号轮换 |
| `tool-support.mjs` | 解析工具调用输出的容错模块 |
| `start-gateway.sh` | 启动网关，重复执行无副作用 |
| `stop-gateway.sh` | 停止网关 |
| `setup-gateway.sh` | 交互式录入账号 |
| `gateway-README.md` | 使用说明 |
| `settings.yaml` | DSH 配置示例，含 deepseek-web 和 bailian 两个 provider |

### plugin/

| 文件 | 作用 |
|---|---|
| `gw-autostart` | DSH 启动时自动拉起网关，失败不影响 DSH |

## 安装步骤

```bash
# 1. 部署脚本
cp -r scripts/* /data/dsh/home/

# 2. 合并 settings.yaml 到现有配置，注意保留原有内容

# 3. 安装插件
mkdir -p /data/dsh/profiles/node_modules/@dsh-user/gw-autostart
cp plugin/* /data/dsh/profiles/node_modules/@dsh-user/gw-autostart/

# 4. 确认 cordis.patch.yml 里有 gw-autostart 插件行

# 5. 启动网关
bash /data/dsh/home/start-gateway.sh

# 6. 录入账号
bash /data/dsh/home/setup-gateway.sh
```

## 配置说明

`scripts/settings.yaml` 里 `bailian` 段引用 `BAILIAN_API_KEY` 环境变量，密钥由使用者自行提供。

只使用网页版网关时，可以删掉 `bailian` 整段，只保留 `deepseek-web` 部分，然后把 `agent-default-model` 指向 `deepseek-web`。

`free-pool` 段记录各模型额度的耗尽状态，属于运行时数据，安装时可以整段删掉，程序会自动重建。
