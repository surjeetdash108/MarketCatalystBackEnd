import { Firestore } from "firebase-admin/firestore";

const MAX_BATCH_WRITES = 500;
/**
 * Firestore caps a single commit at 10 MiB. Chunking on document COUNT alone
 * was not enough: a job whose documents are large blows the size limit long
 * before it reaches 500 of them. intraday-bars (a full session of bars per
 * ticker, 40 tickers a run) failed with "Transaction too big", and
 * analyst-actions hit "Request payload size exceeds the limit: 11534336 bytes"
 * the same way. Budget well under the cap: the estimate below counts JSON
 * characters, while the wire format adds field names, type tags and index
 * entries the estimate cannot see.
 *
 * The margin has to be wide, not cosmetic. intraday_bars documents are arrays
 * of ~780 seven-field maps, and Firestore re-encodes every field NAME for every
 * element, so the stored form runs several times the JSON character count. A
 * 6 MiB budget still produced a single oversized commit for one run of this job;
 * 1.5 MiB is sized so that even a 4-5x expansion stays under the 10 MiB cap.
 */
const MAX_BATCH_BYTES = 1.5 * 1024 * 1024;

/** Rough serialized size of a document's payload. Only needs to be good enough
 *  to keep a commit under the cap, so a cheap JSON length beats an exact walk. */
function approxBytes(data: unknown): number {
  try {
    return JSON.stringify(data)?.length ?? 0;
  } catch {
    return 0;
  }
}

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

  // Flush on EITHER limit — document count or estimated payload size.
  let chunk: PendingWrite[] = [];
  let chunkBytes = 0;
  const flush = async () => {
    if (chunk.length === 0) return;
    const batch = firestore.batch();
    for (const { ref, data, merge = true } of chunk) {
      batch.set(
        ref,
        { ...data, createdAt: prior.get(ref.path) ?? now },
        { merge },
      );
    }
    await batch.commit();
    chunk = [];
    chunkBytes = 0;
  };

  for (const w of writes) {
    const size = approxBytes(w.data);
    // A single oversized document still goes on its own rather than being
    // dropped — Firestore's own 1 MiB per-document limit is the backstop there.
    if (
      chunk.length >= MAX_BATCH_WRITES ||
      (chunk.length > 0 && chunkBytes + size > MAX_BATCH_BYTES)
    ) {
      await flush();
    }
    chunk.push(w);
    chunkBytes += size;
  }
  await flush();
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
