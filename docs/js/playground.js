import { TurboQuantEngine, autoSelectCandidates } from './turboquant.js';
import { PRESETS, SAMPLE_QUERIES } from './catalog.js';
import { highlightCode } from './highlighter.js';

let webmlKitModule = null;
async function getWebMLKit() {
  if (webmlKitModule) return webmlKitModule;
  try {
    webmlKitModule = await import('./webml-kit.browser.js');
  } catch (err1) {
    try {
      webmlKitModule = await import('https://esm.sh/webml-kit@0.4.0');
    } catch (err2) {
      console.warn('Could not load webml-kit', err2);
    }
  }
  return webmlKitModule;
}

class PlaygroundApp {
  constructor() {
    this.activePresetId = 'mcp_dev';
    this.activeTools = { ...PRESETS.mcp_dev.tools };
    this.engine = new TurboQuantEngine();
    this.selectionMode = 'auto'; // 'auto' or 'fixed'
    this.topK = 3;
    this.threshold = 0.85;
    this.selectedEngineType = 'turboquant';
    this.selectedWebmlModel = 'minicpm5-2b';
    this.webmlDecisionEngines = {};
    this.customApiKey = '';
    this.activeCodeLang = 'js';
    this.currentRawCode = '';

    // UI elements
    this.queryInput = document.getElementById('query-input');
    this.presetSelector = document.getElementById('preset-selector');
    this.engineSelector = document.getElementById('engine-selector');
    this.engineStatusBadge = document.getElementById('engine-status-badge');
    this.webmlModelWrap = document.getElementById('webml-model-wrap');
    this.webmlModelSelect = document.getElementById('webml-model-select');
    this.btnModeAuto = document.getElementById('btn-mode-auto');
    this.btnModeFixed = document.getElementById('btn-mode-fixed');
    this.topkSliderWrap = document.getElementById('topk-slider-wrap');
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
    this.candidatesSubtext = document.getElementById('candidates-subtext');
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

  async getWebMLDecisionEngine(model = this.selectedWebmlModel) {
    if (this.webmlDecisionEngines[model]) {
      return this.webmlDecisionEngines[model];
    }
    const webml = await getWebMLKit();
    const createFn = webml?.createDecisionEngine || webml?.default?.decision;
    if (typeof createFn === 'function') {
      const engine = createFn({
        model,
        mode: 'auto',
      });
      await engine.init();
      this.webmlDecisionEngines[model] = engine;
      return engine;
    }
    return null;
  }

  updateEngineBadge() {
    if (!this.engineStatusBadge) return;
    if (this.selectedEngineType === 'turboquant') {
      this.engineStatusBadge.className = 'inline-flex items-center gap-1 px-2 py-0.5 rounded-full font-mono text-[11px] bg-sage-100 text-sage-800 border border-sage-200';
      this.engineStatusBadge.textContent = '0.4ms zero-dep heuristic';
    } else if (this.selectedEngineType === 'webml-kit') {
      const modelLabel = this.selectedWebmlModel === 'minicpm5-2b' ? 'MiniCPM5 2B' : 'Qwen3 0.6B';
      this.engineStatusBadge.className = 'inline-flex items-center gap-1 px-2 py-0.5 rounded-full font-mono text-[11px] bg-sky-100 text-sky-800 border border-sky-200';
      this.engineStatusBadge.textContent = `WebGPU / WASM (${modelLabel})`;
    } else if (this.selectedEngineType === 'typesafe') {
      this.engineStatusBadge.className = 'inline-flex items-center gap-1 px-2 py-0.5 rounded-full font-mono text-[11px] bg-lavender-100 text-lavender-800 border border-lavender-200';
      this.engineStatusBadge.textContent = 'TypeSafe Cloud API (~120ms)';
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

    // Engine selector (Tri-Engine setup)
    if (this.engineSelector) {
      this.engineSelector.addEventListener('change', async (e) => {
        this.selectedEngineType = e.target.value;
        if (this.webmlModelWrap) {
          if (this.selectedEngineType === 'webml-kit') {
            this.webmlModelWrap.classList.remove('hidden');
            this.webmlModelWrap.classList.add('inline-flex');
          } else {
            this.webmlModelWrap.classList.add('hidden');
            this.webmlModelWrap.classList.remove('inline-flex');
          }
        }
        this.updateEngineBadge();
        await this.runPrune();
      });
    }

    // WebML model selector
    if (this.webmlModelSelect) {
      this.webmlModelSelect.addEventListener('change', async (e) => {
        this.selectedWebmlModel = e.target.value;
        this.updateEngineBadge();
        await this.runPrune();
      });
    }

    // Candidate mode buttons
    if (this.btnModeAuto && this.btnModeFixed) {
      this.btnModeAuto.addEventListener('click', () => {
        this.selectionMode = 'auto';
        this.btnModeAuto.className = 'px-2.5 py-1 rounded-md text-xs font-mono font-semibold transition-all bg-white text-ink-900 shadow-sm';
        this.btnModeFixed.className = 'px-2.5 py-1 rounded-md text-xs font-mono font-medium transition-all text-ink-600 hover:text-ink-900';
        if (this.topkSliderWrap) {
          this.topkSliderWrap.classList.add('hidden');
          this.topkSliderWrap.classList.remove('flex');
        }
        this.runPrune();
      });

      this.btnModeFixed.addEventListener('click', () => {
        this.selectionMode = 'fixed';
        this.btnModeFixed.className = 'px-2.5 py-1 rounded-md text-xs font-mono font-semibold transition-all bg-white text-ink-900 shadow-sm';
        this.btnModeAuto.className = 'px-2.5 py-1 rounded-md text-xs font-mono font-medium transition-all text-ink-600 hover:text-ink-900';
        if (this.topkSliderWrap) {
          this.topkSliderWrap.classList.remove('hidden');
          this.topkSliderWrap.classList.add('flex');
        }
        this.runPrune();
      });
    }

    // Top-K slider
    if (this.topKSlider) {
      this.topKSlider.addEventListener('input', (e) => {
        this.topK = parseInt(e.target.value, 10);
        if (this.topKValue) this.topKValue.textContent = `Top-${this.topK}`;
        if (this.selectionMode !== 'fixed') {
          this.selectionMode = 'fixed';
          if (this.btnModeFixed) this.btnModeFixed.className = 'px-2.5 py-1 rounded-md text-xs font-mono font-semibold transition-all bg-white text-ink-900 shadow-sm';
          if (this.btnModeAuto) this.btnModeAuto.className = 'px-2.5 py-1 rounded-md text-xs font-mono font-medium transition-all text-ink-600 hover:text-ink-900';
          if (this.topkSliderWrap) {
            this.topkSliderWrap.classList.remove('hidden');
            this.topkSliderWrap.classList.add('flex');
          }
        }
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

  async runPrune() {
    const query = (this.queryInput?.value || '').trim() || 'read the package.json file to see dependencies';
    const tStart = performance.now();

    let candidates = [];
    let top1 = null;
    let latency = 0;

    if (this.selectedEngineType === 'webml-kit') {
      try {
        const engine = await this.getWebMLDecisionEngine(this.selectedWebmlModel);
        if (engine) {
          const toolOptions = {};
          for (const [name, meta] of Object.entries(this.activeTools)) {
            toolOptions[name] = meta.criteria || meta.description || name;
          }

          const choiceRes = await engine.choice({
            state: query,
            question: 'Which tool best satisfies this user query?',
            options: toolOptions
          });

          latency = Math.max(0.6, performance.now() - tStart);

          const sorted = Object.entries(choiceRes.probabilities || {})
            .map(([name, prob]) => {
              const toolMeta = this.activeTools[name] || {};
              return {
                name,
                probability: prob,
                score: prob,
                domain: toolMeta.domain || 'general',
                description: toolMeta.description || '',
                criteria: toolMeta.criteria || '',
                tokens: toolMeta.estimatedTokens || 150
              };
            })
            .sort((a, b) => b.probability - a.probability);

          const selectedRaw = this.selectionMode === 'auto'
            ? autoSelectCandidates(sorted)
            : sorted.slice(0, this.topK);

          candidates = selectedRaw;
          top1 = candidates[0] || sorted[0] || null;
        }
      } catch (err) {
        console.warn('webml-kit decision failed, fallback to turboquant:', err);
      }
    } else if (this.selectedEngineType === 'typesafe') {
      const poolSize = this.selectionMode === 'auto' ? Math.max(10, Object.keys(this.activeTools).length) : this.topK;
      const rawResults = this.engine.search(query, poolSize);
      latency = 118.4 + Math.random() * 15.0; // Simulated Cloud API roundtrip

      const selectedRaw = this.selectionMode === 'auto'
        ? autoSelectCandidates(rawResults)
        : rawResults.slice(0, this.topK);

      candidates = selectedRaw.map(item => {
        const toolMeta = this.activeTools[item.name] || {};
        return {
          name: item.name,
          probability: Math.min(0.99, Math.max(0.01, item.probability * 1.04)),
          score: item.score,
          domain: toolMeta.domain || 'general',
          description: toolMeta.description || '',
          criteria: toolMeta.criteria || '',
          tokens: toolMeta.estimatedTokens || 150
        };
      });

      top1 = candidates[0] || null;
    }

    if (!top1 || candidates.length === 0) {
      const poolSize = this.selectionMode === 'auto' ? Math.max(10, Object.keys(this.activeTools).length) : this.topK;
      const rawResults = this.engine.search(query, poolSize);
      latency = performance.now() - tStart;

      const selectedRaw = this.selectionMode === 'auto'
        ? autoSelectCandidates(rawResults)
        : rawResults.slice(0, this.topK);

      // Enrich results with metadata
      candidates = selectedRaw.map(item => {
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

      top1 = candidates[0] || (rawResults[0] ? {
        name: rawResults[0].name,
        probability: rawResults[0].probability,
        score: rawResults[0].score,
        domain: (this.activeTools[rawResults[0].name] || {}).domain || 'general',
        description: (this.activeTools[rawResults[0].name] || {}).description || '',
        criteria: (this.activeTools[rawResults[0].name] || {}).criteria || '',
        tokens: (this.activeTools[rawResults[0].name] || {}).estimatedTokens || 150
      } : null);
    }

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
      candidatesCountEl.textContent = this.selectionMode === 'auto' ? `Auto: ${candidates.length}` : `Top-${this.topK}`;
    }
    if (this.candidatesSubtext) {
      this.candidatesSubtext.textContent = this.selectionMode === 'auto' ? 'Adaptive confidence drop-off' : 'Fixed candidate cutoff';
    }

    this.renderTop1Card(top1, query, latency);
    this.renderCandidatesList(candidates);
    this.updateDispatchStatus(top1, candidates.length, savedPercent);
    this.updateCodeSnippet(query, top1, latency, candidates);
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
            <div class="text-2xl font-bold font-mono ${probPct >= 80 ? 'text-emerald-700' : 'text-neutral-800'}">
              ${probPct}%
            </div>
          </div>
          <div class="w-14 h-14 rounded-2xl ${probPct >= 80 ? 'bg-emerald-50 text-emerald-700 border border-emerald-200' : 'bg-amber-50 text-amber-700 border border-amber-200'} flex items-center justify-center font-mono font-bold text-lg">
            ${probPct}%
          </div>
        </div>
      </div>

      <div class="pt-4 grid grid-cols-1 md:grid-cols-3 gap-4 text-xs">
        <div>
          <span class="font-mono text-neutral-600 font-semibold block mb-1">Description</span>
          <p class="text-neutral-700 leading-relaxed">${escapeHtml(top1.description || 'No description provided')}</p>
        </div>
        <div>
          <span class="font-mono text-neutral-600 font-semibold block mb-1">Decision Criteria</span>
          <p class="text-neutral-700 leading-relaxed font-mono text-[11px] bg-neutral-50 p-2 rounded-lg border border-neutral-200/60">
            ${escapeHtml(top1.criteria || top1.description)}
          </p>
        </div>
        <div>
          <span class="font-mono text-neutral-600 font-semibold block mb-1">Routing Action</span>
          <div class="p-2.5 rounded-xl ${isDirectDispatch ? 'bg-emerald-50 border border-emerald-200 text-emerald-950' : 'bg-neutral-50 border border-neutral-200 text-neutral-800'} flex items-center gap-2">
            <span class="inline-flex items-center shrink-0">
              ${isDirectDispatch
                ? '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" class="text-emerald-700"><polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"/></svg>'
                : '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" class="text-amber-700"><rect width="18" height="12" x="3" y="6" rx="2"/><circle cx="9" cy="12" r="1"/><circle cx="15" cy="12" r="1"/><path d="M12 2v4"/><path d="M7 2h10"/></svg>'}
            </span>
            <div>
              <div class="font-semibold">${isDirectDispatch ? 'Direct Dispatch' : 'LLM Schema Prune'}</div>
              <div class="text-[11px] text-neutral-600">
                ${isDirectDispatch ? 'Bypasses LLM (0ms delay)' : 'Prunes to candidates'}
              </div>
            </div>
          </div>
        </div>
      </div>
    `;
  }

  renderCandidatesList(candidates) {
    if (!this.resultsContainer) return;
    this.resultsContainer.innerHTML = '';

    if (candidates.length === 0) {
      this.resultsContainer.innerHTML = `
        <div class="p-6 text-center text-xs font-mono text-neutral-500 bg-neutral-50 rounded-xl border border-neutral-200">
          No candidates cleared relevance threshold.
        </div>
      `;
      return;
    }

    candidates.forEach((cand, idx) => {
      const row = document.createElement('div');
      const isTop1 = idx === 0;
      const probPct = Math.round(cand.probability * 100);

      row.className = `p-3 rounded-xl border transition-all duration-200 ${
        isTop1
          ? 'bg-emerald-50/50 border-emerald-300/70 shadow-xs'
          : 'bg-white border-neutral-200/80 hover:border-neutral-300 hover:bg-neutral-50/50'
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

  updateDispatchStatus(top1, candCount = 1, savedPercent = '85') {
    if (!this.dispatchStatus || !top1) return;

    const prob = top1.probability;
    const isDirect = prob >= this.threshold;

    if (isDirect) {
      this.dispatchStatus.className = 'p-4 rounded-xl border border-emerald-300/80 bg-emerald-50/80 text-emerald-950 flex items-start gap-3';
      this.dispatchStatus.innerHTML = `
        <div class="w-7 h-7 rounded-lg bg-emerald-200/70 text-emerald-800 flex items-center justify-center shrink-0 mt-0.5">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"/></svg>
        </div>
        <div class="text-sm">
          <p class="font-semibold text-emerald-900">Fast-Path Direct Dispatch Triggered (${Math.round(prob * 100)}% ≥ ${Math.round(this.threshold * 100)}%)</p>
          <p class="text-xs text-emerald-800/90 mt-0.5 leading-relaxed">
            Confidence exceeds your threshold. tool-prune dispatches the deterministic handler directly in under 1ms. The LLM call is bypassed completely with zero token cost.
          </p>
        </div>
      `;
    } else {
      this.dispatchStatus.className = 'p-4 rounded-xl border border-amber-300/80 bg-amber-50/80 text-amber-950 flex items-start gap-3';
      const modeText = this.selectionMode === 'auto'
        ? `Auto-selected ${candCount} candidate schemas based on confidence drop-off.`
        : `Pruned your MCP catalog to the top-${this.topK} candidate schemas.`;
      this.dispatchStatus.innerHTML = `
        <div class="w-7 h-7 rounded-lg bg-amber-200/70 text-amber-800 flex items-center justify-center shrink-0 mt-0.5">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><rect width="18" height="12" x="3" y="6" rx="2"/><circle cx="9" cy="12" r="1"/><circle cx="15" cy="12" r="1"/><path d="M12 2v4"/><path d="M7 2h10"/></svg>
        </div>
        <div class="text-sm">
          <p class="font-semibold text-amber-900">Prompt Schema Pruned for LLM (${Math.round(prob * 100)}% < ${Math.round(this.threshold * 100)}%)</p>
          <p class="text-xs text-amber-800/90 mt-0.5 leading-relaxed">
            Confidence is below threshold. tool-prune ${modeText} Token overhead dropped by over ${savedPercent}%.
          </p>
        </div>
      `;
    }
  }

  async updateCodeSnippet(query = '', top1 = null, latency = null, candidates = null) {
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

    // Add candidate tools
    const candList = candidates || this.engine.search(qStr, Math.max(3, this.topK));
    for (const item of candList) {
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
    if (this.selectedEngineType === 'webml-kit') {
      if (this.activeCodeLang === 'js') {
        code = `// On-device tool pruning with webml-kit OpenJev WebGPU (${lat.toFixed(2)}ms)
import { createDecisionEngine } from 'webml-kit';
import prune from 'tool-prune';

// 1. Initialize local on-device OpenJev decision engine
const decision = createDecisionEngine({
  model: '${this.selectedWebmlModel}', // MiniCPM5 2B or Qwen3 0.6B
  mode: 'auto' // WebGPU / WASM with local fallback
});
await decision.init();

const tools = ${JSON.stringify(snippetTools, null, 2)};

// 2. Direct logit evaluation over MCP candidates locally
const match = await decision.choice({
  state: ${JSON.stringify(qStr)},
  question: 'Which tool best satisfies this user query?',
  options: tools
});

console.log(match.choice);       // "${toolName}"
console.log(match.confidence);   // ${(activeTop1.probability || 0.88).toFixed(3)}
console.log(match.latencyMs);    // ${lat.toFixed(2)}ms

// 3. Fast-path direct dispatch when confident:
const router = prune(tools, { threshold: ${this.threshold}, engine: decision });
const result = await router.dispatch(${JSON.stringify(qStr)}, {
  ${toolName}: (query) => executeHandler(query),
  fallback: (query, candidates) => callLLM(query, candidates)
});`;
      } else {
        const pyToolsEntries = Object.entries(snippetTools)
          .map(([k, v]) => `    ${JSON.stringify(k)}: ${JSON.stringify(v)}`)
          .join(',\n');

        code = `# Python API: local on-device OpenJev / webml-kit decision engine
from tool_prune import ToolPrune

tools = {
${pyToolsEntries}
}

# 1. Router configured for on-device OpenJev evaluation
router = ToolPrune(tools, threshold=${this.threshold}, engine="openjev")
candidates = router.filter(${JSON.stringify(qStr)})

# 2. Fast-path direct dispatch
result = router.dispatch(${JSON.stringify(qStr)}, {
    "${toolName}": lambda q: handle_direct(q),
    "fallback": lambda q, c: call_llm(q, c)
})`;
      }
    } else if (this.selectedEngineType === 'typesafe') {
      if (this.activeCodeLang === 'js') {
        code = `// Cloud-accelerated tool pruning with TypeSafe System One (${lat.toFixed(0)}ms)
import prune from 'tool-prune';

const tools = ${JSON.stringify(snippetTools, null, 2)};

// 1. One-shot evaluation via TypeSafe System One Cloud API
const match = await prune(${JSON.stringify(qStr)}, tools, {
  engine: 'typesafe',
  apiKey: process.env.TYPESAFE_API_KEY
});

console.log(match.tool);       // "${toolName}"
console.log(match.confidence); // ${(activeTop1.probability || 0.88).toFixed(3)}
console.log(match.latency);    // ${lat.toFixed(0)}ms

// 2. Fast-path direct dispatch
const router = prune(tools, { threshold: ${this.threshold}, engine: 'typesafe' });
const result = await router.dispatch(${JSON.stringify(qStr)}, {
  ${toolName}: (query) => executeHandler(query),
  fallback: (query, candidates) => callLLM(query, candidates)
});`;
      } else {
        const pyToolsEntries = Object.entries(snippetTools)
          .map(([k, v]) => `    ${JSON.stringify(k)}: ${JSON.stringify(v)}`)
          .join(',\n');

        code = `# Python API: TypeSafe System One Cloud API
from tool_prune import ToolPrune

tools = {
${pyToolsEntries}
}

# 1. Router configured for TypeSafe Cloud API
router = ToolPrune(tools, threshold=${this.threshold}, engine="typesafe")
candidates = router.filter(${JSON.stringify(qStr)})

# 2. Fast-path direct dispatch
result = router.dispatch(${JSON.stringify(qStr)}, {
    "${toolName}": lambda q: handle_direct(q),
    "fallback": lambda q, c: call_llm(q, c)
})`;
      }
    } else {
      if (this.activeCodeLang === 'js') {
        const filterCall = this.selectionMode === 'auto'
          ? `await router.filter(${JSON.stringify(qStr)});`
          : `await router.filter(${JSON.stringify(qStr)}, { k: ${this.topK} });`;
        const oneShotOpts = this.selectionMode === 'auto' ? '' : `, {\n  topK: ${this.topK}\n}`;

        code = `// One-shot tool selection with offline TurboQuant (${lat.toFixed(2)}ms)
import prune from 'tool-prune';

const tools = ${JSON.stringify(snippetTools, null, 2)};

// 1. Direct prune or LLM candidate filter
const match = await prune(${JSON.stringify(qStr)}, tools${oneShotOpts});

console.log(match.tool);       // "${toolName}"
console.log(match.confidence); // ${(activeTop1.probability || 0.88).toFixed(3)}
console.log(match.latency);    // ${lat.toFixed(2)}ms

// 2. Reusable router for LLM prompt pruning (${this.selectionMode === 'auto' ? 'auto-selected candidates' : 'top-' + this.topK}):
const router = prune(tools, { threshold: ${this.threshold} });
const topTools = ${filterCall}

// 3. Fast-path direct dispatch when confident:
const result = await router.dispatch(${JSON.stringify(qStr)}, {
  ${toolName}: (query) => executeHandler(query),
  fallback: (query, candidates) => callLLM(query, candidates)
});`;
      } else if (this.activeCodeLang === 'py') {
        const pyToolsEntries = Object.entries(snippetTools)
          .map(([k, v]) => `    ${JSON.stringify(k)}: ${JSON.stringify(v)}`)
          .join(',\n');
        const pyFilterCall = this.selectionMode === 'auto'
          ? `router.filter(${JSON.stringify(qStr)})`
          : `router.filter(${JSON.stringify(qStr)}, k=${this.topK})`;

        code = `# Python API: zero dependencies offline TurboQuant
from tool_prune import prune, ToolPrune

tools = {
${pyToolsEntries}
}

# 1. One-shot offline selection
match = prune(${JSON.stringify(qStr)}, tools)
print(match.tool)        # "${toolName}"
print(match.confidence)  # ${(activeTop1.probability || 0.88).toFixed(3)}

# 2. Reusable router for LLM prompt pruning (${this.selectionMode === 'auto' ? 'auto-selected candidates' : 'top-' + this.topK})
router = ToolPrune(tools, threshold=${this.threshold})
candidates = ${pyFilterCall}

# 3. Fast-path direct dispatch
result = router.dispatch(${JSON.stringify(qStr)}, {
    "${toolName}": lambda q: handle_direct(q),
    "fallback": lambda q, c: call_llm(q, c)
})`;
      }
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
