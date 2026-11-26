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

| 平台 | 接入方式 | 服务对象 | 状态 |
| --- | --- | --- | --- |
| **微信客服** | 官方 API（kf） | **外部客户**（微信用户） | ✅ 已支持 · **对外唯一合规路** |
| 企业微信（智能机器人） | 官方 API，WebSocket 长连接 | **内部员工** | ✅ 已支持 |
| 企业微信（自建应用） | 官方回调 API + 主动发消息 | 内部成员 | ✅ 已支持（不能对外） |
| 企业微信（客户加好友） | 粘贴导入 / 会话内容存档 | 外部好友（只读） | ✅ 已支持（见下节） |
| 小红书（企业专业号） | 聚光平台三方客服 → 开放平台 webhook | 粉丝私信 | ✅ 收集已支持 |
| 抖音（企业号） | 开放平台私信能力 | 粉丝私信 | 🔜 待认证后接入 |
| 飞书 / 钉钉 | 预留 | — | 🔜 |

### ⚠️ 最重要的一件事：谁能被服务

**企业微信「智能机器人」是对内的，不是对外的。** 官方文档写得很清楚：

> 「在企业**内部**单聊、群聊场景中，向**员工**提供智能问答服务的 AI 工具」
> 「可见范围：支持选择通讯录组织架构或人员标签」
> 「仅支持添加至**企业内部群**……**外部群暂不支持**」

所以：**外部客户扫你的码想跟机器人聊天，智能机器人这条路走不通**，这不是配置问题，
是产品定位问题。想在微信里对外部客户自动回复，官方合规的只有 **微信客服**。

### 三条路怎么选

| | **微信客服**（对外） | 智能机器人（对内） | 自建应用（对内） |
| --- | --- | --- | --- |
| **服务谁** | **外部微信客户** | 内部员工 | 内部成员 |
| 需要公网域名 | **需要**，且要 HTTPS | **不需要** | 需要，且要 HTTPS |
| 需要备案/证书 | 需要 | 不需要 | 需要 |
| 拿到凭据 | 企业ID + Secret + Token + AESKey | BotID + Secret | CorpID + AgentId + Secret |
| 消息加解密 | 需要（AES + SHA1） | 不需要 | 需要 |
| 消息协议 | **两段式**：回调通知 → 主动拉取 | 一段式：回调直接带正文 | 回调直接带正文 |
| 能发卡片吗 | ❌ 只支持纯文本 | ✅ 支持 template_card | ✅ 支持模板卡片 |
| 代码 | `adapters/wecom-kf.js` | `adapters/wecom-bot.js` | `adapters/wecom.js` + `wecom-send.js` |

**怎么决策：**

- 客户是**外部微信用户** → 用**微信客服**（这是你要的那条路）
- 服务**内部同事**（比如运维助手） → 用**智能机器人**，本机外连，零公网配置
- 只是调**通讯录/部门接口**做客户档案 → 用**自建应用**

> 自建应用什么时候还有用？① 给内部同事做测试环境；② 调通讯录/部门接口做客户档案补全。
> 但**它不能作为对外客服的通道**，这是 API 层面的硬约束。

### 微信客服接入（对外，外部客户直接对话）

**后台配置**（<https://kf.weixin.qq.com/>，需要**企业认证**）：

1. 登录 → **企业信息** → 记下**企业ID**（形如 `wk...`）
2. 左侧 **「开发配置」** → 开启 **API 模式** → 填：
   - 回调地址：`https://你的域名/hook/kf`（**必须公网可达**，要有 HTTPS 和备案）
   - **Token**：自己设，英文数字 ≤32 位
   - **EncodingAESKey**：点「随机生成」，43 位
   - 记下页面上的 **Secret**
3. 左侧 **「客服账号」** → 建一个账号，记下它的 **open_kfid**
4. 拿到 open_kfid 后可以调 `account/link` 拿到**对外投放的客服链接**，贴到网站或公众号

**填进程序**：

```bash
npm run kf:setup     # 依次粘贴四个值，自动写 .env
npm run serve
```

**微信客服的协议是「两段式」**，和其他平台不一样，这点必须记住：

