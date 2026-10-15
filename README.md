# Chat Wallpaper for Hermes Desktop（壁纸资源管理库 v2.0）

给 [Hermes Agent](https://github.com/NousResearch/hermes-agent) 桌面端加一张**你自己的背景壁纸**：聊天界面透出壁纸，气泡、卡片、蒙版的配色**自动取自壁纸本身的颜色**。

v2.0 起升级为**完整的壁纸资源管理库**：上传、编辑、删除、刷新索引全部在插件界面内闭环完成 —— 不需要手动打开资源管理器建文件夹、复制媒体文件、手写 project.json。

> 本仓库是 [widewind-7/hermes-chat-wallpaper](https://github.com/widewind-7/hermes-chat-wallpaper)（MIT）的迭代版本：保留原版壁纸注入、配色引擎与全部原有能力，新增 Python 后端与 WebUI 管理闭环。

## 功能一览

- 🖼 **自定义背景壁纸**：聊天界面透出壁纸；消息气泡 / 文件卡片 / 全屏蒙版全部取壁纸平均色；亮壁纸自动压暗保证白字可读
- 🎛 **顶栏原生风格设置按钮**（调色板图标）：全屏蒙版 / 消息气泡 / 文件卡片 / 配色深浅 4 个滑块，拖动即时生效、自动保存、重启保持
- 📚 **壁纸资源管理库（界面内闭环）**：
  - **上传壁纸文件**：系统原生文件选择框（jpg / png / mp4 单选）→ 自动建目录、自动缩放生成预览图、自动写标准元数据、自动刷新索引
  - **刷新壁纸索引**：后台异步任务执行（绝不阻塞界面），带防并发锁；实时显示 扫描中 / 完成，统计 扫描项目总数 · 有效壁纸数 · 新增数 · 跳过无效数
  - **编辑壁纸**：修改标题 / 标签，落盘 project.json 后自动刷新索引
  - **删除壁纸**：二次确认后物理删除整个壁纸文件夹（Wallpaper Engine 库内同步消失），自动刷新索引
  - **缩略图自动生成**（增量，已有不重做）；索引与元数据全部临时文件 + 原子替换，杜绝半写损坏
- 🗂 **壁纸库根目录自由配置**：任意自定义目录，或直接指向 **Wallpaper Engine 的 myprojects 原生目录**；「浏览…」系统文件夹选择 + 粘贴路径双通道；路径含 `Program Files` 时给出 Windows 权限警告；配置持久化，索引脚本直接读取
- 🎬 **Wallpaper Engine 兼容**：生成的目录与 project.json 严格遵循 WE 原生规范（title / type / file / preview / tags / description，UTF-8 中文友好），WE 客户端可直接识别；指向 myprojects 时提醒"WE 不会自动刷新，需在软件内手动刷新"
- ↩️ **恢复默认外观**：一键回到应用原生主题，再点「重新启用壁纸」随时切回
- ✅ **新旧共存**：以前手动创建的壁纸目录、旧 project.json 照常识别加载

## 安装

**前置**：Hermes Desktop（应用自带 Python 后端）。图片预览需要 **Pillow**（多数 Hermes 环境已内置，缺失时 `pip install pillow` 即可）。

### 方式一：Git 安装（推荐）

```bash
hermes plugins install https://github.com/<你的用户名>/hermes-chat-wallpaper.git
hermes plugins enable chat-wallpaper
```

然后**重启 Hermes 桌面应用**（挂载后端路由 + 同步桌面 UI 半区）。

### 方式二：手动安装

```bash
git clone https://github.com/<你的用户名>/hermes-chat-wallpaper.git "$HOME/.hermes/plugins/chat-wallpaper"
hermes plugins enable chat-wallpaper
```

重启桌面应用后，桌面 UI 会自动同步到 `desktop-plugins/chat-wallpaper/` 并加载。

> ⚠️ `hermes plugins enable chat-wallpaper` 是**必须的**：它把 `chat-wallpaper` 写入 `config.yaml` 的 `plugins.enabled` 白名单，是 Python 后端被导入的安全前提。缺少它时，壁纸库会提示"后端未就绪"，上传 / 刷新 / 删除均不可用（换壁纸、滑块、恢复默认外观仍正常 —— 它们不依赖后端）。

### 可选依赖：视频预览（ffmpeg）

mp4 上传始终可用，但**首帧预览图**需要 ffmpeg，按以下顺序自动探测：

1. 沿壁纸库目录向上找 Wallpaper Engine 自带的 `wallpaper_engine\bin\ffmpeg.exe`
2. 常见 Steam 安装位置
3. 系统 PATH 中的 `ffmpeg`

都找不到时**自动降级**：壁纸正常入库运行，仅不生成预览图并记录警告，绝不阻断上传流程。

## 使用

### 打开设置

顶栏右侧按钮排第一位的 🎨 调色板图标 → 壁纸设置面板。

### 两种换壁纸方式

| 方式 | 行为 | 适用 |
|---|---|---|
| **换壁纸…** | 直接把任意图片应用为背景：不入库、不建目录、不动索引 | 临时换张图、随手拍；也是后端不可用时唯一的换壁纸途径 |
| **上传壁纸文件** | 正式入库：自动生成 `wallpaper_YYYYMMDD_NNN` 目录 + 缩放预览图 + project.json + 刷新索引 | 想长期管理、检索、复用的壁纸 |

上传限制：仅 jpg / png / mp4；图片 ≤ 32MB，视频 ≤ 256MB（防超大文件）。标题自动从文件名清洗生成（去时间戳、下划线、横杠与非法字符；`IMG_0001` 之类无意义名自动回退为 `自定义壁纸-时间戳`）；标签默认 `["custom"]`，入库后可用编辑弹窗修改。

### 壁纸库窗口

- **刷新壁纸索引** —— 后台重建索引 + 增量缩略图，完成后列表自动热更新（**无需重启 Hermes、无需重载插件**）；执行异常时弹窗展示完整错误日志
- **搜索框** —— 按标题实时过滤
- **卡片** —— 点击即应用为壁纸（预览不关窗）；悬停出现两个按钮：
  - ✎ **编辑**：改标题 / 标签（逗号分隔），保存后更新磁盘 project.json 并刷新索引
  - 🗑 **删除**：二次确认后**物理永久删除该壁纸文件夹** —— 插件删除 = 本地磁盘壁纸移除，WE 库里也不再拥有这张壁纸
- **状态行** —— 扫描中… / ✓ 完成：共 X 个项目 · 有效 X · 新增 X · 跳过无效 X

### 壁纸库根目录

- 支持任意自定义目录，也支持直接指向 WE 的 myprojects（如 `<Steam>\steamapps\common\wallpaper_engine\projects\myprojects` 或订阅内容库 `...\workshop\content\431960`）
- 「浏览…」打开系统文件夹选择框（选完回填、确认后再保存）；也可以直接粘贴路径
- 路径位于 `Program Files` 时提示 Windows 系统权限限制，建议把 WE 项目目录迁移到非系统盘
- 更换根目录后点【刷新壁纸索引】生效

## 目录结构

```
hermes-chat-wallpaper/
├── plugin.yaml               # agent 侧清单（name: chat-wallpaper）
├── dashboard/
│   ├── manifest.json         # {"name": "chat-wallpaper", "api": "plugin_api.py"}
│   └── plugin_api.py         # Python 后端 → 挂载 /api/plugins/chat-wallpaper/
├── desktop/
│   └── plugin.js             # 桌面 UI 半区（应用自动同步到 desktop-plugins/chat-wallpaper/）
└── scripts/
    ├── build-we-index.py     # 索引构建（复用原版扫描逻辑；CLI 向后兼容；读取 library_config.json）
    └── gen-thumbs.py         # 缩略图生成（增量；被后端自动调用）
```

运行时产物（已 gitignore，不会进仓库）：`we-index.json`、`thumbs/`、`log.txt` 在 `desktop-plugins/chat-wallpaper/`；`library_config.json` 在插件包目录。

## REST API（供 Agent / 脚本调用）

后端随桌面应用挂载在 `/api/plugins/chat-wallpaper/`（需在 `plugins.enabled` 白名单内）：

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/status` | 索引任务状态、最近构建统计、库配置 |
| GET / POST | `/library/config` | 读取 / 保存壁纸库根目录 |
| POST | `/index/refresh` | 触发后台索引重建（防并发锁） |
| POST | `/wallpaper/upload` | `{src_path, plugin_dir}` 上传入库 |
| POST | `/wallpaper/delete` | `{id, plugin_dir}` 物理删除 |
| GET / POST | `/wallpaper/meta` | 读取 / 更新标题与标签 |

## 常见问题

- **打开壁纸库提示索引缺失**：直接点【刷新壁纸索引】自修复
- **提示"后端未就绪"**：确认 `hermes plugins enable chat-wallpaper` 已执行（`config.yaml` 的 `plugins.enabled` 含 `chat-wallpaper`），并重启桌面应用
- **视频上传后没有预览图**：装好 ffmpeg / Wallpaper Engine 后重新上传该视频即可（预览在入库时生成）
- **Wallpaper Engine 里看不到新增/删除**：WE 客户端不会自动刷新，在 WE 软件内点刷新按钮
- **中文、空格路径**：全链路支持

## 致谢

- 原版 [widewind-7/hermes-chat-wallpaper](https://github.com/widewind-7/hermes-chat-wallpaper)（MIT）：壁纸注入、配色引擎、设置面板与 WE 浏览基础
- [Hermes Agent](https://github.com/NousResearch/hermes-agent) 桌面插件 SDK 与 dashboard 后端挂载机制

## License

MIT（与原版一致，见 [LICENSE](LICENSE)）
