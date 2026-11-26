# AIVORA Studio v2.0.0 接线总表（`chen11-A/aivora-studio`）

- **基线**：`v1.9.3`（`bf5a45d9c1de898798324fd0b9901e652c215322`），单主线 `main` 小步直推，每笔提交聚焦 1–2 个相邻工单且可独立 `git revert`。
- **架构边界**：`Electron 36 + TypeScript + node:sqlite + FFmpeg 8.1`，零 Python/C++ 原生业务依赖；所有 `src/**/*.{ts,tsx}` 严格 ≤ 500 行；不引入本地 MCP 端口或外部 CLI 编排器。
- **统一派生真相**：`src/shared/studio-truth.ts` 从 SQLite + 本地素材快照派生四维状态（创作审批 / 远端任务 / 素材版本 / 交付资格与报告新鲜度），剪辑与交付共用。

## 一、工单接线矩阵

| 工单 | 源码文件（含 ≤500 行拆分）与回归测试 | 用户入口 | 读写对象与版本指纹 | 异常 / 取消 / 重开恢复 | 验收标准 |
| :--- | :--- | :--- | :--- | :--- | :--- |
| **DB1** | `src/main/storage/sqlite-driver.ts`；新增 `sqlite-driver.busy-tx.test.ts` | 全应用所有写入事务 | SQLite `BEGIN IMMEDIATE` / `COMMIT` / `ROLLBACK` 状态位 | `BEGIN` 失败不置 `inTransaction`；提交/回滚异常清理标记且不盖过主错误 | 双连接持锁：`BEGIN` 失败未进回调；释放后第二次事务报错数据完整回滚 |
| **DB2** | `src/main/storage/exclusive-file-staging.ts`、`project-store.ts`、`demo-seed.ts`；新增 `exclusive-file-staging.test.ts` | 新建作品、建资产、采纳提案 | `assets/*.svg`（`wx` 独占创建记录）+ `assets`/`takes` 表引用计数 | 事务失败只删本次独占且无其他引用的新文件；绝不删并发/历史共享 SVG | 注入采纳失败：资产/镜头/撤销全回滚、新 SVG 零残留、旧共享 SVG 完整 |
| **F01** | 拆分 `director-apply.ts` → `director-apply-proposal.ts` + `director-undo-service.ts`、`director-service.ts`、`story-pipeline-actions.ts`；新增 `director-f01-f02.test.ts` | 剧本页「AI 拆镜」→ 提案弹窗「采纳提案」 | `episodes.script_text` 的 `scriptSha256`、`proposalId`、依赖哈希、`director_undo_snapshots` | 采纳前强制落盘等回执；事务内重读核验 SHA-256；旧提案只预览/重算；双击幂等 | 改末句/改空白/错集/改回原文依赖变/保存失败/双击并发均拒写且磁盘/库不变 |
| **F02** | `src/shared/shot-matcher.ts`、`director-apply-proposal.ts`、`schema.ts`（`archived_takes`）；`director-f01-f02.test.ts` | 剧本重拆镜预览与增量采纳 | `scenes.anchor_id`、`shots.source_anchor_id` / `source_span_json`、`archived_takes` | 仅按稳定 ID 或唯一可验源锚点一对一匹配；失效/多义不转移旧 Take；移除镜进归档可撤销 | 中间插入、同名场、两场同标题/动作/台词重排：ID、采用视频、手修字幕与裁点零互换 |
| **F03** | `src/main/providers/ref-image-injector.ts`、`src/main/providers/f03-f04-guards.test.ts`、`ref-image-injector.test.ts` | 单镜/批量生图与生视频计划准备 | 仅读本镜可见角色 ID、场次 `location_asset_id`、可见道具、显式首/尾帧 | 去掉全局兜底与台词/说话人子串捞图；缺必需锁定参考直接拦截并定位资产卡 | 断言实际请求体：空景、同名地点、院外父声未入画、仅提及「登天台」零误附演员/地点图 |
| **F04** | `openai-compat-adapter.ts`、`model-registry.ts`、`gemini-video-adapter.ts`、`gemini-official-adapter.ts`、`shot-mutations.ts`、`job-queue.ts`、`ConfirmJobModal.tsx`、`f03-f04-guards.test.ts` | 单镜、批量、重试、外采导入 | `takes`（新回片一律 `is_selected=0` 候选）、`shots.selected_*_take_id`（只读保护） | `images/edits` 失败禁退回无图生图；校验魔数 MIME 与引用顺序；拦截退役模型；晚到回片不冲定稿 | 验证 `/images/edits` 404 不发 `/images/generations`、生图回片不清空 `selected_video_take_id` |
| **F05** | `exclusive-file-staging.ts`、`export-pipeline.ts`、`export-segment.ts`、`register-ipc.ts`、`backup-manager.ts`、`f05-a03-a04-safety.test.ts`、`export-pipeline.test.ts` | 剪辑页导出（正式 / 试片）、交付页导出 | 目标目录唯一暂存名 → `fs.link` 排他发布 → `unlink` 暂存；区分有意静帧与占位画板 | 同名先引导另存；争用/跨盘/不支持硬链接明确报错保原 MP4；已发布不误报已取消 | 故障注入：中文空格同路径、已存在/并发争用/不支持 FS/取消/晚期发布失败；原 MP4 SHA-256 不变 |
| **QA / A03 / A04 / C01 / C02** | `src/shared/studio-truth.ts`、`ExportModal.tsx`、`StudioShell.tsx`、`ProjectHome.tsx`、`register-ipc.ts`、`scripts/layout-audit.mjs`、`f05-a03-a04-safety.test.ts` | 作品库导入 ZIP、拆镜弹窗、导出质检弹窗 | `qc_reports` 快照指纹、备份清单（明示不含外部成片） | 坏/截断 ZIP 作品库原地显示中文原因与重试且清临时目录；取消与失败分开；通知不压主按钮；报告底栏固定 | 真实点击、坏 ZIP、长质检滚动、换素材后旧报告立即标「上次导出（已过期）」 |
| **迁移 + F06–F10 + F15** | `production-contracts.ts`、`schema-v2-migration.ts`、`shootable-screenplay.ts`、`production-sheets.ts`、`continuity-supervisor.ts`、`stage-coordinator.ts`、`schema-v2-migration.test.ts`、`qilin-v2-paper-loop.test.ts` | 1 剧本（可拍稿/因果分场）、2 角色场景（空间/场记）、3 分镜（Animatic 临时读词） | `.backups/` 滚动 3 份 `VACUUM INTO`；项目/集/场三层快照、镜头七组字段、`scene_continuity_states` | 备份校验不过不进迁移；旧工程零伪造审批；跨场重置地点/在场人仅继承合理物件/伤势；不加 Agent 菜单 | 旧库备份→迁移→失败回滚重开；《天渊麒麟录》两场 + 现代对照纸面闭环（0 付费 API） |
| **F16** | `src/main/jobs/budget-ledger.ts`、`plan-builder.ts`、`job-queue.ts`、`job-persistence.ts`、`f16-budget-ledger.test.ts` | 所有付费生成（含生图/视频/TTS/Lyria/可选视觉 QC）与任务抽屉 | `budget_policies`、`budget_ledger`、`jobs`（全表未决检索，废除 `LIMIT 50` 限制） | 先原子校验预算与未决项并落盘再发请求；A 候选不重做、B 有 ID 仅查单/无 ID 禁重付、C 零漂移才恢复 | 模拟 A/B/C 重启崩溃、双窗口并发确认只发 1 次、未知超出 50 条窗口仍拦截、B 双 ID 场景 |
| **F11（含 Editroom 增强）** | `font-locator.ts`、`contact-sheet.ts`、`segment-cache.ts`、`transition-composer.ts`、`TrimmedShotVideo.tsx`、`resources/fonts/NotoSansCJK-Regular.ttc`、`f11-f12-media-engine.test.ts` | 3 分镜（默认播采用段/看原素材/ContactSheet 锚点）、4 剪辑（原地换版/转场/混画幅 Reframe） | `shots.trim_*` / `transition_*` / `reframe_*`、单镜与局部转场缓存、随包 `resources/fonts/`（SIL OFL） | 换版先写候选可撤销；时间顺移不标后续内容重审；改 1 镜仅失效受影响段；短片不足提示受影响台词 | 8s 裁 3s 时序实测、局部叠化缓存复用、BT.709/帧率规范化、随包中文字体英文环境渲染 |
| **F12（含 Editroom 波形闪避）** | `src/main/media/audio-contract.ts`、`f11-f12-media-engine.test.ts` | 分镜声音合同选择、剪辑四层混音与响度导出 | `native_audio / silent_tts / env_plus_tts`、对白/环境/SFX/BGM 轨、实测人声窗 | 真实人声窗（合并 `<0.35s` 气口）闪避；AAC 解码后复测 `-16±1 LUFS` / `≤-1.0 dBTP`，超限有界纯音轨重修 + `-c:v copy` | 113s 纯 BGM 终版解码达标、全静音单列不适用、两路对白不重叠、长片声画同步 |
| **F13** | `src/main/media/external-pack-provenance.ts`、`src/main/media/f13-f17-productivity.test.ts` | 分镜外采包导出、下载监听、回流核对 | `pack-manifest.json`（`project/episode/shotId` + `planRevisionSha256`）与四态证据 | 重排后旧 `03.mp4` / 同名 / 缺版本一律入待人工核对，绝不自动入新镜或覆盖定稿 | 同名项目、重排、重复下载、迟到/不完整文件测试，零额外费用 |
| **F14** | `src/main/media/content-qc.ts`、`export-qc.ts`、`studio-truth.ts`、`f14-multi-episode-f18.test.ts` | 剪辑/交付质检报告、问题定位跳转 | `qc_reports`（绑定集序/画幅/Take 哈希/裁点/字幕/音轨/文件完整快照） | 任一输入变化旧报告变「上次导出（已过期）」；可选视觉抽检走 F16 且仅出疑点不自动批准 | 确定性内容规则 + 技术扫描（黑屏/分类静帧/静音/响度/字幕重叠折行安全区）双过才可交付 |
| **增效（宫格/双档/三视图）** | `src/main/media/creative-presets.ts`、`src/main/media/f13-f17-productivity.test.ts` | 角色页三视图、分镜页同场宫格与双档升格 | 候选图/裁切候选与显式授权记录 | 宫格先验格→镜映射与切线，错格保原图；双档仅在存在第二实配路由时露出；三视图不覆盖已锁 | 重排与部分接受宫格、升格重授权不覆盖旧定稿、单角度重来保留已锁参考 |
| **M01–M04** | `src/main/providers/provider-preflight.ts`、`minimax-video-adapter.ts`、`model-registry.ts`、`m01-m04-contracts.test.ts` | 模型中心、单镜/批量参数预检、外采模式 | 官方参数契约 + 请求体快照（零密钥泄漏） | Seedance `content[].role` 互斥拦截与首尾 `ratio: adaptive`；Omni 1.2 边界零请求拦截；MiniMax 7 天查单提示；未实测能力默认关闭 | 断言拦截请求体与 0 网络调用：Omni 11s 首尾 / 12s 双参考视频 / 7 图；10s 首尾 & 15s 单图放行 |
| **F17** | `src/main/skills/skill-md-registry.ts`、`src/main/media/f13-f17-productivity.test.ts` | 设置 → 技能模板查看/导入/编辑/预览/恢复默认 | `SKILL.md` 纯文本注册表版本与 SHA-256（≤24KB） | 限制体积与白名单 schema；拦截脚本、外链、越权工具指令与绕过计费，仅出可撤销提案 | 恶意注入、伪造工具调用、畸形超限文件拦截与恢复内置默认回归 |
| **第 5 页交付 + F18** | `multi-episode-exporter.ts`、`finishing-pack.ts`、`useDeliveryStore.ts`、`DeliveryStage.tsx`、`StudioShell.tsx`、`EditorStage.tsx`、`f14-multi-episode-f18.test.ts` | 顶栏收敛去导出大按钮；≥2 集且续跑验收通过后出现「5 交付」；剪辑与交付共用精剪包入口 | `multi_episode_export_queues`、精剪包（视频 + 4 路 WAV + SRT + 有理帧率 EDL/JSON + 许可） | 10 集第 3 集失败重启：已验分集零重渲，修复后仅重导第 3 集并重组；跳转修镜原位返回保持集序/滚动/过滤/播放头 | 十集失败重启实测、问题原位往返、精剪包结构与零凭据校验、目标剪辑器实测记录 |

## 二、五批推进节奏（单主线 `main`）

1. **第 1 批（止血）**：`v2-wiring.md` → `DB1 + DB2` → `F01 + F02` → `F03 + F04` → `F05 + A03/A04/C01/C02 + 备份校验`。
2. **第 2 批（前期可拍）**：`schema-v2-migration + F06–F10 + F15` + 纸面闭环回归。
3. **第 3 批（可恢复制作与交付）**：`F16` → `F11 + F12 + F14`（含 Editroom 四项增强 + 随包字体）→ 多集续跑引擎 → 第 5 页「交付」+ `F18` 标准精剪包。
4. **第 4 批（增效与拓展）**：宫格 / 双档 / 三视图 → `F13` → `M01–M04` → `F17` 纯文本技能。
5. **第 5 批（验收与发布门槛）**：`ci-release.yml` 门禁收敛、全量命令与 Electron 真窗口多分辨率点击、双平台候选包 SHA-256 核验与交接报告。