```
客户发消息
   ↓
微信客服 → 你的 /hook/kf   推一个 XML 通知「有新消息了」（不带正文！）
   ↓
你 → sync_msg 接口          主动拉取消息正文
   ↓
你 → send_msg 接口          回复客户
```

> ⚠️ **cursor 必须持久化**。sync_msg 是增量拉取，漏掉一次那批消息就**永久丢失**
> （官方没给重发机制）。程序里存在 `data/kf-cursor.json`，别删。
>
> ⚠️ 回调里的 token **10 分钟过期**，拉取时必须带上，否则接口有严格频率限制。
>
> ⚠️ 微信客服**不支持 markdown，也不支持卡片**，只发纯文本。
> 所以问价那条 URL 只能以纯文本形式发出（用户长按复制）。
> 想要可点击的卡片，得走小程序消息（需要小程序 appid）。

### 场景：客户扫码加我的企业微信好友

这是最常见的真实场景 —— 客户加你个人企微，你在企微客户端里回消息。
**这个场景有一个必须提前知道的边界：**

> 官方**没有开放**「代替你的企微账号给好友发消息」的接口。所以 AI 不可能自动代答。
> 能把消息给到你的，只有下面两条路，且都是「读」。

| | 路线 A：粘贴导入（0 成本） | 路线 B：会话内容存档（付费） |
| --- | --- | --- |
| 能拿到客户消息 | 只能手动复制的那部分 | 全量自动 |
| 费用 | 免费 | 服务版 **900 元/人/年**（仅文字）<br>企业版 1800 元/人/年（含音视频） |
| 前提 | 无 | 企业认证 + 超管开通 + 上传 RSA 公钥 + 盖章确认函 + 1-3 工作日审核 |
| 时效 | 你自己决定什么时候导 | 只能拉**最近 5 天**，必须常驻定时任务 |
| 客户会收到提示 | 不会 | **会**（客户端弹存档提示，合规要求，不可关闭） |
| 平台限制 | 无 | 官方只提供 Linux / Windows SDK，**macOS 跑不了** |
| 代码 | `adapters/paste.js` | `adapters/wecom-audit.js` |

**路线 A 的操作方式**（推荐先跑这条）：

```bash
# 在企微客户端里全选复制一段对话，存成 chat.txt，然后：
node cli.js import chat.txt --self 你的昵称 --dry   # 先预览解析结果
node cli.js import chat.txt --self 你的昵称         # 写入并自动配对
node cli.js list --status pending                   # 审核
```

也可以走 HTTP：`POST /api/import`，body 是 `{"text": "...", "self_name": "你的昵称"}`。

解析器能处理「说话人 + 时间」行、多行消息、跨天日期分隔，同一分钟的多条消息会自动补毫秒保序。

**两个路线共同的产出**：对话沉淀 → QA 库 → AI 出草稿 → **你点发送**。
不要指望它在你不在的时候自动回复外部好友 —— 官方接口层面做不到。

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

> 用 `.env` 更方便：把变量写进项目根目录 `.env`（`npm run bot:setup` 会自动生成），
> `node server.js` 和 `npm run check` 都会读它。**命令行已 export 的变量优先级更高。**

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

### 接入企业微信智能机器人（对内员工用）

> **先说清楚**：智能机器人服务的是**企业内部员工**，不是外部客户。
> 外部客户要走**微信客服**（见上面那节）。
> 智能机器人的价值是：本机主动外连，**不需要公网域名/备案/证书**就能跑，
> 适合做内部 IT 助手、运维问答这类场景。

#### 第一步：后台把机器人建出来（一次性，只在网页点）

1. 浏览器打开 <https://work.weixin.qq.com/> → 用管理员微信扫码登录 → 选你的企业
2. 左侧导航 **「智能专区」** → **「智能机器人」**
   （⚠️ **不在「应用管理」里** —— 那里只有微信客服、打卡、汇报这些内置应用，
   找不到「智能机器人」卡片是正常的，入口在「智能专区」下）
3. 点 **「创建机器人」** → 名称填 `AKIKAZU 客服`
4. 建好后进 **机器人详情**，找到 **「接收消息 / API 模式」**，选 **「长连接」**
   （⚠️ 长连接和「回调地址」二选一，切到回调地址会让现有连接立即失效）
