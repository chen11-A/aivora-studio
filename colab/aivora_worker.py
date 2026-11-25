"""AIVORA Studio ComfyUI GPU Worker Bridge.

Exposes a minimal authenticated HTTP API on top of a local or Colab ComfyUI server:
  GET  /aivora/health
  POST /aivora/images/generate
  POST /aivora/videos/submit
  GET  /aivora/videos/status/{task_id}
  GET  /aivora/videos/download/{task_id}

Truthful readiness contract:
  /aivora/health ONLY advertises models whose workflow JSON AND required weight files
  exist (non-empty) on disk AND whose workflow node class_types are actually installed
  in ComfyUI. If ComfyUI itself is unreachable, /aivora/health returns HTTP 503 with
  ok=False and models=[].

Run locally or on AutoDL/Colab:
  AIVORA_WORKER_TOKEN=<32-char-token> \
  COMFY_MODELS_DIR=/content/ComfyUI/models \
  AIVORA_WORKFLOW_DIR=/content/workflows \
  uvicorn aivora_worker:app --host 127.0.0.1 --port 8199
"""

from __future__ import annotations

import base64
import binascii
import copy
import json
import os
import re
import secrets
import subprocess
import time
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path
from typing import Any, Optional

from fastapi import Depends, FastAPI, Header, HTTPException
from fastapi.responses import JSONResponse, Response
from pydantic import BaseModel

_SCRIPT_DIR = Path(__file__).resolve().parent
_DEFAULT_WORKFLOW_DIR = (
    str(_SCRIPT_DIR / "workflows") if (_SCRIPT_DIR / "workflows").is_dir() else "./workflows"
)

COMFY_URL = os.environ.get("COMFY_URL", "http://127.0.0.1:8188").rstrip("/")
WORKER_TOKEN = os.environ.get("AIVORA_WORKER_TOKEN") or secrets.token_urlsafe(24)
WORKFLOW_DIR = Path(os.environ.get("AIVORA_WORKFLOW_DIR", _DEFAULT_WORKFLOW_DIR))
COMFY_MODELS_DIR = Path(os.environ.get("COMFY_MODELS_DIR", "/content/ComfyUI/models"))

# Optional explicit allowlist filter (still strictly gated by disk weights + workflow JSON).
REQUESTED_MODELS = [
    m.strip()
    for m in os.environ.get("AIVORA_MODELS", "").split(",")
    if m.strip()
]

SAFE_IDENTIFIER_RE = re.compile(r"^[A-Za-z0-9._-]{1,128}$")

# Built-in model manifest with exact ComfyUI model subdirs and required node classes.
BUILTIN_MODEL_SPECS: dict[str, dict[str, Any]] = {
    "flux-schnell": {
        "kind": "image",
        "workflow": "flux-schnell.json",
        "weights": [
            ("checkpoints", "flux1-schnell-fp8.safetensors"),
        ],
        "required_nodes": [
            "CheckpointLoaderSimple",
            "CLIPTextEncode",
            "EmptySD3LatentImage",
            "KSampler",
            "VAEDecode",
            "SaveImage",
        ],
    },
    "wan2.2-i2v-5b": {
        "kind": "video",
        "workflow": "wan2.2-i2v-5b.json",
        "weights": [
            ("diffusion_models", "wan2.2_ti2v_5B_fp16.safetensors"),
            ("text_encoders", "umt5_xxl_fp8_e4m3fn_scaled.safetensors"),
            ("vae", "wan2.2_vae.safetensors"),
        ],
        "required_nodes": [
            "UNETLoader",
            "CLIPLoader",
            "VAELoader",
            "CLIPTextEncode",
            "LoadImage",
            "Wan22ImageToVideoLatent",
            "ModelSamplingSD3",
            "KSampler",
            "VAEDecode",
            "VHS_VideoCombine",
        ],
    },
}

