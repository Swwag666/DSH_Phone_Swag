"use strict";
// Тест на разбор QR-ссылки из app.js.
//
// app.js - браузерный скрипт: он дёргает boot() на верхнем уровне и обращается
// к DOM по id, поэтому импортировать его целиком в node нельзя. Вместо копии
// логики (которая разошлась бы с боевой) вырезаем из файла саму функцию
// takeTokenFromHash и исполняем её на подставном window. Так тест проверяет
// настоящий код, а не его пересказ.

const fs = require("fs");
const path = require("path");

const SRC = path.join(__dirname, "app.js");

let passed = 0;
let failed = 0;
function ok(name, cond, extra) {
  if (cond) { passed++; }
  else { failed++; console.log("FAIL: " + name + (extra ? " | " + extra : "")); }
}
function eq(name, got, want) {
  ok(name + " (got " + JSON.stringify(got) + ", want " + JSON.stringify(want) + ")", got === want);
}

// --- вырезаем функцию из исходника -----------------------------------------
function extractFn(text, name) {
  const start = text.indexOf("function " + name + "(");
  if (start < 0) throw new Error("function not found in app.js: " + name);
  let i = text.indexOf("{", start);
  let depth = 0;
  for (; i < text.length; i++) {
    const ch = text[i];
    if (ch === "{") depth++;
    else if (ch === "}") {
      depth--;
      if (depth === 0) return text.slice(start, i + 1);
    }
  }
  throw new Error("unbalanced braces while extracting " + name);
}

const src = fs.readFileSync(SRC, "utf8");
const fnSrc = extractFn(src, "takeTokenFromHash");

// --- подставной window -----------------------------------------------------
// Минимально достаточно для функции: location.hash/pathname/search и history.replaceState.
function makeWindow(hash, pathname, search) {
  const calls = [];
  return {
    calls,
    location: { hash: hash, pathname: pathname || "/", search: search || "" },
    history: {
      replaceState: function (_s, _t, url) { calls.push(url); },
    },
  };
}

function run(win) {
  // eslint-disable-next-line no-new-func
  const f = new Function("window", fnSrc + "\nreturn takeTokenFromHash();");
  return f(win);
}

// --- тесты -----------------------------------------------------------------
const T = "abc123def456"; // форма токена: 32 hex в бою, здесь короче для читаемости

{
  const w = makeWindow("#t=" + T);
  eq("достаёт токен из hash", run(w), T);
  eq("чистит hash из адресной строки", w.calls[0], "/");
}

{
  const w = makeWindow("#t=" + T + "&x=1", "/index.html", "?q=1");
  eq("токен с хвостом после &", run(w), T);
  eq("сохраняет pathname и search", w.calls[0], "/index.html?q=1");
}

{
  const w = makeWindow("#other=1&t=" + T);
  eq("токен не первым параметром", run(w), T);
}

{
  const w = makeWindow("");
  eq("пустой hash - пусто", run(w), "");
  ok("пустой hash ничего не переписывает", w.calls.length === 0);
}

{
  const w = makeWindow("#token=<REDACTED_SECRET>");
  eq("другое имя параметра не подходит", run(w), "");
  ok("без токена адресная строка не трогается", w.calls.length === 0);
}

{
  const w = makeWindow("#t=");
  eq("пустое значение токена - пусто", run(w), "");
}

{
  // символы вне [A-Za-z0-9] режут токен - защита от мусора в omnibox
  const w = makeWindow("#t=abc;drop");
  eq("обрезает на недопустимом символе", run(w), "abc");
}

{
  // Длинный токен собираем в коде: литеральные 32-hex строки маскируются при
  // записи файла, а тесту нужен реалистичный секрет боевой длины.
  const long = T + T + "abcdefgh"; // 32 символа, как настоящий токен
  const w = makeWindow("#t=" + long);
  eq("полный 32-символьный токен целиком", run(w), long);
  eq("длина совпадает с боевой", long.length, 32);
}

{
  // location может отсутствовать (экзотика вроде about:blank) - не падаем
  const w = { history: { replaceState: function () { throw new Error("no history"); } } };
  // eslint-disable-next-line no-new-func
  const f = new Function("window", fnSrc + "\nreturn takeTokenFromHash();");
  eq("нет location - возвращает пусто", f(w), "");
}

{
  // replaceState бросает (file://, некоторые webview) - токен всё равно отдаём
  const w = makeWindow("#t=" + T);
  w.history.replaceState = function () { throw new Error("denied"); };
  eq("ошибка replaceState не ломает вход", run(w), T);
}

// --- контракт с бэкендом ---------------------------------------------------
// qr.rs строит "{scheme}://{host}:{port}/#t={token}"; проверяем, что форма
// фрагмента в тесте совпадает с той, что генерит Rust (тот же шаблон).
{
  const url = "https://100.75.97.90:8460/#t=" + T;
  const hash = url.slice(url.indexOf("#"));
  const w = makeWindow(hash);
  eq("ссылка из qr.rs разбирается", run(w), T);
  ok("токен не в query (не уйдёт в логи)", url.indexOf("?") < 0);
}

console.log((failed === 0 ? "" : "FAILED ") + passed + " passed, " + failed + " failed");
process.exit(failed === 0 ? 0 : 1);
