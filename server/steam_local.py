# -*- coding: utf-8 -*-
"""
Steam 本地文件读取 —— **Windows 桌面版专用**。

能拿到什么（全部零凭证、零联网）：
    · 本机登录过的账号（含 SteamID64）→ 自动识别「当前账号」，用户不用手填
    · 库文件夹列表（可多盘）
    · 已安装游戏的名字/体积（`appmanifest_*.acf`）
    · **总时长 / 近两周时长 / 最后启动时间**（`localconfig.vdf`）—— 原本要调 API 才有
    · **收藏夹名与成员**（`cloudstorage/cloud-storage-namespace-1.json`）——
      「已通关 / 已隐藏」这两条归类规则的依据，**离线也能拿到**
    · 封面图（`appcache/librarycache/<appid>/`）

**Steam 装在哪**：优先用户设置（`desktop.json`），其次注册表（HKCU + HKLM 两个视图），
   再次常见路径；都不行时用户可以点「扫描磁盘」浅扫一遍。详见「定位 Steam」一节。

🔴 **这些全部是本机个人数据。**
   对应的 `/api/local/*` 路由由 `config.DESKTOP_MODE`（环境变量 `GV_DESKTOP=1`）控制，
   线上部署永不设它 → 那些路由**根本不会注册**，外部访问得到 404。
   改这里之前先读 `.workbuddy/memory/DESIGN.md` 的「Steam 本地文件」一节。

⚠️ **覆盖率有上限**：`localconfig.vdf` 只对**本机玩过/装过**的 app 写记录。
   收藏夹能补回一部分 —— 收藏夹里那些「没装、也没在本机玩过」的款（换机 / 云游戏 /
   早年别的机器上玩过的）。实测（2026-09-21）：云端库**约 400**款，
   本地记录约 300 条（安装 ∪ 时长记录，外加靠收藏夹补回的一小批）；两边交集约两百款。
   **这不是"零凭证拿全库"** —— 剩下那部分只能靠 API（需要用户自己的 key）。
"""

import json
import os
import time

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

# 扫盘时**不进去**的目录名（小写）。这些要么是系统目录，要么是缓存/海量小文件，
# 进去只会白烧时间，不可能放着 Steam。
_SKIP_DIR_NAMES = frozenset((
    "windows", "system32", "syswow64", "winsxs", "$recycle.bin",
    "system volume information", "programdata", "appdata", "recovery",
    "perflogs", "msocache", "boot", "onedrivetemp", "windowsapps",
    "node_modules", ".git", ".svn", "__pycache__", ".cache", ".gradle",
    ".nuget", ".vscode", "temp", "tmp", "intel", "amd", "nvidia",
    "steamapps",            # 里面有游戏本体，进去是纯浪费预算
    "common", "downloading", "shadercache", "temp_content",
))

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
# 目录来源，按优先级排列（前面的赢）：
#   ① **用户在「设置」里指定的目录**（存在 desktop.json 里）—— 用户说了算，覆盖一切
#   ② 注册表 `HKCU\Software\Valve\Steam` 的 `SteamPath` / `InstallPath`
#   ③ 注册表 `HKLM` 的 `InstallPath`（**64 位视图与 WOW6432Node 32 位视图都查**）
#      ⚠️ 只查 HKCU 是不够的：Steam 若由**另一个 Windows 账户**装过/跑过，HKCU 里没有它；
#         而 HKLM 是机器级的，任何账户都读得到。这条以前漏了。
#   ④ 常见路径兜底（原来这里是唯一手段，现在只是最后一档）
#   ⑤ 用户点「扫描磁盘」时：所有固定盘浅层搜 steam.exe（**只在用户要求时才扫**）
#
# 🔴 为什么 ① 必须有：自动检测再全也有兜不住的场景 ——
#    绿色版 / 被手动搬过位置的 Steam、一台机器上多份 Steam 并存、
#    被"清理软件"删掉注册表项的、以及将来在别的系统上跑。
#    没有手动兜底，这些用户就彻底卡在「找不到 Steam 安装目录」上，无路可走。
#    而**不能只有手动**：让每个玩家自己去 `E:\Games\Steam\steamapps\...` 里刨路径，
#    是把开发者的活儿转嫁给用户 —— 所以两条都要，自动为主、手动兜底。

