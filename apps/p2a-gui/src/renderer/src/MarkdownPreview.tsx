import type { CSSProperties, ReactNode } from "react";

type TableAlignment = "left" | "center" | "right" | null;

type MarkdownListItem = {
  text: string;
  checked?: boolean;
};

export type MarkdownBlock =
  | { type: "heading"; depth: number; text: string }
  | { type: "paragraph"; text: string }
  | { type: "code"; language: string | null; value: string }
  | { type: "list"; ordered: boolean; items: MarkdownListItem[] }
  | { type: "quote"; blocks: MarkdownBlock[] }
  | { type: "table"; headers: string[]; alignments: TableAlignment[]; rows: string[][] }
  | { type: "rule" };

type MarkdownPreviewProps = {
  content: string;
};

const fencePattern = /^(`{3,}|~{3,})\s*([A-Za-z0-9_-]+)?/;

export function parseMarkdown(content: string): MarkdownBlock[] {
  const lines = content.replace(/\r\n?/g, "\n").split("\n");
  const blocks: MarkdownBlock[] = [];
  let index = 0;

  while (index < lines.length) {
    const line = lines[index] ?? "";

    if (line.trim().length === 0) {
      index += 1;
      continue;
    }

    const fenceMatch = line.match(fencePattern);
    if (fenceMatch) {
      const fence = fenceMatch[1] ?? "```";
      const marker = fence[0] ?? "`";
      const minLength = fence.length;
      const codeLines: string[] = [];
      index += 1;

      while (index < lines.length) {
        const candidate = lines[index] ?? "";
        if (isClosingFence(candidate, marker, minLength)) {
          index += 1;
          break;
        }
        codeLines.push(candidate);
        index += 1;
      }

      blocks.push({
        type: "code",
        language: fenceMatch[2] ?? null,
        value: codeLines.join("\n"),
      });
      continue;
    }

    const headingMatch = line.match(/^(#{1,6})\s+(.+)$/);
    if (headingMatch) {
      blocks.push({
        type: "heading",
        depth: headingMatch[1]?.length ?? 1,
        text: headingMatch[2]?.trim() ?? "",
      });
      index += 1;
      continue;
    }

    if (isRule(line)) {
      blocks.push({ type: "rule" });
      index += 1;
      continue;
    }

    if (isTableStart(lines, index)) {
      const headers = splitTableRow(lines[index] ?? "");
      const alignments = splitTableRow(lines[index + 1] ?? "").map(tableAlignment);
      const rows: string[][] = [];
      index += 2;

      while (index < lines.length) {
        const row = splitTableRow(lines[index] ?? "");
        if ((lines[index] ?? "").trim().length === 0 || row.length < 2) break;
        rows.push(normalizeTableRow(row, headers.length));
        index += 1;
      }

      blocks.push({
        type: "table",
        headers,
        alignments: normalizeAlignments(alignments, headers.length),
        rows,
      });
      continue;
    }

    if (isQuote(line)) {
      const quoteLines: string[] = [];
      while (index < lines.length && isQuote(lines[index] ?? "")) {
        quoteLines.push((lines[index] ?? "").replace(/^\s{0,3}>\s?/, ""));
        index += 1;
      }
      blocks.push({ type: "quote", blocks: parseMarkdown(quoteLines.join("\n")) });
      continue;
    }

    const listItem = parseListItem(line);
    if (listItem) {
      const ordered = listItem.ordered;
      const items: MarkdownListItem[] = [];

      while (index < lines.length) {
        const nextItem = parseListItem(lines[index] ?? "");
        if (!nextItem || nextItem.ordered !== ordered) break;
        items.push(parseTaskListItem(nextItem.text));
        index += 1;
      }

      blocks.push({ type: "list", ordered, items });
      continue;
    }

    const paragraphLines = [line.trim()];
    index += 1;
    while (
      index < lines.length &&
      (lines[index] ?? "").trim().length > 0 &&
      !isBlockStart(lines, index)
    ) {
      paragraphLines.push((lines[index] ?? "").trim());
      index += 1;
    }

    blocks.push({ type: "paragraph", text: paragraphLines.join(" ") });
  }

  return blocks;
}

export function MarkdownPreview({ content }: MarkdownPreviewProps) {
  return <div className="markdown-preview">{renderBlocks(parseMarkdown(content), "md")}</div>;
}

function renderBlocks(blocks: MarkdownBlock[], keyPrefix: string): ReactNode[] {
  return blocks.map((block, index) => renderBlock(block, `${keyPrefix}-${index}`));
}

