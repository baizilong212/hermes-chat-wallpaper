#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
为壁纸库生成小缩略图（thumbs/），让浏览窗秒开。
在索引构建之后运行（build-we-index.py 或插件内【刷新壁纸索引】）。

用法:
    python gen-thumbs.py <插件目录>

依赖: pip install pillow
"""
import os
import sys
import json
import tempfile

from PIL import Image


def _stale(out, src):
    """缩略图比源文件旧 → 视为过期（ID 复用/重传后的旧图必须重生成）。"""
    try:
        return os.path.getmtime(out) < os.path.getmtime(src)
    except OSError:
        return False


def _save_anim_thumb(src, out, w=360):
    """动图源（gif/animated webp）→ 小动图缩略图（animated webp，卡片/弹窗可播放）。"""
    im = Image.open(src)
    if not getattr(im, "is_animated", False):
        im.close()
        return False
    frames, durations = [], []
    pending = 0
    try:
        for i in range(getattr(im, "n_frames", 1)):
            im.seek(i)
            pending += int(im.info.get("duration", 100)) or 100
            if frames and pending < 100:
                continue                    # 丢帧但累计时长：缩略图封顶 ~10fps，控体积
            fr = im.convert("RGB")
            h = max(1, round(fr.height * w / fr.width))
            frames.append(fr.resize((w, h), Image.LANCZOS))
            durations.append(pending)
            pending = 0
    finally:
        im.close()
    if not frames:
        return False
    frames[0].save(out, "WEBP", save_all=True, append_images=frames[1:],
                   duration=durations, loop=0, quality=62)
    return True


def generate_thumbs(plugin_dir):
    """为索引中缺缩略图的壁纸生成 thumbs/<id>.jpg，并把 th 字段原子写回 we-index.json。

    返回 (ok, skip)：ok = 已有+新生成的数量，skip = 无预览图/解码失败被跳过的数量。
    任何单张失败都不影响整体。
    """
    plugin = str(plugin_dir)
    index = os.path.join(plugin, "we-index.json")
    data = json.load(open(index, encoding="utf-8"))
    thumbs = os.path.join(plugin, "thumbs")
    os.makedirs(thumbs, exist_ok=True)

    ok, skip = 0, 0
    for it in data["items"]:
        # 动图源（item.g）→ 动图缩略图 thumbs/<id>.webp：卡片/弹窗直接动起来
        g = it.get("g")
        folder_g = os.path.join(data["we"], it["id"], g) if g else None
        if folder_g and os.path.exists(folder_g):
            out_anim = os.path.join(thumbs, it["id"] + ".webp")
            try:
                if not os.path.exists(out_anim) or _stale(out_anim, folder_g):
                    _save_anim_thumb(folder_g, out_anim)
            except Exception:
                pass   # 动图缩略图失败 → 落到静态链兜底
            if os.path.exists(out_anim):
                it["th"] = "thumbs/" + it["id"] + ".webp"
                ok += 1
                continue
        out = os.path.join(thumbs, it["id"] + ".jpg")
        src = os.path.join(data["we"], it["id"], it["p"]) if it["p"] else None
        if os.path.exists(out) and src and os.path.exists(src) and not _stale(out, src):
            it["th"] = "thumbs/" + it["id"] + ".jpg"
            ok += 1
            continue
        if not src or not os.path.exists(src):
            skip += 1
            continue
        try:
            im = Image.open(src)
            if getattr(im, "is_animated", False):
                im.seek(0)
            im = im.convert("RGB")
            w = 360
            h = max(1, round(im.height * w / im.width))
            im = im.resize((w, h), Image.LANCZOS)
            im.save(out, "JPEG", quality=72)
            it["th"] = "thumbs/" + it["id"] + ".jpg"
            ok += 1
        except Exception:
            skip += 1

    # 孤儿缩略图清理：已删除素材的残留缩略图必须清掉（缩略图按 ID 命名，ID 会被复用，
    # 残留旧图会错配到新素材）。放在生成循环之后：凡不在当前索引里的缩略图一律删除。
    # 同素材双格式残留也要清：th 只引用 .jpg/.webp 其中之一（动图素材用 .webp、静态用 .jpg），
    # 另一个属于升级残留（如素材还是视频阶段生成的旧 jpg，转动图后已无用）。
    # 注意：本脚本每次索引都从包源现加载 —— 此修复无需重启应用即可生效。
    valid_ids = {it.get("id") for it in data["items"]}
    keep = {it.get("id"): os.path.basename(it["th"])
            for it in data["items"] if it.get("th")}
    try:
        for fn in os.listdir(thumbs):
            base, ext = os.path.splitext(fn)
            if ext.lower() not in (".jpg", ".webp"):
                continue
            if base not in valid_ids or (keep.get(base) and fn != keep[base]):
                try:
                    os.remove(os.path.join(thumbs, fn))
                except OSError:
                    pass
    except OSError:
        pass

    # 原子写回带 th 的索引
    fd, tmp = tempfile.mkstemp(dir=plugin, prefix=".tmp-thumbs-", suffix=".json")
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as f:
            json.dump(data, f, ensure_ascii=False)
            f.flush()
            os.fsync(f.fileno())
        os.replace(tmp, index)
    except Exception:
        try:
            os.unlink(tmp)
        except OSError:
            pass
        raise
    return ok, skip


def main():
    if len(sys.argv) < 2:
        print(__doc__)
        sys.exit(1)
    ok, skip = generate_thumbs(sys.argv[1])
    print(f"缩略图完成: {ok} 张（跳过 {skip}）")


if __name__ == "__main__":
    main()
