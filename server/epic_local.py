# -*- coding: utf-8 -*-
"""
EPIC 本机文件读取 —— **Windows 桌面版专用**。

能拿到什么（全部零凭证、零联网、零登录）：
    · **已拥有的整份库**（含没安装的）—— `Data\\Catalog\\catcache.bin`
    · 已安装的那些（含装到一半的，会被识别出来）—— `Data\\Manifests\\*.item`
    · 标题 / 开发商 / 发售日期 / 封面图 URL
    · 安装状态与装机体积

拿不到什么（**这一节是结论，不是"还没做"**）：
    · **最后游玩时间** —— EPIC 在本机任何地方都没有这个字段（不是本机没有，
      是它整个数据模型里没有）。唯一近似值是 `GameUserSettings.ini` 里
      `LastPlayedGame=` 那**一个槽位**，每次启动被覆盖，只能告诉你"最近玩的那个"。
      ⇒ 应用里"近 90 天玩过 = 正在游玩"那条自动归类（`store.js` 的 suggestStatus）
        **对 EPIC 无解**，所以 EPIC 记录一律停在「我的游戏单」，不会被自动搬走。
    · 游玩时长 / 成就 / 愿望单 / 家庭共享 / 类型 —— 都没有本机来源
      （时长要登录后走非官方接口，见 DESIGN.md 的「平台轴」一节）

🔴 **这些全部是本机个人数据。**
   对应的 `/api/local/*` 路由由 `config.DESKTOP_MODE`（环境变量 `GV_DESKTOP=1`）控制，
   线上部署永不设它 → 那些路由**根本不会注册**，外部访问得到 404。

⚠️ **只读**。本模块**绝不写** EPIC 的任何文件或注册表键 —— EPIC 启动器在跑，
   在它的目录里留垃圾（哪怕是 `-wal` 这种副产物）都是不该发生的。
   路径一律只做 `os.listdir` / `open(...,'r')`。

================================================================================
字段级事实的来源（**不是推的，是别人拿真机验过的**）
================================================================================
`github.com/safwyls/winnow` 的 `docs/spikes/epic-gog-local-files.md`（2026-08-25，
对着真机 Launcher 20.2.4 实测）。下面每条判据都能追到那份记录，另外两条独立印证：
`NotOfficer/EpicManifestParser`（`.item` 字段名）与 `purelogiccode/SimpleLauncher`
（各商店本机数据源总表）。**别凭印象改这里的判据**，改之前把那份记录调出来看。
"""

import base64
import json
import os

# ============================================================
# 数据源位置
# ============================================================
# EPIC 启动器把清单目录**公布在注册表里**，别硬编码路径：
#   HKCU\SOFTWARE\Epic Games\EOS → ModSdkMetadataDir (REG_SZ)
# ⚠️ 实测那个值是**正斜杠**（`C:/ProgramData/.../Manifests`）—— 只影响显示，
#    但顺手 normpath 一下，日志里看着才不像路径拼错了。
EPIC_REG_SUB = r"SOFTWARE\Epic Games\EOS"
EPIC_REG_VALUE = "ModSdkMetadataDir"

# 注册表读不到时的兜底（⚠️ 别当默认值用）
_PROGRAMDATA_FALLBACK = r"C:\ProgramData"
_MANIFESTS_REL = ("Epic", "EpicGamesLauncher", "Data", "Manifests")
_CATALOG_REL = ("Epic", "EpicGamesLauncher", "Data", "Catalog", "catcache.bin")

# 封面类型，**顺序即优先级**。
# 🔴 **横版在前，不是竖版** —— 与 Steam 那边（`steam_local.py` 的 COVER_KINDS）
#    同一条理由：卡片画框是 `aspect-ratio: 460 / 215`（≈2.14:1），
#    `DieselGameBox` 是横版、正好铺满；`DieselGameBoxTall`（1200×1600，比例 0.75）
#    塞进横框会被 `object-fit: cover` 只留中间一条，角色的头当场被裁掉。
#    竖版留在最后**只是兜底**（有总比空着强），`coverKind` 会如实回报是哪种，
#    以后要按形状换画法，前端有依据。
COVER_KINDS = ("DieselGameBox", "DieselGameBoxLogo", "DieselGameBoxTall")

