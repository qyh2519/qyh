// tool-support.mjs — DeepSeek 网页版 DSML 工具调用支持(从 deepseek-free-api 移植精简版)
// DSML 格式:<|DSML|tool_calls> <|DSML|invoke name="x"> <|DSML|parameter name="y"><![CDATA[v]]></|DSML|parameter> </|DSML|invoke> </|DSML|tool_calls>

// ─── 工具定义 → DSML 提示词 ──────────────────────────────
export function buildToolPrompt(tools) {
  if (!tools || !tools.length) return '';
  const lines = [];
  const examples = [];
  for (const tool of tools) {
    const fn = tool.function || tool;
    const name = fn.name || tool.name || '';
    const desc = (fn.description || tool.description || '').split('\n')[0].trim();
    if (name) lines.push(desc ? `- ${name}: ${desc}` : `- ${name}`);
    // 为每个工具生成示例(用第一个参数名)
    const props = fn.parameters?.properties || tool.parameters?.properties || {};
    const firstKey = Object.keys(props)[0] || (name === 'bash' ? 'command' : 'input');
    examples.push(`<${name}>${firstKey === 'command' ? '要执行的命令' : '参数值'}</${name}>`);
  }
  if (!lines.length) return '';
  return [
    'You have access to the following tools. When you need to call a tool, output EXACTLY the tool tag and NOTHING else:',
    ...examples.map((e) => '  ' + e),
    '',
    'STRICT RULES (violating them fails the task):',
    '1. The FIRST non-whitespace character of your reply must be "<" of the tool tag.',
    '2. NO markdown code fences (no ```, no ~~~), NO explanations, NO extra words.',
    '3. The tag name must be exactly the tool name. Put the value inside the tag.',
    '4. After the closing tag, output NOTHING more.',
    '',
    'Example for bash tool: <bash>cat /etc/os-release</bash>',
    '',
    'Available tools:',
    ...lines,
  ].join('\n');
}

// ─── assistant 消息的工具调用 → DSML(用于多轮历史)──────────
export function formatToolCallsForPrompt(toolCalls) {
  if (!Array.isArray(toolCalls) || !toolCalls.length) return '';
  const blocks = [];
  for (const tc of toolCalls) {
    if (!tc || typeof tc !== 'object') continue;
    const fn = tc.function || {};
    const name = tc.name || fn.name || '';
    if (!name) continue;
    let args = tc.arguments ?? tc.input ?? fn.arguments ?? '{}';
    if (typeof args === 'string') { try { args = JSON.parse(args); } catch { /* keep */ } }
    let inner = '';
    if (args && typeof args === 'object') {
      for (const [k, v] of Object.entries(args)) {
        if (typeof v === 'string') {
          inner += `    <|DSML|parameter name="${escAttr(k)}"><![CDATA[${v}]]></|DSML|parameter>\n`;
        } else {
          inner += `    <|DSML|parameter name="${escAttr(k)}">${JSON.stringify(v)}</|DSML|parameter>\n`;
        }
      }
    }
    blocks.push(`  <|DSML|invoke name="${escAttr(name)}">\n${inner}  </|DSML|invoke>`);
  }
  return blocks.length ? `<|DSML|tool_calls>\n${blocks.join('\n')}\n</|DSML|tool_calls>` : '';
}

// ─── 从回复文本解析工具调用 ──────────────────────────────
// 工具标签别名:网页版模型可能用各种标签表达 bash 调用
const TAG_ALIASES = {
  bash: ['bash', 'execute_command', 'execute_ipython', 'shell', 'command', 'code', 'tool_call', 'run', 'exec', 'terminal'],
};

function tagNamesFor(name) {
  return TAG_ALIASES[name] || [name];
}

