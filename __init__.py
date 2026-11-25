# -*- coding: utf-8 -*-
"""提示词工具 —— 词库节点 + LLM 改写节点。

本体：提示词库（点击插入）
    节点上直接平铺分类标签按钮与搜索框，点击标签即追加到节点文本，
    输出 STRING 可连接任意 CLIPTextEncode 的 text 输入。

子模块 llm_nodes/：H3 提示词助手、生图提示词助手
    把口语化的简短描述交给 LLM 改写成可直接用的提示词，见 llm_nodes/README.md。
"""
import json
import os

from aiohttp import web
from server import PromptServer

from .llm_nodes import NODE_CLASS_MAPPINGS as _LLM_CLASSES
from .llm_nodes import NODE_DISPLAY_NAME_MAPPINGS as _LLM_NAMES

_DIR = os.path.dirname(os.path.realpath(__file__))
_DATA = os.path.join(_DIR, "data")


# 顺序基准文件：它的 order 决定分类栏排布，其余文件按文件名顺序依次并入
BASE_FILE = "tags.json"


def _lib_files():
    """收集 data 目录下的全部词库文件。

    规则：基准文件 tags.json 先加载（定义分类栏顺序），其余 .json 按文件名排序
    依次并入，因此可以用 `10_xxx.json` / `90_xxx.json` 这类数字前缀控制合并顺序。
    以 `_` 或 `.` 开头的文件（备份、临时文件）自动跳过。
    """
    base = os.path.join(_DATA, BASE_FILE)
    files = []
    if os.path.isfile(base):
        files.append(base)
    if not os.path.isdir(_DATA):
        return files
    for name in sorted(os.listdir(_DATA)):
        if not name.lower().endswith(".json") or name.startswith(("_", ".")):
            continue
        p = os.path.join(_DATA, name)
        if os.path.isfile(p) and os.path.abspath(p) != os.path.abspath(base):
            files.append(p)
    return files


def _load_lib():
    """合并 data 目录下的所有词库文件（数量不限）。

    兼容两种文件格式：{分类: [词条...]} 或 {"order": [...], "tags": {...}}。
    分类栏顺序以基准文件 tags.json 的 order 为准；新分类若在基准 order 里预留过
    就插到对应位置，没预留则追加在「负面」之前。同分类内英文 tag 去重。
    """
    tags, order, master = {}, [], []
    for path in _lib_files():
        try:
            with open(path, encoding="utf-8") as f:
                d = json.load(f)
        except Exception as e:  # 单个文件写错不影响其余文件加载
            print("[PromptLibrary] 读取", os.path.basename(path), "失败:", e)
            continue
        if not isinstance(d, dict):
            continue
        items_by_cat = d.get("tags", d)
        if not isinstance(items_by_cat, dict):
            continue
        file_order = d.get("order", []) if isinstance(d.get("order"), list) else []

        if not master:  # 首个文件 = 顺序基准
            master = [c for c in file_order if isinstance(c, str)]
            tags = {k: list(v) for k, v in items_by_cat.items() if isinstance(v, list)}
            order = [c for c in master if c in tags]
            order += [c for c in tags if c not in order]
            continue

        for cat_name in file_order + [c for c in items_by_cat if c not in file_order]:
            items = items_by_cat.get(cat_name)
            if not isinstance(items, list):
                continue
            if cat_name not in tags:
                tags[cat_name] = []
                if cat_name in master:
                    # 预留过位置：插到 master 中下一个已上栏的分类之前
                    at = len(order)
                    for c in master[master.index(cat_name) + 1:]:
                        if c in order:
                            at = order.index(c)
                            break
                    order.insert(at, cat_name)
                else:
                    order.append(cat_name)
            exist = {t.get("t") for t in tags[cat_name]}
            for item in items:
                if isinstance(item, dict) and item.get("t") and item["t"] not in exist:
                    tags[cat_name].append(item)
                    exist.add(item["t"])
    # 空分类不上栏；名称含"负面"的分类（写实负面、负面）固定垫底并贴在一起
    order = [c for c in order if tags.get(c)]
    tags = {c: v for c, v in tags.items() if v}
    neg_cats = [c for c in order if "负面" in c]
    order = [c for c in order if "负面" not in c] + neg_cats
    return {"tags": tags, "order": order}


