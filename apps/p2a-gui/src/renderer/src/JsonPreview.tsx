import { ChevronDown, ChevronRight } from "lucide-react";
import {
  useEffect,
  useMemo,
  useState,
  type CSSProperties,
  type ReactNode,
} from "react";

type JsonValue =
  | null
  | boolean
  | number
  | string
  | JsonValue[]
  | { [key: string]: JsonValue };

export type JsonPreviewLabels = {
  toolbarLabel: string;
  treeLabel: string;
  expandAll: string;
  collapseAll: string;
  collapseDepth2: string;
  collapseDepth3: string;
  expandNode: string;
  collapseNode: string;
  invalidJson: string;
};

type JsonPreviewProps = {
  content: string;
  labels: JsonPreviewLabels;
};

type DepthStyle = CSSProperties & {
  "--json-depth": number;
};

const DEFAULT_COLLAPSE_DEPTH = 2;

export function JsonPreview({ content, labels }: JsonPreviewProps) {
  const parsed = useMemo(() => parseJson(content), [content]);
  const collapsiblePaths = useMemo(
    () => (parsed.ok ? collectCollapsiblePaths(parsed.value) : []),
    [parsed],
  );
  const initialCollapsedPaths = useMemo(
    () => collapsedPathsForDepth(collapsiblePaths, DEFAULT_COLLAPSE_DEPTH),
    [collapsiblePaths],
  );
  const [collapsedPaths, setCollapsedPaths] = useState<Set<string>>(initialCollapsedPaths);

  useEffect(() => {
    setCollapsedPaths(initialCollapsedPaths);
  }, [initialCollapsedPaths]);

  if (!parsed.ok) {
    return (
      <div className="json-preview">
        <div className="diagnostic diagnostic--error json-preview__diagnostic">
          <span>{labels.invalidJson}</span>
        </div>
        <pre className="json-preview__raw">{content}</pre>
      </div>
    );
  }

  function togglePath(path: string) {
    setCollapsedPaths((current) => {
      const next = new Set(current);
      if (next.has(path)) {
        next.delete(path);
      } else {
        next.add(path);
      }
      return next;
    });
  }

  return (
    <div className="json-preview">
      <div className="json-preview__toolbar" aria-label={labels.toolbarLabel}>
        <button type="button" onClick={() => setCollapsedPaths(new Set())}>
          {labels.expandAll}
        </button>
        <button type="button" onClick={() => setCollapsedPaths(new Set(collapsiblePaths))}>
          {labels.collapseAll}
        </button>
        <button
          type="button"
          onClick={() => setCollapsedPaths(collapsedPathsForDepth(collapsiblePaths, 2))}
        >
          {labels.collapseDepth2}
        </button>
        <button
          type="button"
          onClick={() => setCollapsedPaths(collapsedPathsForDepth(collapsiblePaths, 3))}
        >
          {labels.collapseDepth3}
        </button>
      </div>
      <div className="json-preview__tree" role="tree" aria-label={labels.treeLabel}>
        <JsonNode
          collapsedPaths={collapsedPaths}
          depth={0}
          labels={labels}
          path=""
          togglePath={togglePath}
          value={parsed.value}
        />
      </div>
    </div>
  );
}

export function parseJson(content: string): { ok: true; value: JsonValue } | { ok: false } {
  try {
    return { ok: true, value: JSON.parse(content) as JsonValue };
  } catch {
    return { ok: false };
  }
}

export function collapsedPathsForDepth(paths: string[], depth: number): Set<string> {
  return new Set(paths.filter((path) => jsonPathDepth(path) >= depth));
}

