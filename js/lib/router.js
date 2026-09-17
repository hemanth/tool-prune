import { TurboQuantEngine } from './turboquant.js';

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
    this.requestedEngine = options.engine;
    this._tqEngine = null;
    this._wasmEngine = null;
  }

  /**
   * Determine engine: explicit option, or fallback to turboquant if no API key.
   */
  getEngine(options = {}) {
    const eng = options.engine || this.requestedEngine;
    if (eng) return eng;
    return this.apiKey ? 'typesafe' : 'turboquant';
  }

  /**
   * Select the most appropriate tool for a given query with calibrated confidence.
   */
  async select(query, options = {}) {
    const engine = this.getEngine(options);
    if (engine === 'turboquant') {
      return this._selectTurboQuant(query, options);
    }
    return this._selectTypeSafe(query, options);
  }

  async _selectTypeSafe(query, options = {}) {
    const key = options.apiKey || this.apiKey;
    if (!key) {
      throw new Error("TypeSafe API key required. Set TYPESAFE_API_KEY, pass { apiKey }, or use { engine: 'turboquant' }.");
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
        Authorization: `Bearer ${key}`,
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
      engine: 'typesafe',
      usage: data.usage,
      raw: data
    };
  }

  async _selectTurboQuant(query, options = {}) {
    const qStr = typeof query === 'string' ? query : (query.intent || query.query || JSON.stringify(query));
    const start = performance.now();

    // Check if turboquant-search (WASM) is available
    if (!this._tqEngine) {
      try {
        const { TurboSearch } = await import('turboquant-search');
        const data = Array.from(this.registry.values()).map(t => ({
          name: t.name,
          description: t.description || '',
          criteria: t.criteria || ''
        }));
        this._wasmEngine = await TurboSearch.from(data, {
          fields: ['name', 'description', 'criteria'],
          dim: 384,
          bits: 3
        });
      } catch {
        // Fallback to built-in zero-dependency TurboQuant engine
        this._tqEngine = new TurboQuantEngine();
        const toolsMap = {};
        for (const [name, tool] of this.registry.entries()) {
          toolsMap[name] = tool;
        }
        this._tqEngine.fit(toolsMap);
      }
    }

    const k = options.topK || this.defaultTopK;
    let topK = [];

    if (this._wasmEngine) {
      const results = await this._wasmEngine.search(qStr, { topK: k });
      topK = results.map(r => ({
        name: r.data?.name || '',
        probability: r.score || 0,
        score: r.score || 0,
        tool: this.registry.get(r.data?.name)
      }));
    } else {
      const rawResults = this._tqEngine.search(qStr, k);
      topK = rawResults.map(r => ({
        name: r.name,
        probability: r.probability,
        score: r.score,
        tool: this.registry.get(r.name)
      }));
    }

    const latency = performance.now() - start;
    const top1 = topK[0];

    return {
      tool: top1?.name || '',
      confidence: top1?.probability || 0,
      probability: top1?.probability || 0,
      topK,
      requiresGeneration: 0,
      latency,
      engine: 'turboquant'
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
