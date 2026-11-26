# 交接文档 · omnibot-qa

> 用途：新对话开始前一分钟读完，知道现在在哪、下一步做什么。
> 生成时间：2026-11-26 12:20 (JST)

---

## 一、这个项目要干什么

做一个**模仿我说话方式的客服机器人**，服务**外部客户**（客户扫码来问，机器人用我的口吻答）。

- 公司业务：日本电脑服务公司（上门装机 / 清灰 / 维修 / 回收 / 升级加装）
- 官网：`https://www.akikazu.co.jp`（简体中文 `/zh-CN`、繁体 `/zh-TW`、英文 `/en-US`、日文 `/ja`）
- 定位：合规路线，企业微信官方能力，公司内部用
- 开源：`https://github.com/akikazu-pc/omnibot-qa`（Apache-2.0，项目名故意做泛用，后续要接小红书/抖音）

---

## 二、最重要的架构结论（别再走弯路）

| 渠道 | 服务对象 | 能不能接外部客户 | 结论 |
|---|---|---|---|
| **微信客服**（kf） | 外部客户 | ✅ 能 | **对外就走这条** |
| 企业微信智能机器人 | 内部员工 | ❌ 不能 | 官方定位就是员工 AI 助手，外部群不支持 |
| 自建应用 | 内部员工 | ❌ 不能 | 已停止推进 |
| 小红书 | 外部客户 | ⚠️ 需企业号 API | 企业号已有，暂缓 |

**踩过的坑**：之前判断"智能机器人能对接外部客户"，是错的。官方原文写的是「在企业**内部**单聊、群聊场景中，向**员工**提供智能问答服务」「仅支持添加至企业内部群……外部群暂不支持」。已全面纠正（README、启动日志、`setup-check.js` 都改过了）。

**智能机器人入口不在「应用管理」**，在 **智能专区** → 智能机器人。备份入口：企微客户端 → 工作台 → 智能机器人 → 创建。

---

## 三、当前进度

### 已完成并推送（`git log`）

```
45756f1  feat: 微信客服回调加解密 + 回调自检工具
e45df0c  feat: 微信客服适配器 + 架构纠正（智能机器人是对内，微信客服才是对外）
ed091dc  feat: 机器人凭据向导 + .env 支持
392a6e3  话术库移除报价条目，改由价格页卡片接管；清掉虚构价格文案
e4da50b  feat: 问价直接发对应语言的价格页（模板卡片）
ce1607b  feat: 话术库优先于 AI，问价直接回卡片
b56beaf  feat: 客户加好友场景两条路 + 防瞎答护栏
8ef237a  fix: 按官方 SDK 修正智能机器人长连接协议
```

工作区干净，与 `origin/main` 同步。**414 个测试全绿**（65 suites）。

### 代码能干什么

**回复决策是三层递进**（`qa/decide.js`，三渠道共用）：

```
问题进来
  ├─ 第 1 层：问价 → 发对应语言的网站价格页（模板卡片/文本链接），不发 AI 编的价格
  ├─ 第 2 层：命中话术库 → 直接发我写好的原话（data/snippets.json）
  └─ 第 3 层：以上都不是 → 交给模型，按我的语气生成；没有依据就拒答
```

**关键设计**：价格和话术永远优先于模型，因为这两类内容 AI 一定会编。模型只在"我确实没预设过答案"时才上场。

**微信客服全链路已打通**：

```
客户发消息
  → 企微推 XML 回调 /hook/kf（只有 token，没有正文）
  → 我们验签 + 解密 + 立刻回 200
  → 异步 sync_msg 拉正文（cursor 存 data/kf-cursor.json）
  → decide() 决策
  → send_msg 回纯文本
```

### 加解密已和官方对齐

`qa/wecom-crypto.js` 零依赖实现，对着**官方样例向量**做过回归：token `QDG6eK`、AESKey `jWmYm7qr5nMoAUwZRjGtBxmz3KA1tkAj3ykkR6q2B2C`、corpId `wx5823bf96d3bd56c7`，算出的签名 `477715d11cdb4164915debcba66cb864d751f3e6` 与官方期望值**逐字符相同**，解密正确还原 `hello`。说明能和微信服务器真实互通，不只是往返自洽。

---

## 四、还没做的（按优先级）