# 「是不是游戏」的判据用到的两个类别（见 is_game_categories）
CAT_GAMES = "games"
CAT_APPLICATIONS = "applications"

# 清单目录 / 目录缓存的环境变量覆盖 —— **给测试用**：本机没装 EPIC 客户端，
# 夹具只能是指定目录里的合成文件。产品路径上不会设这两个变量。
ENV_DIR = "GV_EPIC_DIR"
ENV_CATALOG = "GV_EPIC_CATALOG"


def _programdata():
    return os.environ.get("PROGRAMDATA") or _PROGRAMDATA_FALLBACK


def _env_path(name):
    """读一个环境变量当路径用；空串/只有空白一律当没设。"""
    v = os.environ.get(name) or ""
    v = v.strip()
    return v or ""


def _registry_manifests_dir():
    """注册表里的清单目录；读不到 / 不是字符串 / 是空的 → None。**只读，绝不写。**"""
    try:
        import winreg
    except Exception:
        return None                      # 非 Windows：这条路不存在，不是错误
    try:
        with winreg.OpenKey(winreg.HKEY_CURRENT_USER, EPIC_REG_SUB, 0,
                            winreg.KEY_READ) as k:
            val, _kind = winreg.QueryValueEx(k, EPIC_REG_VALUE)
    except Exception:
        return None
    if not isinstance(val, str) or not val.strip():
        return None
    return os.path.normpath(val.strip())


def manifests_dir():
    """
    已安装清单目录（`...\\Data\\Manifests`）；这台机器上没有 → None。

    顺序：环境变量（测试）→ 注册表 → `%PROGRAMDATA%\\Epic\\...\\Manifests`。
    ⚠️ 返回的目录**不保证里面一定有 `.item`** —— "装了启动器但一款没装"是
       完全正常的状态（`read_manifests` 会给空表），别把它当"没装 EPIC"。
    """
    ov = _env_path(ENV_DIR)
    if ov:
        return ov

    reg = _registry_manifests_dir()
    if reg and os.path.isdir(reg):
        return reg

    fb = os.path.join(_programdata(), *_MANIFESTS_REL)
    return fb if os.path.isdir(fb) else None


def catalog_path():
    """
    整库目录缓存 `catcache.bin` 的路径；这台机器上没有 → None。

    先在清单目录的**兄弟位置**找（`Data\\Manifests` → `Data\\Catalog\\catcache.bin`），
    再退到 `%PROGRAMDATA%` 拼一遍。
    """
    ov = _env_path(ENV_CATALOG)
    if ov:
        return ov

    md = manifests_dir()
    if md:
        cand = os.path.join(os.path.dirname(md), "Catalog", "catcache.bin")
        if os.path.isfile(cand):
            return cand

    fb = os.path.join(_programdata(), *_CATALOG_REL)
    return fb if os.path.isfile(fb) else None


# ============================================================
# 判据（三条）
# ============================================================
def _category_paths(raw):
    """
    把类别字段抽成 `[路径字符串]`。

    容忍两种形状：`.item` 的 `AppCategories` 是 `["public","games",…]`，
    `catcache.bin` 的 `categories` 是 `[{"name":"","path":"games"}, …]`。
    """
    out = []
    if not isinstance(raw, (list, tuple)):
        return out
    for c in raw:
        if isinstance(c, dict):
            p = c.get("path")
            if isinstance(p, str) and p.strip():
                out.append(p.strip())
        elif isinstance(c, str) and c.strip():
            out.append(c.strip())
    return out


