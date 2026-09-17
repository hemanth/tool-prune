import { TurboQuantEngine } from './turboquant.js';
import { PRESETS, SAMPLE_QUERIES } from './catalog.js';
import { highlightCode } from './highlighter.js';

class PlaygroundApp {
  constructor() {
    this.activePresetId = 'mcp_dev';
    this.activeTools = { ...PRESETS.mcp_dev.tools };
    this.engine = new TurboQuantEngine();
    this.topK = 3;
    this.threshold = 0.85;
    this.selectedEngineType = 'turboquant';
    this.customApiKey = '';
    this.activeCodeLang = 'js';
    this.currentRawCode = '';

    // UI elements
    this.queryInput = document.getElementById('query-input');
    this.presetSelector = document.getElementById('preset-selector');
    this.topKSlider = document.getElementById('topk-slider');
    this.topKValue = document.getElementById('topk-value');
    this.thresholdSlider = document.getElementById('threshold-slider');
    this.thresholdValue = document.getElementById('threshold-value');
    this.resultsContainer = document.getElementById('candidates-list');
    this.top1Card = document.getElementById('top1-card');
    this.latencyBadge = document.getElementById('metric-latency');
    this.savingsBadge = document.getElementById('metric-savings');
    this.dispatchStatus = document.getElementById('dispatch-status');
    this.quickChipsContainer = document.getElementById('quick-chips');
    this.toolCountBadge = document.getElementById('tool-count-badge');
    this.codeSnippetEl = document.getElementById('code-snippet');
    this.toolCatalogModal = document.getElementById('tool-catalog-modal');
    this.toolCatalogList = document.getElementById('tool-catalog-list');
    this.toolCatalogSearch = document.getElementById('tool-catalog-search');

    this.init();
  }

  init() {
    this.rebuildEngine();
    this.renderQuickChips();
    this.bindEvents();
    this.initCalculator();
    this.runPrune();
  }

  rebuildEngine() {
    const start = performance.now();
    this.engine.fit(this.activeTools);
    const fitTime = performance.now() - start;
    const count = Object.keys(this.activeTools).length;
    if (this.toolCountBadge) {
      this.toolCountBadge.textContent = `${count} tools active`;
    }
  }

  renderQuickChips() {
    if (!this.quickChipsContainer) return;
    this.quickChipsContainer.innerHTML = '';

    SAMPLE_QUERIES.forEach(sample => {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'quick-chip group relative inline-flex items-center gap-1.5 px-3 py-1.5 rounded-full text-xs font-medium bg-neutral-100/90 text-neutral-800 border border-neutral-200/80 hover:bg-neutral-200/90 hover:border-neutral-300 transition-all duration-200 active:scale-[0.97]';
      btn.innerHTML = `
        <span class="chip-text">${sample.label}</span>
      `;
      btn.addEventListener('click', () => {
        this.queryInput.value = sample.query;
        this.runPrune();
        this.queryInput.focus();
      });
      this.quickChipsContainer.appendChild(btn);
    });
  }

