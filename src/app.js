import { addReply, addUpdate, createBackup, createRecord, formatBackupFilename, formatElapsed, mergeRecords, STATUSES, verifyBackup } from "./domain.js";
import { deleteRecord, getMeta, getRecords, importRecords, openDatabase, saveRecord, setBackupComplete } from "./db.js";
import { organizeMetrics } from "./metrics.js";

const app = document.querySelector("#app");
const recordDialog = document.querySelector("#record-dialog");
const recordForm = document.querySelector("#record-form");
const replyDialog = document.querySelector("#reply-dialog");
const replyForm = document.querySelector("#reply-form");
const replyEditDialog = document.querySelector("#reply-edit-dialog");
const replyEditForm = document.querySelector("#reply-edit-form");
const updateEditDialog = document.querySelector("#update-edit-dialog");
const updateEditForm = document.querySelector("#update-edit-form");
const organizedUpdateDialog = document.querySelector("#organized-update-dialog");
const organizedUpdateForm = document.querySelector("#organized-update-form");
const organizeSummary = document.querySelector("#organize-summary");
const organizeOriginal = document.querySelector("#organize-original");
const importDialog = document.querySelector("#import-dialog");
const themeDialog = document.querySelector("#theme-dialog");
const deleteDialog = document.querySelector("#delete-dialog");
const backupInput = document.querySelector("#backup-input");
const toast = document.querySelector("#toast");
let db;
let records = [];
let meta = {};
let view = { screen: "feed", recordId: null, query: "", status: "all", menu: false, search: false };
let pendingImport = null;
let pendingDelete = null;
let updateStartedAt = null;
const SWIPE_ACTION_WIDTH = 146;
let swipeGesture = null;
let suppressCardClickUntil = 0;
const THEME_KEY = "xuji-theme";
let theme = localStorage.getItem(THEME_KEY) || "warm";

