import assert from "node:assert/strict";
import { test } from "node:test";

import { analyzeItems, isEnabled } from "../services/newsAI.service.js";

test("without GEMINI_API_KEY the AI layer is inert", async () => {
  delete process.env.GEMINI_API_KEY;
  assert.equal(isEnabled(), false);
  const result = await analyzeItems([{ title: "Nvidia beats estimates", link: "https://x.test/1" }]);
  assert.equal(result.size, 0, "resolves to an empty Map with no network call and no throw");
});
