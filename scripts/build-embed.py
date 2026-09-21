# -*- coding: utf-8 -*-
"""
把 data/steam_sync.json 内联成 js/seed-data.js
这样本地双击 index.html（file:// 协议）也能读到数据。
"""
import json, os, sys, io

sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding='utf-8')

BASE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
src = os.path.join(BASE, "data", "steam_sync.json")
dst = os.path.join(BASE, "js", "seed-data.js")

if not os.path.exists(src):
    print("缺少 %s，先跑 scripts/sync.py" % src)
    sys.exit(1)

with open(src, "r", encoding="utf-8-sig") as f:
    data = json.load(f)

# 精简：去掉空字段，减小体积
slim = []
for g in data:
    x = {
        "appid": g.get("appid"),
        "title": g.get("title"),
        "icon": g.get("icon") or "",
        "header": g.get("header") or "",
        "releaseYear": g.get("releaseYear"),
        "releaseDate": g.get("releaseDate") or "",
        "totalMinutes": g.get("totalMinutes") or 0,
        "recentMinutes": g.get("recentMinutes") or 0,
        "lastPlayedTs": g.get("lastPlayedTs") or 0,
        "achievements": g.get("achievements"),
        "genres": g.get("genres") or [],
        "developers": g.get("developers") or [],
        # 本地收藏夹：没命中就省略，省体积
        **({"collections": g["collections"]} if g.get("collections") else {}),
        "steamReview": "",
        "myNote": "",
        "source": "steam",
    }
    slim.append(x)

payload = json.dumps(slim, ensure_ascii=False, separators=(",", ":"))

with open(dst, "w", encoding="utf-8") as f:
    f.write("/* 自动生成，请勿手改。源文件：data/steam_sync.json */\n")
    f.write("window.__SEED_GAMES__ = ")
    f.write(payload)
    f.write(";\n")

print("written: %s" % dst)
print("games: %d" % len(slim))
print("size: %.1f KB" % (os.path.getsize(dst) / 1024.0))