const escapeHtml = (value) => String(value ?? "").replace(/[&<>'"]/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;" })[char]);
const multiline = (value) => escapeHtml(value).replace(/\n/g, "<br>");
const formatDate = (value, full = false) => new Intl.DateTimeFormat("zh-CN", full ? { year: "numeric", month: "long", day: "numeric", hour: "2-digit", minute: "2-digit" } : { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" }).format(new Date(value));
const formatClock = (value) => new Intl.DateTimeFormat("zh-CN", { hour: "2-digit", minute: "2-digit", hour12: false }).format(value);
const localDateTime = (value = new Date()) => new Date(value.getTime() - value.getTimezoneOffset() * 60000).toISOString().slice(0, 16);

function applyTheme() {
  document.documentElement.dataset.theme = theme;
  document.querySelector('meta[name="theme-color"]').content = theme === "warm" ? "#11110f" : "#f6f5f1";
}

applyTheme();

function notify(message) {
  toast.textContent = message;
  toast.hidden = false;
  clearTimeout(notify.timer);
  notify.timer = setTimeout(() => { toast.hidden = true; }, 2600);
}

function activeRecord() {
  return records.find((record) => record.id === view.recordId);
}

function filteredRecords() {
  const query = view.query.trim().toLowerCase();
  return records.filter((record) => (view.status === "all" || (view.status === "ended" ? record.status !== "watching" : record.status === view.status)) && (!query || [record.body, record.reason, record.tags.join(" "), ...record.updates.flatMap((update) => [update.body, ...update.replies.map((reply) => reply.body)])].join(" ").toLowerCase().includes(query))).sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt));
}

function needsBackup() {
  if (!records.length) return false;
  if (!meta.lastBackupAt) return true;
  return Number(meta.changesSinceBackup || 0) >= 20 || Date.now() - Date.parse(meta.lastBackupAt) >= 7 * 86400000;
}

function renderFeed() {
  const list = filteredRecords();
  app.innerHTML = `<div class="app-shell">
    <header class="topbar feed-head"><div class="topbar-main"><div><h1>续记</h1><p>直通车调整日志</p></div><div class="header-actions"><button class="icon-button" data-action="toggle-search" aria-label="搜索">⌕</button><button class="icon-button dots" data-action="toggle-menu" aria-label="更多" aria-expanded="${view.menu}">•••</button></div></div>
      ${view.search ? `<div class="search-wrap"><input id="search-input" type="search" value="${escapeHtml(view.query)}" placeholder="搜索调整、续记、补充或标签" aria-label="搜索记录"></div>` : ""}
      <div class="filters"><button class="filter ${view.status === "all" ? "active" : ""}" data-filter="all">全部</button><button class="filter ${view.status === "watching" ? "active" : ""}" data-filter="watching">观察中</button><button class="filter ${view.status === "ended" ? "active" : ""}" data-filter="ended">已结束</button></div>
    </header>
    ${view.menu ? `<div class="more-menu"><button data-action="export-backup">导出完整备份</button><button data-action="choose-backup">从备份恢复</button><button data-action="show-theme">外观主题</button><button data-action="show-help">使用说明</button></div>` : ""}
    <main class="feed">
      ${needsBackup() ? `<button class="backup-notice" data-action="export-backup">${meta.lastBackupAt ? "距上次备份较久，建议现在备份" : "这些记录还没有备份，建议立即备份"}<span>去备份 ›</span></button>` : ""}
      <section class="record-list" aria-label="调整记录">${list.length ? list.map(recordCard).join("") : emptyState()}</section>
    </main>
    <button class="fab" data-action="new-record" aria-label="新建调整">＋</button>
  </div>`;
  if (view.search) requestAnimationFrame(() => document.querySelector("#search-input")?.focus());
}

function recordCard(record) {
  const latest = record.updates.at(-1);
  return `<div class="swipe-row"><div class="swipe-actions"><button class="swipe-focus" data-action="toggle-focus" data-id="${escapeHtml(record.id)}" aria-label="${record.focused ? "取消关注" : "关注"}这条调整记录"><span class="solid-star" aria-hidden="true">★</span><span>${record.focused ? "取消" : "关注"}</span></button><button class="swipe-delete" data-action="delete-record-from-feed" data-id="${escapeHtml(record.id)}" aria-label="删除这条调整记录"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3 6h18M8 6V4h8v2M7 6l1 14h8l1-14M10 10v6M14 10v6"/></svg><span>删除</span></button></div><article class="record-card ${record.focused ? "focused" : ""}" data-action="open-record" data-id="${escapeHtml(record.id)}">
    <div class="record-meta"><span class="status status-${record.status}">${STATUSES[record.status]}</span><time>${formatDate(record.createdAt)}</time></div>
    <h2>${multiline(record.body)}</h2>
    ${record.reason ? `<p class="reason">${multiline(record.reason)}</p>` : ""}
    ${record.tags.length ? `<div class="tags">${record.tags.map((tag) => `<span>#${escapeHtml(tag)}</span>`).join("")}</div>` : ""}
    <div class="record-foot"><span>${latest ? `最新：${escapeHtml(latest.body)}` : "还没有后续观察"}</span><b>续记 ${record.updates.length}</b></div>
  </article></div>`;
}

function closeSwipeRows(except) {
  document.querySelectorAll(".swipe-row.open").forEach((row) => { if (row !== except) row.classList.remove("open"); });
}

function emptyState() {
  return `<div class="empty"><div class="empty-mark">记</div><h2>${view.query || view.status !== "all" ? "没有找到记录" : "记录第一次调整"}</h2><p>${view.query || view.status !== "all" ? "试试其他关键词或筛选条件。" : "写下改了什么，之后再回来续记它的反应。"}</p>${!records.length ? `<button class="primary-button" data-action="new-record">新建调整</button>` : ""}</div>`;
}

function renderDetail() {
  const record = activeRecord();
  if (!record) return goFeed();
  app.innerHTML = `<div class="app-shell detail-shell">
    <header class="topbar detail-head"><button class="icon-button back" data-action="back" aria-label="返回">‹</button><h1>调整详情</h1><span aria-hidden="true"></span></header>
    <main class="detail">
      <article class="origin-card"><div class="record-meta"><button class="status status-${record.status}" data-action="cycle-status">${STATUSES[record.status]}</button><time>${formatDate(record.createdAt, true)}</time></div><h2>${multiline(record.body)}</h2>${record.reason ? `<p class="reason">${multiline(record.reason)}</p>` : ""}${record.tags.length ? `<div class="tags">${record.tags.map((tag) => `<span>#${escapeHtml(tag)}</span>`).join("")}</div>` : ""}<button class="record-edit" data-action="edit-record">编辑</button></article>
      <section class="timeline" aria-label="后续观察">
        ${record.updates.length ? record.updates.map((update) => updateItem(record, update)).join("") : `<div class="timeline-empty">还没有后续观察。调整产生变化后，在下方继续记录。</div>`}
      </section>
    </main>
    <form id="update-form" class="composer"><div class="composer-entry"><time id="composer-cutoff">记录于 ${formatClock(updateStartedAt || new Date())}</time><textarea name="body" rows="1" maxlength="10000" required placeholder="语音输入数据、想法或后续反应…" aria-label="续写内容"></textarea></div><button type="submit">续写</button></form>
  </div>`;
}

function updateItem(record, update) {
  return `<article class="timeline-item"><div class="elapsed">调整后 ${formatElapsed(record.createdAt, update.createdAt)}</div><section class="update-card"><div class="timeline-dot"></div><div class="update-body">${multiline(update.body)}</div><footer class="item-footer"><time>${formatDate(update.createdAt, true)}</time><div class="item-actions"><button data-action="organize-update" data-update-id="${escapeHtml(update.id)}">整理</button><button data-action="reply" data-update-id="${escapeHtml(update.id)}">补充</button><button data-action="edit-update" data-update-id="${escapeHtml(update.id)}">编辑</button><button data-action="delete-update" data-update-id="${escapeHtml(update.id)}">删除</button></div></footer></section>
    ${update.replies.map((reply) => `<section class="reply-card"><div class="timeline-dot"></div><p><b>补充</b> · ${multiline(reply.body)}</p><footer class="item-footer"><time>${formatDate(reply.createdAt)}</time><div class="item-actions"><button data-action="edit-reply" data-update-id="${escapeHtml(update.id)}" data-reply-id="${escapeHtml(reply.id)}">编辑</button><button data-action="delete-reply" data-update-id="${escapeHtml(update.id)}" data-reply-id="${escapeHtml(reply.id)}">删除</button></div></footer></section>`).join("")}
  </article>`;
}

function render() {
  view.screen === "detail" ? renderDetail() : renderFeed();
}

function goFeed() {
  if (view.screen === "detail" && history.state?.recordId) return history.back();
  view = { ...view, screen: "feed", recordId: null, menu: false };
  updateStartedAt = null;
  history.replaceState({ screen: "feed" }, "", location.pathname);
  render();
}

function openRecordDialog(record) {
  recordForm.reset();
  document.querySelector("#record-dialog-title").textContent = record ? "编辑调整" : "新建调整";
  recordForm.elements.id.value = record?.id || "";
  recordForm.elements.body.value = record?.body || "";
  recordForm.elements.reason.value = record?.reason || "";
  recordForm.elements.status.value = record?.status || "watching";
  recordForm.elements.createdAt.value = localDateTime(record ? new Date(record.createdAt) : new Date());
  recordForm.elements.tags.value = record?.tags.join(" ") || "";
  recordDialog.showModal();
  setTimeout(() => recordForm.elements.body.focus(), 50);
}

async function refresh() {
  [records, meta] = await Promise.all([getRecords(db), getMeta(db)]);
  render();
}

async function updateCurrent(mutator, message) {
  const record = activeRecord();
  const changed = mutator(record);
  await saveRecord(db, changed);
  await refresh();
  notify(message);
}

async function exportBackup() {
  view.menu = false;
  render();
  const payload = await createBackup(records);
  const file = new File([JSON.stringify(payload, null, 2)], formatBackupFilename(payload.exportedAt), { type: "application/json" });
  try {
    let shared = false;
    if (navigator.canShare?.({ files: [file] })) {
      try { await navigator.share({ files: [file] }); shared = true; }
      catch (error) { if (error.name === "AbortError") throw error; }
    }
    if (!shared) {
      const link = document.createElement("a");
      link.href = URL.createObjectURL(file);
      link.download = file.name;
      link.click();
      setTimeout(() => URL.revokeObjectURL(link.href), 1000);
    }
    await setBackupComplete(db, payload.exportedAt);
    await refresh();
    notify("完整备份已生成");
  } catch (error) {
    if (error.name !== "AbortError") notify(`备份失败：${error.message || "请重试"}`);
  }
}

async function readBackup(file) {
  if (!file || file.size > 10 * 1024 * 1024) throw new Error("备份文件无效或超过 10 MB");
  const payload = JSON.parse(await file.text());
  if (!await verifyBackup(payload)) throw new Error("备份文件校验失败，内容可能无效或已经损坏");
  return payload.version === 1 ? { ...payload, version: 2, records: payload.records.map((record) => ({ ...record, focused: false })) } : payload;
}

function askDelete(type, ids, title, copy) {
  pendingDelete = { type, ...ids };
  document.querySelector("#delete-title").textContent = title;
  document.querySelector("#delete-copy").textContent = copy;
  deleteDialog.showModal();
}

async function confirmDelete() {
  if (!pendingDelete) return;
  const target = pendingDelete;
  if (target.type === "record") {
    await deleteRecord(db, target.recordId);
    await refresh();
    notify("记录已删除");
  } else if (target.type === "replace-import") {
    pendingDelete = null;
    deleteDialog.close();
    await restoreImport(true);
    return;
  } else if (target.type === "update") {
    await updateCurrent((record) => ({ ...record, updatedAt: new Date().toISOString(), updates: record.updates.filter((item) => item.id !== target.updateId) }), "续记已删除");
  } else {
    await updateCurrent((record) => ({ ...record, updatedAt: new Date().toISOString(), updates: record.updates.map((item) => item.id === target.updateId ? { ...item, updatedAt: new Date().toISOString(), replies: item.replies.filter((reply) => reply.id !== target.replyId) } : item) }), "补充已删除");
  }
  pendingDelete = null;
  deleteDialog.close();
}

app.addEventListener("pointerdown", (event) => {
  const row = event.target.closest(".record-card")?.closest(".swipe-row");
  if (!row || !event.isPrimary || event.button !== 0) return;
  swipeGesture = { row, pointerId: event.pointerId, startX: event.clientX, startY: event.clientY, startOffset: row.classList.contains("open") ? SWIPE_ACTION_WIDTH : 0, offset: 0, horizontal: null, lastX: event.clientX, lastTime: performance.now(), velocity: 0 };
});

app.addEventListener("pointermove", (event) => {
  if (!swipeGesture || event.pointerId !== swipeGesture.pointerId) return;
  const dx = swipeGesture.startX - event.clientX;
  const dy = event.clientY - swipeGesture.startY;
  if (swipeGesture.horizontal === null && Math.hypot(dx, dy) >= 8) {
    swipeGesture.horizontal = Math.abs(dx) > Math.abs(dy);
    if (swipeGesture.horizontal) { closeSwipeRows(swipeGesture.row); swipeGesture.row.setPointerCapture(event.pointerId); }
  }
  if (!swipeGesture.horizontal) return;
  event.preventDefault();
  const now = performance.now();
  swipeGesture.velocity = (swipeGesture.lastX - event.clientX) / Math.max(1, now - swipeGesture.lastTime);
  swipeGesture.lastX = event.clientX;
  swipeGesture.lastTime = now;
  swipeGesture.offset = Math.max(0, Math.min(SWIPE_ACTION_WIDTH, swipeGesture.startOffset + dx));
  swipeGesture.row.classList.add("dragging");
  swipeGesture.row.style.setProperty("--swipe-x", String(-swipeGesture.offset) + "px");
}, { passive: false });

app.addEventListener("pointerup", (event) => {
  if (!swipeGesture || event.pointerId !== swipeGesture.pointerId) return;
  if (swipeGesture.horizontal) {
    swipeGesture.row.classList.remove("dragging");
    swipeGesture.row.style.removeProperty("--swipe-x");
    swipeGesture.row.classList.toggle("open", swipeGesture.velocity > .35 || (swipeGesture.velocity >= -.35 && swipeGesture.offset >= SWIPE_ACTION_WIDTH * .4));
    suppressCardClickUntil = Date.now() + 350;
  }
  swipeGesture = null;
});

app.addEventListener("pointercancel", () => {
  if (!swipeGesture) return;
  swipeGesture.row.classList.remove("dragging");
  swipeGesture.row.style.removeProperty("--swipe-x");
  swipeGesture = null;
});

app.addEventListener("scroll", (event) => { if (event.target.matches(".record-list")) closeSwipeRows(); }, true);

app.addEventListener("click", async (event) => {
  if (Date.now() < suppressCardClickUntil && event.target.closest(".record-card")) return;
  const openRow = document.querySelector(".swipe-row.open");
  if (openRow && !event.target.closest(".swipe-delete")) {
    const clickedCard = event.target.closest(".record-card");
    closeSwipeRows();
    if (clickedCard) return;
  }
  if (view.menu && !event.target.closest(".more-menu, [data-action='toggle-menu']")) {
    view.menu = false;
    document.querySelector(".more-menu")?.remove();
    document.querySelector("[data-action='toggle-menu']")?.setAttribute("aria-expanded", "false");
  }
  const target = event.target.closest("[data-action], [data-filter]");
  if (!target) return;
  const action = target.dataset.action;
  if (target.dataset.filter) { view.status = target.dataset.filter; return render(); }
  if (action === "toggle-search") { view.search = !view.search; view.menu = false; return render(); }
  if (action === "toggle-menu") { view.menu = !view.menu; view.search = false; return render(); }
  if (action === "new-record") return openRecordDialog();
  if (action === "open-record") { updateStartedAt = null; view = { ...view, screen: "detail", recordId: target.dataset.id, menu: false }; history.pushState({ screen: "detail", recordId: target.dataset.id }, "", `#${target.dataset.id}`); return render(); }
  if (action === "back") return goFeed();
  if (action === "edit-record") return openRecordDialog(activeRecord());
  if (action === "export-backup") return exportBackup();
  if (action === "choose-backup") { view.menu = false; render(); backupInput.click(); return; }
  if (action === "show-theme") {
    view.menu = false;
    render();
    themeDialog.querySelectorAll("[data-theme-choice]").forEach((button) => button.setAttribute("aria-pressed", String(button.dataset.themeChoice === theme)));
    themeDialog.showModal();
    return;
  }
  if (action === "show-help") { view.menu = false; render(); return notify("先记录调整，再进入详情持续续记；请定期导出备份。"); }
  if (action === "toggle-focus") {
    const record = records.find((item) => item.id === target.dataset.id);
    if (!record) return;
    await saveRecord(db, { ...record, focused: !record.focused, updatedAt: new Date().toISOString() });
    closeSwipeRows();
    await refresh();
    return notify(record.focused ? "已取消关注" : "已设为重点关注");
  }
  if (action === "reply") { replyForm.reset(); replyForm.elements.updateId.value = target.dataset.updateId; return replyDialog.showModal(); }
  if (action === "organize-update") {
    const update = activeRecord().updates.find((item) => item.id === target.dataset.updateId);
    if (!update) return;
    const result = organizeMetrics(update.body, new Date(update.createdAt));
    const recognized = Math.max(0, result.recognized - 1);
    if (!recognized) return notify("没有识别到数据字段，已保留原内容");
    const missing = result.missing.filter((label) => label !== "统计截止");
    organizedUpdateForm.reset();
    organizedUpdateForm.elements.updateId.value = update.id;
    organizedUpdateForm.elements.body.value = result.text;
    organizeOriginal.textContent = result.original;
    organizeSummary.textContent = missing.length ? "已识别 " + recognized + "/11 项数据；未识别字段已自动填 0：" + missing.join("、") : "已识别全部数据字段，请核对后保存。";
    organizeSummary.classList.toggle("warning", !!missing.length);
    return organizedUpdateDialog.showModal();
  }
  if (action === "cycle-status") {
    const order = Object.keys(STATUSES);
    return updateCurrent((record) => ({ ...record, status: order[(order.indexOf(record.status) + 1) % order.length], updatedAt: new Date().toISOString() }), "状态已更新");
  }
  if (action === "edit-update") {
    const record = activeRecord();
    const update = record.updates.find((item) => item.id === target.dataset.updateId);
    updateEditForm.reset();
    updateEditForm.elements.updateId.value = update.id;
    updateEditForm.elements.body.value = update.body;
    updateEditDialog.showModal();
    return setTimeout(() => updateEditForm.elements.body.focus(), 50);
  }
  if (action === "edit-reply") {
    const update = activeRecord().updates.find((item) => item.id === target.dataset.updateId);
    const reply = update?.replies.find((item) => item.id === target.dataset.replyId);
    if (!reply) return;
    replyEditForm.reset();
    replyEditForm.elements.updateId.value = update.id;
    replyEditForm.elements.replyId.value = reply.id;
    replyEditForm.elements.body.value = reply.body;
    replyEditDialog.showModal();
    return setTimeout(() => replyEditForm.elements.body.focus(), 50);
  }
  if (action === "delete-update") return askDelete("update", { updateId: target.dataset.updateId }, "删除这条续记？", "这条续记及其全部补充将一起删除。");
  if (action === "delete-reply") return askDelete("reply", { updateId: target.dataset.updateId, replyId: target.dataset.replyId }, "删除这条补充？", "删除后无法恢复。");
  if (action === "delete-record-from-feed") return askDelete("record", { recordId: target.dataset.id }, "删除这条调整？", "整条调整记录、所有续记和补充将一起删除。");
});

app.addEventListener("input", (event) => {
  if (event.target.id === "search-input") {
    view.query = event.target.value;
    const list = filteredRecords();
    document.querySelector(".record-list").innerHTML = list.length ? list.map(recordCard).join("") : emptyState();
  }
});

app.addEventListener("focusin", (event) => {
  if (!event.target.matches("#update-form textarea") || updateStartedAt) return;
  updateStartedAt = new Date();
  document.querySelector("#composer-cutoff").textContent = "记录于 " + formatClock(updateStartedAt);
});

app.addEventListener("submit", async (event) => {
  if (event.target.id !== "update-form") return;
  event.preventDefault();
  const body = new FormData(event.target).get("body").trim();
  if (!body) return notify("请填写续写内容");
  const createdAt = (updateStartedAt || new Date()).toISOString();
  updateStartedAt = null;
  try {
    await updateCurrent((record) => addUpdate(record, body, createdAt), "续写已保存");
  } catch (error) { notify(error.message); }
});

recordForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  const data = Object.fromEntries(new FormData(recordForm));
  const existing = records.find((record) => record.id === data.id);
  try {
    const record = createRecord({ ...data, id: data.id || undefined, tags: data.tags, focused: existing?.focused, updates: existing?.updates || [] });
    await saveRecord(db, record);
    recordDialog.close();
    view = { ...view, screen: "detail", recordId: record.id };
    await refresh();
    notify(existing ? "调整记录已更新" : "调整记录已保存");
  } catch (error) { notify(error.message); }
});

replyForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  const data = Object.fromEntries(new FormData(replyForm));
  try { await updateCurrent((record) => addReply(record, data.updateId, data.body), "补充已保存"); replyDialog.close(); } catch (error) { notify(error.message); }
});

replyEditForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  const data = Object.fromEntries(new FormData(replyEditForm));
  const body = data.body.trim();
  if (!body) return notify("请填写补充内容");
  const now = new Date().toISOString();
  try {
    await updateCurrent((record) => ({ ...record, updatedAt: now, updates: record.updates.map((update) => update.id === data.updateId ? { ...update, updatedAt: now, replies: update.replies.map((reply) => reply.id === data.replyId ? { ...reply, body, updatedAt: now } : reply) } : update) }), "补充已修改");
    replyEditDialog.close();
  } catch (error) { notify(error.message); }
});

updateEditForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  const data = Object.fromEntries(new FormData(updateEditForm));
  const body = data.body.trim();
  if (!body) return notify("请填写续记内容");
  const now = new Date().toISOString();
  try {
    await updateCurrent((record) => ({ ...record, updatedAt: now, updates: record.updates.map((update) => update.id === data.updateId ? { ...update, body, updatedAt: now } : update) }), "续记已修改");
    updateEditDialog.close();
  } catch (error) { notify(error.message); }
});

organizedUpdateForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  const data = Object.fromEntries(new FormData(organizedUpdateForm));
  const body = data.body.trim();
  if (!body) return notify("请填写整理内容");
  const now = new Date().toISOString();
  try {
    await updateCurrent((record) => ({ ...record, updatedAt: now, updates: record.updates.map((update) => update.id === data.updateId ? { ...update, body, updatedAt: now } : update) }), "数据已整理");
    organizedUpdateDialog.close();
  } catch (error) { notify(error.message); }
});

document.body.addEventListener("click", async (event) => {
  const action = event.target.closest("[data-action]")?.dataset.action;
  if (action === "close-record") recordDialog.close();
  if (action === "close-reply") replyDialog.close();
  if (action === "close-reply-edit") replyEditDialog.close();
  if (action === "close-update-edit") updateEditDialog.close();
  if (action === "close-organized-update") organizedUpdateDialog.close();
  if (action === "cancel-import") { pendingImport = null; importDialog.close(); }
  if (action === "merge-import" && pendingImport) restoreImport(false);
  if (action === "replace-import" && pendingImport) askDelete("replace-import", {}, "完全替换现有记录？", "当前设备中的全部记录会先被删除，再恢复这份备份。");
  if (action === "close-theme") themeDialog.close();
  if (action === "cancel-delete") { pendingDelete = null; deleteDialog.close(); }
  if (action === "confirm-delete") await confirmDelete();
  const choice = event.target.closest("[data-theme-choice]")?.dataset.themeChoice;
  if (choice) {
    theme = choice;
    localStorage.setItem(THEME_KEY, theme);
    applyTheme();
    themeDialog.close();
    render();
    notify(theme === "warm" ? "已切换到暖调任务主题" : "已切换到原始主题");
  }
});

