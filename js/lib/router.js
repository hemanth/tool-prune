import { TurboQuantEngine } from './turboquant.js';

function buildRichCriteria(name, def) {
  if (!def || typeof def !== 'object') return String(def || name);
  if (def.criteria) return String(def.criteria);

  const base = def.description || def.summary || def.title || name;
  const schema = def.parameters || def.inputSchema || def.input_schema || def.schema;
  const props = schema?.properties;
  if (props && typeof props === 'object') {
    const keys = Object.keys(props);
    if (keys.length > 0) {
      return `${base} (params: ${keys.slice(0, 12).join(', ')})`;
    }
  }
  return String(base);
}

/**
 * Normalize diverse tool definitions (Dict, Array, MCP inputSchema, Anthropic input_schema,
 * OpenAI { type: 'function', function: {...} }) into a criteria map and tool registry.
 */
export function normalizeTools(tools) {
  const criteria = {};
  const registry = new Map();

  if (Array.isArray(tools)) {
    for (const t of tools) {
      if (!t || typeof t !== 'object') continue;
      const fnDef = (t.function && typeof t.function === 'object') ? t.function : t;
      const name = fnDef.name || t.name || t.id;
      if (!name) continue;
      criteria[name] = buildRichCriteria(name, fnDef);
      registry.set(name, t);
    }
  } else if (tools && typeof tools === 'object') {
    for (const [key, val] of Object.entries(tools)) {
      if (typeof val === 'string') {
        criteria[key] = val;
        registry.set(key, { name: key, description: val });
      } else if (val && typeof val === 'object') {
        const fnDef = (val.function && typeof val.function === 'object') ? val.function : val;
        const name = key || fnDef.name;
        criteria[name] = buildRichCriteria(name, fnDef);
        registry.set(name, val.name ? val : { name, ...val });
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
   * Determine engine: explicit option, custom engine object/function, or fallback to turboquant if no API key.
   */
  getEngine(options = {}) {
    const eng = options.engine ?? this.requestedEngine;
    if (eng) return eng;
    return this.apiKey ? 'typesafe' : 'turboquant';
  }

  /**
   * Select the most appropriate tool for a given query with calibrated confidence.
   */
  async select(query, options = {}) {
    const engine = this.getEngine(options);
    if (typeof engine === 'function' || (engine && typeof engine === 'object' && typeof engine.choice === 'function')) {
      return this._selectCustomEngine(engine, query, options);
    }
    if (engine === 'turboquant' || engine === 'turboquant-wasm') {
      return this._selectTurboQuant(query, options, engine === 'turboquant-wasm');
    }
    return this._selectTypeSafe(query, options);
  }

  async _selectCustomEngine(engine, query, options = {}) {
    const start = performance.now();
    const qState = typeof query === 'string' ? query : (query.intent || query.query || query);
    let rawRes;

    if (typeof engine === 'function') {
      rawRes = await engine(qState, this.criteria, options);
    } else {
      rawRes = await engine.choice({
        state: qState,
        question: options.instructions || 'Which specific tool is required to satisfy this intent?',
        options: this.criteria
      });
    }

    const latency = performance.now() - start;
    let allCandidates = [];
    let explicitChoice = '';
    let explicitConfidence;

    if (Array.isArray(rawRes)) {
      allCandidates = rawRes.map(r => ({
        name: r.name,
        probability: r.probability ?? r.score ?? 0,
        score: r.score,
        tool: this.registry.get(r.name)
      }));
    } else if (rawRes && typeof rawRes === 'object') {
      const probs = rawRes.probabilities || {};
      const sorted = Object.entries(probs).sort((a, b) => b[1] - a[1]);
      allCandidates = sorted.map(([name, p]) => ({
        name,
        probability: p,
        tool: this.registry.get(name)
      }));
      explicitChoice = rawRes.choice || '';
      explicitConfidence = rawRes.confidence;
      if (allCandidates.length === 0 && explicitChoice) {
        allCandidates = [{
          name: explicitChoice,
          probability: explicitConfidence ?? 1,
          tool: this.registry.get(explicitChoice)
        }];
      }
    }

    const autoSelected = autoSelectCandidates(allCandidates, options);
    const autoTools = autoSelected.map(c => c.tool || c.name);
    const k = typeof options.topK === 'number' ? options.topK : (typeof this.defaultTopK === 'number' ? this.defaultTopK : null);
    const topK = typeof k === 'number' ? allCandidates.slice(0, k) : allCandidates.slice(0, Math.max(3, autoSelected.length));

    const emptyAllowed = Boolean(options.allowEmpty) && autoSelected.length === 0;
    const selectedName = emptyAllowed ? '' : (explicitChoice || topK[0]?.name || '');
    const matchedCand = allCandidates.find(c => c.name === selectedName) || topK[0];
    const probability = matchedCand?.probability ?? 0;
    const confidence = explicitConfidence ?? probability;

    return {
      tool: selectedName,
      confidence,
      probability,
      topK,
      autoSelected,
      autoTools,
      requiresGeneration: 0,
      latency,
      engine: engine.name || 'custom',
      raw: rawRes
    };
  }

  async _selectTypeSafe(query, options = {}) {
    const key = options.apiKey || this.apiKey;
    if (!key) {
      throw new Error("TypeSafe API key required. Set TYPESAFE_API_KEY, pass { apiKey }, or use { engine: 'turboquant' }.");
    }

    const state = typeof query === 'string' ? { intent: query } : query;
    let activeCriteria = this.criteria;
    if (this.registry.size > 250) {
      if (!this._tqEngine) {
        this._tqEngine = new TurboQuantEngine();
        this._tqEngine.fit(this.registry);
      }
      const qStr = typeof query === 'string' ? query : (query?.intent || query?.query || JSON.stringify(query));
      const shortlisted = this._tqEngine.search(qStr, 200);
      activeCriteria = {};
      for (const item of shortlisted) {
        if (this.criteria[item.name] !== undefined) {
          activeCriteria[item.name] = this.criteria[item.name];
        }
      }
    }

    const body = {
      model: options.model || this.model,
      state,
      questions: {
        tool: {
          type: 'choice',
          instructions: options.instructions || 'Which specific tool is required to satisfy this intent?',
          criteria: activeCriteria
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

    const emptyAllowed = Boolean(options.allowEmpty) && autoSelected.length === 0;
    const selectedName = emptyAllowed ? '' : (toolAnswer?.choice || topK[0]?.name || '');
    const probability = selectedName ? (probs[selectedName] ?? 0) : (probs[topK[0]?.name] ?? 0);
    const confidence = selectedName ? (toolAnswer?.confidence ?? probability) : probability;
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

  async _selectTurboQuant(query, options = {}, preferWasm = false) {
    const qStr = typeof query === 'string' ? query : (query?.intent || query?.query || JSON.stringify(query));
    const start = performance.now();

    if (preferWasm && !this._wasmEngine) {
      try {
        const { TurboSearch } = await import('turboquant-search');
        const data = Array.from(this.registry.entries()).map(([name, t]) => ({
          name,
          description: t?.description || '',
          criteria: this.criteria[name] || ''
        }));
        this._wasmEngine = await TurboSearch.from(data, {
          fields: ['name', 'description', 'criteria'],
          dim: 384,
          bits: 3
        });
      } catch {
        preferWasm = false;
      }
    }

    if (!preferWasm && !this._tqEngine) {
      this._tqEngine = new TurboQuantEngine();
      this._tqEngine.fit(this.registry);
    }

    const k = typeof options.topK === 'number' ? options.topK : (typeof this.defaultTopK === 'number' ? this.defaultTopK : null);
    const poolSize = Math.max(k || 3, 10, this.registry.size);
    let allCandidates = [];

    if (preferWasm && this._wasmEngine) {
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

    const emptyAllowed = Boolean(options.allowEmpty) && autoSelected.length === 0;

    return {
      tool: emptyAllowed ? '' : (top1?.name || ''),
      confidence: top1?.probability || 0,
      probability: top1?.probability || 0,
      topK,
      autoSelected,
      autoTools,
      requiresGeneration: 0,
      latency,
      engine: (preferWasm && this._wasmEngine) ? 'turboquant-wasm' : 'turboquant'
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

    if (selection.tool && selection.confidence >= threshold && handlers[selection.tool]) {
      return await handlers[selection.tool](query, selection);
    }

    if (handlers.fallback) {
      return await handlers.fallback(query, selection);
    }

    return selection;
  }
}

/**
 * Uncertainty-aware conformal candidate selection based on score distribution,
 * cliff / elbow drop-off, and relevance floors.
 */
export function autoSelectCandidates(candidates, options = {}) {
  if (!candidates || candidates.length === 0) return [];

  const maxK = options.maxK ?? 5;
  const minK = options.minK ?? (options.allowEmpty ? 0 : 1);
  const minScore = options.minScore ?? 0.08;
  const minProb = options.minProbability ?? options.minProb ?? 0.20;
  const relativeThreshold = options.relativeThreshold ?? 0.68;
  const cliffRatio = options.cliffRatio ?? 0.72;
  const dominantMargin = options.dominantMargin ?? 0.14;

  const top1 = candidates[0];
  const hasScore = typeof top1.score === 'number';
  const topVal = hasScore ? top1.score : top1.probability;
  const floorVal = hasScore ? minScore : minProb;

  if (topVal < floorVal) {
    return minK > 0 ? candidates.slice(0, minK) : [];
  }

  // Widen candidate set slightly when top1 score is in the low/ambiguous zone
  const uncertain = hasScore ? top1.score < 0.34 : top1.probability < 0.68;
  const effRel = (options.relativeThreshold !== undefined || !uncertain) ? relativeThreshold : 0.48;
  const effCliff = (options.cliffRatio !== undefined || !uncertain) ? cliffRatio : 0.58;
  const effFloor = (options.minScore !== undefined || !uncertain) ? minScore : 0.05;

  const selected = [top1];

  for (let i = 1; i < Math.min(candidates.length, maxK); i++) {
    const curr = candidates[i];
    const prev = candidates[i - 1];

    if (hasScore) {
      if (curr.score < effFloor) break;
      if (top1.score >= 0.38 && (top1.score - curr.score) > dominantMargin) break;
      if ((curr.score / Math.max(1e-6, top1.score)) < effRel) break;
      if (prev.score > 0 && (curr.score / prev.score) < effCliff) break;
    } else {
      if (curr.probability < minProb) break;
      if (top1.probability >= 0.70 && (top1.probability - curr.probability) > 0.20) break;
      if ((curr.probability / Math.max(1e-6, top1.probability)) < effRel) break;
      if (prev.probability > 0 && (curr.probability / prev.probability) < effCliff) break;
    }

    selected.push(curr);
  }

  if (selected.length < minK) {
    return candidates.slice(0, Math.min(candidates.length, minK));
  }

  return selected;
}

/**
 * Main function:
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
toolPrune.TurboQuantEngine = TurboQuantEngine;
toolPrune.normalizeTools = normalizeTools;
toolPrune.autoSelectCandidates = autoSelectCandidates;