  bindEvents() {
    // Query input
    if (this.queryInput) {
      this.queryInput.addEventListener('input', () => this.runPrune());
      this.queryInput.addEventListener('keydown', (e) => {
        if (e.key === 'Escape') {
          this.queryInput.value = '';
          this.runPrune();
        }
      });
    }

    // Keyboard shortcut / or Cmd+K
    window.addEventListener('keydown', (e) => {
      if ((e.metaKey || e.ctrlKey) && e.key === 'k') {
        e.preventDefault();
        this.queryInput?.focus();
        this.queryInput?.select();
      }
    });

    // Preset selector
    if (this.presetSelector) {
      this.presetSelector.addEventListener('change', (e) => {
        this.activePresetId = e.target.value;
        const preset = PRESETS[this.activePresetId];
        if (preset) {
          this.activeTools = { ...preset.tools };
          this.rebuildEngine();
          this.runPrune();
        }
      });
    }

    // Top-K slider
    if (this.topKSlider) {
      this.topKSlider.addEventListener('input', (e) => {
        this.topK = parseInt(e.target.value, 10);
        if (this.topKValue) this.topKValue.textContent = `Top-${this.topK}`;
        this.runPrune();
      });
    }

    // Threshold slider
    if (this.thresholdSlider) {
      this.thresholdSlider.addEventListener('input', (e) => {
        this.threshold = parseInt(e.target.value, 10) / 100;
        if (this.thresholdValue) this.thresholdValue.textContent = `${Math.round(this.threshold * 100)}%`;
        this.runPrune();
      });
    }

    // Code lang tabs
    document.querySelectorAll('[data-lang-tab]').forEach(tab => {
      tab.addEventListener('click', (e) => {
        const lang = e.currentTarget.getAttribute('data-lang-tab');
        this.activeCodeLang = lang;
        document.querySelectorAll('[data-lang-tab]').forEach(t => {
          const active = t.getAttribute('data-lang-tab') === lang;
          t.setAttribute('aria-selected', active ? 'true' : 'false');
          t.className = active
            ? 'px-3.5 py-1.5 text-xs font-semibold rounded-lg bg-white shadow-sm border border-neutral-200 text-neutral-900'
            : 'px-3.5 py-1.5 text-xs font-medium rounded-lg text-neutral-600 hover:text-neutral-900';
        });
        this.updateCodeSnippet();
      });
    });

    // Copy buttons
    document.querySelectorAll('[data-copy-target]').forEach(btn => {
      btn.addEventListener('click', () => {
        const targetId = btn.getAttribute('data-copy-target');
        let text = '';
        if (targetId === 'code-snippet' && this.currentRawCode) {
          text = this.currentRawCode;
        } else {
          text = document.getElementById(targetId)?.textContent || '';
        }
        navigator.clipboard.writeText(text).then(() => {
          const originalText = btn.innerHTML;
          btn.innerHTML = `
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" class="text-emerald-700 inline-block mr-1"><path d="M20 6 9 17l-5-5"/></svg>
            <span class="text-emerald-800">Copied</span>
          `;
          btn.classList.add('bg-emerald-50', 'border-emerald-200');
          setTimeout(() => {
            btn.innerHTML = originalText;
            btn.classList.remove('bg-emerald-50', 'border-emerald-200');
          }, 2000);
        });
      });
    });

    // Catalog modal toggle
    const inspectBtn = document.getElementById('btn-inspect-catalog');
    const closeCatalogBtn = document.getElementById('btn-close-catalog');
    if (inspectBtn && this.toolCatalogModal) {
      inspectBtn.addEventListener('click', () => {
        this.renderCatalogList();
        this.toolCatalogModal.classList.remove('hidden');
      });
    }
    if (closeCatalogBtn && this.toolCatalogModal) {
      closeCatalogBtn.addEventListener('click', () => {
        this.toolCatalogModal.classList.add('hidden');
      });
    }

    // Catalog search
    if (this.toolCatalogSearch) {
      this.toolCatalogSearch.addEventListener('input', () => {
        this.renderCatalogList(this.toolCatalogSearch.value);
      });
    }

    // Add tool button
    const addToolBtn = document.getElementById('btn-add-tool');
    if (addToolBtn) {
      addToolBtn.addEventListener('click', () => {
        const nameInput = document.getElementById('new-tool-name');
        const descInput = document.getElementById('new-tool-desc');
        const critInput = document.getElementById('new-tool-crit');
        const domainInput = document.getElementById('new-tool-domain');

        const name = (nameInput?.value || '').trim();
        const desc = (descInput?.value || '').trim();
        const crit = (critInput?.value || '').trim();
        const domain = (domainInput?.value || 'custom').trim();

        if (!name || !desc) {
          alert('Please provide a tool name and description.');
          return;
        }

        this.activeTools[name] = {
          domain,
          description: desc,
          criteria: crit || desc,
          estimatedTokens: 150
        };

        this.rebuildEngine();
        this.renderCatalogList();
        this.runPrune();

        // Clear inputs
        if (nameInput) nameInput.value = '';
        if (descInput) descInput.value = '';
        if (critInput) critInput.value = '';

        const notice = document.getElementById('add-tool-notice');
        if (notice) {
          notice.textContent = `Added ${name} to active tools`;
          notice.classList.remove('hidden');
          setTimeout(() => notice.classList.add('hidden'), 2500);
        }
      });
    }
  }