# ComfyUI accepts alias directories for diffusion models and text encoders.
SUBDIR_ALIASES: dict[str, tuple[str, ...]] = {
    "checkpoints": ("checkpoints",),
    "diffusion_models": ("diffusion_models", "unet"),
    "unet": ("diffusion_models", "unet"),
    "text_encoders": ("text_encoders", "clip"),
    "clip": ("text_encoders", "clip"),
    "vae": ("vae",),
    "loras": ("loras",),
}

# Loader node input field -> ComfyUI models subdirectory mapping for custom workflow inspection.
LOADER_WEIGHT_INPUTS: dict[str, list[tuple[str, str]]] = {
    "CheckpointLoaderSimple": [("ckpt_name", "checkpoints")],
    "UNETLoader": [("unet_name", "diffusion_models")],
    "UnetLoaderGGUF": [("unet_name", "diffusion_models")],
    "CLIPLoader": [("clip_name", "text_encoders")],
    "DualCLIPLoader": [("clip_name1", "text_encoders"), ("clip_name2", "text_encoders")],
    "VAELoader": [("vae_name", "vae")],
    "LoraLoader": [("lora_name", "loras")],
}

app = FastAPI(title="AIVORA ComfyUI GPU Worker", version="1.9.0")


def require_bearer_token(authorization: Optional[str] = Header(default=None)) -> None:
    if not authorization or not authorization.startswith("Bearer "):
        raise HTTPException(status_code=401, detail="Missing Bearer token")
    provided = authorization.removeprefix("Bearer ").strip()
    if not secrets.compare_digest(provided, WORKER_TOKEN):
        raise HTTPException(status_code=403, detail="Invalid Bearer token")


def validate_safe_id(value: str, label: str) -> str:
    cleaned = (value or "").strip()
    if not SAFE_IDENTIFIER_RE.match(cleaned) or cleaned in (".", "..") or ".." in cleaned:
        raise HTTPException(status_code=400, detail=f"无效的 {label}")
    return cleaned


def detect_gpu_name() -> str:
    try:
        out = subprocess.check_output(
            ["nvidia-smi", "--query-gpu=name,memory.total", "--format=csv,noheader"],
            stderr=subprocess.DEVNULL,
            timeout=5,
        )
        line = out.decode("utf-8", errors="ignore").strip().splitlines()[0]
        if line:
            return line
    except Exception:
        pass
    return "GPU Worker"


def comfy_request(
    method: str,
    endpoint: str,
    payload: Optional[bytes] = None,
    content_type: Optional[str] = None,
    timeout: int = 120,
) -> bytes:
    url = f"{COMFY_URL}{endpoint}"
    headers: dict[str, str] = {}
    if content_type:
        headers["Content-Type"] = content_type
    req = urllib.request.Request(url, data=payload, headers=headers, method=method)
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            return resp.read()
    except urllib.error.HTTPError as exc:
        body = exc.read().decode("utf-8", errors="ignore")[:300]
        raise HTTPException(status_code=502, detail=f"ComfyUI HTTP {exc.code}: {body}") from exc
    except Exception as exc:
        raise HTTPException(status_code=502, detail=f"ComfyUI unreachable: {exc}") from exc


def fetch_comfy_installed_nodes() -> Optional[set[str]]:
    """Queries ComfyUI /object_info to verify custom/core node availability."""
    req = urllib.request.Request(f"{COMFY_URL}/object_info", method="GET")
    try:
        with urllib.request.urlopen(req, timeout=3) as resp:
            data = json.loads(resp.read().decode("utf-8"))
            if isinstance(data, dict):
                return set(data.keys())
    except Exception:
        return None
    return None


def safe_workflow_filename(model_id: str) -> str:
    safe_name = "".join(ch if ch.isalnum() or ch in "._-" else "_" for ch in model_id)
    return f"{safe_name}.json"