# 用户设置的落盘位置（⚠️ 在用户目录，**不在仓库里**）
SETTINGS_NAME = "desktop.json"

# 自动检测结果的缓存（原因见 auto_candidates 的注释）
_AUTO_TTL = 20.0
_AUTO_CACHE = {"ts": 0.0, "val": None}


def settings_path():
    """
    桌面版设置文件路径。

    默认 `%LOCALAPPDATA%\\MyGameVault\\desktop.json`；`GV_DESKTOP_HOME` 可改
    （测试用它指到临时目录，避免污染真机设置）。
    """
    home = os.environ.get("GV_DESKTOP_HOME") or ""
    if not home:
        home = os.path.join(os.environ.get("LOCALAPPDATA")
                            or os.path.expanduser("~"), "MyGameVault")
    return os.path.join(home, SETTINGS_NAME)


def read_settings():
    """读设置文件。不存在 / 读坏 / 不是对象 → 一律返回 `{}`（不抛）。"""
    try:
        with open(settings_path(), "r", encoding="utf-8") as f:
            data = json.load(f)
        return data if isinstance(data, dict) else {}
    except Exception:
        return {}


def write_settings(patch=None, remove=()):
    """
    合并写设置（不覆盖别的键）。**原子替换**：先写 `.tmp` 再 `os.replace` ——
    写到一半断电/被杀进程时，也不会留下半个 JSON 把下次启动搞坏。

    ⚠️ 想删键必须用 `remove=`，**不能**靠"传一个不含该键的 dict"。
       本函数是**合并**语义：先把文件读回来再 update，所以传进来的 dict 里没写
       某个键，那个键会**原样留在文件里**。
       （踩过：清空 Steam 目录时设置没被真删掉，`find_steam()` 于是继续返回那个
       用户明明已经清掉的路径 —— 表现是"点了清空没反应"。）
    """
    cur = read_settings()
    for k in (remove or ()):
        cur.pop(k, None)
    cur.update(patch or {})
    p = settings_path()
    try:
        d = os.path.dirname(p)
        if d:
            os.makedirs(d, exist_ok=True)
        tmp = p + ".tmp"
        with open(tmp, "w", encoding="utf-8") as f:
            json.dump(cur, f, ensure_ascii=False, indent=2)
        os.replace(tmp, p)
        invalidate_cache()
        return {"ok": True, "path": p}
    except Exception as e:
        return {"ok": False, "reason": str(e), "path": p}


def _norm_user_path(raw):
    """
    把用户粘进来的路径收拾干净。用户在资源管理器地址栏复制的路径长这样：
        "D:\\Steam"        ← 带引号
        %ProgramFiles(x86)%\\Steam
        D:/Steam/          ← 正斜杠 + 尾斜杠
    这些都不该让用户自己去改。

    最后一步用 `os.path.realpath` 拿到**文件系统里的真实大小写** ——
    注册表里存的是 `SteamPath` 是**全小写**的（实测 `d:\\program files (x86)\\steam`），
    直接显示给用户很难看，而且会让人怀疑「这路径对不对」。
    realpath 顺带把目录联接/junction 也解成真实位置（实测 0.2ms，可忽略）。
    路径不存在时 realpath 原样返回，不会抛异常。
    """
    s = "" if raw is None else str(raw)
    s = s.strip().strip('"').strip("'").strip()
    if not s:
        return ""
    try:
        s = os.path.expandvars(s)      # Windows 上 %VAR% 和 $VAR 都认
    except Exception:
        pass
    s = s.replace("/", os.sep)
    try:
        s = os.path.abspath(s)
    except Exception:
        return ""
    s = os.path.normpath(s)
    try:
        if os.path.isdir(s):
            real = os.path.realpath(s)
            if os.path.isdir(real):
                s = os.path.normpath(real)
    except Exception:
        pass
    return s