function JsonNode({
  collapsedPaths,
  depth,
  labels,
  name,
  path,
  togglePath,
  trailingComma = false,
  value,
}: {
  collapsedPaths: Set<string>;
  depth: number;
  labels: JsonPreviewLabels;
  name?: string;
  path: string;
  togglePath: (path: string) => void;
  trailingComma?: boolean;
  value: JsonValue;
}) {
  if (!isContainer(value)) {
    return (
      <JsonRow depth={depth}>
        <span className="json-preview__toggle-spacer" />
        {renderName(name)}
        {renderPrimitive(value)}
        {trailingComma && <span className="json-preview__punctuation">,</span>}
      </JsonRow>
    );
  }

  const entries = containerEntries(value);
  const isCollapsed = collapsedPaths.has(path);
  const isArray = Array.isArray(value);
  const opening = isArray ? "[" : "{";
  const closing = isArray ? "]" : "}";

  if (isCollapsed) {
    return (
      <JsonRow ariaExpanded={false} depth={depth} role="treeitem">
        <JsonToggle
          isCollapsed={isCollapsed}
          labels={labels}
          onClick={() => togglePath(path)}
        />
        {renderName(name)}
        <span className="json-preview__punctuation">{opening}</span>
        <span className="json-preview__summary">{containerSummary(value)}</span>
        <span className="json-preview__punctuation">{closing}</span>
        {trailingComma && <span className="json-preview__punctuation">,</span>}
      </JsonRow>
    );
  }

  return (
    <>
      <JsonRow ariaExpanded depth={depth} role="treeitem">
        <JsonToggle
          isCollapsed={isCollapsed}
          labels={labels}
          onClick={() => togglePath(path)}
        />
        {renderName(name)}
        <span className="json-preview__punctuation">{opening}</span>
        {entries.length === 0 && (
          <>
            <span className="json-preview__summary">{containerSummary(value)}</span>
            <span className="json-preview__punctuation">{closing}</span>
            {trailingComma && <span className="json-preview__punctuation">,</span>}
          </>
        )}
      </JsonRow>
      {entries.length > 0 && (
        <>
          {entries.map(([entryName, entryValue], index) => (
            <JsonNode
              collapsedPaths={collapsedPaths}
              depth={depth + 1}
              key={`${path}/${escapePathPart(entryName)}`}
              labels={labels}
              name={entryName}
              path={`${path}/${escapePathPart(entryName)}`}
              togglePath={togglePath}
              trailingComma={index < entries.length - 1}
              value={entryValue}
            />
          ))}
          <JsonRow depth={depth}>
            <span className="json-preview__toggle-spacer" />
            <span className="json-preview__punctuation">{closing}</span>
            {trailingComma && <span className="json-preview__punctuation">,</span>}
          </JsonRow>
        </>
      )}
    </>
  );
}

function JsonRow({
  ariaExpanded,
  children,
  depth,
  role,
}: {
  ariaExpanded?: boolean;
  children: ReactNode;
  depth: number;
  role?: "treeitem";
}) {
  return (
    <div
      aria-expanded={ariaExpanded}
      className="json-preview__row"
      role={role}
      style={{ "--json-depth": depth } as DepthStyle}
    >
      {children}
    </div>
  );
}

function JsonToggle({
  isCollapsed,
  labels,
  onClick,
}: {
  isCollapsed: boolean;
  labels: JsonPreviewLabels;
  onClick: () => void;
}) {
  const Icon = isCollapsed ? ChevronRight : ChevronDown;
  return (
    <button
      className="json-preview__toggle"
      type="button"
      onClick={onClick}
      aria-label={isCollapsed ? labels.expandNode : labels.collapseNode}
    >
      <Icon size={14} strokeWidth={1.8} aria-hidden="true" />
    </button>
  );
}

function renderName(name: string | undefined): ReactNode {
  if (typeof name !== "string") return null;
  if (/^\d+$/.test(name)) {
    return (
      <>
        <span className="json-preview__index">[{name}]</span>
        <span className="json-preview__punctuation">: </span>
      </>
    );
  }
  return (
    <>
      <span className="json-preview__key">{JSON.stringify(name)}</span>
      <span className="json-preview__punctuation">: </span>
    </>
  );
}

function renderPrimitive(value: JsonValue): ReactNode {
  if (typeof value === "string") {
    return <span className="json-preview__string">{JSON.stringify(value)}</span>;
  }
  if (typeof value === "number") {
    return <span className="json-preview__number">{String(value)}</span>;
  }
  if (typeof value === "boolean") {
    return <span className="json-preview__boolean">{String(value)}</span>;
  }
  return <span className="json-preview__null">null</span>;
}

function isContainer(value: JsonValue): value is JsonValue[] | { [key: string]: JsonValue } {
  return typeof value === "object" && value !== null;
}

function containerEntries(value: JsonValue[] | { [key: string]: JsonValue }): [string, JsonValue][] {
  if (Array.isArray(value)) {
    return value.map((item, index) => [String(index), item]);
  }
  return Object.entries(value);
}

function containerSummary(value: JsonValue[] | { [key: string]: JsonValue }): string {
  const count = Array.isArray(value) ? value.length : Object.keys(value).length;
  return Array.isArray(value) ? `Array(${count})` : `Object(${count})`;
}

function collectCollapsiblePaths(value: JsonValue, path = ""): string[] {
  if (!isContainer(value)) return [];

  const entries = containerEntries(value);
  const current = entries.length > 0 ? [path] : [];
  return [
    ...current,
    ...entries.flatMap(([name, child]) =>
      collectCollapsiblePaths(child, `${path}/${escapePathPart(name)}`),
    ),
  ];
}

function jsonPathDepth(path: string): number {
  return path === "" ? 0 : path.split("/").length - 1;
}

function escapePathPart(value: string): string {
  return value.replaceAll("~", "~0").replaceAll("/", "~1");
}
