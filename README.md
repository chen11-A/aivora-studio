# AIVORA Studio

> 面向漫剧与短剧创作者的本地优先桌面工作台（Electron + TypeScript + React 19 + SQLite + FFmpeg）。

## 设计原则

- **固定外框、画面为王**：固定 `48px` 顶栏（作品库 · 四阶段胶囊 · 模型中心 · 导出成片）+ `28px` 底栏，1280×800 笔记本屏零遮挡、零嵌套双滚动条。
- **零丢稿与本地优先**：单作品独立文件夹 + `node:sqlite`（WAL + 显式事务）+ 切集前同步 flush + `VACUUM INTO` 一致性 ZIP 备份。
- **安全边界**：凭据强制走系统加密库（Windows DPAPI / macOS Keychain），拒绝明文 `basic_text` 降级；`aivora-media://` 严格限定目录并完整支持 HTTP `206 Range` 流式拖拽播放。
- **双通道模型与防重复扣费**：支持网页会员账号 OAuth（ChatGPT / Grok）与任意自定义 API 自由混搭；生成前显式确认并锁定配置快照，网络未知状态严禁静默重发。

## 开发命令

```bash
pnpm install
pnpm dev          # 启动桌面开发环境
pnpm typecheck    # TypeScript 严格检查（node + web）
pnpm lint         # ESLint 检查（含单文件 <= 500 行门禁）
pnpm test         # Vitest 单元测试
pnpm build        # 编译 main / preload / renderer
pnpm audit:layout # Chrome 1280x800 / 1920x1080 几何与视觉审计
pnpm build:win    # 构建 Windows x64 NSIS 安装包
```

## 阶段规划

- **阶段 1（已完成）**：作品首页、固定顶栏四阶段界面、本地 SQLite + 中文空格路径 + ZIP 备份、`aivora-media://` 206 Range 协议、自动化单测与几何审计、Windows NSIS CI 实测。
- **阶段 2（已完成，选 A 主线）**：角色页详情/定妆/声线检视器、剪辑页单一导出与成片就绪检查、本地视频/图片/配音/BGM 导入、真实时间轴连播引擎（`<video>` + 播放头推进 + 切版本即时生效）、移植自 `aivora-media` 的真 FFmpeg 成片导出（字幕烧录 + 两遍 `-16 LUFS` 响度统一 + 写盘防关窗保护）。
- **阶段 3（已完成）**：双通道模型中心（ChatGPT PKCE / Grok OAuth 登录、可灵 Kling 官方视频 API HS256 JWT + 立即拉回 MP4、OpenAI 兼容自定义厂家与测试连接）、导演拆镜提案与一键撤销、角色锁定参考图自动注入、防重复扣费任务队列（确认锁快照、`UNKNOWN` 阻断自动重发、GET-only 查单找回、失败不覆盖已选版本）。
- **阶段 4（已完成 · v1.0.0 正式交付）**：内置 SHA-256 校验 Windows FFmpeg 8.1.2、非管理员 HKCU 静默安装 + 覆盖升级无损读回 + ZIP 备份恢复 + 中文名 MP4 导出全链路回归，以及 [用户上手指南](docs/用户上手指南.md)。
