/**
 * 提示词助手 —— 节点上的「设置 API」按钮
 *
 * 点开填 接口地址 / 模型 ID / API Key，存到 llm_nodes/config.json（不进工作流 json）。
 * 「H3 提示词助手」和「生图提示词助手」共用同一份配置，所以这里是个节点名列表。
 * 后端接口在 llm_nodes/nodes.py 里注册：GET/POST /prompt_lib/llm/config、POST /prompt_lib/llm/test
 */

import { app } from "../../scripts/app.js";

const API = "/prompt_lib/llm";
const NODE_NAMES = ["H3PromptHelper", "ImagePromptHelper"];

// ==================== 样式（只注入一次） ====================

const STYLE_ID = "h3ph-style";

function ensureStyle() {
  if (document.getElementById(STYLE_ID)) return;
  const el = document.createElement("style");
  el.id = STYLE_ID;
  el.textContent = `
.h3ph-mask{position:fixed;inset:0;z-index:10000;display:flex;align-items:center;justify-content:center;
  background:rgba(0,0,0,.45);font-size:13px;line-height:1.5}
.h3ph-panel{width:430px;max-width:94vw;box-sizing:border-box;padding:16px 18px 14px;border-radius:10px;
  background:var(--comfy-menu-bg,#2b2b2b);color:var(--fg-color,#ddd);
  border:1px solid var(--border-color,#4e4e4e);box-shadow:0 16px 48px rgba(0,0,0,.5)}
.h3ph-head{display:flex;align-items:center;justify-content:space-between;margin-bottom:2px}
.h3ph-title{font-size:14px;font-weight:600}
.h3ph-sub{color:var(--descrip-text,#999);font-size:12px;margin-bottom:14px}
.h3ph-field{display:flex;flex-direction:column;gap:5px;margin-bottom:11px}
.h3ph-field > span:first-child{color:var(--descrip-text,#aaa);font-size:12px}
.h3ph-input{width:100%;box-sizing:border-box;padding:7px 10px;border-radius:6px;font-size:13px;
  background:var(--comfy-input-bg,#1e1e1e);color:var(--input-text,#ddd);
  border:1px solid var(--border-color,#4e4e4e);outline:none;font-family:inherit}
.h3ph-input:focus{border-color:var(--p-primary-color,#4f8cff)}
.h3ph-keyrow{display:flex;gap:6px}
.h3ph-keyrow .h3ph-input{flex:1;min-width:0}
.h3ph-btn{padding:6px 13px;border-radius:6px;font-size:12px;cursor:pointer;white-space:nowrap;
  background:var(--comfy-input-bg,#3a3a3a);color:var(--fg-color,#ddd);
  border:1px solid var(--border-color,#4e4e4e);font-family:inherit}
.h3ph-btn:hover{filter:brightness(1.25)}
.h3ph-btn:disabled{opacity:.55;cursor:default;filter:none}
.h3ph-primary{background:var(--p-primary-color,#4f8cff);border-color:transparent;color:#fff}
.h3ph-x{padding:2px 8px;background:transparent;border:none;color:var(--descrip-text,#999);
  font-size:15px;line-height:1;cursor:pointer}
.h3ph-x:hover{color:var(--fg-color,#ddd)}
.h3ph-actions{display:flex;align-items:center;gap:8px;margin-top:14px}
.h3ph-gap{flex:1}
.h3ph-msg{min-height:17px;font-size:12px;margin-top:2px;word-break:break-word}
.h3ph-msg.ok{color:#6cc46c}
.h3ph-msg.err{color:#e06c6c}
.h3ph-msg.busy{color:var(--descrip-text,#999)}
`;
  document.head.appendChild(el);
}

// ==================== 后端接口 ====================

async function apiGet() {
  const r = await fetch(API + "/config");
  if (!r.ok) throw new Error("HTTP " + r.status);
  return await r.json();
}

async function apiPost(path, body) {
  const r = await fetch(API + path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body || {}),
  });
  if (!r.ok && r.status >= 500) throw new Error("HTTP " + r.status);
  return await r.json();
}

// ==================== 节点上的按钮 ====================

function setLabel(node, widget, text) {
  // 不同前端版本读 label 或 name，两个都设一下；name 保持原样以免影响序列化对位
  widget.label = text;
  try {
    node.setDirtyCanvas(true, true);
  } catch (e) {
    /* 忽略 */
  }
}

function isConfigured(cfg) {
  return !!(cfg && cfg.base_url && cfg.api_key && cfg.model);
}

async function refreshLabel(node) {
  const btn = node.__h3phBtn;
  if (!btn) return;
  let cfg = null;
  try {
    const d = await apiGet();
    if (d && d.ok) cfg = d.config || {};
  } catch (e) {
    setLabel(node, btn, "设置 API（读不到配置）");
    return;
  }
  setLabel(node, btn, isConfigured(cfg) ? "设置 API · " + cfg.model : "⚠ 设置 API（未配置）");
}

function setupNode(node) {
  if (node.__h3phReady) return;
  node.__h3phReady = true;
  const btn = node.addWidget("button", "设置 API", null, () => openPanel(node));
  node.__h3phBtn = btn;
  refreshLabel(node);
}