def looks_like_steam(path, with_accounts=False):
    """
    判断一个目录**是不是 Steam 安装目录**，并顺手报出它里面有什么。

    返回 dict：
        {ok, kind, input, path, reason, adjusted,
         hasUserdata, hasConfig, hasAppcache, hasLibraryFile, accountCount}

    ⚠️ `with_accounts=True` 才会去数账号（要解析 `loginusers.vdf`）。
       默认不数 —— 本函数会被 `find_steam()` 高频调用（**每张本地封面都过一遍**），
       每次都读一遍 VDF 纯粹是白花钱。只有「探测用户填的路径」这类一次性场景才需要。

    · `ok=True` 的唯一判据是**那一层有 `steam.exe`**。
      不看目录名、不看有没有 userdata —— 名字可以随便改，`steam.exe` 改不了。
    · 容忍用户选错一层：选到 `…\\Steam\\steamapps`、`…\\Steam\\steamapps\\common`、
      甚至直接选中 `steam.exe` 本身，都会**自动往上找**（最多三层）。
    · `ok=False` 时 `reason` 是给用户看的中文原因，不是异常信息。

    ⚠️ 这里**故意不调 `read_libraries()`** —— 那会经 `resolve_steam_dir()` 绕回本函数
       形成无限递归。库的数量等真正同步完由 `/api/local/library` 回报。
    """
    raw = "" if path is None else str(path)
    p = _norm_user_path(raw)
    if not p:
        return {"ok": False, "kind": None, "input": raw, "path": "",
                "reason": "路径是空的", "accountCount": 0}

    # 往上找：用户可能选到 steamapps / common / steam.exe 本身
    tries, cur = [], p
    for _ in range(3):
        if not cur or cur in tries:
            break
        tries.append(cur)
        nxt = os.path.dirname(cur)
        if nxt == cur:
            break
        cur = nxt

    hit = None
    for t in tries:
        if os.path.isfile(os.path.join(t, "steam.exe")):
            hit = t
            break

    if hit is None:
        base = os.path.basename(p).lower()
        if not os.path.isdir(p):
            why = "这个目录不存在"
        elif base == "steamapps" or os.path.isdir(os.path.join(p, "steamapps")):
            why = ("这是「游戏库」目录，不是 Steam 安装目录 —— 它里面没有 steam.exe。"
                   "要填的是**有 steam.exe 的那一层**（通常在 steamapps 的上一级）")
        else:
            why = "这个目录里没有 steam.exe，不像是 Steam 安装目录"
        return {"ok": False, "kind": None, "input": raw, "path": p,
                "reason": why, "accountCount": 0}

    try:
        accs = read_accounts(hit) if with_accounts else []
    except Exception:
        accs = []
    return {
        "ok": True,
        "kind": "full",
        "input": raw,
        "path": hit,
        # 用户给的路径不等于最终采用的路径时，说明是"往上找"找到的 —— UI 要如实说明
        "adjusted": os.path.normcase(hit) != os.path.normcase(p),
        "hasUserdata": os.path.isdir(os.path.join(hit, "userdata")),
        "hasConfig": os.path.isdir(os.path.join(hit, "config")),
        "hasAppcache": os.path.isdir(os.path.join(hit, "appcache")),
        "hasLibraryFile": os.path.isfile(
            os.path.join(hit, "steamapps", "libraryfolders.vdf")),
        "accountCount": len(accs),
        "reason": "",
    }


def _registry_candidates():
    """注册表里的候选目录 → `[(路径, 来源说明)]`。读不到就是空表。"""
    out, seen = [], set()
    try:
        import winreg
    except Exception:
        return out

    W32 = getattr(winreg, "KEY_WOW64_32KEY", 0)
    W64 = getattr(winreg, "KEY_WOW64_64KEY", 0)
    plans = (
        (winreg.HKEY_CURRENT_USER, r"Software\Valve\Steam", 0, "注册表当前用户"),
        (winreg.HKEY_LOCAL_MACHINE, r"SOFTWARE\Valve\Steam", W64, "注册表本机(64位)"),
        (winreg.HKEY_LOCAL_MACHINE, r"SOFTWARE\Valve\Steam", W32, "注册表本机(32位)"),
        (winreg.HKEY_LOCAL_MACHINE, r"SOFTWARE\WOW6432Node\Valve\Steam", W64,
         "注册表本机(WOW6432)"),
    )
    for root, sub, flag, label in plans:
        try:
            with winreg.OpenKey(root, sub, 0, winreg.KEY_READ | flag) as k:
                for name in ("SteamPath", "InstallPath"):
                    try:
                        val, _ = winreg.QueryValueEx(k, name)
                    except OSError:
                        continue
                    if not (isinstance(val, str) and val.strip()):
                        continue
                    p = _norm_user_path(val)
                    if not p or p.lower() in seen:
                        continue
                    seen.add(p.lower())
                    out.append((p, label + " " + name))
        except Exception:
            continue
    return out


