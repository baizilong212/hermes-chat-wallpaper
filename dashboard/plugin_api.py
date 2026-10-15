# -*- coding: utf-8 -*-
"""Chat Wallpaper 后端（挂在 /api/plugins/chat-wallpaper/ 下）。

职责：
- 壁纸库根目录配置（持久化到包目录 library_config.json，build-we-index.py 直接读取）
- 后台异步刷新索引（复用 scripts/build-we-index.py 的扫描逻辑；线程锁防并发；
  临时文件 + os.replace 原子写索引；完成后前端轮询 /status 即可热更新列表）
- 上传壁纸（原生文件选择由渲染层 selectPaths 完成，这里做校验/建目录/落盘/
  生成预览图/写 project.json/自动触发刷新）
- 删除壁纸（物理删除整个项目文件夹）、编辑元数据（标题/标签）

索引输出位置 = 渲染层插件目录（desktop-plugins/<id>/we-index.json），
由前端随请求传入并做服务端校验，保持与原有渲染层读取路径完全一致。
"""
import importlib.util
import json
import os
import re
import shutil
import subprocess
import threading
import time
import traceback
from datetime import datetime
from pathlib import Path

from fastapi import APIRouter, HTTPException

router = APIRouter()

PKG_ROOT = Path(__file__).resolve().parent.parent        # plugins/chat-wallpaper
SCRIPTS_DIR = PKG_ROOT / "scripts"
CONFIG_PATH = PKG_ROOT / "library_config.json"

IMAGE_EXTS = {".jpg", ".jpeg", ".png"}
VIDEO_EXTS = {".mp4"}
ALLOWED_EXTS = IMAGE_EXTS | VIDEO_EXTS
MAX_IMAGE_BYTES = 32 * 1024 * 1024        # 图片上限 32MB
MAX_VIDEO_BYTES = 256 * 1024 * 1024       # 视频上限 256MB（防超大文件）

_ILLEGAL_CHARS = re.compile(r'[\\/:*?"<>|]')              # Windows 文件名非法字符
_TS_LIKE = re.compile(r"\d{8,}")                          # 长数字串（时间戳类）
_NOISE_TITLE = re.compile(
    r"(?i)^(?:img|dsc|dcim|vid|mvimg|pxl|photo|screen|screenshot|wechat|weixin|image|"
    r"图片|照片|屏幕截图|截图|微信图片)+\d*$"
)
_FOLDER_PREFIX_RE_TMPL = r"wallpaper_{day}_(\d{{3,}})"

_index_lock = threading.Lock()      # 索引构建防并发（非阻塞获取）
_upload_lock = threading.Lock()     # 上传防并发
_pending = {"flag": False, "plugin_dir": None}   # 构建期间又有变更 → 结束后补跑一次

_state = {
    "running": False,
    "trigger": None,
    "started_at": None,
    "finished_at": None,
    "last": None,        # 最近一次成功构建的统计
    "error": None,       # 最近一次失败的完整 traceback（前端弹窗展示）
}


# ---------------------------------------------------------------- 基础工具

def _load_index_module():
    """以模块方式加载 scripts/build-we-index.py，复用其扫描/构建逻辑。"""
    return _load_script_module("chat_wallpaper_build_we_index", "build-we-index.py")


def _load_gen_thumbs_module():
    """以模块方式加载 scripts/gen-thumbs.py，复用其缩略图生成逻辑。"""
    return _load_script_module("chat_wallpaper_gen_thumbs", "gen-thumbs.py")


def _load_script_module(mod_name, file_name):
    spec = importlib.util.spec_from_file_location(mod_name, str(SCRIPTS_DIR / file_name))
    if spec is None or spec.loader is None:
        raise RuntimeError(f"无法加载 {file_name}")
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


def _read_config():
    try:
        data = json.loads(CONFIG_PATH.read_text(encoding="utf-8"))
        lib = data.get("library_dir")
        return lib.strip() if isinstance(lib, str) and lib.strip() else ""
    except Exception:
        return ""