class PromptLibraryNode:
    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "text": ("STRING", {"default": "", "multiline": True, "dynamicPrompts": False}),
            }
        }

    RETURN_TYPES = ("STRING",)
    RETURN_NAMES = ("text",)
    FUNCTION = "run"
    CATEGORY = "提示词工具"
    DESCRIPTION = ("上方文本框输出 prompt（STRING，可直接连线到任意节点的文本输入），"
                   "下方提示词库为抽拉式抽屉：点词条选中（高亮），再点取消；收起时只留一条把手不占空间。")

    def run(self, text):
        return (text,)


NODE_CLASS_MAPPINGS = {"PromptLibraryNode": PromptLibraryNode}
NODE_DISPLAY_NAME_MAPPINGS = {"PromptLibraryNode": "提示词库（点击插入）"}

# 并入 llm_nodes 子模块的节点（H3 提示词助手 / 生图提示词助手），
# 三个节点同属「提示词工具」分类。
NODE_CLASS_MAPPINGS.update(_LLM_CLASSES)
NODE_DISPLAY_NAME_MAPPINGS.update(_LLM_NAMES)

# 前端扩展：web/prompt_library.js（词库抽屉）、web/prompt_helper.js（「设置 API」按钮）
WEB_DIRECTORY = "./web"

# 节点里新增的词条写在 99_自定义.json（按文件名排在最后，会被正常加载）；
# 预设以 _ 开头，不会被当作词库加载，只由前端单独读写
_CUSTOM = os.path.join(_DATA, "99_自定义.json")
_PRESETS = os.path.join(_DATA, "_presets.json")


def _read_json(path, default):
    if not os.path.isfile(path):
        return default
    try:
        with open(path, encoding="utf-8") as f:
            return json.load(f)
    except Exception as e:
        print("[PromptLibrary] 读取", os.path.basename(path), "失败:", e)
        return default


def _write_json(path, data):
    with open(path, "w", encoding="utf-8") as f:
        json.dump(data, f, ensure_ascii=False, indent=2)
        f.write("\n")


if PromptServer.instance is not None:

    @PromptServer.instance.routes.get("/prompt_lib/tags")
    async def prompt_lib_tags(request):
        return web.json_response(_load_lib())

    @PromptServer.instance.routes.post("/prompt_lib/tag")
    async def prompt_lib_add_tag(request):
        """往 99_自定义.json 里追加一条自定义词条。"""
        try:
            data = await request.json()
        except Exception:
            return web.json_response({"ok": False, "error": "请求格式错误"}, status=400)
        cat = str(data.get("cat", "")).strip()
        tag = str(data.get("t", "")).strip()
        zh = str(data.get("z", "")).strip() or tag
        if not cat or not tag:
            return web.json_response({"ok": False, "error": "分类和词条都不能为空"}, status=400)
        doc = _read_json(_CUSTOM, {"order": [], "tags": {}})
        doc.setdefault("tags", {}).setdefault(cat, [])
        if any(x.get("t") == tag for x in doc["tags"][cat]):
            return web.json_response({"ok": False, "error": "该分类里已有这个词条"})
        doc["tags"][cat].append({"t": tag, "z": zh})
        _write_json(_CUSTOM, doc)
        return web.json_response({"ok": True})

    @PromptServer.instance.routes.get("/prompt_lib/presets")
    async def prompt_lib_get_presets(request):
        return web.json_response({"presets": _read_json(_PRESETS, {})})

    @PromptServer.instance.routes.post("/prompt_lib/preset")
    async def prompt_lib_save_preset(request):
        """保存 / 删除预设；预设内容就是节点文本框里的整段文本。"""
        try:
            data = await request.json()
        except Exception:
            return web.json_response({"ok": False, "error": "请求格式错误"}, status=400)
        name = str(data.get("name", "")).strip()
        if not name:
            return web.json_response({"ok": False, "error": "预设名不能为空"}, status=400)
        presets = _read_json(_PRESETS, {})
        if data.get("delete"):
            presets.pop(name, None)
        else:
            presets[name] = str(data.get("text", ""))
        _write_json(_PRESETS, presets)
        return web.json_response({"ok": True, "presets": presets})