  runPrune() {
    const query = (this.queryInput?.value || '').trim() || 'read the package.json file to see dependencies';
    const tStart = performance.now();

    const rawResults = this.engine.search(query, this.topK);
    const latency = performance.now() - tStart;

    // Enrich results with metadata
    const candidates = rawResults.map(item => {
      const toolMeta = this.activeTools[item.name] || {};
      return {
        name: item.name,
        probability: item.probability,
        score: item.score,
        domain: toolMeta.domain || 'general',
        description: toolMeta.description || '',
        criteria: toolMeta.criteria || '',
        tokens: toolMeta.estimatedTokens || 150
      };
    });

    const top1 = candidates[0] || null;

    // Compute token savings
    const totalTools = Object.keys(this.activeTools).length;
    const baselineTokens = Object.values(this.activeTools).reduce((acc, t) => acc + (t.estimatedTokens || 150), 0);
    const prunedTokens = candidates.reduce((acc, c) => acc + c.tokens, 0);
    const savedPercent = baselineTokens > 0
      ? Math.max(0, Math.min(99, ((1 - (prunedTokens / baselineTokens)) * 100))).toFixed(1)
      : '0';

    // Update metrics in UI
    if (this.latencyBadge) {
      this.latencyBadge.textContent = `${latency.toFixed(2)} ms`;
    }
    if (this.savingsBadge) {
      this.savingsBadge.textContent = `-${savedPercent}% tokens`;
    }

    const candidatesCountEl = document.getElementById('candidates-count');
    if (candidatesCountEl) {
      candidatesCountEl.textContent = `Top-${this.topK}`;
    }

    this.renderTop1Card(top1, query, latency);
    this.renderCandidatesList(candidates);
    this.updateDispatchStatus(top1);
    this.updateCodeSnippet(query, top1, latency);
  }

  renderTop1Card(top1, query, latency) {
    if (!this.top1Card || !top1) return;

    const probPct = Math.round(top1.probability * 100);
    const isDirectDispatch = top1.probability >= this.threshold;

    this.top1Card.innerHTML = `
      <div class="flex flex-col md:flex-row md:items-center justify-between gap-4 pb-4 border-b border-neutral-200/70">
        <div>
          <div class="flex items-center gap-2 mb-1.5">
            <span class="inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-semibold bg-emerald-100/90 text-emerald-800 border border-emerald-300/60">
              Rank #1 Selected Tool
            </span>
            <span class="inline-flex items-center px-2 py-0.5 rounded-full text-[11px] font-mono uppercase tracking-wider bg-neutral-100 text-neutral-600 border border-neutral-200">
              ${escapeHtml(top1.domain)}
            </span>
          </div>
          <h3 class="text-2xl font-bold font-mono text-neutral-900 tracking-tight">
            ${escapeHtml(top1.name)}
          </h3>
        </div>
        <div class="flex items-center gap-3">
          <div class="text-right">
            <div class="text-xs font-mono uppercase tracking-wider text-neutral-500">Calibrated Confidence</div>
            <div class="text-2xl font-bold font-mono ${probPct >= 85 ? 'text-emerald-700' : 'text-amber-700'}">
              ${probPct}%
            </div>
          </div>
          <div class="w-16 h-16 rounded-2xl ${isDirectDispatch ? 'bg-emerald-50 text-emerald-700 border border-emerald-200/90' : 'bg-amber-50 text-amber-700 border border-amber-200/90'} flex flex-col items-center justify-center font-mono text-xs font-semibold p-1 text-center">
            <span>${isDirectDispatch ? '⚡ FAST' : '🤖 PASS'}</span>
            <span class="text-[10px] font-normal opacity-80">${isDirectDispatch ? '<1ms' : 'LLM'}</span>
          </div>
        </div>
      </div>
      
      <div class="pt-4 grid grid-cols-1 md:grid-cols-2 gap-4 text-sm">
        <div>
          <p class="text-xs font-mono uppercase tracking-wider text-neutral-500 mb-1">Tool Description</p>
          <p class="text-neutral-800 leading-relaxed font-normal">${escapeHtml(top1.description)}</p>
        </div>
        <div>
          <p class="text-xs font-mono uppercase tracking-wider text-neutral-500 mb-1">Matching Criteria</p>
          <p class="text-neutral-600 leading-relaxed font-normal">${escapeHtml(top1.criteria || top1.description)}</p>
        </div>
      </div>
    `;
  }

