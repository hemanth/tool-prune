import os
import sys
import json
import time
import numpy as np

# Import directly from local tool_prune package
ROOT_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(ROOT_DIR, "python"))

from tool_prune.turboquant import TurboQuantEngine, TurbovecEngine, extract_features

# Load BFCL Dataset
bfcl_path = os.path.join(ROOT_DIR, "bench/bfcl_dataset/BFCL_v3_multiple.json")
ans_path = os.path.join(ROOT_DIR, "bench/bfcl_dataset/BFCL_v3_multiple_answers.json")

with open(bfcl_path) as f:
    bfcl_questions = [json.loads(line) for line in f if line.strip()]

with open(ans_path) as f:
    bfcl_answers = {}
    for line in f:
        if not line.strip():
            continue
        data = json.loads(line)
        targets = [list(gt.keys())[0] for gt in data.get("ground_truth", [])]
        bfcl_answers[data["id"]] = targets

# Filter 60 valid test cases (matching run_bfcl_eval.mjs)
bfcl_tests = []
for q in bfcl_questions:
    targets = bfcl_answers.get(q["id"], [])
    if len(targets) == 1 and len(q["function"]) >= 2:
        bfcl_tests.append({
            "id": q["id"],
            "query": q["question"][0][0]["content"],
            "target": targets[0],
            "candidates": q["function"],
        })
bfcl_tests = bfcl_tests[:60]

print("=" * 78)
print("BENCHMARK: TURBOVEC (RUST SIMD) & PURE PYTHON TURBOQUANT ON GORILLA BFCL v3")
print(f"Evaluated Test Cases: {len(bfcl_tests)} from Gorilla BFCL v3 Multiple")
print("=" * 78)

# 1. Evaluate TurbovecEngine & TurboQuantEngine on Local Distractor Selection
tv_distractor_correct = 0
py_distractor_correct = 0
tv_kernel_latencies = []
py_latencies = []

for test in bfcl_tests:
    cand_map = {fn["name"]: fn for fn in test["candidates"]}

    tv_eng = TurbovecEngine(dim=1024, bit_width=4)
    tv_eng.fit(cand_map)

    q_feats = extract_features(test["query"], 1.0, {}, True)
    q_vec_list, _, _ = tv_eng._embedder._embed_features(q_feats, True)
    q_vec = np.array(q_vec_list, dtype=np.float32).reshape(1, tv_eng.dim)

    t0 = time.perf_counter()
    _, indices = tv_eng.index.search(q_vec, k=1)
    tv_kernel_latencies.append((time.perf_counter() - t0) * 1000.0)

    if tv_eng.items[int(indices[0][0])] == test["target"]:
        tv_distractor_correct += 1

    py_eng = TurboQuantEngine(dim=1024)
    py_eng.fit(cand_map)
    t1 = time.perf_counter()
    py_res = py_eng.search(test["query"], top_k=1)
    py_latencies.append((time.perf_counter() - t1) * 1000.0)
    if py_res and py_res[0]["name"] == test["target"]:
        py_distractor_correct += 1

tv_distractor_acc = (tv_distractor_correct / len(bfcl_tests)) * 100.0
py_distractor_acc = (py_distractor_correct / len(bfcl_tests)) * 100.0
avg_tv_kernel_ms = sum(tv_kernel_latencies) / len(tv_kernel_latencies)
avg_py_ms = sum(py_latencies) / len(py_latencies)

# 2. Evaluate Global 100-Tool Catalog Pruning
all_tools = {}
for q in bfcl_questions:
    for fn in q["function"]:
        if fn["name"] not in all_tools and len(all_tools) < 100:
            all_tools[fn["name"]] = fn

tv_global = TurbovecEngine(dim=1024, bit_width=4)
tv_global.fit(all_tools)

py_global = TurboQuantEngine(dim=1024)
py_global.fit(all_tools)

tv_top1 = tv_top3 = tv_top5 = 0
py_top1 = py_top3 = py_top5 = 0
in_catalog_count = 0
tv_100_kernel_ms = []
tv_100_e2e_ms = []
py_100_e2e_ms = []