function renderBlock(block: MarkdownBlock, key: string): ReactNode {
  if (block.type === "heading") {
    const HeadingTag = `h${Math.min(block.depth, 4)}` as "h1" | "h2" | "h3" | "h4";
    return <HeadingTag key={key}>{renderInline(block.text, key)}</HeadingTag>;
  }

  if (block.type === "paragraph") {
    return <p key={key}>{renderInline(block.text, key)}</p>;
  }

  if (block.type === "code") {
    return (
      <div className="markdown-preview__code" key={key}>
        {block.language && <span className="markdown-preview__code-language">{block.language}</span>}
        <pre>
          <code>{block.value}</code>
        </pre>
      </div>
    );
  }

  if (block.type === "list") {
    const ListTag = block.ordered ? "ol" : "ul";
    const hasTasks = block.items.some((item) => typeof item.checked === "boolean");
    return (
      <ListTag className={hasTasks ? "markdown-preview__task-list" : undefined} key={key}>
        {block.items.map((item, index) => (
          <li
            className={typeof item.checked === "boolean" ? "markdown-preview__task-item" : undefined}
            key={`${key}-item-${index}`}
          >
            {typeof item.checked === "boolean" && (
              <input checked={item.checked} disabled type="checkbox" />
            )}
            <span>{renderInline(item.text, `${key}-item-${index}`)}</span>
          </li>
        ))}
      </ListTag>
    );
  }

  if (block.type === "quote") {
    return <blockquote key={key}>{renderBlocks(block.blocks, `${key}-quote`)}</blockquote>;
  }

  if (block.type === "table") {
    return (
      <div className="markdown-preview__table-wrap" key={key}>
        <table>
          <thead>
            <tr>
              {block.headers.map((header, index) => (
                <th key={`${key}-head-${index}`} style={textAlignStyle(block.alignments[index])}>
                  {renderInline(header, `${key}-head-${index}`)}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {block.rows.map((row, rowIndex) => (
              <tr key={`${key}-row-${rowIndex}`}>
                {row.map((cell, cellIndex) => (
                  <td
                    key={`${key}-cell-${rowIndex}-${cellIndex}`}
                    style={textAlignStyle(block.alignments[cellIndex])}
                  >
                    {renderInline(cell, `${key}-cell-${rowIndex}-${cellIndex}`)}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    );
  }

  return <hr key={key} />;
}

function renderInline(text: string, keyPrefix: string): ReactNode[] {
  const nodes: ReactNode[] = [];
  let cursor = 0;
  let nodeIndex = 0;

  while (cursor < text.length) {
    const codeEnd = text.startsWith("`", cursor) ? text.indexOf("`", cursor + 1) : -1;
    if (codeEnd > cursor + 1) {
      nodes.push(<code key={`${keyPrefix}-inline-${nodeIndex}`}>{text.slice(cursor + 1, codeEnd)}</code>);
      nodeIndex += 1;
      cursor = codeEnd + 1;
      continue;
    }

    const image = parseImage(text, cursor);
    if (image) {
      nodes.push(
        <span className="markdown-preview__image-alt" key={`${keyPrefix}-inline-${nodeIndex}`}>
          {image.alt ? `[${image.alt}]` : "[image]"}
        </span>,
      );
      nodeIndex += 1;
      cursor = image.end;
      continue;
    }

    const link = parseLink(text, cursor);
    if (link) {
      const href = safeLinkHref(link.href);
      const children = renderInline(link.label, `${keyPrefix}-inline-${nodeIndex}`);
      nodes.push(
        href ? (
          <a href={href} key={`${keyPrefix}-inline-${nodeIndex}`} rel="noreferrer" target="_blank">
            {children}
          </a>
        ) : (
          <span className="markdown-preview__link-text" key={`${keyPrefix}-inline-${nodeIndex}`}>
            {children}
          </span>
        ),
      );
      nodeIndex += 1;
      cursor = link.end;
      continue;
    }

    const strongEnd = text.startsWith("**", cursor) ? text.indexOf("**", cursor + 2) : -1;
    if (strongEnd > cursor + 2) {
      nodes.push(
        <strong key={`${keyPrefix}-inline-${nodeIndex}`}>
          {renderInline(text.slice(cursor + 2, strongEnd), `${keyPrefix}-strong-${nodeIndex}`)}
        </strong>,
      );
      nodeIndex += 1;
      cursor = strongEnd + 2;
      continue;
    }

    const emphasisEnd =
      text.startsWith("*", cursor) && !text.startsWith("**", cursor)
        ? text.indexOf("*", cursor + 1)
        : -1;
    if (emphasisEnd > cursor + 1) {
      nodes.push(
        <em key={`${keyPrefix}-inline-${nodeIndex}`}>
          {renderInline(text.slice(cursor + 1, emphasisEnd), `${keyPrefix}-em-${nodeIndex}`)}
        </em>,
      );
      nodeIndex += 1;
      cursor = emphasisEnd + 1;
      continue;
    }

    const nextSpecial = nextInlineSpecial(text, cursor);
    const end = nextSpecial > cursor ? nextSpecial : cursor + 1;
    nodes.push(text.slice(cursor, end));
    cursor = end;
  }

  return nodes;
}

function isBlockStart(lines: string[], index: number): boolean {
  const line = lines[index] ?? "";
  return Boolean(
    line.match(fencePattern) ||
      line.match(/^(#{1,6})\s+(.+)$/) ||
      isRule(line) ||
      isTableStart(lines, index) ||
      isQuote(line) ||
      parseListItem(line),
  );
}

function isClosingFence(line: string, marker: string, minLength: number): boolean {
  const trimmed = line.trim();
  return trimmed.startsWith(marker.repeat(minLength));
}

function isRule(line: string): boolean {
  return /^\s{0,3}([-*_])(?:\s*\1){2,}\s*$/.test(line);
}

function isQuote(line: string): boolean {
  return /^\s{0,3}>\s?/.test(line);
}

function parseListItem(line: string): { ordered: boolean; text: string } | null {
  const ordered = line.match(/^\s{0,3}\d+[.)]\s+(.+)$/);
  if (ordered) return { ordered: true, text: ordered[1] ?? "" };

  const unordered = line.match(/^\s{0,3}[-*+]\s+(.+)$/);
  if (unordered) return { ordered: false, text: unordered[1] ?? "" };

  return null;
}

function parseTaskListItem(text: string): MarkdownListItem {
  const task = text.match(/^\[( |x|X)\]\s+(.+)$/);
  if (!task) return { text };
  return {
    text: task[2] ?? "",
    checked: (task[1] ?? "").toLowerCase() === "x",
  };
}

function isTableStart(lines: string[], index: number): boolean {
  const current = lines[index] ?? "";
  const next = lines[index + 1] ?? "";
  return splitTableRow(current).length > 1 && isTableDivider(next);
}

function splitTableRow(line: string): string[] {
  const trimmed = line.trim();
  if (!trimmed.includes("|")) return [];
  const withoutOuterPipes = trimmed.replace(/^\|/, "").replace(/\|$/, "");
  return withoutOuterPipes.split("|").map((cell) => cell.trim());
}

function isTableDivider(line: string): boolean {
  const cells = splitTableRow(line);
  return cells.length > 1 && cells.every((cell) => /^:?-{3,}:?$/.test(cell.replace(/\s+/g, "")));
}

function tableAlignment(cell: string): TableAlignment {
  const normalized = cell.replace(/\s+/g, "");
  const left = normalized.startsWith(":");
  const right = normalized.endsWith(":");
  if (left && right) return "center";
  if (right) return "right";
  if (left) return "left";
  return null;
}

function normalizeAlignments(alignments: TableAlignment[], length: number): TableAlignment[] {
  return Array.from({ length }, (_, index) => alignments[index] ?? null);
}

function normalizeTableRow(row: string[], length: number): string[] {
  return Array.from({ length }, (_, index) => row[index] ?? "");
}

function textAlignStyle(alignment: TableAlignment | undefined): CSSProperties | undefined {
  return alignment ? { textAlign: alignment } : undefined;
}

function parseImage(text: string, start: number): { alt: string; end: number } | null {
  if (!text.startsWith("![", start)) return null;
  const match = text.slice(start).match(/^!\[([^\]]*)\]\(([^)\s]+)(?:\s+"[^"]*")?\)/);
  if (!match) return null;
  return {
    alt: match[1] ?? "",
    end: start + match[0].length,
  };
}

function parseLink(text: string, start: number): { label: string; href: string; end: number } | null {
  if (!text.startsWith("[", start)) return null;
  const match = text.slice(start).match(/^\[([^\]]+)\]\(([^)\s]+)(?:\s+"[^"]*")?\)/);
  if (!match) return null;
  return {
    label: match[1] ?? "",
    href: match[2] ?? "",
    end: start + match[0].length,
  };
}

function safeLinkHref(value: string): string | null {
  const trimmed = value.trim();
  if (trimmed.startsWith("#")) return trimmed;

  try {
    const url = new URL(trimmed);
    return url.protocol === "http:" || url.protocol === "https:" || url.protocol === "mailto:"
      ? trimmed
      : null;
  } catch {
    return null;
  }
}

function nextInlineSpecial(text: string, start: number): number {
  const indexes = ["`", "!", "[", "*"]
    .map((marker) => text.indexOf(marker, start + 1))
    .filter((index) => index >= 0);
  return indexes.length > 0 ? Math.min(...indexes) : text.length;
}
