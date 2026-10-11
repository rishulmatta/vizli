import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { ProjectSchema, createDemoProject, type Project } from "@vizli/shared";
export class ProjectStore {
  constructor(private directory: string) {}
  private path(id: string) {
    if (!/^[a-zA-Z0-9_-]{1,120}$/.test(id))
      throw new Error("Invalid project ID");
    return join(this.directory, `${id}.json`);
  }
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
  async save(project: Project) {
    const valid = ProjectSchema.parse(project);
    const file = this.path(valid.id);
    await mkdir(this.directory, { recursive: true });
    const temporary = `${file}.${randomUUID()}.tmp`;
    await writeFile(temporary, JSON.stringify(valid, null, 2), { mode: 0o600 });
    await rename(temporary, file);
  }
}