def is_game_categories(paths):
    """
    判据①：**是不是游戏** —— 类别里同时有 `games` 和 `applications`。

    实测（297 个目录条目）这条能收全 73 个游戏、又能挡掉：
      · Unreal 引擎（`engines` / `engines/ue5`）
      · Twinmotion 这类工具（只有 `applications` + `software`，没有 `games`）
      · 素材包（`assets` / `asset-format/…` / `type/asset`）
      · **最大的那坨垃圾 —— 纯装饰/权益条目（`audience`，297 里占 114 个）**

    ⚠️ 它**够用但不够细**：只靠类别**认不出 DLC**（见 `is_dlc_manifest`）。
    """
    return CAT_GAMES in paths and CAT_APPLICATIONS in paths


def is_dlc_manifest(manifest):
    """
    判据②：**是不是 DLC** —— `MainGameAppName` 非空。

    🔴 别按类别判断：《无主之地3》的 DLC「Bounty of Blood」类别是
       `[application, games, applications]` —— **和基游戏长得一模一样**，
       它唯一的孩子标记就是 `MainGame*` 那组字段。
    🔴 `dlcItemList` **永远是空数组**（297/297，连明明有 DLC 的基游戏也是空的）→
       **别用它**，DLC 只能从孩子往上认，不能从爹往下数。
    ⚠️ 基游戏上这三个字段是**空字符串，不是缺键** —— 所以判据是"非空"，
       不是"存在"。
    """
    for k in ("MainGameAppName", "MainGameCatalogItemId", "MainGameCatalogNamespace"):
        v = manifest.get(k)
        if isinstance(v, str) and v.strip():
            return True
    return False


def is_dlc_catalog(entry):
    """判据②在 `catcache.bin` 上的对应写法：`mainGameItem` 的 namespace / id 非空。"""
    main = entry.get("mainGameItem")
    if not isinstance(main, dict):
        return False
    for k in ("namespace", "id"):
        v = main.get(k)
        if isinstance(v, str) and v.strip():
            return True
    return False


def is_installed(manifest):
    """
    判据③：**装完没有** —— `bIsIncompleteInstall` 为假才算装好。

    🔴 `.item` 文件在**下载排队时就已经写盘**了（不是装完才写）→
       只看"这个文件在不在"会把**下到一半的游戏当成已安装的**。
       实测佐证：同一个清单在下到一半时 `InstallSize` 是 `0`、`bNeedsValidation` 是 `true`，
       装完后启动器日志里写着 `IncompleteInstall=0`。
    """
    return not bool(manifest.get("bIsIncompleteInstall"))


def identity_of(manifest_or_entry):
    """
    一条记录的**稳定身份** → `(namespace, catalogItemId)`；缺任一项返回 None。

    🔴 **不要用 `AppName` 当 id**（实测推翻过一次）：它是"**每次发版的代号**"，
       73 个条目里 **58 个是代号**（`Bluebird` 就是 Fez，还有 `Ginger` / `Cardinal` /
       `Wombat`），另外 15 个是 32 位十六进制串 —— **形状不可测，渲染出来就是乱码**。
       EPIC 自己在日志 / 配置 / 下载记录里用的也是 `namespace:catalogItemId:appName`
       这个三元组，所以身份取前两段。
    ⚠️ `namespace` 单独也不唯一（命名空间 `fn` 底下同时挂着 Fortnite 和三个子项，
       `catnip` 底下是《无主之地3》加九个 DLC），`catalogItemId` 单独碰巧唯一但没有契约保证
       → **两个一起用**。
    """
    if not isinstance(manifest_or_entry, dict):
        return None
    m = manifest_or_entry
    ns = m.get("CatalogNamespace") or m.get("namespace") or ""
    cid = m.get("CatalogItemId") or m.get("id") or ""
    ns = ns.strip() if isinstance(ns, str) else ""
    cid = cid.strip() if isinstance(cid, str) else ""
    if not ns or not cid:
        return None
    return (ns, cid)


