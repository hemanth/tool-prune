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
    this.defaultTopK = options.topK ?? 'auto';
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
    const allCandidates = sorted.map(([name, p]) => ({
      name,
      probability: p,
      tool: this.registry.get(name)
    }));

    const autoSelected = autoSelectCandidates(allCandidates, options);
    const autoTools = autoSelected.map(c => c.tool || c.name);

    const k = typeof options.topK === 'number' ? options.topK : (typeof this.defaultTopK === 'number' ? this.defaultTopK : null);
    const topK = typeof k === 'number' ? allCandidates.slice(0, k) : allCandidates.slice(0, Math.max(3, autoSelected.length));

    const selectedName = toolAnswer?.choice || topK[0]?.name || '';
    const probability = probs[selectedName] ?? 0;
    const confidence = toolAnswer?.confidence ?? probability;
    const requiresGeneration = data.answers?.requires_generation?.probability ?? 0;

    return {
      tool: selectedName,
      confidence,
      probability,
      topK,
      autoSelected,
      autoTools,
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

    const k = typeof options.topK === 'number' ? options.topK : (typeof this.defaultTopK === 'number' ? this.defaultTopK : null);
    const poolSize = Math.max(k || 3, 10, this.registry.size);
    let allCandidates = [];

    if (this._wasmEngine) {
      const results = await this._wasmEngine.search(qStr, { topK: poolSize });
      allCandidates = results.map(r => ({
        name: r.data?.name || '',
        probability: r.score || 0,
        score: r.score || 0,
        tool: this.registry.get(r.data?.name)
      }));
    } else {
      const rawResults = this._tqEngine.search(qStr, poolSize);
      allCandidates = rawResults.map(r => ({
        name: r.name,
        probability: r.probability,
        score: r.score,
        tool: this.registry.get(r.name)
      }));
    }

    const latency = performance.now() - start;
    const top1 = allCandidates[0];
    const autoSelected = autoSelectCandidates(allCandidates, options);
    const autoTools = autoSelected.map(c => c.tool || c.name);
    const topK = typeof k === 'number' ? allCandidates.slice(0, k) : allCandidates.slice(0, Math.max(3, autoSelected.length));

    return {
      tool: top1?.name || '',
      confidence: top1?.probability || 0,
      probability: top1?.probability || 0,
      topK,
      autoSelected,
      autoTools,
      requiresGeneration: 0,
      latency,
      engine: 'turboquant'
    };
  }

  /**
   * Filter tool collection down to relevant candidates to prune LLM prompt bloat.
   * If k or topK is a number, returns that fixed number of candidates.
   * Otherwise (default or k='auto'), automatically selects the candidates based on score drop-off.
   */
  async filter(query, options = {}) {
    const k = options.k ?? options.topK ?? this.defaultTopK;
    if (typeof k === 'number' && k > 0) {
      const res = await this.select(query, { ...options, topK: k });
      return res.topK.slice(0, k).map(item => item.tool || item.name);
    }
    const res = await this.select(query, options);
    return res.autoTools;
  }

  /**
   * Automatically select the optimal candidate tools based on score distribution.
   */
  async auto(query, options = {}) {
    const res = await this.select(query, options);
    return res.autoTools;
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
 * Automatically select the most relevant tool candidates based on score distribution,
 * cliff / elbow drop-off, and relevance floors.
 */
export function autoSelectCandidates(candidates, options = {}) {
  if (!candidates || candidates.length === 0) return [];

  const maxK = options.maxK ?? 5;
  const minK = options.minK ?? (options.allowEmpty ? 0 : 1);
  const minScore = options.minScore ?? 0.12;
  const minProb = options.minProbability ?? options.minProb ?? 0.20;
  const relativeThreshold = options.relativeThreshold ?? 0.70;
  const cliffRatio = options.cliffRatio ?? 0.75;
  const dominantMargin = options.dominantMargin ?? 0.14;

  const top1 = candidates[0];
  const hasScore = typeof top1.score === 'number';
  const topVal = hasScore ? top1.score : top1.probability;
  const floorVal = hasScore ? minScore : minProb;

  if (topVal < floorVal) {
    return minK > 0 ? candidates.slice(0, minK) : [];
  }

  const selected = [top1];

  for (let i = 1; i < Math.min(candidates.length, maxK); i++) {
    const curr = candidates[i];
    const prev = candidates[i - 1];

    if (hasScore) {
      if (curr.score < minScore) break;
      // Dominant lead: top1 is strong and clearly ahead
      if (top1.score >= 0.35 && (top1.score - curr.score) > dominantMargin) break;
      // Relative to top1
      if ((curr.score / Math.max(1e-6, top1.score)) < relativeThreshold) break;
      // Cliff drop from previous
      if (prev.score > 0 && (curr.score / prev.score) < cliffRatio) break;
    } else {
      if (curr.probability < minProb) break;
      if (top1.probability >= 0.70 && (top1.probability - curr.probability) > 0.20) break;
      if ((curr.probability / Math.max(1e-6, top1.probability)) < relativeThreshold) break;
      if (prev.probability > 0 && (curr.probability / prev.probability) < cliffRatio) break;
    }

    selected.push(curr);
  }

  if (selected.length < minK) {
    return candidates.slice(0, Math.min(candidates.length, minK));
  }

  return selected;
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

toolPrune.auto = function(query, tools, options) {
  const pruner = new ToolPruner(tools, options);
  return pruner.auto(query, options);
};

toolPrune.ToolPruner = ToolPruner;
toolPrune.normalizeTools = normalizeTools;
toolPrune.autoSelectCandidates = autoSelectCandidates;