### 🔴 P0 · 卡在这，做不了别的

1. **后台开通微信客服**
   企业微信管理后台 → 应用管理 → **微信客服** → 启用。
   CorpID 已有：`ww90af80a1c9f47c46`
   拿到 4 个值：`KF_SECRET`、`KF_TOKEN`（自己填，字母数字 1-32 位）、`KF_AES_KEY`（点「随机获取」，43 位）、`open_kfid`

2. **部署到服务器 / 拿到公网回调地址**
   回调地址必须是完整 HTTPS URL，写死在后台，微信只往这个地址发。

3. **填进 `.env` 并自检**
   ```bash
   npm run kf:setup          # 交互式写入，自动打码回显
   npm run kf:check          # 本地 5 步自检，不需要域名
   ```

### 🟡 P1 · 跑通后立刻要做的

4. **真机联调**：客户扫码发一条消息，确认从回调到回复整条链路
5. **灌真实聊天记录**：现在话术库只有 4 条占位。目标是拿我真实的企微聊天记录，配对成 QA 灌进 `data/`
   ```bash
   # 企微客户端里全选复制一段对话存成 chat.txt
   npm run pair -- chat.txt   # 配对成 QA
   npm run stats              # 看沉淀了多少
   ```
6. **打磨语气**：`BOT_PERSONA` / `BOT_BUSINESS` 现在还是示例值，要换成我真实的行文习惯

### 🟢 P2 · 以后再说

7. 小红书企业号接入（`adapters/xhs.js` 已有骨架）
8. 抖音（等认证）
9. 智能机器人给员工用（内部场景，不是当前重点）

---

## 五、域名与备案：已确认可以走

**结论：日本域名不需要 ICP 备案，可以直接用。**

- 备案是**中国大陆境内服务器**的要求，与域名后缀无关，取决于服务器在哪
- 你的站实际在 **日本 GMO Internet（福冈北九州），IP `157.120.209.57`**
- 微信支付官方文档明确写：「境外服务器虽无需备案，但需确保域名解析正常」——等于官方承认这种配置成立

**实测结果（2026-11-26 12:19 JST）**：

| 检查 | 结果 |
|---|---|
| 解析 | `www.akikazu.co.jp` 与 `akikazu.co.jp` 均指向 `157.120.209.57` |
| 证书 | GlobalSign，SAN 同时覆盖 `akikazu.co.jp` + `www.akikazu.co.jp`，有效期至 2027-05-31 |
| 响应 | nginx，126~175ms |
| `/health`、`/hook/kf` | **404**（机器人服务尚未部署，符合预期） |

企业微信对接只要求：公网可达 + 有效 HTTPS 证书 + 80/443 端口。三条都满足，备案不是检查项。

### 部署方案建议

**推荐开子域名 `bot.akikazu.co.jp`**，不要往主站 nginx 里塞。主站是正式网站，改动它的 `server` 块有把官网搞挂的风险；子域名互不干扰，出问题直接摘掉。

子域名需要新证书：GMO 那边加免费 Let's Encrypt，或让 GlobalSign 免费追加 SAN。

nginx 反代**三个关键点**（很容易踩）：

```nginx
location /hook/kf {
    proxy_pass http://127.0.0.1:8787;      # 末尾不带 /，否则 query 参数被吞，签名必挂
    proxy_set_header Host $host;
    proxy_read_timeout 5s;                  # 企微等 5 秒就重试，别拖
}
```

1. **必须原样转发 query 参数**（`msg_signature` / `timestamp` / `nonce` / `echostr`）。`proxy_pass ...:8787/` 带斜杠会改写 URI，签名直接验不过
2. **绝对不能改 body**。POST 进来的是加密 XML，加任何 `sub_filter` 就解不开
3. **不需要改 Content-Type**，原样透传

---

## 六、环境变量速查

完整模板见 `.env.example`。`.env` 已在 `.gitignore`，不会进仓库。

