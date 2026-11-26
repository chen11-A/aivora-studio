# AIVORA Studio v2.0.0 接线总表（`chen11-A/aivora-studio`）

- **基线**：`v1.9.3`（`bf5a45d9c1de898798324fd0b9901e652c215322`），单主线 `main` 小步直推，每笔提交聚焦 1–2 个相邻工单且可独立 `git revert`。
- **架构边界**：`Electron 36 + TypeScript + node:sqlite + FFmpeg 8.1`，零 Python/C++ 原生业务依赖；所有 `src/**/*.{ts,tsx}` 严格 ≤ 500 行；不引入本地 MCP 端口或外部 CLI 编排器。
- **统一派生真相**：`src/shared/studio-truth.ts` 从 SQLite + 本地素材快照派生四维状态（创作审批 / 远端任务 / 素材版本 / 交付资格与报告新鲜度），剪辑与交付共用。

## 一、工单接线矩阵

| 工单 | 源码文件（含 ≤500 行拆分）与回归测试 | 用户入口 | 读写对象与版本指纹 | 异常 / 取消 / 重开恢复 | 验收标准 |
| :--- | :--- | :--- | :--- | :--- | :--- |
| **DB1** | `src/main/storage/sqlite-driver.ts`；`sqlite-driver.busy-tx.test.ts` | 全应用所有写入事务 | SQLite `BEGIN IMMEDIATE` / `SAVEPOINT` / `COMMIT` / `ROLLBACK` | `BEGIN` 失败不置 `inTransaction`；嵌套事务走独立 `SAVEPOINT`；提交/回滚异常清理标记且不盖过主错误 | 双连接持锁：`BEGIN` 失败未进回调；嵌套回滚不污染外层；释放后二次事务报错数据完整回滚 |
| **DB2** | `src/main/storage/exclusive-file-staging.ts`、`project-store.ts`、`demo-seed.ts`；`exclusive-file-staging.test.ts` | 新建作品、建资产、采纳提案、成片发布 | `assets/*.svg`（`wx` 独占创建记录）+ 分块流式 `publishFileExclusively` | 事务失败只删本次独占且无其他引用的新文件；1MB 流式拷贝避开 2GB Buffer 上限 | 注入采纳失败：资产/镜头/撤销全回滚、新 SVG 零残留、旧共享 SVG 完整 |
| **F01** | `director-apply-proposal.ts`、`director-undo-service.ts`、`director-service.ts`、`story-pipeline-actions.ts`；`director-f01-f02.test.ts` | 剧本页「AI 拆镜」→ 提案弹窗「采纳提案」 | `episodes.script_text` 的 `scriptSha256`、`proposalId`、依赖哈希、`director_undo_snapshots` | 采纳前强制落盘等回执；事务内重读核验 SHA-256；旧提案只预览/重算；双击幂等 | 改末句/改空白/错集/改回原文依赖变/保存失败/双击并发均拒写且磁盘/库不变 |
| **F02** | `src/shared/shot-matcher.ts`、`director-apply-proposal.ts`、`schema.ts`（`archived_takes`）；`director-f01-f02.test.ts` | 剧本重拆镜预览与增量采纳 | `scenes.anchor_id`、`shots.source_anchor_id` / `source_span_json`、`archived_takes` | 仅按稳定 ID 或唯一可验源锚点一对一匹配；失效/多义不转移旧 Take；移除镜进归档可撤销 | 中间插入、同名场、两场同标题/动作/台词重排：ID、采用视频、手修字幕与裁点零互换 |
| **F03** | `src/main/providers/ref-image-injector.ts`、`src/main/providers/f03-f04-guards.test.ts`、`ref-image-injector.test.ts` | 单镜/批量生图与生视频计划准备 | 仅读本镜可见角色 ID、场次 `location_asset_id`、可见道具、显式首/尾帧 | 去掉全局兜底与台词/说话人子串捞图；缺必需锁定参考直接拦截并定位资产卡 | 断言实际请求体：空景、同名地点、院外父声未入画、仅提及「登天台」零误附演员/地点图 |
| **F04** | `openai-compat-adapter.ts`、`model-registry.ts`、`gemini-http.ts`、`gemini-video-adapter.ts`、`gemini-official-adapter.ts`、`shot-mutations.ts`、`job-queue.ts`、`ConfirmJobModal.tsx`、`f03-f04-guards.test.ts` | 单镜、批量、重试、外采导入 | `takes`（新回片一律 `is_selected=0` 候选）、`shots.selected_*_take_id`（只读保护） | `images/edits` 失败禁退回无图生图；校验魔数 MIME 与引用顺序；拦截退役模型；晚到回片不冲定稿 | 验证 `/images/edits` 404 不发 `/images/generations`、生图回片不清空 `selected_video_take_id` |
| **F05 + 崩溃恢复** | `exclusive-file-staging.ts`、`delivery-journal.ts`、`export-pipeline.ts`、`export-segment.ts`、`ffmpeg-presets.ts`、`register-ipc.ts`、`backup-manager.ts`、`f05-a03-a04-safety.test.ts` | 剪辑页导出（正式 / 试片）、交付页导出 | 目标目录暂存 → 正式导出**先内容+技术双质检再 `publishFileExclusively`** → `export_delivery_records` | 质检拦截黑屏/错误前绝不落盘 `outputPath`；同名引导另存；发布后异常退出重开可按 SHA-256 核验 | 故障注入：中文空格同路径、黑屏/坏轨拦截零落盘、并发争用、取消、发布后崩溃恢复；原 MP4 SHA-256 不变 |
| **QA / A03 / A04 / C01 / C02** | `src/shared/studio-truth.ts`、`ExportModal.tsx`、`StudioShell.tsx`、`ProjectHome.tsx`、`register-ipc.ts`、`scripts/layout-audit.mjs`、`f05-a03-a04-safety.test.ts` | 作品库导入 ZIP、拆镜弹窗、导出质检弹窗 | `qc_reports` 快照指纹、备份清单（明示不含外部成片） | 坏/截断 ZIP 作品库原地显示中文原因与重试且清临时目录；取消与失败分开；通知不压主按钮；报告底栏固定 | 真实点击、坏 ZIP、长质检滚动、换素材后旧报告立即标「上次导出（已过期）」 |
| **迁移 + F06–F10 + F15** | `project-store.ts`（只读扫描）、`schema.ts` + `schema-v2-migration.ts`（**先备份后 DDL**）、`production-contracts.ts`、`production-sheets.ts`、`continuity-supervisor.ts`、`stage-coordinator.ts`、`live-preprod-gate.ts`、`plan-builder.ts`、`qilin-live-generation-wiring.test.ts`、`qilin-v2-paper-loop.test.ts` | 真实生图/视频主入口（`plan-builder` 实时门禁与场记连戏注入）；`shootable-screenplay` 底层契约待 v2.1 开放独立面板 | `.backups/` 滚动 3 份 `VACUUM INTO`；项目/集/场三层快照、镜头七组字段、`scene_continuity_states` | 扫描作品库绝不触发 DDL；备份校验不过不进迁移；未审 Animatic 在门禁开启时拦截生视频；跨场重置在场人 | 旧库先备份再迁移；真实 `GenerationJobQueue` 断言发给模型的 HTTP body 含场记、左右映射、前镜末态且零误加父声口型 |
| **F16** | `budget-ledger.ts`、`budget-pricing.ts`、`paid-bgm-service.ts`、`plan-builder.ts`、`job-queue.ts`、`job-persistence.ts`、`register-external-ipc.ts`、`f16-budget-ledger.test.ts` | 所有付费生成（生图/视频/TTS/Lyria AI 配乐统一收口）与任务抽屉 | `budget_policies`、`budget_ledger`、`jobs`（单 `BEGIN IMMEDIATE` 原子预扣+建任务；全表未决检索） | 视频按模型+分辨率分档估价；未拿实付标 `settled_estimated`；发包后断网/本地保存失败落 `UNKNOWN`/`unknown_hold`；重启同步对账 | 模拟 A/B/C 重启崩溃、双窗口并发确认、Lyria 预算拦截与保存失败保留 `unknown_hold` |
| **F11（含 Editroom 增强）** | `font-locator.ts`、`contact-sheet.ts`、`segment-cache.ts`、`transition-composer.ts`、`export-segment.ts`、`ffmpeg-presets.ts`、`TrimmedShotVideo.tsx`、`resources/fonts/NotoSansCJK-Regular.ttc`、`f11-f12-media-engine.test.ts` | 3 分镜、4 剪辑、5 交付（带时间戳 ContactSheet 抽帧网格） | `shots.trim_*` / `transition_*` / `reframe_*`、单镜内容哈希缓存、`media_visual_notes`、随包中文字体 | `dip_to_black` 原地淡出淡入零音画漂移且自动豁免黑屏误报；`dissolve` 视音频同长叠化；改 1 镜仅失效受影响段 | 3 镜混合转场声画偏移 ≤0.08s、黑屏质检 0 误报、二次导出缓存命中 `[true, true, false]`、ContactSheet 烧录时间戳 |
| **F12（含 Editroom 波形闪避）** | `audio-contract.ts`、`export-segment.ts`、`export-pipeline.ts`、`audio-normalize.ts`、`f11-f12-media-engine.test.ts` | 分镜声音合同选择、剪辑四层混音与响度导出 | `native_audio / silent_tts / env_plus_tts`、对白区间交集实测人声窗 | 实测人声窗与 `dialogueIntervals` 取交集，避免无对白空镜误闪避；AAC 解码后 `-16±1 LUFS` / `≤-1.0 dBTP` 有界 `-c:v copy` 重修 | 113s 纯 BGM 终版解码达标、全静音单列不适用、两路对白不重叠、长片声画同步 |
| **F13** | `external-pack-provenance.ts`、`external-pack.ts`、`ExternalWorkflowModal.tsx`、`external-pack.test.ts`、`f13-f17-productivity.test.ts` | 分镜外采包导出、下载扫描、回流防替换入库 | `pack-manifest.json` + 扫描期 `expectedSha256` 绑定 + 私有目录暂存校验 | 扫描读取 `pack-manifest`；重排/跨项目入 `manual_review`；提交经私有拷贝单次验签后探测与入库，阻断 TOCTOU A→B 替换 | A→B 替换拦截、重排 `manual_review`、同名/重复下载/迟到不完整文件零误覆盖 |
| **F14** | `content-qc.ts`、`export-qc.ts`、`register-delivery-ipc.ts`、`DeliveryDrawer.tsx`、`studio-truth.ts`、`f14-multi-episode-f18.test.ts` | 剪辑正式导出前自动阻断 + 第五页侧栏「立即复查内容质检」 | `qc_reports`（绑定完整内容与导出指纹） | 任一输入变化旧报告变「上次导出（已过期）」；正式导出在落盘前执行内容+技术双质检 | 确定性内容规则 + 技术扫描（黑屏/静帧/静音/响度/字幕折行重叠）双过才可交付 |
| **M01–M04** | `provider-preflight.ts`、`live-preprod-gate.ts`、`plan-builder.ts`、`model-registry.ts`、`m01-m04-contracts.test.ts`、`qilin-live-generation-wiring.test.ts` | 真实生视频入口实时预检；MiniMax 异步适配器待真机实测后于 v2.1 开放 | 官方参数契约 + 请求体快照（零密钥泄漏） | Seedance `content[].role` 互斥与 Omni 1.2 时长/参考边界在主生成入口零请求拦截；未实测能力默认关闭 | 断言拦截请求体与 0 网络调用：Omni 2s/11s/双参考/7 图零外发；合规放行 |
| **第 5 页交付 + F18** | `src/shared/types/delivery.ts`、`register-delivery-ipc.ts`、`multi-episode-exporter.ts`、`finishing-pack.ts`、`useDeliveryStore.ts`、`DeliveryStage.tsx`、`DeliveryDrawer.tsx`、`f14-multi-episode-f18.test.ts` | ≥2 集按需开放「5 交付」：真实按钮驱动多集导出/按序合片/断点续跑、F14 复查、F18 精剪包、ContactSheet | `multi_episode_export_queues`、精剪包（视频 + 4 路 WAV + SRT + 有理帧率 EDL/JSON + `CHECKSUMS.sha256` + `LICENSES.md`） | 10 集第 3 集失败重启后已完 9 集零重渲，修复后仅补第 3 集并按序合片；跳转修镜原位返回 | Electron 真窗口点击 10 集失败重启续跑、F18 精剪包零凭据与校验和实测 |
| **v2.1 延后开放 UI 的底层契约** | `shootable-screenplay.ts`、`creative-presets.ts`、`minimax-video-adapter.ts`、`skill-md-registry.ts`；对应单测已通过 | 本版不对外宣称独立界面功能（见 `docs/release-notes-v2.0.0.md` 声明） | 仅保留已验底层契约与自动化回归 | 不在 UI 放空壳按钮或未实测开关 | 保持模块内聚与回归绿灯，v2.1 按需接通独立面板 |