def auto_candidates(force=False):
    """
    自动检测（**只看注册表与常见路径，不看用户设置、不扫盘**）→
    `[{"path", "source"}, …]`，按可信度排序，已去重。

    返回列表而不是单个路径：多份 Steam 并存时，界面要能把"还检测到这些"摆出来
    让用户自己挑，而不是替他猜。

    ⚠️ 结果带 20 秒缓存。理由：`find_steam()` 会被**每一张本地封面请求**调到
       （`/api/local/cover`），而每轮都要读注册表 + 对 5 个兜底路径各做一次
       `stat` 的话，300 张封面就是上千次系统调用，白烧在每次翻页上。
       注册表在运行期不会变（真变了用户点「重新检测」即可），缓存完全够用。
    """
    global _AUTO_CACHE
    now = time.time()
    if not force and _AUTO_CACHE["val"] is not None \
            and (now - _AUTO_CACHE["ts"]) < _AUTO_TTL:
        return list(_AUTO_CACHE["val"])

    out, seen = [], set()

    def add(p, source):
        if not p:
            return
        key = os.path.normcase(p)
        if key in seen:
            return
        info = looks_like_steam(p)
        if not info["ok"]:
            return
        seen.add(key)
        out.append({"path": info["path"], "source": source})

    for p, src in _registry_candidates():
        add(p, src)
    for p in _FALLBACK_DIRS:
        add(p, "常见安装路径")

    _AUTO_CACHE = {"ts": now, "val": out}
    return list(out)


def invalidate_cache():
    """清掉自动检测缓存。改了设置、或用户点「重新检测」时调一下。"""
    global _AUTO_CACHE
    _AUTO_CACHE = {"ts": 0.0, "val": None}


def auto_steam_dir():
    """自动检测到的第一个（最可信的）目录；没有则 None。"""
    cands = auto_candidates()
    return cands[0]["path"] if cands else None


def find_steam(override=None):
    """
    最终采用的 Steam 安装目录；找不到返回 None。

    顺序：`override` 参数 → 用户设置 → 自动检测。
    🔴 用户设置排在自动检测**前面** —— 用户显式指定过就以他的为准，
       否则"改了没反应"（自动检测又把他改回了错的那个）。
       被指定的目录失效时（盘拔了/搬走了）会静默回落到自动检测，不会卡死。
    """
    if override:
        info = looks_like_steam(override)
        if info["ok"]:
            return info["path"]

    saved = str(read_settings().get("steamDir") or "").strip()
    if saved:
        info = looks_like_steam(saved)
        if info["ok"]:
            return info["path"]

    return auto_steam_dir()


def resolve_steam_dir(explicit=None):
    """`find_steam` 的别名 —— 给"明摆着要传目录"的调用点用，读起来更顺。（同一个函数。）"""
    return find_steam(explicit)


def desktop_status():
    """
    给 `/api/local/status` 用：现在用的是哪个目录、它是哪来的、还检测到哪些。

    返回 `{ok, steamDir, source, savedDir, savedInvalid, savedReason, auto, settingsPath, reason}`
        source — `settings`（用户设的）/ `auto`（自动检测）/ None（没找到）
        auto   — **除当前这个之外**的自动检测候选，供界面「换一个」用
    """
    saved_raw = str(read_settings().get("steamDir") or "").strip()
    saved_info = looks_like_steam(saved_raw, with_accounts=True) if saved_raw else None
    saved_ok = bool(saved_info and saved_info["ok"])
    auto = auto_candidates()

    used, source = None, None
    if saved_ok:
        used, source = saved_info["path"], "settings"
    elif auto:
        used, source = auto[0]["path"], "auto"

    others = [{"path": c["path"], "source": c["source"]} for c in auto
              if not used or os.path.normcase(c["path"]) != os.path.normcase(used)]

    if used:
        reason = ""
    elif saved_raw and not saved_ok:
        # 用户设过、但那个目录现在读不动了（盘符变了 / 被搬走）——先说这条，比"没找到"有用
        reason = "你之前指定的目录已经不可用：" + str((saved_info or {}).get("reason") or "")
    else:
        reason = "没有找到 Steam 安装目录"

    return {
        "ok": bool(used),
        "steamDir": used,
        "source": source,
        "savedDir": saved_info["path"] if saved_ok else "",
        "savedRaw": saved_raw,
        "savedInvalid": bool(saved_raw) and not saved_ok,
        "savedReason": (saved_info or {}).get("reason", "") if saved_raw else "",
        "auto": others,
        "settingsPath": settings_path(),
        "reason": reason,
    }


