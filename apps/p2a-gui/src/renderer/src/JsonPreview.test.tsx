import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { JsonPreview, collapsedPathsForDepth, parseJson, type JsonPreviewLabels } from "./JsonPreview";

const labels: JsonPreviewLabels = {
  toolbarLabel: "JSON viewer tools",
  treeLabel: "JSON tree",
  expandAll: "Expand all",
  collapseAll: "Collapse all",
  collapseDepth2: "Collapse depth 2",
  collapseDepth3: "Collapse depth 3",
  expandNode: "Expand node",
  collapseNode: "Collapse node",
  invalidJson: "JSON parse failed. Showing source.",
};

describe("JsonPreview", () => {
  it("renders JSON as a collapsible tree", () => {
    const html = renderToStaticMarkup(
      createElement(JsonPreview, {
        content: JSON.stringify({
          project: {
            id: "demo",
            tasks: [{ id: "TASK-001", ready: true }],
          },
        }),
        labels,
      }),
    );

    expect(html).toContain("Expand all");
    expect(html).toContain("Collapse depth 2");
    expect(html).toContain("&quot;project&quot;");
    expect(html).toContain("Array(1)");
    expect(html).not.toContain("TASK-001");
  });

  it("falls back to source text for invalid JSON", () => {
    const html = renderToStaticMarkup(
      createElement(JsonPreview, {
        content: "{ invalid",
        labels,
      }),
    );

    expect(html).toContain("JSON parse failed. Showing source.");
    expect(html).toContain("{ invalid");
  });

  it("parses JSON and derives depth-collapsed paths", () => {
    const parsed = parseJson('{"a":{"b":{"c":1}},"d":[{"e":2}]}');
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;

    const collapsed = collapsedPathsForDepth(["", "/a", "/a/b", "/d", "/d/0"], 2);

    expect(collapsed.has("")).toBe(false);
    expect(collapsed.has("/a")).toBe(false);
    expect(collapsed.has("/a/b")).toBe(true);
    expect(collapsed.has("/d/0")).toBe(true);
  });
});
