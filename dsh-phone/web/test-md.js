"use strict";
// Escape/markdown tests for the PWA renderer: node test-md.js
const assert = require("node:assert");
const { escapeHtml, renderMarkdown, renderInline } = require("./md.js");

let n = 0;
function t(name, fn) {
  fn();
  n++;
  console.log("ok - " + name);
}

t("escapeHtml escapes all five", () => {
  assert.equal(
    escapeHtml(`<a href="x" class='y'>&`),
    "&lt;a href=&quot;x&quot; class=&#39;y&#39;&gt;&amp;"
  );
});

t("markdown body escapes tags", () => {
  const html = renderMarkdown("hello <script>alert(1)</script> world");
  assert.ok(!html.includes("<script"));
  assert.ok(html.includes("&lt;script&gt;"));
});

t("code fences escape content", () => {
  const html = renderMarkdown("```js\nif (x < 1) { evil(); }\n```");
  assert.ok(!html.includes("<code>if (x < 1)"));
  assert.ok(html.includes("x &lt;"));
});

t("javascript: links are neutralised", () => {
  const html = renderMarkdown("[click](javascript:alert(1))");
  assert.ok(!html.includes('href="javascript'));
  assert.ok(html.includes("click"));
});

t("data: links are neutralised", () => {
  const html = renderMarkdown("[x](data:text/html;base64,PHNjcmlwdD4=)");
  assert.ok(!html.includes("href=\"data:"));
});

t("https links render as anchors", () => {
  const html = renderMarkdown("[site](https://example.com/x)");
  assert.ok(html.includes('href="https://example.com/x"'));
  assert.ok(html.includes('rel="noopener noreferrer"'));
});

t("tables escape cells", () => {
  const html = renderMarkdown("| a | b |\n|---|---|\n| <img src=x> | 2 |");
  assert.ok(html.startsWith("<table>"));
  assert.ok(html.includes("&lt;img src=x&gt;"));
});

t("headings escape", () => {
  const html = renderMarkdown("# <b>title</b>");
  assert.ok(html.startsWith("<h2>"));
  assert.ok(html.includes("&lt;b&gt;title&lt;/b&gt;"));
});

t("inline formatting works", () => {
  const html = renderMarkdown("plain *em* **strong** `code`");
  assert.ok(html.includes("<em>em</em>"));
  assert.ok(html.includes("<strong>strong</strong>"));
  assert.ok(html.includes('<code class="ci">code</code>'));
});

t("blockquotes escape", () => {
  const html = renderMarkdown("> quoted <i>text</i>");
  assert.ok(html.startsWith("<blockquote>"));
  assert.ok(html.includes("&lt;i&gt;text&lt;/i&gt;"));
});

t("list items escape", () => {
  const html = renderMarkdown("- item <b>x</b>");
  assert.ok(html.includes("<li>item &lt;b&gt;x&lt;/b&gt;</li>"));
});

t("attribute breakout via markdown link text is escaped", () => {
  const html = renderMarkdown('[a"onmouseover="alert(1)](https://x.com)');
  assert.ok(!html.includes('"onmouseover='));
});

t("renderInline passes scheme filter", () => {
  const out = renderInline(escapeHtml("see [x](vbscript:whatever)"));
  assert.ok(!out.includes("vbscript:"));
});

console.log(`\n${n} tests passed`);
