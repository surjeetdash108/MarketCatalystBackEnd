import { emailHash, normaliseEmail } from "./email-normalise";

describe("normaliseEmail (retention once-per-email)", () => {
  it.each([
    ["  Jane.Doe@Example.com ", "jane.doe@example.com"],
    ["jane+promo@example.com", "jane@example.com"],
    ["Jane.Doe+trading@gmail.com", "janedoe@gmail.com"],
    ["j.a.n.e.d.o.e@googlemail.com", "janedoe@gmail.com"],
    ["jane.doe@outlook.com", "jane.doe@outlook.com"],
  ])("%s → %s", (input, out) => {
    expect(normaliseEmail(input)).toBe(out);
  });
  it("hashes all spellings of one inbox to the same id, and different inboxes differently", () => {
    expect(emailHash("JaneDoe@gmail.com")).toBe(
      emailHash("jane.doe+x@googlemail.com"),
    );
    expect(emailHash("jane.doe@outlook.com")).not.toBe(
      emailHash("janedoe@outlook.com"),
    );
    expect(emailHash("a@example.com")).toMatch(/^[0-9a-f]{64}$/);
  });
});
