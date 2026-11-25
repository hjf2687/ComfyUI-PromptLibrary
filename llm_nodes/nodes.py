"""
MiniMax H3 提示词助手 —— ComfyUI-PromptLibrary / llm_nodes 子模块

把口语化的简短描述交给 LLM，按 H3 官方规范改写成可直接喂给 H3 生成节点的提示词。

配置存同目录下的 config.json（不进工作流 json，key 不会随工作流外泄）。
节点上的「设置 API」按钮（前端扩展）就是这份文件的图形编辑器；
不装前端扩展也能用 —— 直接手改 config.json 一样生效。

节点输出一个 STRING，连到 MiniMaxH3ReferenceToVideo / MiniMaxH3ImageToVideo 的 prompt 输入口。
"""

import asyncio
import json
import os
import urllib.error
import urllib.request

NODE_DIR = os.path.dirname(os.path.abspath(__file__))
CONFIG_PATH = os.path.join(NODE_DIR, "config.json")
PROMPTS_DIR = os.path.join(NODE_DIR, "prompts")

DEFAULT_CONFIG = {
    "base_url": "",
    "api_key": "",
    "model": "",
    "temperature": 0.7,
    "timeout": 300,
}

# 面板可以改的字段（顺序即 GUI 里的顺序）
EDITABLE_KEYS = ("base_url", "api_key", "model", "temperature", "timeout")

# 模式 -> 吃哪份规范 + 这次要跟模型强调什么
MODE_SPEC = {
    "单图参考": {
        "file": "ref-en.txt",
        "brief": (
            "本次是全参考模式（Ref2VA），而且【只有一张参考图】。\n"
            "这张图不是首帧也不是尾帧，而是参考素材：把图里的角色、服装、场景、风格抽象成 <Subject N>，"
            "其中 <Subject 1> 用 `is the ... in <Picture 1>` 这类写法，在 subject_definitions 里定义清楚，"
            "再在 detailed_description 里描述新画面如何取用它。\n"
            "因为只有一张图，绝对不要编造 <Picture 2>、<Video N>、<Audio N>。"
        ),
    },
    "多参考混合": {
        "file": "ref-en.txt",
        "brief": (
            "本次是全参考模式（Ref2VA），【有多张参考图】。\n"
            "每张图按 <Picture N> 编号，从中抽象出需要的 <Subject N>，在 subject_definitions 里逐条定义；"
            "在 retention_analysis 里逐项说明它是被完整保留、部分保留、迁移还是复用。\n"
            "用户给了参考视频或音频素材时用 <Video N> / <Audio N>；没给就不要凭空编造。\n"
            "注意：同一张图可以提供多个 Subject，一个 Subject 也可以由多张图共同定义，按实际关系写。"
        ),
    },
    "首尾帧补间": {
        "file": "base-en.txt",
        "brief": (
            "本次是 FL2VA（首尾帧补间）：第一张图是首帧、第二张图是尾帧，中间的连续变化由你补完整。\n"
            "提示词第一行必须使用 FL2VA 规定的固定对齐指令句，把 Picture 1 对齐 0.00 秒、"
            "Picture 2 对齐视频结束时刻（两位小数）。\n"
            "整段一般保持单镜头，让模型能从首帧连续插值到尾帧；只有用户明确要求时才分多个 [Shot]，"
            "并且必须让最后的 [Shot N] 结束时正好落到尾帧。\n"
            "另外这次不要写 subject_definitions / summary / retention_analysis 这些全参考模式的段落。"
        ),
    },
}


# ==================== 配置文件读写 ====================

def _ensure_config_file():
    """config.json 不存在就生成一份空模板，方便直接改。"""
    if not os.path.exists(CONFIG_PATH):
        try:
            with open(CONFIG_PATH, "w", encoding="utf-8") as fh:
                json.dump(DEFAULT_CONFIG, fh, ensure_ascii=False, indent=2)
        except OSError:
            pass


