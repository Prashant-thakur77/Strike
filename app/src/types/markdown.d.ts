/** Markdown files import as their text (a webpack asset/source rule in next.config.ts). */
declare module "*.md" {
  const text: string;
  export default text;
}
