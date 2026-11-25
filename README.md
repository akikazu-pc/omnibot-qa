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
| 企业微信（智能机器人） | 官方 API，支持 WS 长连接 | ✅ 收集已支持，自动回复待接 |
| 小红书（企业专业号） | 聚光平台三方客服 → 开放平台 webhook | ✅ 收集已支持 |
| 抖音（企业号） | 开放平台私信能力 | 🔜 待认证后接入 |
| 飞书 / 钉钉 | 预留 | 🔜 |

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

再配企业微信凭据才能真正发出去（不配则只落库不发送，方便先观察效果）：

```bash
export WECOM_CORP_ID=ww1a2b3c4d5e6f7g8h
export WECOM_AGENT_ID=1000002
export WECOM_SECRET=xxx
```

### 先看看 AI 会怎么答（不发送）

```bash
curl -X POST http://127.0.0.1:8787/api/ask \
  -H "Content-Type: application/json" \
  -d '{"question":"你们能私有化部署吗"}'
```

返回里会带上**命中的知识库条目**和**用了多少条风格样本**，方便调优。

### 本地零成本试用

不想花额度也能验证链路 —— 内置一个假的 OpenAI 兼容服务：

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
│   ├── wecom-send.js   # 企业微信（发，含 token 缓存）
│   └── xhs.js          # 小红书
├── qa/
│   ├── pair.js         # QA 配对引擎
│   ├── knowledge.js    # BM25 检索（中文 bigram，零依赖）
│   └── agent.js        # 风格抽取 + prompt 组装 + 生成回复
├── llm/
│   └── provider.js     # OpenAI 兼容调用（任何厂商都能接）
├── scripts/
│   ├── demo.js         # 完整链路演示
│   └── mock-llm.js     # 本地假 LLM，零成本验证
├── tests/              # 57 个用例
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
