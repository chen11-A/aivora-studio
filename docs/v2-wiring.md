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
| **F05 + 崩溃恢复** | `exclusive-file-staging.ts`、`delivery-journal.ts`、`export-pipeline.ts`、`export-segment.ts`、`ffmpeg-presets.ts`、`register-ipc.ts`、`ExportModal.tsx`、`backup-manager.ts`、`f05-a03-a04-safety.test.ts` | 剪辑页单集导出（含审片确认入口，正式 / 试片）、交付页导出 | 目标目录暂存 → 正式导出**先校验当前版本人工审片确认 + 内容/技术双质检，再 `publishFileExclusively`** → `export_delivery_records` | 正式模式强制审片与技术质检不可通过传参跳过；质检拦截黑屏/错误前绝不落盘 `outputPath`；同名引导另存；发布后异常退出重开按 SHA-256 核验 | 故障注入：单集未审拦截、中文空格同路径、黑屏/坏轨拦截零落盘、并发争用、取消、发布后崩溃恢复；原 MP4 SHA-256 不变 |
| **QA / A03 / A04 / C01 / C02** | `src/shared/studio-truth.ts`、`ExportModal.tsx`、`StudioShell.tsx`、`ProjectHome.tsx`、`register-ipc.ts`、`scripts/layout-audit.mjs`、`f05-a03-a04-safety.test.ts` | 作品库导入 ZIP、拆镜弹窗、导出质检弹窗 | `qc_reports` 快照指纹、备份清单（明示不含外部成片） | 坏/截断 ZIP 作品库原地显示中文原因与重试且清临时目录；取消与失败分开；通知不压主按钮；报告底栏固定 | 真实点击、坏 ZIP、长质检滚动、换素材后旧报告立即标「上次导出（已过期）」 |
| **迁移 + F06–F10 + F15** | `project-store.ts`（只读扫描）、`schema.ts` + `schema-v2-migration.ts`（**先备份后 DDL**）、`production-contracts.ts`、`production-sheets.ts`、`continuity-supervisor.ts`、`stage-coordinator.ts`、`live-preprod-gate.ts`、`plan-builder.ts`、`qilin-live-generation-wiring.test.ts`、`qilin-v2-paper-loop.test.ts` | 真实生图/视频主入口（`plan-builder` 实时门禁与场记连戏注入）；`shootable-screenplay` 底层契约待 v2.1 开放独立面板 | `.backups/` 滚动 3 份 `VACUUM INTO`；项目/集/场三层快照、镜头七组字段、`scene_continuity_states` | 扫描作品库绝不触发 DDL；备份校验不过不进迁移；未审 Animatic 在门禁开启时拦截生视频；跨场重置在场人 | 旧库先备份再迁移；真实 `GenerationJobQueue` 断言发给模型的 HTTP body 含场记、左右映射、前镜末态且零误加父声口型 |
| **F16 + 三态恢复** | `budget-ledger.ts`、`budget-pricing.ts`、`paid-bgm-service.ts`、`register-budget-ipc.ts`、`ProjectBudgetSection.tsx`、`JobDrawer.tsx`、`f16-budget-ledger.test.ts` | 模型中心作品预算上限设置 + 任务抽屉账本条与中断三态恢复 + 全付费入口收口 | `budget_policies`、`budget_ledger`、`jobs`（单 `BEGIN IMMEDIATE` 原子预扣+建任务；全表未决检索） | 有远端号只查单；无号 `UNKNOWN` 冻结禁重发；未发包零漂移可安全续跑；视频按模型+分辨率分档估价；未拿实付标 `settled_estimated` | 模拟 A/B/C 重启崩溃、双窗口并发、Lyria 预算拦截与预算上限拦截回归 |
| **F11 / F12 音视频底层** | `font-locator.ts`、`filter-path.ts`、`segment-cache.ts`、`transition-composer.ts`、`export-segment.ts`、`export-pipeline.ts`、`audio-contract.ts`、`audio-normalize.ts`、`f11-f12-media-engine.test.ts` | 剪辑与多集导出引擎内置能力（局部转场零漂移作底层修复，不作独立新卖点） | 随包中文字体（双层转义支持单引号/冒号/空格/中文）、对白交集人声闪避、`-16±1 LUFS / ≤-1.0 dBTP` | `dip_to_black` 原地淡出淡入零音画漂移且自动豁免黑屏误报；AAC 解码复测超限 `-c:v copy` 有界重修 | 3 镜混合转场声画偏移 ≤0.08s、`O'Brien:测试 字体` libass 加载通过、113s BGM 解码达标 |
| **F13** | `external-pack-provenance.ts`、`external-pack.ts`、`ExternalWorkflowModal.tsx`、`external-pack.test.ts` | 分镜外采包导出、下载扫描、回流防替换入库 | `pack-manifest.json` + 扫描期 `expectedSha256` 绑定 + 私有目录暂存校验 | 扫描读取 `pack-manifest`；重排/跨项目入 `manual_review`；提交经私有拷贝单次验签后探测与入库，阻断 TOCTOU A→B 替换 | A→B 替换拦截、重排 `manual_review`、同名/重复下载/迟到不完整文件零误覆盖 |
| **F14 + 正式交付真相** | `content-qc.ts`、`export-qc.ts`、`delivery-journal.ts`、`project-reader.ts`、`studio-truth.ts`、`f05-a03-a04-safety.test.ts` | 剪辑正式导出前自动阻断 + 打开工程自动对账 + 第五页内容质检复查 | `qc_reports` + `export_delivery_records` + `episode_review_signoffs`（绑定完整快照指纹与文件 SHA-256） | 未审、改剪点或中途退出立即退出「已正式交付」；打开工程自动把中断 `publishing` 归位为 `published` 或 `aborted` | 确定性内容+技术双质检前置阻断零污染目标文件，重启对账恢复与修改失效回归 |
| **M01–M04 预检** | `provider-preflight.ts`、`live-preprod-gate.ts`、`plan-builder.ts`、`m01-m04-contracts.test.ts`、`qilin-live-generation-wiring.test.ts` | 真实生视频入口请求前参数校验 | 官方参数契约 + 请求体快照（零密钥泄漏） | 以最终参考图/时长参数校验，不支持提前中文拦截且零网络请求，绝不静默丢图 | 断言拦截请求体与 0 网络调用：Omni 2s/11s/双参考/7 图零外发；合规放行 |
| **第 5 页多集交付** | `src/shared/types/delivery.ts`、`register-delivery-ipc.ts`、`multi-episode-exporter.ts`、`useDeliveryStore.ts`、`DeliveryStage.tsx`、`DeliveryDrawer.tsx` | ≥2 集按需开放「5 交付」：勾选与排序分集、按序合片导出、断点续跑与 F14 内容质检/审片确认 | `multi_episode_export_queues` + `export_delivery_records`（SQLite 持久化队列、模式、质检标记与产物 SHA-256） | 续跑严格核验同版本 + 同导出模式 + 合格正式质检记录 + SHA-256（旧试片绝不被正式任务复用）；10 集第 3 集失败重启已完 9 集零重渲 | Electron 真窗口勾选+重排 10 集第 3 集失败重启续跑合片 + 试片升级正式绝不复用回归通过 |

