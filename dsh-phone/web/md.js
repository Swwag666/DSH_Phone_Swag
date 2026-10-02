"use strict";
// Pure text-rendering helpers for the DSH Phone PWA: escaping + a small
// markdown subset (code fences, tables, lists, headings, quotes, links).
// No DOM, no state - the same file loads in the browser (plain <script>)
// and runs under `node test-md.js` (module.exports at the bottom).

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  }[c]));
}

function highlightCode(code) {
  let s = escapeHtml(String(code == null ? "" : code));
  s = s.replace(/((?:&quot;|")[^"\n]*(?:&quot;|"))/g, '<span class="tk-str">$1</span>');
  s = s.replace(/(\/\/[^\n]*)/g, '<span class="tk-com">$1</span>');
  s = s.replace(/(\/\*[\s\S]*?\*\/)/g, '<span class="tk-com">$1</span>');
  s = s.replace(/\b(\d+(?:\.\d+)?)\b/g, '<span class="tk-num">$1</span>');
  s = s.replace(/\b(fn|function|const|let|var|return|if|else|for|while|loop|match|import|from|export|async|await|def|class|new|try|catch|throw|use|pub|struct|impl|trait|self|Some|None|Ok|Err|true|false|null|undefined|typeof|static|mut|print)\b/g, '<span class="tk-kw">$1</span>');
  return s;
}

function renderCodeBlock(code, lang) {
  const label = escapeHtml(lang && lang.trim() || "code");
  return `<div class="codeblock"><div class="codehead"><span class="codelang">${label}</span><button class="copycode" type="button" onclick="copyCode(this)">копия</button></div><pre><code>${highlightCode(code)}</code></pre></div>`;
}

function renderInline(s) {
  // input assumed already HTML-escaped
  s = s.replace(/`([^`\n]+)`/g, '<code class="ci">$1</code>');
  s = s.replace(/\*\*([^*\n]+)\*\*/g, "<strong>$1</strong>");
  s = s.replace(/(^|[^*\w])\*([^*\n]+)\*/g, "$1<em>$2</em>");
  s = s.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (m, text, url) => {
    if (!/^(https?:|mailto:|#|\/)/i.test(url)) return text;
    return `<a href="${url}" target="_blank" rel="noopener noreferrer">${text}</a>`;
  });
  return s;
}

function renderTableHtml(rows) {
  const parse = (r) => r.trim().replace(/^\||\|$/g, "").split("|").map((c) => c.trim());
  const header = parse(rows[0]);
  const body = rows.slice(1).filter((r) => !/^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)+\|?\s*$/.test(r));
  let html = "<table><thead><tr>" + header.map((c) => "<th>" + renderInline(escapeHtml(c)) + "</th>").join("") + "</tr></thead><tbody>";
  for (const r of body) {
    const cells = parse(r);
    html += "<tr>" + header.map((_, i) => "<td>" + renderInline(escapeHtml(cells[i] || "")) + "</td>").join("") + "</tr>";
  }
  return html + "</tbody></table>";
}

function renderMarkdown(src) {
  const blocks = [];
  let input = String(src == null ? "" : src);
  input = input.replace(/```([^\n`]*)\n?([\s\S]*?)```/g, (m, lang, code) => {
    const i = blocks.length;
    blocks.push({ lang: lang.trim(), code });
    return "\u0000B" + i + "\u0000";
  });

  const lines = input.split("\n");
  const out = [];
  let inList = null;
  let tableRows = [];
  let para = [];

  const flushPara = () => { if (para.length) { out.push("<p>" + para.join("<br>") + "</p>"); para = []; } };
  const closeList = () => { if (inList) { out.push("</" + inList + ">"); inList = null; } };
  const flushTable = () => {
    if (tableRows.length >= 2) out.push(renderTableHtml(tableRows));
    else if (tableRows.length) out.push("<p>" + tableRows.map((r) => renderInline(escapeHtml(r))).join("<br>") + "</p>");
    tableRows = [];
  };

  for (const raw of lines) {
    const line = raw;
    if (/^\u0000B\d+\u0000$/.test(line)) { flushPara(); closeList(); flushTable(); out.push(line); continue; }
    if (/^\s*\|.*\|\s*$/.test(line)) { flushPara(); closeList(); tableRows.push(line); continue; }
    if (tableRows.length) flushTable();
    if (/^\s*$/.test(line)) { flushPara(); closeList(); continue; }
    let m = line.match(/^(#{1,4})\s+(.*)$/);
    if (m) {
      flushPara(); closeList();
      const lvl = Math.min(m[1].length + 1, 4);
      out.push("<h" + lvl + ">" + renderInline(escapeHtml(m[2])) + "</h" + lvl + ">");
      continue;
    }
    if (/^\s*(?:-{3,}|\*{3,}|_{3,})\s*$/.test(line)) { flushPara(); closeList(); out.push("<hr>"); continue; }
    if (/^>\s?/.test(line)) {
      flushPara(); closeList();
      out.push("<blockquote>" + renderInline(escapeHtml(line.replace(/^>\s?/, ""))) + "</blockquote>");
      continue;
    }
    m = line.match(/^\s*[-*+]\s+(.*)$/);
    if (m) {
      flushPara();
      if (inList !== "ul") { closeList(); out.push("<ul>"); inList = "ul"; }
      out.push("<li>" + renderInline(escapeHtml(m[1])) + "</li>");
      continue;
    }
    m = line.match(/^\s*\d+[.)]\s+(.*)$/);
    if (m) {
      flushPara();
      if (inList !== "ol") { closeList(); out.push("<ol>"); inList = "ol"; }
      out.push("<li>" + renderInline(escapeHtml(m[1])) + "</li>");
      continue;
    }
    closeList();
    para.push(renderInline(escapeHtml(line)));
  }
  flushPara(); closeList(); flushTable();

  let html = out.join("\n");
  html = html.replace(/\u0000B(\d+)\u0000/g, (m, i) => renderCodeBlock(blocks[+i].code, blocks[+i].lang));
  return html;
}

if (typeof module !== "undefined" && module.exports) {
  module.exports = { escapeHtml, highlightCode, renderCodeBlock, renderInline, renderTableHtml, renderMarkdown };
}
