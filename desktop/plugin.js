/**
 * Chat Wallpaper — 为 Hermes Desktop 加自定义背景壁纸的插件
 *
 * 功能：
 * - 自定义背景图：聊天界面透出壁纸，配色（气泡/卡片/蒙版）自动取自壁纸平均色
 * - 顶栏原生风格设置按钮（插在右侧按钮排第一位，悬停/明暗与原生一致）
 * - 设置面板：4 个滑块即时生效自动保存（蒙版/气泡/卡片/配色深浅）
 * - 换壁纸：系统文件选择框，选完即时应用，重启保持
 * - Wallpaper Engine 壁纸库接入（可选）：分页浏览 + 搜索 + 分辨率/比例标注
 *   + 从 scene.pkg 抽取的高清纹理（HD 标记）+ 点击预览不关窗
 * - 恢复默认外观：一键回到应用原生主题（可再切回）
 *
 * 安装：把本文件夹（chat-wallpaper）放进 Hermes 的 desktop-plugins 目录，
 *       应用会自动加载（或 Ctrl+K → Reload desktop plugins）。
 * 详见 README.md。
 *
 * 实现备忘（踩坑记录，供后续维护）：
 * - 大 data URL 塞进 CSS 字符串会被浏览器解析器静默丢弃 → 用 Blob URL
 * - hermes-media:// 协议对任意本地路径不放行 → 用 readFileDataUrl + Blob URL
 * - 此内嵌浏览器（Electron）的 CSS Grid 内容高度计算会塌陷 → 卡片高度写死
 * - <button> 内嵌 <img> 布局有怪癖 → 卡片用 div + role=button
 * - 结构化卡片（文件变更/统计）底色变量是 --ui-widget-surface-background
 */

const STYLE_ID = 'chat-wallpaper-style'
const UI_ID = 'chat-wallpaper-ui'
const PANEL_ID = 'chat-wallpaper-panel'
const BROWSER_ID = 'chat-wallpaper-browser'

const DEFAULTS = { dim: 0.42, bubble: 0.68, card: 0.6, darken: 1.0 }

// ── 运行时解析的路径（见 resolvePluginDir）──
let PLUGIN_DIR = null
let IMG_PATH = null
let LOG_PATH = null
let INDEX_PATH = null

function joinPath(base, name) {
  // 跟随根目录的分隔符风格（Windows 反斜杠 / POSIX 正斜杠）
  const sep = base.includes('\\') && !base.includes('/') ? '\\' : '/'
  return base.replace(/[\\/]+$/, '') + sep + name
}

const logLines = []
function log(line) {
  logLines.push(`[${new Date().toLocaleTimeString()}] ${line}`)
  if (!LOG_PATH) return
  try {
    window.hermesDesktop?.writeTextFile?.(LOG_PATH, logLines.slice(-40).join('\n') + '\n')?.catch?.(() => {})
  } catch { /* 日志失败不影响壁纸 */ }
}

/**
 * 定位插件自己的文件夹：desktopPluginsRoot() 给出根目录，
 * 在其中找名为 chat-wallpaper（官方约定：文件夹名=插件id）的目录；
 * 兼容旧文件夹名 wallpaper。
 */
async function resolvePluginDir() {
  const hd = window.hermesDesktop
  const root = typeof hd?.desktopPluginsRoot === 'function' ? await hd.desktopPluginsRoot() : null
  if (typeof root !== 'string' || !root) return null
  try {
    const { entries } = await hd.readDir(root)
    const names = new Set((entries || []).filter(e => e.isDirectory).map(e => e.name))
    const dirName = names.has('chat-wallpaper') ? 'chat-wallpaper' : names.has('wallpaper') ? 'wallpaper' : null
    if (!dirName) return null
    PLUGIN_DIR = joinPath(root, dirName)
    IMG_PATH = joinPath(PLUGIN_DIR, 'bg.jpg')
    LOG_PATH = joinPath(PLUGIN_DIR, 'log.txt')
    INDEX_PATH = joinPath(PLUGIN_DIR, 'we-index.json')
    return PLUGIN_DIR
  } catch {
    return null
  }
}

let styleEl = null
let panelEl = null
let browserEl = null
let objectUrl = null
let rawAvg = null
let params = { ...DEFAULTS }
let storage = null
let disposed = false
let keepAliveTimer = null
let onOutsideClick = null
let escClose = null
let onHashChange = null
let insertedOnce = false
let weIndex = null // {we, n, items:[{id,t,p,th,hd,y,w,h}]}
let currentWeId = null
let wePage = 0
let disabled = false // 「恢复默认外观」：界面可用但视觉层撤下
let ctxRef = null            // register(ctx) 保存的上下文（后端 REST 用）
let indexPollTimer = null    // 壁纸库状态轮询定时器
let libCfgTouched = false    // 设置面板路径输入是否已被用户编辑

// 配色 = 壁纸平均色 × darken（darken=1 即壁纸原色）
function tintOf() {
  const base = rawAvg ?? { r: 13, g: 17, b: 23 }
  const k = params.darken
  return { r: Math.round(base.r * k), g: Math.round(base.g * k), b: Math.round(base.b * k) }
}