def set_steam_dir(raw):
    """
    存用户指定的 Steam 目录。传空串 = 清掉，回到自动检测。

    🔴 **校验通过才落盘** —— 存一个错路径进去，下次启动就会拿着它去读，
       比不存更糟（用户以为设好了，其实一直在读空气）。
    """
    text = "" if raw is None else str(raw).strip()
    if not text:
        w = write_settings(remove=("steamDir",))
        if not w["ok"]:
            return {"ok": False, "reason": "设置写不进去：" + w["reason"]}
        return {"ok": True, "cleared": True, "steamDir": auto_steam_dir(),
                "status": desktop_status()}

    info = looks_like_steam(text)
    if not info["ok"]:
        return {"ok": False, "reason": info["reason"], "probe": info}
    w = write_settings({"steamDir": info["path"]})
    if not w["ok"]:
        return {"ok": False, "reason": "设置写不进去：" + w["reason"], "probe": info}
    return {"ok": True, "steamDir": info["path"], "probe": info,
            "settingsPath": w["path"]}


def _looks_like_library(path):
    """
    判断一个目录**是不是 Steam 游戏库根目录**（不等于 Steam 安装目录）。

    🔴 判据不能用 `steamapps/libraryfolders.vdf` —— 2026-09-21 实测：
       一台机器上 4 个库里只有**主安装**那份有 `libraryfolders.vdf`，
       次级库（`F:\\SteamLibrary` 等）一个都没有。用那个判据等于永远匹配不上。
       真正的共同特征是**有 `steamapps` 目录**，且里面至少有一个库该有的东西。
    """
    sa = os.path.join(path, "steamapps")
    if not os.path.isdir(sa):
        return False
    if os.path.isdir(os.path.join(sa, "common")):
        return True
    try:
        for fn in os.listdir(sa):
            if fn.startswith("appmanifest_") and fn.endswith(".acf"):
                return True
    except OSError:
        return False
    return os.path.isfile(os.path.join(sa, "libraryfolders.vdf"))


def scan_for_steam(max_depth=3, budget=4000, roots=None, max_seconds=25.0):
    """
    在磁盘上**浅层**搜 Steam 安装目录与游戏库目录。

    返回 `{installs:[{path,source}], libraries:[{path,source}], roots, scanned,
            truncated, elapsedMs}`

    🔴 **只在用户点「扫描磁盘」时调用。**
       它是全盘 IO（机械盘上尤其慢、还吵），绝不能放进启动流程或者
       `/api/local/status` 这种每次都要走的地方 —— 那会让应用每次开都卡几秒。
       深度、访问目录数、总耗时**三个上限**都有，超了就 `truncated=True` 如实回报，
       不假装扫全了。

    ⚠️ 总耗时上限（`max_seconds`）不是多余的：断开的**映射网络盘**上，
       连 `os.path.isdir("Z:\\")` 都可能卡住好几秒，光靠目录数预算是拦不住的。
    """
    t0 = time.time()
    if roots is None:
        roots = _drive_roots()

    installs, libraries, seen = [], [], set()
    queue = [(r, 0) for r in roots]
    scanned, truncated = 0, False

    while queue:
        if scanned >= budget or (time.time() - t0) > max_seconds:
            truncated = True
            break
        d, depth = queue.pop(0)
        scanned += 1
        try:
            with os.scandir(d) as it:
                entries = [e for e in it]
        except OSError:
            continue                    # 没权限/盘掉线：跳过，不中断整轮
        for e in entries:
            name = e.name
            low = name.lower()
            if low.startswith("$") or low in _SKIP_DIR_NAMES:
                continue
            try:
                # follow_symlinks=False：Windows 上目录联接(junction)会被判为非目录，
                # 于是天然不会顺着循环链接绕圈（Steam 的库目录常被做成链接）。
                if not e.is_dir(follow_symlinks=False):
                    continue
            except OSError:
                continue

            key = os.path.normcase(e.path)
            if key in seen:
                continue
            if os.path.isfile(os.path.join(e.path, "steam.exe")):
                seen.add(key)
                installs.append({"path": e.path, "source": "磁盘扫描"})
                continue                # 认出来了就不往里走了（appcache 里几万个文件）
            if _looks_like_library(e.path):
                seen.add(key)
                libraries.append({"path": e.path, "source": "磁盘扫描"})
                continue                # steamapps 里是游戏本体，进去纯浪费预算
            if depth + 1 <= max_depth:
                queue.append((e.path, depth + 1))

    return {
        "installs": installs,
        "libraries": libraries,
        "roots": roots,
        "scanned": scanned,
        "truncated": truncated,
        "elapsedMs": int((time.time() - t0) * 1000),
    }


