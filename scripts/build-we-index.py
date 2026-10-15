#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
生成 Wallpaper Engine 壁纸库索引（we-index.json）

用法（向后兼容，参数均可省略）:
    python build-we-index.py [插件目录] [WE壁纸库目录]

路径解析优先级：命令行参数 > 库配置 library_config.json（插件设置页保存）
> 自动探测 WE 目录（find_we_dir）。

被 dashboard/plugin_api.py 以模块方式复用（scan_we_dir / build_index）。
依赖: 无（缩略图由 gen-thumbs.py 负责，需要 Pillow）
"""
import os
import sys
import json
import tempfile
from pathlib import Path

# 库配置（插件设置页写入），与本脚本同属一个包：../library_config.json
PKG_ROOT = Path(__file__).resolve().parent.parent
CONFIG_PATH = PKG_ROOT / "library_config.json"


def find_we_dir():
    """尝试自动定位 WE 的 workshop 内容目录（找不到则要求手动传参）"""
    candidates = []
    for drive in "CDEFGH":
        for lib in (f"{drive}:/SteamLibrary", f"{drive}:/Program Files (x86)/Steam", f"{drive}:/steam"):
            candidates.append(f"{lib}/steamapps/workshop/content/431960")
    for c in candidates:
        if os.path.isdir(c):
            return c
    return None


def load_config():
    """读取插件设置页保存的壁纸库根目录（无效/缺失返回空串）"""
    try:
        data = json.loads(CONFIG_PATH.read_text(encoding="utf-8"))
        lib = data.get("library_dir")
        return lib.strip() if isinstance(lib, str) and lib.strip() else ""
    except Exception:
        return ""


def scan_we_dir(we_dir):
    """扫描壁纸库目录（沿用原 build-we-index.py 的解析逻辑）。

    返回 (items, stats)：
      items — 索引条目列表 [{id,t,p,y}]
      stats — {total: 扫描到的项目文件夹总数,
               valid: 识别为有效壁纸的数量,
               skipped: project.json 缺失/不可解析被跳过的数量,
               skipped_ids: 被跳过的文件夹名列表}
    """
    items = []
    skipped_ids = []
    total = 0
    for pid in os.listdir(we_dir):
        d = os.path.join(we_dir, pid)
        if not os.path.isdir(d):
            continue
        total += 1
        pj = os.path.join(d, "project.json")
        try:
            meta = json.load(open(pj, encoding="utf-8", errors="replace"))
        except Exception:
            skipped_ids.append(pid)
            continue
        title = meta.get("title") or pid
        preview = meta.get("preview") or ""
        if preview and not os.path.exists(os.path.join(d, preview)):
            preview = ""
        if not preview:
            for alt in ("preview.jpg", "preview.gif", "preview.png"):
                if os.path.exists(os.path.join(d, alt)):
                    preview = alt
                    break
        items.append({
            "id": pid,
            "t": title,
            "p": preview,
            "y": (meta.get("type") or "").lower(),
        })
    items.sort(key=lambda x: x["t"].lower())
    stats = {
        "total": total,
        "valid": len(items),
        "skipped": len(skipped_ids),
        "skipped_ids": skipped_ids,
    }
    return items, stats


def atomic_write_json(path, obj):
    """临时文件 + os.replace 原子落盘，杜绝半写损坏索引/元数据"""
    path = Path(path)
    fd, tmp = tempfile.mkstemp(dir=str(path.parent), prefix=".tmp-", suffix=".json")
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as f:
            json.dump(obj, f, ensure_ascii=False)
            f.flush()
            os.fsync(f.fileno())
        os.replace(tmp, str(path))
    except Exception:
        try:
            os.unlink(tmp)
        except OSError:
            pass
        raise


def _previous_ids(out_path):
    try:
        old = json.loads(Path(out_path).read_text(encoding="utf-8"))
        return {it.get("id") for it in old.get("items", []) if it.get("id")}
    except Exception:
        return set()


def build_index(we_dir=None, out_path=None):
    """构建索引并原子写入 out_path。

    we_dir 省略时：库配置 > find_we_dir()。
    返回 stats（含 added 新增壁纸数量）。目录不存在抛 FileNotFoundError。
    """
    if not out_path:
        raise ValueError("缺少索引输出路径 out_path")
    we_dir = (we_dir or load_config() or find_we_dir() or "").strip()
    if not we_dir or not os.path.isdir(we_dir):
        raise FileNotFoundError("壁纸库目录不存在：" + str(we_dir))
    items, stats = scan_we_dir(we_dir)
    old = _previous_ids(out_path)
    added_ids = [it["id"] for it in items if it["id"] not in old]
    payload = {"we": we_dir.replace("\\", "/"), "n": len(items), "items": items}
    atomic_write_json(out_path, payload)
    stats.update({
        "we": we_dir,
        "added": len(added_ids),
        "added_ids": added_ids,
    })
    return stats


def main():
    args = sys.argv[1:]
    if len(args) >= 2:
        plugin_dir, we_dir = args[0], args[1]
    elif len(args) == 1:
        plugin_dir, we_dir = args[0], None  # we_dir 走配置/自动探测
    else:
        print(__doc__)
        sys.exit(1)
    out = os.path.join(plugin_dir, "we-index.json")
    try:
        stats = build_index(we_dir=we_dir, out_path=out)
    except FileNotFoundError as e:
        print(str(e) + "（请在插件设置页填写壁纸库根目录，或作为第二个参数传入）")
        sys.exit(1)
    print(f"WE 库: {stats['we']}")
    print(
        f"索引已生成: {out}（扫描 {stats['total']} 个项目，有效壁纸 {stats['valid']}，"
        f"新增 {stats['added']}，跳过无效 {stats['skipped']}）"
    )
    print("下一步（可选）: 运行 gen-thumbs.py 和 extract-hd.py 提升浏览体验")


if __name__ == "__main__":
    main()