function repaint() {
  if (disposed || !styleEl) return
  const t = tintOf()
  const tint = `${t.r}, ${t.g}, ${t.b}`
  // 右侧消息时间轴刻度线：按壁纸亮度自动给对比色（暗壁纸→亮线，亮壁纸→暗线）
  const tintLum = 0.2126 * t.r + 0.7152 * t.g + 0.0722 * t.b
  const tick = tintLum > 140 ? '20, 24, 28' : '236, 240, 244'
  // 视觉层（壁纸/透明/取色）只在启用时注入；插件自身 UI（设置面板+壁纸库窗）的样式始终保留，
  // 否则「恢复默认外观」下打开壁纸库会因子元素无样式而布局挤压。
  const css = `${disabled ? '' : `
    :root {
      --wallpaper-tint: rgb(${tint});
      --wallpaper-tint-rgb: ${tint};
      --wallpaper-tint-dim: rgba(${tint}, ${params.dim});
      --wallpaper-tint-bubble: rgba(${tint}, ${params.bubble});
      --wallpaper-tint-card: rgba(${tint}, ${params.card});
      --ui-chat-surface-background: transparent;
      --ui-editor-surface-background: transparent;
      --ui-chat-bubble-background: var(--wallpaper-tint-bubble);
      --ui-chat-bubble-opaque-background: var(--wallpaper-tint-bubble);
      /* 结构化卡片（文件变更卡/统计卡）：原生深色下近纯黑，改壁纸同色调 */
      --ui-widget-surface-background: var(--wallpaper-tint-card);
      --ui-bg-editor: var(--wallpaper-tint-card);
    }
    html, body, #root,
    [data-pane-shell], [data-tree-group],
    [data-contrib-shell], [data-slot='sidebar-wrapper'] {
      background: transparent !important;
    }
    ${objectUrl ? `
    body {
      background-color: var(--wallpaper-tint) !important;
      background-image:
        linear-gradient(var(--wallpaper-tint-dim), var(--wallpaper-tint-dim)),
        url("${objectUrl}") !important;
      background-size: cover !important;
      background-position: center !important;
      background-repeat: no-repeat !important;
    }
    ` : ''}
    [data-file-edit] {
      background: var(--wallpaper-tint-card) !important;
    }
    /* 时间轴刻度线（dither 点阵用 currentColor） */
    [data-slot='thread-timeline'] .dither {
      color: rgb(${tick}) !important;
      opacity: .85 !important;
    }
  `}
    #${UI_ID} .codicon { line-height: 1; }
    /* ── 设置面板（应用原生弹层风格）── */
    #${PANEL_ID} {
      display: none;
      position: fixed;
      width: 280px;
      padding: 14px 16px 12px;
      border-radius: calc(var(--radius-scalar, 1) * 0.75rem);
      background: color-mix(in srgb, var(--theme-elevated-seed, #161b22) 94%, transparent);
      border: 1px solid var(--dt-border, rgba(240, 246, 252, 0.12));
      color: var(--dt-foreground, #e6edf3);
      backdrop-filter: blur(16px);
      box-shadow: 0 12px 40px rgba(0, 0, 0, 0.4);
      font-size: 13px;
      z-index: 2147483000;
      font-family: var(--dt-font-sans, system-ui, sans-serif);
    }
    #${PANEL_ID}.open { display: block; }
    #${PANEL_ID} .wp-row { margin-bottom: 13px; }
    #${PANEL_ID} .wp-label {
      display: flex; justify-content: space-between; align-items: baseline; margin-bottom: 4px;
    }
    #${PANEL_ID} .wp-label b {
      font-weight: 500; font-size: 12.5px;
      color: var(--ui-text-primary, var(--dt-foreground, #e6edf3));
    }
    #${PANEL_ID} .wp-pct {
      font-size: 12px;
      color: var(--ui-text-tertiary, var(--dt-muted-foreground, #8b949e));
      font-variant-numeric: tabular-nums;
    }
    #${PANEL_ID} input[type=range] {
      width: 100%;
      accent-color: var(--ui-accent, #6f9bff);
      cursor: pointer;
      margin: 0;
      height: 18px;
    }
    #${PANEL_ID} .wp-hint {
      font-size: 11px;
      color: var(--ui-text-tertiary, var(--dt-muted-foreground, #8b949e));
      margin-top: 1px;
    }
    #${PANEL_ID} .wp-title {
      display: flex; justify-content: space-between; align-items: center;
      margin-bottom: 12px;
      font-size: 13px; font-weight: 600;
      color: var(--dt-foreground, #e6edf3);
    }
    #${PANEL_ID} .wp-close {
      display: inline-flex; align-items: center; justify-content: center;
      width: 22px; height: 22px;
      border-radius: calc(var(--radius-scalar, 1) * 0.25rem);
      cursor: pointer;
      color: var(--ui-text-tertiary, var(--dt-muted-foreground, #8b949e));
      background: transparent; border: none; padding: 0;
    }
    #${PANEL_ID} .wp-close:hover {
      background: var(--chrome-action-hover, var(--ui-control-hover-background, rgba(128,128,128,.18)));
      color: var(--ui-text-primary, var(--dt-foreground, #e6edf3));
    }
    #${PANEL_ID} .wp-close .codicon { font-size: 13px; line-height: 1; }
    #${PANEL_ID} .wp-foot {
      margin-top: 10px; padding-top: 9px;
      font-size: 11px;
      color: var(--ui-text-tertiary, var(--dt-muted-foreground, #8b949e));
      line-height: 1.65;
      border-top: 1px solid var(--dt-border, rgba(240, 246, 252, 0.12));
    }
    /* ── 操作按钮（原生次级按钮风格）── */
    #${PANEL_ID} .wp-pickrow { margin: 2px 0 4px; }
    #${PANEL_ID}-pick,
    #${PANEL_ID}-we,
    #${PANEL_ID}-reset {
      display: inline-flex; align-items: center; justify-content: center; gap: 6px;
      width: 100%;
      height: 30px;
      border-radius: calc(var(--radius-scalar, 1) * 0.375rem);
      background: transparent;
      border: 1px solid var(--dt-border, rgba(240, 246, 252, 0.12));
      color: var(--ui-text-primary, var(--dt-foreground, #e6edf3));
      font-size: 12.5px;
      font-family: inherit;
      cursor: pointer;
      padding: 0 10px;
      transition: background .12s ease;
    }
    #${PANEL_ID}-we, #${PANEL_ID}-reset { margin-top: 6px; }
    #${PANEL_ID}-reset { color: var(--ui-text-secondary, var(--dt-muted-foreground, #8b949e)); }
    #${PANEL_ID}-pick:hover,
    #${PANEL_ID}-we:hover,
    #${PANEL_ID}-reset:hover {
      background: var(--chrome-action-hover, var(--ui-control-hover-background, rgba(128,128,128,.18)));
      color: var(--ui-text-primary, var(--dt-foreground, #e6edf3));
    }
    #${PANEL_ID}-pick .codicon,
    #${PANEL_ID}-we .codicon,
    #${PANEL_ID}-reset .codicon { font-size: 14px; line-height: 1; }
    /* ── Wallpaper Engine 壁纸库浏览窗 ── */
    #${BROWSER_ID} {
      display: none;
      position: fixed;
      top: 44px; left: 50%;
      transform: translateX(-50%);
      width: min(860px, calc(100vw - 60px));
      height: min(640px, calc(100vh - 110px));
      border-radius: calc(var(--radius-scalar, 1) * 0.75rem);
      background: color-mix(in srgb, var(--theme-elevated-seed, #161b22) 96%, transparent);
      border: 1px solid var(--dt-border, rgba(240, 246, 252, 0.12));
      color: var(--dt-foreground, #e6edf3);
      backdrop-filter: blur(16px);
      box-shadow: 0 16px 56px rgba(0, 0, 0, 0.45);
      z-index: 2147483100;
      font-family: var(--dt-font-sans, system-ui, sans-serif);
      flex-direction: column;
      overflow: hidden;
    }
    #${BROWSER_ID}.open { display: flex; }
    #${BROWSER_ID} .wb-head {
      display: flex; align-items: center; gap: 10px;
      padding: 12px 14px 10px;
      border-bottom: 1px solid var(--dt-border, rgba(240, 246, 252, 0.12));
      flex: none;
    }
    #${BROWSER_ID} .wb-title { font-size: 13px; font-weight: 600; white-space: nowrap; }
    #${BROWSER_ID} .wb-search {
      flex: 0 1 300px;
      min-width: 130px;
      max-width: 300px;
      height: 28px;
      border-radius: calc(var(--radius-scalar, 1) * 0.375rem);
      background: color-mix(in srgb, var(--theme-background-seed, #0d1117) 70%, transparent);
      border: 1px solid var(--dt-border, rgba(240, 246, 252, 0.12));
      color: var(--ui-text-primary, var(--dt-foreground, #e6edf3));
      font-size: 12.5px;
      font-family: inherit;
      padding: 0 10px;
      outline: none;
    }
    #${BROWSER_ID} .wb-search:focus { border-color: var(--ui-accent, #6f9bff); }
    #${BROWSER_ID} .wb-search::placeholder { color: var(--ui-text-tertiary, #8b949e); }
    #${BROWSER_ID} .wb-close {
      display: inline-flex; align-items: center; justify-content: center;
      width: 24px; height: 24px; flex: none;
      border-radius: calc(var(--radius-scalar, 1) * 0.25rem);
      cursor: pointer; background: transparent; border: none; padding: 0;
      color: var(--ui-text-tertiary, #8b949e);
    }
    #${BROWSER_ID} .wb-close:hover {
      background: var(--chrome-action-hover, rgba(128,128,128,.18));
      color: var(--ui-text-primary, #e6edf3);
    }
    #${BROWSER_ID} .wb-close .codicon { font-size: 14px; line-height: 1; }
    #${BROWSER_ID} .wb-grid {
      flex: 1; overflow-y: auto; overflow-x: hidden;
      padding: 12px;
      display: grid;
      grid-template-columns: repeat(auto-fill, minmax(150px, 1fr));
      gap: 10px;
      align-content: start;
    }
    #${BROWSER_ID} .wb-card {
      border: 1px solid var(--dt-border, rgba(240, 246, 252, 0.1));
      border-radius: calc(var(--radius-scalar, 1) * 0.5rem);
      overflow: hidden; cursor: pointer;
      background: color-mix(in srgb, var(--theme-background-seed, #0d1117) 60%, transparent);
      transition: border-color .12s ease, transform .12s ease;
      padding: 0; margin: 0; text-align: left; font-family: inherit;
      position: relative;
      height: 136px; /* 写死：此内嵌浏览器网格内容高度计算会塌陷 */
    }
    #${BROWSER_ID} .wb-card:hover {
      border-color: var(--ui-accent, #6f9bff);
      transform: translateY(-1px);
    }
    #${BROWSER_ID} .wb-card.wb-active {
      border-color: var(--ui-accent, #6f9bff);
    }
    #${BROWSER_ID} .wb-thumb {
      width: 100%; height: 84px;
      object-fit: cover; display: block;
      background: color-mix(in srgb, var(--theme-background-seed, #0d1117) 90%, #30363d);
    }
    #${BROWSER_ID} .wb-meta {
      padding: 6px 8px 7px;
      display: flex; flex-direction: column; gap: 2px;
    }
    #${BROWSER_ID} .wb-name {
      font-size: 11.5px; line-height: 1.35;
      color: var(--ui-text-primary, #e6edf3);
      overflow: hidden; text-overflow: ellipsis;
      display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical;
      word-break: break-all;
    }
    #${BROWSER_ID} .wb-type {
      font-size: 10px;
      color: var(--ui-text-tertiary, #8b949e);
    }
    #${BROWSER_ID} .wb-hd {
      display: inline-block;
      font-size: 9px;
      font-weight: 600;
      color: var(--ui-accent, #6f9bff);
      border: 1px solid currentColor;
      border-radius: 3px;
      padding: 0 3px;
      vertical-align: 1px;
      line-height: 1.2;
    }
    #${BROWSER_ID} .wb-using {
      display: inline-block;
      font-size: 9px;
      font-weight: 600;
      color: var(--ui-accent, #6f9bff);
      margin-left: 4px;
    }
    #${BROWSER_ID} .wb-empty {
      grid-column: 1 / -1; text-align: center;
      color: var(--ui-text-tertiary, #8b949e); font-size: 12.5px;
      padding: 40px 0;
    }
    /* ── 分页条 ── */
    #${BROWSER_ID} .wb-pager {
      flex: none;
      position: relative;
      display: flex; align-items: center; justify-content: center; gap: 4px;
      padding: 8px 10px 10px;
      border-top: 1px solid var(--dt-border, rgba(240, 246, 252, 0.12));
    }
    #${BROWSER_ID} .wb-page {
      min-width: 26px; height: 24px;
      display: inline-flex; align-items: center; justify-content: center;
      border-radius: calc(var(--radius-scalar, 1) * 0.25rem);
      background: transparent;
      border: 1px solid transparent;
      color: var(--ui-text-secondary, #c9d1d9);
      font-size: 12px; font-family: inherit;
      cursor: pointer; padding: 0 5px;
    }
    #${BROWSER_ID} .wb-page .codicon { font-size: 13px; line-height: 1; }
    #${BROWSER_ID} .wb-page:hover:not(:disabled):not(.cur) {
      background: var(--chrome-action-hover, rgba(128,128,128,.18));
      color: var(--ui-text-primary, #e6edf3);
    }
    #${BROWSER_ID} .wb-page.cur {
      background: color-mix(in srgb, var(--ui-accent, #6f9bff) 22%, transparent);
      border-color: var(--ui-accent, #6f9bff);
      color: var(--ui-text-primary, #e6edf3);
      cursor: default;
    }
    #${BROWSER_ID} .wb-page:disabled { opacity: .35; cursor: default; }
    #${BROWSER_ID} .wb-dots {
      color: var(--ui-text-tertiary, #8b949e); font-size: 12px; padding: 0 2px;
    }
    #${BROWSER_ID} .wb-done {
      position: absolute; right: 10px;
      display: inline-flex; align-items: center; gap: 4px;
      height: 24px; padding: 0 10px;
      border-radius: calc(var(--radius-scalar, 1) * 0.25rem);
      background: color-mix(in srgb, var(--ui-accent, #6f9bff) 18%, transparent);
      border: 1px solid var(--ui-accent, #6f9bff);
      color: var(--ui-text-primary, #e6edf3);
      font-size: 12px; font-family: inherit;
      cursor: pointer;
    }
    #${BROWSER_ID} .wb-done:hover {
      background: color-mix(in srgb, var(--ui-accent, #6f9bff) 32%, transparent);
    }
    #${BROWSER_ID} .wb-done .codicon { font-size: 12px; line-height: 1; }
    /* ── 工具按钮（位于头部行：标题 | 搜索 | [弹性] | 刷新 | 上传 | ✕）── */
    #${BROWSER_ID} .wb-head .wb-tbtn:first-of-type { margin-left: auto; }
    #${BROWSER_ID} .wb-tbtn {
      display: inline-flex; align-items: center; gap: 5px;
      height: 26px; padding: 0 10px;
      border-radius: calc(var(--radius-scalar, 1) * 0.375rem);
      background: transparent;
      border: 1px solid var(--dt-border, rgba(240, 246, 252, 0.16));
      color: var(--ui-text-primary, #e6edf3);
      font-size: 12px; font-family: inherit; cursor: pointer; white-space: nowrap;
    }
    #${BROWSER_ID} .wb-tbtn:hover:not(:disabled) { background: var(--chrome-action-hover, rgba(128,128,128,.18)); }
    #${BROWSER_ID} .wb-tbtn:disabled { opacity: .5; cursor: default; }
    #${BROWSER_ID} .wb-tbtn .codicon { font-size: 13px; line-height: 1; }
    #${BROWSER_ID} .wb-statusrow {
      display: none;
      padding: 7px 14px 0;
      flex: none;
    }
    #${BROWSER_ID} .wb-statusrow.show { display: block; }
    #${BROWSER_ID} .wb-status {
      font-size: 11.5px; color: var(--ui-text-tertiary, #8b949e);
      overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
    }
    #${BROWSER_ID} .wb-wehint {
      font-size: 11px; color: var(--ui-text-tertiary, #8b949e);
      padding: 0 14px 6px; display: none; flex: none;
    }
    #${BROWSER_ID} .wb-wehint.show { display: block; }
    /* ── 卡片操作按钮（编辑/删除）── */
    #${BROWSER_ID} .wb-acts { position: absolute; top: 4px; right: 4px; display: none; gap: 4px; z-index: 1; }
    #${BROWSER_ID} .wb-card:hover .wb-acts,
    #${BROWSER_ID} .wb-card:focus-within .wb-acts { display: inline-flex; }
    #${BROWSER_ID} .wb-act {
      width: 22px; height: 22px;
      display: inline-flex; align-items: center; justify-content: center;
      border-radius: calc(var(--radius-scalar, 1) * 0.25rem);
      background: rgba(0, 0, 0, .55); border: none; cursor: pointer;
      color: #e6edf3; padding: 0;
    }
    #${BROWSER_ID} .wb-act:hover { background: rgba(0, 0, 0, .78); }
    #${BROWSER_ID} .wb-act .codicon { font-size: 13px; line-height: 1; }
    /* ── 通用弹窗（确认 / 错误日志 / 编辑）── */
    .cw-modal {
      position: fixed; inset: 0; z-index: 2147483200;
      display: flex; align-items: center; justify-content: center;
      background: rgba(0, 0, 0, .45);
    }
    .cw-box {
      width: min(460px, calc(100vw - 48px));
      max-height: min(70vh, 560px);
      display: flex; flex-direction: column;
      border-radius: calc(var(--radius-scalar, 1) * 0.75rem);
      background: color-mix(in srgb, var(--theme-elevated-seed, #161b22) 97%, transparent);
      border: 1px solid var(--dt-border, rgba(240, 246, 252, 0.12));
      color: var(--dt-foreground, #e6edf3);
      box-shadow: 0 16px 56px rgba(0, 0, 0, 0.45);
      font-family: var(--dt-font-sans, system-ui, sans-serif);
      font-size: 13px;
    }
    .cw-head { display: flex; align-items: center; justify-content: space-between; padding: 12px 14px 8px; font-weight: 600; }
    .cw-x {
      width: 22px; height: 22px; display: inline-flex; align-items: center; justify-content: center;
      border-radius: calc(var(--radius-scalar, 1) * 0.25rem);
      background: transparent; border: none; cursor: pointer;
      color: var(--ui-text-tertiary, #8b949e); padding: 0;
    }
    .cw-x:hover { background: var(--chrome-action-hover, rgba(128,128,128,.18)); color: var(--ui-text-primary, #e6edf3); }
    .cw-x .codicon { font-size: 13px; line-height: 1; }
    .cw-body { padding: 4px 14px 10px; overflow: auto; }
    .cw-text { line-height: 1.7; color: var(--ui-text-primary, #e6edf3); }
    .cw-pre {
      white-space: pre-wrap; word-break: break-all;
      font-size: 11px; line-height: 1.5; max-height: 46vh; overflow: auto;
      color: var(--ui-text-secondary, #c9d1d9);
      background: color-mix(in srgb, var(--theme-background-seed, #0d1117) 60%, transparent);
      border: 1px solid var(--dt-border, rgba(240, 246, 252, 0.1));
      border-radius: calc(var(--radius-scalar, 1) * 0.375rem);
      padding: 8px 10px;
    }
    .cw-label { display: block; font-size: 12px; color: var(--ui-text-secondary, #c9d1d9); margin: 8px 0 4px; }
    .cw-input {
      width: 100%; height: 28px; box-sizing: border-box;
      border-radius: calc(var(--radius-scalar, 1) * 0.375rem);
      background: color-mix(in srgb, var(--theme-background-seed, #0d1117) 70%, transparent);
      border: 1px solid var(--dt-border, rgba(240, 246, 252, 0.12));
      color: var(--ui-text-primary, #e6edf3);
      font-size: 12.5px; font-family: inherit; padding: 0 10px; outline: none;
    }
    .cw-input:focus { border-color: var(--ui-accent, #6f9bff); }
    .cw-foot { display: flex; justify-content: flex-end; gap: 8px; padding: 8px 14px 12px; }
    .cw-btn {
      height: 28px; padding: 0 14px;
      border-radius: calc(var(--radius-scalar, 1) * 0.375rem);
      background: transparent;
      border: 1px solid var(--dt-border, rgba(240, 246, 252, 0.16));
      color: var(--ui-text-primary, #e6edf3);
      font-size: 12.5px; font-family: inherit; cursor: pointer;
    }
    .cw-btn:hover { background: var(--chrome-action-hover, rgba(128,128,128,.18)); }
    .cw-primary { background: color-mix(in srgb, var(--ui-accent, #6f9bff) 22%, transparent); border-color: var(--ui-accent, #6f9bff); }
    .cw-danger { color: #ff7b72; border-color: rgba(255, 123, 114, .6); }
    .cw-danger:hover { background: rgba(255, 123, 114, .14); }
    /* ── 设置面板：壁纸库根目录 ── */
    #${PANEL_ID} .wp-libsec { margin-bottom: 12px; padding-top: 10px; border-top: 1px solid var(--dt-border, rgba(240, 246, 252, 0.12)); }
    #${PANEL_ID} .wp-librow { display: flex; gap: 6px; }
    #${PANEL_ID} .wp-libinput {
      flex: 1; min-width: 0; height: 26px; box-sizing: border-box;
      border-radius: calc(var(--radius-scalar, 1) * 0.375rem);
      background: color-mix(in srgb, var(--theme-background-seed, #0d1117) 70%, transparent);
      border: 1px solid var(--dt-border, rgba(240, 246, 252, 0.12));
      color: var(--ui-text-primary, #e6edf3);
      font-size: 12px; font-family: inherit; padding: 0 8px; outline: none;
    }
    #${PANEL_ID} .wp-libinput:focus { border-color: var(--ui-accent, #6f9bff); }
    #${PANEL_ID} .wp-libsave,
    #${PANEL_ID} .wp-libbrowse {
      height: 26px; padding: 0 10px; flex: none;
      border-radius: calc(var(--radius-scalar, 1) * 0.375rem);
      background: transparent;
      border: 1px solid var(--dt-border, rgba(240, 246, 252, 0.16));
      color: var(--ui-text-primary, #e6edf3);
      font-size: 12px; font-family: inherit; cursor: pointer;
    }
    #${PANEL_ID} .wp-libsave:hover,
    #${PANEL_ID} .wp-libbrowse:hover { background: var(--chrome-action-hover, rgba(128,128,128,.18)); }
    #${PANEL_ID} .wp-libsave:disabled,
    #${PANEL_ID} .wp-libbrowse:disabled { opacity: .5; cursor: default; }
  `
  if (styleEl.styleSheet) {
    styleEl.styleSheet.cssText = css
  } else {
    styleEl.textContent = css
  }
}

