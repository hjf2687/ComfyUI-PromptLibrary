"""
生图提示词助手 —— ComfyUI-PromptLibrary / llm_nodes 子模块

把口语化的简短描述交给 LLM，按「预设」里定义的写法，改写成可直接喂给生图模型的提示词。

预设是数据、不是代码 —— 加新模型只要往 image_presets/ 丢一个 json，不用改这里。
预设只有这一处真源，不分层查找。

预设字段：

    id                  唯一标识，被 extends 引用时用这个
    name                下拉里显示的名字（也是节点「模式」的值）
    order               排前面的小（默认 100，内置用 10/20）
    extends             可选，继承另一个预设的 rules / language / negative
    language            "en" 或 "zh"，输出语言；不填则继承
    negative            true 时额外输出一段负面词
    negative_fallback   模型没按两段格式输出时回落的固定词表
    rules               正向提示词的写法要求，一条一项
    negative_rules      负面词的写法要求，一条一项

配置（base_url / api_key / model）与 H3 那个节点共用同一份 config.json，
节点上的「设置 API」按钮也一样 —— key 只填一次。
"""

import json
import logging
import os
import re

from .nodes import (
    NODE_DIR,
    _call_llm,
    _require_config,
    _strip_fence,
)

IMAGE_PRESETS_DIR = os.path.join(NODE_DIR, "image_presets")

LOGGER_NAME = "生图提示词助手"
DEFAULT_LANGUAGE = "en"
DEFAULT_ORDER = 100
MAX_EXTENDS_DEPTH = 5

# 两段输出的分隔标记。用大写 ASCII，解析时大小写不敏感、允许两侧有多余的 = 或空白。
_MARK_RE = re.compile(r"^[=\-\s]*(POSITIVE|NEGATIVE)[=\-\s]*$", re.IGNORECASE | re.MULTILINE)


# ==================== 预设文件 ====================

def _as_rule_list(value):
    if value is None:
        return []
    if isinstance(value, str):
        value = [value]
    if not isinstance(value, (list, tuple)):
        return []
    return [str(item).strip() for item in value if str(item).strip()]


def _load_preset_files(directory):
    """扫一个目录下的 *.json，返回原始条目（未解析 extends）。坏文件只警告，不打断。"""
    items = []
    if not os.path.isdir(directory):
        return items
    for filename in sorted(os.listdir(directory)):
        if not filename.lower().endswith(".json"):
            continue
        path = os.path.join(directory, filename)
        try:
            with open(path, "r", encoding="utf-8") as fh:
                data = json.load(fh)
        except (OSError, json.JSONDecodeError) as exc:
            logging.warning("[%s] 读不了预设 %s：%s", LOGGER_NAME, path, exc)
            continue
        if not isinstance(data, dict):
            logging.warning("[%s] 预设 %s 不是对象，跳过", LOGGER_NAME, path)
            continue

        name = str(data.get("name") or os.path.splitext(filename)[0]).strip()
        if not name:
            continue
        language = data.get("language")
        negative = data.get("negative")
        fallback = data.get("negative_fallback")
        order = data.get("order")
        try:
            order = int(order)
        except (TypeError, ValueError):
            order = DEFAULT_ORDER

        items.append({
            "id": str(data.get("id") or name).strip(),
            "name": name,
            "order": order,
            "extends": str(data.get("extends") or "").strip(),
            # 这三个用 None 表示"没写"，好跟"写了空值"区分开，继承时才知道该不该覆盖
            "language": (str(language).strip().lower() if language is not None else None),
            "negative": (bool(negative) if negative is not None else None),
            "negative_fallback": (str(fallback).strip() if fallback is not None else None),
            "rules": _as_rule_list(data.get("rules")),
            "negative_rules": _as_rule_list(data.get("negative_rules")),
            "source": path,
        })
    return items


def load_presets():
    """扫 image_presets/，按 order/名字排好。同 id 撞车时后扫到的覆盖先扫到的。"""
    by_id = {}
    for item in _load_preset_files(IMAGE_PRESETS_DIR):
        by_id[item["id"]] = item
    return sorted(by_id.values(), key=lambda p: (p["order"], p["name"]))


