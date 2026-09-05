import { addReply, addUpdate, createBackup, createRecord, formatElapsed, mergeRecords, STATUSES, verifyBackup } from "./domain.js";
import { deleteRecord, getMeta, getRecords, importRecords, openDatabase, saveRecord, setBackupComplete } from "./db.js";
import { METRIC_FIELDS, organizeMetrics } from "./metrics.js";

const app = document.querySelector("#app");
const recordDialog = document.querySelector("#record-dialog");
const recordForm = document.querySelector("#record-form");
const replyDialog = document.querySelector("#reply-dialog");
const replyForm = document.querySelector("#reply-form");
const updateEditDialog = document.querySelector("#update-edit-dialog");
const updateEditForm = document.querySelector("#update-edit-form");
const organizedUpdateDialog = document.querySelector("#organized-update-dialog");
const organizedUpdateForm = document.querySelector("#organized-update-form");
const organizeSummary = document.querySelector("#organize-summary");
const organizeOriginal = document.querySelector("#organize-original");
const importDialog = document.querySelector("#import-dialog");
const backupInput = document.querySelector("#backup-input");
const toast = document.querySelector("#toast");
let db;
let records = [];
let meta = {};
let view = { screen: "feed", recordId: null, query: "", status: "all", menu: false, search: false };
let pendingImport = null;
const SWIPE_ACTION_WIDTH = 80;
let swipeGesture = null;
let suppressCardClickUntil = 0;

