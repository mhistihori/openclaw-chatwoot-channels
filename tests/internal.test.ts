import { describe, expect, it } from "vitest";
import { splitInternal } from "../src/internal.js";

const split = (text: string, open = false) => {
  const state = { open };
  return { ...splitInternal(text, state), state };
};

describe("splitInternal", () => {
  it("leaves a normal reply alone", () => {
    expect(split("Halo Kak, ada yang bisa dibantu?")).toMatchObject({ customer: "Halo Kak, ada yang bisa dibantu?", internal: [] });
  });

  it("moves an internal block out of the customer text", () => {
    const r = split("Pesanan Kakak sedang kami cek.\n\n[[INTERNAL]]Stok habis, hubungi gudang.[[/INTERNAL]]");
    expect(r.customer).toBe("Pesanan Kakak sedang kami cek.");
    expect(r.internal).toEqual(["Stok habis, hubungi gudang."]);
  });

  it("handles several blocks and keeps the text between them", () => {
    const r = split("A [[INTERNAL]]x[[/INTERNAL]] B [[INTERNAL]]y[[/INTERNAL]] C");
    expect(r.customer).toBe("A  B  C");
    expect(r.internal).toEqual(["x", "y"]);
  });

  it("is not case sensitive", () => {
    const r = split("Halo [[internal]]rahasia[[/Internal]]");
    expect(r.customer).toBe("Halo");
    expect(r.internal).toEqual(["rahasia"]);
  });

  it("keeps an unclosed block internal to the end, so a forgotten tag cannot leak", () => {
    const r = split("Halo Kak.\n[[INTERNAL]]laporan: harga modal 400rb, margin 30%");
    expect(r.customer).toBe("Halo Kak.");
    expect(r.internal).toEqual(["laporan: harga modal 400rb, margin 30%"]);
    expect(r.state.open).toBe(true);
  });

  it("continues a block that spans several reply payloads", () => {
    const state = { open: false };
    const a = splitInternal("Halo Kak. [[INTERNAL]]bagian satu", state);
    const b = splitInternal("bagian dua[[/INTERNAL]] Ada lagi?", state);
    expect(a.customer).toBe("Halo Kak.");
    expect(b.customer).toBe("Ada lagi?");
    expect([...a.internal, ...b.internal]).toEqual(["bagian satu", "bagian dua"]);
    expect(state.open).toBe(false);
  });

  it("removes a stray closing tag from the customer text", () => {
    expect(split("Halo [[/INTERNAL]] Kak").customer).toBe("Halo  Kak");
  });

  it("returns nothing for the customer when the whole reply is internal", () => {
    const r = split("[[INTERNAL]]hanya catatan[[/INTERNAL]]");
    expect(r.customer).toBe("");
    expect(r.internal).toEqual(["hanya catatan"]);
  });
});
