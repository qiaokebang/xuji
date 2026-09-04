const DB_NAME = "xuji-db";
const DB_VERSION = 1;

const requestResult = (request) => new Promise((resolve, reject) => {
  request.onsuccess = () => resolve(request.result);
  request.onerror = () => reject(request.error);
});

const transactionDone = (transaction) => new Promise((resolve, reject) => {
  transaction.oncomplete = resolve;
  transaction.onerror = () => reject(transaction.error);
  transaction.onabort = () => reject(transaction.error || new Error("数据操作已取消"));
});

export function openDatabase() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains("records")) db.createObjectStore("records", { keyPath: "id" });
      if (!db.objectStoreNames.contains("meta")) db.createObjectStore("meta", { keyPath: "key" });
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

export async function getRecords(db) {
  return requestResult(db.transaction("records", "readonly").objectStore("records").getAll());
}

export async function getMeta(db) {
  const rows = await requestResult(db.transaction("meta", "readonly").objectStore("meta").getAll());
  return Object.fromEntries(rows.map(({ key, value }) => [key, value]));
}

async function markChanged(transaction) {
  const store = transaction.objectStore("meta");
  const current = await requestResult(store.get("changesSinceBackup"));
  store.put({ key: "changesSinceBackup", value: Number(current?.value || 0) + 1 });
}

export async function saveRecord(db, record) {
  const transaction = db.transaction(["records", "meta"], "readwrite");
  const done = transactionDone(transaction);
  transaction.objectStore("records").put(record);
  await markChanged(transaction);
  await done;
}

export async function deleteRecord(db, id) {
  const transaction = db.transaction(["records", "meta"], "readwrite");
  const done = transactionDone(transaction);
  transaction.objectStore("records").delete(id);
  await markChanged(transaction);
  await done;
}

export async function setBackupComplete(db, timestamp) {
  const transaction = db.transaction("meta", "readwrite");
  const done = transactionDone(transaction);
  const store = transaction.objectStore("meta");
  store.put({ key: "lastBackupAt", value: timestamp });
  store.put({ key: "changesSinceBackup", value: 0 });
  await done;
}

export async function importRecords(db, records, replace, backupTime) {
  const transaction = db.transaction(["records", "meta"], "readwrite");
  const done = transactionDone(transaction);
  const store = transaction.objectStore("records");
  if (replace) store.clear();
  records.forEach((record) => store.put(record));
  transaction.objectStore("meta").put({ key: "lastBackupAt", value: backupTime });
  transaction.objectStore("meta").put({ key: "changesSinceBackup", value: 0 });
  await done;
}