def _write_json_atomic(path, obj):
    _load_index_module().atomic_write_json(path, obj)


def _effective_library():
    """(目录, 来源 config/autodetect/unset)"""
    cfg = _read_config()
    if cfg:
        return cfg, "config"
    try:
        auto = _load_index_module().find_we_dir()
    except Exception:
        auto = None
    if auto:
        return auto, "autodetect"
    return "", "unset"


def _is_we_myprojects(path):
    try:
        parts = [p.lower() for p in Path(path).parts]
    except Exception:
        return False
    return bool(parts) and parts[-1] == "myprojects"


def _validate_plugin_dir(raw):
    """校验渲染层传来的插件目录：必须是 desktop-plugins 下的 chat-wallpaper/wallpaper。"""
    p = str(raw or "").strip()
    if not p:
        raise HTTPException(400, "缺少插件目录参数")
    pp = Path(p)
    if pp.name not in ("chat-wallpaper", "wallpaper"):
        raise HTTPException(400, "非法插件目录名：" + pp.name)
    try:
        resolved = pp.resolve()
    except OSError as e:
        raise HTTPException(400, f"路径非法：{e}")
    if "desktop-plugins" not in [x.lower() for x in resolved.parts]:
        raise HTTPException(400, "插件目录必须位于 desktop-plugins 下")
    if not resolved.is_dir():
        raise HTTPException(400, "插件目录不存在：" + str(resolved))
    return resolved


def _ensure_library():
    lib, source = _effective_library()
    if not lib:
        raise HTTPException(400, "未配置壁纸库根目录：请在插件设置面板中填写路径")
    if not os.path.isdir(lib):
        raise HTTPException(400, "壁纸库根目录不存在：" + lib)
    return lib, source


def _validate_wid(wid):
    """壁纸 ID = 库根目录下的直接子文件夹名，防路径穿越。"""
    wid = str(wid or "").strip()
    if not wid or wid in (".", "..") or not re.fullmatch(r'[^\\/:*?"<>|]+', wid):
        raise HTTPException(400, "非法壁纸 ID")
    return wid


def _resolve_wallpaper_dir(lib, wid):
    root = Path(lib).resolve()
    target = (root / wid).resolve()
    if target == root or root not in target.parents:
        raise HTTPException(400, "非法壁纸路径")
    if not target.is_dir():
        raise HTTPException(400, "壁纸文件夹不存在：" + wid)
    return target


def _fmt_mb(n):
    return f"{n / 1048576:.1f}MB"


# ---------------------------------------------------------------- 索引任务

def _run_index(plugin_dir, trigger):
    started = time.time()
    _state.update(running=True, trigger=trigger, started_at=started, error=None)
    try:
        lib, source = _effective_library()
        if not lib:
            raise RuntimeError("未配置壁纸库根目录：请在插件设置面板中填写路径")
        if not os.path.isdir(lib):
            raise RuntimeError("壁纸库根目录不存在：" + lib)
        out = str(Path(plugin_dir) / "we-index.json")
        stats = _load_index_module().build_index(we_dir=lib, out_path=out)
        # 缩略图纳入闭环：为缺 th 的条目增量生成（已存在的跳过），失败不影响索引
        try:
            t_ok, t_skip = _load_gen_thumbs_module().generate_thumbs(plugin_dir)
            stats["thumbs"] = {"ok": t_ok, "skipped": t_skip}
        except Exception:
            stats["thumbs"] = None
            stats["thumbs_error"] = traceback.format_exc(limit=2)
        stats.pop("added_ids", None)
        stats.pop("skipped_ids", None)
        stats["library"] = lib
        stats["source"] = source
        stats["is_we_myprojects"] = _is_we_myprojects(lib)
        stats["elapsed"] = round(time.time() - started, 2)
        _state["last"] = stats
        _state["error"] = None
    except Exception:
        _state["error"] = traceback.format_exc()
    finally:
        _state["running"] = False
        _state["finished_at"] = time.time()
        try:
            _index_lock.release()
        except RuntimeError:
            pass
        # 构建期间又有上传/删除 → 补跑一轮
        if _pending["flag"]:
            pd = _pending["plugin_dir"]
            _pending["flag"] = False
            _start_index(pd, "pending")


