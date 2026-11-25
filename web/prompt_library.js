import { app } from "../../scripts/app.js";
import { api } from "../../scripts/api.js";

let TAGS = null; // { 分类: [{t, z, z2, d, cat}] }
let ORDER = []; // 分类顺序
let PRESETS = {}; // 预设名 -> 文本

const PRESET_CAT = "预设";

// ---- 抽屉尺寸（图坐标 px；DOM 覆盖层内 1 图坐标 px = 1 CSS px，随画布整体缩放）----
const MARGIN = 2; // DOM widget 四周留白（要很小，否则收起时底边会留缝）
const HEAD_PX = 28; // 把手高度（也是收起时元素的高度）
const BODY_PX = 280; // 展开时把手以下的主体（搜索+分类+词条格）
const ROOT_OPEN_PX = HEAD_PX + BODY_PX; // 展开时元素高度
const ROOT_CLOSED_PX = HEAD_PX; // 收起时元素高度

// 权重档位：Shift 逐级加强，Alt 逐级减弱，走到底回到 1
const W_UP = [1, 1.1, 1.2, 1.3, 1.5];
const W_DOWN = [1, 0.9, 0.8, 0.7, 0.5];

async function ensureTags() {
  if (TAGS) return TAGS;
  await reloadLibrary();
  return TAGS;
}

async function reloadLibrary() {
  try {
    const res = await api.fetchApi("/prompt_lib/tags");
    const data = await res.json();
    TAGS = data.tags || {};
    ORDER = data.order || Object.keys(TAGS);
  } catch (e) {
    TAGS = TAGS || {};
    ORDER = ORDER.length ? ORDER : Object.keys(TAGS);
    console.warn("[PromptLibrary] 词库加载失败", e);
  }
}

async function loadPresets() {
  try {
    const res = await api.fetchApi("/prompt_lib/presets");
    const data = await res.json();
    PRESETS = data.presets || {};
  } catch (e) {
    PRESETS = {};
  }
}

