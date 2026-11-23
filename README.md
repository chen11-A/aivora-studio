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

- **阶段 1（已完成工程底座与全新界面）**：作品首页、固定顶栏四阶段界面、本地 SQLite + 中文空格路径 + ZIP 备份、`aivora-media://` 206 Range 协议、自动化单测与几何审计、Windows NSIS CI 实测。
- **阶段 2**：双通道模型中心（ChatGPT / Grok OAuth、可灵 Kling 官方视频 API、OpenAI 兼容自定义厂家）、导演拆镜技能提案、防重复扣费任务队列。
- **阶段 3**：完整四阶段联调、HTML5 `<video>` 代理连播、FFmpeg 真成片导出（`-16 LUFS` 响度统一 + 字幕烧录 + 写盘防关窗保护）。
- **阶段 4**：全链路验收与 v1.0 正式安装包交付。
