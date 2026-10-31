import os
import json
import time
import inspect
import urllib.request
import urllib.error
from dataclasses import dataclass, field
from typing import Dict, List, Any, Optional, Union, Callable, Tuple
from .turboquant import get_turboquant_engine, TurboQuantEngine


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
    top_k: List[CandidateTool] = field(default_factory=list)
    auto_selected: List[CandidateTool] = field(default_factory=list)
    auto_tools: List[Any] = field(default_factory=list)
    requires_generation: float = 0.0
    latency_ms: float = 0.0
    engine: str = "turboquant"
    usage: Optional[Dict[str, int]] = None
    raw: Optional[Dict[str, Any]] = None


def _build_rich_criteria(name: str, defn: Any) -> str:
    if not isinstance(defn, dict):
        return str(defn or name)
    if defn.get("criteria"):
        return str(defn["criteria"])

    base = defn.get("description") or defn.get("summary") or defn.get("title") or name
    schema = defn.get("parameters") or defn.get("inputSchema") or defn.get("input_schema") or defn.get("schema")
    props = schema.get("properties") if isinstance(schema, dict) else None
    if isinstance(props, dict) and props:
        keys = list(props.keys())[:12]
        return f"{base} (params: {', '.join(str(k) for k in keys)})"
    return str(base)


def normalize_tools(tools: Union[Dict[str, Any], List[Dict[str, Any]]]) -> Tuple[Dict[str, str], Dict[str, Any]]:
    """
    Normalize diverse tool definitions (Dict, List, MCP inputSchema, Anthropic input_schema,
    OpenAI {"type": "function", "function": {...}}) into a criteria map and registry.
    """
    criteria: Dict[str, str] = {}
    registry: Dict[str, Any] = {}

    if isinstance(tools, list):
        for t in tools:
            if not isinstance(t, dict):
                continue
            fn_def = t.get("function") if isinstance(t.get("function"), dict) else t
            name = fn_def.get("name") or t.get("name") or t.get("id")
            if not name:
                continue
            criteria[str(name)] = _build_rich_criteria(str(name), fn_def)
            registry[str(name)] = t
    elif isinstance(tools, dict):
        for key, val in tools.items():
            if isinstance(val, str):
                criteria[key] = val
                registry[key] = {"name": key, "description": val}
            elif isinstance(val, dict):
                fn_def = val.get("function") if isinstance(val.get("function"), dict) else val
                name = key or fn_def.get("name")
                if not name:
                    continue
                criteria[str(name)] = _build_rich_criteria(str(name), fn_def)
                registry[str(name)] = val if "name" in val else {"name": str(name), **val}

    return criteria, registry


_normalize_tools = normalize_tools


def auto_select_candidates(
    candidates: List[CandidateTool],
    min_k: Optional[int] = None,
    max_k: int = 5,
    min_score: Optional[float] = None,
    min_probability: float = 0.20,
    relative_threshold: Optional[float] = None,
    cliff_ratio: Optional[float] = None,
    dominant_margin: float = 0.14,
    allow_empty: bool = False,
    **kwargs,
) -> List[CandidateTool]:
    """
    Uncertainty-aware conformal candidate selection based on score distribution,
    cliff/elbow drop-off, and relevance floors.
    """
    if not candidates:
        return []

    effective_min_k = min_k if min_k is not None else (0 if allow_empty else 1)
    eff_min_score = min_score if min_score is not None else 0.08
    eff_rel_base = relative_threshold if relative_threshold is not None else 0.68
    eff_cliff_base = cliff_ratio if cliff_ratio is not None else 0.72

    top1 = candidates[0]
    has_score = top1.score is not None

    top_val = top1.score if has_score else top1.probability
    floor_val = eff_min_score if has_score else min_probability

    if top_val is not None and top_val < floor_val:
        return candidates[:effective_min_k] if effective_min_k > 0 else []

    uncertain = (top1.score < 0.34) if (has_score and top1.score is not None) else (top1.probability < 0.68)
    eff_rel = eff_rel_base if (relative_threshold is not None or not uncertain) else 0.48
    eff_cliff = eff_cliff_base if (cliff_ratio is not None or not uncertain) else 0.58
    eff_floor = eff_min_score if (min_score is not None or not uncertain) else 0.05

    selected = [top1]

    for i in range(1, min(len(candidates), max_k)):
        curr = candidates[i]
        prev = candidates[i - 1]

        if has_score and curr.score is not None and top1.score is not None and prev.score is not None:
            if curr.score < eff_floor:
                break
            if top1.score >= 0.38 and (top1.score - curr.score) > dominant_margin:
                break
            if (curr.score / max(1e-6, top1.score)) < eff_rel:
                break
            if prev.score > 0 and (curr.score / prev.score) < eff_cliff:
                break
        else:
            if curr.probability < min_probability:
                break
            if top1.probability >= 0.70 and (top1.probability - curr.probability) > 0.20:
                break
            if (curr.probability / max(1e-6, top1.probability)) < eff_rel:
                break
            if prev.probability > 0 and (curr.probability / prev.probability) < eff_cliff:
                break

        selected.append(curr)

    if len(selected) < effective_min_k:
        return candidates[:effective_min_k]

    return selected