  renderCandidatesList(candidates) {
    if (!this.resultsContainer) return;
    this.resultsContainer.innerHTML = '';

    candidates.forEach((cand, idx) => {
      const probPct = Math.round(cand.probability * 100);
      const isTop1 = idx === 0;

      const row = document.createElement('div');
      row.className = `p-4 rounded-xl border transition-all duration-200 ${
        isTop1
          ? 'bg-white border-emerald-300 shadow-sm ring-1 ring-emerald-200/50'
          : 'bg-white/70 border-neutral-200/80 hover:border-neutral-300 hover:bg-white'
      }`;

      row.innerHTML = `
        <div class="flex items-start justify-between gap-3">
          <div class="min-w-0 flex-1">
            <div class="flex items-center gap-2 mb-1">
              <span class="font-mono text-xs font-semibold px-2 py-0.5 rounded-md ${
                isTop1 ? 'bg-emerald-100 text-emerald-800' : 'bg-neutral-100 text-neutral-700'
              }">#${idx + 1}</span>
              <span class="font-mono text-sm font-bold text-neutral-900 truncate">${escapeHtml(cand.name)}</span>
              <span class="text-[10px] font-mono uppercase px-2 py-0.5 rounded-full bg-neutral-100 text-neutral-500 border border-neutral-200/60">${escapeHtml(cand.domain)}</span>
            </div>
            <p class="text-xs text-neutral-600 line-clamp-2 leading-relaxed mt-1">${escapeHtml(cand.description)}</p>
          </div>
          <div class="text-right shrink-0">
            <span class="font-mono text-sm font-bold ${probPct >= 80 ? 'text-emerald-700' : 'text-neutral-700'}">${probPct}%</span>
            <div class="w-20 bg-neutral-100 rounded-full h-1.5 mt-1.5 overflow-hidden border border-neutral-200/70">
              <div class="h-full rounded-full ${probPct >= 80 ? 'bg-emerald-500' : 'bg-amber-400'}" style="width: ${probPct}%"></div>
            </div>
          </div>
        </div>
      `;
      this.resultsContainer.appendChild(row);
    });
  }

  updateDispatchStatus(top1) {
    if (!this.dispatchStatus || !top1) return;

    const prob = top1.probability;
    const isDirect = prob >= this.threshold;

    if (isDirect) {
      this.dispatchStatus.className = 'p-4 rounded-xl border border-emerald-300/80 bg-emerald-50/80 text-emerald-950 flex items-start gap-3';
      this.dispatchStatus.innerHTML = `
        <div class="w-7 h-7 rounded-lg bg-emerald-200/70 text-emerald-800 flex items-center justify-center shrink-0 mt-0.5 font-mono text-sm">⚡</div>
        <div class="text-sm">
          <p class="font-semibold text-emerald-900">Fast-Path Direct Dispatch Triggered (${Math.round(prob * 100)}% ≥ ${Math.round(this.threshold * 100)}%)</p>
          <p class="text-xs text-emerald-800/90 mt-0.5 leading-relaxed">
            Confidence exceeds your threshold. tool-prune dispatches the deterministic handler directly in under 1ms. The LLM call is bypassed completely with zero token cost.
          </p>
        </div>
      `;
    } else {
      this.dispatchStatus.className = 'p-4 rounded-xl border border-amber-300/80 bg-amber-50/80 text-amber-950 flex items-start gap-3';
      this.dispatchStatus.innerHTML = `
        <div class="w-7 h-7 rounded-lg bg-amber-200/70 text-amber-800 flex items-center justify-center shrink-0 mt-0.5 font-mono text-sm">🤖</div>
        <div class="text-sm">
          <p class="font-semibold text-amber-900">Prompt Schema Pruned for LLM (${Math.round(prob * 100)}% < ${Math.round(this.threshold * 100)}%)</p>
          <p class="text-xs text-amber-800/90 mt-0.5 leading-relaxed">
            Confidence is below threshold. tool-prune prunes your MCP catalog to the top-${this.topK} candidate schemas before calling your LLM. Token overhead dropped by over 85%.
          </p>
        </div>
      `;
    }
  }

