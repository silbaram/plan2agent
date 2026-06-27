import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { MarkdownPreview, parseMarkdown } from "./MarkdownPreview";

describe("parseMarkdown", () => {
  it("parses common artifact markdown blocks", () => {
    const blocks = parseMarkdown(`# Status

Progress: \`ready\`

- Canonical file: \`status.md\`
- [x] Reviewed

| Gate | State |
| --- | --- |
| A | complete |

\`\`\`json
{"ok": true}
\`\`\`
`);

    expect(blocks.map((block) => block.type)).toEqual([
      "heading",
      "paragraph",
      "list",
      "table",
      "code",
    ]);
    expect(blocks[0]).toMatchObject({ type: "heading", depth: 1, text: "Status" });
    expect(blocks[2]).toMatchObject({
      type: "list",
      ordered: false,
      items: [{ text: "Canonical file: `status.md`" }, { text: "Reviewed", checked: true }],
    });
    expect(blocks[3]).toMatchObject({
      type: "table",
      headers: ["Gate", "State"],
      rows: [["A", "complete"]],
    });
    expect(blocks[4]).toMatchObject({
      type: "code",
      language: "json",
      value: "{\"ok\": true}",
    });
  });

  it("renders markdown as document markup instead of raw source", () => {
    const html = renderToStaticMarkup(
      createElement(MarkdownPreview, {
        content: "# Artifact status\n\n- `status.md` is ready",
      }),
    );

    expect(html).toContain("<h1>Artifact status</h1>");
    expect(html).toContain("<li><span><code>status.md</code> is ready</span></li>");
    expect(html).not.toContain("# Artifact status");
  });
});
