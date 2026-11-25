"""Unit tests for colab/aivora_worker.py, colab/workflows/*.json, and colab/aivora-gpu-worker.ipynb."""

from __future__ import annotations

import json
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

COLAB_DIR = Path(__file__).resolve().parent
WORKFLOWS_DIR = COLAB_DIR / "workflows"
NOTEBOOK_PATH = COLAB_DIR / "aivora-gpu-worker.ipynb"

sys.path.insert(0, str(COLAB_DIR))
import aivora_worker  # noqa: E402


ALL_CORE_AND_VHS_NODES = {
    "CheckpointLoaderSimple",
    "CLIPTextEncode",
    "EmptySD3LatentImage",
    "KSampler",
    "VAEDecode",
    "SaveImage",
    "UNETLoader",
    "CLIPLoader",
    "VAELoader",
    "LoadImage",
    "Wan22ImageToVideoLatent",
    "ModelSamplingSD3",
    "VHS_VideoCombine",
}


class ColabWorkerIntegrityTests(unittest.TestCase):
    def test_bundled_workflows_are_valid_json_with_intact_links(self) -> None:
        for model_id in ("flux-schnell", "wan2.2-i2v-5b"):
            wf_path = WORKFLOWS_DIR / f"{model_id}.json"
            self.assertTrue(wf_path.is_file(), f"Missing bundled workflow {wf_path}")
            graph, err = aivora_worker.parse_workflow_json(wf_path)
            self.assertIsNone(err)
            assert graph is not None
            node_ids = set(graph.keys())
            for node_id, node in graph.items():
                inputs = node.get("inputs", {})
                self.assertIsInstance(inputs, dict, f"Node {node_id} inputs must be dict")
                for key, val in inputs.items():
                    if isinstance(val, list) and len(val) == 2 and isinstance(val[0], str):
                        self.assertIn(
                            val[0],
                            node_ids,
                            f"{model_id}: node {node_id}.{key} links to unknown node {val[0]}",
                        )

    def test_notebook_json_syntax_and_weight_manifest_alignment(self) -> None:
        nb = json.loads(NOTEBOOK_PATH.read_text(encoding="utf-8"))
        self.assertEqual(nb.get("nbformat"), 4)
        code_cells = [c for c in nb.get("cells", []) if c.get("cell_type") == "code"]
        self.assertEqual(len(code_cells), 3)

        all_sources = []
        for idx, cell in enumerate(code_cells, start=1):
            src = "".join(cell.get("source", []))
            compile(src, f"aivora-gpu-worker.ipynb#cell{idx}", "exec")
            all_sources.append(src)

        cell2_src = all_sources[1]
        cell3_src = all_sources[2]
        # Verify notebook downloads required real HuggingFace weights and VideoHelperSuite
        self.assertIn("ComfyUI-VideoHelperSuite", cell2_src)
        self.assertIn("Comfy-Org/flux1-schnell", cell2_src)
        self.assertIn("flux1-schnell-fp8.safetensors", cell2_src)
        self.assertIn("Comfy-Org/Wan_2.2_ComfyUI_Repackaged", cell2_src)
        self.assertIn("wan2.2_ti2v_5B_fp16.safetensors", cell2_src)
        self.assertIn("wan2.2_vae.safetensors", cell2_src)
        self.assertIn("Comfy-Org/Wan_2.1_ComfyUI_repackaged", cell2_src)
        self.assertIn("umt5_xxl_fp8_e4m3fn_scaled.safetensors", cell2_src)
        self.assertIn("symlink_to", cell2_src)
        # Verify Cell 3 queries /aivora/health, avoids PIPE deadlock, and enforces non-empty public_url
        self.assertIn("/aivora/health", cell3_src)
        self.assertIn("/content/tunnel.log", cell3_src)
        self.assertNotIn("subprocess.PIPE", cell3_src)
        self.assertNotIn("wan2.2-i2v-14b-gguf", cell3_src)
        self.assertNotIn("ltx-2.5-distilled", cell3_src)

    def test_health_truthfulness_weights_symlinks_and_comfy_nodes(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            cache_dir = root / "drive_cache"
            models_dir = root / "comfy_models"
            for sub in ("checkpoints", "diffusion_models", "text_encoders", "vae"):
                (cache_dir / sub).mkdir(parents=True, exist_ok=True)
                (models_dir / sub).mkdir(parents=True, exist_ok=True)

            # 1. Empty models dir -> NO models advertised
            ready, not_ready, reachable = aivora_worker.evaluate_all_models(
                workflow_dir=WORKFLOWS_DIR,
                models_dir=models_dir,
                installed_nodes=ALL_CORE_AND_VHS_NODES,
                probe_comfy=False,
                require_comfy=True,
            )
            self.assertTrue(reachable)
            self.assertEqual(ready, [])
            self.assertIn("flux-schnell", not_ready)
            self.assertIn("wan2.2-i2v-5b", not_ready)

            # 2. Broken symlink and 0-byte weight must NOT pass readiness
            broken_link = models_dir / "checkpoints" / "flux1-schnell-fp8.safetensors"
            broken_link.symlink_to(cache_dir / "checkpoints" / "does-not-exist.safetensors")
            ready, _, _ = aivora_worker.evaluate_all_models(
                workflow_dir=WORKFLOWS_DIR,
                models_dir=models_dir,
                installed_nodes=ALL_CORE_AND_VHS_NODES,
                probe_comfy=False,
                require_comfy=True,
            )
            self.assertEqual(ready, [])
            broken_link.unlink()

            flux_cache = cache_dir / "checkpoints" / "flux1-schnell-fp8.safetensors"
            flux_cache.write_bytes(b"")  # 0 bytes -> invalid!
            broken_link.symlink_to(flux_cache)
            ready, _, _ = aivora_worker.evaluate_all_models(
                workflow_dir=WORKFLOWS_DIR,
                models_dir=models_dir,
                installed_nodes=ALL_CORE_AND_VHS_NODES,
                probe_comfy=False,
                require_comfy=True,
            )
            self.assertEqual(ready, [])

            # 3. Real non-empty symlinked Flux weight -> ONLY flux-schnell advertised
            flux_cache.write_bytes(b"real-fp8-weights")
            ready, not_ready, _ = aivora_worker.evaluate_all_models(
                workflow_dir=WORKFLOWS_DIR,
                models_dir=models_dir,
                installed_nodes=ALL_CORE_AND_VHS_NODES,
                probe_comfy=False,
                require_comfy=True,
            )
            self.assertEqual(ready, ["flux-schnell"])
            self.assertIn("wan2.2-i2v-5b", not_ready)

            # 4. Add Wan 2.2 weights via symlinks, but omit VHS_VideoCombine node -> Wan NOT ready
            for sub, fname in (
                ("diffusion_models", "wan2.2_ti2v_5B_fp16.safetensors"),
                ("text_encoders", "umt5_xxl_fp8_e4m3fn_scaled.safetensors"),
                ("vae", "wan2.2_vae.safetensors"),
            ):
                src = cache_dir / sub / fname
                src.write_bytes(b"real-wan-weight")
                (models_dir / sub / fname).symlink_to(src)

            nodes_without_vhs = ALL_CORE_AND_VHS_NODES - {"VHS_VideoCombine"}
            ready, not_ready, _ = aivora_worker.evaluate_all_models(
                workflow_dir=WORKFLOWS_DIR,
                models_dir=models_dir,
                installed_nodes=nodes_without_vhs,
                probe_comfy=False,
                require_comfy=True,
            )
            self.assertEqual(ready, ["flux-schnell"])
            self.assertIn("wan2.2-i2v-5b", not_ready)
            self.assertTrue(any("VHS_VideoCombine" in r for r in not_ready["wan2.2-i2v-5b"]))

            # 5. With VHS_VideoCombine installed -> BOTH models ready!
            ready, not_ready, _ = aivora_worker.evaluate_all_models(
                workflow_dir=WORKFLOWS_DIR,
                models_dir=models_dir,
                installed_nodes=ALL_CORE_AND_VHS_NODES,
                probe_comfy=False,
                require_comfy=True,
            )
            self.assertEqual(ready, ["flux-schnell", "wan2.2-i2v-5b"])
            self.assertEqual(not_ready, {})

            # 6. If ComfyUI is unreachable -> empty ready list + HTTP 503 on /aivora/health
            with (
                mock.patch.object(aivora_worker, "WORKFLOW_DIR", WORKFLOWS_DIR),
                mock.patch.object(aivora_worker, "COMFY_MODELS_DIR", models_dir),
                mock.patch.object(aivora_worker, "fetch_comfy_installed_nodes", return_value=None),
            ):
                resp = aivora_worker.health()
                self.assertEqual(resp.status_code, 503)
                body = json.loads(resp.body.decode("utf-8"))
                self.assertFalse(body["ok"])
                self.assertFalse(body["comfy_reachable"])
                self.assertEqual(body["models"], [])

    def test_workflow_rendering_float_durations_wan_alignment_and_t2v_fallback(self) -> None:
        # P0 regression: fractional float duration_sec (e.g. 4.5s from trim/TTS fit) accepted by Pydantic v2
        req = aivora_worker.VideoSubmitRequest(model="wan2.2-i2v-5b", prompt="test", duration_sec=4.5)
        self.assertEqual(req.duration_sec, 4.5)

        # Flux image graph substitution
        flux_tpl, _ = aivora_worker.parse_workflow_json(WORKFLOWS_DIR / "flux-schnell.json")
        assert flux_tpl is not None
        flux_graph = aivora_worker.render_workflow_graph(
            flux_tpl,
            prompt='雨夜书店，"灯还亮着"\n暖光特写',
            negative_prompt="blurry",
            width=1344,
            height=768,
            ref_filename=None,
            duration_sec=0,
            seed=42,
        )
        self.assertEqual(flux_graph["2"]["inputs"]["text"], '雨夜书店，"灯还亮着"\n暖光特写')
        self.assertIs(type(flux_graph["4"]["inputs"]["width"]), int)
        self.assertEqual(flux_graph["4"]["inputs"]["width"], 1344)
        self.assertEqual(flux_graph["4"]["inputs"]["height"], 768)
        self.assertEqual(flux_graph["5"]["inputs"]["seed"], 42)

        # Wan 2.2 resolution (divisible by 32) and frames (4k + 1), including fractional seconds
        self.assertEqual(aivora_worker.resolve_video_dimensions("wan2.2-i2v-5b", "16:9"), (1280, 704))
        self.assertEqual(aivora_worker.resolve_video_dimensions("wan2.2-i2v-5b", "9:16"), (704, 1280))
        for sec in (1, 2.3, 3, 4.5, 5, 8.2):
            frames = aivora_worker.compute_video_num_frames(sec)
            self.assertEqual((frames - 1) % 4, 0)
            self.assertGreaterEqual(frames, 25)
            self.assertLessEqual(frames, 121)

        wan_tpl, _ = aivora_worker.parse_workflow_json(WORKFLOWS_DIR / "wan2.2-i2v-5b.json")
        assert wan_tpl is not None

        # I2V mode keeps LoadImage + start_image link
        i2v_graph = aivora_worker.render_workflow_graph(
            wan_tpl,
            prompt="镜头缓缓推进",
            negative_prompt="jitter",
            width=1280,
            height=704,
            ref_filename="aivora_firstframe_01.png",
            duration_sec=4.5,
            seed=777,
        )
        self.assertEqual(i2v_graph["6"]["inputs"]["image"], "aivora_firstframe_01.png")
        self.assertEqual(i2v_graph["7"]["inputs"]["start_image"], ["6", 0])
        self.assertEqual(i2v_graph["7"]["inputs"]["length"], 109)
        self.assertEqual(i2v_graph["7"]["inputs"]["width"], 1280)
        self.assertEqual(i2v_graph["7"]["inputs"]["height"], 704)

        # T2V fallback strips LoadImage node and start_image cleanly with zero dangling references
        t2v_graph = aivora_worker.render_workflow_graph(
            wan_tpl,
            prompt="暮色天渊断崖",
            negative_prompt="",
            width=1280,
            height=704,
            ref_filename=None,
            duration_sec=3.0,
            seed=888,
        )
        self.assertNotIn("6", t2v_graph)
        self.assertNotIn("start_image", t2v_graph["7"]["inputs"])
        self.assertEqual(t2v_graph["7"]["inputs"]["length"], 73)

    def test_security_and_error_state_transitions(self) -> None:
        # Path traversal in task_id or model_id rejected with 400
        for bad_id in ("../system_stats", "a/b", "..", "id?foo=1"):
            with self.assertRaises(aivora_worker.HTTPException) as ctx:
                aivora_worker.validate_safe_id(bad_id, "task_id")
            self.assertEqual(ctx.exception.status_code, 400)

        # Malformed base64 returns 400 instead of 500
        with self.assertRaises(aivora_worker.HTTPException) as ctx:
            aivora_worker.upload_image_to_comfy("!!!not-base64!!!")
        self.assertEqual(ctx.exception.status_code, 400)

        # Lost task (missing from both /history and /queue) fails cleanly instead of polling forever
        with (
            mock.patch.object(aivora_worker, "fetch_history_entry", return_value=None),
            mock.patch.object(aivora_worker, "detect_queue_state", return_value=None),
        ):
            status = aivora_worker.video_status("lost-task-999")
            self.assertEqual(status["status"], "failed")

        # Completed workflow with zero video output fails cleanly instead of running forever
        with mock.patch.object(
            aivora_worker,
            "fetch_history_entry",
            return_value={"status": {"completed": True, "status_str": "success"}, "outputs": {}},
        ):
            status = aivora_worker.video_status("empty-video-task")
            self.assertEqual(status["status"], "failed")

    def test_find_history_media_prefers_final_mp4_over_vhs_png_sidecar(self) -> None:
        mock_history = {
            "prompt-123": {
                "outputs": {
                    "11": {
                        "gifs": [
                            {"filename": "aivora_wan22_00001.png", "subfolder": "", "type": "output"},
                            {"filename": "aivora_wan22_00001.mp4", "subfolder": "", "type": "output"},
                        ]
                    }
                }
            }
        }
        with mock.patch.object(
            aivora_worker,
            "comfy_request",
            return_value=json.dumps(mock_history).encode("utf-8"),
        ):
            media = aivora_worker.find_history_media("prompt-123", "video")
            self.assertEqual(
                media,
                {"filename": "aivora_wan22_00001.mp4", "subfolder": "", "type": "output"},
            )

    def test_health_endpoint_and_unready_model_rejection(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            models_dir = Path(tmp) / "models"
            models_dir.mkdir(parents=True, exist_ok=True)
            with (
                mock.patch.object(aivora_worker, "WORKFLOW_DIR", WORKFLOWS_DIR),
                mock.patch.object(aivora_worker, "COMFY_MODELS_DIR", models_dir),
                mock.patch.object(
                    aivora_worker,
                    "fetch_comfy_installed_nodes",
                    return_value=ALL_CORE_AND_VHS_NODES,
                ),
            ):
                resp = aivora_worker.health()
                self.assertEqual(resp.status_code, 200)
                res = json.loads(resp.body.decode("utf-8"))
                self.assertTrue(res["ok"])
                self.assertEqual(res["models"], [])
                self.assertIn("flux-schnell", res["not_ready"])
                self.assertIn("wan2.2-i2v-5b", res["not_ready"])

                with self.assertRaises(aivora_worker.HTTPException) as ctx:
                    aivora_worker.submit_video(
                        aivora_worker.VideoSubmitRequest(
                            model="wan2.2-i2v-5b",
                            prompt="test",
                        )
                    )
                self.assertEqual(ctx.exception.status_code, 400)
                self.assertIn("尚未就绪", str(ctx.exception.detail))


if __name__ == "__main__":
    unittest.main()
