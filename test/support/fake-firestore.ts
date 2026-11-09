/**
 * A small in-memory stand-in for the slice of Firestore the admin Jobs code
 * uses. Test support only — it lives outside src/ so it is never compiled into
 * the image.
 *
 * It models the behaviours the code under test depends on, not Firestore in
 * general:
 *   - doc().update() fails on a missing document, like the real SDK
 *   - runTransaction() buffers writes and applies them only if the callback
 *     resolves, so a thrown error leaves the store untouched
 *   - queries support where(==|in), orderBy and limit
 *   - an injectable failure hook, to exercise the "Firestore is down" paths
 */
type Data = Record<string, unknown>;

export class FakeFirestore {
  private readonly collections = new Map<string, Map<string, Data>>();
  private counter = 0;
  /** Return an Error to make that operation fail; undefined lets it through. */
  failOn: (op: string, collection: string) => Error | undefined = () => undefined;

  seed(collection: string, id: string, data: Data): void {
    this.bucket(collection).set(id, { ...data });
  }

  read(collection: string, id: string): Data | undefined {
    const d = this.bucket(collection).get(id);
    return d ? { ...d } : undefined;
  }

  ids(collection: string): string[] {
    return [...this.bucket(collection).keys()];
  }

  /** Same-shaped 20-char alphanumeric ids as Firestore's auto-ids. */
  newId(): string {
    this.counter += 1;
    return `run${String(this.counter).padStart(17, "0")}`;
  }

  bucket(name: string): Map<string, Data> {
    let b = this.collections.get(name);
    if (!b) this.collections.set(name, (b = new Map()));
    return b;
  }

  guard(op: string, collection: string): void {
    const err = this.failOn(op, collection);
    if (err) throw err;
  }

  collection(name: string): FakeCollection {
    return new FakeCollection(this, name);
  }

  /** `firestore.doc("a/b")` / `doc("a/b/c/d")`: last segment is the id. */
  doc(path: string): FakeDocRef {
    const parts = path.split("/").filter(Boolean);
    if (parts.length < 2 || parts.length % 2 !== 0) {
      throw new Error(`FakeFirestore: not a document path: ${path}`);
    }
    return new FakeDocRef(this, parts.slice(0, -1).join("/"), parts[parts.length - 1]);
  }

  batch(): FakeBatch {
    return new FakeBatch(this);
  }

  /** Transactions run one at a time, which is what serializability amounts to. */
  private txTail: Promise<unknown> = Promise.resolve();

  async runTransaction<T>(fn: (tx: FakeTransaction) => Promise<T>): Promise<T> {
    // Real Firestore detects two transactions that touched the same data and
    // retries the loser against the winner's result. Running them back to back
    // gives the same outcome, and keeps a test of a double-click honest — with
    // free interleaving both would read before either wrote.
    const run = async (): Promise<T> => {
      this.guard("transaction", "*");
      const tx = new FakeTransaction(this);
      const result = await fn(tx);
      tx.commit();
      return result;
    };
    const result = this.txTail.then(run, run);
    this.txTail = result.catch(() => undefined);
    return result;
  }
}

function isPlainObject(v: unknown): v is Data {
  return typeof v === "object" && v !== null && !Array.isArray(v) && !(v instanceof Date);
}

/** Real Firestore rejects `undefined` anywhere in a document; so does the fake. */
export function assertNoUndefined(data: unknown, path = ""): void {
  if (data === undefined) {
    throw new Error(`Cannot use "undefined" as a Firestore value (found in field "${path}")`);
  }
  if (Array.isArray(data)) data.forEach((v, i) => assertNoUndefined(v, `${path}[${i}]`));
  else if (isPlainObject(data)) for (const [k, v] of Object.entries(data)) assertNoUndefined(v, path ? `${path}.${k}` : k);
}

/** Firestore `set(..., { merge: true })` semantics: maps merge recursively. */
export function deepMerge(base: Data, patch: Data): Data {
  const out: Data = { ...base };
  for (const [k, v] of Object.entries(patch)) {
    out[k] = isPlainObject(v) && isPlainObject(out[k]) ? deepMerge(out[k] as Data, v) : v;
  }
  return out;
}

class FakeSnapshot {
  constructor(
    readonly id: string,
    private readonly value: Data | undefined,
  ) {}
  get exists(): boolean {
    return this.value !== undefined;
  }
  data(): Data | undefined {
    return this.value ? { ...this.value } : undefined;
  }
}

export class FakeDocRef {
  constructor(
    readonly fs: FakeFirestore,
    readonly collectionName: string,
    readonly id: string,
  ) {}

  async get(): Promise<FakeSnapshot> {
    this.fs.guard("get", this.collectionName);
    return new FakeSnapshot(this.id, this.fs.bucket(this.collectionName).get(this.id));
  }

  get path(): string {
    return `${this.collectionName}/${this.id}`;
  }

  async set(data: Data, opts?: { merge?: boolean }): Promise<void> {
    this.fs.guard("set", this.collectionName);
    assertNoUndefined(data);
    const bucket = this.fs.bucket(this.collectionName);
    const current = bucket.get(this.id);
    bucket.set(this.id, opts?.merge && current ? deepMerge(current, data) : { ...data });
  }