async function averageColor(blob) {
  const bmp = await createImageBitmap(blob)
  const w = 64, hh = Math.max(1, Math.round((64 * bmp.height) / bmp.width))
  const canvas = document.createElement('canvas')
  canvas.width = w
  canvas.height = hh
  const g = canvas.getContext('2d', { willReadFrequently: true })
  g.drawImage(bmp, 0, 0, w, hh)
  bmp.close?.()
  const d = g.getImageData(0, 0, w, hh).data
  let r = 0, gr = 0, b = 0, n = 0
  for (let i = 0; i < d.length; i += 4) { r += d[i]; gr += d[i + 1]; b += d[i + 2]; n++ }
  r = Math.round(r / n); gr = Math.round(gr / n); b = Math.round(b / n)
  const lum = 0.2126 * r + 0.7152 * gr + 0.0722 * b
  return { r, g: gr, b, lum }
}

const SLIDERS = [
  { key: 'dim', label: '全屏蒙版', hint: '调大：文字更清楚、壁纸更淡' },
  { key: 'bubble', label: '消息气泡', hint: '太透看不清字就调大' },
  { key: 'card', label: '文件卡片', hint: '「文件已更改」卡片的深浅' },
  { key: 'darken', label: '配色深浅', hint: '调低=配色整体变深；100%=壁纸原色' },
]

