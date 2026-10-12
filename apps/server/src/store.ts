import { mkdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { ProjectSchema, createDemoProject, type Project } from "@vizli/shared";
const ID = /^[a-zA-Z0-9_-]{1,120}$/;
/**
 * File-backed project store. `<id>.json` is the plain, schema-valid project used by the HTTP API and exports.
 * `<id>.yjs` is the authoritative collaborative document (a full Yjs state update) once a room has written it.
 */
export class ProjectStore {
  constructor(private directory: string) {}
  private path(id: string, extension: "json" | "yjs" = "json") {
    if (!ID.test(id)) throw new Error("Invalid project ID");
    return join(this.directory, `${id}.${extension}`);
  }
  private async atomicWrite(file: string, data: string | Uint8Array) {
    await mkdir(this.directory, { recursive: true });
    const temporary = `${file}.${randomUUID()}.tmp`;
    await writeFile(temporary, data, { mode: 0o600 });
    await rename(temporary, file);
  }
  /** Plain project; the demo project stands in for a missing `default`. */
  async load(id: string): Promise<Project> {
    try {
      return ProjectSchema.parse(
        JSON.parse(await readFile(this.path(id), "utf8")),
      );
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ENOENT" && id === "default")
        return createDemoProject();
      throw e;
    }
  }
  /** Plain project or null when the file does not exist; invalid content still throws so the file is preserved. */
  async loadJson(id: string): Promise<Project | null> {
    try {
      return ProjectSchema.parse(
        JSON.parse(await readFile(this.path(id), "utf8")),
      );
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw e;
    }
  }
  async save(project: Project) {
    const valid = ProjectSchema.parse(project);
    await this.atomicWrite(
      this.path(valid.id),
      JSON.stringify(valid, null, 2),
    );
  }
  /** Full Yjs state update for the project, or null when no collaborative document has been written yet. */
  async loadUpdate(id: string): Promise<Uint8Array | null> {
    try {
      return new Uint8Array(await readFile(this.path(id, "yjs")));
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw e;
    }
  }
  async saveUpdate(id: string, update: Uint8Array) {
    await this.atomicWrite(this.path(id, "yjs"), update);
  }
  /** Which representation exists on disk; `yjs` wins when both do because it is the merge history. */
  async exists(id: string): Promise<"yjs" | "json" | null> {
    for (const extension of ["yjs", "json"] as const) {
      try {
        await stat(this.path(id, extension));
        return extension;
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
      }
    }
    return null;
  }
  /** True when the plain file is newer than the document, which means it was written outside a room. */
  async jsonNewerThanUpdate(id: string): Promise<boolean> {
    try {
      const [json, yjs] = await Promise.all([
        stat(this.path(id, "json")),
        stat(this.path(id, "yjs")),
      ]);
      return json.mtimeMs > yjs.mtimeMs + 1000;
    } catch {
      return false;
    }
  }
}