// ==================== 设置面板 ====================

function openPanel(node) {
  if (document.querySelector(".h3ph-mask")) return;
  ensureStyle();
  apiGet()
    .then((d) => buildPanel(node, (d && d.ok && d.config) || {}))
    .catch(() => buildPanel(node, {}));
}

function buildPanel(node, cfg) {
  const mask = document.createElement("div");
  mask.className = "h3ph-mask";
  mask.innerHTML = `
  <div class="h3ph-panel" role="dialog" aria-modal="true">
    <div class="h3ph-head">
      <div class="h3ph-title">设置语言模型 API</div>
      <button class="h3ph-x" data-act="cancel" title="关闭">✕</button>
    </div>
    <div class="h3ph-sub">存到插件目录的 config.json，不会写进工作流</div>

    <label class="h3ph-field">
      <span>接口地址</span>
      <input class="h3ph-input" data-f="base_url" type="text" spellcheck="false"
             placeholder="https://api.example.com/v1" autocomplete="off">
    </label>
    <label class="h3ph-field">
      <span>模型 ID</span>
      <input class="h3ph-input" data-f="model" type="text" spellcheck="false"
             placeholder="gpt-4o-mini" autocomplete="off">
    </label>
    <label class="h3ph-field">
      <span>API Key</span>
      <span class="h3ph-keyrow">
        <input class="h3ph-input" data-f="api_key" type="password"
               placeholder="sk-..." autocomplete="off">
        <button class="h3ph-btn" data-act="eye">显示</button>
      </span>
    </label>

    <div class="h3ph-msg"></div>

    <div class="h3ph-actions">
      <button class="h3ph-btn" data-act="test">测试连接</button>
      <span class="h3ph-gap"></span>
      <button class="h3ph-btn" data-act="cancel">取消</button>
      <button class="h3ph-btn h3ph-primary" data-act="save">保存</button>
    </div>
  </div>`;

  const q = (sel) => mask.querySelector(sel);
  const field = (name) => mask.querySelector(`[data-f="${name}"]`);
  const msg = q(".h3ph-msg");

  field("base_url").value = cfg.base_url || "";
  field("model").value = cfg.model || "";
  field("api_key").value = cfg.api_key || "";

  const say = (text, kind) => {
    msg.textContent = text || "";
    msg.className = "h3ph-msg" + (kind ? " " + kind : "");
  };
  const readForm = () => ({
    base_url: field("base_url").value.trim(),
    model: field("model").value.trim(),
    api_key: field("api_key").value.trim(),
  });
  const busy = (on) => {
    mask.querySelectorAll("button").forEach((b) => {
      if (b.dataset.act !== "cancel" && b.dataset.act !== "eye") b.disabled = on;
    });
  };

  let closed = false;
  const close = () => {
    if (closed) return;
    closed = true;
    document.removeEventListener("keydown", onKey, true);
    mask.remove();
  };
  const onKey = (e) => {
    if (e.key === "Escape") {
      e.stopPropagation();
      close();
    }
  };
  document.addEventListener("keydown", onKey, true);

  mask.addEventListener("click", async (e) => {
    if (e.target === mask) return close(); // 点遮罩关闭
    const btn = e.target.closest("[data-act]");
    if (!btn) return;
    const act = btn.dataset.act;

    if (act === "cancel") return close();

    if (act === "eye") {
      const key = field("api_key");
      const hidden = key.type === "password";
      key.type = hidden ? "text" : "password";
      btn.textContent = hidden ? "隐藏" : "显示";
      return;
    }

    if (act === "test") {
      const form = readForm();
      busy(true);
      say("正在测试…", "busy");
      try {
        const d = await apiPost("/test", form);
        if (d.ok) say("连接正常，模型回了：" + (d.reply || "(空)"), "ok");
        else say("失败：" + (d.error || "未知错误"), "err");
      } catch (err) {
        say("失败：" + err.message, "err");
      }
      busy(false);
      return;
    }

    if (act === "save") {
      busy(true);
      say("正在保存…", "busy");
      try {
        const d = await apiPost("/config", readForm());
        if (!d.ok) {
          say("保存失败：" + (d.error || "未知错误"), "err");
          busy(false);
          return;
        }
        close();
        refreshLabel(node);
        app.extensionManager?.toast?.add?.({
          severity: "success",
          summary: "提示词助手",
          detail: "API 配置已保存",
          life: 2500,
        });
      } catch (err) {
        say("保存失败：" + err.message, "err");
        busy(false);
      }
      return;
    }
  });

  document.body.appendChild(mask);
  field("base_url").focus();
}

// ==================== 注册 ====================

app.registerExtension({
  name: "ComfyUI.PromptLibrary.llmSettings",
  beforeRegisterNodeDef(nodeType, nodeData) {
    if (!NODE_NAMES.includes(nodeData?.name)) return;
    const orig = nodeType.prototype.onNodeCreated;
    nodeType.prototype.onNodeCreated = function () {
      const r = orig ? orig.apply(this, arguments) : undefined;
      try {
        setupNode(this);
      } catch (e) {
        console.error("[提示词助手] 挂载设置按钮失败：", e);
      }
      return r;
    };
  },
});