def _pick_cover(images):
    """
    从 `keyImages` 里挑一张封面 → `(url, 类型名)`；没有就是 `(None, None)`。

    按 `COVER_KINDS` 的优先级（**横版在前**）。同一类型出现多次时取第一个 ——
    实测每个类型只有一条，但"取第一个"比"取最后一个"更接近它自己的顺序。
    """
    if not isinstance(images, list):
        return None, None
    by_kind = {}
    for im in images:
        if not isinstance(im, dict):
            continue
        t = im.get("type")
        u = im.get("url")
        t = t.strip() if isinstance(t, str) else ""
        u = u.strip() if isinstance(u, str) else ""
        if t and u and t not in by_kind:
            by_kind[t] = u
    for k in COVER_KINDS:
        if k in by_kind:
            return by_kind[k], k
    return None, None


def _int_size(v):
    """`InstallSize` 是 JSON **数字**（不是字符串）—— 但别对"它一定是数字"下赌注。"""
    if isinstance(v, bool):
        return 0
    if isinstance(v, (int, float)):
        return int(v)
    try:
        return int(str(v).strip())
    except (TypeError, ValueError):
        return 0


# ============================================================
# 读整库目录缓存（catcache.bin）
# ============================================================
def decode_catalog(raw):
    """
    把 `catcache.bin` 的字节解成目录条目列表；解不动返回 None。

    格式（实测）：**base64(明文 UTF-8 JSON)，不压缩、不加密**。
    顶层是一个**数组**（本机那份 297 条）。

    ⚠️ 也容忍"直接就是明文 JSON"这种写法 —— 启动器版本换过好几次格式，
       万一哪天不套 base64 了，这里不该整块失效（失败也不抛，回 None 让上层降级）。
    """
    if not raw:
        return None
    for decode in (lambda b: base64.b64decode(b, validate=False), lambda b: b):
        try:
            text = decode(raw).decode("utf-8-sig")
            data = json.loads(text)
        except Exception:
            continue
        if isinstance(data, list):
            return data
        # 容忍 `{"catalog": [...]}` 这种包一层的形状
        if isinstance(data, dict):
            for v in data.values():
                if isinstance(v, list):
                    return v
    return None


def read_catalog(path=None):
    """
    读 `catcache.bin` → `[条目…]`（原始形状，未过滤）；读不到 → None。

    🔑 **这是"已拥有全库"的免登录来源** —— 含**没安装**的款。实测启动器日志在
       写入这份文件的同一时刻打印 `found 74 entitled apps`，而当时机器上只装了 1 款。
       ⇒ 计划里那个"EPIC 只能拿已安装清单"的缺口，靠它补上了，而且不联网、不登录。
    ⚠️ 它是**开机登录后重写**的，所以和 Steam 的配置树一样是"最终一致" ——
       刚买下、还没重开启动器时读到的是上一版，这是预期行为，不是 bug。
    """
    path = path or catalog_path()
    if not path or not os.path.isfile(path):
        return None
    try:
        with open(path, "rb") as f:
            raw = f.read()
    except OSError:
        return None
    return decode_catalog(raw)


