import type { MetadataRoute } from "next";
import { BRAND } from "@/lib/brand";

export default function manifest(): MetadataRoute.Manifest {
  return {
    name: BRAND.name,
    short_name: BRAND.name,
    description: BRAND.tagline,
    start_url: "/",
    display: "standalone",
    background_color: "#f5f6f8",
    theme_color: "#2f6fed",
    icons: [
      { src: "/icon.svg", sizes: "any", type: "image/svg+xml", purpose: "any" },
      { src: "/icon-maskable.svg", sizes: "any", type: "image/svg+xml", purpose: "maskable" },
    ],
    // Opening a PDF from the OS "Open with" menu lands on the tools page.
    file_handlers: [{ action: "/", accept: { "application/pdf": [".pdf"] } }],
  } as MetadataRoute.Manifest;
}
