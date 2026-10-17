import { Marked } from "./vendor/marked.mjs";
import DOMPurify from "./vendor/purify.mjs";
import katex from "./vendor/katex.mjs";

const escape = (text) =>
  String(text).replace(
    /[&<>"']/g,
    (char) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        char
      ],
  );
const math = (source, displayMode) =>
  katex.renderToString(source, {
    displayMode,
    throwOnError: false,
    trust: false,
    strict: "ignore",
    maxExpand: 1000,
    maxSize: 20,
  });
const markdown = new Marked({ gfm: true, breaks: true });
markdown.use({
  renderer: { html: (token) => escape(token.text) },
  extensions: [
    {
      name: "displayMath",
      level: "block",
      start: (src) => src.search(/\$\$|\\\[/),
      tokenizer(src) {
        const match = /^(?:\$\$([\s\S]+?)\$\$|\\\[([\s\S]+?)\\\])(?:\n|$)/.exec(
          src,
        );
        if (match)
          return {
            type: "displayMath",
            raw: match[0],
            text: match[1] ?? match[2],
          };
      },
      renderer: (token) => math(token.text, true),
    },
    {
      name: "inlineMath",
      level: "inline",
      start: (src) => src.search(/\$|\\\(/),
      tokenizer(src) {
        const match =
          /^(?:\$([^\s$](?:[^$\n]*?[^\s$])?)\$(?!\d)|\\\(([^\n]+?)\\\))/.exec(
            src,
          );
        if (match)
          return {
            type: "inlineMath",
            raw: match[0],
            text: match[1] ?? match[2],
          };
      },
      renderer: (token) => math(token.text, false),
    },
  ],
});
const cache = new Map();
export function renderMarkdown(value) {
  const text = String(value ?? "").slice(0, 60000);
  if (cache.has(text)) return cache.get(text);
  const result = DOMPurify.sanitize(markdown.parse(text), {
    USE_PROFILES: { html: true, svg: true, mathMl: true },
    FORBID_TAGS: ["style", "form", "input", "button", "iframe"],
  });
  if (cache.size >= 80) cache.delete(cache.keys().next().value);
  cache.set(text, result);
  return result;
}
