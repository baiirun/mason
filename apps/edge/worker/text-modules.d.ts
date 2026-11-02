declare module "*.isolate.js" {
  const source: string;
  export default source;
}
declare module "*.tsx?raw" {
  const source: string;
  export default source;
}
declare module "*/generated/frame-sdk.js" {
  const source: string;
  export default source;
}