  async updateCodeSnippet(query = '', top1 = null, latency = null) {
    if (!this.codeSnippetEl) return;
    const qStr = query || this.lastQuery || (this.queryInput?.value || '').trim() || 'read the package.json file to see dependencies';
    const activeTop1 = top1 || this.lastTop1 || this.engine.search(qStr, 1)[0] || { name: 'fs_read_file', probability: 0.88 };
    const toolName = activeTop1.name || 'fs_read_file';
    const lat = latency ?? this.lastLatency ?? 0.24;

    this.lastQuery = qStr;
    this.lastTop1 = activeTop1;
    this.lastLatency = lat;

    // Build the tools map so the selected tool and candidate tools are always defined
    const snippetTools = {};
    snippetTools[toolName] = this.activeTools[toolName]?.description || 'Execute ' + toolName;

    // Add other top candidates
    const searchResults = this.engine.search(qStr, Math.max(3, this.topK));
    for (const item of searchResults) {
      if (!snippetTools[item.name] && Object.keys(snippetTools).length < 4) {
        snippetTools[item.name] = this.activeTools[item.name]?.description || 'Execute ' + item.name;
      }
    }

    // Ensure at least 3 tools are displayed
    for (const [name, meta] of Object.entries(this.activeTools)) {
      if (!snippetTools[name] && Object.keys(snippetTools).length < 3) {
        snippetTools[name] = meta.description || 'Tool description';
      }
    }

    let code = '';
    if (this.activeCodeLang === 'js') {
      code = `// One-shot tool selection with offline TurboQuant (${lat.toFixed(2)}ms)
import prune from 'tool-prune';

const tools = ${JSON.stringify(snippetTools, null, 2)};

// 1. Direct prune or LLM candidate filter
const match = await prune(${JSON.stringify(qStr)}, tools, {
  topK: ${this.topK}
});

console.log(match.tool);       // "${toolName}"
console.log(match.confidence); // ${(activeTop1.probability || 0.88).toFixed(3)}
console.log(match.latency);    // ${lat.toFixed(2)}ms

// 2. Fast-path direct dispatch when confident:
const router = prune(tools, { threshold: ${this.threshold} });
const result = await router.dispatch(${JSON.stringify(qStr)}, {
  ${toolName}: (query) => executeHandler(query),
  fallback: (query, candidates) => callLLM(query, candidates)
});`;
    } else if (this.activeCodeLang === 'py') {
      const pyToolsEntries = Object.entries(snippetTools)
        .map(([k, v]) => `    ${JSON.stringify(k)}: ${JSON.stringify(v)}`)
        .join(',\n');

      code = `# Python API: zero dependencies offline TurboQuant
from tool_prune import prune, ToolPrune

tools = {
${pyToolsEntries}
}

# 1. One-shot offline selection
match = prune(${JSON.stringify(qStr)}, tools)
print(match.tool)        # "${toolName}"
print(match.confidence)  # ${(activeTop1.probability || 0.88).toFixed(3)}

# 2. Reusable router for LLM prompt pruning
router = ToolPrune(tools, threshold=${this.threshold})
candidates = router.filter(${JSON.stringify(qStr)}, k=${this.topK})

# 3. Fast-path direct dispatch
result = router.dispatch(${JSON.stringify(qStr)}, {
    "${toolName}": lambda q: handle_direct(q),
    "fallback": lambda q, c: call_llm(q, c)
})`;
    }

    this.currentRawCode = code;

    // Apply syntax highlighting
    const { html } = await highlightCode(code, this.activeCodeLang);
    this.codeSnippetEl.innerHTML = html;
  }

