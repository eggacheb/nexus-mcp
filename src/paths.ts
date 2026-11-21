import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * 是否跑在 SEA 单文件产物里。
 * 打包产物是 CJS，`require` 在作用域内；开发态是 ESM，`typeof require` 为 undefined。
 */
function detectSea(): boolean {
  try {
    if (typeof require !== "function") return false;
    const sea = require("node:sea") as { isSea?: () => boolean } | undefined;
    return sea?.isSea?.() === true;
  } catch {
    return false;
  }
}

/** 开发态的仓库根：dist/ 的上一级。CJS 产物里 import.meta 是空的，退回 exe 目录 */
function devRoot(): string {
  try {
    return path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  } catch {
    return path.dirname(process.execPath);
  }
}

export const isPackaged = detectSea();

/**
 * 程序根目录：打包后是 exe 所在目录（配置、执行器、workspace 都相对它），
 * 开发态是仓库根。
 */
export const appRoot = isPackaged ? path.dirname(process.execPath) : devRoot();
