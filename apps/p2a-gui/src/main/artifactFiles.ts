import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import type {
  ArtifactFileKind,
  ArtifactFileReadRequest,
  ArtifactFileReadResult,
} from "../shared/ipc";

const MAX_ARTIFACT_PREVIEW_BYTES = 1024 * 1024;

function inferArtifactKind(relativePath: string): ArtifactFileKind {
  const extension = path.extname(relativePath).toLowerCase();
  if (extension === ".json") return "json";
  if (extension === ".md" || extension === ".markdown") return "markdown";
  return "text";
}

function resolveProjectFile(projectRoot: string, relativePath: string): string {
  if (typeof projectRoot !== "string" || projectRoot.trim().length === 0) {
    throw new Error("artifact:readFile requires a project root");
  }
  if (typeof relativePath !== "string" || relativePath.trim().length === 0) {
    throw new Error("artifact:readFile requires a relative path");
  }
  if (path.isAbsolute(relativePath)) {
    throw new Error("artifact:readFile only accepts project-relative paths");
  }

  const normalizedRoot = path.resolve(projectRoot);
  const resolvedPath = path.resolve(normalizedRoot, relativePath);
  const rootBoundary = `${normalizedRoot}${path.sep}`;

  if (resolvedPath !== normalizedRoot && !resolvedPath.startsWith(rootBoundary)) {
    throw new Error("artifact:readFile path must stay inside the project root");
  }

  return resolvedPath;
}

export async function readArtifactFile(
  request: ArtifactFileReadRequest,
): Promise<ArtifactFileReadResult> {
  const relativePath = request.relativePath.split(path.sep).join("/");
  const filePath = resolveProjectFile(request.projectRoot, relativePath);
  const fileStat = await stat(filePath);

  if (!fileStat.isFile()) {
    throw new Error("artifact:readFile target is not a file");
  }
  if (fileStat.size > MAX_ARTIFACT_PREVIEW_BYTES) {
    throw new Error("artifact:readFile target is too large to preview");
  }

  return {
    relativePath,
    kind: inferArtifactKind(relativePath),
    content: await readFile(filePath, "utf8"),
    sizeBytes: fileStat.size,
    modifiedAt: fileStat.mtime.toISOString(),
  };
}