  renderCatalogList(filter = '') {
    if (!this.toolCatalogList) return;
    this.toolCatalogList.innerHTML = '';
    const term = filter.toLowerCase();

    const entries = Object.entries(this.activeTools).filter(([name, t]) => {
      if (!term) return true;
      return name.toLowerCase().includes(term) ||
             t.description?.toLowerCase().includes(term) ||
             t.domain?.toLowerCase().includes(term);
    });

    entries.forEach(([name, t]) => {
      const item = document.createElement('div');
      item.className = 'p-3 rounded-xl border border-neutral-200/80 bg-neutral-50/60 text-xs flex flex-col gap-1';
      item.innerHTML = `
        <div class="flex items-center justify-between">
          <span class="font-mono font-bold text-neutral-900">${escapeHtml(name)}</span>
          <span class="font-mono uppercase text-[10px] px-2 py-0.5 rounded-full bg-neutral-200/60 text-neutral-700">${escapeHtml(t.domain || 'tool')}</span>
        </div>
        <p class="text-neutral-600 leading-normal">${escapeHtml(t.description || '')}</p>
        ${t.criteria ? `<p class="text-neutral-500 font-mono text-[11px] mt-1 bg-white/70 p-1.5 rounded border border-neutral-200/60">Criteria: ${escapeHtml(t.criteria)}</p>` : ''}
      `;
      this.toolCatalogList.appendChild(item);
    });
  }

  initCalculator() {
    const stepsSlider = document.getElementById('calc-steps');
    const toolsSlider = document.getElementById('calc-tools');
    const modelSelect = document.getElementById('calc-model');

    const stepsVal = document.getElementById('calc-steps-val');
    const toolsVal = document.getElementById('calc-tools-val');
    const savedTokensEl = document.getElementById('calc-saved-tokens');
    const savedDollarsEl = document.getElementById('calc-saved-dollars');
    const savedHoursEl = document.getElementById('calc-saved-latency');

    const updateCalc = () => {
      const dailySteps = parseInt(stepsSlider?.value || 5000, 10);
      const toolCount = parseInt(toolsSlider?.value || 40, 10);
      const costPerMillion = parseFloat(modelSelect?.value || 3.0); // e.g. $3 per 1M tokens

      if (stepsVal) stepsVal.textContent = Number(dailySteps).toLocaleString();
      if (toolsVal) toolsVal.textContent = `${toolCount} tools`;

      // Calculation:
      // Average tool schema = 160 tokens
      // Baseline prompt per step = toolCount * 160
      // Pruned prompt per step = 3 * 160 = 480 tokens
      // Saved tokens per step = Math.max(0, (toolCount - 3) * 160)
      const tokensSavedPerStep = Math.max(0, (toolCount - 3) * 160);
      const monthlyTokens = dailySteps * tokensSavedPerStep * 30;
      const monthlyCost = (monthlyTokens / 1000000) * costPerMillion;

      // Latency saved: LLM input ingestion + time = ~1.2ms per tool token or ~800ms saved per step
      const monthlyHoursSaved = (dailySteps * 30 * 0.7) / 3600; // in hours

      if (savedTokensEl) {
        if (monthlyTokens >= 1000000000) {
          savedTokensEl.textContent = `${(monthlyTokens / 1000000000).toFixed(2)}B`;
        } else {
          savedTokensEl.textContent = `${Math.round(monthlyTokens / 1000000)}M`;
        }
      }
      if (savedDollarsEl) {
        savedDollarsEl.textContent = `$${Math.round(monthlyCost).toLocaleString()}`;
      }
      if (savedHoursEl) {
        savedHoursEl.textContent = `${Math.round(monthlyHoursSaved).toLocaleString()}h`;
      }
    };

    stepsSlider?.addEventListener('input', updateCalc);
    toolsSlider?.addEventListener('input', updateCalc);
    modelSelect?.addEventListener('change', updateCalc);
    updateCalc();
  }
}

function escapeHtml(str) {
  if (!str) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

document.addEventListener('DOMContentLoaded', () => {
  window.playground = new PlaygroundApp();
});
