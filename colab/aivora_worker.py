"""AIVORA Studio ComfyUI GPU Worker Bridge.

Exposes a minimal authenticated HTTP API on top of a local or Colab ComfyUI server:
  GET  /aivora/health
  POST /aivora/images/generate
  POST /aivora/videos/submit
  GET  /aivora/videos/status/{task_id}
  GET  /aivora/videos/download/{task_id}

Run locally or on AutoDL/Colab:
  AIVORA_WORKER_TOKEN=<32-char-token> uvicorn aivora_worker:app --host 0.0.0.0 --port 8199
"""

from __future__ import annotations

import base64
import json
import os
import secrets
import subprocess
import time
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path
from typing import Any, Optional

from fastapi import Depends, FastAPI, Header, HTTPException
from fastapi.responses import Response
from pydantic import BaseModel

COMFY_URL = os.environ.get("COMFY_URL", "http://127.0.0.1:8188").rstrip("/")
WORKER_TOKEN = os.environ.get("AIVORA_WORKER_TOKEN") or secrets.token_urlsafe(24)
WORKFLOW_DIR = Path(os.environ.get("AIVORA_WORKFLOW_DIR", "./workflows"))
ADVERTISED_MODELS = [
    m.strip()
    for m in os.environ.get(
        "AIVORA_MODELS",
        "flux-schnell,wan2.2-i2v-5b,wan2.2-i2v-14b-gguf,ltx-2.5-distilled",
    ).split(",")
    if m.strip()
]

app = FastAPI(title="AIVORA ComfyUI GPU Worker", version="1.3.0")


def require_bearer_token(authorization: Optional[str] = Header(default=None)) -> None:
    if not authorization or not authorization.startswith("Bearer "):
        raise HTTPException(status_code=401, detail="Missing Bearer token")
    provided = authorization.removeprefix("Bearer ").strip()
    if not secrets.compare_digest(provided, WORKER_TOKEN):
        raise HTTPException(status_code=403, detail="Invalid Bearer token")


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


def comfy_request(method: str, endpoint: str, payload: Optional[bytes] = None, content_type: Optional[str] = None) -> bytes:
    url = f"{COMFY_URL}{endpoint}"
    headers: dict[str, str] = {}
    if content_type:
        headers["Content-Type"] = content_type
    req = urllib.request.Request(url, data=payload, headers=headers, method=method)
    try:
        with urllib.request.urlopen(req, timeout=120) as resp:
            return resp.read()
    except urllib.error.HTTPError as exc:
        body = exc.read().decode("utf-8", errors="ignore")[:300]
        raise HTTPException(status_code=502, detail=f"ComfyUI HTTP {exc.code}: {body}") from exc
    except Exception as exc:
        raise HTTPException(status_code=502, detail=f"ComfyUI unreachable: {exc}") from exc


def upload_image_to_comfy(image_b64: str, prefix: str = "aivora_ref") -> str:
    raw = base64.b64decode(image_b64)
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


def load_workflow_template(model_id: str, is_video: bool, prompt: str, negative_prompt: str, width: int, height: int, ref_filename: Optional[str], duration_sec: int) -> dict[str, Any]:
    """Loads an optional user workflow JSON from WORKFLOW_DIR/{model_id}.json or builds a clean default graph."""
    safe_name = "".join(ch if ch.isalnum() or ch in "._-" else "_" for ch in model_id)
    custom_path = WORKFLOW_DIR / f"{safe_name}.json"
    if custom_path.exists():
        template_text = custom_path.read_text(encoding="utf-8")
        replacements = {
            "__PROMPT__": json.dumps(prompt)[1:-1],
            "__NEGATIVE_PROMPT__": json.dumps(negative_prompt)[1:-1],
            "__WIDTH__": str(width),
            "__HEIGHT__": str(height),
            "__DURATION_SEC__": str(duration_sec),
            "__SEED__": str(secrets.randbelow(2**31 - 1)),
            "__REF_IMAGE__": json.dumps(ref_filename or "")[1:-1],
        }
        for key, val in replacements.items():
            template_text = template_text.replace(key, val)
        return json.loads(template_text)

    if not is_video:
        # Default Flux.1 Schnell / standard Checkpoint workflow graph
        return {
            "1": {"class_type": "CheckpointLoaderSimple", "inputs": {"ckpt_name": os.environ.get("AIVORA_IMAGE_CKPT", "flux1-schnell-fp8.safetensors")}},
            "2": {"class_type": "CLIPTextEncode", "inputs": {"text": prompt, "clip": ["1", 1]}},
            "3": {"class_type": "CLIPTextEncode", "inputs": {"text": negative_prompt or "", "clip": ["1", 1]}},
            "4": {"class_type": "EmptyLatentImage", "inputs": {"width": width, "height": height, "batch_size": 1}},
            "5": {
                "class_type": "KSampler",
                "inputs": {
                    "seed": secrets.randbelow(2**31 - 1),
                    "steps": 4,
                    "cfg": 1.0,
                    "sampler_name": "euler",
                    "scheduler": "simple",
                    "denoise": 1.0,
                    "model": ["1", 0],
                    "positive": ["2", 0],
                    "negative": ["3", 0],
                    "latent_image": ["4", 0],
                },
            },
            "6": {"class_type": "VAEDecode", "inputs": {"samples": ["5", 0], "vae": ["1", 2]}},
            "7": {"class_type": "SaveImage", "inputs": {"filename_prefix": "aivora_img", "images": ["6", 0]}},
        }

    raise HTTPException(
        status_code=400,
        detail=(
            f"未找到视频工作流模板 {custom_path}。"
            "请运行 Colab 笔记本第 3 步生成对应模型（Wan 2.2 / LTX-2.5）的 ComfyUI API Workflow JSON。"
        ),
    )