def weight_file_ready(models_dir: Path, subdir: str, filename: str) -> bool:
    """Checks that a weight file (or symlink target) exists and is non-empty."""
    candidates = SUBDIR_ALIASES.get(subdir, (subdir,))
    for folder in candidates:
        candidate = models_dir / folder / filename
        try:
            if candidate.is_file() and candidate.stat().st_size > 0:
                return True
        except OSError:
            continue
    return False


def parse_workflow_json(path: Path) -> tuple[Optional[dict[str, Any]], Optional[str]]:
    if not path.is_file():
        return None, f"缺少工作流模板: {path.name}"
    try:
        raw = path.read_text(encoding="utf-8")
        data = json.loads(raw)
    except Exception as exc:
        return None, f"工作流 JSON 解析失败 ({path.name}): {exc}"
    if not isinstance(data, dict) or not data:
        return None, f"工作流 JSON 为空或结构无效 ({path.name})"
    for node_id, node in data.items():
        if not isinstance(node, dict) or not isinstance(node.get("class_type"), str):
            return None, f"工作流节点 {node_id} 缺少 class_type ({path.name})"
    return data, None


def extract_workflow_weights_and_nodes(graph: dict[str, Any]) -> tuple[list[tuple[str, str]], set[str]]:
    weights: list[tuple[str, str]] = []
    seen_weights: set[tuple[str, str]] = set()
    node_types: set[str] = set()
    for node in graph.values():
        if not isinstance(node, dict):
            continue
        cls_type = node.get("class_type")
        if isinstance(cls_type, str):
            node_types.add(cls_type)
            inputs = node.get("inputs") or {}
            if isinstance(inputs, dict) and cls_type in LOADER_WEIGHT_INPUTS:
                for field_name, subdir in LOADER_WEIGHT_INPUTS[cls_type]:
                    val = inputs.get(field_name)
                    if isinstance(val, str) and val.strip() and not val.startswith("__"):
                        key = (subdir, val.strip())
                        if key not in seen_weights:
                            seen_weights.add(key)
                            weights.append(key)
    return weights, node_types


def workflow_uses_ref_image(graph: dict[str, Any]) -> bool:
    return "__REF_IMAGE__" in json.dumps(graph, ensure_ascii=False)


def evaluate_model_readiness(
    model_id: str,
    workflow_dir: Path,
    models_dir: Path,
    installed_nodes: Optional[set[str]],
    *,
    require_comfy: bool = False,
) -> tuple[bool, list[str]]:
    reasons: list[str] = []
    spec = BUILTIN_MODEL_SPECS.get(model_id)
    wf_name = spec["workflow"] if spec else safe_workflow_filename(model_id)
    wf_path = workflow_dir / wf_name

    graph, wf_err = parse_workflow_json(wf_path)
    if wf_err:
        reasons.append(wf_err)

    required_weights: list[tuple[str, str]] = []
    required_nodes: set[str] = set()
    if graph is not None:
        graph_weights, graph_nodes = extract_workflow_weights_and_nodes(graph)
        required_weights.extend(graph_weights)
        required_nodes.update(graph_nodes)
    elif spec:
        required_weights.extend(spec["weights"])
        required_nodes.update(spec["required_nodes"])

    for subdir, filename in required_weights:
        if not weight_file_ready(models_dir, subdir, filename):
            reasons.append(f"缺少权重文件: {subdir}/{filename}")

    if installed_nodes is None:
        if require_comfy:
            reasons.append(f"ComfyUI 服务未就绪 ({COMFY_URL})")
    elif required_nodes:
        missing_nodes = sorted(n for n in required_nodes if n not in installed_nodes)
        if missing_nodes:
            reasons.append(f"ComfyUI 缺少节点: {', '.join(missing_nodes)}")

    return len(reasons) == 0, reasons


def discover_candidate_models(workflow_dir: Path) -> list[str]:
    candidates: list[str] = []
    seen: set[str] = set()

    def add(mid: str) -> None:
        if mid and mid not in seen:
            seen.add(mid)
            candidates.append(mid)

    if REQUESTED_MODELS:
        for mid in REQUESTED_MODELS:
            add(mid)
    else:
        for mid in BUILTIN_MODEL_SPECS:
            add(mid)
        if workflow_dir.is_dir():
            for wf in sorted(workflow_dir.glob("*.json")):
                add(wf.stem)
    return candidates


