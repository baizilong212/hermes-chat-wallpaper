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
        out = os.path.join(thumbs, it["id"] + ".jpg")
        if os.path.exists(out):
            it["th"] = "thumbs/" + it["id"] + ".jpg"
            ok += 1
            continue
        src = os.path.join(data["we"], it["id"], it["p"]) if it["p"] else None
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
