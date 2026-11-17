import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { config } from "./config.ts";
import { one } from "./db.ts";
import { files, isKey } from "./storage.ts";

/**
 * diagrams.file_path is either a bundled image under public/ ("diagrams/pickup.jpg")
 * or a storage key for an image an admin uploaded ("2026/11/<uuid>.jpg").
 */
export function diagramUrl(id: number | null, filePath: string | null): string | null {
  if (!id || !filePath) return null;
  if (filePath.startsWith("diagrams/")) return "/" + filePath;
  return `/api/diagrams/${id}/image`;
}

export async function readDiagram(filePath: string): Promise<{ data: Buffer; mime: string }> {
  const mime = filePath.endsWith(".png") ? "image/png" : "image/jpeg";
  if (filePath.startsWith("diagrams/") && /^diagrams\/[\w.-]+\.(jpg|png)$/.test(filePath)) {
    return { data: await readFile(join(config.publicDir, filePath)), mime };
  }
  if (isKey(filePath)) return { data: await files.read(filePath), mime };
  throw new Error(`Bad diagram path ${filePath}`);
}

export type DiagramKind = "truck" | "trailer";
export interface DiagramRow { id: number; name: string; file_path: string }

/** The diagram used when a truck has none set (the first one of that kind). */
export async function defaultDiagram(kind: DiagramKind): Promise<DiagramRow | undefined> {
  return one(`SELECT id, name, file_path FROM diagrams WHERE kind = $1 ORDER BY id LIMIT 1`, [kind]);
}

/** The first of `ids` that is a diagram of this kind, else the default one. */
export async function pickDiagram(ids: (number | null | undefined)[], kind: DiagramKind): Promise<DiagramRow | undefined> {
  for (const id of ids) {
    if (!id) continue;
    const d = await one<DiagramRow>(`SELECT id, name, file_path FROM diagrams WHERE id = $1 AND kind = $2`, [id, kind]);
    if (d) return d;
  }
  return defaultDiagram(kind);
}

/** True if `id` is a diagram of this kind (used to validate admin input). */
export async function isDiagramKind(id: number, kind: DiagramKind): Promise<boolean> {
  return !!(await one(`SELECT 1 FROM diagrams WHERE id = $1 AND kind = $2`, [id, kind]));
}