def _flatten(preset, by_id, depth=0):
    """把 extends 链摊平：rules 叠加，语言/负面词按"子级没写才向上取"处理。"""
    parent = None
    extends = preset.get("extends")
    if extends:
        target = by_id.get(extends)
        if target is None:
            logging.warning("[%s] 预设「%s」引用的 extends=%s 找不到，只用它自己的 rules",
                            LOGGER_NAME, preset["name"], extends)
        elif depth >= MAX_EXTENDS_DEPTH:
            logging.warning("[%s] 预设「%s」的 extends 链太深（>%d 层），就此打住",
                            LOGGER_NAME, preset["name"], MAX_EXTENDS_DEPTH)
        else:
            parent = _flatten(target, by_id, depth + 1)

    def pick(key, default=None):
        value = preset.get(key)
        if value is not None:
            return value
        if parent is not None:
            return parent[key]
        return default

    return {
        "id": preset["id"],
        "name": preset["name"],
        "language": pick("language", DEFAULT_LANGUAGE) or DEFAULT_LANGUAGE,
        "negative": bool(pick("negative", False)),
        "negative_fallback": pick("negative_fallback", "") or "",
        "rules": (parent["rules"] if parent else []) + preset["rules"],
        "negative_rules": (parent["negative_rules"] if parent else []) + preset["negative_rules"],
        "source": preset["source"],
    }


def resolve_preset(name):
    """按下拉里显示的名字取最终预设（把 extends 链摊平）。"""
    presets = load_presets()
    for preset in presets:
        if preset["name"] == name:
            return _flatten(preset, {p["id"]: p for p in presets})
    raise RuntimeError(
        "生图提示词助手：不认识的模式「" + str(name) + "」。"
        "预设文件放在 " + IMAGE_PRESETS_DIR + "，加完要重启 ComfyUI。"
    )


def preset_names():
    """下拉选项。一个都没有时给个占位，免得前端拿到空列表报错。"""
    names = [preset["name"] for preset in load_presets()]
    return names or ["（没找到预设文件）"]


# ==================== 提示词组装 ====================

def _build_image_system_prompt(preset):
    language = preset["language"]
    lang_label = "英文" if language == "en" else "中文"
    negative = preset["negative"]

    parts = [
        "你是图像生成模型（Stable Diffusion / SDXL / 各类 DiT 生图模型）的提示词工程师。",
        "用户会用中文口语化地描述画面，你要把它改写成可以直接粘进生图模型的正向提示词 —— "
        "不是复述用户的话，而是按下面的写法要求把它写全、写具体。",
        "",
        "【本次写法要求】（" + preset["name"] + "）",
    ]
    parts += ["- " + rule for rule in preset["rules"]]
    parts += [
        "",
        "【输出语言】" + lang_label + "。用户给的是中文描述，你要把它改写成" + lang_label + "提示词。",
    ]

    if negative:
        parts += [
            "",
            "【输出格式】严格按下面两段输出，除了这两段什么都不要有 —— "
            "不要开场白、不要解释、不要 markdown 代码块、不要用 ``` 包裹：",
            "",
            "===POSITIVE===",
            "（正向提示词）",
            "===NEGATIVE===",
            "（负面提示词）",
        ]
        if preset["negative_rules"]:
            parts += ["", "【负面词的额外要求】"]
            parts += ["- " + rule for rule in preset["negative_rules"]]
    else:
        parts += [
            "",
            "【输出格式】只输出正向提示词本身 —— 不要开场白、不要解释、不要小标题、"
            "不要 markdown 代码块、不要用 ``` 包裹、不要加「提示词：」这类前缀。",
        ]

    parts += [
        "",
        "【通用要求】",
        "- 用户没提到的具体角色名、作品名、品牌、真人姓名一律不要凭空添加；反过来，用户提到的角色必须照写成角色 tag，不要用外貌描述替换。画面细节可以补，但用户的意图不能改。",
        "- 不要输出任何解释性文字或自问自答，输出必须能直接粘进生图模型就用。",
    ]
    return "\n".join(parts)


