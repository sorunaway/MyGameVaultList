# -*- coding: utf-8 -*-
"""
Steam 本地文件读取 —— **Windows 桌面版专用**。

能拿到什么（全部零凭证、零联网）：
    · 本机登录过的账号（含 SteamID64）→ 自动识别「当前账号」，用户不用手填
    · 库文件夹列表（可多盘）
    · 已安装游戏的名字/体积（`appmanifest_*.acf`）
    · **总时长 / 近两周时长 / 最后启动时间**（`localconfig.vdf`）—— 原本要调 API 才有
    · 封面图（`appcache/librarycache/<appid>/`）

🔴 **这些全部是本机个人数据。**
   对应的 `/api/local/*` 路由由 `config.DESKTOP_MODE`（环境变量 `GV_DESKTOP=1`）控制，
   线上部署永不设它 → 那些路由**根本不会注册**，外部访问得到 404。
   改这里之前先读 `.workbuddy/memory/DESIGN.md` 的「Steam 本地文件」一节。

⚠️ **覆盖率有上限**：`localconfig.vdf` 只对**本机玩过/装过**的 app 写记录。
   实测：云端库约 400 款，本机记录约 300 条、两边交集约两百款。
   **这不是"零凭证拿全库"** —— 剩下那部分只能靠 API（需要用户自己的 key）。
"""

import os

# SteamID64 与账号 ID（SteamID3）的固定偏移
STEAMID64_BASE = 76561197960265728

# 注册表读不到时的兜底路径（⚠️ 别当默认值用 —— 本机自己就装在 D 盘）
_FALLBACK_DIRS = (
    r"C:\Program Files (x86)\Steam",
    r"C:\Program Files\Steam",
    r"D:\Steam",
    r"E:\Steam",
    r"D:\Program Files (x86)\Steam",
)

# 封面优先级：竖版封面 > 宽版头图 > 背景图 > 名字标
COVER_KINDS = ("library_600x900.jpg", "header.jpg", "library_hero.jpg", "logo.png")


# ============================================================
# VDF 解析
# ============================================================
def parse_vdf(text):
    """
    Valve 的 VDF 文本格式：`"键" "值"` 或 `"键" { … }`，字符串内 `\\` 是转义。

    返回嵌套 dict（叶子是 str）。对格式异常**不抛异常**，尽量返回已解析的部分 ——
    这些文件由 Steam 维护，版本间偶有差异，读不动时宁可少拿数据也不要让整个请求崩掉。
    """
    i = 0
    n = len(text)

    def skip_ws():
        nonlocal i
        while i < n and text[i] in " \t\r\n":
            i += 1

    def read_str():
        nonlocal i
        i += 1  # 跳过开引号
        buf = []
        while i < n and text[i] != '"':
            if text[i] == "\\" and i + 1 < n:
                i += 1
            buf.append(text[i])
            i += 1
        i += 1  # 跳过收尾引号
        return "".join(buf)

    def parse_obj():
        nonlocal i
        out = {}
        while True:
            skip_ws()
            if i >= n:
                break
            if text[i] == "}":
                i += 1
                break
            if text[i] != '"':
                i += 1  # 容错：跳过不认识的字符
                continue
            key = read_str()
            skip_ws()
            if i < n and text[i] == "{":
                i += 1
                out[key] = parse_obj()
            elif i < n and text[i] == '"':
                out[key] = read_str()
            else:
                out[key] = None
        return out

    skip_ws()
    if i < n and text[i] == "{":
        i += 1
    return parse_obj()


def read_vdf(path):
    """读一个 VDF 文件并解析。不存在或彻底读不动时返回 None。"""
    if not path or not os.path.isfile(path):
        return None
    try:
        raw = open(path, "rb").read()
    except OSError:
        return None
    for enc in ("utf-8-sig", "utf-8", "latin-1"):
        try:
            return parse_vdf(raw.decode(enc))
        except Exception:
            continue
    return None


# ============================================================
# 定位 Steam
# ============================================================
def find_steam():
    """
    返回 Steam 安装目录（绝对路径），找不到返回 None。

    顺序：注册表 `HKCU\\Software\\Valve\\Steam` 的 `SteamPath` → 常见路径兜底。
    🔴 **必须先读注册表** —— 装在非默认盘（本机就是 D 盘）时兜底路径全落空。
    """
    try:
        import winreg
        with winreg.OpenKey(winreg.HKEY_CURRENT_USER, r"Software\Valve\Steam") as k:
            for name in ("SteamPath", "InstallPath"):
                try:
                    val, _ = winreg.QueryValueEx(k, name)
                except OSError:
                    continue
                if isinstance(val, str) and val.strip():
                    p = os.path.normpath(val)
                    if os.path.isfile(os.path.join(p, "steam.exe")):
                        return p
    except Exception:
        pass

    for p in _FALLBACK_DIRS:
        if os.path.isfile(os.path.join(p, "steam.exe")):
            return p
    return None


