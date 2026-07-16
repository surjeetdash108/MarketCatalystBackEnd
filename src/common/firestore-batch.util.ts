import { Firestore } from 'firebase-admin/firestore';

const MAX_BATCH_WRITES = 500;

export async function chunkedBatchSet<T>(
  firestore: Firestore,
  collectionName: string,
  docs: Array<{ id: string; data: T }>,
): Promise<void> {
  const col = firestore.collection(collectionName);
  for (let i = 0; i < docs.length; i += MAX_BATCH_WRITES) {
    const chunk = docs.slice(i, i + MAX_BATCH_WRITES);
    const batch = firestore.batch();
    for (const { id, data } of chunk) {
      batch.set(col.doc(id), data as FirebaseFirestore.DocumentData, { merge: true });
    }
    await batch.commit();
  }
}