function buildPanel() {
  const panel = document.createElement('div')
  panel.id = PANEL_ID
  panel.innerHTML = `
    <div class="wp-title">
      <span>壁纸设置</span>
      <button class="wp-close" type="button" aria-label="关闭" title="关闭">
        <i class="codicon codicon-close" aria-hidden="true"></i>
      </button>
    </div>
  `
  for (const s of SLIDERS) {
    const row = document.createElement('div')
    row.className = 'wp-row'
    const pct = Math.round(params[s.key] * 100)
    row.innerHTML = `
      <div class="wp-label"><b>${s.label}</b><span class="wp-pct">${pct}%</span></div>
      <input type="range" min="0" max="100" value="${pct}" data-key="${s.key}">
      <div class="wp-hint">${s.hint}</div>
    `
    panel.append(row)
  }
  // ── 壁纸库根目录配置 ──
  const libSec = document.createElement('div')
  libSec.className = 'wp-libsec'
  libSec.innerHTML = `
    <div class="wp-label"><b>壁纸库根目录</b></div>
    <div class="wp-librow">
      <input type="text" class="wp-libinput" spellcheck="false"
        placeholder="自定义目录 或 WE 的 myprojects 目录">
      <button type="button" class="wp-libbrowse" title="打开系统文件夹选择框">浏览…</button>
      <button type="button" class="wp-libsave">保存</button>
    </div>
    <div class="wp-hint wp-libhint-pf" style="display:none">⚠ 路径位于 Program Files：Windows 系统目录权限受限，建议把 Wallpaper Engine 项目目录迁移到非系统盘（如 D:\\），否则写入壁纸可能失败。</div>
    <div class="wp-hint wp-libhint-status"></div>
  `
  const libInput = libSec.querySelector('.wp-libinput')
  const pfHint = libSec.querySelector('.wp-libhint-pf')
  libInput.addEventListener('input', () => {
    libCfgTouched = true
    pfHint.style.display = /Program Files/i.test(libInput.value) ? '' : 'none'
  })
  libSec.querySelector('.wp-libbrowse').addEventListener('click', async ev => {
    const btn = ev.currentTarget
    const pick = window.hermesDesktop?.selectPaths
    if (typeof pick !== 'function') {
      errorModal('不可用', '当前环境不支持系统文件夹选择框，请直接粘贴路径')
      return
    }
    btn.disabled = true
    try {
      const paths = await pick({ title: '选择壁纸库根目录', directories: true, multiple: false })
      const p = Array.isArray(paths) ? paths[0] : paths
      if (p && typeof p === 'string') {
        libInput.value = p
        libInput.dispatchEvent(new Event('input'))   // 复用输入联动：标记已编辑 + Program Files 提示
      }
    } catch { /* 用户取消 */ }
    finally { btn.disabled = false }
  })
  libSec.querySelector('.wp-libsave').addEventListener('click', async ev => {
    const btn = ev.currentTarget
    const v = libInput.value.trim()
    if (!v) return
    btn.disabled = true
    try {
      const r = await api('/library/config', { method: 'POST', body: { library_dir: v } })
      const hint = libSec.querySelector('.wp-libhint-status')
      if (hint) hint.textContent = '✓ 已保存' + (r.is_we_myprojects ? '（Wallpaper Engine myprojects 目录）' : '') + '，打开壁纸库点【刷新壁纸索引】生效'
      libCfgTouched = false
      log('壁纸库根目录已保存：' + v)
    } catch (e) {
      errorModal('保存失败', apiErrorText(e))
    } finally {
      btn.disabled = false
    }
  })
  panel.append(libSec)

  const pickRow = document.createElement('div')
  pickRow.className = 'wp-pickrow'
  const pickBtn = document.createElement('button')
  pickBtn.id = `${PANEL_ID}-pick`
  pickBtn.type = 'button'
  pickBtn.innerHTML = '<i class="codicon codicon-add-photo" aria-hidden="true"></i><span>换壁纸…</span>'
  pickBtn.addEventListener('click', onPickWallpaper)
  pickRow.append(pickBtn)
  panel.append(pickRow)

  const weRow = document.createElement('div')
  weRow.className = 'wp-pickrow'
  const weBtn = document.createElement('button')
  weBtn.id = `${PANEL_ID}-we`
  weBtn.type = 'button'
  weBtn.innerHTML = '<i class="codicon codicon-library" aria-hidden="true"></i><span>Wallpaper Engine 壁纸库</span>'
  weBtn.addEventListener('click', openWeBrowser)
  weRow.append(weBtn)
  panel.append(weRow)

  const resetRow = document.createElement('div')
  resetRow.className = 'wp-pickrow'
  const resetBtn = document.createElement('button')
  resetBtn.id = `${PANEL_ID}-reset`
  resetBtn.type = 'button'
  function syncResetBtn() {
    resetBtn.innerHTML = disabled
      ? '<i class="codicon codicon-activate-breakpoints" aria-hidden="true"></i><span>重新启用壁纸</span>'
      : '<i class="codicon codicon-discard" aria-hidden="true"></i><span>恢复默认外观</span>'
  }
  syncResetBtn()
  resetBtn.addEventListener('click', () => {
    disabled = !disabled
    storage?.set('disabled', disabled)
    log(disabled ? '恢复默认外观：视觉层撤下' : '重新启用壁纸：视觉层恢复')
    syncResetBtn()
    panelEl?.classList.remove('open')
    browserEl?.classList.remove('open')
    repaint()
  })
  resetRow.append(resetBtn)
  panel.append(resetRow)


  const foot = document.createElement('div')
  foot.className = 'wp-foot'
  foot.textContent = '配色自动取自壁纸。「恢复默认外观」一键回到应用原生主题，再点「重新启用壁纸」恢复。'
  panel.append(foot)

  panel.querySelectorAll('input[type=range]').forEach(input => {
    input.addEventListener('input', () => {
      const key = input.dataset.key
      const v = Number(input.value) / 100
      params = { ...params, [key]: v }
      const span = input.parentElement?.querySelector('.wp-pct')
      if (span) span.textContent = Math.round(v * 100) + '%'
      storage?.set(key, v)
      repaint()
    })
  })
  panel.querySelector('.wp-close').addEventListener('click', () => panel.classList.remove('open'))
  return panel
}