def read_config():
    """读配置，不校验必填项。节点和 GUI 面板都走这里。"""
    _ensure_config_file()
    cfg = dict(DEFAULT_CONFIG)
    try:
        with open(CONFIG_PATH, "r", encoding="utf-8") as fh:
            loaded = json.load(fh)
        if isinstance(loaded, dict):
            cfg.update(loaded)
    except FileNotFoundError:
        pass
    except (OSError, json.JSONDecodeError) as exc:
        raise RuntimeError("提示词助手：config.json 读不出来（" + str(exc) + "）。") from None
    return cfg


def write_config(updates):
    """把面板提交的字段合并写回；不认识的字段和没提交的字段一律保留原值。"""
    cfg = read_config()
    for key in EDITABLE_KEYS:
        if not isinstance(updates, dict) or key not in updates or updates[key] is None:
            continue
        if key in ("temperature", "timeout"):
            try:
                cfg[key] = float(updates[key])
            except (TypeError, ValueError):
                continue
        elif key == "base_url":
            cfg[key] = str(updates[key]).strip().rstrip("/")
        else:
            cfg[key] = str(updates[key]).strip()
    with open(CONFIG_PATH, "w", encoding="utf-8") as fh:
        json.dump(cfg, fh, ensure_ascii=False, indent=2)
    return cfg


def _require_config():
    """节点真正要用的时候才校验必填，缺了给出能直接照做的提示。"""
    cfg = read_config()
    missing = [k for k in ("base_url", "api_key", "model") if not str(cfg.get(k, "")).strip()]
    if missing:
        raise RuntimeError(
            "提示词助手：还没配置 " + " / ".join(missing)
            + "。在节点上点「设置 API」按钮填一下，或者直接编辑 " + CONFIG_PATH
            + "（H3 提示词助手和生图提示词助手共用这一份配置）"
        )
    return cfg


_ensure_config_file()


# ==================== 规范文件与提示词组装 ====================

def _read_guide(filename):
    path = os.path.join(PROMPTS_DIR, filename)
    try:
        with open(path, "r", encoding="utf-8") as fh:
            return fh.read()
    except OSError as exc:
        raise RuntimeError("H3 提示词助手：读不到规范文件 " + path + "（" + str(exc) + "）。") from None


def _build_system_prompt(mode, duration):
    spec = MODE_SPEC[mode]
    guide = _read_guide(spec["file"])
    dur = "%.2f" % duration
    return (
        "你是 MiniMax H3 视频生成模型的提示词工程师。\n"
        "用户会给你一段口语化的简短描述，你要按下面的官方规范，把它改写成可以直接喂给 H3 的完整提示词。\n\n"
        "===== 官方规范开始（字段名、字段顺序、标签写法、时间戳格式必须严格遵守）=====\n"
        + guide
        + "\n===== 官方规范结束 =====\n\n"
        "【本次任务】\n"
        + spec["brief"]
        + "\n目标视频总时长：" + dur + " 秒。"
        "所有镜头切点必须落在 0.00 ~ " + dur + " 秒之间，最后一段结束于 " + dur + " 秒。\n\n"
        "【输出要求】\n"
        "1. 正文用英文写；对白、歌词、画面内可见文字保留原语言。\n"
        "2. 只输出提示词本身——不要开场白、不要解释、不要小标题、不要 markdown 代码块、不要用 ``` 包裹。\n"
        "3. 严格按照规范规定的字段顺序逐段输出，字段名写法照抄规范。\n"
        "4. 用户没说过的专有名词、品牌、人名一律不要凭空添加；画面细节可以补，但剧情意图不能改。\n"
        "5. 镜头、运镜、声音要写具体，不要用 cinematic、beautiful、stunning 这类空词。\n"
        "6. 时长必须和上面给的秒数一致，不要写出超出范围的切点。"
    )


def _build_user_message(text, extra, duration):
    parts = ["【用户的口语描述】\n" + text.strip()]
    if extra and extra.strip():
        parts.append("【补充要求】\n" + extra.strip())
    parts.append("【目标时长】" + ("%.2f" % duration) + " 秒")
    return "\n\n".join(parts)


