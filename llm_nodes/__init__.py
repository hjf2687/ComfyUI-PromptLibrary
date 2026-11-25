"""llm_nodes —— ComfyUI-PromptLibrary 里的 LLM 改写节点子模块。

把口语化的简短描述交给 LLM，改写成能直接用的提示词。

节点：
    H3 提示词助手      按 MiniMax H3 官方规范改写视频提示词
    生图提示词助手      按预设改写生图提示词，输出正向 + 负面两个口

两个节点共用同目录的 config.json —— 点节点上的「设置 API」按钮图形化编辑，
或直接改文件。预设见 image_presets/ 与 README。

前端扩展（那个「设置 API」按钮）由外层包的 WEB_DIRECTORY = "./web" 一起托管，
文件是 web/prompt_helper.js —— 所以这里不再声明 WEB_DIRECTORY。
"""

from .nodes import NODE_CLASS_MAPPINGS as _H3_CLASSES
from .nodes import NODE_DISPLAY_NAME_MAPPINGS as _H3_NAMES
from .image_nodes import NODE_CLASS_MAPPINGS as _IMAGE_CLASSES
from .image_nodes import NODE_DISPLAY_NAME_MAPPINGS as _IMAGE_NAMES

NODE_CLASS_MAPPINGS = {**_H3_CLASSES, **_IMAGE_CLASSES}
NODE_DISPLAY_NAME_MAPPINGS = {**_H3_NAMES, **_IMAGE_NAMES}

__all__ = ["NODE_CLASS_MAPPINGS", "NODE_DISPLAY_NAME_MAPPINGS"]
