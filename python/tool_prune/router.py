import os
import time
import json
import urllib.request
import urllib.error
from dataclasses import dataclass, field
from typing import Any, Callable, Dict, List, Optional, Union

@dataclass
class CandidateTool:
    name: str
    probability: float
    tool: Any = None

@dataclass
class SelectionResult:
    tool: str
    confidence: float
    probability: float
    top_k: List[CandidateTool]
    requires_generation: float
    latency_ms: float
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

class ToolPrune:
    def __init__(
        self,
        tools: Union[Dict[str, Any], List[Dict[str, Any]]],
        api_key: Optional[str] = None,
        model: str = "jev-latest",
        endpoint: str = "https://api.typesafe.ai/v1/systemone",
        threshold: float = 0.85,
        top_k: int = 3,
    ):
        self.criteria, self.registry = _normalize_tools(tools)
        self.api_key = api_key or os.getenv("TYPESAFE_API_KEY")
        self.model = model
        self.endpoint = endpoint
        self.threshold = threshold
        self.top_k = top_k

    def _prepare_payload(self, query: Union[str, Dict[str, Any]], options: Optional[Dict[str, Any]] = None) -> bytes:
        if not self.api_key:
            raise ValueError("TypeSafe API key required. Set TYPESAFE_API_KEY environment variable or pass api_key.")

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

    def _process_response(self, data: Dict[str, Any], latency_ms: float, top_k_count: Optional[int] = None) -> SelectionResult:
        tool_answer = data.get("answers", {}).get("tool", {})
        probs = tool_answer.get("probabilities", {})
        sorted_probs = sorted(probs.items(), key=lambda kv: kv[1], reverse=True)

        k = top_k_count or self.top_k
        top_candidates = [
            CandidateTool(name=name, probability=p, tool=self.registry.get(name))
            for name, p in sorted_probs[:k]
        ]

        selected_name = tool_answer.get("choice", "")
        probability = probs.get(selected_name, 0.0)
        confidence = tool_answer.get("confidence", probability)
        requires_gen = data.get("answers", {}).get("requires_generation", {}).get("probability", 0.0)

        return SelectionResult(
            tool=selected_name,
            confidence=confidence,
            probability=probability,
            top_k=top_candidates,
            requires_generation=requires_gen,
            latency_ms=latency_ms,
            usage=data.get("usage"),
            raw=data,
        )

    def select(self, query: Union[str, Dict[str, Any]], **kwargs) -> SelectionResult:
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
        return self._process_response(data, latency_ms, kwargs.get("top_k"))

    def filter(self, query: Union[str, Dict[str, Any]], k: Optional[int] = None, **kwargs) -> List[Any]:
        result = self.select(query, top_k=k or self.top_k, **kwargs)
        target_k = k or self.top_k
        return [c.tool if c.tool is not None else c.name for c in result.top_k[:target_k]]

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