def _drive_roots():
    """本机所有**存在**的盘符根目录（跳过 A:/B: 这两个历史上的软驱位）。"""
    out = []
    for ch in "CDEFGHIJKLMNOPQRSTUVWXYZ":
        p = ch + ":\\"
        try:
            if os.path.isdir(p):
                out.append(p)
        except OSError:
            continue
    return out


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
# 收藏夹（collection）
# ============================================================
# 🔑 收藏夹**不在** localconfig.vdf 里（那里只有一个空的 `"user-collections"  "{}"`），
#    而是在**云存储的本地镜像**里：
#      userdata/<accountId>/config/cloudstorage/cloud-storage-namespace-1.json
#
#    这份文件的形状（2026-09-21 实测，猜错两次才对）：
#      顶层 = list，每一项是 `[key, record]` 两元组；
#      `record = {key, version, timestamp, value, is_deleted?, conflictResolutionMethod?}`
#      收藏夹的正文在 `record["value"]` 里：`{id, name, added:[appid…], removed:[appid…]}`
#      → **成员 = added − removed**（都是 int）。
#
#    🔴 两个必须处理的坑：
#      ① `is_deleted: true` 的记录**要整个跳过** —— 否则被删掉的收藏夹会带着**过期成员表**
#         继续参与归类（实测本机就有 4 个这样的）。
#      ② 键名前缀有三种：`user-collections.<匿名id>`、`user-collections.from-tag-<标签名>`、
#         以及 Steam 内置的 `user-collections.hidden`（= 界面上那个「已隐藏」）。
#         **不能用键名推名字**，名字一律取 `value.name`（只有取不到时才退化成键名尾巴）。
CLOUD_STORAGE_REL = ("config", "cloudstorage", "cloud-storage-namespace-1.json")


def _int_list(v):
    """把 added/removed 这类数组里的元素抽成 int 集合（容忍字符串数字与脏值）。"""
    out = set()
    if not isinstance(v, list):
        return out
    for x in v:
        try:
            n = int(x)
        except (TypeError, ValueError):
            continue
        if n > 0:
            out.add(n)
    return out