// ── 选图换壁纸 ──
async function onPickWallpaper() {
  const pick = window.hermesDesktop?.selectPaths
  if (typeof pick !== 'function') {
    log('!!! 当前环境不支持文件选择')
    return
  }
  let paths = []
  try {
    paths = await pick({
      title: '选择壁纸图片',
      multiple: false,
      filters: [{ name: '图片', extensions: ['jpg', 'jpeg', 'png', 'webp', 'bmp'] }],
    })
  } catch (e) {
    log('选图失败: ' + (e?.message || e))
    return
  }
  const src = Array.isArray(paths) ? paths[0] : paths
  if (!src || typeof src !== 'string') return
  log('用户选择壁纸: ' + src)
  const bridge = window.hermesDesktop?.readFileDataUrl
  if (typeof bridge !== 'function') {
    log('!!! 无法读取所选图片')
    return
  }
  try {
    const dataUrl = await bridge(src)
    const blob = await (await fetch(dataUrl)).blob()
    storage?.set('srcPath', src)
    currentWeId = null
    disabled = false
    storage?.set('disabled', false)
    applyWallpaperBlob(blob, src)
    repaint()
  } catch (e) {
    log('!!! 应用新壁纸失败: ' + (e?.message || e))
  }
}

async function applyWallpaperBlob(blob, srcLabel) {
  if (disposed) return
  if (objectUrl) URL.revokeObjectURL(objectUrl)
  objectUrl = URL.createObjectURL(blob)
  try {
    rawAvg = await averageColor(blob)
    log(`新壁纸已应用（${srcLabel}），取色 rgb(${rawAvg.r}, ${rawAvg.g}, ${rawAvg.b})`)
  } catch (e) {
    rawAvg = null
    log('取色失败，用深色兜底: ' + (e?.message || e))
  }
  repaint()
  const probe = new Image()
  probe.onload = () => log('新壁纸图片加载成功')
  probe.onerror = () => log('!!! 新壁纸图片加载失败')
  probe.src = objectUrl
}

// ── 资源管理库：后端 REST（/api/plugins/chat-wallpaper/）──
function apiErrorText(e) {
  const raw = (e && (e.detail || e.message)) || String(e)
  return typeof raw === 'string' ? raw : JSON.stringify(raw)
}

async function api(path, opts) {
  if (!ctxRef || typeof ctxRef.rest !== 'function') {
    throw new Error('插件后端不可用：请确认 config.yaml 的 plugins.enabled 包含 chat-wallpaper，并重启应用')
  }
  let res
  try {
    res = await ctxRef.rest(path, opts)
  } catch (e) {
    throw new Error(apiErrorText(e))
  }
  if (res && typeof res === 'object' && typeof res.detail === 'string' &&
      res.ok === undefined && res.running === undefined && res.last === undefined &&
      res.library_dir === undefined && res.source === undefined && res.resolved === undefined) {
    throw new Error(res.detail)   // FastAPI HTTPException 的错误体
  }
  return res
}

/** 从磁盘重读索引并重绘当前网格（上传/删除/编辑/刷新后热更新，无需重载插件） */
async function reloadIndexFromDisk() {
  const bridge = window.hermesDesktop?.readFileText
  if (typeof bridge !== 'function' || !INDEX_PATH) return false
  try {
    const res = await bridge(INDEX_PATH)
    const data = JSON.parse(res.text ?? res)
    if (!data || !Array.isArray(data.items)) return false
    weIndex = data
    const titleEl = browserEl?.querySelector('.wb-title')
    if (titleEl) titleEl.textContent = `壁纸库（${weIndex.n}）`
    const search = browserEl?.querySelector('.wb-search')
    wePage = 0
    renderWeGrid(search ? search.value.trim() : '')
    return true
  } catch {
    return false
  }
}

// ── 通用弹窗（确认 / 错误 / 编辑）──
function modalOpen({ title, bodyBuilder, buttons }) {
  return new Promise(resolve => {
    const overlay = document.createElement('div')
    overlay.className = 'cw-modal'
    const box = document.createElement('div')
    box.className = 'cw-box'
    const head = document.createElement('div')
    head.className = 'cw-head'
    const h = document.createElement('span')
    h.textContent = title
    const close = document.createElement('button')
    close.type = 'button'
    close.className = 'cw-x'
    close.setAttribute('aria-label', '关闭')
    close.innerHTML = '<i class="codicon codicon-close" aria-hidden="true"></i>'
    head.append(h, close)
    const body = document.createElement('div')
    body.className = 'cw-body'
    const boxCtx = {}
    bodyBuilder(body, boxCtx)
    const foot = document.createElement('div')
    foot.className = 'cw-foot'
    const finish = val => {
      document.removeEventListener('keydown', esc, true)
      overlay.remove()
      resolve(val)
    }
    close.addEventListener('click', () => finish(null))
    overlay.addEventListener('pointerdown', ev => { if (ev.target === overlay) finish(null) })
    const esc = ev => {
      if (ev.key === 'Escape') { ev.stopPropagation(); finish(null) }
    }
    document.addEventListener('keydown', esc, true)
    for (const b of buttons) {
      const btn = document.createElement('button')
      btn.type = 'button'
      btn.className = 'cw-btn' + (b.primary ? ' cw-primary' : '') + (b.danger ? ' cw-danger' : '')
      btn.textContent = b.label
      btn.addEventListener('click', () => finish(b.result ? b.result(boxCtx) : null))
      foot.append(btn)
    }
    box.append(head, body, foot)
    overlay.append(box)
    document.body.append(overlay)
    setTimeout(() => body.querySelector('input')?.focus(), 50)
  })
}

function confirmModal({ title, text, okLabel, danger }) {
  return modalOpen({
    title,
    bodyBuilder: b => {
      const p = document.createElement('div')
      p.className = 'cw-text'
      p.textContent = text
      b.append(p)
    },
    buttons: [
      { label: '取消', result: () => null },
      { label: okLabel || '确定', primary: !danger, danger: !!danger, result: () => true },
    ],
  })
}

function errorModal(title, text) {
  return modalOpen({
    title,
    bodyBuilder: b => {
      const pre = document.createElement('pre')
      pre.className = 'cw-pre'
      pre.textContent = text || '(无错误详情)'
      b.append(pre)
    },
    buttons: [{ label: '关闭', primary: true, result: () => null }],
  })
}

function editMetaModal(item, meta) {
  return modalOpen({
    title: '编辑壁纸信息',
    bodyBuilder: (b, box) => {
      const l1 = document.createElement('label')
      l1.className = 'cw-label'
      l1.textContent = '标题'
      box.title = document.createElement('input')
      box.title.type = 'text'
      box.title.className = 'cw-input'
      box.title.value = (meta && meta.title) || item.t || ''
      const l2 = document.createElement('label')
      l2.className = 'cw-label'
      l2.textContent = '标签（逗号分隔，如 custom,4K）'
      box.tags = document.createElement('input')
      box.tags.type = 'text'
      box.tags.className = 'cw-input'
      box.tags.value = ((meta && meta.tags) || item.tags || []).join(', ')
      b.append(l1, box.title, l2, box.tags)
    },
    buttons: [
      { label: '取消', result: () => null },
      {
        label: '保存', primary: true,
        result: box => ({
          title: box.title.value.trim(),
          tags: box.tags.value.split(/[,，]/).map(s => s.trim()).filter(Boolean),
        }),
      },
    ],
  })
}

