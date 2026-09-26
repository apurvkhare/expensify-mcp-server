/** Wrangler bundles *.html imports as text modules; this is the type of that import. */
declare module '*.html' {
  const html: string;
  export default html;
}
