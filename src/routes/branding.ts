import type { FastifyInstance } from "fastify";
import { requireRole } from "../auth.ts";
import { COLOR_RE, getBranding, logoVersion, publicBranding, saveBranding } from "../branding.ts";
import type { Branding } from "../branding.ts";
import { bad, notFound, obj, reqStr } from "../http.ts";
import { files, imageType, newKey } from "../storage.ts";

export default async function brandingRoutes(app: FastifyInstance) {
  // Public: the sign-in screen needs it before anyone is signed in.
  app.get("/branding", async () => publicBranding(await getBranding()));

  app.get("/branding/logo", async (req, reply) => {
    const b = await getBranding();
    if (!b.logo_key) throw notFound();
    const v = (req.query as { v?: string } | undefined)?.v;
    return reply
      .type(b.logo_key.endsWith(".png") ? "image/png" : "image/jpeg")
      .header("cache-control", v === logoVersion(b.logo_key) ? "public, max-age=31536000, immutable" : "no-cache")
      .send(files.stream(b.logo_key));
  });

  const admin = { preHandler: requireRole("admin") };

  app.put("/admin/branding", admin, async (req) => {
    const body = obj(req.body);
    const patch: Partial<Branding> = {};
    if (body.company_name !== undefined) patch.company_name = reqStr(body.company_name, "Company name", 60);
    if (body.app_name !== undefined) patch.app_name = reqStr(body.app_name, "App name", 40);
    if (body.color !== undefined) {
      const c = String(body.color).trim().toLowerCase();
      if (!COLOR_RE.test(c)) throw bad("Color must be a hex color like #2f6b3a.");
      patch.color = c;
    }
    return publicBranding(await saveBranding(patch, req.user!.id));
  });

  app.post("/admin/branding/logo", admin, async (req) => {
    const part = await req.file({ limits: { fileSize: 2 * 1024 * 1024, files: 1 } });
    if (!part) throw bad("No image was sent.");
    let data: Buffer;
    try {
      data = await part.toBuffer();
    } catch {
      throw bad("Logo must be under 2 MB.");
    }
    if (part.file.truncated) throw bad("Logo must be under 2 MB.");
    const type = imageType(data);
    if (!type) throw bad("Logo must be a PNG or JPEG image.");
    // Old logo files are kept (they're tiny), in line with "nothing is hard-deleted" (SPEC §4a).
    const key = newKey(type.ext);
    await files.put(key, data);
    let b: Branding;
    try {
      b = await saveBranding({ logo_key: key }, req.user!.id);
    } catch (e) {
      await files.remove(key).catch(() => {}); // never referenced, safe to drop
      throw e;
    }
    return publicBranding(b);
  });

  app.delete("/admin/branding/logo", admin, async (req) => publicBranding(await saveBranding({ logo_key: null }, req.user!.id)));
}
