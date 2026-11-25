/**
 * 本地模拟 LLM 服务（OpenAI 兼容），用于端到端演示，不消耗任何真实额度。
 *
 * 它会回显收到的 system prompt 里的关键信息，方便验证：
 * - 知识库是否被检索到并注入
 * - 风格样本是否被抽到
 *
 * 用法：node scripts/mock-llm.js [port]
 */
import http from 'node:http';

const PORT = Number(process.argv[2] || 8899);

const server = http.createServer(async (req, res) => {
  if (req.method !== 'POST' || !req.url.includes('/chat/completions')) {
    res.writeHead(404).end();
    return;
  }

  const chunks = [];
  for await (const c of req) chunks.push(c);
  const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));

  const system = body.messages?.find((m) => m.role === 'system')?.content || '';
  const userMsg = [...(body.messages || [])].reverse().find((m) => m.role === 'user')?.content || '';

  const hasRef = system.includes('过往真实问答');
  const hasStyle = system.includes('你的说话风格');
  const refCount = (system.match(/客户问：/g) || []).length;

  // 模拟一个「有我们自己语气」的客服回复
  let answer;
  if (hasRef && refCount > 0) {
    const m = system.match(/我们答：(.+)/);
    answer = `${m ? m[1].trim() : '这个我们支持的'}~ 有需要随时找我`;
  } else {
    answer = '这个我确认下再回复您哈';
  }

  const payload = {
    id: 'mock-1',
    object: 'chat.completion',
    model: body.model || 'mock',
    choices: [
      {
        index: 0,
        message: {
          role: 'assistant',
          content: answer,
        },
        finish_reason: 'stop',
      },
    ],
    usage: {
      prompt_tokens: system.length,
      completion_tokens: answer.length,
      total_tokens: system.length + answer.length,
    },
    // 调试信息，方便在终端确认链路
    _debug: { hasRef, hasStyle, refCount, userMsg },
  };

  console.log(
    `[mock-llm] 收到提问「${userMsg}」 → 参考=${hasRef ? refCount + '条' : '无'} 风格=${hasStyle ? '有' : '无'}`
  );

  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(payload));
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`[mock-llm] OpenAI 兼容模拟服务 http://127.0.0.1:${PORT}/v1`);
});