def _strip_fence(text):
    """模型偶尔还是会包一层 ```，剥掉。"""
    out = text.strip()
    if out.startswith("```"):
        lines = out.splitlines()
        if lines and lines[0].lstrip().startswith("```"):
            lines = lines[1:]
        if lines and lines[-1].strip().startswith("```"):
            lines = lines[:-1]
        out = "\n".join(lines).strip()
    return out


def _extract_content(body):
    try:
        choice = body["choices"][0]
    except (KeyError, IndexError, TypeError):
        raise RuntimeError(
            "接口返回里没有 choices，原始返回前 300 字："
            + json.dumps(body, ensure_ascii=False)[:300]
        ) from None
    message = choice.get("message") or {}
    content = message.get("content")
    # 有些中转会把 content 返回成 [{type:text, text:...}] 形式
    if isinstance(content, list):
        chunks = []
        for item in content:
            if isinstance(item, dict) and item.get("text"):
                chunks.append(str(item["text"]))
            elif isinstance(item, str):
                chunks.append(item)
        content = "".join(chunks)
    if not content or not str(content).strip():
        raise RuntimeError("模型返回了空内容，换个模型或重试。")
    return str(content)


# ==================== HTTP ====================

def _post_json(cfg, payload):
    """发一次 POST 拿 JSON。所有网络错误都带着上游原文抛出来，方便定位。"""
    base = str(cfg.get("base_url", "")).strip().rstrip("/")
    if not base:
        raise RuntimeError("接口地址（base_url）是空的。")
    url = base if base.lower().endswith("/chat/completions") else base + "/chat/completions"

    data = json.dumps(payload, ensure_ascii=False).encode("utf-8")
    req = urllib.request.Request(url, data=data, method="POST")
    req.add_header("Content-Type", "application/json")
    req.add_header("Authorization", "Bearer " + str(cfg.get("api_key", "")).strip())

    timeout = float(cfg.get("timeout", 300) or 300)
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            raw = resp.read().decode("utf-8", "replace")
    except urllib.error.HTTPError as exc:
        detail = exc.read().decode("utf-8", "replace")[:500]
        raise RuntimeError("接口返回 HTTP " + str(exc.code) + "。" + detail) from None
    except urllib.error.URLError as exc:
        raise RuntimeError(
            "连不上 " + url + "（" + str(exc.reason) + "）。检查接口地址和网络。"
        ) from None
    except TimeoutError:
        raise RuntimeError(
            "等待超过 " + str(timeout) + " 秒还没返回，把 timeout 调大或换个更快的模型。"
        ) from None

    try:
        return json.loads(raw)
    except json.JSONDecodeError:
        raise RuntimeError("返回的不是 JSON，前 300 字：" + raw[:300]) from None


def ping_llm(cfg):
    """面板的「测试连接」用：发一个最小请求，确认地址 / key / 模型都对。"""
    # 探测请求把超时压到 30 秒 —— 填错地址时不该让人干等五分钟
    probe = dict(cfg)
    try:
        probe["timeout"] = min(float(cfg.get("timeout") or 60), 30)
    except (TypeError, ValueError):
        probe["timeout"] = 30
    body = _post_json(probe, {
        "model": str(cfg.get("model", "")).strip(),
        "messages": [{"role": "user", "content": "ping"}],
        "max_tokens": 8,
    })
    return _extract_content(body)


def _call_llm(cfg, system_prompt, user_prompt):
    body = _post_json(cfg, {
        "model": str(cfg.get("model", "")).strip(),
        "messages": [
            {"role": "system", "content": system_prompt},
            {"role": "user", "content": user_prompt},
        ],
        "temperature": float(cfg.get("temperature", 0.7) or 0.7),
    })
    return _strip_fence(_extract_content(body))


# ==================== 节点 ====================

