import {
  PROJECT_STORAGE_KEY,
  parseSnapshot,
  type ProjectSnapshot,
} from './projectSnapshot.ts'

export interface KeyValueStore {
  get(key: string): string | null
  set(key: string, value: string): void
  remove(key: string): void
}

let storageTail: Promise<unknown> = Promise.resolve()

function enqueue<T>(task: () => Promise<T>): Promise<T> {
  const run = storageTail.then(task, task)
  storageTail = run.then(
    () => undefined,
    () => undefined,
  )
  return run
}

export function browserKeyValue(): KeyValueStore {
  return {
    get(key) {
      try {
        return localStorage.getItem(key)
      } catch {
        return null
      }
    },
    set(key, value) {
      localStorage.setItem(key, value)
    },
    remove(key) {
      try {
        localStorage.removeItem(key)
      } catch {
        // Storage can be disabled. The in-memory edit still stands.
      }
    },
  }
}

export function readStoredSnapshot(store: KeyValueStore): ProjectSnapshot | null {
  const raw = store.get(PROJECT_STORAGE_KEY)
  if (!raw) return null
  const parsed = parseSnapshot(raw)
  if (!parsed) {
    store.remove(PROJECT_STORAGE_KEY)
    return null
  }
  return parsed
}

export function writeStoredSnapshot(store: KeyValueStore, snapshot: ProjectSnapshot): boolean {
  try {
    store.set(PROJECT_STORAGE_KEY, JSON.stringify(snapshot))
    return true
  } catch {
    return false
  }
}

export function clearStoredSnapshot(store: KeyValueStore): void {
  store.remove(PROJECT_STORAGE_KEY)
}

const DB_NAME = 'frameflow'
const DB_VERSION = 1
const UPLOAD_STORE = 'uploads'

function openUploads(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION)
    request.onupgradeneeded = () => {
      const db = request.result
      if (!db.objectStoreNames.contains(UPLOAD_STORE)) db.createObjectStore(UPLOAD_STORE)
    }
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error ?? new Error('IndexedDB failed'))
  })
}

async function withUploads<T>(
  mode: IDBTransactionMode,
  run: (store: IDBObjectStore) => Promise<T> | T,
): Promise<T> {
  if (typeof indexedDB === 'undefined') {
    throw new Error('IndexedDB is unavailable')
  }
  const db = await openUploads()
  try {
    const tx = db.transaction(UPLOAD_STORE, mode)
    const result = await run(tx.objectStore(UPLOAD_STORE))
    await new Promise<void>((resolve, reject) => {
      tx.oncomplete = () => resolve()
      tx.onerror = () => reject(tx.error ?? new Error('IndexedDB failed'))
      tx.onabort = () => reject(tx.error ?? new Error('IndexedDB failed'))
    })
    return result
  } finally {
    db.close()
  }
}

function requestResult<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error ?? new Error('IndexedDB failed'))
  })
}

export function putUploadBlob(vaultId: string, blob: Blob): Promise<void> {
  if (!vaultId || blob.size < 0) return Promise.resolve()
  return enqueue(async () => {
    try {
      await withUploads('readwrite', (store) => {
        store.put(blob, vaultId)
      })
    } catch {
      // The file still plays in this tab. Refresh will report it as unrestored.
    }
  })
}

export function getUploadBlob(vaultId: string): Promise<Blob | null> {
  return enqueue(async () => {
    try {
      const blob = await withUploads('readonly', (store) => requestResult(store.get(vaultId)))
      return blob instanceof Blob ? blob : null
    } catch {
      return null
    }
  })
}

export function listUploadIds(): Promise<string[]> {
  return enqueue(async () => {
    try {
      const keys = await withUploads('readonly', (store) => requestResult(store.getAllKeys()))
      return keys.filter((key): key is string => typeof key === 'string')
    } catch {
      return []
    }
  })
}

export function clearUploadBlobs(): Promise<void> {
  return enqueue(async () => {
    try {
      await withUploads('readwrite', (store) => {
        store.clear()
      })
    } catch {
      // A failed clear still drops the snapshot key. Leftover bytes are unused.
    }
  })
}

export async function clearProjectStorage(store: KeyValueStore = browserKeyValue()): Promise<void> {
  clearStoredSnapshot(store)
  await clearUploadBlobs()
}
