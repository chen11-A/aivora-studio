# AIVORA Studio：Google Colab / 本地 ComfyUI 算力直连指南

通过这套轻量桥接服务（`aivora_worker.py` + `aivora-gpu-worker.ipynb` + `workflows/*.json`），你可以把 **Google Colab（T4 / L4 / A100）**、**AutoDL 算力云** 或 **本机 NVIDIA 显卡的 ComfyUI** 接入 AIVORA Studio 的「模型中心」，直接用于生图定妆与图生视频，并完整支持 `UNKNOWN` 断线查单找回。

---

## 一、内置模型预设与显卡档位对照

| GPU 型号 | 显存 | 推荐 `MODEL_PRESET` | 自动下载的开源权重（HuggingFace） |
| --- | --- | --- | --- |
| **Colab T4** | 16 GB | `flux-schnell` | `Comfy-Org/flux1-schnell` → `flux1-schnell-fp8.safetensors`（17.2 GB） |
| **Colab L4 / A100** | 24–80 GB | `flux-schnell + wan2.2-i2v-5b` | 上述 Flux 权重 + `Comfy-Org/Wan_2.2_ComfyUI_Repackaged`（`wan2.2_ti2v_5B_fp16.safetensors`、`wan2.2_vae.safetensors`）+ `Comfy-Org/Wan_2.1_ComfyUI_repackaged`（`umt5_xxl_fp8_e4m3fn_scaled.safetensors`） |

> 提示：所有内置权重均来自 `Comfy-Org` 公开仓库（Apache-2.0），无需申请私有权限。开启 `USE_GOOGLE_DRIVE_CACHE = True` 后，权重会缓存到 `MyDrive/AIVORA_Models/` 并软链到 `/content/ComfyUI/models/`，下次重开 Colab 自动复用缓存，不再重复下载。（注意：Google Drive 免费版容量为 15 GB，放不下 17.2 GB 的 Flux 权重；如无 100GB+ 云盘空间，请将 `USE_GOOGLE_DRIVE_CACHE` 设为 `False` 使用 Colab 实例本地磁盘。）

---

## 二、Google Colab 三步上手

1. 在 AIVORA Studio 模型中心选择 **「Google Colab / 本地 ComfyUI 算力直连」**，点击 **「打开 Colab 一键启动页」**（菜单「代码执行程序 → 更改运行时类型 → L4 / A100 / T4 GPU」）。
2. 依次运行第 1、2、3 步单元格：
   - 第 1 步检测 GPU 并可选挂载 Google Drive 缓存目录；
   - 第 2 步自动安装 ComfyUI、`ComfyUI-VideoHelperSuite`（H.264 MP4 视频封装节点）、拉取 `workflows/*.json`，按预设从 HuggingFace 下载所需权重并软链进 `/content/ComfyUI/models/`；
   - 第 3 步启动 ComfyUI 与 `aivora_worker.py`，实地校验 `/aivora/health`，只把「权重文件 + 工作流 JSON + ComfyUI 节点」三项均就绪的模型写入 **「一键连接码（`AIVORA-COMFY::...`）」**。
3. 整段复制连接码，粘贴到模型中心的 **「一键粘贴连接码」** 框中，保存后测试连接，再绑定到 **生图定妆** / **生成视频** 即可。

---

## 三、本机显卡或 AutoDL 直接启动（无需 Colab）

如果你已有正在运行的本地 ComfyUI（默认 `http://127.0.0.1:8188`，并已安装 `ComfyUI-VideoHelperSuite` 及对应权重）：

```bash
pip install fastapi uvicorn pydantic
export AIVORA_WORKER_TOKEN="your-random-32-char-secret-token"
export COMFY_MODELS_DIR="/path/to/ComfyUI/models"
export AIVORA_WORKFLOW_DIR="./colab/workflows"
uvicorn aivora_worker:app --app-dir ./colab --host 127.0.0.1 --port 8199
```

`GET /aivora/health` 会自动校验本地权重文件、工作流 JSON 与 ComfyUI 已装节点，只返回真实可用的模型并在 `not_ready` 字段列出缺失项，避免误把未装好的模型广告成可用。

---

## 四、内置与自定义 ComfyUI 工作流模板

仓库 `colab/workflows/` 已内置两份可直接执行的标准 ComfyUI API Workflow JSON：
- `colab/workflows/flux-schnell.json`（Flux.1 Schnell FP8 4 步出图）
- `colab/workflows/wan2.2-i2v-5b.json`（Wan 2.2 TI2V-5B 720p 图生视频 / 无首帧自动回退文生视频，自动对齐 32 倍数分辨率 `1280x704` / `704x1280` 与 `4k+1` 帧数，经 `VHS_VideoCombine` 输出 `yuv420p` H.264 MP4）

如需接入更多自定义模型，只需将 ComfyUI 导出的 **API Format Workflow JSON** 放进 `workflows/<model_id>.json`，权重放进 `COMFY_MODELS_DIR` 对应目录即可。支持以下占位符（自动按 JSON 类型安全替换）：

- `__PROMPT__`：镜头画面描述（已注入锁定角色/场景外貌词）
- `__NEGATIVE_PROMPT__`：反向提示词
- `__WIDTH__` / `__HEIGHT__`：自动按作品 `16:9` 或 `9:16` 填充为整数
- `__DURATION_SEC__`：镜头时长（秒，整数）
- `__NUM_FRAMES__`：自动按 `4k+1` 帧数规则换算（24fps，上限 121 帧）
- `__SEED__`：每次自动生成的随机整数种子
- `__REF_IMAGE__`：自动上传至 ComfyUI 的首帧图/参考图文件名（为空时自动剥离 `LoadImage` 节点以支持纯文生视频）