class H3PromptHelper:
    """把简短描述扩写成 MiniMax H3 官方格式的视频提示词。"""

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "描述": ("STRING", {"multiline": True, "default": "", "dynamicPrompts": False}),
                "模式": (list(MODE_SPEC.keys()), {"default": "单图参考"}),
                "时长": ("FLOAT", {"default": 5.0, "min": 4.0, "max": 15.0, "step": 0.1}),
                "变体": ("INT", {"default": 0, "min": 0, "max": 999999, "step": 1}),
            },
            "optional": {
                "补充要求": ("STRING", {"multiline": True, "default": "", "dynamicPrompts": False}),
            },
        }

    RETURN_TYPES = ("STRING",)
    RETURN_NAMES = ("H3提示词",)
    FUNCTION = "generate"
    CATEGORY = "提示词工具"
    DESCRIPTION = "接 LLM，把口语描述扩写成 MiniMax H3 官方格式提示词。点节点上的「设置 API」配密钥；改「变体」可强制重新生成。「描述」留空则不发请求，直接输出空提示词。"

    def generate(self, 描述, 模式, 时长, 变体, 补充要求=""):
        text = (描述 or "").strip()
        if not text:
            # 「描述」是空的就当这个节点不存在：不发请求、不报错，输出空串。
            return ("",)
        if 模式 not in MODE_SPEC:
            raise RuntimeError("H3 提示词助手：不认识的模式「" + str(模式) + "」。")

        cfg = _require_config()
        system_prompt = _build_system_prompt(模式, float(时长))
        user_prompt = _build_user_message(text, 补充要求, float(时长))
        return (_call_llm(cfg, system_prompt, user_prompt),)


NODE_CLASS_MAPPINGS = {
    "H3PromptHelper": H3PromptHelper,
}

NODE_DISPLAY_NAME_MAPPINGS = {
    "H3PromptHelper": "H3 提示词助手",
}


# ==================== 给前端面板用的接口 ====================
# 只在 ComfyUI 服务真跑起来时才注册；模块被单独导入（自测）时静默跳过。

def _register_routes():
    try:
        from aiohttp import web
        from server import PromptServer
    except Exception:
        return False

    instance = getattr(PromptServer, "instance", None)
    if instance is None:
        return False

    routes = instance.routes

    def _json_error(message, status=500):
        return web.json_response({"ok": False, "error": str(message)}, status=status)

    @routes.get("/prompt_lib/llm/config")
    async def _route_get_config(request):
        try:
            return web.json_response({
                "ok": True,
                "config": read_config(),
                "editable": list(EDITABLE_KEYS),
                "path": CONFIG_PATH,
            })
        except Exception as exc:
            return _json_error(exc)

    @routes.post("/prompt_lib/llm/config")
    async def _route_set_config(request):
        try:
            data = await request.json()
        except Exception:
            return _json_error("请求体不是合法 JSON", 400)
        try:
            cfg = write_config(data or {})
            return web.json_response({"ok": True, "config": cfg})
        except Exception as exc:
            return _json_error(exc)

    @routes.post("/prompt_lib/llm/test")
    async def _route_test(request):
        try:
            data = await request.json()
        except Exception:
            data = {}
        cfg = read_config()
        # 面板允许"用还没保存的值先试一下"。注意用 `key in data` 判断：
        # 用户在面板里把 api_key 清空了也要如实覆盖成空，否则会拿旧 key 去测。
        if isinstance(data, dict):
            for key in ("base_url", "api_key", "model"):
                if key in data:
                    cfg[key] = str(data[key] or "").strip()
        missing = [k for k in ("base_url", "api_key", "model") if not str(cfg.get(k, "")).strip()]
        if missing:
            return web.json_response({"ok": False, "error": "还没填 " + " / ".join(missing)})
        try:
            # _post_json 是阻塞的，丢到线程池，别卡住 aiohttp 的事件循环
            loop = asyncio.get_running_loop()
            reply = await loop.run_in_executor(None, ping_llm, cfg)
            return web.json_response({"ok": True, "reply": reply[:120]})
        except Exception as exc:
            return web.json_response({"ok": False, "error": str(exc)})

    return True


ROUTES_REGISTERED = _register_routes()
