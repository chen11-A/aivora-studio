# AIVORA Studio — Google Colab / 本地 ComfyUI 算力直连指南

通过这套轻量桥接服务（`aivora_worker.py` + `aivora-gpu-worker.ipynb`），你可以把 **Google Colab（Pro L4/A100）**、**AutoDL 算力云** 或 **本机 NVIDIA 显卡的 ComfyUI** 接入 AIVORA Studio 的「模型中心」，直接用于生图定妆与生成视频，并完整支持 `UNKNOWN` 断线查单找回。

---

## 一、显卡显存与模型档位对照（真实预期）

| GPU 型号 | 显存 | 推荐模型预设 | 首次冷启动预计 |
| --- | --- | --- | --- |
| **Colab T4** | 16 GB | `flux-schnell`（FP8 生图） | 4–6 分钟 |
| **Colab L4** | 24 GB | `flux-schnell` + `wan2.2-i2v-5b` / `wan2.2-i2v-14b-gguf` | 5–10 分钟（挂载 Drive 后约 3–5 分钟） |
| **Colab A100 / AutoDL 4090+** | 40–80 GB | 全系列，含 `ltx-2.5-distilled`（带原生音效） | 4–8 分钟 |

> 提示：22B 满血版 LTX-2.5 或未量化 14B 视频模型在 24GB L4 上会爆显存，L4 请优先使用 GGUF / FP8 量化权重或 5B 版本。

---

## 二、Google Colab 三步上手

1. 在 AIVORA Studio 模型中心选择 **「Google Colab / 本地 ComfyUI 算力直连」**，点击 **「打开 Colab 一键启动页」**（菜单「代码执行程序 → 更改运行时类型 → L4 / A100 GPU」）。
2. 依次运行第 1、2、3 步单元格，底部会打印一段 **「一键连接码（`AIVORA-COMFY::...`）」**（同时包含 `Base URL` 与 32 位随机 `Access Token`）。
3. 整段复制连接码，粘贴到模型中心的 **「一键粘贴连接码」** 框中，软件自动填充网址、令牌与模型列表；点「保存厂家配置」→「测试连接」，再在下方「默认模型路由」绑定到 **生图定妆** / **生成视频**。
4. 下次重开 Colab 临时隧道地址变化时，直接点厂家卡片上的 **「编辑」** 再粘贴一次新连接码即可，原有模型路由无需重新配置。

---

## 三、本机显卡或 AutoDL 直接启动（无需 Colab）

如果你已有正在运行的本地 ComfyUI（默认 `http://127.0.0.1:8188`）：

```bash
pip install fastapi uvicorn pydantic
export AIVORA_WORKER_TOKEN="your-random-32-char-secret-token"
export AIVORA_WORKFLOW_DIR="./workflows"
uvicorn aivora_worker:app --host 127.0.0.1 --port 8199
```

然后在 AIVORA 模型中心填 `Base URL = http://127.0.0.1:8199` 和同样的 `Access Token` 即可零延迟直连。

---

## 四、自定义 ComfyUI 工作流模板

将 ComfyUI 导出的 **API Format Workflow JSON** 放进 `workflows/<model_id>.json`（例如 `workflows/wan2.2-i2v-5b.json`），支持以下占位符自动替换：

- `__PROMPT__`：镜头画面描述（已注入锁定角色/场景外貌词）
- `__NEGATIVE_PROMPT__`：反向提示词
- `__WIDTH__` / `__HEIGHT__`：自动按作品 `16:9` 或 `9:16` 填充
- `__DURATION_SEC__`：镜头时长（秒）
- `__SEED__`：每次自动生成的随机种子
- `__REF_IMAGE__`：自动上传至 ComfyUI 的首帧图/参考图文件名
