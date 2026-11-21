/** postject 没带类型声明，只用到它的 inject 一个入口 */
declare module "postject" {
  export function inject(
    file: string,
    resourceName: string,
    resourceData: Buffer,
    options: Record<string, unknown>,
  ): Promise<void>;
}