def _start_index(plugin_dir, trigger):
    """非阻塞拿锁；拿不到 → 记 pending，当前任务结束后补跑。返回是否立即启动。"""
    if _index_lock.acquire(blocking=False):
        threading.Thread(
            target=_run_index, args=(str(plugin_dir), trigger), daemon=True,
            name="chat-wallpaper-index",
        ).start()
        return True
    _pending["flag"] = True
    _pending["plugin_dir"] = str(plugin_dir)
    return False


# ---------------------------------------------------------------- 预览图

def _find_ffmpeg(lib_dir=None):
    """优先定位 Wallpaper Engine 自带 ffmpeg，其次 PATH。"""
    cands = []
    try:
        p = Path(lib_dir or "").resolve()
        for ancestor in [p] + list(p.parents)[:5]:
            cands.append(ancestor / "bin" / "ffmpeg.exe")
            cands.append(ancestor / "ffmpeg.exe")
    except Exception:
        pass
    for drive in "CDEFGH":
        cands.append(Path(f"{drive}:/Program Files (x86)/Steam/steamapps/common/wallpaper_engine/bin/ffmpeg.exe"))
        cands.append(Path(f"{drive}:/SteamLibrary/steamapps/common/wallpaper_engine/bin/ffmpeg.exe"))
        cands.append(Path(f"{drive}:/Program Files/wallpaper_engine/bin/ffmpeg.exe"))
    for c in cands:
        try:
            if c.is_file():
                return str(c)
        except OSError:
            continue
    return shutil.which("ffmpeg")


def _preview_via_ffmpeg(ffmpeg, media, out_tmp):
    proc = subprocess.run(
        [ffmpeg, "-y", "-i", str(media), "-frames:v", "1",
         "-vf", "scale=min(1920\\,iw):-2", str(out_tmp)],
        stdout=subprocess.DEVNULL, stderr=subprocess.PIPE, timeout=90,
    )
    return proc.returncode == 0 and out_tmp.is_file() and out_tmp.stat().st_size > 0


def _make_preview(folder, media, ext, lib_dir, warnings):
    """生成 preview.jpg（image: Pillow 缩放压缩；video: ffmpeg 截首帧）。

    任何失败都只记 warning 并返回降级结果，绝不抛异常阻断入库。
    返回 preview 字段值（"" 表示无预览图）。
    """
    final_jpg = folder / "preview.jpg"
    tmp = folder / ".preview-tmp.jpg"

    def _finish_from_tmp():
        os.replace(tmp, final_jpg)
        return "preview.jpg"

    if ext in IMAGE_EXTS:
        try:
            from PIL import Image
            im = Image.open(media)
            if getattr(im, "is_animated", False):
                im.seek(0)
            im = im.convert("RGB")
            if im.width > 1920:
                h = max(1, round(im.height * 1920 / im.width))
                im = im.resize((1920, h), Image.LANCZOS)
            im.save(tmp, "JPEG", quality=85)
            return _finish_from_tmp()
        except ImportError:
            warnings.append("未安装 Pillow，跳过图片缩放")
        except Exception as e:
            warnings.append(f"图片预览生成失败（文件可能损坏）：{e}")
            return ""

    # 视频（或 Pillow 不可用的图片）→ ffmpeg 截帧
    ff = _find_ffmpeg(lib_dir)
    if ff:
        try:
            if _preview_via_ffmpeg(ff, media, tmp):
                return _finish_from_tmp()
            warnings.append("ffmpeg 截帧失败：" + ff)
        except Exception as e:
            warnings.append(f"ffmpeg 截帧异常：{e}")
    else:
        warnings.append("未找到 ffmpeg（Wallpaper Engine 自带或 PATH 均无），无法生成视频预览图")

    # 降级：无预览图（视频）；jpg/png 退化为原图副本（不缩放）
    if ext in (".jpg", ".jpeg", ".png"):
        try:
            shutil.copy2(media, folder / ("preview.jpg" if ext != ".png" else "preview.png"))
            warnings.append("预览图未缩放（无 Pillow/ffmpeg），已用原图作预览")
            return "preview.jpg" if ext != ".png" else "preview.png"
        except Exception as e:
            warnings.append(f"预览图复制失败：{e}")
    return ""


