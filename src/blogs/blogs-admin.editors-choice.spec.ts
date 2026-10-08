import { BadRequestException } from "@nestjs/common";
import { BlogsAdminService } from "./blogs-admin.service";
import type { FirebaseAdminService } from "../common/firebase-admin.provider";

// marked ships ESM only, which ts-jest's CommonJS runtime cannot load. These
// tests never render Markdown, so an identity stand-in is enough.
jest.mock("marked", () => ({ marked: { parse: (s: string) => s } }));

/**
 * Editor's choice: an `editorsChoice` flag on each post, at most one true.
 * Driven through the public update()/list() surface against an in-memory
 * Firestore stand-in that implements only what these paths touch.
 */

type Data = Record<string, unknown>;

function fakeFirestore(store: Map<string, Data>) {
  const docRef = (path: string) => ({
    path,
    id: path.split("/").pop()!,
    get: async () => ({
      exists: store.has(path),
      id: path.split("/").pop(),
      data: () => store.get(path),
    }),
    set: async (d: Data) => void store.set(path, d),
    update: async (d: Data) => {
      if (!store.has(path)) throw new Error(`NOT_FOUND: ${path}`);
      store.set(path, { ...store.get(path), ...d });
    },
    delete: async () => void store.delete(path),
  });
  type Ref = ReturnType<typeof docRef>;
  const docsOf = (name: string, keep: (v: Data) => boolean = () => true) =>
    [...store]
      .filter(([k, v]) => k.startsWith(`${name}/`) && keep(v))
      .map(([k, v]) => ({ id: k.slice(name.length + 1), ref: docRef(k), data: () => v }));
  return {
    collection: (name: string) => ({
      doc: (id: string) => docRef(`${name}/${id}`),
      get: async () => ({ docs: docsOf(name) }),
      where: (field: string, _op: "==", value: unknown) => ({
        get: async () => ({ docs: docsOf(name, (v) => v[field] === value) }),
      }),
    }),
    runTransaction: async (fn: (tx: unknown) => Promise<void>) =>
      fn({
        get: (q: { get: () => Promise<unknown> }) => q.get(),
        update: (ref: Ref, d: Data) => {
          if (!store.has(ref.path)) throw new Error(`NOT_FOUND: ${ref.path}`);
          store.set(ref.path, { ...store.get(ref.path), ...d });
        },
      }),
  };
}

function setup() {
  const store = new Map<string, Data>([
    ["posts/a", { title: "A", status: "published" }],
    ["posts/b", { title: "B", status: "published" }],
  ]);
  const firebase = {
    firestore: fakeFirestore(store),
    bucket: { deleteFiles: async () => undefined },
  } as unknown as FirebaseAdminService;
  return { store, svc: new BlogsAdminService(firebase) };
}

const chosen = async (svc: BlogsAdminService) =>
  (await svc.list()).filter((p) => p.editorsChoice).map((p) => p.id);

describe("BlogsAdminService — editor's choice", () => {
  it("posts without the flag are not featured", async () => {
    const { svc } = setup();
    expect(await chosen(svc)).toEqual([]);
  });

  it("marking a post unmarks the previous choice", async () => {
    const { svc, store } = setup();
    await svc.update("a", { editorsChoice: true });
    expect(await chosen(svc)).toEqual(["a"]);

    await svc.update("b", { editorsChoice: true });
    expect(await chosen(svc)).toEqual(["b"]);
    expect(store.get("posts/a")?.editorsChoice).toBe(false);
  });

  it("re-marking the holder keeps it featured", async () => {
    const { svc } = setup();
    await svc.update("a", { editorsChoice: true });
    await svc.update("a", { editorsChoice: true });
    expect(await chosen(svc)).toEqual(["a"]);
  });

  it("unmarking a post that does not hold the choice leaves it alone", async () => {
    const { svc } = setup();
    await svc.update("a", { editorsChoice: true });
    await svc.update("b", { editorsChoice: false });
    expect(await chosen(svc)).toEqual(["a"]);
  });

  it("unmarking the holder clears the choice", async () => {
    const { svc } = setup();
    await svc.update("a", { editorsChoice: true });
    await svc.update("a", { editorsChoice: false });
    expect(await chosen(svc)).toEqual([]);
  });

  it("an update without the field does not touch the flag", async () => {
    const { svc } = setup();
    await svc.update("a", { editorsChoice: true });
    await svc.update("a", { read: "4 min" });
    expect(await chosen(svc)).toEqual(["a"]);
  });

  it("deleting the holder leaves nothing featured", async () => {
    const { svc } = setup();
    await svc.update("a", { editorsChoice: true });
    await svc.remove("a");
    expect(await chosen(svc)).toEqual([]);
  });

  it("rejects a non-boolean value before writing anything", async () => {
    const { svc, store } = setup();
    await expect(svc.update("a", { editorsChoice: "yes" })).rejects.toBeInstanceOf(
      BadRequestException,
    );
    expect(store.get("posts/a")).not.toHaveProperty("editorsChoice");
  });
});
