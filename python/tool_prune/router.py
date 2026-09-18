import os
import time
import json
import urllib.request
import urllib.error
from dataclasses import dataclass, field
from typing import Any, Callable, Dict, List, Optional, Union

from .turboquant import get_turboquant_engine

@dataclass
class CandidateTool:
    name: str
    probability: float
    tool: Any = None
    score: Optional[float] = None

@dataclass
class SelectionResult:
    tool: str
    confidence: float
    probability: float
    top_k: List[CandidateTool]
    auto_selected: List[CandidateTool] = field(default_factory=list)
    auto_tools: List[Any] = field(default_factory=list)
    requires_generation: float = 0.0
    latency_ms: float = 0.0
    engine: str = "typesafe"
    usage: Optional[Dict[str, int]] = None
    raw: Optional[Dict[str, Any]] = None


def _normalize_tools(tools: Union[Dict[str, Any], List[Dict[str, Any]]]):
    criteria: Dict[str, str] = {}
    registry: Dict[str, Any] = {}

    if isinstance(tools, list):
        for t in tools:
            if not isinstance(t, dict):
                continue
            name = t.get("name") or t.get("id")
            if not name:
                continue
            desc = t.get("criteria") or t.get("description") or t.get("summary") or name
            criteria[name] = str(desc)
            registry[name] = t
    elif isinstance(tools, dict):
        for name, val in tools.items():
            if isinstance(val, str):
                criteria[name] = val
                registry[name] = {"name": name, "description": val}
            elif isinstance(val, dict):
                desc = val.get("criteria") or val.get("description") or val.get("summary") or name
                criteria[name] = str(desc)
                registry[name] = {"name": name, **val}

    return criteria, registry

def auto_select_candidates(
    candidates: List[CandidateTool],
    min_k: Optional[int] = None,
    max_k: int = 5,
    min_score: float = 0.12,
    min_probability: float = 0.20,
    relative_threshold: float = 0.70,
    cliff_ratio: float = 0.75,
    dominant_margin: float = 0.14,
    allow_empty: bool = False,
    **kwargs
) -> List[CandidateTool]:
    """
    Automatically select the most relevant tool candidates based on confidence
    score distribution, cliff/elbow drop-off, and relevance floors.
    """
    if not candidates:
        return []

    effective_min_k = min_k if min_k is not None else (0 if allow_empty else 1)
    top1 = candidates[0]
    has_score = top1.score is not None

    top_val = top1.score if has_score else top1.probability
    floor_val = min_score if has_score else min_probability

    if top_val is not None and top_val < floor_val:
        return candidates[:effective_min_k] if effective_min_k > 0 else []

    selected = [top1]

    for i in range(1, min(len(candidates), max_k)):
        curr = candidates[i]
        prev = candidates[i - 1]

        if has_score and curr.score is not None and top1.score is not None and prev.score is not None:
            if curr.score < min_score:
                break
            if top1.score >= 0.35 and (top1.score - curr.score) > dominant_margin:
                break
            if (curr.score / max(1e-6, top1.score)) < relative_threshold:
                break
            if prev.score > 0 and (curr.score / prev.score) < cliff_ratio:
                break
        else:
            if curr.probability < min_probability:
                break
            if top1.probability >= 0.70 and (top1.probability - curr.probability) > 0.20:
                break
            if (curr.probability / max(1e-6, top1.probability)) < relative_threshold:
                break
            if prev.probability > 0 and (curr.probability / prev.probability) < cliff_ratio:
                break

        selected.append(curr)

    if len(selected) < effective_min_k:
        return candidates[:effective_min_k]

    return selected