# ---------------------------------------------------------------- 标题清洗

def _sanitize_title(filename):
    """原始文件名 → 壁纸标题：去后缀、去非法字符、去下划线/横杠、去时间戳串；
    全部无意义时 fallback 自定义壁纸-时间戳。"""
    name = str(filename)
    stem = name.rsplit(".", 1)[0] if "." in name else name   # 不用 Path.stem：避免 Windows 盘符误解析
    cleaned = _ILLEGAL_CHARS.sub("", stem)
    cleaned = re.sub(r"[_\-]+", "", cleaned)
    cleaned = _TS_LIKE.sub("", cleaned)
    cleaned = re.sub(r"\s+", " ", cleaned).strip()
    if not cleaned or _NOISE_TITLE.fullmatch(cleaned):
        return "自定义壁纸-" + datetime.now().strftime("%Y%m%d_%H%M%S")
    return cleaned


def _next_folder(root):
    """wallpaper_YYYYMMDD_001：扫描同日前缀取最大序号+1，目录已存在则继续递增。"""
    day = datetime.now().strftime("%Y%m%d")
    pat = re.compile(_FOLDER_PREFIX_RE_TMPL.format(day=re.escape(day)))
    max_seq = 0
    try:
        for entry in root.iterdir():
            m = pat.fullmatch(entry.name)
            if entry.is_dir() and m:
                max_seq = max(max_seq, int(m.group(1)))
    except OSError as e:
        raise HTTPException(500, f"读取壁纸库目录失败：{e}")
    for seq in range(max_seq + 1, max_seq + 10001):
        cand = root / f"wallpaper_{day}_{seq:03d}"
        if not cand.exists():
            return cand
    raise HTTPException(500, "当日壁纸序号已耗尽")


def _copy_atomic(src, dst):
    tmp = dst.with_name(dst.name + ".part")
    try:
        shutil.copy2(src, tmp)
        os.replace(tmp, dst)
    except Exception:
        try:
            tmp.unlink()
        except OSError:
            pass
        raise


# ---------------------------------------------------------------- 路由

@router.get("/status")
def status():
    lib, source = _effective_library()
    return {
        "running": _state["running"],
        "trigger": _state["trigger"],
        "started_at": _state["started_at"],
        "finished_at": _state["finished_at"],
        "last": _state["last"],
        "error": _state["error"],
        "library": lib,
        "library_source": source,
        "is_we_myprojects": _is_we_myprojects(lib),
        "limits": {
            "image_mb": MAX_IMAGE_BYTES // 1048576,
            "video_mb": MAX_VIDEO_BYTES // 1048576,
            "allowed": sorted(ALLOWED_EXTS),
        },
    }


@router.get("/library/config")
def get_library_config():
    lib, source = _effective_library()
    return {
        "library_dir": _read_config(),
        "resolved": lib,
        "source": source,
        "is_we_myprojects": _is_we_myprojects(lib),
    }