_INIT_KEYS = frozenset({"api_key", "model", "endpoint", "threshold", "top_k", "engine"})


class ToolPrune:
    def __init__(
        self,
        tools: Union[Dict[str, Any], List[Dict[str, Any]]],
        api_key: Optional[str] = None,
        model: str = "jev-latest",
        endpoint: str = "https://api.typesafe.ai/v1/systemone",
        threshold: float = 0.85,
        top_k: Union[int, str] = "auto",
        engine: Optional[Any] = None,
    ):
        self.criteria, self.registry = normalize_tools(tools)
        self.api_key = api_key if api_key is not None else os.getenv("TYPESAFE_API_KEY")
        if self.api_key == "":
            self.api_key = None
        self.model = model
        self.endpoint = endpoint
        self.threshold = threshold
        self.top_k = top_k
        self.requested_engine = engine
        self._tq_engine = None
        self._simd_engine = None

    def get_engine(self, **kwargs) -> Any:
        eng = kwargs.get("engine") if kwargs.get("engine") is not None else self.requested_engine
        if eng is not None:
            return eng
        return "typesafe" if self.api_key else "turboquant"

    def _prepare_payload(
        self,
        query: Union[str, Dict[str, Any]],
        options: Optional[Dict[str, Any]] = None,
    ) -> Tuple[bytes, str]:
        opts = options or {}
        key = opts.get("api_key") or self.api_key
        if not key:
            raise ValueError(
                "TypeSafe API key required. Set TYPESAFE_API_KEY environment variable, pass api_key, or use engine='turboquant'."
            )

        state = {"intent": query} if isinstance(query, str) else query
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
        return json.dumps(body).encode("utf-8"), key

    def _process_response(
        self,
        data: Dict[str, Any],
        latency_ms: float,
        top_k_count: Union[int, str, None] = None,
        **kwargs,
    ) -> SelectionResult:
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
            top_k_candidates = all_candidates[: max(3, len(auto_selected))]

        empty_allowed = bool(kwargs.get("allow_empty")) and len(auto_selected) == 0
        raw_choice = tool_answer.get("choice", "") or (top_k_candidates[0].name if top_k_candidates else "")
        selected_name = "" if empty_allowed else raw_choice
        probability = probs.get(raw_choice, 0.0)
        confidence = tool_answer.get("confidence", probability) if selected_name else probability
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
        payload, key = self._prepare_payload(query, kwargs)
        req = urllib.request.Request(
            self.endpoint,
            data=payload,
            headers={
                "Authorization": f"Bearer {key}",
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

    def _select_custom_engine(self, engine: Any, query: Union[str, Dict[str, Any]], **kwargs) -> SelectionResult:
        start = time.perf_counter()
        q_state = query if isinstance(query, str) else (query.get("intent") or query.get("query") or query)

        if callable(engine):
            raw_res = engine(q_state, self.criteria, kwargs)
        else:
            raw_res = engine.choice({
                "state": q_state,
                "question": kwargs.get("instructions", "Which specific tool is required to satisfy this intent?"),
                "options": self.criteria,
            })

        latency_ms = (time.perf_counter() - start) * 1000.0
        all_candidates: List[CandidateTool] = []
        explicit_choice = ""
        explicit_confidence: Optional[float] = None

        if isinstance(raw_res, list):
            for r in raw_res:
                if isinstance(r, CandidateTool):
                    all_candidates.append(r)
                elif isinstance(r, dict) and r.get("name"):
                    all_candidates.append(
                        CandidateTool(
                            name=r["name"],
                            probability=float(r.get("probability", r.get("score", 0.0))),
                            score=r.get("score"),
                            tool=self.registry.get(r["name"]),
                        )
                    )
        elif isinstance(raw_res, dict):
            probs = raw_res.get("probabilities", {})
            for name, p in sorted(probs.items(), key=lambda kv: kv[1], reverse=True):
                all_candidates.append(CandidateTool(name=name, probability=float(p), tool=self.registry.get(name)))
            explicit_choice = raw_res.get("choice", "") or ""
            explicit_confidence = raw_res.get("confidence")
            if not all_candidates and explicit_choice:
                all_candidates.append(
                    CandidateTool(
                        name=explicit_choice,
                        probability=float(explicit_confidence if explicit_confidence is not None else 1.0),
                        tool=self.registry.get(explicit_choice),
                    )
                )

        auto_selected = auto_select_candidates(all_candidates, **kwargs)
        auto_tools = [c.tool if c.tool is not None else c.name for c in auto_selected]
        k = kwargs.get("top_k") if kwargs.get("top_k") is not None else self.top_k
        if isinstance(k, int) and k > 0:
            top_k_candidates = all_candidates[:k]
        else:
            top_k_candidates = all_candidates[: max(3, len(auto_selected))]

        empty_allowed = bool(kwargs.get("allow_empty")) and len(auto_selected) == 0
        selected_name = "" if empty_allowed else (explicit_choice or (top_k_candidates[0].name if top_k_candidates else ""))
        matched = next((c for c in all_candidates if c.name == selected_name), top_k_candidates[0] if top_k_candidates else None)
        prob = matched.probability if matched else 0.0
        conf = float(explicit_confidence) if (explicit_confidence is not None and selected_name) else prob
        eng_name = getattr(engine, "name", None) or getattr(engine, "__name__", "custom")

        return SelectionResult(
            tool=selected_name,
            confidence=conf,
            probability=prob,
            top_k=top_k_candidates,
            auto_selected=auto_selected,
            auto_tools=auto_tools,
            requires_generation=0.0,
            latency_ms=latency_ms,
            engine=str(eng_name),
            raw=raw_res if isinstance(raw_res, dict) else None,
        )

    def _select_turboquant(self, query: Union[str, Dict[str, Any]], prefer_simd: bool = False, **kwargs) -> SelectionResult:
        q_str = query if isinstance(query, str) else (query.get("intent") or query.get("query") or json.dumps(query))
        start = time.perf_counter()

        if prefer_simd:
            if self._simd_engine is None:
                self._simd_engine = get_turboquant_engine(self.registry, prefer_simd=True)
            active_engine = self._simd_engine
        else:
            if self._tq_engine is None:
                self._tq_engine = get_turboquant_engine(self.registry, prefer_simd=False)
            active_engine = self._tq_engine

        k = kwargs.get("top_k") if kwargs.get("top_k") is not None else self.top_k
        pool_size = max(k if isinstance(k, int) else 3, 10, len(self.registry))
        raw_results = active_engine.search(q_str, top_k=pool_size)
        latency_ms = (time.perf_counter() - start) * 1000.0

        all_candidates = [
            CandidateTool(
                name=r["name"],
                probability=r["probability"],
                tool=self.registry.get(r["name"]),
                score=r.get("score"),
            )
            for r in raw_results
        ]

        top1 = all_candidates[0] if all_candidates else None
        prob = top1.probability if top1 else 0.0

        auto_selected = auto_select_candidates(all_candidates, **kwargs)
        auto_tools = [c.tool if c.tool is not None else c.name for c in auto_selected]

        if isinstance(k, int) and k > 0:
            top_k_candidates = all_candidates[:k]
        else:
            top_k_candidates = all_candidates[: max(3, len(auto_selected))]

        empty_allowed = bool(kwargs.get("allow_empty")) and len(auto_selected) == 0
        selected_name = "" if empty_allowed else (top1.name if top1 else "")

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
        if callable(engine) or (hasattr(engine, "choice") and callable(getattr(engine, "choice"))):
            return self._select_custom_engine(engine, query, **kwargs)
        if engine in ("turboquant", "turboquant-simd", "turbovec"):
            return self._select_turboquant(query, prefer_simd=(engine != "turboquant"), **kwargs)
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
        target_k = k if k is not None else kwargs.pop("top_k", self.top_k)
        if isinstance(target_k, int) and target_k > 0:
            result = self.select(query, top_k=target_k, **kwargs)
            return [c.tool if c.tool is not None else c.name for c in result.top_k[:target_k]]
        return self.auto(query, **kwargs)

    @staticmethod
    def _invoke_handler(fn: Callable[..., Any], query: Union[str, Dict[str, Any]], selection: SelectionResult) -> Any:
        try:
            params = list(inspect.signature(fn).parameters.values())
            has_varargs = any(p.kind == inspect.Parameter.VAR_POSITIONAL for p in params)
            positional = [
                p for p in params
                if p.kind in (inspect.Parameter.POSITIONAL_ONLY, inspect.Parameter.POSITIONAL_OR_KEYWORD)
            ]
            if not has_varargs and len(positional) == 1:
                return fn(query)
            if not has_varargs and len(positional) == 0:
                return fn()
        except (ValueError, TypeError):
            pass
        return fn(query, selection)

    def dispatch(
        self,
        query: Union[str, Dict[str, Any]],
        handlers: Dict[str, Callable[..., Any]],
        threshold: Optional[float] = None,
        **kwargs,
    ) -> Any:
        selection = self.select(query, **kwargs)
        t = threshold if threshold is not None else self.threshold

        if selection.tool and selection.confidence >= t and selection.tool in handlers:
            return self._invoke_handler(handlers[selection.tool], query, selection)

        if "fallback" in handlers:
            return self._invoke_handler(handlers["fallback"], query, selection)

        return selection


def prune(
    arg1: Union[str, Dict[str, Any], List[Dict[str, Any]]],
    arg2: Optional[Union[Dict[str, Any], List[Dict[str, Any]]]] = None,
    **kwargs,
) -> Union[SelectionResult, ToolPrune]:
    """
    Dual-mode entrypoint matching JS API:
    - One-shot: prune(query, tools, **kwargs) -> SelectionResult
    - Configured router: prune(tools, **kwargs) -> ToolPrune
    """
    init_kwargs = {k: v for k, v in kwargs.items() if k in _INIT_KEYS}
    select_kwargs = {k: v for k, v in kwargs.items() if k not in _INIT_KEYS}
    if "top_k" in kwargs:
        select_kwargs["top_k"] = kwargs["top_k"]

    if arg2 is None and isinstance(arg1, (dict, list)):
        return ToolPrune(arg1, **init_kwargs)

    if arg2 is None:
        raise TypeError("prune() requires (query, tools) for one-shot selection or (tools) to construct a ToolPrune router.")

    router = ToolPrune(arg2, **init_kwargs)
    return router.select(arg1, **select_kwargs)  # type: ignore[arg-type]


def prune_auto(
    query: Union[str, Dict[str, Any]],
    tools: Union[Dict[str, Any], List[Dict[str, Any]]],
    **kwargs,
) -> List[Any]:
    """One-shot automatic candidate tool selection."""
    init_kwargs = {k: v for k, v in kwargs.items() if k in _INIT_KEYS}
    select_kwargs = {k: v for k, v in kwargs.items() if k not in _INIT_KEYS}
    return ToolPrune(tools, **init_kwargs).auto(query, **select_kwargs)


prune.auto = prune_auto  # type: ignore[attr-defined]
prune.ToolPrune = ToolPrune  # type: ignore[attr-defined]
prune.TurboQuantEngine = TurboQuantEngine  # type: ignore[attr-defined]
prune.normalize_tools = normalize_tools  # type: ignore[attr-defined]
prune.auto_select_candidates = auto_select_candidates  # type: ignore[attr-defined]