## 二、移出 v2.0.0 范围的 8 项扩展（v2.1 延后区，不纳入 2.0 承诺）

以下模块仅保留底层纯逻辑与自动化回归供 v2.1 实测后开放，**不在 v2.0.0 开放前端入口或对外宣称支持**：
1. `minimax-video-adapter.ts`（MiniMax / 海螺异步视频供应商 — 待真实付费账号实测提交与查单后开放）；
2. `finishing-pack.ts`（标准精剪素材包 — 待至少一款目标剪辑器完成导入→修改→保存→重开实测后开放）；
3. `contact-sheet.ts`（帧缩略图接触表）；
4. 局部转场缓存作为独立新卖点（剪辑页既有转场的零音画漂移仅作为底层稳定性修复默默保留）；
5. `creative-presets.ts`（同场宫格生成）；
6. `creative-presets.ts`（角色三视图生成）；
7. `creative-presets.ts`（双档升格生成）；
8. `skill-md-registry.ts`（外部 `SKILL.md` 模板导入管理面板）及 `shootable-screenplay.ts` / `production-sheets.ts` 独立工作区面板。

## 三、推进与审计闭环（单主线 `main`）

1. **第 1–4 批基线落地**：完成 DB1/DB2、核心媒体与多集底座（`f3e065e`）。
2. **发版前全量审计闭环（6+1 核心真接通 + 8 项诚实裁剪 + 跨会话底盘加固）**：
   - 预算策略 UI/IPC + 全付费入口（含 Lyria）收口 + 模型/分辨率分档估价 + `settled_estimated` + `JobDrawer` 三态中断恢复；
   - 外采回流 TOCTOU 私有拷贝防替换 + `pack-manifest` 扫描接通；
   - 正式导出先内容+技术双质检后流式排他落盘 + `openProject` 自动对账 `export_delivery_records` 绑定「已正式交付」真相；
   - 只读扫描/只读备份校验 + 先备份后 DDL + 嵌套 `assets/` 递归归档与动态重绑 + ZIP 炸弹流式限流 + FFmpeg 双层字体路径转义 + 零循环依赖；
   - 原四页实时场记连戏与前期门禁 + `provider-preflight` 接通真实生成入口；
   - 第五页收口聚焦多集勾选/排序/第 3 集失败重启续跑/按序合片，将未真机验证的 8 项扩展彻底移出 v2.0.0 承诺。