def catalog_games(entries):
    """
    目录条目 → `{(namespace, catalogItemId): 记录}`，只留**基游戏**。

    挡掉的三类（判据见上面各自的函数）：不是游戏 / 是 DLC / 缺身份字段。
    """
    out = {}
    for e in (entries or []):
        if not isinstance(e, dict):
            continue
        key = identity_of(e)
        if not key:
            continue
        if not is_game_categories(_category_paths(e.get("categories"))):
            continue
        if is_dlc_catalog(e):
            continue
        rel = e.get("releaseInfo")
        rel0 = rel[0] if (isinstance(rel, list) and rel and isinstance(rel[0], dict)) else {}
        cover, kind = _pick_cover(e.get("keyImages"))
        app_name = rel0.get("appId")
        dev = e.get("developer")
        date = rel0.get("dateAdded")
        out[key] = {
            "namespace": key[0],
            "catalogItemId": key[1],
            # ⚠️ AppName **只作为附带字段留着**（不当 id 用）—— 它是跨商店对号入座
            #    的钥匙（GOG 的 gamesdb 用它一次能认出 67/67 款 EPIC 游戏），
            #    以后要做"同一个游戏在 Steam 和 EPIC 都有"的去重，靠的就是它。
            "appName": app_name.strip() if isinstance(app_name, str) else "",
            "title": (e.get("title") or "").strip() if isinstance(e.get("title"), str) else "",
            "developer": dev.strip() if isinstance(dev, str) else "",
            # ⚠️ `releaseInfo[0].dateAdded` 是**商店上的发售日期**，不是"你什么时候领的"。
            #    本机没有任何字段记录"哪天领的" —— 别把这个问题当成拿到答案了。
            "releaseDate": date.strip() if isinstance(date, str) else "",
            "cover": cover,
            "coverKind": kind,
        }
    return out


# ============================================================
# 读已安装清单（Manifests/*.item）
# ============================================================
def read_manifests(directory=None):
    """
    扫清单目录 → `{(namespace, catalogItemId): 安装信息}`。

    ⚠️ **每一个 `.item` 一个 JSON 文件**，文件名主干就是它自己的 `InstallationGuid`。
       同一个游戏装了又卸，文件会消失 —— 所以"文件在不在"约等于"装没装"，
       唯一的例外是**下到一半**（判据③）。
    ⚠️ 清单在 `%PROGRAMDATA%` 下 = **机器级、跨 Windows 账号共享**。
       想知道"这是哪个 EPIC 账号的"得看 `catcache.bin`，不是看这里。
    ⚠️ 顺带一句：`UnrealEngineLauncher\\LauncherInstalled.dat` **是死的**，
       装了能玩的游戏它照样返回 `{"InstallationList": []}` —— 它跟的是 **Unreal 引擎**
       的安装，不是游戏。网上推荐它的文章全是错的，**别加回来**。
    """
    d = directory or manifests_dir()
    out = {}
    if not d or not os.path.isdir(d):
        return out
    try:
        names = os.listdir(d)
    except OSError:
        return out
    for fn in names:
        if not fn.lower().endswith(".item"):
            continue
        try:
            with open(os.path.join(d, fn), "r", encoding="utf-8-sig") as f:
                m = json.load(f)
        except Exception:
            # 读不动单个清单就跳过它，别让一个坏文件废掉整份库
            continue
        if not isinstance(m, dict):
            continue
        key = identity_of(m)
        if not key:
            continue
        cats = m.get("AppCategories")
        if not isinstance(cats, list) or not cats:
            # `TechnicalType` 是同一份列表的逗号拼接版（`"public,games,applications"`），
            # 实测冗余，但正好当 `AppCategories` 缺失时的兜底
            tt = m.get("TechnicalType")
            cats = [s.strip() for s in tt.split(",")] if isinstance(tt, str) else []
        if not is_game_categories(_category_paths(cats)):
            continue
        if is_dlc_manifest(m):
            continue
        title = m.get("DisplayName")
        loc = m.get("InstallLocation")
        exe = m.get("LaunchExecutable")
        app_name = m.get("AppName")
        ver = m.get("AppVersionString")
        out[key] = {
            "installed": is_installed(m),
            "title": title.strip() if isinstance(title, str) else "",
            # 绝对路径（和 Steam 的 `installdir` 不一样，那个只是个文件夹名）
            "installLocation": loc.strip() if isinstance(loc, str) else "",
            # 相对 `installLocation` 的可执行文件名；不可启动的条目是空串
            "launchExecutable": exe.strip() if isinstance(exe, str) else "",
            "installSize": _int_size(m.get("InstallSize")),
            "appName": app_name.strip() if isinstance(app_name, str) else "",
            "version": ver.strip() if isinstance(ver, str) else "",
        }
    return out


