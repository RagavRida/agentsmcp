import { describe, expect, it } from "vitest";
import { extractRecentLoopLessons } from "../../src/briefing/helpers";

describe("briefing helpers", () => {
  it("extracts lessons from the latest loop iteration", () => {
    const raw = `
## Loop Iteration 1
- Goal: improve parser
### Lessons Learned
- old lesson

## Loop Iteration 2
- Goal: fix edge cases
### Lessons Learned
- tighten COPY resolution
- none
`;
    const lessons = extractRecentLoopLessons(raw);
    expect(lessons).toEqual(["tighten COPY resolution"]);
  });

  it("returns empty array when no loop memory exists", () => {
    expect(extractRecentLoopLessons("")).toEqual([]);
  });
});