@router.post("/library/config")
def set_library_config(body: dict):
    lib = str(body.get("library_dir") or "").strip().strip('"')
    if not lib:
        raise HTTPException(400, "壁纸库根目录不能为空")
    if not os.path.isdir(lib):
        raise HTTPException(400, "目录不存在或不可访问：" + lib)
    try:
        _write_json_atomic(CONFIG_PATH, {"library_dir": lib, "updated_at": datetime.now().isoformat()})
    except PermissionError:
        raise HTTPException(500, "没有权限写入插件配置（权限不足）：" + str(CONFIG_PATH))
    except OSError as e:
        raise HTTPException(500, f"写入配置失败：{e}")
    return {"ok": True, "library_dir": lib, "is_we_myprojects": _is_we_myprojects(lib)}


@router.post("/index/refresh")
def refresh_index(body: dict):
    plugin_dir = _validate_plugin_dir(body.get("plugin_dir"))
    started = _start_index(plugin_dir, "manual")
    return {"ok": True, "started": started, "running": True, "queued": not started}


@router.post("/wallpaper/upload")
def upload_wallpaper(body: dict):
    src = str(body.get("src_path") or "").strip()
    plugin_dir = _validate_plugin_dir(body.get("plugin_dir"))
    if not src:
        raise HTTPException(400, "缺少上传文件路径")
    if not _upload_lock.acquire(blocking=False):
        raise HTTPException(409, "已有上传任务在进行中，请稍后再试")
    folder = None
    try:
        lib, _ = _ensure_library()
        sp = Path(src)
        try:
            if not sp.is_file():
                raise HTTPException(400, "源文件不存在或不可读：" + src)
            size = sp.stat().st_size
        except OSError as e:
            raise HTTPException(400, f"读取源文件失败：{e}")
        ext = sp.suffix.lower()
        if ext not in ALLOWED_EXTS:
            raise HTTPException(400, f"不支持的文件格式：{ext or '（无后缀）'}，仅支持 jpg / png / mp4")
        limit = MAX_VIDEO_BYTES if ext in VIDEO_EXTS else MAX_IMAGE_BYTES
        if size > limit:
            raise HTTPException(400, f"文件过大（{_fmt_mb(size)}），上限 {_fmt_mb(limit)}")
        if size == 0:
            raise HTTPException(400, "文件为空（0 字节）")

        title = _sanitize_title(sp.name)
        folder = _next_folder(Path(lib))
        try:
            folder.mkdir()
        except PermissionError:
            raise HTTPException(500, f"没有权限在库目录创建文件夹（Windows 权限不足）：{folder}")
        except OSError as e:
            raise HTTPException(500, f"创建壁纸文件夹失败：{e}")

        media = folder / sp.name
        try:
            _copy_atomic(sp, media)
        except PermissionError:
            raise HTTPException(500, "没有权限写入壁纸文件（权限不足）")
        except shutil.SameFileError:
            raise HTTPException(400, "源文件与目标相同")
        except OSError as e:
            raise HTTPException(500, f"保存壁纸文件失败：{e}")

        warnings = []
        try:
            preview = _make_preview(folder, media, ext, lib, warnings)
        except Exception as e:   # 预览失败绝不阻断入库
            preview = ""
            warnings.append(f"预览图生成异常：{e}")

        meta = {
            "title": title,
            "type": "image" if ext in IMAGE_EXTS else "video",
            "file": sp.name,
            "preview": preview,
            "tags": ["custom"],
            "description": "自定义上传壁纸",
        }
        try:
            _write_json_atomic(folder / "project.json", meta)
        except OSError as e:
            raise HTTPException(500, f"写入 project.json 失败：{e}")

        result = {
            "ok": True,
            "folder": folder.name,
            "title": title,
            "type": meta["type"],
            "preview": preview,
            "warnings": warnings,
        }
    except HTTPException:
        if folder is not None:
            shutil.rmtree(folder, ignore_errors=True)   # 失败不留半成品
        raise
    except Exception as e:
        if folder is not None:
            shutil.rmtree(folder, ignore_errors=True)
        raise HTTPException(500, f"上传失败：{e}\n{traceback.format_exc()}")
    finally:
        _upload_lock.release()

    _start_index(plugin_dir, "upload")   # 写入完成 → 自动后台刷新索引
    return result