# ============================================================
# 汇总出口（给 /api/local/epic）
# ============================================================
def read_library():
    """
    桌面版 EPIC 的出口：**已拥有全库 ∪ 已安装清单**。

    返回形状（前端直接用）：
        { ok, manifestsDir, catalogPath, catalogFound, catalogOk,
          games:[{appid,title,developer,releaseDate,cover,coverKind,
                  installed,installSize,appName,epicId}],
          stats:{total,installed,named,withCover,installedOnly,catalogEntries} }

    `ok=False` 时带 `reason`：`epic_not_found`（这台机器上没有 EPIC 的任何痕迹）。

    🔴 `ok=False` 与"`ok=True` 但 `games` 是空"是**两件不同的事**：
       前者 = 没装启动器 / 装在别处；后者 = 装了、也读到了，但你库里一款游戏都没有。
       前端要分别说，混成一句用户会照着错的提示去折腾。

    ⚠️ `catalogFound` / `catalogOk` 是**两个**标志，别合成一个：
       · `catalogFound=False` —— 这份文件根本不在（老版本启动器 / 从没登录过）
       · `catalogFound=True, catalogOk=False` —— 文件在、但解不动（换了格式 / 权限 / 写一半）
       前者不用提，后者得在界面上说清"整库缓存没读动"。合成一个布尔量，
       用户看到的就是一句指向错误方向的提示。
    """
    md = manifests_dir()
    cp = catalog_path()
    if not md and not cp:
        return {"ok": False, "reason": "epic_not_found", "games": [], "stats": {}}

    entries = read_catalog(cp)
    catalog_ok = entries is not None
    cat = catalog_games(entries or [])
    inst = read_manifests(md)

    keys, seen = [], set()
    for k in cat:
        keys.append(k)
        seen.add(k)
    # 清单里有、目录缓存里没有的（老启动器不写 catcache，或缓存是旧的）→ 也要收，
    # 否则"装着的游戏在界面上消失"比"少了个发售年"难解释得多
    for k in inst:
        if k not in seen:
            keys.append(k)
            seen.add(k)

    games = []
    installed_only = 0
    for k in keys:
        c = cat.get(k) or {}
        m = inst.get(k) or {}
        if k not in cat:
            installed_only += 1
        title = c.get("title") or m.get("title") or ""
        games.append({
            # 🔴 appid 是**带前缀的字符串**（不是数字）：两个平台的 id 空间完全不同，
            #    前缀一眼能看出归属，也保证和 Steam 的数字 appid 永不撞车。
            #    中间那两段取自 EPIC 自己的复合身份 —— 理由见 identity_of()。
            "appid": "epic:%s:%s" % (k[0], k[1]),
            "title": title,
            "developer": c.get("developer") or "",
            "releaseDate": c.get("releaseDate") or "",
            "cover": c.get("cover"),
            "coverKind": c.get("coverKind"),
            "installed": bool(m.get("installed")),
            "installSize": m.get("installSize", 0),
            "appName": c.get("appName") or m.get("appName") or "",
            "epicId": "%s:%s" % (k[0], k[1]),
        })
    games.sort(key=lambda g: (g["title"] or "~").lower())

    return {
        "ok": True,
        "manifestsDir": md or "",
        "catalogPath": cp or "",
        "catalogFound": bool(cp) and os.path.isfile(cp),
        "catalogOk": catalog_ok,
        "games": games,
        "stats": {
            "total": len(games),
            "installed": sum(1 for g in games if g["installed"]),
            "named": sum(1 for g in games if g["title"]),
            "withCover": sum(1 for g in games if g["cover"]),
            # 只在安装清单里、不在整库缓存里的款 —— 往往是"缓存还没刷新"，
            # 排查"数字对不上"时看这个
            "installedOnly": installed_only,
            "catalogEntries": len(entries or []),
        },
    }