backupInput.addEventListener("change", async () => {
  try {
    pendingImport = await readBackup(backupInput.files[0]);
    document.querySelector("#import-summary").innerHTML = `<p><b>${pendingImport.records.length}</b> 条调整记录</p><p>备份于 ${formatDate(pendingImport.exportedAt, true)}</p>`;
    importDialog.showModal();
  } catch (error) { notify(error.message); }
  backupInput.value = "";
});

async function restoreImport(replace) {
  const next = replace ? pendingImport.records : mergeRecords(records, pendingImport.records);
  await importRecords(db, next, replace, pendingImport.exportedAt);
  pendingImport = null;
  importDialog.close();
  await refresh();
  notify("备份恢复完成");
}

window.addEventListener("popstate", () => {
  updateStartedAt = null;
  document.querySelectorAll("dialog[open]").forEach((dialog) => dialog.close());
  const recordId = history.state?.recordId;
  view = recordId && records.some((record) => record.id === recordId) ? { ...view, screen: "detail", recordId, menu: false } : { ...view, screen: "feed", recordId: null, menu: false };
  render();
});

async function start() {
  try {
    history.replaceState({ screen: "feed" }, "", location.pathname);
    db = await openDatabase();
    await refresh();
    if ("serviceWorker" in navigator) navigator.serviceWorker.register("./sw.js");
  } catch (error) {
    app.innerHTML = `<div class="fatal"><h1>无法打开本地数据</h1><p>${escapeHtml(error.message)}</p><p>请确认浏览器没有禁用网站存储。</p></div>`;
  }
}

start();
