#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
MyGameVaultList — Steam 同步脚本

拉取你 Steam 库的全部游戏，输出成应用能吃的 JSON。

用法：
    python scripts/sync.py                    # 用脚本内配置的 Key/ID
    python scripts/sync.py --key XXX --sid YYY
    python scripts/sync.py --no-store         # 跳过商店信息（快很多）

输出：
    data/steam_sync.json    给应用「同步」按钮载入用

依赖：标准库（urllib），无需 pip install
"""

import json
import os
import re
import sys
import time
import argparse
import urllib.request
import urllib.error

BASE_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DATA_DIR = os.path.join(BASE_DIR, "data")
CACHE_DIR = os.path.join(DATA_DIR, ".cache")


def load_dotenv():
    """把项目根 .env 读进 os.environ（不覆盖已存在的环境变量）。

    极简实现：只认 KEY=VALUE，忽略空行与 # 注释，不引第三方依赖。
    与服务端那份（server/config.py）保持同一套语义。
    """
    path = os.path.join(BASE_DIR, ".env")
    if not os.path.isfile(path):
        return
    with open(path, "r", encoding="utf-8-sig") as f:
        for line in f:
            line = line.strip()
            if not line or line.startswith("#") or "=" not in line:
                continue
            k, v = line.split("=", 1)
            k = k.strip()
            v = v.strip().strip('"').strip("'")
            if k:
                os.environ.setdefault(k, v)


# ===== 默认配置（可从命令行覆盖）=====
# ⚠️ 这里**绝不允许**写死真实凭证。
#    2026-09-21 修：原先这两个默认值里直接写着**一把真实的 Steam Web API Key**
#    和对应的 SteamID64。后果有两层：①拿到这份源码的人可以拿这把 Key 以库主
#    的名义调 Steam 接口；②它会被人不知情地打包进部署产物。
#    现在的取值顺序：命令行 --key/--sid > 环境变量 > 项目根 .env。
#    一个都不给就直接报错退出（main() 里有守卫），**绝不静默退化成某一个人的账号**。
load_dotenv()
DEFAULT_KEY = os.environ.get("STEAM_API_KEY", "")
DEFAULT_SID = os.environ.get("STEAM_ID", "")

UA = ("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
      "(KHTML, like Gecko) Chrome/120.0 Safari/537.36")


def log(msg):
    sys.stdout.write(msg + "\n")
    sys.stdout.flush()


def fetch(url, timeout=25, retries=2):
    """GET 一个 URL，返回解析后的 JSON（失败返回 None）"""
    # 绕过系统代理（Steam API 直连更稳）
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
    for attempt in range(retries + 1):
        try:
            req = urllib.request.Request(url, headers={
                "User-Agent": UA,
                "Accept": "application/json",
            })
            with opener.open(req, timeout=timeout) as resp:
                raw = resp.read().decode("utf-8", "replace")
            return json.loads(raw)
        except Exception as e:
            if attempt == retries:
                log("  ! 请求失败: %s" % e)
                return None
            time.sleep(1.2)


def fetch_text(url, timeout=25, retries=2):
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
    for attempt in range(retries + 1):
        try:
            req = urllib.request.Request(url, headers={
                "User-Agent": UA,
                "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.8",
            })
            with opener.open(req, timeout=timeout) as resp:
                return resp.read().decode("utf-8", "replace")
        except Exception as e:
            if attempt == retries:
                log("  ! 请求失败: %s" % e)
                return None
            time.sleep(1.2)


def load_cache(name):
    p = os.path.join(CACHE_DIR, name)
    if os.path.exists(p):
        try:
            # utf-8-sig：兼容带 BOM 的文件（PowerShell 写出的 JSON 常带 BOM）
            with open(p, "r", encoding="utf-8-sig") as f:
                data = json.load(f)
            return data if isinstance(data, dict) else {}
        except Exception as e:
            log("  ! 缓存 %s 读取失败（将忽略）: %s" % (name, e))
            return {}
    return {}


def save_cache(name, data):
    os.makedirs(CACHE_DIR, exist_ok=True)
    p = os.path.join(CACHE_DIR, name)
    with open(p, "w", encoding="utf-8") as f:
        json.dump(data, f, ensure_ascii=False)


def parse_year(s):
    if not s:
        return None
    m = re.search(r"(19|20)\d{2}", str(s))
    return int(m.group(0)) if m else None


# ===== 1. 游戏库 =====
def step_owned(key, sid):
    log("[1/4] 拉取游戏库…")
    url = ("https://api.steampowered.com/IPlayerService/GetOwnedGames/v1/"
           "?key=%s&steamid=%s&include_appinfo=1&include_played_free_games=1&format=json"
           % (key, sid))
    data = fetch(url)
    if not data:
        raise RuntimeError("游戏库拉取失败。检查 API Key / SteamID / 档案是否公开。")

    resp = data.get("response", {})
    games = resp.get("games", [])
    count = resp.get("game_count", 0)
    if not games:
        raise RuntimeError("返回的游戏列表为空。请确认「游戏详情」设为公开。")

    log("      拿到 %d 款游戏（game_count=%d）" % (len(games), count))
    return games


# ===== 2. 成就 =====
def step_achievements(key, sid, games, refresh=False):
    """拉成就。

    策略：缓存是「有成就的游戏 -> {earned,total}」的映射。
    没有成就的游戏（如老游戏、无成就系统）不在缓存里是正常的，
    每次联网重查这些游戏既慢又会被 Steam 限流（HTTP 400）。
    所以默认只用缓存，只有 --refresh-ach 时才联网补查。
    """
    log("[2/4] 拉取成就（只查玩过的）…")
    cache = load_cache("achievements.json")
    targets = [g for g in games if (g.get("playtime_forever") or 0) > 0]
    log("      玩过的游戏 %d 款；缓存已有 %d 条" % (len(targets), len(cache)))

    if not refresh:
        out = {}
        for g in targets:
            k = str(g["appid"])
            out[k] = cache.get(k)
        got = sum(1 for v in out.values() if v)
        log("      有成就数据的：%d 款（纯用缓存，未联网）" % got)
        log("      如需补查无成就记录的游戏，加参数 --refresh-ach")
        return out

    out = {}
    for i, g in enumerate(targets, 1):
        appid = str(g["appid"])
        url = ("https://api.steampowered.com/ISteamUserStats/GetPlayerAchievements/v1/"
               "?key=%s&steamid=%s&appid=%s&l=schinese" % (key, sid, appid))
        d = fetch(url, timeout=15, retries=0)
        if d and d.get("playerstats", {}).get("achievements"):
            achs = d["playerstats"]["achievements"]
            earned = sum(1 for a in achs if a.get("achieved") == 1)
            out[appid] = {"earned": earned, "total": len(achs)}
        elif appid in cache:
            out[appid] = cache[appid]
        else:
            out[appid] = None
        if i % 25 == 0:
            log("      %d / %d" % (i, len(targets)))
        time.sleep(1.1)   # Steam 对该接口限流较严

    save_cache("achievements.json", out)
    got = sum(1 for v in out.values() if v)
    log("      有成就数据的：%d 款" % got)
    return out


# ===== 3. 商店信息 =====
def step_store(games, refresh=False):
    """商店信息（发售年份/图片/类型）。

    同成就：缓存里没有的游戏（下架、地区限制、DLC 等）联网重查既慢又容易被限流。
    默认只用缓存，--refresh-store 才联网补查。
    """
    log("[3/4] 商店信息…")
    cache = load_cache("store.json")
    out = dict(cache)

    if not refresh:
        got = sum(1 for v in out.values() if v)
        log("      缓存 %d 条（纯用缓存，未联网）" % got)
        log("      如需补查缺失的游戏，加参数 --refresh-store")
        return out

    todo = [g for g in games if str(g["appid"]) not in cache]
    log("      需要联网查询 %d 款（已缓存 %d）" % (len(todo), len(cache)))

    for i, g in enumerate(todo, 1):
        appid = str(g["appid"])
        url = "https://store.steampowered.com/api/appdetails?appids=%s&l=schinese" % appid
        d = fetch(url, timeout=15, retries=1)
        node = (d or {}).get(appid)
        if node and node.get("success") and node.get("data"):
            dd = node["data"]
            rel = (dd.get("release_date") or {}).get("date")
            out[appid] = {
                "name": dd.get("name"),
                "release": rel,
                "header": dd.get("header_image"),
                "genres": [x.get("description") for x in (dd.get("genres") or [])],
                "developers": dd.get("developers") or [],
            }
        else:
            out[appid] = None
        if i % 25 == 0:
            log("      %d / %d" % (i, len(todo)))
            save_cache("store.json", out)
        time.sleep(0.5)

    save_cache("store.json", out)
    log("      商店信息：%d 款" % sum(1 for v in out.values() if v))
    return out


# ===== 3.5 本地收藏夹 =====
# Steam 新版库的自定义收藏夹（Collections）保存在本地：
#   <Steam>/userdata/<账号短ID>/config/cloudstorage/cloud-storage-namespace-1.json
# 结构：顶层是 [key, {value: "{\"id\",\"name\",\"added\":[appid...],\"removed\":[]}"}, ...]
# 注意：这是本地文件，只有装了 Steam 客户端并同步过才能读到；纯 API 拿不到。

STEAM_REG_PATHS = [
    (r"SOFTWARE\WOW6432Node\Valve\Steam", "InstallPath"),
    (r"SOFTWARE\Valve\Steam", "InstallPath"),
    (r"SOFTWARE\Valve\Steam", "SteamPath"),
]


def _steam_paths_from_registry():
    """从注册表找 Steam 安装目录（32/64 位视图都看）"""
    found = []
    try:
        import winreg
    except ImportError:
        return found
    for sub, val in STEAM_REG_PATHS:
        for hive in (winreg.HKEY_CURRENT_USER, winreg.HKEY_LOCAL_MACHINE):
            try:
                with winreg.OpenKey(hive, sub) as k:
                    p = winreg.QueryValueEx(k, val)[0]
                    if p and p not in found:
                        found.append(p)
            except Exception:
                pass
    return found


def _steam_paths_from_disk():
    """注册表读不到时的兜底：常见安装位置"""
    guesses = [
        r"C:\Program Files (x86)\Steam",
        r"C:\Program Files\Steam",
        r"D:\Program Files (x86)\Steam",
        r"D:\Steam",
        r"E:\Steam",
        r"E:\Program Files (x86)\Steam",
        r"F:\Steam",
    ]
    return [p for p in guesses if os.path.isdir(p)]


def _norm(p):
    return os.path.abspath(str(p).replace("\\", "/")).replace("\\", "/").lower()


def _steam_dir_from_app_settings():
    """
    读**桌面版应用**里「设置 → Steam 安装目录」存的那个路径。

    为什么要有这条：自动探测再全也有兜不住的（绿色版 / 装在非常规位置 /
    注册表项被清理过）。用户已经在应用里指定过一次了，脚本这边不该再让他
    重设一遍 —— 两边读同一个设置文件，就是「设一次、两边都认」。

    ⚠️ 这里**故意重复**了一份 `server/steam_local.py` 的路径规则，而不是 import 它：
       `sync.py` 要能被**单独拷走使用**（别人可以只拿走这一个文件），
       引入 server/ 包就把这个前提毁了。改这里时记得同步改那边的
       `settings_path()` / `SETTINGS_NAME`（同一个文件、同一套目录规则）。
    """
    home = os.environ.get("GV_DESKTOP_HOME") or ""
    if not home:
        home = os.path.join(os.environ.get("LOCALAPPDATA") or os.path.expanduser("~"),
                            "MyGameVault")
    try:
        with open(os.path.join(home, "desktop.json"), "r", encoding="utf-8") as f:
            d = json.load(f)
    except Exception:
        return ""
    v = d.get("steamDir") if isinstance(d, dict) else None
    return v.strip() if isinstance(v, str) and v.strip() else ""


def find_steam_roots():
    """返回所有可能的 Steam 根目录（去重）"""
    saved = _steam_dir_from_app_settings()
    # ⚠️ 应用里指定的那个**排最前** —— 用户显式说过一次了，就该以他为准，
    #    否则"设了没反应"（被后面的注册表结果盖住）。
    cands = ([saved] if saved else []) + _steam_paths_from_registry() + _steam_paths_from_disk()
    seen, out = set(), []
    for p in cands:
        try:
            n = _norm(p)
        except Exception:
            continue
        if n in seen:
            continue
        seen.add(n)
        if os.path.isdir(p):
            out.append(p)
    return out


def _read_library_folders(root):
    """解析 libraryfolders.vdf，拿到所有库目录（游戏可能装在别的盘）"""
    vdf = os.path.join(root, "steamapps", "libraryfolders.vdf")
    if not os.path.exists(vdf):
        vdf = os.path.join(root, "config", "libraryfolders.vdf")
    if not os.path.exists(vdf):
        return []
    out = []
    try:
        txt = open(vdf, "r", encoding="utf-8", errors="replace").read()
    except Exception:
        return out
    for m in re.finditer(r'"path"\s*"([^"]+)"', txt):
        out.append(m.group(1).replace("\\\\", "\\"))
    return out


def _steamid64_to_account_id(sid64):
    """SteamID64 -> 账号短 ID（userdata 目录用的是后者）"""
    try:
        return str(int(sid64) - 76561197960265728)
    except Exception:
        return None


def _parse_collections_file(path):
    """解析 cloud-storage-namespace-*.json，返回 {收藏夹名: [appid, ...]}"""
    result = {}
    try:
        data = json.loads(open(path, "r", encoding="utf-8-sig").read())
    except Exception as e:
        log("  ! 收藏夹文件解析失败 %s: %s" % (os.path.basename(path), e))
        return result
    if not isinstance(data, list):
        return result
    for item in data:
        if not (isinstance(item, list) and len(item) >= 2):
            continue
        key = item[0]
        meta = item[1]
        if not (isinstance(key, str) and key.startswith("user-collections.")):
            continue
        if not isinstance(meta, dict) or meta.get("is_deleted"):
            continue
        raw = meta.get("value")
        if not raw:
            continue
        try:
            obj = json.loads(raw)
        except Exception:
            continue
        name = obj.get("name")
        if not name:
            continue
        added = [a for a in (obj.get("added") or []) if isinstance(a, int)]
        removed = [a for a in (obj.get("removed") or []) if isinstance(a, int)]
        # removed 表示用户在该收藏夹里手动剔除过的，应用时扣掉
        keep = [a for a in added if a not in set(removed)]
        result[name] = keep
    return result


def step_collections(sid, root=None):
    """读本地 Steam 收藏夹。

    返回 {"__source__": 说明, "收藏夹名": [appid...]}
    读不到就返回空 dict。这是本地文件，与 API Key 无关。
    """
    log("[3.5/4] 读取本地 Steam 收藏夹…")

    roots = [root] if root else find_steam_roots()
    if not roots:
        log("      未找到 Steam 安装目录（跳过）")
        return {}

    account_id = _steamid64_to_account_id(sid)

    # 候选 userdata 目录：优先账号短 ID，其次全部
    for r in roots:
        ud = os.path.join(r, "userdata")
        if not os.path.isdir(ud):
            continue
        try:
            users = [d for d in os.listdir(ud) if os.path.isdir(os.path.join(ud, d))]
        except Exception:
            continue
        ordered = ([account_id] if account_id and account_id in users else []) + \
                  [u for u in users if u != account_id]

        for u in ordered:
            csdir = os.path.join(ud, u, "config", "cloudstorage")
            if not os.path.isdir(csdir):
                continue
            try:
                files = sorted(
                    [f for f in os.listdir(csdir) if f.startswith("cloud-storage-namespace")
                     and f.endswith(".json")],
                    reverse=True)
            except Exception:
                continue
            for fn in files:
                colls = _parse_collections_file(os.path.join(csdir, fn))
                if not colls:
                    continue
                total = sum(len(v) for v in colls.values())
                log("      账号 %s -> 读到 %d 个收藏夹，共 %d 条记录："
                    % (u, len(colls), total))
                for name, ids in sorted(colls.items(), key=lambda x: -len(x[1])):
                    log("        · %-12s %d 款" % (name, len(ids)))
                colls["__source__"] = "userdata/%s/%s" % (u, fn)
                return colls

    log("      未找到收藏夹文件（Steam 未登录过该账号，或未启用云同步）")
    return {}


# ===== 4. 合成 =====
def step_compose(games, ach, store, collections=None):
    log("[4/4] 合成输出…")

    # 建反查表：appid -> [收藏夹名...]
    coll_of = {}
    for cname, ids in (collections or {}).items():
        if cname == "__source__":
            continue
        for a in ids:
            coll_of.setdefault(a, []).append(cname)

    out = []
    for g in games:
        appid = str(g["appid"])
        st = store.get(appid) or {}
        ac = ach.get(appid)

        total_min = g.get("playtime_forever") or 0
        recent_min = g.get("playtime_2weeks") or 0
        last_ts = g.get("rtime_last_played") or 0

        name = g.get("name") or st.get("name") or ("App " + appid)

        icon = ""
        if g.get("img_icon_url"):
            icon = ("https://media.steampowered.com/steamcommunity/public/images/apps/%s/%s.jpg"
                    % (appid, g["img_icon_url"]))

        header = st.get("header") or ""
        if not header:
            header = ("https://cdn.cloudflare.steamstatic.com/steam/apps/%s/header.jpg" % appid)

        rel_year = parse_year(st.get("release"))

        achievements = None
        if ac and isinstance(ac, dict):
            e = ac.get("earned")
            t = ac.get("total")
            if isinstance(e, int) and isinstance(t, int) and t > 0:
                achievements = {"earned": e, "total": t}

        out.append({
            "appid": int(appid),
            "title": name,
            "icon": icon,
            "header": header,
            "releaseYear": rel_year,
            "releaseDate": st.get("release"),
            "totalMinutes": total_min,
            "recentMinutes": recent_min,
            "lastPlayedTs": last_ts,
            "achievements": achievements,
            "genres": [x for x in (st.get("genres") or []) if x],
            "developers": [x for x in (st.get("developers") or []) if x],
            "steamReview": "",
            "myNote": "",
            "source": "steam",
            # 本地收藏夹名，原样带上（哪个名字代表什么状态由应用里的设置决定，
            # 脚本不猜 —— 收藏夹是用户自己建的，名字随心）
            "collections": sorted(coll_of.get(int(appid), [])),
        })
    return out


def main():
    ap = argparse.ArgumentParser(description="MyGameVaultList Steam 同步")
    ap.add_argument("--key", default=DEFAULT_KEY)
    ap.add_argument("--sid", default=DEFAULT_SID)
    ap.add_argument("--refresh-store", action="store_true",
                    help="联网补查商店信息（发售年份/类型）")
    ap.add_argument("--refresh-ach", action="store_true",
                    help="联网重查成就（慢，且容易被 Steam 限流）")
    ap.add_argument("--steam-root", default=None,
                    help="手动指定 Steam 安装目录"
                         "（默认：应用里设过的 → 注册表 → 常见路径）")
    ap.add_argument("--no-collections", action="store_true",
                    help="跳过本地收藏夹读取")
    ap.add_argument("--out", default=os.path.join(DATA_DIR, "steam_sync.json"))
    args = ap.parse_args()

    if not args.key or not args.sid:
        log("错误：需要 Steam Web API Key 和 SteamID64。")
        log("")
        log("三种给法，任选其一：")
        log("  1) 写进项目根 .env（推荐）：")
        log("       STEAM_API_KEY=<你的 key>")
        log("       STEAM_ID=<你的 17 位 SteamID64>")
        log("  2) 设环境变量 STEAM_API_KEY / STEAM_ID")
        log("  3) 命令行：python scripts/sync.py --key XXX --sid YYY")
        log("")
        log("API Key 申请：https://steamcommunity.com/dev/apikey")
        log("SteamID64 查询：https://steamid.io/")
        sys.exit(1)

    log("=" * 56)
    log("MyGameVaultList Steam 同步")
    log("=" * 56)
    log("SteamID: %s" % args.sid)
    log("")

    games = step_owned(args.key, args.sid)
    ach = step_achievements(args.key, args.sid, games, refresh=args.refresh_ach)
    store = step_store(games, refresh=args.refresh_store)
    colls = {} if args.no_collections else step_collections(args.sid, root=args.steam_root)
    out = step_compose(games, ach, store, collections=colls)

    os.makedirs(os.path.dirname(args.out), exist_ok=True)
    with open(args.out, "w", encoding="utf-8") as f:
        json.dump(out, f, ensure_ascii=False, indent=1)

    # 摘要
    def _perfect(x):
        a = x.get("achievements")
        return bool(a and a.get("total") and a.get("earned") is not None
                    and a["earned"] >= a["total"])
    perfect = [x for x in out if _perfect(x)]
    playing = [x for x in out if (x.get("recentMinutes") or 0) > 0]
    log("")
    log("-" * 56)
    log("完成：%d 款游戏 -> %s" % (len(out), args.out))
    log("  全成就：%d 款" % len(perfect))
    log("  最近两周在玩：%d 款" % len(playing))
    if colls:
        src = colls.get("__source__", "")
        names = sorted(k for k in colls if k != "__source__")
        log("  收藏夹：%d 个（来源 %s）" % (len(names), src))
        for nm in names:
            log("    「%s」%d 款" % (nm, len(colls.get(nm) or [])))
        # 这里刻意不打印"某某收藏夹 -> 已通关"：哪个名字算通关由用户在应用里
        # 自己定（顶栏「设置」），脚本写死一个名字只会误导人。
        log("    （哪个收藏夹算「已通关」在应用顶栏「设置」里定，默认「已完结」）")
    else:
        log("  收藏夹：未读取（本地 Steam 配置不可用）")
    if perfect:
        log("  全成就列表：")
        for x in perfect[:15]:
            log("    - %s" % x["title"])
    log("-" * 56)
    log("")
    log("下一步：打开应用 -> 点「同步」-> 选择 %s" % os.path.basename(args.out))


if __name__ == "__main__":
    main()