// ── 索引任务状态轮询（浏览器窗打开期间每 1.2s 一次；任务结束自动重载列表）──
function setToolsDisabled(v) {
  if (!browserEl) return
  browserEl.querySelectorAll('.wb-tbtn').forEach(b => { b.disabled = v })
}

function setBrowserStatus(text) {
  const el = browserEl?.querySelector('.wb-status')
  if (!el) return
  el.textContent = text || ''
  el.closest('.wb-statusrow')?.classList.toggle('show', !!text)
}

function setWeMyprojectsHint(show) {
  browserEl?.querySelector('.wb-wehint')?.classList.toggle('show', !!show)
}

function doneStatusText(st) {
  return `✓ 完成：共 ${st.total} 个项目 · 有效 ${st.valid} · 新增 ${st.added} · 跳过无效 ${st.skipped}`
}

async function pollIndexStatus() {
  if (!browserEl || !browserEl.isConnected) { stopIndexPolling(); return }
  let st
  try {
    st = await api('/status')
  } catch (e) {
    setBrowserStatus('后端未就绪：' + apiErrorText(e))
    setToolsDisabled(true)
    return
  }
  setWeMyprojectsHint(st.is_we_myprojects)
  if (st.running) {
    if (!indexRunningSeen) setToolsDisabled(true)
    indexRunningSeen = true
    setBrowserStatus(st.trigger === 'upload' ? '⏳ 扫描中…（上传触发）' : '⏳ 扫描中…')
    return
  }
  const justFinished = indexRunningSeen
  indexRunningSeen = false
  setToolsDisabled(false)
  if (justFinished && st.error) {
    errorModal('索引构建失败（完整错误日志）', st.error)
    setBrowserStatus('上次构建失败，点【刷新壁纸索引】重试')
    return
  }
  // 只要存在比上次重载更新的构建结果就从磁盘重载。
  // 不能依赖 running→false 过渡：本地小库构建常在首次轮询（1.2s）之前就已完成，过渡检测会漏掉。
  if (st.finished_at && st.finished_at > lastReloadedFinishedAt) {
    lastReloadedFinishedAt = st.finished_at
    await reloadIndexFromDisk()
    if (justFinished) log('索引已刷新：' + JSON.stringify(st.last))
  }
  if (st.error) setBrowserStatus('上次构建失败，点【刷新壁纸索引】重试')
  else if (st.last) setBrowserStatus(doneStatusText(st.last))
  else if (!st.library) setBrowserStatus('未配置壁纸库根目录：到设置面板填写')
  else if (!weIndex || !weIndex.n) setBrowserStatus('索引缺失或为空：点上方【刷新壁纸索引】生成')
}

function startIndexPolling() {
  if (indexPollTimer) return
  indexPollTimer = setInterval(pollIndexStatus, 1200)
  pollIndexStatus()
}

function stopIndexPolling() {
  if (indexPollTimer) { clearInterval(indexPollTimer); indexPollTimer = null }
}

let indexRunningSeen = false
let lastReloadedFinishedAt = 0   // 上次从磁盘重载列表时的构建完成时间戳

async function onRefreshIndexClick() {
  setToolsDisabled(true)
  try {
    const r = await api('/index/refresh', { method: 'POST', body: { plugin_dir: PLUGIN_DIR } })
    log('索引刷新已启动' + (r.queued ? '（已有任务进行中，结束后自动补跑）' : ''))
    startIndexPolling()
  } catch (e) {
    setToolsDisabled(false)
    errorModal('无法启动索引构建', apiErrorText(e))
  }
}

async function onUploadWallpaper() {
  const pick = window.hermesDesktop?.selectPaths
  if (typeof pick !== 'function') {
    errorModal('上传不可用', '当前环境不支持系统文件选择对话框')
    return
  }
  let paths
  try {
    paths = await pick({
      title: '选择壁纸文件（jpg / png / mp4，单选）',
      multiple: false,
      filters: [{ name: '壁纸文件', extensions: ['jpg', 'jpeg', 'png', 'mp4'] }],
    })
  } catch {
    return
  }
  const src = Array.isArray(paths) ? paths[0] : paths
  if (!src || typeof src !== 'string') return
  setToolsDisabled(true)
  setBrowserStatus('⏳ 上传处理中…')
  try {
    const r = await api('/wallpaper/upload', { method: 'POST', body: { src_path: src, plugin_dir: PLUGIN_DIR } })
    const warn = (r.warnings && r.warnings.length) ? '；警告：' + r.warnings.join('；') : ''
    log(`上传成功：${r.folder}（${r.title}）` + warn)
    setBrowserStatus(`✓ 已入库：${r.title}（${r.folder}）` + (r.preview ? '' : '（无预览图）'))
    if (warn) errorModal('上传完成，但有警告', warn)
    startIndexPolling()   // 后端已自动触发刷新，轮询接管并重载列表
  } catch (e) {
    setToolsDisabled(false)
    setBrowserStatus('')
    errorModal('上传失败', apiErrorText(e))
  }
}

async function onDeleteWallpaper(it) {
  const ok = await confirmModal({
    title: '删除壁纸',
    text: `确定删除「${it.t}」吗？该壁纸文件夹会被物理永久删除，如果是 Wallpaper Engine 库，该壁纸也将从本地移除。`,
    okLabel: '永久删除',
    danger: true,
  })
  if (!ok) return
  try {
    await api('/wallpaper/delete', { method: 'POST', body: { id: it.id, plugin_dir: PLUGIN_DIR } })
    log('已物理删除壁纸：' + it.id)
    await reloadIndexFromDisk()
    startIndexPolling()
  } catch (e) {
    errorModal('删除失败', apiErrorText(e))
  }
}

async function onEditWallpaper(it) {
  let meta = null
  try {
    meta = await api(`/wallpaper/meta?id=${encodeURIComponent(it.id)}&plugin_dir=${encodeURIComponent(PLUGIN_DIR)}`)
  } catch { /* 读不到 project.json 就用索引里的标题兜底 */ }
  const res = await editMetaModal(it, meta)
  if (!res) return
  try {
    await api('/wallpaper/meta', { method: 'POST', body: { id: it.id, title: res.title, tags: res.tags, plugin_dir: PLUGIN_DIR } })
    log('已更新元数据：' + it.id)
    await reloadIndexFromDisk()
    startIndexPolling()
  } catch (e) {
    errorModal('保存失败', apiErrorText(e))
  }
}

/** 把后端配置的壁纸库根目录回填到设置面板（含 Program Files 权限提示逻辑联动） */
async function loadLibraryConfigIntoPanel() {
  if (!panelEl || !panelEl.isConnected) return
  const input = panelEl.querySelector('.wp-libinput')
  const hint = panelEl.querySelector('.wp-libhint-status')
  const pf = panelEl.querySelector('.wp-libhint-pf')
  try {
    const cfg = await api('/library/config')
    const val = cfg.library_dir || cfg.resolved || ''
    if (input && !libCfgTouched) input.value = val
    if (pf) pf.style.display = /Program Files/i.test(input ? input.value : val) ? '' : 'none'
    if (hint) {
      hint.textContent = !cfg.resolved
        ? '尚未配置：将自动探测 Wallpaper Engine 目录'
        : (cfg.source === 'config' ? '✓ 使用已保存的库目录' : '当前自动探测到 WE 目录，保存后固定为你填写的路径')
    }
  } catch (e) {
    if (hint) hint.textContent = '后端未就绪：' + apiErrorText(e)
  }
}

// ── Wallpaper Engine 壁纸库 ──
const TYPE_LABEL = { scene: '动态场景', web: '网页', video: '视频', application: '应用', image: '图片' }

function weFullSrc(item) {
  if (item.hd) return joinPath(PLUGIN_DIR, item.hd)
  if (!item.p) return null
  return joinPath(joinPath(weIndex.we, item.id), item.p)
}

function weThumbSrc(item) {
  if (item.th) return joinPath(PLUGIN_DIR, item.th)
  if (!item.p || !weIndex?.we) return null
  return joinPath(joinPath(weIndex.we, item.id), item.p)   // 缺缩略图时直接用预览图兜底，卡片永不空白
}