@router.post("/wallpaper/delete")
def delete_wallpaper(body: dict):
    wid = _validate_wid(body.get("id"))
    plugin_dir = _validate_plugin_dir(body.get("plugin_dir"))
    lib, _ = _ensure_library()
    target = _resolve_wallpaper_dir(lib, wid)
    if not (target / "project.json").is_file():
        raise HTTPException(400, f"「{wid}」不是壁纸项目（缺少 project.json），已取消删除")
    try:
        shutil.rmtree(target)
    except PermissionError:
        raise HTTPException(500, "没有权限删除该文件夹（Windows 权限不足）：" + wid)
    except OSError as e:
        raise HTTPException(500, f"删除失败：{e}")
    _start_index(plugin_dir, "delete")
    return {"ok": True, "deleted": wid}


@router.get("/wallpaper/meta")
def get_wallpaper_meta(id: str, plugin_dir: str):
    """编辑弹窗回读：返回该壁纸 project.json 的完整元数据。"""
    wid = _validate_wid(id)
    _validate_plugin_dir(plugin_dir)
    lib, _ = _ensure_library()
    target = _resolve_wallpaper_dir(lib, wid)
    pj = target / "project.json"
    if not pj.is_file():
        raise HTTPException(400, f"「{wid}」缺少 project.json")
    try:
        meta = json.loads(pj.read_text(encoding="utf-8", errors="replace"))
    except Exception as e:
        raise HTTPException(400, f"读取 project.json 失败：{e}")
    return {
        "id": wid,
        "title": meta.get("title") or wid,
        "tags": meta.get("tags") or [],
        "type": (meta.get("type") or "").lower(),
        "file": meta.get("file") or "",
        "preview": meta.get("preview") or "",
        "description": meta.get("description") or "",
    }


@router.post("/wallpaper/meta")
def edit_wallpaper_meta(body: dict):
    wid = _validate_wid(body.get("id"))
    plugin_dir = _validate_plugin_dir(body.get("plugin_dir"))
    lib, _ = _ensure_library()
    target = _resolve_wallpaper_dir(lib, wid)
    pj = target / "project.json"
    if not pj.is_file():
        raise HTTPException(400, f"「{wid}」缺少 project.json，无法编辑")
    try:
        meta = json.loads(pj.read_text(encoding="utf-8", errors="replace"))
        if not isinstance(meta, dict):
            raise ValueError("project.json 内容不是 JSON 对象")
    except Exception as e:
        raise HTTPException(400, f"读取 project.json 失败：{e}")

    changed = False
    if "title" in body:
        title = str(body.get("title") or "").strip()
        if not title:
            raise HTTPException(400, "标题不能为空")
        title = _ILLEGAL_CHARS.sub("", title).strip()
        if not title:
            raise HTTPException(400, "标题清洗后为空，请输入有效标题")
        if title != meta.get("title"):
            meta["title"] = title
            changed = True
    if "tags" in body:
        raw_tags = body.get("tags")
        if isinstance(raw_tags, str):
            raw_tags = [t.strip() for t in re.split(r"[,，]", raw_tags)]
        if not isinstance(raw_tags, list):
            raise HTTPException(400, "标签格式错误")
        tags = []
        for t in raw_tags:
            t = str(t).strip()
            if t and t not in tags:
                tags.append(t[:32])
        if len(tags) > 16:
            raise HTTPException(400, "标签最多 16 个")
        if tags != meta.get("tags"):
            meta["tags"] = tags
            changed = True
    if not changed:
        return {"ok": True, "changed": False}
    try:
        _write_json_atomic(pj, meta)
    except PermissionError:
        raise HTTPException(500, "没有权限写入 project.json（权限不足）")
    except OSError as e:
        raise HTTPException(500, f"写入 project.json 失败：{e}")
    _start_index(plugin_dir, "edit")
    return {"ok": True, "changed": True, "title": meta.get("title"), "tags": meta.get("tags")}