async function postJSON(url, body) {
  const res = await api.fetchApi(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  return await res.json();
}

function widgetEl(w) {
  return w.element || w.inputEl || w.textarea || null;
}

function syncWidget(w, val) {
  w.value = val;
  const el = widgetEl(w);
  if (el) {
    el.value = val;
    el.dispatchEvent(new Event("input", { bubbles: true }));
  }
}

/* ---------- 文本 <-> 选中状态 ---------- */

// 支持权重写法："(tag:1.2)"、"（tag）"、裸 "tag"
function normToken(s) {
  s = String(s).trim();
  let m = s.match(/^\((.+):([0-9.]+)\)$/);
  if (m) return { name: m[1].trim(), w: parseFloat(m[2]) };
  m = s.match(/^\((.+)\)$/);
  if (m) return { name: m[1].trim(), w: 1.1 };
  return { name: s, w: 1 };
}

function fmtToken(name, w) {
  return w && Math.abs(w - 1) > 0.001 ? "(" + name + ":" + w + ")" : name;
}

function isCatLine(line) {
  const t = line.trim();
  return ORDER.some((c) => t.startsWith(c + ":"));
}

function parseCatLine(line) {
  const m = line.trim().match(/^\s*[^:]*:\s*([\s\S]*?)(?:；|;)?\s*$/);
  return m ? m[1].split("，").map((s) => s.trim()).filter(Boolean) : [];
}

// 把节点文本解析成两份选中集合：普通词条 token 集合（含权重）+ 分类行的值集合
function computeSelection(w) {
  const plain = new Set();
  const weights = new Map();
  const cats = new Map();
  for (const line of (w.value ?? "").toString().split("\n")) {
    if (isCatLine(line)) {
      const t = line.trim();
      const cname = t.slice(0, t.indexOf(":")).trim();
      if (!cats.has(cname)) cats.set(cname, new Set());
      parseCatLine(t).forEach((v) => cats.get(cname).add(v));
    } else {
      line.split(/[,，、]+/).forEach((s) => {
        const tk = normToken(s);
        if (!tk.name) return;
        plain.add(tk.name);
        if (tk.w !== 1) weights.set(tk.name, tk.w);
      });
    }
  }
  return { plain, weights, cats };
}

function isSelected(sel, tag) {
  return tag.cat ? sel.cats.get(tag.cat)?.has(tag.t) : sel.plain.has(tag.t);
}

function getLines(w) {
  return (w.value ?? "").toString().split("\n");
}

function setLines(w, lines) {
  syncWidget(w, lines.filter((l) => l.trim() !== "").join("\n"));
}

// 在第一个普通行上加工 token 数组；没有普通行就新建一行
function editPlainTokens(w, fn) {
  const lines = getLines(w);
  let done = false;
  for (let i = 0; i < lines.length && !done; i++) {
    if (isCatLine(lines[i])) continue;
    const toks = lines[i].split(/[,，、]+/).map((s) => s.trim()).filter(Boolean);
    const res = fn(toks);
    if (res) {
      lines[i] = res.join(", ");
      done = true;
    }
  }
  if (!done) {
    const res = fn([]);
    if (res && res.length) lines.push(res.join(", "));
  }
  setLines(w, lines);
}

function addToken(w, name, weight) {
  editPlainTokens(w, (toks) => {
    const i = toks.findIndex((s) => normToken(s).name === name);
    if (i >= 0) {
      if (weight && weight !== 1) toks[i] = fmtToken(name, weight);
      return toks;
    }
    toks.push(fmtToken(name, weight));
    return toks;
  });
}

function removeToken(w, name) {
  editPlainTokens(w, (toks) => {
    const i = toks.findIndex((s) => normToken(s).name === name);
    if (i >= 0) toks.splice(i, 1);
    return toks;
  });
}

// 普通词条：文本里已有该 token 则删掉（取消选择），没有则追加（选中）
function togglePlain(w, t) {
  const sel = computeSelection(w);
  if (sel.plain.has(t)) removeToken(w, t);
  else addToken(w, t, 1);
  app.graph.setDirtyCanvas(true, false);
}

function setWeight(w, t, nw) {
  editPlainTokens(w, (toks) => {
    const i = toks.findIndex((s) => normToken(s).name === t);
    if (i < 0) {
      toks.push(fmtToken(t, nw));
      return toks;
    }
    toks[i] = nw && nw !== 1 ? fmtToken(t, nw) : t;
    return toks;
  });
  app.graph.setDirtyCanvas(true, false);
}

function cycleWeight(w, t, dir) {
  const cur = computeSelection(w).weights.get(t) || 1;
  const ladder = dir > 0 ? W_UP : W_DOWN;
  let i = ladder.indexOf(cur);
  if (i < 0) i = 0;
  const nw = ladder[(i + 1) % ladder.length];
  let removed = false;
  if (nw === 1) {
    // 回到 1 时顺带取消选择，省一步
    const sel = computeSelection(w);
    if (sel.plain.has(t) && cur !== 1) setWeight(w, t, 1);
    else togglePlain(w, t);
    removed = true;
  }
  if (!removed) setWeight(w, t, nw);
}

// 中文参数词条：按 "分类: 值1，值2；" 整行维护，同分类合并，再点一次取消
function toggleCatLine(w, tag) {
  const prefix = tag.cat + ":";
  const lines = getLines(w);
  const idx = lines.findIndex((l) => l.trim().startsWith(prefix));
  if (idx === -1) {
    lines.push(prefix + " " + tag.t + "；");
  } else {
    const vals = parseCatLine(lines[idx]);
    const at = vals.indexOf(tag.t);
    if (at >= 0) vals.splice(at, 1);
    else vals.push(tag.t);
    if (vals.length === 0) lines.splice(idx, 1);
    else lines[idx] = prefix + " " + vals.join("，") + "；";
  }
  setLines(w, lines);
  app.graph.setDirtyCanvas(true, false);
}

function addCatValue(w, cname, v) {
  const prefix = cname + ":";
  const lines = getLines(w);
  const idx = lines.findIndex((l) => l.trim().startsWith(prefix));
  if (idx === -1) {
    lines.push(prefix + " " + v + "；");
  } else {
    const vals = parseCatLine(lines[idx]);
    if (!vals.includes(v)) vals.push(v);
    lines[idx] = prefix + " " + vals.join("，") + "；";
  }
  setLines(w, lines);
}

// 把一段预设文本并入当前文本框（分类行合并、普通词追加，不覆盖已有内容）
function applyPreset(w, text) {
  for (const raw of (text || "").split("\n")) {
    const t = raw.trim();
    if (!t) continue;
    if (isCatLine(t)) {
      const cname = t.slice(0, t.indexOf(":")).trim();
      parseCatLine(t).forEach((v) => addCatValue(w, cname, v));
    } else {
      t.split(/[,，、]+/).forEach((s) => {
        const tk = normToken(s);
        if (tk.name) addToken(w, tk.name, tk.w);
      });
    }
  }
  app.graph.setDirtyCanvas(true, false);
}

/* ---------- 抽屉展开 / 收起 ---------- */

const DELTA = ROOT_OPEN_PX - ROOT_CLOSED_PX; // 展开/收起的高度差

// 网格若溢出节点底边（文本框最小高度被压到时），向下补足节点高度
function fitGrid(node) {
  const el = node._pl && node._pl.el;
  if (!el || !el.isConnected) return;
  const nodeEl = el.closest(".lg-node");
  const grid = el.closest(".lg-node-widgets");
  if (!nodeEl || !grid) return;
  const scale = (window.app && window.app.canvas && window.app.canvas.ds && window.app.canvas.ds.scale) || 1;
  const overflow =
    (grid.getBoundingClientRect().bottom - nodeEl.getBoundingClientRect().top) / scale - node.size[1];
  if (overflow > 1) node.setSize([node.size[0], node.size[1] + overflow + 2]);
}

function applyOpen(node, open, resize) {
  node.properties = node.properties || {};
  node.properties.pl_open = open;
  const el = node._pl && node._pl.el;
  if (!el) return;
  el.dataset.open = open ? "1" : "0";
  // 元素高度自己管住；行高是 min-content，富余空间全被上方文本框吸收，
  // 所以把手位置只取决于文本框高度——按固定差值增减节点高度即可保持把手不动
  el.style.height = (open ? ROOT_OPEN_PX : ROOT_CLOSED_PX) + "px";
  if (!resize) return;
  node.setSize([node.size[0], Math.max(80, node.size[1] + (open ? DELTA : -DELTA))]);
  app.graph.setDirtyCanvas(false, true);
  if (!open) requestAnimationFrame(() => fitGrid(node));
}

/* ---------- 样式 ---------- */

function injectCSS() {
  if (document.getElementById("pl-style")) return;
  const s = document.createElement("style");
  s.id = "pl-style";
  s.textContent = `
.pl-root{font-family:system-ui,'Microsoft YaHei',sans-serif;color:#ddd;background:#1b1b1b;
  border:1px solid #2e2e2e;border-radius:6px;box-sizing:border-box;width:100%;
  display:flex;flex-direction:column;overflow:hidden;}
.pl-head{display:flex;align-items:center;gap:6px;cursor:pointer;user-select:none;flex:0 0 auto;
  height:28px;padding:0 8px;font-size:12px;color:#9a9a9a;background:#242424;border:0;text-align:left;
  width:100%;font-family:inherit;}
.pl-head:hover{background:#2d2d2d;color:#ddd;}
.pl-arrow{font-size:9px;line-height:1;transition:transform .12s ease;}
.pl-root[data-open="1"] .pl-arrow{transform:rotate(90deg);}
.pl-head-title{flex:1;}
.pl-selcount{font-size:10px;color:#7c8ffd;}
.pl-body{display:none;flex-direction:column;gap:4px;flex:1;min-height:0;padding:4px;}
.pl-root[data-open="1"] .pl-body{display:flex;}
.pl-bar{display:flex;gap:4px;flex:0 0 auto;}
.pl-search{flex:1;background:#111;border:1px solid #333;color:#eee;border-radius:6px;padding:4px 8px;
  font-size:12px;outline:none;min-width:0;}
.pl-search:focus{border-color:#4a6df0;}
.pl-clear{background:#3a2424;color:#e0a0a0;border:1px solid #5a3030;border-radius:6px;padding:2px 10px;
  cursor:pointer;font-size:12px;}
.pl-clear:hover{background:#4a2c2c;}
.pl-all{background:#24331f;color:#b8dcb8;border:1px solid #3d5a3d;border-radius:6px;padding:2px 10px;
  cursor:pointer;font-size:12px;white-space:nowrap;}
.pl-all:hover{background:#2d3f27;}
.pl-cats{display:flex;gap:4px;flex:0 0 auto;overflow-x:auto;scrollbar-width:thin;padding-bottom:2px;}
.pl-cat{background:#262626;border:1px solid #3a3a3a;color:#bbb;font-size:11px;padding:2px 8px;
  border-radius:10px;cursor:pointer;line-height:1.4;flex:0 0 auto;}
.pl-cat.active{background:#3b5bdb;border-color:#3b5bdb;color:#fff;}
.pl-cat.preset{background:#2f2a3d;border-color:#4a3f6b;color:#c3b6ff;}
.pl-cat.preset.active{background:#6741d9;border-color:#6741d9;color:#fff;}
.pl-grid{flex:1;min-height:0;overflow-y:auto;display:grid;grid-template-columns:repeat(3,1fr);gap:4px;
  align-content:start;padding-right:2px;grid-auto-rows:min-content;}
.pl-tag{position:relative;background:#2b2b2b;border:1px solid #3d3d3d;color:#ddd;border-radius:6px;padding:3px 5px;
  cursor:pointer;text-align:left;line-height:1.15;overflow:hidden;min-width:0;min-height:33px;}
.pl-tag:hover{background:#3a3a3a;border-color:#4a6df0;}
.pl-tag.selected{background:#2f4cd8;border-color:#5a7bff;color:#fff;}
.pl-tag.selected .en{color:#c8d3ff;}
.pl-tag .zh{display:block;font-size:12px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}
.pl-tag .en{display:block;font-size:10px;color:#8f8f8f;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}
.pl-w{position:absolute;top:1px;right:2px;font-size:9px;color:#ffd479;background:#00000066;
  border-radius:4px;padding:0 3px;line-height:1.4;pointer-events:none;}
.pl-del{position:absolute;top:1px;right:2px;font-size:10px;color:#e09090;background:#00000066;
  border-radius:4px;padding:0 4px;line-height:1.4;}
.pl-del:hover{color:#fff;background:#a33;}
.pl-plus{display:flex;align-items:center;justify-content:center;font-size:17px;color:#8f8f8f;
  border-style:dashed;min-height:33px;cursor:pointer;}
.pl-plus:hover{color:#ddd;border-color:#4a6df0;background:#3a3a3a;}
.pl-add{grid-column:1/-1;display:flex;flex-direction:column;gap:4px;padding:6px;background:#232323;
  border:1px solid #3d3d3d;border-radius:6px;}
.pl-add input{background:#111;border:1px solid #333;color:#eee;border-radius:5px;padding:4px 6px;
  font-size:12px;outline:none;width:100%;}
.pl-add input:focus{border-color:#4a6df0;}
.pl-add-row{display:flex;gap:4px;}
.pl-btn{flex:1;background:#2f4cd8;border:1px solid #5a7bff;color:#fff;border-radius:5px;padding:3px 0;
  cursor:pointer;font-size:12px;}
.pl-btn:hover{background:#3b5bdb;}
.pl-btn.ghost{background:#2b2b2b;border-color:#3d3d3d;color:#bbb;}
.pl-btn.ghost:hover{background:#3a3a3a;}
.pl-empty{color:#888;font-size:12px;padding:8px;grid-column:1/-1;}
`;
  document.head.appendChild(s);
}

/* ---------- 词库 UI ---------- */

function buildUI(root, node, textWidget) {
  let cat = ORDER[0] || PRESET_CAT; // 默认落在第一个真实分类，预设需点一下才进
  let q = "";

  root.innerHTML = `
    <button type="button" class="pl-head" title="点击展开 / 收起提示词库；Shift+点词条加强，Alt+点减弱，右键清零">
      <span class="pl-arrow">▶</span>
      <span class="pl-head-title">提示词库</span>
      <span class="pl-selcount"></span>
    </button>
    <div class="pl-body">
      <div class="pl-bar">
        <input class="pl-search" placeholder="搜索提示词（中文/英文均可）" />
        <button type="button" class="pl-all" title="把当前分类的全部词条一次性加入文本框">全选本类</button>
        <button type="button" class="pl-clear" title="清空节点里的全部文本">清空</button>
      </div>
      <div class="pl-cats"></div>
      <div class="pl-grid"></div>
    </div>`;
  const headEl = root.querySelector(".pl-head");
  const countEl = root.querySelector(".pl-selcount");
  const catsEl = root.querySelector(".pl-cats");
  const gridEl = root.querySelector(".pl-grid");
  const searchEl = root.querySelector(".pl-search");

  headEl.addEventListener("click", () => applyOpen(node, root.dataset.open !== "1", true));

  root.querySelector(".pl-clear").addEventListener("click", () => {
    syncWidget(textWidget, "");
    app.graph.setDirtyCanvas(true, false);
  });

  root.querySelector(".pl-all").addEventListener("click", () => {
    if (cat === PRESET_CAT) return;
    const sel = computeSelection(textWidget);
    const list = (TAGS[cat] || []).filter((t) => !t.cat && !isSelected(sel, t)).map((t) => t.t);
    if (!list.length) return;
    editPlainTokens(textWidget, (toks) => {
      list.forEach((t) => toks.push(t));
      return toks;
    });
    app.graph.setDirtyCanvas(true, false);
    refresh();
  });

  searchEl.addEventListener("input", () => {
    q = searchEl.value.trim().toLowerCase();
    renderGrid();
  });

  const tagRefs = []; // 与网格按钮一一对应，用于刷新高亮

  function refresh() {
    const sel = computeSelection(textWidget);
    for (const { btn, tag, badge } of tagRefs) {
      const on = isSelected(sel, tag);
      btn.classList.toggle("selected", on);
      const w = on && !tag.cat ? sel.weights.get(tag.t) || 1 : 1;
      if (badge) badge.textContent = w !== 1 ? String(w) : "";
    }
    let total = 0;
    for (const c of ORDER) for (const tag of TAGS[c] || []) if (isSelected(sel, tag)) total++;
    countEl.textContent = total ? "已选 " + total : "";
  }
  node._pl.refresh = refresh;

  function toggleTag(tag, ev) {
    if (tag.cat) {
      toggleCatLine(textWidget, tag);
      refresh();
      return;
    }
    if (ev && ev.shiftKey) cycleWeight(textWidget, tag.t, 1);
    else if (ev && ev.altKey) cycleWeight(textWidget, tag.t, -1);
    else togglePlain(textWidget, tag.t);
    refresh();
  }

  function clearWeight(tag) {
    if (tag.cat) return;
    if (!computeSelection(textWidget).plain.has(tag.t)) return;
    setWeight(textWidget, tag.t, 1);
    refresh();
  }

  function gridCats() {
    return [PRESET_CAT].concat(ORDER);
  }

  function renderCats() {
    catsEl.innerHTML = "";
    for (const c of gridCats()) {
      const b = document.createElement("button");
      b.className = "pl-cat" + (c === PRESET_CAT ? " preset" : "");
      b.textContent = c === PRESET_CAT ? PRESET_CAT + (Object.keys(PRESETS).length ? " (" + Object.keys(PRESETS).length + ")" : "") : c;
      b.addEventListener("click", () => {
        cat = c;
        q = "";
        searchEl.value = "";
        renderCats();
        renderGrid();
      });
      catsEl.appendChild(b);
    }
    [...catsEl.children].forEach((b, i) => b.classList.toggle("active", gridCats()[i] === cat));
  }

  function makeTagBtn(tag) {
    const btn = document.createElement("button");
    btn.className = "pl-tag";
    btn.title =
      tag.t +
      (tag.z && tag.z !== tag.t ? "（" + tag.z + "）" : "") +
      (tag.d ? " — " + tag.d : "") +
      (tag.cat ? " [" + tag.cat + "]" : "  ·  Shift 加强 / Alt 减弱 / 右键清零");
    const zhEl = document.createElement("span");
    zhEl.className = "zh";
    zhEl.textContent = tag.z || tag.t;
    const enEl = document.createElement("span");
    enEl.className = "en";
    enEl.textContent = tag.t !== tag.z ? tag.t : tag.d || tag.t;
    btn.append(zhEl, enEl);
    let badge = null;
    if (!tag.cat) {
      badge = document.createElement("span");
      badge.className = "pl-w";
      btn.appendChild(badge);
    }
    btn.addEventListener("click", (ev) => toggleTag(tag, ev));
    btn.addEventListener("contextmenu", (ev) => {
      ev.preventDefault();
      clearWeight(tag);
    });
    tagRefs.push({ btn, tag, badge });
    return btn;
  }

  function renderPresets(filter) {
    const names = Object.keys(PRESETS).filter(
      (n) => !filter || n.toLowerCase().includes(filter) || (PRESETS[n] || "").toLowerCase().includes(filter)
    );
    for (const n of names) {
      const btn = document.createElement("button");
      btn.className = "pl-tag";
      btn.title = "点击并入当前文本\n右键删除\n\n" + PRESETS[n];
      const zhEl = document.createElement("span");
      zhEl.className = "zh";
      zhEl.textContent = n;
      const enEl = document.createElement("span");
      enEl.className = "en";
      enEl.textContent = (PRESETS[n] || "").replace(/\n/g, " ").slice(0, 40) || "（空）";
      const del = document.createElement("span");
      del.className = "pl-del";
      del.textContent = "×";
      del.addEventListener("click", (ev) => {
        ev.stopPropagation();
        if (!confirm("删除预设「" + n + "」？")) return;
        postJSON("/prompt_lib/preset", { name: n, delete: true }).then((r) => {
          if (r.ok) {
            PRESETS = r.presets || {};
            renderCats();
            renderGrid();
          }
        });
      });
      btn.append(zhEl, enEl, del);
      btn.addEventListener("click", () => {
        applyPreset(textWidget, PRESETS[n]);
        refresh();
      });
      gridEl.appendChild(btn);
    }
    if (filter) return;
    const add = document.createElement("button");
    add.className = "pl-plus";
    add.textContent = "＋ 保存当前文本为预设";
    add.style.gridColumn = "1/-1";
    add.addEventListener("click", () => {
      const box = document.createElement("div");
      box.className = "pl-add";
      box.innerHTML =
        '<input class="pl-pname" placeholder="预设名，如：电影感人像" />' +
        '<div class="pl-add-row"><button type="button" class="pl-btn pl-ok">保存</button>' +
        '<button type="button" class="pl-btn ghost pl-cancel">取消</button></div>';
      add.replaceWith(box);
      const inp = box.querySelector(".pl-pname");
      inp.focus();
      const submit = async () => {
        const name = inp.value.trim();
        if (!name) return;
        const r = await postJSON("/prompt_lib/preset", {
          name,
          text: (textWidget.value ?? "").toString(),
        });
        if (r.ok) {
          PRESETS = r.presets || {};
          renderCats();
          renderGrid();
        }
      };
      box.querySelector(".pl-ok").addEventListener("click", submit);
      box.querySelector(".pl-cancel").addEventListener("click", renderGrid);
      inp.addEventListener("keydown", (e) => {
        if (e.key === "Enter") submit();
        if (e.key === "Escape") renderGrid();
      });
    });
    gridEl.appendChild(add);
  }

  function renderTagAdd() {
    const add = document.createElement("button");
    add.className = "pl-plus";
    add.textContent = "＋";
    add.title = "往「" + cat + "」里新增词条";
    add.addEventListener("click", () => {
      const box = document.createElement("div");
      box.className = "pl-add";
      box.innerHTML =
        '<input class="pl-z" placeholder="中文名，如：双色瞳" />' +
        '<input class="pl-t" placeholder="英文 tag，如：heterochromia" />' +
        '<div class="pl-add-row"><button type="button" class="pl-btn pl-ok">添加</button>' +
        '<button type="button" class="pl-btn ghost pl-cancel">取消</button></div>';
      add.replaceWith(box);
      const zi = box.querySelector(".pl-z");
      zi.focus();
      const submit = async () => {
        const z = zi.value.trim();
        const t = box.querySelector(".pl-t").value.trim();
        if (!t) return;
        const r = await postJSON("/prompt_lib/tag", { cat, t, z });
        if (r.ok) {
          await reloadLibrary();
          renderCats();
          renderGrid();
        } else if (r.error) {
          alert(r.error);
        }
      };
      box.querySelector(".pl-ok").addEventListener("click", submit);
      box.querySelector(".pl-cancel").addEventListener("click", renderGrid);
      box.querySelectorAll("input").forEach((i) =>
        i.addEventListener("keydown", (e) => {
          if (e.key === "Enter") submit();
          if (e.key === "Escape") renderGrid();
        })
      );
    });
    gridEl.appendChild(add);
  }

  function renderGrid() {
    gridEl.innerHTML = "";
    tagRefs.length = 0;
    const cats = q ? gridCats() : [cat];
    for (const c of cats) {
      if (c === PRESET_CAT) {
        renderPresets(q);
        continue;
      }
      for (const tag of TAGS[c] || []) {
        const zh = tag.z || "";
        if (
          q &&
          !tag.t.toLowerCase().includes(q) &&
          !zh.includes(q) &&
          !(tag.z2 || "").includes(q) &&
          !(tag.d || "").includes(q)
        )
          continue;
        gridEl.appendChild(makeTagBtn(tag));
      }
    }
    if (!q && cat !== PRESET_CAT) renderTagAdd();
    if (!gridEl.children.length)
      gridEl.innerHTML = '<div class="pl-empty">没有匹配的标签，试试别的关键词</div>';
    refresh();
  }

  // 文本框手动编辑 / 清空时同步高亮。新版前端里可见的 textarea 由 Vue 渲染，
  // widget 自带的 element 已脱离文档，所以要在 document 捕获阶段监听，
  // 并补一层 widget 回调（其他扩展改写文本时也能同步）
  document.addEventListener(
    "input",
    (e) => {
      if (!(e.target instanceof HTMLTextAreaElement)) return;
      const nodeEl = root.closest(".lg-node");
      if (nodeEl && nodeEl.contains(e.target)) refresh();
    },
    true
  );
  const origCallback = textWidget.callback;
  textWidget.callback = function () {
    const r = origCallback ? origCallback.apply(this, arguments) : undefined;
    if (node._pl.refresh) node._pl.refresh();
    return r;
  };
  const te = widgetEl(textWidget);
  if (te) te.addEventListener("input", refresh);

  renderCats();
  renderGrid();
}

app.registerExtension({
  name: "ComfyUI.PromptLibrary",
  beforeRegisterNodeDef(nodeType, nodeData) {
    if (nodeData.name !== "PromptLibraryNode") return;
    const onNodeCreated = nodeType.prototype.onNodeCreated;
    nodeType.prototype.onNodeCreated = function () {
      const r = onNodeCreated ? onNodeCreated.apply(this, arguments) : undefined;
      const node = this;
      const textWidget = (node.widgets || []).find((w) => w.name === "text");
      if (!textWidget) return r;

      injectCSS();
      const el = document.createElement("div");
      el.className = "pl-root";
      el.dataset.open = "1";
      el.style.height = ROOT_OPEN_PX + "px";
      // 前端给 DOM widget 元素套了 flex:1 1 0%（flex-basis 会压过 height），
      // 必须改回 flex:0 0 auto，inline 高度才能生效
      el.style.flex = "0 0 auto";
      el.style.minHeight = "0";
      node._pl = { el };
      node.properties = node.properties || {};
      node.properties.pl_open = true; // 新节点默认展开，收起状态会随工作流保存
      const libWidget = node.addDOMWidget("library", "library", el, { margin: MARGIN });
      // 让 Vue 节点把这一行按 min-content 排版（hasLayoutSize 靠 typeof 判定，
      // 用 undefined 遮蔽原型上的 computeLayoutSize）：行高压到内容本身，
      // 节点富余空间全部留给上方文本框，收起时把手下方不留空隙
      libWidget.computeLayoutSize = undefined;
      if (node.size) {
        node.size = [Math.max(node.size[0] || 0, 380), Math.max(node.size[1] || 0, 460)];
      }
      Promise.all([ensureTags(), loadPresets()]).then(() => {
        buildUI(el, node, textWidget);
        // 挂载后校正一次：若网格溢出节点底边则向下补足
        requestAnimationFrame(() => fitGrid(node));
      });
      return r;
    };
    const onConfigure = nodeType.prototype.onConfigure;
    nodeType.prototype.onConfigure = function () {
      const r = onConfigure ? onConfigure.apply(this, arguments) : undefined;
      if (!this._pl) return r;
      // 加载工作流：只恢复展开/收起状态，节点尺寸已随工作流保存，不再改动
      applyOpen(this, this.properties?.pl_open !== false, false);
      requestAnimationFrame(() => fitGrid(this));
      if (this._pl.refresh) this._pl.refresh();
      return r;
    };
  },
});
