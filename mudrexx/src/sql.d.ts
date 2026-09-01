/** Vite `?raw` imports let tests load the migration SQL verbatim. */
declare module '*.sql?raw' {
  const content: string;
  export default content;
}