## 二、推进与审计闭环（单主线 `main`）

1. **第 1–4 批基线落地**：完成 DB1/DB2、F01–F18、Editroom 增强与双平台 CI 门禁（`f3e065e`）。
2. **发版前深度审计闭环（GPT 5 项 + 架构与媒体 9 项 + 零循环依赖）**：
   - 统一 Lyria 配乐预算账本、模型+分辨率分档估价、诚实估算结算与断网/落盘失败 `UNKNOWN` 挂起；
   - 外采回流 TOCTOU 私有拷贝防替换 + `pack-manifest` 扫描接通；
   - 正式导出先内容+技术双质检后流式排他落盘 + `export_delivery_records` 崩溃恢复；
   - `scanProjects` 只读 + 先备份后 DDL + 嵌套 `SAVEPOINT` + 单事务原子预算+任务 + 消除全部模块循环依赖；
   - `dip_to_black`/`dissolve` 零漂移转场与黑屏质检豁免 + ContactSheet 时间戳与 notes 缓存 + 单镜缓存/Reframe/三路声音合同/对白区间限定闪避 + `-1.0 dBTP`；
   - 真实生成入口接通场次协调器、场记连戏注入与 M01–M04 预检；
   - 第五页真实按钮全链打通多集续跑、按序合片、F18 精剪包、F14 复查与 ContactSheet，并收敛发布说明诚实边界。