def _build_image_user_message(text, extra):
    parts = ["【用户的描述】\n" + text.strip()]
    if extra and extra.strip():
        parts.append("【补充要求】\n" + extra.strip())
    return "\n\n".join(parts)


def _clean_block(text):
    """模型有时还是会把每段各自包一层 ```，或者带上标记行，都清掉。"""
    out = _strip_fence(text or "")
    lines = [line for line in out.splitlines() if not _MARK_RE.match(line.strip())]
    return "\n".join(lines).strip()


def split_output(raw, preset):
    """把模型返回拆成（正向, 负面）。容错策略：认不出标记就整段当正向，负面回落到预设的固定词表。"""
    negative_wanted = preset["negative"]
    matches = list(_MARK_RE.finditer(raw))

    positive = negative = ""
    if matches:
        for index, match in enumerate(matches):
            end = matches[index + 1].start() if index + 1 < len(matches) else len(raw)
            body = raw[match.end():end]
            kind = match.group(1).upper()
            if kind == "POSITIVE" and not positive:
                positive = _clean_block(body)
            elif kind == "NEGATIVE" and not negative:
                negative = _clean_block(body)

    if not positive:
        # 没认出来（或者模型干脆没给标记）：整段当正向，别把内容丢掉
        positive = _clean_block(raw)
        if matches:
            logging.warning("[%s] 预设「%s」的输出里没找到正向段，整段当正向用了。",
                            LOGGER_NAME, preset["name"])

    if not negative_wanted:
        return positive, ""

    if not negative:
        logging.warning("[%s] 预设「%s」没拿到负面段，回落到预设里的固定词表。",
                        LOGGER_NAME, preset["name"])
        negative = preset["negative_fallback"]
    return positive, negative


# ==================== 节点 ====================

class ImagePromptHelper:
    """把简短描述扩写成生图模型用的提示词（正向 + 负面）。"""

    @classmethod
    def INPUT_TYPES(cls):
        names = preset_names()
        return {
            "required": {
                "描述": ("STRING", {"multiline": True, "default": "", "dynamicPrompts": False}),
                "模式": (names, {"default": names[0]}),
                "变体": ("INT", {"default": 0, "min": 0, "max": 999999, "step": 1}),
            },
            "optional": {
                "补充要求": ("STRING", {"multiline": True, "default": "", "dynamicPrompts": False}),
            },
        }

    RETURN_TYPES = ("STRING", "STRING")
    RETURN_NAMES = ("正向提示词", "负面提示词")
    FUNCTION = "generate"
    CATEGORY = "提示词工具"
    DESCRIPTION = (
        "接 LLM，把口语描述扩写成生图模型用的提示词。模式下拉来自预设文件，"
        "加新模型只需往预设目录丢 json。与 H3 提示词助手共用同一份 API 配置；改「变体」可强制重新生成。"
        "「描述」留空则不发请求，直接输出空提示词。"
    )

    def generate(self, 描述, 模式, 变体, 补充要求=""):
        text = (描述 or "").strip()
        if not text:
            # 「描述」是空的就当这个节点不存在：不发请求、不报错，直接吐两个空串出去。
            # 这样另一个提示词节点（比如提示词库）可以单独接在后面用，不会被这里带崩整个队列。
            return ("", "")
        preset = resolve_preset(模式)
        if not preset["rules"]:
            raise RuntimeError(
                "生图提示词助手：预设「" + str(模式) + "」里一条 rules 都没有（" + preset["source"] + "）。"
            )

        cfg = _require_config()
        raw = _call_llm(
            cfg,
            _build_image_system_prompt(preset),
            _build_image_user_message(text, 补充要求),
        )
        positive, negative = split_output(raw, preset)
        if not positive:
            raise RuntimeError("生图提示词助手：模型返回的正向提示词是空的，换个模型或重试。")
        return (positive, negative)


NODE_CLASS_MAPPINGS = {
    "ImagePromptHelper": ImagePromptHelper,
}

NODE_DISPLAY_NAME_MAPPINGS = {
    "ImagePromptHelper": "生图提示词助手",
}
