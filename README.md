# omnibot-qa

多平台 IM 客服 **QA 沉淀系统**。收集企业微信、小红书、抖音等平台的客服对话，自动配对成「问题-答案」，人工确认后沉淀为可复用的客服知识库。

[![test](https://github.com/akikazu-pc/omnibot-qa/actions/workflows/test.yml/badge.svg)](https://github.com/akikazu-pc/omnibot-qa/actions/workflows/test.yml)

> 核心价值：**让机器人学会你的说话方式**。不是一次性训练，而是边服务边积累。

## 它解决什么问题

客服每天回答大量重复问题，但答案散落在聊天窗口里，过两天就找不到了。

这个项目做四件事：

1. **收集** —— 接各平台回调，把对话按会话归档（SQLite）
2. **配对** —— 自动识别「客户问」→「我方答」，生成 QA 候选
3. **沉淀** —— 人工确认后进知识库，检索即用
4. **代答** —— 拿沉淀的 QA + 你的真实回复风格，用大模型自动回复客户

第 4 步是重点：**回复时会模仿你自己的说话方式**。做法是把历史上真实的人工回复
作为 few-shot 示例塞进 system prompt，模型自然学会你的语气、长度、口头禅 ——
不是微调，不训练模型，加一条数据就立刻生效。

## 支持的平台

| 平台 | 接入方式 | 状态 |
| --- | --- | --- |
| 企业微信（自建应用） | 官方回调 API + 主动发消息 | ✅ 已支持 |
| 企业微信（智能机器人） | 官方 API，WebSocket 长连接 | ✅ 已支持（推荐，无需公网域名） |
| 小红书（企业专业号） | 聚光平台三方客服 → 开放平台 webhook | ✅ 收集已支持 |
| 抖音（企业号） | 开放平台私信能力 | 🔜 待认证后接入 |
| 飞书 / 钉钉 | 预留 | 🔜 |

### 企业微信接入：两条路怎么选

| | 智能机器人（长连接） | 自建应用（回调） |
| --- | --- | --- |
| 需要公网域名 | **不需要** | 需要，且要 HTTPS |
| 需要备案/证书 | 不需要 | 需要 |
| 拿到凭据 | BotID + Secret | CorpID + AgentId + Secret |
| 消息加解密 | 不需要 | 需要（AES + SHA1 签名） |
| 能给外部客户发消息 | 可以 | **不行**，只能发给本企业成员 |
| 代码 | `adapters/wecom-bot.js` | `adapters/wecom.js` + `wecom-send.js` |

**默认推荐智能机器人**：本机主动外连就能收消息，开发环境零配置。

**如果你的客户是外部微信用户（不是本企业成员）**，只有智能机器人和「微信客服」能触达；
自建应用发不出消息，那时需要另外接微信客服（`kf` 接口），代码里已留了 `wecom_cs` 平台位。

> 自建应用什么时候还有用？① 给内部同事做测试环境；② 调通讯录/部门接口做客户档案补全。
> 但**它不能作为对外客服的通道**，这是 API 层面的硬约束，不是配置问题。

### 小红书接入前提

1. 企业专业号认证
2. **聚光平台推广资质认证**（关键卡点，需单独申请）
3. 聚光平台 → 工具 → 三方客服管理 → 授权
4. 商业开放平台创建应用，回调地址填 `https://你的域名/hook/xhs`

注意：小红书**只能收发粉丝私信**，且与电商客服、小程序客服是独立系统。

## 快速开始

```bash
# 零依赖，只要 Node >= 22.5（用内置 node:sqlite）
node cli.js flow       # 完整链路演示：采集→配对→检索→提示词（纯本地，不需要网络）
node cli.js demo       # 只演示配对逻辑
node cli.js stats      # 统计
npm run check          # 检查环境变量配置，告诉你缺什么

# 启动服务
node server.js         # 默认 127.0.0.1:8787
```

### 开启自动回复

```bash
export OPENAI_API_KEY=sk-xxx                  # 必填
export OPENAI_BASE_URL=https://api.deepseek.com/v1   # 可选，任何 OpenAI 兼容服务
export OPENAI_MODEL=deepseek-chat              # 可选
export BOT_PERSONA="你是XX公司的客服小助手"     # 可选，人设
export BOT_BUSINESS="我们卖SaaS客服系统，支持私有化部署"  # 可选，业务背景
export AUTO_REPLY=1                            # 开启自动回复
node server.js
```

配好凭据后 `npm run check` 会告诉你还缺什么。

### 接入企业微信智能机器人（推荐，能对接外部客户）

> **为什么必须用它**：企业微信「自建应用」的消息 API 只接受**本企业通讯录内的 userid**，
> 发不到外部客户。要对外部客户做客服，只有智能机器人和微信客服能触达。

**后台配置四步**：

1. 企业微信管理后台 → **应用管理 → 应用 → 自建 → 「+ 创建应用」**
   （「消息推送」不行，它没有 API 权限）
2. 应用类型选 **智能机器人**，填名称，创建
3. 进入机器人详情 → 开启 **「API 模式」** → 选择 **「长连接」** 方式
   （⚠️ 只能在「长连接」和「回调地址」里二选一，切到回调地址会让现有长连接立即失效）
4. 复制 **BotID** 和 **Secret**（这是长连接专用 Secret，不是 Token/EncodingAESKey）

```bash
export WECOM_BOT_ID=你的BotID
export WECOM_BOT_SECRET=你的Secret
export OPENAI_API_KEY=sk-xxx
export AUTO_REPLY=1
node server.js
```

启动后日志应该长这样：

```
🔌 企业微信智能机器人长连接启动中…
[ws] 连接中
[ws] 握手鉴权中
[ws] ✅ 已连接
```

看到 `✅ 已连接` 说明订阅成功。本机主动外连 `wss://openws.work.weixin.qq.com`，
**不需要公网域名 / 备案 / HTTPS 证书 / 消息加解密**。

收到消息会走完整链路：

```
客户发消息 → WS 推送 → 落库 → 检索已审核QA → 抽你的说话风格
          → 大模型生成 → aibot_respond_msg 回帧 → 落库 outbound → 配对出待审核 QA
```

**协议细节**（按官方 SDK `@wecom/aibot-node-sdk` 实现，不是猜的）：

| 动作 | cmd | 说明 |
| --- | --- | --- |
| 鉴权 | `aibot_subscribe` | `body: { bot_id, secret }` |
| 心跳 | `ping` | 建议 30 秒 |
| 收消息 | `aibot_msg_callback` | `body.msgtype` / `from.userid` / `text.content` |
| 回复 | `aibot_respond_msg` | `body: { msgtype:'stream', stream:{ id, finish, content } }` |
| 主动推送 | `aibot_send_msg` | 无需用户先说话 |

**注意**：同一机器人**同时只能有一个长连接**，新连接会踢掉旧连接。
本地调试时别在多个终端同时跑。

### 先看看 AI 会怎么答（不发送）

```bash
curl -X POST http://127.0.0.1:8787/api/ask \
  -H "Content-Type: application/json" \
  -d '{"question":"你们能私有化部署吗"}'
```

返回里会带上**命中的知识库条目**和**用了多少条风格样本**，方便调优。

### 本地零成本试用

不需要真实凭据也不花钱 —— 直接跑端到端验证（模拟企业微信推送）：

```bash
node scripts/e2e-bot.js
```

它会用假 WebSocket 走完：订阅鉴权 → 收到消息 → AI 生成 → stream 回帧 → 落库 → 配对 QA。

或者起个假 LLM 配真服务：

```bash
node scripts/mock-llm.js 8899     # 终端 1
OPENAI_API_KEY=mock OPENAI_BASE_URL=http://127.0.0.1:8899/v1 AUTO_REPLY=1 node server.js  # 终端 2
```

## CLI

```bash
node cli.js pair                      # 扫描全部会话，配对 QA
node cli.js list --status pending     # 待审核列表
node cli.js approve 3 "标准答案"       # 确认某条
node cli.js reject 5 "答案过时"        # 驳回
node cli.js stats                     # 统计
node cli.js export --out qa.jsonl     # 导出已确认 QA
node cli.js flow                      # 完整链路演示
```

## HTTP 接口

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| POST | `/hook/wecom` | 企业微信自建应用回调（明文 JSON） |
| POST | `/hook/wecombot` | 企业微信智能机器人回调 |
| POST | `/hook/xhs` | 小红书 webhook |
| POST | `/api/message` | 通用消息入口（平台无关，供外部插件调用） |
| POST | `/api/reply` | **回报我方发出的消息**（配对答案的关键） |
| POST | `/api/ask` | AI 生成一条回复但不发送（调优用） |
| POST | `/api/pair` | 手动触发配对 |
| GET | `/api/qa?status=pending` | 列出 QA |
| POST | `/api/qa/:id/approve` | 确认 |
| GET | `/api/export` | 导出 JSONL |
| GET | `/health` | 健康检查 |

### ⚠️ 为什么需要 `/api/reply`

**企业微信和小红书都不会把「我方回复」回调给我们**——回调只推客户发来的消息。

开启 `AUTO_REPLY=1` 时本服务自己发的回复会自动落库，不用你操心。
但如果你用别的系统（人工、LangBot 等）回复，每发一条都必须回报一次：

```bash
curl -X POST http://127.0.0.1:8787/api/reply \
  -H "Content-Type: application/json" \
  -d '{"to_user":"zhangsan","content":"基础版 299 元/月"}'
```

## 配对规则

| 规则 | 说明 |
| --- | --- |
| 配对窗口 | 问题与答案间隔不超过 **30 分钟** |
| 连发合并 | 客户连发多条，合并成一个问题 |
| 追索取最后 | 客户追问后我方作答，以最后一个问题为准 |
| 一答一用 | 同一条答案只配一个问题 |
| 未答识别 | 问了没人答的问题单独记录 —— **这是知识库最大的缺口** |

## 数据结构

统一消息模型（`collector/message.js`），所有平台归一化：

```js
{
  id,                 // 全局唯一
  platform,           // wecom / xhs / douyin
  conversation_id,    // 会话主键
  sender_id,
  sender_name,
  direction,          // inbound(客户问) / outbound(我方答) / system
  msg_type,           // text / image / file / voice / video / card / event
  content,
  timestamp,          // 毫秒
  is_group,
  raw,                // 平台原始报文，便于追溯
}
```

下游逻辑完全不感知平台差异——接入新平台只需写一个 adapter。

## 目录结构

```
omnibot-qa/
├── collector/
│   ├── message.js      # 统一消息模型（跨平台抽象的核心）
│   └── store.js        # SQLite 存储
├── adapters/
│   ├── wecom.js        # 企业微信（收）
│   ├── wecom-send.js   # 企业微信自建应用（发，含 token 缓存）
│   ├── wecom-bot.js    # 企业微信智能机器人（WebSocket 长连接，无需公网域名）
│   └── xhs.js          # 小红书
├── qa/
│   ├── pair.js         # QA 配对引擎
│   ├── knowledge.js    # BM25 检索（中文 bigram，零依赖）
│   └── agent.js        # 风格抽取 + prompt 组装 + 生成回复
├── llm/
│   └── provider.js     # OpenAI 兼容调用（任何厂商都能接）
├── scripts/
│   ├── demo.js         # 完整链路演示
│   ├── mock-llm.js     # 本地假 LLM，零成本验证
│   └── setup-check.js  # 配置检查向导
├── tests/              # 70 个用例
├── cli.js
└── server.js
```

## 自动回复是怎么模仿你的

不是微调，也不是训练。三步拼出来：

**1. 抽风格样本** —— 从历史 `outbound` 消息里挑长度适中、不重复的真实回复：

```
- 这个我们支持的哈，走年度合同就行
- 发票可以开，专票普票都行，你告诉我要哪种
```

**2. 检索知识** —— 用 BM25（中文二元切分）从已审核 QA 里找最相关的 3 条作为事实依据。

**3. 一起塞进 system prompt** —— 人设 + 业务背景 + 参考问答 + 风格样本 + 回复约束。

模型拿到这些，语气自然就贴合了。想调整说话方式？不用改代码，
在系统里多积累几条你自己的真实回复，效果立刻变。

## 与 LangBot 的关系

两条路都能走：

**A. 只用本项目（已可跑通）** —— 接平台、回消息、沉淀 QA、建知识库全包，零依赖。

**B. 本项目 + LangBot** —— LangBot 负责接更多平台/复杂编排，本项目负责沉淀与检索：

```
客户 ──▶ LangBot（接平台、调大模型）
              │
              ├──▶ /api/reply 回报发出的消息
              ↓
         omnibot-qa（归档 + 配对 + 审核）
              ↓
         qa.jsonl ──▶ LangBot 知识库
```

> 注：LangBot 的插件体系需要独立的 Plugin Runtime 容器（Docker），本地跑通成本较高。
> 本项目的自动回复不依赖它。

## 测试

```bash
npm test      # 57 个用例，纯本地，不联网
```

## 合规说明

- 只用各平台**官方开放接口**，不涉及 hook / 协议逆向
- 不导出、不解密任何平台的本地聊天数据库
- 建议生产环境配置 `OMNIBOT_SECRET` 做接口鉴权
- 聊天数据属于用户，归档前请确认符合公司隐私政策
- 自动回复建议开启人工复核（回复落库后可在 `/api/qa` 审核），避免答错话

## License

Apache-2.0