def read_collections(steam_dir=None, account_id=None):
    """
    读本机 Steam 的收藏夹 → `{appid: [收藏夹名…]}`。

    返回 `(by_appid, names)`：
        by_appid —— `{appid(int): [收藏夹名(str)…]}`（名字按字典序，保证输出稳定）
        names    —— `{收藏夹名(str): 成员数(int)}`

    读不到（没装 Steam / 没这个账号 / 文件不存在 / 解析失败）一律返回空表，
    **不抛异常** —— 桌面版没有收藏夹也要能正常显示库。
    """
    steam_dir = steam_dir or find_steam()
    if not steam_dir or not account_id:
        return {}, {}

    path = os.path.join(steam_dir, "userdata", str(account_id), *CLOUD_STORAGE_REL)
    if not os.path.isfile(path):
        return {}, {}
    try:
        with open(path, "r", encoding="utf-8-sig") as f:
            data = json.load(f)
    except Exception:
        return {}, {}

    # 顶层是 list（实测）。也容忍 dict 形态 —— 这份文件由 Steam 维护，
    # 万一以后换成 `{key: record}` 的写法，这里不至于整块失效。
    items = data if isinstance(data, list) else list(data.items()) if isinstance(data, dict) else []

    by_appid, names = {}, {}
    for it in items:
        if not (isinstance(it, (list, tuple)) and len(it) >= 2 and isinstance(it[0], str)):
            continue
        key, rec = it[0], it[1]
        if not key.startswith("user-collections."):
            continue
        if not isinstance(rec, dict):
            continue
        # ① 删掉的收藏夹必须跳过（带着过期成员表）
        if rec.get("is_deleted"):
            continue
        inner = rec.get("value")
        if isinstance(inner, str):
            try:
                inner = json.loads(inner)
            except Exception:
                continue
        if not isinstance(inner, dict):
            continue

        # ② 名字只认 value.name；取不到才退化成键名尾巴
        name = inner.get("name")
        name = name.strip() if isinstance(name, str) else ""
        if not name:
            name = key.split("user-collections.", 1)[1] or key

        members = _int_list(inner.get("added")) - _int_list(inner.get("removed"))
        if not members:
            names[name] = 0
            continue
        names[name] = len(members)
        for appid in members:
            by_appid.setdefault(appid, []).append(name)

    for appid in by_appid:
        by_appid[appid].sort()
    return by_appid, names


# ============================================================
# 汇总出口
# ============================================================
def read_library(steam_id=None, with_covers=True):
    """
    桌面版的主出口：一次性给出「当前账号 + 本地库 + 时长 + 收藏夹」。

    返回形状（前端直接用）：
        { ok, steamDir, account:{steamId,personaName,accountName,lastLoginTs,autoLogin},
          accounts:[…], libraries:[…],
          games:[{appid,title,totalMinutes,recent2wMinutes,lastPlayedTs,
                  installed,sizeOnDisk,cover,coverKind,collections}],
          stats:{total,installed,named,withCover,played,fromCollections,
                 collections:{名字:成员数}} }

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
    coll_by_appid, coll_names = read_collections(steam_dir, account_id)

    # 🔴 appid 来源是**三份之并**：已安装 ∪ 有时长记录 ∪ 在某个收藏夹里。
    #    第三份不能省：收藏夹里会有「没装也没本机玩过」的款（换机、云游戏、
    #    或者早年在别的机器上玩过的），它们拿不到时长，但**归类的依据（收藏夹）
    #    是有的** —— 少算了它们，「已通关 / 已隐藏」这两条规则就会漏。
    appids = set(installed) | set(played) | set(coll_by_appid)
    games = []
    for appid in sorted(appids):
        inst = installed.get(appid) or {}
        loc = played.get(appid) or {}
        k = cover_kind(steam_dir, appid) if with_covers else None
        games.append({
            "appid": appid,
            # 名字只有「已安装」的款有；其余靠商店接口补（UI 会退化成 "App <appid>" 占位）
            "title": inst.get("title") or "",
            # localconfig.vdf 的 Playtime 是唯一的时长来源（分钟，等价 playtime_forever）
            "totalMinutes": loc.get("totalMinutes", 0),
            "recent2wMinutes": loc.get("recent2wMinutes", 0),
            # 两处都有 LastPlayed 时取较新的那个
            "lastPlayedTs": max(loc.get("lastPlayedTs", 0), inst.get("lastPlayedTs", 0)),
            "installed": appid in installed,
            "sizeOnDisk": inst.get("sizeOnDisk", 0),
            "cover": ("/api/local/cover?appid=%d" % appid) if k else None,
            "coverKind": k,
            # 收藏夹名列表 —— 前端拿它做「已通关 / 已隐藏」归类（名字哪个代表什么由用户在设置里定）
            "collections": coll_by_appid.get(appid, []),
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
            "fromCollections": sum(1 for g in games
                                   if g["appid"] in coll_by_appid
                                   and g["appid"] not in installed
                                   and g["appid"] not in played),
            "collections": coll_names,
        },
    }
