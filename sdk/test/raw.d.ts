// Vite's `?raw` imports (file contents as a string), used to check enums against the Solidity sources.
declare module "*?raw" {
  const content: string;
  export default content;
}
