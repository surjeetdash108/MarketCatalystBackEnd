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

  async set(data: Data): Promise<void> {
    this.fs.guard("set", this.collectionName);
    this.fs.bucket(this.collectionName).set(this.id, { ...data });
  }

  async update(patch: Data): Promise<void> {
    this.fs.guard("update", this.collectionName);
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
    const match: Filter =
      op === "in"
        ? (d) => (value as unknown[]).includes(d[field])
        : op === "=="
          ? (d) => d[field] === value
          : () => {
              throw new Error(`FakeFirestore: unsupported operator ${op}`);
            };
    return new FakeQuery(this.fs, this.name, [...this.filters, match], this.order, this.max);
  }

  orderBy(field: string, dir: "asc" | "desc" = "asc"): FakeQuery {
    return new FakeQuery(this.fs, this.name, this.filters, { field, dir }, this.max);
  }

  limit(n: number): FakeQuery {
    return new FakeQuery(this.fs, this.name, this.filters, this.order, n);
  }

  async get(): Promise<{ docs: Array<FakeSnapshot & { ref: FakeDocRef }> }> {
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
    return {
      docs: rows.map(([id, d]) => {
        const snap = new FakeSnapshot(id, d) as FakeSnapshot & { ref: FakeDocRef };
        snap.ref = new FakeDocRef(this.fs, this.name, id);
        return snap;
      }),
    };
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

  set(ref: FakeDocRef, data: Data): void {
    this.writes.push(() => this.fs.bucket(ref.collectionName).set(ref.id, { ...data }));
  }

  delete(ref: FakeDocRef): void {
    this.writes.push(() => this.fs.bucket(ref.collectionName).delete(ref.id));
  }

  commit(): void {
    for (const write of this.writes) write();
  }
}