const escapeHtml = (value) => String(value ?? "").replace(/[&<>'"]/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;" })[char]);
const multiline = (value) => escapeHtml(value).replace(/\n/g, "<br>");
const formatDate = (value, full = false) => new Intl.DateTimeFormat("zh-CN", full ? { year: "numeric", month: "long", day: "numeric", hour: "2-digit", minute: "2-digit" } : { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" }).format(new Date(value));
const localDateTime = (value = new Date()) => new Date(value.getTime() - value.getTimezoneOffset() * 60000).toISOString().slice(0, 16);

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
    <header class="topbar"><div><h1>续记</h1><p>直通车调整日志</p></div><div class="header-actions"><button class="icon-button" data-action="toggle-search" aria-label="搜索">⌕</button><button class="icon-button dots" data-action="toggle-menu" aria-label="更多" aria-expanded="${view.menu}">•••</button></div></header>
    ${view.menu ? `<div class="more-menu"><button data-action="export-backup">导出完整备份</button><button data-action="choose-backup">从备份恢复</button><button data-action="show-help">使用说明</button></div>` : ""}
    ${view.search ? `<div class="search-wrap"><input id="search-input" type="search" value="${escapeHtml(view.query)}" placeholder="搜索调整、续记或标签" aria-label="搜索记录"></div>` : ""}
    <main class="feed">
      <div class="filters"><button class="filter ${view.status === "all" ? "active" : ""}" data-filter="all">全部</button><button class="filter ${view.status === "watching" ? "active" : ""}" data-filter="watching">观察中</button><button class="filter ${view.status === "ended" ? "active" : ""}" data-filter="ended">已结束</button></div>
      ${needsBackup() ? `<button class="backup-notice" data-action="export-backup">${meta.lastBackupAt ? "距上次备份较久，建议现在备份" : "这些记录还没有备份，建议立即备份"}<span>去备份 ›</span></button>` : ""}
      <section class="record-list" aria-label="调整记录">${list.length ? list.map(recordCard).join("") : emptyState()}</section>
    </main>
    <button class="fab" data-action="new-record" aria-label="新建调整">＋</button>
  </div>`;
  if (view.search) requestAnimationFrame(() => document.querySelector("#search-input")?.focus());
}

function recordCard(record) {
  const latest = record.updates.at(-1);
  return `<div class="swipe-row"><button class="swipe-delete" data-action="delete-record-from-feed" data-id="${escapeHtml(record.id)}" aria-label="删除这条调整记录"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3 6h18M8 6V4h8v2M7 6l1 14h8l1-14M10 10v6M14 10v6"/></svg><span>删除</span></button><article class="record-card" data-action="open-record" data-id="${escapeHtml(record.id)}">
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
    <form id="update-form" class="composer"><textarea name="body" rows="1" maxlength="10000" required placeholder="语音输入数据或记录后续反应…" aria-label="续记内容"></textarea><button type="submit">整理</button></form>
  </div>`;
}

function updateItem(record, update) {
  return `<article class="timeline-item"><div class="timeline-dot"></div><div class="elapsed">调整后 ${formatElapsed(record.createdAt, update.createdAt)}</div><p>${multiline(update.body)}</p><time>${formatDate(update.createdAt, true)}</time>
    <div class="item-actions"><button data-action="reply" data-update-id="${escapeHtml(update.id)}">追评</button><button data-action="edit-update" data-update-id="${escapeHtml(update.id)}">编辑</button><button data-action="delete-update" data-update-id="${escapeHtml(update.id)}">删除</button></div>
    ${update.replies.map((reply) => `<div class="reply"><p><b>追评</b> · ${multiline(reply.body)}</p><div><time>${formatDate(reply.createdAt)}</time><button data-action="delete-reply" data-update-id="${escapeHtml(update.id)}" data-reply-id="${escapeHtml(reply.id)}">删除</button></div></div>`).join("")}
  </article>`;
}

function render() {
  view.screen === "detail" ? renderDetail() : renderFeed();
}

function goFeed() {
  if (view.screen === "detail" && history.state?.recordId) return history.back();
  view = { ...view, screen: "feed", recordId: null, menu: false };
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
  const date = payload.exportedAt.replace(/[-:]/g, "").slice(0, 13).replace("T", "-");
  const file = new File([JSON.stringify(payload, null, 2)], `续记备份-${date}.json`, { type: "application/json" });
  try {
    let shared = false;
    if (navigator.canShare?.({ files: [file] })) {
      try { await navigator.share({ files: [file], title: "续记完整备份" }); shared = true; }
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
  return payload;
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
  if (action === "open-record") { view = { ...view, screen: "detail", recordId: target.dataset.id, menu: false }; history.pushState({ screen: "detail", recordId: target.dataset.id }, "", `#${target.dataset.id}`); return render(); }
  if (action === "back") return goFeed();
  if (action === "edit-record") return openRecordDialog(activeRecord());
  if (action === "export-backup") return exportBackup();
  if (action === "choose-backup") { view.menu = false; render(); backupInput.click(); return; }
  if (action === "show-help") { view.menu = false; render(); return notify("先记录调整，再进入详情持续续记；请定期导出备份。"); }
  if (action === "reply") { replyForm.reset(); replyForm.elements.updateId.value = target.dataset.updateId; return replyDialog.showModal(); }
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
  if (action === "delete-update" && confirm("删除这条续记及其全部追评？")) return updateCurrent((record) => ({ ...record, updatedAt: new Date().toISOString(), updates: record.updates.filter((item) => item.id !== target.dataset.updateId) }), "续记已删除");
  if (action === "delete-reply" && confirm("删除这条追评？")) return updateCurrent((record) => ({ ...record, updatedAt: new Date().toISOString(), updates: record.updates.map((item) => item.id === target.dataset.updateId ? { ...item, replies: item.replies.filter((reply) => reply.id !== target.dataset.replyId) } : item) }), "追评已删除");
  if (action === "delete-record-from-feed" && confirm("删除整条调整记录及所有续记？此操作无法撤销。")) { await deleteRecord(db, target.dataset.id); await refresh(); notify("记录已删除"); }
});

app.addEventListener("input", (event) => {
  if (event.target.id === "search-input") {
    view.query = event.target.value;
    const list = filteredRecords();
    document.querySelector(".record-list").innerHTML = list.length ? list.map(recordCard).join("") : emptyState();
  }
});

app.addEventListener("submit", async (event) => {
  if (event.target.id !== "update-form") return;
  event.preventDefault();
  const result = organizeMetrics(new FormData(event.target).get("body"));
  organizedUpdateForm.elements.body.value = result.text;
  organizeOriginal.textContent = result.original;
  organizeSummary.textContent = result.recognized === METRIC_FIELDS.length ? "已识别全部 12 项指标，请核对数值后保存。" : result.recognized ? "已识别 " + result.recognized + "/12 项；请检查未识别项：" + result.missing.join("、") : "未识别到固定指标，已保留原文，请检查后保存。";
  organizeSummary.classList.toggle("warning", result.recognized !== METRIC_FIELDS.length);
  organizedUpdateDialog.showModal();
});

recordForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  const data = Object.fromEntries(new FormData(recordForm));
  const existing = records.find((record) => record.id === data.id);
  try {
    const record = createRecord({ ...data, id: data.id || undefined, tags: data.tags, updates: existing?.updates || [] });
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
  try { await updateCurrent((record) => addReply(record, data.updateId, data.body), "追评已保存"); replyDialog.close(); } catch (error) { notify(error.message); }
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
  const body = new FormData(organizedUpdateForm).get("body").trim();
  if (!body) return notify("请填写续记内容");
  try {
    await updateCurrent((record) => addUpdate(record, body), "续记已保存");
    organizedUpdateDialog.close();
  } catch (error) { notify(error.message); }
});

document.body.addEventListener("click", (event) => {
  const action = event.target.closest("[data-action]")?.dataset.action;
  if (action === "close-record") recordDialog.close();
  if (action === "close-reply") replyDialog.close();
  if (action === "close-update-edit") updateEditDialog.close();
  if (action === "close-organized-update") organizedUpdateDialog.close();
  if (action === "cancel-import") { pendingImport = null; importDialog.close(); }
  if (action === "merge-import" && pendingImport) restoreImport(false);
  if (action === "replace-import" && pendingImport && confirm("确定完全替换当前全部记录？")) restoreImport(true);
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