def is_available():
    return find_steam() is not None


# ============================================================
# 账号
# ============================================================
def read_accounts(steam_dir=None):
    """
    读 `config/loginusers.vdf` → 本机登录过的账号（按最后登录时间倒序）。

    ⚠️ 新版 Steam **已不再写 `MostRecent` 字段**，只能靠 `Timestamp` 排序。
    """
    steam_dir = steam_dir or find_steam()
    if not steam_dir:
        return []
    root = read_vdf(os.path.join(steam_dir, "config", "loginusers.vdf")) or {}
    users = root.get("users") or {}
    out = []
    for sid, info in users.items():
        if not isinstance(info, dict):
            continue
        try:
            ts = int(info.get("Timestamp") or 0)
        except (TypeError, ValueError):
            ts = 0
        out.append({
            "steamId": str(sid),
            "accountName": str(info.get("AccountName") or ""),
            "personaName": str(info.get("PersonaName") or ""),
            "lastLoginTs": ts,
            "autoLogin": str(info.get("AutoLogin") or "0") == "1",
            "rememberPassword": str(info.get("RememberPassword") or "0") == "1",
        })
    out.sort(key=lambda a: a["lastLoginTs"], reverse=True)
    return out


def account_id_of(steam_id64):
    """SteamID64 → 账号 ID（= `userdata/` 下的目录名）。"""
    try:
        return str(int(steam_id64) - STEAMID64_BASE)
    except (TypeError, ValueError):
        return None


# ============================================================
# 库 / 游戏
# ============================================================
def read_libraries(steam_dir=None):
    """读 `steamapps/libraryfolders.vdf` → 去重后的库根目录列表（含 Steam 自身那份）。"""
    steam_dir = steam_dir or find_steam()
    if not steam_dir:
        return []
    root = read_vdf(os.path.join(steam_dir, "steamapps", "libraryfolders.vdf")) or {}
    node = root.get("libraryfolders") if "libraryfolders" in root else root
    if not isinstance(node, dict):
        node = {}
    paths = []
    for v in node.values():
        if isinstance(v, dict):
            p = v.get("path")
            if isinstance(p, str) and p.strip():
                paths.append(os.path.normpath(p))
    if steam_dir not in paths:
        paths.insert(0, steam_dir)
    # 去重且保序
    seen, uniq = set(), []
    for p in paths:
        key = p.lower()
        if key not in seen:
            seen.add(key)
            uniq.append(p)
    return uniq


def read_installed(steam_dir=None, libraries=None):
    """
    扫所有库的 `steamapps/appmanifest_<appid>.acf` → {appid(int): 信息}。
    只有**已安装**的游戏能有名字，未安装的名字要从商店接口补。
    """
    steam_dir = steam_dir or find_steam()
    if not steam_dir:
        return {}
    libs = libraries if libraries is not None else read_libraries(steam_dir)
    out = {}
    for lib in libs:
        d = os.path.join(lib, "steamapps")
        if not os.path.isdir(d):
            continue
        try:
            names = os.listdir(d)
        except OSError:
            continue
        for fn in names:
            if not (fn.startswith("appmanifest_") and fn.endswith(".acf")):
                continue
            st = read_vdf(os.path.join(d, fn)) or {}
            app = st.get("AppState") or {}
            try:
                appid = int(app.get("appid"))
            except (TypeError, ValueError):
                continue

            def _int(key):
                try:
                    return int(app.get(key) or 0)
                except (TypeError, ValueError):
                    return 0

            out[appid] = {
                "appid": appid,
                "title": str(app.get("name") or ""),
                "installDir": str(app.get("installdir") or ""),
                "sizeOnDisk": _int("SizeOnDisk"),
                "lastUpdatedTs": _int("LastUpdated"),
                "lastPlayedTs": _int("LastPlayed"),
                "stateFlags": _int("StateFlags"),
                "library": lib,
            }
    return out


