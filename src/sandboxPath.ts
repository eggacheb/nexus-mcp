import path from "node:path";

/**
 * 必填文件路径（read / write / edit）：仅拦截空串并转为绝对坐标；
 * 遵照 ADR-0001，沙箱边界的词法与真实路径双道校验统一由 Rust 执行层裁决。
 */
export function resolveRequiredFileTarget(
  root: string,
  filePath: string,
): { root: string; path: string } {
  if (!filePath || filePath.trim() === "") {
    throw new Error("path 不能为空");
  }
  return { root, path: path.resolve(root, filePath) };
}

/**
 * 可选目录参数（bash/job_start 的 cwd、glob/grep 的搜索起点 path）：
 * 未传或纯空白一律回退到沙箱根，非空转为绝对坐标交执行层双道验根。
 */
export function resolveOptionalDir(root: string, dirInput: string | undefined): string {
  const trimmed = dirInput?.trim();
  return trimmed ? path.resolve(root, trimmed) : root;
}

/** 相对根目录展示，便于把结果喂给模型时更短（Windows 兼容盘符大小写差异） */
export function displayPath(root: string, abs: string): string {
  let normalizedAbs = abs;
  if (
    process.platform === "win32" &&
    /^[A-Za-z]:/.test(root) &&
    /^[A-Za-z]:/.test(abs) &&
    root[0]!.toLowerCase() === abs[0]!.toLowerCase()
  ) {
    normalizedAbs = root[0]! + abs.slice(1);
  }
  const rel = path.relative(root, normalizedAbs);
  return rel === "" ? "." : rel.split(path.sep).join("/");
}