async function openWeBrowser() {
  if (!weIndex) {
    const bridge = window.hermesDesktop?.readFileText
    if (typeof bridge !== 'function' || !INDEX_PATH) { log('!!! 无法读索引'); return }
    try {
      const res = await bridge(INDEX_PATH)
      weIndex = JSON.parse(res.text ?? res)
    } catch (e) {
      log('索引不存在或读取失败: ' + (e?.message || e))
      weIndex = { we: '', n: 0, items: [] }   // 不再死路拦截：打开空库，让用户能直接点【刷新壁纸索引】自修复
    }
  }
  buildWeBrowser()
  browserEl.classList.add('open')
  wePage = 0
  renderWeGrid('')
  setTimeout(() => browserEl.querySelector('.wb-search')?.focus(), 50)
  log('壁纸库浏览窗打开（' + weIndex.n + ' 张）')
}

function buildWeBrowser() {
  document.getElementById(BROWSER_ID)?.remove()
  browserEl = document.createElement('div')
  browserEl.id = BROWSER_ID
  browserEl.innerHTML = `
    <div class="wb-head">
      <span class="wb-title">壁纸库（${weIndex.n}）</span>
      <input class="wb-search" type="text" placeholder="搜索壁纸名…" spellcheck="false">
      <button class="wb-tbtn" type="button" id="${BROWSER_ID}-refresh" title="重新扫描壁纸库目录并重建索引">
        <i class="codicon codicon-refresh" aria-hidden="true"></i><span>刷新壁纸索引</span>
      </button>
      <button class="wb-tbtn" type="button" id="${BROWSER_ID}-upload" title="从本机选择 jpg / png / mp4 文件入库（自动建目录、生成预览与元数据）">
        <i class="codicon codicon-cloud-upload" aria-hidden="true"></i><span>上传壁纸文件</span>
      </button>
      <button class="wb-close" type="button" aria-label="关闭" title="关闭">
        <i class="codicon codicon-close" aria-hidden="true"></i>
      </button>
    </div>
    <div class="wb-statusrow"><span class="wb-status"></span></div>
    <div class="wb-wehint">⚠ Wallpaper Engine 客户端不会自动刷新，请手动打开 Wallpaper Engine 软件，点击软件内刷新按钮才能看到新增/移除后的变化</div>
    <div class="wb-grid"></div>
    <div class="wb-pager"></div>
  `
  browserEl.querySelector('.wb-close').addEventListener('click', () => browserEl.classList.remove('open'))
  browserEl.querySelector(`#${BROWSER_ID}-refresh`).addEventListener('click', onRefreshIndexClick)
  browserEl.querySelector(`#${BROWSER_ID}-upload`).addEventListener('click', onUploadWallpaper)
  const search = browserEl.querySelector('.wb-search')
  let timer = null
  search.addEventListener('input', () => {
    clearTimeout(timer)
    timer = setTimeout(() => { wePage = 0; renderWeGrid(search.value.trim()) }, 150)
  })
  document.body.append(browserEl)
  indexRunningSeen = false
  startIndexPolling()   // 打开即恢复状态轮询（后台有任务则接管展示与重载）
}

const PAGE_SIZE = 40

function aspectRatio(w, h) {
  if (!w || !h) return ''
  const gcd = (a, b) => b ? gcd(b, a % b) : a
  const g = gcd(w, h)
  const rw = w / g, rh = h / g
  return rw <= 40 && rh <= 40 ? `${rw}:${rh}` : (w / h).toFixed(2)
}

function renderWeGrid(needle) {
  const grid = browserEl.querySelector('.wb-grid')
  const pager = browserEl.querySelector('.wb-pager')
  const items = weIndex.items.filter(it =>
    !needle || it.t.toLowerCase().includes(needle.toLowerCase())
  )
  grid.innerHTML = ''
  pager.innerHTML = ''
  if (items.length === 0) {
    const empty = document.createElement('div')
    empty.className = 'wb-empty'
    empty.textContent = needle ? '没有匹配「' + needle + '」的壁纸' : '壁纸库是空的：点上方【上传壁纸文件】添加，或【刷新壁纸索引】重新扫描'
    grid.append(empty)
    return
  }
  const pages = Math.ceil(items.length / PAGE_SIZE)
  if (wePage >= pages) wePage = pages - 1
  const from = wePage * PAGE_SIZE
  renderWePage(grid, items.slice(from, from + PAGE_SIZE))
  buildPager(pager, wePage, pages, p => { wePage = p; renderWeGrid(needle) })
}

function buildPager(pager, page, pages, go) {
  const btn = (label, target, disabledFlag, isCurrent) => {
    const b = document.createElement('button')
    b.type = 'button'
    b.className = 'wb-page' + (isCurrent ? ' cur' : '')
    b.textContent = label
    b.disabled = disabledFlag
    b.addEventListener('click', () => go(target))
    pager.append(b)
  }
  const prev = document.createElement('button')
  prev.type = 'button'
  prev.className = 'wb-page'
  prev.innerHTML = '<i class="codicon codicon-chevron-left" aria-hidden="true"></i>'
  prev.disabled = page === 0
  prev.title = '上一页'
  prev.addEventListener('click', () => go(page - 1))
  pager.append(prev)

  const win = []
  for (let p = 1; p <= pages; p++) {
    if (p === 1 || p === pages || Math.abs(p - 1 - page) <= 2) win.push(p)
  }
  let last = 0
  for (const p of win) {
    if (p - last > 1) {
      const dots = document.createElement('span')
      dots.className = 'wb-dots'
      dots.textContent = '…'
      pager.append(dots)
    }
    btn(String(p), p - 1, false, p - 1 === page)
    last = p
  }

  const next = document.createElement('button')
  next.type = 'button'
  next.className = 'wb-page'
  next.innerHTML = '<i class="codicon codicon-chevron-right" aria-hidden="true"></i>'
  next.disabled = page >= pages - 1
  next.title = '下一页'
  next.addEventListener('click', () => go(page + 1))
  pager.append(next)

  const done = document.createElement('button')
  done.type = 'button'
  done.className = 'wb-done'
  done.innerHTML = '<i class="codicon codicon-check" aria-hidden="true"></i><span>完成</span>'
  done.title = '用当前壁纸，关闭浏览窗'
  done.addEventListener('click', () => {
    browserEl?.classList.remove('open')
    panelEl?.classList.remove('open')
  })
  pager.append(done)
}

function renderWePage(grid, items) {
  const queue = []
  let active = 0
  const MAX = 6
  function pump() {
    while (active < MAX && queue.length > 0) {
      const { img, src } = queue.shift()
      active++
      const bridge = window.hermesDesktop?.readFileDataUrl
      if (typeof bridge !== 'function') { active--; continue }
      bridge(src)
        .then(dataUrl => { if (img.isConnected) img.src = dataUrl })
        .catch(() => {})
        .finally(() => { active--; pump() })
    }
  }
  const io = new IntersectionObserver(entries => {
    for (const en of entries) {
      if (!en.isIntersecting) continue
      const img = en.target
      io.unobserve(img)
      const src = img.dataset.src
      if (src) { queue.push({ img, src }); pump() }
    }
  }, { root: grid, rootMargin: '300px' })

  for (const it of items) {
    const card = document.createElement('div')
    card.className = 'wb-card'
    card.setAttribute('role', 'button')
    card.setAttribute('tabindex', '0')
    card.title = it.t
    card.dataset.wid = it.id
    const thumbSrc = weThumbSrc(it)
    const typeLabel = TYPE_LABEL[it.y] || it.y || '壁纸'
    const resText = it.w ? `${it.w}×${it.h}` : ''
    const arText = aspectRatio(it.w, it.h)
    card.innerHTML = `
      <img class="wb-thumb" alt="" ${thumbSrc ? `data-src="${thumbSrc}"` : ''}
        style="width:100%;height:84px;object-fit:cover;display:block;flex:none">
      <div class="wb-meta">
        <div class="wb-name">${it.t.replace(/</g, '&lt;')}${it.hd ? ' <span class="wb-hd">HD</span>' : ''}</div>
        <div class="wb-type">${typeLabel}${resText ? ` · ${resText}${arText ? ` · ${arText}` : ''}` : ''}</div>
      </div>
    `
    const pick = () => applyWeWallpaper(it, card)
    card.addEventListener('click', pick)
    card.addEventListener('keydown', e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); pick() } })
    const acts = document.createElement('div')
    acts.className = 'wb-acts'
    const editBtn = document.createElement('button')
    editBtn.type = 'button'
    editBtn.className = 'wb-act'
    editBtn.title = '编辑标题/标签'
    editBtn.innerHTML = '<i class="codicon codicon-edit" aria-hidden="true"></i>'
    editBtn.addEventListener('click', ev => { ev.stopPropagation(); onEditWallpaper(it) })
    const delBtn = document.createElement('button')
    delBtn.type = 'button'
    delBtn.className = 'wb-act'
    delBtn.title = '删除（物理删除文件夹）'
    delBtn.innerHTML = '<i class="codicon codicon-trash" aria-hidden="true"></i>'
    delBtn.addEventListener('click', ev => { ev.stopPropagation(); onDeleteWallpaper(it) })
    acts.append(editBtn, delBtn)
    card.append(acts)
    grid.append(card)
    const img = card.querySelector('.wb-thumb')
    if (thumbSrc) io.observe(img)
  }
  markActiveCard(grid)
}