def evaluate_all_models(
    workflow_dir: Optional[Path] = None,
    models_dir: Optional[Path] = None,
    installed_nodes: Optional[set[str]] = None,
    probe_comfy: bool = True,
    require_comfy: bool = True,
) -> tuple[list[str], dict[str, list[str]], bool]:
    wf_dir = workflow_dir or WORKFLOW_DIR
    m_dir = models_dir or COMFY_MODELS_DIR
    nodes = installed_nodes
    if nodes is None and probe_comfy:
        nodes = fetch_comfy_installed_nodes()

    comfy_reachable = nodes is not None
    ready: list[str] = []
    not_ready: dict[str, list[str]] = {}
    for mid in discover_candidate_models(wf_dir):
        ok, reasons = evaluate_model_readiness(
            mid, wf_dir, m_dir, nodes, require_comfy=require_comfy
        )
        if ok:
            ready.append(mid)
        else:
            not_ready[mid] = reasons
    return ready, not_ready, comfy_reachable


def upload_image_to_comfy(image_b64: str, prefix: str = "aivora_ref") -> str:
    cleaned = (image_b64 or "").strip()
    if cleaned.startswith("data:") and "," in cleaned:
        cleaned = cleaned.split(",", 1)[1]
    try:
        raw = base64.b64decode(cleaned, validate=True)
    except (binascii.Error, ValueError) as exc:
        raise HTTPException(status_code=400, detail=f"参考图 Base64 格式无效: {exc}") from exc
    if len(raw) < 16:
        raise HTTPException(status_code=400, detail="参考图数据为空或过小")

    boundary = f"----AivoraBoundary{secrets.token_hex(8)}"
    filename = f"{prefix}_{secrets.token_hex(4)}.png"
    body = (
        f"--{boundary}\r\n"
        f'Content-Disposition: form-data; name="image"; filename="{filename}"\r\n'
        f"Content-Type: image/png\r\n\r\n"
    ).encode("utf-8") + raw + f"\r\n--{boundary}--\r\n".encode("utf-8")
    resp = comfy_request("POST", "/upload/image", body, f"multipart/form-data; boundary={boundary}")
    data = json.loads(resp.decode("utf-8"))
    return str(data.get("name") or filename)


def resolve_image_dimensions(aspect_ratio: str) -> tuple[int, int]:
    return (768, 1344) if aspect_ratio == "9:16" else (1344, 768)


def resolve_video_dimensions(model_id: str, aspect_ratio: str) -> tuple[int, int]:
    # Wan 2.2 TI2V-5B VAE requires height & width divisible by 32 (704, not 720).
    if model_id.startswith("wan2.2"):
        return (704, 1280) if aspect_ratio == "9:16" else (1280, 704)
    return (720, 1280) if aspect_ratio == "9:16" else (1280, 720)


