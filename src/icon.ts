import type { IncomingMessage, ServerResponse } from "node:http";

/**
 * Nexus MCP 内置品牌图标（SVG / PNG / ICO）。
 * 纯常量零磁盘依赖，单文件 SEA 打包与本地/隧道模式均可直接返回。
 */
export const ICON_SVG = [
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64" width="64" height="64">',
  "<defs>",
  '<linearGradient id="bg" x1="0" y1="0" x2="0" y2="1">',
  '<stop offset="0%" stop-color="#2563eb"/>',
  '<stop offset="100%" stop-color="#4f46e5"/>',
  "</linearGradient>",
  "</defs>",
  '<rect width="64" height="64" rx="14" fill="url(#bg)"/>',
  '<path d="M18 46V18L46 46V18" fill="none" stroke="#ffffff" stroke-width="7" stroke-linecap="round" stroke-linejoin="round"/>',
  '<circle cx="18" cy="46" r="5.5" fill="#ffffff"/>',
  '<circle cx="18" cy="18" r="5.5" fill="#ffffff"/>',
  '<circle cx="46" cy="46" r="5.5" fill="#ffffff"/>',
  '<circle cx="46" cy="18" r="5.5" fill="#7dd3fc"/>',
  "</svg>",
].join("");

export const ICON_SVG_BASE64 = Buffer.from(ICON_SVG, "utf8").toString("base64");
export const ICON_DATA_URI_SVG = `data:image/svg+xml;base64,${ICON_SVG_BASE64}`;

/** 64x64 抗锯齿 PNG（与 ICON_SVG 同款几何节点 N 图形） */
const ICON_PNG_BASE64 =
  "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";

/** 含 32x32 与 64x64 PNG 帧的标准 ICO，供浏览器与云端连接器抓取 /favicon.ico */
const ICON_ICO_BASE64 =
  "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";

export const ICON_PNG = Buffer.from(ICON_PNG_BASE64, "base64");
export const ICON_ICO = Buffer.from(ICON_ICO_BASE64, "base64");

/**
 * MCP initialize serverInfo.icons（SEP-973）：PNG 与 SVG 双格式兜底。
 * src 一律用可公网访问的 HTTPS URL，不内嵌 data URI——
 * Gemini 连接器对 serverInfo 解析严格，内嵌 base64 会让整个连接被拒（2026-11-26 实测）。
 */
export function serverIcons(baseUrl: string): Array<{ src: string; mimeType: string; sizes: string[] }> {
  const base = baseUrl.replace(/\/+$/, "");
  return [
    { src: `${base}/icon.png`, mimeType: "image/png", sizes: ["64x64"] },
    { src: `${base}/favicon.svg`, mimeType: "image/svg+xml", sizes: ["any"] },
  ];
}

const ICON_ROUTES: Record<string, { contentType: string; body: Buffer }> = {
  "/favicon.ico": { contentType: "image/x-icon", body: ICON_ICO },
  "/favicon.svg": { contentType: "image/svg+xml; charset=utf-8", body: Buffer.from(ICON_SVG, "utf8") },
  "/icon.png": { contentType: "image/png", body: ICON_PNG },
  "/apple-touch-icon.png": { contentType: "image/png", body: ICON_PNG },
};

/**
 * 免鉴权响应常见图标路径（GET / HEAD），不刷服务日志。
 * 云端连接器（如 Gemini）常向根域名的 /favicon.ico 抓取图标。
 */
export function handleIconRequest(req: IncomingMessage, res: ServerResponse, pathname: string): boolean {
  const asset = ICON_ROUTES[pathname];
  if (!asset) return false;
  const method = req.method ?? "GET";
  if (method !== "GET" && method !== "HEAD") {
    res.writeHead(405, { Allow: "GET, HEAD" });
    res.end();
    return true;
  }
  res.writeHead(200, {
    "Content-Type": asset.contentType,
    "Content-Length": String(asset.body.byteLength),
    "Cache-Control": "public, max-age=86400",
  });
  res.end(method === "HEAD" ? undefined : asset.body);
  return true;
}