```bash
# ── 微信客服（对外，重点）────────────────────
KF_CORP_ID=          # 企业ID，ww 开头（已有：ww90af80a1c9f47c46）
KF_SECRET=           # 应用管理 → 微信客服 → Secret
KF_TOKEN=            # 接收消息服务器配置 → Token，自填 1-32 位字母数字
KF_AES_KEY=          # 同上 → EncodingAESKey，43 位
KF_API_BASE=         # 可选，默认 https://qyapi.weixin.qq.com
KF_LIMIT=            # 可选，单次拉取条数

# ── 智能机器人（对内员工用）──────────────────
WECOM_BOT_ID=
WECOM_BOT_SECRET=

# ── 可选 ───────────────────────────────────
OPENAI_API_KEY=      # 不配就只有「价格页 + 话术库」两层，够用
OPENAI_BASE_URL=
OPENAI_MODEL=
BOT_PERSONA=         # 语气人设，待换成真实值
BOT_BUSINESS=        # 业务描述，待换成真实值
AUTO_REPLY=true      # false = 只记录不回复，调试用
PORT=8787
OMNIBOT_SECRET=      # /api/reply 的鉴权密钥
OMNIBOT_DB=          # 默认 data/omnibot.db
OMNIBOT_SNIPPETS=    # 默认 data/snippets.json
OMNIBOT_PRICE_CARD=true
```

**优先级**：命令行已 export 的 > `.env` 文件 > 默认值。

---

## 七、常用命令

```bash
npm test                  # 414 个测试
npm run serve             # 起服务（默认 8787）
npm run check             # 环境体检：微信客服 → 智能机器人 → 自建应用
npm run kf:setup          # 微信客服四值向导
npm run kf:check          # 回调自检（可传域名测公网：npm run kf:check https://bot.akikazu.co.jp）
npm run bot:setup         # 智能机器人凭据
npm run pair -- chat.txt  # 聊天记录配对成 QA
npm run stats             # 沉淀统计
npm run demo              # 本地零成本试用
```

---

## 八、关键文件在哪

| 文件 | 职责 |
|---|---|
| `qa/decide.js` | **回复决策核心**，三层递进，三渠道共用。改回复逻辑先看这里 |
| `qa/price-router.js` | 问价识别 + 判断该发哪个价格页 |
| `qa/site-map.js` | 官网页面地图，18 个服务项 × 4 种语言 |
| `qa/snippets.js` | 话术库匹配 |
| `qa/knowledge.js` | 从沉淀的 QA 里检索 |
| `qa/wecom-crypto.js` | 企微加解密（注意 PKCS#7 块大小是 **32**，不是 16） |
| `adapters/wecom-kf.js` | 微信客服适配器：回调解析、sync_msg、send_msg |
| `adapters/wecom-bot.js` | 智能机器人长连接 |
| `adapters/wecom-audit.js` | 会话存档（客户加好友场景） |
| `adapters/paste.js` | 粘贴导入聊天记录 |
| `server.js` | HTTP 服务 + `/hook/kf` 回调入口 |
| `scripts/check-webhook.js` | 回调 5 步自检，能区分 401（Token 错）vs 400（AESKey 错） |

---

## 九、技术约束（改代码前必看）

1. **零依赖**。只用 Node 22 自带的 `crypto`、全局 `WebSocket`、`node:sqlite`。不要加 npm 包
2. **`send_msg` 只支持纯文本**。不支持 markdown、不支持卡片。可点击卡片只能走小程序消息
3. **cursor 必须持久化**。微信客服漏拉一次消息**永久丢失**，官方不重发
4. **回调 token 10 分钟有效**，过期要重新拉
5. **PKCS#7 填充块大小是 32**，不是 AES 默认的 16。这条错了会静默失败
6. **回调先回 200 再处理**。用 `setImmediate` 异步，否则企微 5 秒超时重试会导致重复回复
7. **报价和话术绝不交给 AI**。`data/snippets.json` 里已删掉 `price` 条目，避免和价格页卡片互抢

---

## 十、新对话怎么接上

直接说：

> 「继续 omnibot-qa。先读 HANDOFF.md 和 README.md，当前卡在微信客服后台开通和部署。」

或者更具体：

- 「帮我把 omnibot-qa 部署到日本服务器，用 bot.akikazu.co.jp 子域名」
- 「微信客服四值我拿到了，帮我填进 .env 并自检」
- 「帮我整理真实聊天记录，灌进 QA 库」

**新对话第一件该问的事**：微信客服开通了吗？4 个值拿到了吗？服务器能登吗？