class ToolPrune:
    def __init__(
        self,
        tools: Union[Dict[str, Any], List[Dict[str, Any]]],
        api_key: Optional[str] = None,
        model: str = "jev-latest",
        endpoint: str = "https://api.typesafe.ai/v1/systemone",
        threshold: float = 0.85,
        top_k: Union[int, str] = "auto",
        engine: Optional[str] = None,
    ):
        self.criteria, self.registry = _normalize_tools(tools)
        self.api_key = api_key or os.getenv("TYPESAFE_API_KEY")
        self.model = model
        self.endpoint = endpoint
        self.threshold = threshold
        self.top_k = top_k
        self.requested_engine = engine
        self._tq_engine = None

    def get_engine(self, **kwargs) -> str:
        eng = kwargs.get("engine") or self.requested_engine
        if eng:
            return eng
        return "typesafe" if self.api_key else "turboquant"

    def _prepare_payload(self, query: Union[str, Dict[str, Any]], options: Optional[Dict[str, Any]] = None) -> bytes:
        if not self.api_key:
            raise ValueError("TypeSafe API key required. Set TYPESAFE_API_KEY environment variable, pass api_key, or use engine='turboquant'.")

        state = {"intent": query} if isinstance(query, str) else query
        opts = options or {}
        body = {
            "model": opts.get("model", self.model),
            "state": state,
            "questions": {
                "tool": {
                    "type": "choice",
                    "instructions": opts.get("instructions", "Which specific tool is required to satisfy this intent?"),
                    "criteria": self.criteria,
                },
                "requires_generation": {
                    "type": "noul",
                    "instructions": "Does fulfilling this request require open-ended creative text or arbitrary code generation rather than a deterministic tool execution?",
                },
            },
        }
        return json.dumps(body).encode("utf-8")

    def _process_response(self, data: Dict[str, Any], latency_ms: float, top_k_count: Union[int, str, None] = None, **kwargs) -> SelectionResult:
        tool_answer = data.get("answers", {}).get("tool", {})
        probs = tool_answer.get("probabilities", {})
        sorted_probs = sorted(probs.items(), key=lambda kv: kv[1], reverse=True)

        all_candidates = [
            CandidateTool(name=name, probability=p, tool=self.registry.get(name))
            for name, p in sorted_probs
        ]

        auto_selected = auto_select_candidates(all_candidates, **kwargs)
        auto_tools = [c.tool if c.tool is not None else c.name for c in auto_selected]

        k = top_k_count if top_k_count is not None else self.top_k
        if isinstance(k, int) and k > 0:
            top_k_candidates = all_candidates[:k]
        else:
            top_k_candidates = all_candidates[:max(3, len(auto_selected))]

        selected_name = tool_answer.get("choice", "") or (top_k_candidates[0].name if top_k_candidates else "")
        probability = probs.get(selected_name, 0.0)
        confidence = tool_answer.get("confidence", probability)
        requires_gen = data.get("answers", {}).get("requires_generation", {}).get("probability", 0.0)

        return SelectionResult(
            tool=selected_name,
            confidence=confidence,
            probability=probability,
            top_k=top_k_candidates,
            auto_selected=auto_selected,
            auto_tools=auto_tools,
            requires_generation=requires_gen,
            latency_ms=latency_ms,
            engine="typesafe",
            usage=data.get("usage"),
            raw=data,
        )

    def _select_typesafe(self, query: Union[str, Dict[str, Any]], **kwargs) -> SelectionResult:
        payload = self._prepare_payload(query, kwargs)
        req = urllib.request.Request(
            self.endpoint,
            data=payload,
            headers={
                "Authorization": f"Bearer {self.api_key}",
                "Content-Type": "application/json",
            },
            method="POST",
        )

        start = time.perf_counter()
        try:
            with urllib.request.urlopen(req) as resp:
                raw_data = resp.read()
        except urllib.error.HTTPError as e:
            err = e.read().decode("utf-8", errors="replace")
            raise RuntimeError(f"tool-prune API error ({e.code}): {err}") from e

        latency_ms = (time.perf_counter() - start) * 1000.0
        data = json.loads(raw_data.decode("utf-8"))
        return self._process_response(data, latency_ms, kwargs.get("top_k"), **kwargs)

    def _select_turboquant(self, query: Union[str, Dict[str, Any]], **kwargs) -> SelectionResult:
        q_str = query if isinstance(query, str) else (query.get("intent") or query.get("query") or json.dumps(query))
        start = time.perf_counter()

        if self._tq_engine is None:
            self._tq_engine = get_turboquant_engine(self.registry)

        k = kwargs.get("top_k") if kwargs.get("top_k") is not None else self.top_k
        pool_size = max(k if isinstance(k, int) else 3, 10, len(self.registry))
        raw_results = self._tq_engine.search(q_str, top_k=pool_size)
        latency_ms = (time.perf_counter() - start) * 1000.0

        all_candidates = [
            CandidateTool(
                name=r["name"],
                probability=r["probability"],
                tool=self.registry.get(r["name"]),
                score=r.get("score")
            )
            for r in raw_results
        ]

        top1 = all_candidates[0] if all_candidates else None
        selected_name = top1.name if top1 else ""
        prob = top1.probability if top1 else 0.0

        auto_selected = auto_select_candidates(all_candidates, **kwargs)
        auto_tools = [c.tool if c.tool is not None else c.name for c in auto_selected]

        if isinstance(k, int) and k > 0:
            top_k_candidates = all_candidates[:k]
        else:
            top_k_candidates = all_candidates[:max(3, len(auto_selected))]

        return SelectionResult(
            tool=selected_name,
            confidence=prob,
            probability=prob,
            top_k=top_k_candidates,
            auto_selected=auto_selected,
            auto_tools=auto_tools,
            requires_generation=0.0,
            latency_ms=latency_ms,
            engine="turboquant",
        )

    def select(self, query: Union[str, Dict[str, Any]], **kwargs) -> SelectionResult:
        engine = self.get_engine(**kwargs)
        if engine == "turboquant":
            return self._select_turboquant(query, **kwargs)
        return self._select_typesafe(query, **kwargs)

    def auto(self, query: Union[str, Dict[str, Any]], **kwargs) -> List[Any]:
        """Automatically select the optimal candidate tools based on score distribution."""
        result = self.select(query, **kwargs)
        return result.auto_tools

    def filter(self, query: Union[str, Dict[str, Any]], k: Union[int, str, None] = None, **kwargs) -> List[Any]:
        """
        Filter tool collection down to relevant candidates to prune LLM prompt bloat.
        If k is a positive int, returns that fixed number of candidates.
        Otherwise (default or k='auto'), automatically selects the candidates based on score drop-off.
        """
        target_k = k if k is not None else self.top_k
        if isinstance(target_k, int) and target_k > 0:
            result = self.select(query, top_k=target_k, **kwargs)
            return [c.tool if c.tool is not None else c.name for c in result.top_k[:target_k]]
        return self.auto(query, **kwargs)

    def dispatch(
        self,
        query: Union[str, Dict[str, Any]],
        handlers: Dict[str, Callable[..., Any]],
        threshold: Optional[float] = None,
        **kwargs,
    ) -> Any:
        selection = self.select(query, **kwargs)
        t = threshold if threshold is not None else self.threshold

        if selection.confidence >= t and selection.tool in handlers:
            return handlers[selection.tool](query, selection)

        if "fallback" in handlers:
            return handlers["fallback"](query, selection)

        return selection

def prune(
    query: Union[str, Dict[str, Any]],
    tools: Union[Dict[str, Any], List[Dict[str, Any]]],
    **kwargs,
) -> SelectionResult:
    """One-shot tool pruning and selection."""
    return ToolPrune(tools, **kwargs).select(query)

def prune_auto(
    query: Union[str, Dict[str, Any]],
    tools: Union[Dict[str, Any], List[Dict[str, Any]]],
    **kwargs,
) -> List[Any]:
    """One-shot automatic candidate tool selection."""
    return ToolPrune(tools, **kwargs).auto(query, **kwargs)

prune.auto = prune_auto
