import { randomUUID } from "node:crypto";
import {
  SceneObjectSchema,
  resolveImageAnchor,
  type Scene,
  type SceneObject,
} from "@vizli/shared";

export type ImageResult = {
  src: string;
  pageUrl: string;
  attribution?: string;
  license?: string;
};
export type ImageSearch = (
  query: string,
  signal: AbortSignal,
) => Promise<ImageResult | null>;
const plainText = (value: unknown, max = 2000) =>
  typeof value === "string"
    ? value
        .replace(/<[^>]*>/g, " ")
        .replace(
          /&(?:nbsp|amp|quot|lt|gt);/g,
          (entity) =>
            ({
              "&nbsp;": " ",
              "&amp;": "&",
              "&quot;": '"',
              "&lt;": "<",
              "&gt;": ">",
            })[entity] ?? " ",
        )
        .replace(/\s+/g, " ")
        .trim()
        .slice(0, max)
    : undefined;
const isCommonsImage = (value: unknown): value is string => {
  try {
    const url = new URL(String(value));
    return (
      url.protocol === "https:" &&
      ["upload.wikimedia.org", "thumb.wikimedia.org"].includes(url.hostname) &&
      !/\.svg(?:\/|$)/i.test(url.pathname)
    );
  } catch {
    return false;
  }
};
const isCommonsPage = (value: unknown): value is string => {
  try {
    const url = new URL(String(value));
    return (
      url.protocol === "https:" && url.hostname === "commons.wikimedia.org"
    );
  } catch {
    return false;
  }
};
/** Fixed provider endpoint; model and user supply query text only, never request URLs. */
export const searchCommonsImage: ImageSearch = async (query, signal) => {
  const search = query.trim().slice(0, 160).replace(/["|]/g, " ");
  const expanded = search.toLowerCase() === "apple" ? "apple fruit" : search;
  const endpoint = new URL("https://commons.wikimedia.org/w/api.php");
  endpoint.search = new URLSearchParams({
    action: "query",
    format: "json",
    generator: "search",
    gsrsearch: `${expanded} filetype:bitmap`,
    gsrnamespace: "6",
    gsrlimit: "4",
    prop: "imageinfo",
    iiprop: "url|extmetadata",
    iiurlwidth: "600",
    iiextmetadatafilter: "Artist|Credit|LicenseShortName|UsageTerms",
    origin: "*",
  }).toString();
  const response = await fetch(endpoint, {
    signal: AbortSignal.any([signal, AbortSignal.timeout(8000)]),
    headers: {
      "User-Agent": "Vizli/0.1 (presentation image retrieval)",
      Accept: "application/json",
    },
  });
  if (!response.ok)
    throw new Error(
      `Image search is unavailable (${response.status}). Try again.`,
    );
  const result = (await response.json()) as {
    error?: unknown;
    query?: {
      pages?: Record<
        string,
        {
          index?: number;
          imageinfo?: {
            url?: string;
            thumburl?: string;
            descriptionurl?: string;
            extmetadata?: Record<string, { value?: string }>;
          }[];
        }
      >;
    };
  };
  if (result.error)
    throw new Error("Image search could not complete this query.");
  const pages = Object.values(result.query?.pages ?? {}).sort(
    (a, b) => (a.index ?? Infinity) - (b.index ?? Infinity),
  );
  for (const page of pages) {
    const info = page.imageinfo?.[0];
    if (!info) continue;
    const src = isCommonsImage(info.thumburl) ? info.thumburl : info.url;
    if (!isCommonsImage(src) || !isCommonsPage(info.descriptionurl)) continue;
    const metadata = info.extmetadata;
    return {
      src,
      pageUrl: info.descriptionurl,
      attribution: plainText(
        metadata?.Artist?.value ?? metadata?.Credit?.value,
      ),
      license: plainText(
        metadata?.LicenseShortName?.value ?? metadata?.UsageTerms?.value,
        300,
      ),
    };
  }
  return null;
};
export async function createAnchoredImage(
  query: string,
  targetId: string,
  scene: Scene,
  signal: AbortSignal,
  search: ImageSearch = searchCommonsImage,
): Promise<SceneObject | null> {
  const result = await search(query, signal);
  if (!result) return null;
  const object: SceneObject = {
    id: `image-${randomUUID()}`,
    kind: "image",
    label: query.charAt(0).toUpperCase() + query.slice(1),
    x: 0,
    y: 0,
    width: 100,
    height: 100,
    src: result.src,
    anchor: { targetId, kind: "x-axis" },
    imageSource: {
      query,
      pageUrl: result.pageUrl,
      provider: "Wikimedia Commons",
      attribution: result.attribution,
      license: result.license,
    },
  };
  return SceneObjectSchema.parse(resolveImageAnchor(object, scene));
}