def queue_comfy_prompt(graph: dict[str, Any]) -> str:
    payload = json.dumps({"prompt": graph, "client_id": "aivora-worker"}).encode("utf-8")
    resp = comfy_request("POST", "/prompt", payload, "application/json")
    data = json.loads(resp.decode("utf-8"))
    prompt_id = data.get("prompt_id")
    if not prompt_id:
        raise HTTPException(status_code=502, detail=f"ComfyUI did not return prompt_id: {data}")
    return str(prompt_id)


def find_history_media(prompt_id: str, media_type: str) -> Optional[dict[str, str]]:
    raw = comfy_request("GET", f"/history/{urllib.parse.quote(prompt_id)}")
    hist = json.loads(raw.decode("utf-8"))
    entry = hist.get(prompt_id)
    if not entry:
        return None
    outputs = entry.get("outputs") or {}
    key = "images" if media_type == "image" else "gifs"
    for node_out in outputs.values():
        for bucket in (key, "videos", "images"):
            items = node_out.get(bucket) or []
            if items and isinstance(items[0], dict) and items[0].get("filename"):
                if media_type == "video" and not str(items[0]["filename"]).lower().endswith((".mp4", ".webm", ".mov")):
                    continue
                return {
                    "filename": str(items[0]["filename"]),
                    "subfolder": str(items[0].get("subfolder", "")),
                    "type": str(items[0].get("type", "output")),
                }
    return None


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
    duration_sec: int = 5
    aspect_ratio: str = "16:9"
    image_base64: Optional[str] = None


@app.get("/aivora/health", dependencies=[Depends(require_bearer_token)])
def health() -> dict[str, Any]:
    return {
        "ok": True,
        "gpu": detect_gpu_name(),
        "models": ADVERTISED_MODELS,
        "comfy_url": COMFY_URL,
    }


@app.post("/aivora/images/generate", dependencies=[Depends(require_bearer_token)])
def generate_image(req: ImageGenRequest) -> Response:
    width, height = (768, 1344) if req.aspect_ratio == "9:16" else (1344, 768)
    ref_file = upload_image_to_comfy(req.reference_image_base64) if req.reference_image_base64 else None
    graph = load_workflow_template(req.model, False, req.prompt, req.negative_prompt, width, height, ref_file, 0)
    prompt_id = queue_comfy_prompt(graph)

    deadline = time.time() + 170
    while time.time() < deadline:
        media = find_history_media(prompt_id, "image")
        if media:
            qs = urllib.parse.urlencode(media)
            png_bytes = comfy_request("GET", f"/view?{qs}")
            return Response(content=png_bytes, media_type="image/png")
        time.sleep(1.5)
    raise HTTPException(status_code=504, detail="ComfyUI image generation timed out")


@app.post("/aivora/videos/submit", dependencies=[Depends(require_bearer_token)])
def submit_video(req: VideoSubmitRequest) -> dict[str, str]:
    width, height = (720, 1280) if req.aspect_ratio == "9:16" else (1280, 720)
    ref_file = upload_image_to_comfy(req.image_base64, "aivora_firstframe") if req.image_base64 else None
    graph = load_workflow_template(
        req.model, True, req.prompt, req.negative_prompt, width, height, ref_file, req.duration_sec
    )
    task_id = queue_comfy_prompt(graph)
    return {"task_id": task_id}


@app.get("/aivora/videos/status/{task_id}", dependencies=[Depends(require_bearer_token)])
def video_status(task_id: str) -> dict[str, Any]:
    media = find_history_media(task_id, "video")
    if media:
        return {
            "status": "succeeded",
            "progress": 100,
            "download_url": f"/aivora/videos/download/{urllib.parse.quote(task_id)}",
        }
    raw = comfy_request("GET", f"/history/{urllib.parse.quote(task_id)}")
    hist = json.loads(raw.decode("utf-8"))
    entry = hist.get(task_id)
    if entry and entry.get("status", {}).get("status_str") == "error":
        return {"status": "failed", "progress": 0, "error": "ComfyUI workflow execution error"}
    return {"status": "running", "progress": 50}


@app.get("/aivora/videos/download/{task_id}", dependencies=[Depends(require_bearer_token)])
def download_video(task_id: str) -> Response:
    media = find_history_media(task_id, "video")
    if not media:
        raise HTTPException(status_code=404, detail="Video output not ready or task not found")
    qs = urllib.parse.urlencode(media)
    mp4_bytes = comfy_request("GET", f"/view?{qs}")
    return Response(content=mp4_bytes, media_type="video/mp4")