function markActiveCard(grid) {
  if (!grid || !currentWeId) return
  grid.querySelectorAll('.wb-card').forEach(c => {
    const on = c.dataset.wid === currentWeId
    c.classList.toggle('wb-active', on)
    if (on && !c.querySelector('.wb-using')) {
      const tag = document.createElement('span')
      tag.className = 'wb-using'
      tag.textContent = '✓ 使用中'
      c.querySelector('.wb-meta')?.append(tag)
    }
  })
}

async function applyWeWallpaper(it, card) {
  const src = weFullSrc(it)
  if (!src) { log('!!! 这张壁纸没有可用的预览图'); return }
  log('选用 WE 壁纸（预览不关窗）: ' + it.t)
  const bridge = window.hermesDesktop?.readFileDataUrl
  if (typeof bridge !== 'function') return
  try {
    const dataUrl = await bridge(src)
    const blob = await (await fetch(dataUrl)).blob()
    storage?.set('srcPath', src)
    currentWeId = it.id
    disabled = false
    storage?.set('disabled', false)
    applyWallpaperBlob(blob, it.t)
    repaint()
    const grid = browserEl?.querySelector('.wb-grid')
    if (grid) {
      grid.querySelectorAll('.wb-using').forEach(t => t.remove())
      grid.querySelectorAll('.wb-active').forEach(c => c.classList.remove('wb-active'))
      if (card) {
        card.classList.add('wb-active')
        const tag = document.createElement('span')
        tag.className = 'wb-using'
        tag.textContent = '✓ 使用中'
        card.querySelector('.wb-meta')?.append(tag)
      }
    }
  } catch (e) {
    log('!!! 应用 WE 壁纸失败: ' + (e?.message || e))
  }
}

// ── 顶栏按钮（类名实时拷贝原生，保证风格一致）──
function findRightCluster() {
  for (const el of document.querySelectorAll('div.fixed.z-70')) {
    if (typeof el.className === 'string' && el.className.includes('right-(')) return el
  }
  return null
}

function openPanel(btn) {
  const r = btn.getBoundingClientRect()
  const W = 280
  panelEl.style.top = (r.bottom + 6) + 'px'
  panelEl.style.left = Math.max(8, Math.min(r.left, window.innerWidth - W - 8)) + 'px'
  panelEl.classList.add('open')
}

function onBtnClick(e) {
  e.stopPropagation()
  if (panelEl.classList.contains('open')) {
    panelEl.classList.remove('open')
  } else {
    openPanel(e.currentTarget)
  }
}

function ensureButton() {
  if (disposed) return
  const existing = document.getElementById(UI_ID)
  const cluster = findRightCluster()
  if (existing) {
    if (cluster && existing.parentElement === cluster && cluster.firstElementChild === existing) return
    existing.remove()
  }
  if (!cluster) return
  const firstBtn = cluster.querySelector('button')
  if (!firstBtn) return
  const btn = document.createElement('button')
  btn.id = UI_ID
  btn.type = 'button'
  btn.className = firstBtn.className
  btn.title = '壁纸设置'
  btn.setAttribute('aria-label', '壁纸设置')
  btn.innerHTML = '<i class="codicon codicon-symbol-color leading-none" aria-hidden="true" style="font-size:13.9px"></i>'
  btn.addEventListener('click', onBtnClick)
  btn.addEventListener('pointerdown', ev => ev.stopPropagation())
  cluster.insertBefore(btn, cluster.firstChild)
  if (!insertedOnce) {
    insertedOnce = true
    log('按钮已插入顶栏原生排第一位')
  }
}

const OVERLAY_PREFIXES = ['/settings', '/command-center', '/agents', '/cron', '/profiles', '/starmap', '/webhooks']

function currentPath() {
  return (window.location.hash || '').replace(/^#/, '').split(/[?#]/, 1)[0] || '/'
}

export default {
  id: 'chat-wallpaper',
  name: 'Chat Wallpaper',
  description: '自定义背景壁纸：配色自动跟随壁纸，顶栏设置按钮，支持 Wallpaper Engine 壁纸库',
  async register(ctx) {
    storage = ctx.storage
    ctxRef = ctx
    params = {
      dim: ctx.storage.get('dim', DEFAULTS.dim),
      bubble: ctx.storage.get('bubble', DEFAULTS.bubble),
      card: ctx.storage.get('card', DEFAULTS.card),
      darken: ctx.storage.get('darken', DEFAULTS.darken),
    }
    disabled = ctx.storage.get('disabled', false) === true

    const dir = await resolvePluginDir()
    if (!dir) {
      console.warn('[chat-wallpaper] 无法定位插件目录，壁纸功能不可用')
      return
    }
    log('插件已加载；目录 ' + PLUGIN_DIR + '；参数 ' + JSON.stringify(params))

    document.getElementById(STYLE_ID)?.remove()
    styleEl = document.createElement('style')
    styleEl.id = STYLE_ID
    document.head.append(styleEl)
    repaint()

    document.getElementById(PANEL_ID)?.remove()
    panelEl = buildPanel()
    document.body.append(panelEl)
    loadLibraryConfigIntoPanel().catch(() => {})   // 回填壁纸库根目录配置（后端未就绪则静默）

    escClose = e => {
      if (e.key === 'Escape') {
        panelEl?.classList.remove('open')
        browserEl?.classList.remove('open')
      }
    }
    document.addEventListener('keydown', escClose)

    onOutsideClick = e => {
      if (browserEl?.classList.contains('open') && !browserEl.contains(e.target)) {
        const weBtn = document.getElementById(`${PANEL_ID}-we`)
        if (weBtn && weBtn.contains(e.target)) return
        browserEl.classList.remove('open')
        return
      }
      if (!panelEl.classList.contains('open')) return
      if (panelEl.contains(e.target)) return
      const btn = document.getElementById(UI_ID)
      if (btn && btn.contains(e.target)) return
      panelEl.classList.remove('open')
    }
    document.addEventListener('pointerdown', onOutsideClick)

    onHashChange = () => {
      const p = currentPath()
      if (OVERLAY_PREFIXES.some(pre => p === pre || p.startsWith(pre + '/'))) {
        panelEl?.classList.remove('open')
        browserEl?.classList.remove('open')
      }
    }
    window.addEventListener('hashchange', onHashChange)

    ensureButton()
    keepAliveTimer = setInterval(ensureButton, 900)

    const bridge = window.hermesDesktop?.readFileDataUrl
    if (typeof bridge !== 'function') {
      log('!!! 桥接不存在，无法读图')
      return
    }
    // 启动壁纸来源：上次选的图优先，否则插件目录里的 bg.jpg
    const lastPicked = ctx.storage.get('srcPath', null)
    const bootPath = typeof lastPicked === 'string' && lastPicked ? lastPicked : IMG_PATH
    const tryBoot = path =>
      bridge(path)
        .then(async dataUrl => {
          if (disposed) return
          const blob = await (await fetch(dataUrl)).blob()
          applyWallpaperBlob(blob, path)
        })
    tryBoot(bootPath).catch(err => {
      if (bootPath !== IMG_PATH) {
        log('上次选的图读不到，退回 bg.jpg: ' + (err?.message || err))
        tryBoot(IMG_PATH).catch(err2 => {
          // 一张壁纸都没有：保持默认外观，不注入半透明层
          log('没有可用壁纸（bg.jpg 不存在）：保持默认外观。' + (err2?.message || ''))
          disabled = true
          repaint()
        })
      } else {
        log('没有可用壁纸（bg.jpg 不存在）：保持默认外观。' + (err?.message || ''))
        disabled = true
        repaint()
      }
    })

    ctx.onDispose(() => {
      disposed = true
      log('插件被卸载/重载')
      if (keepAliveTimer) clearInterval(keepAliveTimer)
      if (onOutsideClick) document.removeEventListener('pointerdown', onOutsideClick)
      if (escClose) document.removeEventListener('keydown', escClose)
      if (onHashChange) window.removeEventListener('hashchange', onHashChange)
      if (objectUrl) URL.revokeObjectURL(objectUrl)
      objectUrl = null
      styleEl?.remove()
      styleEl = null
      panelEl?.remove()
      panelEl = null
      browserEl?.remove()
      browserEl = null
      weIndex = null
      document.getElementById(UI_ID)?.remove()
    })
  }
}
