/**
 * Normalize diverse tool definitions (Dict, Array, MCP Schema) into a clean criteria map.
 */
export function normalizeTools(tools) {
  const criteria = {};
  const registry = new Map();

  if (Array.isArray(tools)) {
    for (const t of tools) {
      if (!t || typeof t !== 'object') continue;
      const name = t.name || t.id;
      if (!name) continue;
      const desc = t.criteria || t.description || t.summary || name;
      criteria[name] = desc;
      registry.set(name, t);
    }
  } else if (tools && typeof tools === 'object') {
    for (const [name, val] of Object.entries(tools)) {
      if (typeof val === 'string') {
        criteria[name] = val;
        registry.set(name, { name, description: val });
      } else if (val && typeof val === 'object') {
        const desc = val.criteria || val.description || val.summary || name;
        criteria[name] = desc;
        registry.set(name, { name, ...val });
      }
    }
  }

  return { criteria, registry };
}

export class ToolPruner {
  constructor(tools, options = {}) {
    const { criteria, registry } = normalizeTools(tools);
    this.criteria = criteria;
    this.registry = registry;
    this.apiKey = options.apiKey || (typeof process !== 'undefined' ? process.env?.TYPESAFE_API_KEY : undefined);
    this.endpoint = options.endpoint || 'https://api.typesafe.ai/v1/systemone';
    this.model = options.model || 'jev-latest';
    this.threshold = options.threshold ?? 0.85;
    this.defaultTopK = options.topK ?? 3;
  }

  /**
   * Select the most appropriate tool for a given query with calibrated confidence.
   */
  async select(query, options = {}) {
    if (!this.apiKey) {
      throw new Error('TypeSafe API key required. Set TYPESAFE_API_KEY or pass { apiKey }.');
    }

    const state = typeof query === 'string' ? { intent: query } : query;
    const body = {
      model: options.model || this.model,
      state,
      questions: {
        tool: {
          type: 'choice',
          instructions: options.instructions || 'Which specific tool is required to satisfy this intent?',
          criteria: this.criteria
        },
        requires_generation: {
          type: 'noul',
          instructions: 'Does fulfilling this request require open-ended creative text or arbitrary code generation rather than a deterministic tool execution?'
        }
      }
    };

    const start = performance.now();
    const res = await fetch(this.endpoint, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(body)
    });

    if (!res.ok) {
      const errText = await res.text().catch(() => '');
      throw new Error(`tool-prune API error (${res.status}): ${errText || res.statusText}`);
    }

    const data = await res.json();
    const latency = performance.now() - start;

    const toolAnswer = data.answers?.tool;
    const probs = toolAnswer?.probabilities || {};
    const sorted = Object.entries(probs).sort((a, b) => b[1] - a[1]);
    const topKCount = options.topK || this.defaultTopK;
    const topK = sorted.slice(0, topKCount).map(([name, p]) => ({
      name,
      probability: p,
      tool: this.registry.get(name)
    }));

    const selectedName = toolAnswer?.choice;
    const probability = probs[selectedName] ?? 0;
    const confidence = toolAnswer?.confidence ?? probability;
    const requiresGeneration = data.answers?.requires_generation?.probability ?? 0;

    return {
      tool: selectedName,
      confidence,
      probability,
      topK,
      requiresGeneration,
      latency,
      usage: data.usage,
      raw: data
    };
  }

  /**
   * Filter tool collection down to top-K candidates to prune LLM prompt bloat.
   */
  async filter(query, options = {}) {
    const res = await this.select(query, options);
    const k = options.k || options.topK || this.defaultTopK;
    return res.topK.slice(0, k).map(item => item.tool || item.name);
  }

  /**
   * Route and execute matching handler function directly when confidence exceeds threshold.
   */
  async dispatch(query, handlers = {}, options = {}) {
    const selection = await this.select(query, options);
    const threshold = options.threshold ?? this.threshold;

    if (selection.confidence >= threshold && handlers[selection.tool]) {
      return await handlers[selection.tool](query, selection);
    }

    if (handlers.fallback) {
      return await handlers.fallback(query, selection);
    }

    return selection;
  }
}

/**
 * Main function following Hemanth module style:
 * - One-shot: await toolPrune(query, tools, options)
 * - Configured: const pruner = toolPrune(tools, options)
 */
export default function toolPrune(arg1, arg2, options) {
  if (typeof arg1 === 'string' && (Array.isArray(arg2) || (arg2 && typeof arg2 === 'object'))) {
    const pruner = new ToolPruner(arg2, options);
    return pruner.select(arg1, options);
  }
  return new ToolPruner(arg1, arg2);
}

toolPrune.ToolPruner = ToolPruner;
toolPrune.normalizeTools = normalizeTools;