def compute_video_num_frames(duration_sec: float, fps: int = 24) -> int:
    # Wan 2.2 temporal VAE requires frame length == 4k + 1 (e.g., 49, 73, 97, 121).
    val = float(duration_sec) if duration_sec and duration_sec > 0 else 5.0
    clamped_sec = max(1.0, min(val, 5.0))
    raw_frames = max(25, min(int(round(clamped_sec * fps)) + 1, 121))
    return ((raw_frames - 1) // 4) * 4 + 1


def _substitute_value(val: Any, exact_map: dict[str, Any], str_map: dict[str, str]) -> Any:
    if isinstance(val, str):
        if val in exact_map:
            return exact_map[val]
        out = val
        for placeholder, replacement in str_map.items():
            if placeholder in out:
                out = out.replace(placeholder, replacement)
        return out
    if isinstance(val, list):
        return [_substitute_value(item, exact_map, str_map) for item in val]
    if isinstance(val, dict):
        return {k: _substitute_value(v, exact_map, str_map) for k, v in val.items()}
    return val


def render_workflow_graph(
    graph_template: dict[str, Any],
    *,
    prompt: str,
    negative_prompt: str,
    width: int,
    height: int,
    ref_filename: Optional[str],
    duration_sec: float,
    seed: Optional[int] = None,
) -> dict[str, Any]:
    """Deep-copies a ComfyUI API workflow dict and substitutes typed placeholders safely."""
    resolved_seed = seed if seed is not None else secrets.randbelow(2**31 - 1)
    num_frames = compute_video_num_frames(duration_sec)

    graph = copy.deepcopy(graph_template)

    # If no reference image was provided (T2V fallback), cleanly detach LoadImage("__REF_IMAGE__")
    # nodes so Wan22ImageToVideoLatent runs in text-to-video mode without failing on empty filename.
    if not ref_filename:
        ref_loader_ids: set[str] = set()
        for node_id, node in list(graph.items()):
            if (
                isinstance(node, dict)
                and node.get("class_type") == "LoadImage"
                and isinstance(node.get("inputs"), dict)
                and node["inputs"].get("image") == "__REF_IMAGE__"
            ):
                ref_loader_ids.add(node_id)
        if ref_loader_ids:
            for node_id in ref_loader_ids:
                del graph[node_id]
            for node in graph.values():
                inputs = node.get("inputs") if isinstance(node, dict) else None
                if not isinstance(inputs, dict):
                    continue
                for input_key, input_val in list(inputs.items()):
                    if (
                        isinstance(input_val, list)
                        and len(input_val) >= 1
                        and str(input_val[0]) in ref_loader_ids
                    ):
                        del inputs[input_key]

    exact_map: dict[str, Any] = {
        "__PROMPT__": prompt,
        "__NEGATIVE_PROMPT__": negative_prompt or "",
        "__WIDTH__": int(width),
        "__HEIGHT__": int(height),
        "__DURATION_SEC__": int(round(duration_sec)),
        "__NUM_FRAMES__": int(num_frames),
        "__SEED__": int(resolved_seed),
        "__REF_IMAGE__": ref_filename or "",
    }
    str_map: dict[str, str] = {k: str(v) for k, v in exact_map.items()}
    return _substitute_value(graph, exact_map, str_map)


def ensure_model_ready_and_load_template(model_id: str) -> dict[str, Any]:
    safe_model = validate_safe_id(model_id, "model")
    installed_nodes = fetch_comfy_installed_nodes()
    ok, reasons = evaluate_model_readiness(
        safe_model, WORKFLOW_DIR, COMFY_MODELS_DIR, installed_nodes, require_comfy=True
    )
    if not ok:
        raise HTTPException(
            status_code=400,
            detail=f"模型 {safe_model} 尚未就绪：{'；'.join(reasons)}",
        )

    spec = BUILTIN_MODEL_SPECS.get(safe_model)
    wf_name = spec["workflow"] if spec else safe_workflow_filename(safe_model)
    wf_path = WORKFLOW_DIR / wf_name
    graph_template, wf_err = parse_workflow_json(wf_path)
    if wf_err or graph_template is None:
        raise HTTPException(status_code=400, detail=wf_err or f"无法加载工作流 {wf_path}")
    return graph_template


def queue_comfy_prompt(graph: dict[str, Any]) -> str:
    payload = json.dumps({"prompt": graph, "client_id": "aivora-worker"}).encode("utf-8")
    resp = comfy_request("POST", "/prompt", payload, "application/json")
    data = json.loads(resp.decode("utf-8"))
    prompt_id = data.get("prompt_id")
    if not prompt_id:
        raise HTTPException(status_code=502, detail=f"ComfyUI did not return prompt_id: {data}")
    return str(prompt_id)


def fetch_history_entry(prompt_id: str) -> Optional[dict[str, Any]]:
    safe_pid = validate_safe_id(prompt_id, "task_id")
    raw = comfy_request("GET", f"/history/{urllib.parse.quote(safe_pid, safe='')}")
    hist = json.loads(raw.decode("utf-8"))
    entry = hist.get(safe_pid)
    return entry if isinstance(entry, dict) else None


def extract_media_from_entry(entry: dict[str, Any], media_type: str) -> Optional[dict[str, str]]:
    outputs = entry.get("outputs") or {}
    buckets = ("images",) if media_type == "image" else ("gifs", "videos", "images")
    for node_out in outputs.values():
        if not isinstance(node_out, dict):
            continue
        for bucket in buckets:
            items = node_out.get(bucket) or []
            if not isinstance(items, list):
                continue
            # Scan in reverse so VHS_VideoCombine's final encoded video wins over metadata PNGs.
            for item in reversed(items):
                if not isinstance(item, dict) or not item.get("filename"):
                    continue
                fname = str(item["filename"])
                if media_type == "video" and not fname.lower().endswith((".mp4", ".webm", ".mov")):
                    continue
                if media_type == "image" and not fname.lower().endswith((".png", ".jpg", ".jpeg", ".webp")):
                    continue
                return {
                    "filename": fname,
                    "subfolder": str(item.get("subfolder", "")),
                    "type": str(item.get("type", "output")),
                }
    return None


def find_history_media(prompt_id: str, media_type: str) -> Optional[dict[str, str]]:
    entry = fetch_history_entry(prompt_id)
    if not entry:
        return None
    return extract_media_from_entry(entry, media_type)


def extract_entry_error(entry: dict[str, Any]) -> Optional[str]:
    status_obj = entry.get("status")
    if isinstance(status_obj, dict) and status_obj.get("status_str") == "error":
        messages = status_obj.get("messages") or []
        detail = f"ComfyUI workflow execution error: {messages}" if messages else "ComfyUI workflow execution error"
        return detail[:300]
    return None


def detect_queue_state(prompt_id: str) -> Optional[str]:
    try:
        raw = comfy_request("GET", "/queue", timeout=5)
        data = json.loads(raw.decode("utf-8"))
        for item in data.get("queue_running") or []:
            if isinstance(item, list) and len(item) >= 2 and str(item[1]) == prompt_id:
                return "running"
        for item in data.get("queue_pending") or []:
            if isinstance(item, list) and len(item) >= 2 and str(item[1]) == prompt_id:
                return "queued"
        return None
    except Exception:
        return "running"


class ImageGenRequest(BaseModel):
    model: str = "flux-schnell"
    prompt: str
    negative_prompt: str = ""
    aspect_ratio: str = "16:9"
    reference_image_base64: Optional[str] = None


class VideoSubmitRequest(BaseModel):
    model: str = "wan2.2-i2v-5b"
    prompt: str
    negative_prompt: str = ""
    duration_sec: float = 5.0
    aspect_ratio: str = "16:9"
    image_base64: Optional[str] = None


@app.get("/aivora/health", dependencies=[Depends(require_bearer_token)])
def health() -> JSONResponse:
    ready_models, not_ready, comfy_reachable = evaluate_all_models(
        probe_comfy=True, require_comfy=True
    )
    payload = {
        "ok": comfy_reachable,
        "comfy_reachable": comfy_reachable,
        "gpu": detect_gpu_name(),
        "models": ready_models,
        "not_ready": not_ready,
        "comfy_url": COMFY_URL,
        "models_dir": str(COMFY_MODELS_DIR),
        "workflow_dir": str(WORKFLOW_DIR),
    }
    return JSONResponse(status_code=200 if comfy_reachable else 503, content=payload)


@app.post("/aivora/images/generate", dependencies=[Depends(require_bearer_token)])
def generate_image(req: ImageGenRequest) -> Response:
    template = ensure_model_ready_and_load_template(req.model)
    width, height = resolve_image_dimensions(req.aspect_ratio)
    ref_file = (
        upload_image_to_comfy(req.reference_image_base64)
        if req.reference_image_base64 and workflow_uses_ref_image(template)
        else None
    )
    graph = render_workflow_graph(
        template,
        prompt=req.prompt,
        negative_prompt=req.negative_prompt,
        width=width,
        height=height,
        ref_filename=ref_file,
        duration_sec=0,
    )
    prompt_id = queue_comfy_prompt(graph)

    deadline = time.time() + 170
    while time.time() < deadline:
        entry = fetch_history_entry(prompt_id)
        if entry:
            err_msg = extract_entry_error(entry)
            if err_msg:
                raise HTTPException(status_code=502, detail=err_msg)
            media = extract_media_from_entry(entry, "image")
            if media:
                qs = urllib.parse.urlencode(media)
                png_bytes = comfy_request("GET", f"/view?{qs}")
                return Response(content=png_bytes, media_type="image/png")
            status_obj = entry.get("status")
            if isinstance(status_obj, dict) and status_obj.get("completed"):
                raise HTTPException(status_code=502, detail="ComfyUI 工作流已结束但未输出图片文件")
        time.sleep(1.5)
    raise HTTPException(status_code=504, detail="ComfyUI image generation timed out")


@app.post("/aivora/videos/submit", dependencies=[Depends(require_bearer_token)])
def submit_video(req: VideoSubmitRequest) -> dict[str, str]:
    template = ensure_model_ready_and_load_template(req.model)
    width, height = resolve_video_dimensions(req.model, req.aspect_ratio)
    ref_file = (
        upload_image_to_comfy(req.image_base64, "aivora_firstframe")
        if req.image_base64 and workflow_uses_ref_image(template)
        else None
    )
    graph = render_workflow_graph(
        template,
        prompt=req.prompt,
        negative_prompt=req.negative_prompt,
        width=width,
        height=height,
        ref_filename=ref_file,
        duration_sec=req.duration_sec,
    )
    task_id = queue_comfy_prompt(graph)
    return {"task_id": task_id}


@app.get("/aivora/videos/status/{task_id}", dependencies=[Depends(require_bearer_token)])
def video_status(task_id: str) -> dict[str, Any]:
    safe_tid = validate_safe_id(task_id, "task_id")
    entry = fetch_history_entry(safe_tid)
    if entry:
        media = extract_media_from_entry(entry, "video")
        if media:
            return {
                "status": "succeeded",
                "progress": 100,
                "download_url": f"/aivora/videos/download/{urllib.parse.quote(safe_tid, safe='')}",
            }
        err_msg = extract_entry_error(entry)
        if err_msg:
            return {"status": "failed", "progress": 0, "error": err_msg}
        status_obj = entry.get("status")
        if isinstance(status_obj, dict) and status_obj.get("completed"):
            return {
                "status": "failed",
                "progress": 0,
                "error": "ComfyUI 工作流已完成但未生成有效视频文件（请检查 VHS_VideoCombine 与 FFmpeg）",
            }
        return {"status": "running", "progress": 75}

    queue_state = detect_queue_state(safe_tid)
    if queue_state == "queued":
        return {"status": "queued", "progress": 15}
    if queue_state == "running":
        return {"status": "running", "progress": 50}
    return {
        "status": "failed",
        "progress": 0,
        "error": "ComfyUI 未找到该任务记录（可能算力端已重启或任务号无效）",
    }


@app.get("/aivora/videos/download/{task_id}", dependencies=[Depends(require_bearer_token)])
def download_video(task_id: str) -> Response:
    safe_tid = validate_safe_id(task_id, "task_id")
    media = find_history_media(safe_tid, "video")
    if not media:
        raise HTTPException(status_code=404, detail="Video output not ready or task not found")
    qs = urllib.parse.urlencode(media)
    mp4_bytes = comfy_request("GET", f"/view?{qs}")
    return Response(content=mp4_bytes, media_type="video/mp4")