  async update(patch: Data): Promise<void> {
    this.fs.guard("update", this.collectionName);
    assertNoUndefined(patch);
    const bucket = this.fs.bucket(this.collectionName);
    const current = bucket.get(this.id);
    if (!current) throw new Error(`NOT_FOUND: ${this.collectionName}/${this.id}`);
    bucket.set(this.id, { ...current, ...patch });
  }

  async delete(): Promise<void> {
    this.fs.guard("delete", this.collectionName);
    this.fs.bucket(this.collectionName).delete(this.id);
  }
}

type Filter = (data: Data) => boolean;

export class FakeQuery {
  constructor(
    protected readonly fs: FakeFirestore,
    protected readonly name: string,
    private readonly filters: Filter[] = [],
    private readonly order?: { field: string; dir: "asc" | "desc" },
    private readonly max?: number,
  ) {}

  where(field: string, op: string, value: unknown): FakeQuery {
    const cmp = (a: unknown, b: unknown) =>
      typeof a === "number" && typeof b === "number"
        ? a - b
        : String(a ?? "").localeCompare(String(b ?? ""));
    const ops: Record<string, Filter> = {
      in: (d) => (value as unknown[]).includes(d[field]),
      "==": (d) => d[field] === value,
      "!=": (d) => d[field] !== value && d[field] !== undefined,
      "<": (d) => d[field] !== undefined && cmp(d[field], value) < 0,
      "<=": (d) => d[field] !== undefined && cmp(d[field], value) <= 0,
      ">": (d) => d[field] !== undefined && cmp(d[field], value) > 0,
      ">=": (d) => d[field] !== undefined && cmp(d[field], value) >= 0,
      "array-contains": (d) => Array.isArray(d[field]) && (d[field] as unknown[]).includes(value),
    };
    const match = ops[op];
    if (!match) throw new Error(`FakeFirestore: unsupported operator ${op}`);
    return new FakeQuery(this.fs, this.name, [...this.filters, match], this.order, this.max);
  }

  orderBy(field: string, dir: "asc" | "desc" = "asc"): FakeQuery {
    return new FakeQuery(this.fs, this.name, this.filters, { field, dir }, this.max);
  }

  limit(n: number): FakeQuery {
    return new FakeQuery(this.fs, this.name, this.filters, this.order, n);
  }

  async get(): Promise<{
    docs: Array<FakeSnapshot & { ref: FakeDocRef }>;
    size: number;
    empty: boolean;
  }> {
    this.fs.guard("query", this.name);
    let rows = [...this.fs.bucket(this.name).entries()].filter(([, d]) =>
      this.filters.every((f) => f(d)),
    );
    if (this.order) {
      const { field, dir } = this.order;
      rows.sort(([, a], [, b]) => {
        const x = String(a[field] ?? "");
        const y = String(b[field] ?? "");
        return dir === "desc" ? y.localeCompare(x) : x.localeCompare(y);
      });
    }
    if (this.max !== undefined) rows = rows.slice(0, this.max);
    const docs = rows.map(([id, d]) => {
      const snap = new FakeSnapshot(id, d) as FakeSnapshot & { ref: FakeDocRef };
      snap.ref = new FakeDocRef(this.fs, this.name, id);
      return snap;
    });
    return { docs, size: docs.length, empty: docs.length === 0 };
  }
}

export class FakeCollection extends FakeQuery {
  constructor(fs: FakeFirestore, name: string) {
    super(fs, name);
  }

  doc(id?: string): FakeDocRef {
    return new FakeDocRef(this.fs, this.name, id ?? this.fs.newId());
  }
}

export class FakeTransaction {
  private readonly writes: Array<() => void> = [];
  constructor(private readonly fs: FakeFirestore) {}

  async get(target: FakeDocRef | FakeQuery) {
    return target instanceof FakeDocRef ? target.get() : target.get();
  }

  set(ref: FakeDocRef, data: Data, opts?: { merge?: boolean }): void {
    assertNoUndefined(data);
    this.writes.push(() => {
      const bucket = this.fs.bucket(ref.collectionName);
      const current = bucket.get(ref.id);
      bucket.set(ref.id, opts?.merge && current ? deepMerge(current, data) : { ...data });
    });
  }

  update(ref: FakeDocRef, patch: Data): void {
    assertNoUndefined(patch);
    this.writes.push(() => {
      const bucket = this.fs.bucket(ref.collectionName);
      const current = bucket.get(ref.id);
      if (!current) throw new Error(`NOT_FOUND: ${ref.collectionName}/${ref.id}`);
      bucket.set(ref.id, { ...current, ...patch });
    });
  }

  delete(ref: FakeDocRef): void {
    this.writes.push(() => this.fs.bucket(ref.collectionName).delete(ref.id));
  }

  commit(): void {
    for (const write of this.writes) write();
  }
}

/** WriteBatch: buffered writes applied on commit(). */
export class FakeBatch {
  private readonly tx: FakeTransaction;
  constructor(fs: FakeFirestore) {
    this.tx = new FakeTransaction(fs);
  }
  set(ref: FakeDocRef, data: Data, opts?: { merge?: boolean }): this {
    this.tx.set(ref, data, opts);
    return this;
  }
  update(ref: FakeDocRef, patch: Data): this {
    this.tx.update(ref, patch);
    return this;
  }
  delete(ref: FakeDocRef): this {
    this.tx.delete(ref);
    return this;
  }
  async commit(): Promise<void> {
    this.tx.commit();
  }
}
