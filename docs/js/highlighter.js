/**
 * Syntax Highlighter with WebGPU (gpu-lexer) and Fast Lexical Fallback
 * Reference: https://gpu-lexer.vercel.app/ by Shu Ding at Vercel Labs
 */

let gpuLexerPromise = null;
let webGpuAvailable = null;

export function escapeHtml(str) {
  if (!str) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

async function getGpuLexer() {
  if (gpuLexerPromise) return gpuLexerPromise;

  if (typeof navigator === 'undefined' || !navigator.gpu) {
    webGpuAvailable = false;
    return null;
  }

  gpuLexerPromise = (async () => {
    try {
      const adapter = await navigator.gpu.requestAdapter();
      if (!adapter) {
        webGpuAvailable = false;
        return null;
      }
      // Import WebGPU model from official CDN distribution
      const mod = await import('https://cdn.jsdelivr.net/npm/gpu-lexer@0.0.3/dist/index.js');
      webGpuAvailable = true;
      return mod.parse;
    } catch (err) {
      console.warn('WebGPU gpu-lexer initialization note:', err);
      webGpuAvailable = false;
      return null;
    }
  })();

  return gpuLexerPromise;
}

export function highlightFallback(code, lang = 'js') {
  const isPy = lang === 'py';
  const patterns = [
    { type: 'comment', regex: isPy ? /#[^\n]*/y : /(\/\/[^\n]*|\/\*[\s\S]*?\*\/)/y },
    { type: 'string', regex: /(`(?:\\.|[^`])*`|"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*')/y },
    { type: 'number', regex: /\b\d+(?:\.\d+)?\b/y },
    {
      type: 'keyword',
      regex: isPy
        ? /\b(?:import|from|as|def|return|if|elif|else|for|while|in|is|not|and|or|lambda|class|try|except|with|None|True|False|await|async)\b/y
        : /\b(?:import|export|from|as|const|let|var|function|return|if|else|for|while|in|of|await|async|new|class|try|catch|true|false|null|undefined|default)\b/y
    },
    { type: 'function', regex: /\b([a-zA-Z_$][a-zA-Z0-9_$]*)(?=\s*\()/y },
    { type: 'constant', regex: /\b[A-Z_][A-Z0-9_]{2,}\b/y },
    { type: 'plain', regex: /[a-zA-Z_$][a-zA-Z0-9_$]*|[^\s\w]+|\s+/y }
  ];

  let html = '';
  let i = 0;
  while (i < code.length) {
    let matched = false;
    for (let p = 0; p < patterns.length; p++) {
      const item = patterns[p];
      item.regex.lastIndex = i;
      const m = item.regex.exec(code);
      if (m && m.index === i) {
        const text = escapeHtml(m[0]);
        if (item.type === 'plain') {
          html += text;
        } else {
          html += `<span class="token-${item.type}">${text}</span>`;
        }
        i += m[0].length;
        matched = true;
        break;
      }
    }
    if (!matched) {
      html += escapeHtml(code[i]);
      i++;
    }
  }
  return html;
}

export async function highlightCode(code, lang = 'js') {
  try {
    const parse = await getGpuLexer();
    if (parse) {
      const spans = await parse(code);
      if (Array.isArray(spans) && spans.length > 0) {
        let html = '';
        let last = 0;
        for (const s of spans) {
          if (s.start > last) {
            html += escapeHtml(code.slice(last, s.start));
          }
          const text = escapeHtml(code.slice(s.start, s.end));
          if (s.type === 'plain') {
            html += text;
          } else {
            html += `<span class="token-${s.type}">${text}</span>`;
          }
          last = s.end;
        }
        if (last < code.length) {
          html += escapeHtml(code.slice(last));
        }
        return { html, engine: 'webgpu' };
      }
    }
  } catch (err) {
    console.debug('gpu-lexer parse fallback:', err);
  }

  return { html: highlightFallback(code, lang), engine: 'fast-lex' };
}

if (typeof window !== 'undefined') {
  window.toolPruneHighlighter = { highlightCode, highlightFallback };
}
