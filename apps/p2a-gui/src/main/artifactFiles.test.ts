import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { readArtifactFile } from "./artifactFiles";

describe("readArtifactFile", () => {
  it("reads a project-relative artifact file with metadata", async () => {
    const projectRoot = await mkdtemp(path.join(tmpdir(), "p2a-artifact-file-"));

    try {
      await mkdir(path.join(projectRoot, "gate-b-spec"), { recursive: true });
      await writeFile(
        path.join(projectRoot, "gate-b-spec/spec.json"),
        `${JSON.stringify({ schema_version: "p2a.spec.v1", project_id: "demo" })}\n`,
      );

      const result = await readArtifactFile({
        projectRoot,
        relativePath: "gate-b-spec/spec.json",
      });

      expect(result).toMatchObject({
        relativePath: "gate-b-spec/spec.json",
        kind: "json",
      });
      expect(result.sizeBytes).toBeGreaterThan(0);
      expect(JSON.parse(result.content)).toMatchObject({ project_id: "demo" });
    } finally {
      await rm(projectRoot, { recursive: true, force: true });
    }
  });

  it("rejects paths outside the project root", async () => {
    const projectRoot = await mkdtemp(path.join(tmpdir(), "p2a-artifact-file-"));

    try {
      await expect(
        readArtifactFile({
          projectRoot,
          relativePath: "../outside.json",
        }),
      ).rejects.toThrow("inside the project root");
    } finally {
      await rm(projectRoot, { recursive: true, force: true });
    }
  });
});
