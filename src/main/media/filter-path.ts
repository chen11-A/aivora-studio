/**
 * Ported from aijian-studio/packages/aivora-media/filter-path.mjs.
 * Escapes an unquoted AVOption value through both FFmpeg filter parsing layers.
 * Used strictly with execFile's -vf argument (never passed through a shell).
 */
export function escapeFilterPath(value: string): string {
  if (typeof value !== "string" || !value || /[\0\r\n]/.test(value)) {
    throw new Error("滤镜路径无效");
  }
  const option = value.replace(/[\\':\s]/gu, "\\$&");
  return option.replace(/[\\'[\],;\s]/gu, "\\$&");
}