for test in bfcl_tests:
    if test["target"] not in all_tools:
        continue
    in_catalog_count += 1

    q_feats = extract_features(test["query"], 1.0, {}, True)
    q_vec_list, _, _ = tv_global._embedder._embed_features(q_feats, True)
    q_vec = np.array(q_vec_list, dtype=np.float32).reshape(1, tv_global.dim)

    t_k = time.perf_counter()
    _, idxs = tv_global.index.search(q_vec, k=5)
    tv_100_kernel_ms.append((time.perf_counter() - t_k) * 1000.0)

    t_e2e = time.perf_counter()
    tv_res = tv_global.search(test["query"], top_k=5)
    tv_100_e2e_ms.append((time.perf_counter() - t_e2e) * 1000.0)

    tv_names = [r["name"] for r in tv_res]
    if tv_names and tv_names[0] == test["target"]:
        tv_top1 += 1
    if test["target"] in tv_names[:3]:
        tv_top3 += 1
    if test["target"] in tv_names[:5]:
        tv_top5 += 1

    t_py = time.perf_counter()
    py_res = py_global.search(test["query"], top_k=5)
    py_100_e2e_ms.append((time.perf_counter() - t_py) * 1000.0)

    py_names = [r["name"] for r in py_res]
    if py_names and py_names[0] == test["target"]:
        py_top1 += 1
    if test["target"] in py_names[:3]:
        py_top3 += 1
    if test["target"] in py_names[:5]:
        py_top5 += 1

tv_g1 = (tv_top1 / in_catalog_count) * 100.0
tv_g3 = (tv_top3 / in_catalog_count) * 100.0
tv_g5 = (tv_top5 / in_catalog_count) * 100.0
py_g1 = (py_top1 / in_catalog_count) * 100.0
py_g3 = (py_top3 / in_catalog_count) * 100.0
py_g5 = (py_top5 / in_catalog_count) * 100.0
avg_tv_100_kernel = sum(tv_100_kernel_ms) / len(tv_100_kernel_ms)
avg_tv_100_e2e = sum(tv_100_e2e_ms) / len(tv_100_e2e_ms)
avg_py_100_e2e = sum(py_100_e2e_ms) / len(py_100_e2e_ms)

print("\n--- RESULTS: BERKELEY FUNCTION CALLING LEADERBOARD (BFCL v3) ---")
print(f"Turbovec (Rust SIMD) Distractor Top-1: {tv_distractor_acc:.1f}% ({avg_tv_kernel_ms:.3f} ms SIMD kernel, {avg_tv_100_e2e:.3f} ms E2E)")
print(f"Pure Python TurboQuant Distractor Top-1: {py_distractor_acc:.1f}% ({avg_py_ms:.3f} ms E2E)")
print(f"\n100-Tool Catalog Pruning ({in_catalog_count} queries):")
print(f"- Turbovec (Rust SIMD): Top-1 {tv_g1:.1f}% | Top-3 {tv_g3:.1f}% | Top-5 {tv_g5:.1f}% ({avg_tv_100_kernel:.3f} ms SIMD kernel)")
print(f"- Pure Python Stdlib:   Top-1 {py_g1:.1f}% | Top-3 {py_g3:.1f}% | Top-5 {py_g5:.1f}% ({avg_py_100_e2e:.3f} ms E2E)")

print("\nComparison Summary:")
print("-" * 82)
print(f"{'Engine':<30} | {'BFCL Distractors':<16} | {'100-Tool Top-5':<14} | {'Latency':<14}")
print("-" * 82)
print(f"{'TypeSafe System One (Jev)':<30} | {'100.0%':<16} | {'100.0%':<14} | {'~189 ms':<14}")
print(f"{'turbovec (Python/Rust SIMD)':<30} | {f'{tv_distractor_acc:.1f}%':<16} | {f'{tv_g5:.1f}%':<14} | {f'{avg_tv_100_kernel:.3f} ms':<14}")
print(f"{'TurboQuant (Pure Python)':<30} | {f'{py_distractor_acc:.1f}%':<16} | {f'{py_g5:.1f}%':<14} | {f'{avg_py_100_e2e:.2f} ms':<14}")
print("-" * 82)
