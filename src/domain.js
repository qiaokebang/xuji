export const BACKUP_APP = "xuji-local-experiment-log";
export const BACKUP_VERSION = 1;
export const STATUSES = {
  watching: "观察中",
  effective: "有效",
  ineffective: "无效",
  unclear: "无法判断"
};

const text = (value, max) => String(value ?? "").trim().slice(0, max);
const validDate = (value) => typeof value === "string" && !Number.isNaN(Date.parse(value));

export function createId() {
  return globalThis.crypto?.randomUUID?.() || `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}

export function createRecord(input, now = new Date().toISOString()) {
  const body = text(input.body, 20000);
  if (!body) throw new Error("请填写调整内容");
  const createdAt = validDate(input.createdAt) ? new Date(input.createdAt).toISOString() : now;
  const status = Object.hasOwn(STATUSES, input.status) ? input.status : "watching";
  return {
    id: input.id || createId(),
    body,
    reason: text(input.reason, 10000),
    status,
    tags: [...new Set((Array.isArray(input.tags) ? input.tags : String(input.tags || "").split(/\s+/)).map((tag) => text(tag, 30)).filter(Boolean))].slice(0, 10),
    createdAt,
    updatedAt: now,
    updates: Array.isArray(input.updates) ? input.updates : []
  };
}

export function addUpdate(record, body, now = new Date().toISOString()) {
  const content = text(body, 10000);
  if (!content) throw new Error("请填写续记内容");
  return { ...record, updatedAt: now, updates: [...record.updates, { id: createId(), body: content, createdAt: now, updatedAt: now, replies: [] }] };
}

export function addReply(record, updateId, body, now = new Date().toISOString()) {
  const content = text(body, 10000);
  if (!content) throw new Error("请填写追评内容");
  let found = false;
  const updates = record.updates.map((update) => update.id === updateId ? (found = true, { ...update, updatedAt: now, replies: [...update.replies, { id: createId(), body: content, createdAt: now, updatedAt: now }] }) : update);
  if (!found) throw new Error("没有找到要追评的记录");
  return { ...record, updatedAt: now, updates };
}

export function formatElapsed(start, end) {
  const seconds = Math.max(0, (new Date(end) - new Date(start)) / 1000);
  if (seconds < 60) return "刚刚";
  if (seconds < 3600) return `${Math.floor(seconds / 60)} 分钟`;
  if (seconds < 172800) return `${Math.floor(seconds / 3600)} 小时`;
  if (seconds < 5184000) return `${Math.floor(seconds / 86400)} 天`;
  if (seconds < 31536000) return `${Math.floor(seconds / 2592000)} 个月`;
  return `${Math.floor(seconds / 31536000)} 年`;
}

export function formatBackupFilename(value = new Date()) {
  const date = value instanceof Date ? value : new Date(value);
  const pad = (part) => String(part).padStart(2, "0");
  const stamp = `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}-${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`;
  return `续记备份-${stamp}.json`;
}

export function validateRecord(record) {
  if (!record || typeof record !== "object" || typeof record.id !== "string" || !record.id || !text(record.body, 20000)) return false;
  if (!Object.hasOwn(STATUSES, record.status) || !validDate(record.createdAt) || !validDate(record.updatedAt) || !Array.isArray(record.tags) || record.tags.length > 10 || !Array.isArray(record.updates)) return false;
  return record.updates.every((update) => update && typeof update.id === "string" && !!text(update.body, 10000) && validDate(update.createdAt) && validDate(update.updatedAt || update.createdAt) && Array.isArray(update.replies) && update.replies.every((reply) => reply && typeof reply.id === "string" && !!text(reply.body, 10000) && validDate(reply.createdAt)));
}

export function validateBackupShape(value) {
  return value && value.app === BACKUP_APP && value.version === BACKUP_VERSION && validDate(value.exportedAt) && typeof value.checksum === "string" && Array.isArray(value.records) && value.records.length <= 100000 && value.records.every(validateRecord);
}

async function checksum(value, algorithm = "sha256") {
  if (algorithm === "sha256" && globalThis.crypto?.subtle) {
    const hash = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
    return `sha256:${[...new Uint8Array(hash)].map((byte) => byte.toString(16).padStart(2, "0")).join("")}`;
  }
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) hash = Math.imul(hash ^ value.charCodeAt(index), 16777619);
  return `fnv1a:${(hash >>> 0).toString(16).padStart(8, "0")}`;
}

export async function createBackup(records, exportedAt = new Date().toISOString()) {
  const base = { app: BACKUP_APP, version: BACKUP_VERSION, exportedAt, records: records.slice().sort((a, b) => a.id.localeCompare(b.id)) };
  return { ...base, checksum: await checksum(JSON.stringify(base)) };
}

export async function verifyBackup(payload) {
  if (!validateBackupShape(payload)) return false;
  const base = { app: payload.app, version: payload.version, exportedAt: payload.exportedAt, records: payload.records };
  return payload.checksum === await checksum(JSON.stringify(base), payload.checksum.split(":")[0]);
}

export function mergeRecords(current, imported) {
  const records = new Map(current.map((record) => [record.id, record]));
  for (const record of imported) {
    const existing = records.get(record.id);
    if (!existing || Date.parse(record.updatedAt) > Date.parse(existing.updatedAt)) records.set(record.id, record);
  }
  return [...records.values()];
}
