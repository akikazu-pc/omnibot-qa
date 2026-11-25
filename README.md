# omnibot-qa

多平台 IM 客服 **QA 沉淀系统**。收集企业微信、小红书、抖音等平台的客服对话，自动配对成「问题-答案」，人工确认后沉淀为可复用的客服知识库。

> 核心价值：**让机器人学会你的说话方式**。不是一次性训练，而是边服务边积累。

## 它解决什么问题

客服每天回答大量重复问题，但答案散落在聊天窗口里，过两天就找不到了。

这个项目做三件事：

1. **收集** —— 接各平台回调，把对话按会话归档（SQLite）
2. **配对** —— 自动识别「客户问」→「我方答」，生成 QA 候选
3. **沉淀** —— 人工确认后导出为 JSONL，直接喂给 LangBot / RAG 知识库

## 支持的平台

| 平台 | 接入方式 | 状态 |
| --- | --- | --- |
| 企业微信（自建应用） | 官方回调 API | ✅ 已支持 |
| 企业微信（智能机器人） | 官方 API，支持 WS 长连接 | ✅ 已支持 |
| 小红书（企业专业号） | 聚光平台三方客服 → 开放平台 webhook | ✅ 已支持 |
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
node cli.js demo      # 跑演示，看配对效果
node cli.js stats     # 统计

# 启动收集服务
node server.js        # 默认 127.0.0.1:8787
```

## CLI

```bash
node cli.js pair                      # 扫描全部会话，配对 QA
node cli.js list --status pending     # 待审核列表
node cli.js approve 3 "标准答案"       # 确认某条
node cli.js reject 5 "答案过时"        # 驳回
node cli.js stats                     # 统计
node cli.js export --out qa.jsonl     # 导出已确认 QA
```

## HTTP 接口

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| POST | `/hook/wecom` | 企业微信自建应用回调（明文 JSON） |
| POST | `/hook/wecombot` | 企业微信智能机器人回调 |
| POST | `/hook/xhs` | 小红书 webhook |
| POST | `/api/reply` | **回报我方发出的消息**（配对答案的关键） |
| POST | `/api/pair` | 手动触发配对 |
| GET | `/api/qa?status=pending` | 列出 QA |
| POST | `/api/qa/:id/approve` | 确认 |
| GET | `/api/export` | 导出 JSONL |
| GET | `/health` | 健康检查 |

### ⚠️ 为什么需要 `/api/reply`

**企业微信和小红书都不会把「我方回复」回调给我们**——回调只推客户发来的消息。

所以要配出 QA，你的机器人每发出一条消息，都必须回报一次：

```bash
curl -X POST http://127.0.0.1:8787/api/reply \
  -H "Content-Type: application/json" \
  -d '{"to_user":"zhangsan","content":"基础版 299 元/月"}'
```

如果你用 LangBot 做回复，需要加一个 hook 把发出的消息转发到这个接口。

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
│   ├── message.js    # 统一消息模型（跨平台抽象的核心）
│   └── store.js      # SQLite 存储
├── adapters/
│   ├── wecom.js      # 企业微信
│   └── xhs.js        # 小红书
├── qa/
│   └── pair.js       # QA 配对引擎
├── tests/
│   └── core.test.js  # 28 个用例
├── cli.js
└── server.js
```

## 测试

```bash
node --test "tests/**/*.test.js"
```

## 与 LangBot 的关系

[LangBot](https://github.com/langbot-app/LangBot) 负责**接平台 + 回复**，本项目负责**沉淀 QA + 建知识库**。

两者组合：

```
客户 ──▶ LangBot（接平台、调用大模型回复）
              │
              ├──▶ /api/reply 回报发出的消息
              ↓
         omnibot-qa（归档 + 配对 + 审核）
              ↓
         qa.jsonl ──▶ LangBot 知识库（下次回答更准）
```

## 合规说明

- 只用各平台**官方开放接口**，不涉及 hook / 协议逆向
- 不导出、不解密任何平台的本地聊天数据库
- 建议生产环境配置 `OMNIBOT_SECRET` 做接口鉴权
- 聊天数据属于用户，归档前请确认符合公司隐私政策

## License

Apache-2.0
