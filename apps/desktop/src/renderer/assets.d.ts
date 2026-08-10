/**
 * The renderer imports its stylesheet so the bundler emits it alongside the
 * script. TypeScript only needs to know the import is legal; it has no type.
 */
declare module '*.css';