5. 在同一页复制两个值：
   - **BotID**
   - **Secret** —— 是「长连接 Secret」，**不是** Token / EncodingAESKey / 应用 Secret

> 官方还提供另一个入口：**企微客户端 → 工作台 → 智能机器人 → 创建 → 手动创建**，
> 走这条路也是 API 模式。两条路任选其一。

#### 第二步：把两个值交给程序（不用敲命令）

```bash
npm run bot:setup      # 依次粘贴 BotID、Secret，自动写进 .env 并打码回显
npm run bot:test       # 试连一次，看到「已连接」就成了
npm run serve          # 起服务，自动读 .env
```

`bot:setup` 会做形态体检：`ww` 开头（多半是 CorpID）、长度 43（多半是
EncodingAESKey）、带空格（复制多了）都会当场拦下来。`.env` 已在 `.gitignore` 里，
权限写成 `600`。

想用环境变量而不是 `.env` 也行，**命令行已 export 的变量优先级更高**：

```bash
export WECOM_BOT_ID=你的BotID
export WECOM_BOT_SECRET=你的Secret
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
node cli.js import chat.txt --self 小王 # 导入粘贴的聊天记录（--dry 只预览）
node cli.js flow                      # 完整链路演示

# 话术库
node scripts/setup-snippets.js init   # 交互式生成 data/snippets.json
node scripts/setup-snippets.js lint   # 检查折行 / 配置错误 / 关键词冲突
node scripts/setup-snippets.js try "多少钱"  # 模拟客户提问看命中哪条
```

## HTTP 接口

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| POST | `/hook/kf` | **微信客服回调（对外渠道，两段式：先通知，再拉取）** |
| POST | `/hook/wecom` | 企业微信自建应用回调（明文 JSON） |
| POST | `/hook/wecombot` | 企业微信智能机器人回调 |
| POST | `/hook/xhs` | 小红书 webhook |
| POST | `/api/message` | 通用消息入口（平台无关，供外部插件调用） |
| POST | `/api/reply` | **回报我方发出的消息**（配对答案的关键） |
| POST | `/api/import` | 粘贴导入聊天记录（`{"text":"...","self_name":"小王"}`） |
| POST | `/api/ask` | AI 生成一条回复但不发送（调优用） |
| POST | `/api/snippet` | 预览话术匹配结果（不发送、不需要模型 key） |
| POST | `/api/price` | 预览问价发出的卡片与跳转链接（`{"text":"多少钱","lang":"ja"}`） |
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
│   ├── wecom-bot.js    # 企业微信智能机器人（WebSocket 长连接，对内，无需公网域名）
│   ├── wecom-kf.js     # 微信客服（对外，两段式：回调通知 + sync_msg 拉取）
│   └── xhs.js          # 小红书
├── qa/
│   ├── pair.js         # QA 配对引擎
│   ├── knowledge.js    # BM25 检索（中文 bigram，零依赖）
│   ├── agent.js        # 风格抽取 + prompt 组装 + 生成回复
│   ├── snippets.js     # 话术匹配（问句判定 + 优先级 + 负面词）
│   ├── card.js         # 卡片渲染 + 手机端宽度检测
│   ├── site-map.js     # 站点页面地图 + 语言前缀拼接
│   ├── lang-detect.js  # 客户语言识别（简/繁/英/日）
│   ├── price-router.js # 问价意图 → 该发哪个页面
│   ├── price-reply.js  # 组装报价卡片
│   ├── decide.js       # 回复决策：价格页 → 话术 → 模型（三层递进，各渠道共用）
│   └── env.js          # .env 解析（命令行已 export 的优先）
├── llm/
│   └── provider.js     # OpenAI 兼容调用（任何厂商都能接）
├── scripts/
│   ├── demo.js         # 完整链路演示
│   ├── e2e-bot.js      # 智能机器人端到端（假 WS + 假 LLM）
│   ├── e2e-import.js   # 粘贴导入端到端（导入→配对→检索→草稿）
│   ├── mock-llm.js     # 本地假 LLM，零成本验证
│   ├── make-card.js    # 卡片渲染 CLI
│   ├── setup-snippets.js # 话术库向导（init / lint / try）
│   ├── setup-bot.js    # 凭据向导（bot:setup / bot:test / kf:setup）
│   └── setup-check.js  # 配置检查向导
├── data/
│   ├── snippets.example.json # 话术模板（跟着仓库走）
│   └── snippets.json         # 你的实际话术（本地，不进仓库）
├── tests/              # 394 个用例
├── cli.js
└── server.js
```

## 问价就发价格表页面（模板卡片）

客户问「多少钱」，机器人不报数字，直接回一张卡片，点开就是网站的价格表。

**价格只在网站上维护一份。** 写死在话术里要改代码、要重启，改漏一个套餐就是报错价 ——
而客户截图留证，最后是你认。

### 为什么必须用模板卡片，不能用 markdown 链接

企微**单聊**里 markdown 的 `a` 标签不渲染，客户看到的是一串裸 URL，点不动。
只有模板卡片的 `card_action.type = 1` 才能真正跳转。这是硬约束，不是偏好。

### 发哪个页面：有几分信息发多细

| 客户说 | 发他 |
| --- | --- |
| 多少钱 / 价格 / 报个价 | `/service` 服务总表 |
| 装机 / 组装 多少钱 | `/service/desktop?item=assembly` |
| 笔记本清灰多少钱 | `/service/laptop?item=cleaning` |
| 装机 + 清灰 多少钱 | `/service/desktop`（台式机总页） |
| 有上门吗 | `/service/onsite`（上门区域与费用） |
| 太贵了 / 能便宜点 | **不发**，交给 AI 或人工 |

规则写死在 `qa/price-router.js`，加服务项改 `SERVICE_KEYS` 和 `SERVICE_HINTS` 即可。

**「笔记本清灰」为什么不会被台式机抢走**：中文里「清灰」「维修」两者共用，
所以判定时先看有没有笔记本语境，有就把台式机同名词压掉。

### 多语言：客户用什么语言问，就给什么语言的页面

| 语言 | 前缀 | 例 |
| --- | --- | --- |
| 简体中文 | `/zh-CN` | `akikazu.co.jp/zh-CN/service` |
| 繁体中文 | `/zh-TW` | `akikazu.co.jp/zh-TW/service` |
| 英文 | `/en-US` | `akikazu.co.jp/en-US/service` |
| 日语 | 无前缀 | `akikazu.co.jp/service` |

识别靠 `qa/lang-detect.js`：假名 → 日语（最硬的信号），
繁体专用字/繁体用词 → 繁中，纯 ASCII 且有 3 个以上字母 → 英文，其余 → 简中。

**认不出来就发简体**，绝不会因为识别失败而发错语言。

### 预览

```bash
curl -X POST http://127.0.0.1:8787/api/price \
  -H "Content-Type: application/json" \
  -d '{"text":"装机多少钱"}'