def read_local_apps(steam_dir, account_id):
    """
    读 `userdata/<account_id>/config/localconfig.vdf` 里这份**账号级**数据：
        `Playtime`（分钟，等价 API 的 `playtime_forever`）
        `Playtime2wks`（分钟，等价 `playtime_2weeks`）
        `LastPlayed`（unix 秒，等价 `rtime_last_played`）
    """
    if not steam_dir or not account_id:
        return {}
    path = os.path.join(steam_dir, "userdata", str(account_id), "config", "localconfig.vdf")
    root = read_vdf(path) or {}
    apps = {}
    try:
        apps = root["UserLocalConfigStore"]["Software"]["Valve"]["Steam"]["apps"] or {}
    except (KeyError, TypeError):
        return {}
    out = {}
    for k, v in apps.items():
        if not isinstance(v, dict) or not str(k).isdigit():
            continue
        appid = int(k)
        if appid <= 0:
            continue

        def _int(key):
            raw = v.get(key)
            if raw is None:
                return 0
            try:
                return int(str(raw).strip() or 0)
            except (TypeError, ValueError):
                return 0

        out[appid] = {
            "totalMinutes": _int("Playtime"),
            "recent2wMinutes": _int("Playtime2wks"),
            "lastPlayedTs": _int("LastPlayed"),
        }
    return out


# ============================================================
# 封面
# ============================================================
def cover_path(steam_dir, appid, kind=None):
    """
    返回该 appid 的封面文件绝对路径；没有则 None。
    `kind` 指定则只找那一张，否则按 COVER_KINDS 优先级取第一张存在的。
    🔴 只接受 `COVER_KINDS` 里的固定文件名 —— 绝不能让外部传进来的字符串拼进路径。
    """
    if not steam_dir or not appid:
        return None
    d = os.path.join(steam_dir, "appcache", "librarycache", str(appid))
    if not os.path.isdir(d):
        return None
    kinds = (kind,) if kind in COVER_KINDS else COVER_KINDS
    for k in kinds:
        p = os.path.join(d, k)
        if os.path.isfile(p):
            return p
    return None


def cover_kind(steam_dir, appid):
    """返回命中的封面类型名（用于回给前端判断长宽比），没有则 None。"""
    if not steam_dir or not appid:
        return None
    d = os.path.join(steam_dir, "appcache", "librarycache", str(appid))
    for k in COVER_KINDS:
        if os.path.isfile(os.path.join(d, k)):
            return k
    return None


# ============================================================
# 汇总出口
# ============================================================
def read_library(steam_id=None, with_covers=True):
    """
    桌面版的主出口：一次性给出「当前账号 + 本地库 + 时长」。

    返回形状（前端直接用）：
        { ok, steamDir, account:{steamId,personaName,accountName,lastLoginTs,autoLogin},
          accounts:[…], libraries:[…],
          games:[{appid,title,totalMinutes,recent2wMinutes,lastPlayedTs,
                  installed,sizeOnDisk,cover,coverKind}],
          stats:{total,installed,named,withCover,played} }

    `ok=False` 时带 `reason`：`steam_not_found` / `no_account`。
    """
    steam_dir = find_steam()
    if not steam_dir:
        return {"ok": False, "reason": "steam_not_found"}

    accounts = read_accounts(steam_dir)
    if not accounts:
        return {"ok": False, "reason": "no_account", "steamDir": steam_dir}

    account = None
    if steam_id:
        want = str(steam_id).strip()
        for a in accounts:
            if a["steamId"] == want or account_id_of(a["steamId"]) == want:
                account = a
                break
    if account is None:
        account = accounts[0]          # 已按最后登录时间倒序

    account_id = account_id_of(account["steamId"])
    libraries = read_libraries(steam_dir)
    installed = read_installed(steam_dir, libraries)
    played = read_local_apps(steam_dir, account_id)

    appids = set(installed) | set(played)
    games = []
    for appid in sorted(appids):
        inst = installed.get(appid) or {}
        loc = played.get(appid) or {}
        k = cover_kind(steam_dir, appid) if with_covers else None
        games.append({
            "appid": appid,
            # 名字只有「已安装」的款有；其余靠商店接口补（UI 会退化成 "App <appid>" 占位）
            "title": inst.get("title") or "",
            "totalMinutes": inst.get("lastPlayedTs") and loc.get("totalMinutes") or loc.get("totalMinutes", 0),
            "recent2wMinutes": loc.get("recent2wMinutes", 0),
            # 两处都有 LastPlayed 时取较新的那个
            "lastPlayedTs": max(loc.get("lastPlayedTs", 0), inst.get("lastPlayedTs", 0)),
            "installed": appid in installed,
            "sizeOnDisk": inst.get("sizeOnDisk", 0),
            "cover": ("/api/local/cover?appid=%d" % appid) if k else None,
            "coverKind": k,
        })

    return {
        "ok": True,
        "steamDir": steam_dir,
        "account": account,
        "accounts": accounts,
        "libraries": libraries,
        "games": games,
        "stats": {
            "total": len(games),
            "installed": sum(1 for g in games if g["installed"]),
            "named": sum(1 for g in games if g["title"]),
            "withCover": sum(1 for g in games if g["cover"]),
            "played": sum(1 for g in games if g["totalMinutes"] > 0),
        },
    }
