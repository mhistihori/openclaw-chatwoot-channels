import { describe, expect, it } from "vitest";
import { looksLikeHostNotice } from "../src/dispatch.js";

describe("looksLikeHostNotice", () => {
  it.each([
    "⚠️ Couldn't sign in to the AI service. Sign in again under Models in the Control UI or run `openclaw configure`.",
    "  ⚠️ The AI service is busy.",
  ])("flags %s", (text) => {
    expect(looksLikeHostNotice(text)).toBe(true);
  });

  it.each(["Halo, ada yang bisa saya bantu?", "Pesanan Anda ⚠️ sedang dikirim", "", undefined])("lets %s through", (text) => {
    expect(looksLikeHostNotice(text)).toBe(false);
  });
});