# 强制看某语言
curl -X POST http://127.0.0.1:8787/api/price \
  -H "Content-Type: application/json" \
  -d '{"text":"多少钱","lang":"ja"}'
```

返回 `url`、命中的页面、以及完整的 `card` 结构（就是会发给企微的那份 JSON）。
不发送、不需要 `OPENAI_API_KEY`。

设 `OMNIBOT_PRICE_CARD=0` 可整体关掉，退回话术 / AI。

## 话术库：报价这类内容不要交给 AI

AI 适合答「你们支持私有化吗」，不适合答「多少钱」。

原因很直接：报价、发票、试用、联系方式这些是**承诺**。模型多写一句
「老客户可以再谈」，你就多一笔扯不清的账。所以这类问题的正确答案不是
生成，而是**原样发出去**。

`data/snippets.json` 就是这个「原样发出去」的库。命中关键词 → 直发固定文案，
**不调用模型、不消耗 token、不需要 `OPENAI_API_KEY`**，零延迟零幻觉。

### 怎么配

```bash
cp data/snippets.example.json data/snippets.json   # 从模板开始

node scripts/setup-snippets.js init                # 交互式向导：问套餐/单价/优惠/电话
node scripts/setup-snippets.js lint                # 检查排版折行 + 配置错误 + 关键词冲突
node scripts/setup-snippets.js try "多少钱"         # 模拟客户提问，看命中哪条
```

改完重启服务生效。

### 一句话话术长这样

```json
{
  "id": "invoice",
  "label": "发票",
  "priority": 80,
  "keywords": ["发票", "开票", "专票", "普票", "报销"],
  "reply": "可以开发票。\n\n正式签约后按合同走：\n· 报价单 / 見積書\n· 发票 / 領収書\n..."
}
```

> ⚠️ 话术库里**不要**再放报价条目。问价已经交给
> `qa/price-router.js` → `qa/price-reply.js` 发官网价格页，两边同时存在会互相抢。
> 定制开发、试用、发票、联系方式这些没有对应网页的，才放话术。

| 字段 | 作用 |
| --- | --- |
| `keywords` | 客户话里出现任一个就触发 |
| `priority` | 多条同时命中时，数字大的赢 |
| `negative` | 出现这些词就**不**触发（「太贵了」不该甩价格表） |
| `exclude` | 话题不符就不触发（客户问「有价格表模板吗」不是在问价） |
| `requireQuestion` | 默认 `true`，必须像提问才触发；写 `false` 则无条件触发 |

### 两道闸，防止乱发价格

1. **问句判定（`looksLikeAsk`）** —— 微信里绝大多数提问根本没有问号，
   所以靠疑问词判断（多少钱/能不能/有没有/怎么…）。纯寒暄「你好」「谢谢」直接放行不触发。
2. **语义判负（`isPriceComplaint`）** —— 「价格好高」形式上像提问，实际是嫌贵。
   这种时候甩一张价格表等于火上浇油，所以报价话术一律让开，交给 AI 或人工。

### 关于「直接发价格表网页链接」

企业微信**智能机器人单聊里 markdown 的 `a` 标签不渲染**（会显示成裸 URL），
但 **`template_card` 可点、可跳转**。所以问价走的是卡片：

| 渠道 | 写法 | 单聊能否点 |
| --- | --- | --- |
| markdown `a` 标签 | `[看价格](https://...)` | ❌ 显示裸 URL |
| 纯文本 URL | `https://...` | ❌ 不可点 |
| **template_card** `card_action.type=1` | 见 `qa/price-reply.js` | ✅ 整张卡可点 |

上面那种 34 半角宽度的**卡片式文本**仍然保留，用于话术文案（发票/试用/联系方式），
`lint` 会逐行算宽度，超了会告诉你哪一行会折行。

### 在线预览卡片

```bash
curl -X POST http://127.0.0.1:8787/api/snippet \
  -H "Content-Type: application/json" \
  -d '{"text":"你们这个多少钱"}'
```

返回命中的是哪条、完整文案、以及最宽行是多少，不发送、不需要模型 key。

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

### 为什么它宁可拒答也不瞎编

客服场景最怕的不是「没答上来」，而是「答错了还答得很自然」。所以检索层设了两道闸：

1. **必备词校验** —— 查询里的稀有关键词至少命中一个。挡掉「私有化多少钱」被
   「私有化部署支持国产化环境吗」这条命中的情况（共享「私有化」一个词，但问的根本不是一件事）。
2. **分数阈值 = 1.2** —— 宁可拒答，不拿不相干的答案糊客户。

没有依据时，AI 统一回「这个我确认下再回复您」。如果走的是智能机器人自动回复，
这种情况干脆**不发声**，直接留给你人工接手 —— 免得客户以为问题被处理了。

> 知识库刚起步时（只有几条 QA），idf 上不去、绝对分数天然偏低，
> 检索会自动退一步用「查询覆盖率 ≥ 60%」兜底，否则你会发现 AI 什么都不肯答。

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
npm test                          # 394 个用例，纯本地，不联网
node scripts/e2e-import.js        # 粘贴导入全链路（假 LLM，验证结构）
OPENAI_API_KEY=sk-xx node scripts/e2e-import.js --live   # 用真模型看草稿质量
```

## 合规说明

- 只用各平台**官方开放接口**，不涉及 hook / 协议逆向
- 不导出、不解密任何平台的本地聊天数据库
- 会话内容存档属于**企业主动开通**的合规能力，客户端会明确提示客户，不可隐藏
- 建议生产环境配置 `OMNIBOT_SECRET` 做接口鉴权
- 聊天数据属于用户，归档前请确认符合公司隐私政策
- 自动回复建议开启人工复核（回复落库后可在 `/api/qa` 审核），避免答错话

## License

Apache-2.0