export function parseToolCalls(text, toolNames, tools) {
  if (!text) return { calls: [], cleaned: '' };
  const calls = [];
  if (!toolNames || !toolNames.length) return { calls, cleaned: cleanToolText(text) };
  let working = text;

  // 找 <tool_calls> 块(容忍 |DSML| 前缀、dsml-tool_calls、大小写、噪声)
  const blockRe = /<\|?(?:dsml\|?)?\s*tool_calls\s*>(.*?)<\/\|?(?:dsml\|?)?\s*tool_calls\s*>/gis;
  const blocks = [];
  let m;
  while ((m = blockRe.exec(working)) !== null) blocks.push(m[1]);

  const invRe = /<\|?(?:dsml\|?)?\s*invoke\s+name\s*=\s*["']([^"']+)["']\s*>(.*?)<\/\|?(?:dsml\|?)?\s*invoke\s*>/gis;

  if (blocks.length) {
    for (const block of blocks) {
      let im;
      while ((im = invRe.exec(block)) !== null) {
        const tc = buildCall(im[1], im[2], toolNames, tools);
        if (tc) calls.push(tc);
      }
    }
  } else {
    // 裸 invoke(模型偶尔省略外层包裹)
    let im;
    while ((im = invRe.exec(working)) !== null) {
      const tc = buildCall(im[1], im[2], toolNames, tools);
      if (tc) calls.push(tc);
    }
    // 工具名标签 / 别名标签:<bash>cmd</bash>、<execute_command>...</execute_command> 等
    if (!calls.length) {
      for (const name of toolNames) {
        for (const tag of tagNamesFor(name)) {
          const tagRe = new RegExp(`<${escapeRe(tag)}\\s*>([\\s\\S]*?)<\\/${escapeRe(tag)}\\s*>`, 'gi');
          let tm;
          while ((tm = tagRe.exec(working)) !== null) {
            const tc = buildCall(name, tm[1], toolNames, tools);
            if (tc) calls.push(tc);
          }
        }
      }
    }
    // Markdown 代码块兜底:```bash\ncmd\n```(模型偶尔用代码块表达)
    if (!calls.length) {
      for (const name of toolNames) {
        const re = new RegExp('```(?:' + escapeRe(name) + '|sh|shell)\\s*\\n?([\\s\\S]*?)```', 'gi');
        let cm;
        while ((cm = re.exec(working)) !== null) {
          const tc = buildCall(name, cm[1], toolNames, tools);
          if (tc) calls.push(tc);
        }
      }
    }
  }
  // 移除已识别为工具调用的标签,再清理残留
  for (const name of toolNames) {
    for (const tag of tagNamesFor(name)) {
      working = working.replace(new RegExp(`<${escapeRe(tag)}\\s*>([\\s\\S]*?)<\\/${escapeRe(tag)}\\s*>`, 'gi'), '');
    }
    working = working.replace(new RegExp('```(?:' + escapeRe(name) + '|sh|shell)\\s*\\n?([\\s\\S]*?)```', 'gi'), '');
  }
  // 去重(嵌套标签可能重复解析)
  const seen = new Set();
  const unique = calls.filter((c) => {
    const key = `${c.function.name}|${c.function.arguments}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  return { calls: unique, cleaned: cleanToolText(working) };
}

function escapeRe(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function buildCall(rawName, inner, toolNames, tools) {
  const name = rawName.trim();
  if (!name) return null;
  // 模糊匹配工具名(容忍前后缀差异)
  const resolved = toolNames.find((t) => t.toLowerCase() === name.toLowerCase()) || name;
  // 提取嵌套 <command>...</command>(如 <execute_command><command>cmd</command></execute_command>)
  const cmdMatch = inner.match(/<command\s*>([\s\S]*?)<\/command\s*>/i);
  if (cmdMatch) inner = cmdMatch[1];
  let args = parseParams(inner);
  // 没有显式参数节点时,尝试按工具 schema 推断第一个参数名(如 bash → command)
  if (Object.keys(args).length === 0) {
    args = inferArgs(inner, resolved, tools);
  }
  return {
    id: `call_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`,
    type: 'function',
    function: { name: resolved, arguments: JSON.stringify(args) },
  };
}

// 推断参数:内容是 JSON 对象 → 直接用作参数;否则塞进工具的第一个参数名
function inferArgs(inner, toolName, tools) {
  const trimmed = (inner || '').trim();
  if (!trimmed) return {};
  try {
    const j = JSON.parse(trimmed);
    if (j && typeof j === 'object' && !Array.isArray(j)) return j;
  } catch { /* not json */ }
  const tool = (tools || []).find((t) => (t.function?.name || t.name) === toolName);
  const props = tool?.function?.parameters?.properties || tool?.parameters?.properties || {};
  const firstKey = Object.keys(props)[0] || (toolName === 'bash' ? 'command' : 'input');
  return { [firstKey]: trimmed };
}

function parseParams(inner) {
  const args = {};
  const re = /<\|?(?:dsml\|?)?\s*parameter\s+name\s*=\s*["']([^"']+)["']\s*>(.*?)<\/\|?(?:dsml\|?)?\s*parameter\s*>/gis;
  let m;
  while ((m = re.exec(inner)) !== null) {
    const key = m[1].trim();
    let val = m[2];
    const cd = val.match(/<!\[CDATA\[([\s\S]*?)\]\]>/);
    if (cd) {
      val = cd[1];
    } else {
      val = autoType(val.trim());
    }
    args[key] = val;
  }
  return args;
}

function autoType(s) {
  if (s === 'null') return null;
  if (s === 'true') return true;
  if (s === 'false') return false;
  if (/^-?\d+(\.\d+)?$/.test(s)) return Number(s);
  return s;
}

// ─── 清理 DSML 残留标记 ──────────────────────────────────
export function cleanToolText(text) {
  if (!text) return text;
  let t = text;
  t = t.replace(/<\/?\|?(?:dsml\|?)?\s*(?:tool_calls|invoke|parameter)[^>]*>/gi, '');
  t = t.replace(/<!\[CDATA\[[\s\S]*?\]\]>/g, '');
  t = t.replace(/<tool_calls?[\s\S]*?<\/tool_calls?>/gi, '');
  t = t.replace(/<invoke[^>]*>[\s\S]*?<\/invoke>/gi, '');
  t = t.replace(/<parameter[^>]*>[\s\S]*?<\/parameter>/gi, '');
  // 压缩残留的空白行
  t = t.replace(/[ \t]+\n/g, '\n');
  t = t.replace(/\n{2,}/g, '\n');
  return t;
}

function escAttr(s) {
  return String(s).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// ─── 流式筛分器:把工具调用块从正文中分离 ────────────────
export class StreamSieve {
  constructor(toolNames, tools) {
    this.toolNames = toolNames || [];
    this.tools = tools;
    this.textBuf = '';      // 待输出的纯净正文
    this.inTool = false;
    this.toolMode = null;   // 'dsml' | 'tag'
    this.toolTag = null;    // 工具名标签模式下的标签名
    this.toolBuf = '';
  }

  // 找下一个工具块起始,返回 {index, mode, tag} 或 null
  _findStart() {
    let best = null;
    const m = this.textBuf.match(/<\|?(?:dsml\|?)?\s*tool_calls\s*>/i);
    if (m) best = { index: m.index, mode: 'dsml', tag: null };
    if (this.toolNames.length) {
      const allTags = [];
      for (const name of this.toolNames) allTags.push(...tagNamesFor(name));
      const re = new RegExp(`<(${allTags.map(escapeRe).join('|')})\\s*>`, 'i');
      const tm = this.textBuf.match(re);
      if (tm && (!best || tm.index < best.index)) {
        best = { index: tm.index, mode: 'tag', tag: tm[1] };
      }
    }
    return best;
  }

  // 喂入一段正文文本,返回要输出的事件数组 [{type:'text', text} | {type:'toolCalls', calls}]
  feed(chunk) {
    const out = [];
    this.textBuf += chunk;
    let guard = 0;
    while (guard++ < 100) {
      if (!this.inTool) {
        const start = this._findStart();
        if (!start) break; // 没有工具块,剩余文本留待下次/结尾 flush
        const before = this.textBuf.slice(0, start.index);
        if (before) out.push({ type: 'text', text: cleanToolText(before) });
        this.textBuf = this.textBuf.slice(start.index);
        this.inTool = true;
        this.toolMode = start.mode;
        this.toolTag = start.tag;
        this.toolBuf = '';
      } else {
        // 在工具模式:查找结束标签
        const closeRe = this.toolMode === 'dsml'
          ? /<\/\|?(?:dsml\|?)?\s*tool_calls\s*>/i
          : new RegExp(`</${escapeRe(this.toolTag)}\\s*>`, 'i');
        const m = closeRe.exec(this.textBuf);
        if (!m) break; // 工具块尚未完整,继续攒
        this.toolBuf += this.textBuf.slice(0, m.index + m[0].length);
        const { calls } = parseToolCalls(this.toolBuf, this.toolNames, this.tools);
        if (calls.length) out.push({ type: 'toolCalls', calls });
        this.textBuf = this.textBuf.slice(m.index + m[0].length);
        this.inTool = false;
        this.toolMode = null;
        this.toolTag = null;
        this.toolBuf = '';
        // 继续循环,处理可能的后续工具块
      }
    }
    return out;
  }

  // 流结束:返回剩余输出
  flush() {
    const out = [];
    if (this.inTool) {
      const { calls } = parseToolCalls(this.toolBuf, this.toolNames, this.tools);
      if (calls.length) out.push({ type: 'toolCalls', calls });
      this.inTool = false;
      this.toolMode = null;
      this.toolTag = null;
      this.toolBuf = '';
    }
    if (this.textBuf) {
      const t = cleanToolText(this.textBuf);
      if (t) out.push({ type: 'text', text: t });
      this.textBuf = '';
    }
    return out;
  }
}
