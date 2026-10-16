import { chromePath } from "@/lib/server/chrome";
import { connection } from "next/server";
import { sofficePath } from "@/lib/server/office";

// Lets the UI say up front when a server tool can't run here.
export async function GET() {
  // Checked per request, not frozen at build time.
  await connection();
  return Response.json(
    { chrome: Boolean(chromePath()), libreoffice: Boolean(sofficePath()) },
    { headers: { "Cache-Control": "no-store" } },
  );
}
