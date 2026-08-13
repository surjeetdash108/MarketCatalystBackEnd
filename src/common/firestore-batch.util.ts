import { Firestore } from "firebase-admin/firestore";

const MAX_BATCH_WRITES = 500;

/**
 * How many refs to resolve per getAll(). Firestore documents no hard cap, but
 * large getAll calls are slow and memory-hungry, so this mirrors the write
 * batch size to keep the read and write passes symmetrical.
 */
const MAX_READ_BATCH = 500;

export interface PendingWrite {
  ref: FirebaseFirestore.DocumentReference;
  data: FirebaseFirestore.DocumentData;
  /**
   * Defaults to true. Pass false to keep a call site's original full-overwrite
   * behaviour — carrying `createdAt` forward works either way, because it is
   * read first and written back as part of the payload. Without this option a
   * plain `set()` would quietly become a merge and any field later dropped from
   * the code would linger in Firestore forever.
   */
  merge?: boolean;
}

/**
 * Reads the existing `createdAt` for each ref.
 *
 * Firestore cannot set a field conditionally inside a batch — a write is either
 * a full overwrite or a merge, and a merge would clobber `createdAt` with the
 * current time on every run. Reading first and carrying the original value
 * forward is the only way to keep a true creation timestamp.
 *
 * The fieldMask keeps the payload to that one field. It is still billed as a
 * document read, but at ~1 read per written doc that is small next to the write
 * it accompanies.
 */
async function existingCreatedAt(
  firestore: Firestore,
  refs: FirebaseFirestore.DocumentReference[],
): Promise<Map<string, string>> {
  const found = new Map<string, string>();
  for (let i = 0; i < refs.length; i += MAX_READ_BATCH) {
    const chunk = refs.slice(i, i + MAX_READ_BATCH);
    const snaps = await firestore.getAll(...chunk, {
      fieldMask: ["createdAt"],
    });
    for (const snap of snaps) {
      const v = snap.get("createdAt");
      if (typeof v === "string" && v) found.set(snap.ref.path, v);
    }
  }
  return found;
}

/**
 * Merge-writes documents, stamping `createdAt` on first write and preserving it
 * on every write thereafter.
 *
 * Refs may span different collections in one call, so a job that writes a
 * current doc and its history twin can keep both in the same batch.
 *
 * `createdAt` is an ISO-8601 string, matching the existing `updatedAt`
 * convention and letting the purge API range-filter it as a 'datetime' field.
 * A document that is deleted and later re-synced gets a NEW createdAt — correct,
 * since it is genuinely a new document.
 */
export async function batchSetWithCreatedAt(
  firestore: Firestore,
  writes: PendingWrite[],
  now = new Date().toISOString(),
): Promise<void> {
  if (writes.length === 0) return;

  const prior = await existingCreatedAt(
    firestore,
    writes.map((w) => w.ref),
  );

  for (let i = 0; i < writes.length; i += MAX_BATCH_WRITES) {
    const chunk = writes.slice(i, i + MAX_BATCH_WRITES);
    const batch = firestore.batch();
    for (const { ref, data, merge = true } of chunk) {
      batch.set(
        ref,
        { ...data, createdAt: prior.get(ref.path) ?? now },
        { merge },
      );
    }
    await batch.commit();
  }
}

/**
 * Single-document variant. Use where a write must stay in its original position
 * in a sequence — batching it would reorder it relative to neighbouring reads
 * and writes.
 */
export async function setWithCreatedAt(
  firestore: Firestore,
  ref: FirebaseFirestore.DocumentReference,
  data: FirebaseFirestore.DocumentData,
  merge = true,
): Promise<void> {
  await batchSetWithCreatedAt(firestore, [{ ref, data, merge }]);
}

/**
 * Convenience wrapper for the common case: many docs into one collection.
 * Signature unchanged — every existing caller gets `createdAt` for free.
 */
export async function chunkedBatchSet<T>(
  firestore: Firestore,
  collectionName: string,
  docs: Array<{ id: string; data: T }>,
): Promise<void> {
  const col = firestore.collection(collectionName);
  await batchSetWithCreatedAt(
    firestore,
    docs.map(({ id, data }) => ({
      ref: col.doc(id),
      data: data,
    })),
  );
}
