// A fast, dependency-free reimplementation of makefun-site 1.0.0's build.
// Written from scratch against the reference's stated semantics (its README
// and code): same front matter, template dialect, Markdown subset, slug rule
// and report, byte for byte. Speed comes from fusing the Markdown lexer and
// renderer into one pass, rendering inline markup over index ranges instead
// of sliced substrings, escaping in whole chunks instead of per character,
// and rendering templates into a shared string array instead of repeated
// string concatenation.

export function run(input) {
  return build(input);
}

// ---------------------------------------------------------------- utilities

const byCodeUnits = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

function longDate(date) {
  const [y, m, d] = date.split('-');
  return `${Number(d)} ${MONTHS[Number(m) - 1]} ${y}`;
}

// --- HTML escaping ---------------------------------------------------------

const ESC_MAP = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
const ESC_TEST = /[&<>"']/;

/** Append `s` to `out` with & < > " ' escaped. Fast path when nothing needs it. */
function escAppend(out, s) {
  if (s.length === 0) return;
  if (!ESC_TEST.test(s)) {
    out.push(s);
    return;
  }
  let i = 0;
  const n = s.length;
  while (i < n) {
    let j = n;
    let k = s.indexOf('&', i);
    if (k !== -1 && k < j) j = k;
    k = s.indexOf('<', i);
    if (k !== -1 && k < j) j = k;
    k = s.indexOf('>', i);
    if (k !== -1 && k < j) j = k;
    k = s.indexOf('"', i);
    if (k !== -1 && k < j) j = k;
    k = s.indexOf("'", i);
    if (k !== -1 && k < j) j = k;
    if (j === n) {
      out.push(s.slice(i));
      break;
    }
    if (j > i) out.push(s.slice(i, j));
    out.push(ESC_MAP[s[j]]);
    i = j + 1;
  }
}

// --- slugs -----------------------------------------------------------------

const SLUG_MAX = 64;

/** The slug rule applied to already-normalised text (marks already dropped). */
function slugFromPlain(plain) {
  let out = '';
  let gap = false;
  for (let i = 0; i < plain.length; i++) {
    const ch = plain[i];
    let keep = null;
    if (ch >= 'A' && ch <= 'Z') keep = ch.toLowerCase();
    else if ((ch >= 'a' && ch <= 'z') || (ch >= '0' && ch <= '9')) keep = ch;
    if (keep === null) {
      gap = out.length > 0;
      continue;
    }
    if (gap) out += '-';
    gap = false;
    out += keep;
  }
  out = out.slice(0, SLUG_MAX).replace(/-+$/, '');
  return out === '' ? 'untitled' : out;
}

const MARK = /\p{M}/gu;

/** The slug of `text`: NFKD, combining marks dropped, A-Z lowered, runs of
 *  other characters one "-", at most 64 chars, "untitled" when empty.
 *  Pure ASCII text is already NFKD-normal and mark-free, so it skips both. */
function slugify(text) {
  let ascii = true;
  for (let i = 0; i < text.length; i++) {
    if (text.charCodeAt(i) > 127) {
      ascii = false;
      break;
    }
  }
  if (ascii) return slugFromPlain(text);
  return slugFromPlain(text.normalize('NFKD').replace(MARK, ''));
}

/** `slug` made unique against `taken` (and added to it). */
function uniqueSlug(slug, taken) {
  let out = slug;
  for (let n = 2; taken.has(out); n++) out = `${slug}-${n}`;
  taken.add(out);
  return out;
}

// --- whitespace / words ----------------------------------------------------

/** Whether a UTF-16 code unit is JavaScript whitespace (\s). */
function isWS(c) {
  return (
    c === 32 ||
    (c >= 9 && c <= 13) ||
    c === 0xa0 ||
    c === 0x1680 ||
    (c >= 0x2000 && c <= 0x200a) ||
    c === 0x2028 ||
    c === 0x2029 ||
    c === 0x202f ||
    c === 0x205f ||
    c === 0x3000 ||
    c === 0xfeff
  );
}

function hasWS(s) {
  for (let i = 0; i < s.length; i++) if (isWS(s.charCodeAt(i))) return true;
  return false;
}

/** The words of a body: its runs of characters other than whitespace.
 *  Fast paths first: a space ends a word, ASCII printable is a word
 *  character, and only the rest needs the full whitespace test. */
function wordsOf(text) {
  let n = 0;
  let inWord = false;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    if (c === 32 || (c >= 9 && c <= 13)) inWord = false;
    else if (c < 127) {
      if (!inWord) {
        inWord = true;
        n++;
      }
    } else if (
      c === 0xa0 ||
      c === 0x1680 ||
      (c >= 0x2000 && c <= 0x200a) ||
      c === 0x2028 ||
      c === 0x2029 ||
      c === 0x202f ||
      c === 0x205f ||
      c === 0x3000 ||
      c === 0xfeff
    )
      inWord = false;
    else if (!inWord) {
      inWord = true;
      n++;
    }
  }
  return n;
}

// --- small line helpers ----------------------------------------------------

function isBlank(line) {
  for (let i = 0; i < line.length; i++) {
    const c = line.charCodeAt(i);
    if (c !== 32 && c !== 9) return false;
  }
  return true;
}

/** A line with spaces and tabs dropped at either end. */
function trimST(line) {
  let a = 0;
  let b = line.length;
  while (a < b && (line.charCodeAt(a) === 32 || line.charCodeAt(a) === 9)) a++;
  while (b > a && (line.charCodeAt(b - 1) === 32 || line.charCodeAt(b - 1) === 9)) b--;
  return a === 0 && b === line.length ? line : line.slice(a, b);
}

/** A value with trailing spaces and tabs dropped (leading ones are kept). */
function rstripST(s) {
  let b = s.length;
  while (b > 0 && (s.charCodeAt(b - 1) === 32 || s.charCodeAt(b - 1) === 9)) b--;
  return b === s.length ? s : s.slice(0, b);
}

const dirOf = (path) => (path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '');

/** `rel` from the directory `dir`, or null when it climbs out of the root. */
function resolvePath(dir, rel) {
  const parts = dir === '' ? [] : dir.split('/');
  for (const seg of rel.split('/')) {
    if (seg === '' || seg === '.') continue;
    if (seg === '..') {
      if (parts.length === 0) return null;
      parts.pop();
    } else parts.push(seg);
  }
  return parts.join('/');
}

// ---------------------------------------------------------------- front matter

const KEYS = new Set(['title', 'date', 'tags', 'draft', 'layout', 'slug', 'summary']);
const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
const NAME_RE = /^[a-z0-9-]+$/;
const SLUG_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const TAG_RE = /^[^"[\]]+$/;

function daysIn(y, m) {
  if (m === 2) return (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0 ? 29 : 28;
  return m === 4 || m === 6 || m === 9 || m === 11 ? 30 : 31;
}

/** A string value: "..." with \" and \\ its only escapes, or bare. */
function stringOf(raw) {
  if (raw.charCodeAt(0) === 34) {
    if (raw.length < 2 || raw.charCodeAt(raw.length - 1) !== 34) return { error: 'a quoted string is not closed' };
    let out = '';
    for (let i = 1; i < raw.length - 1; i++) {
      const c = raw[i];
      if (c === '\\') {
        const n = raw[i + 1];
        if ((n !== '"' && n !== '\\') || i + 1 === raw.length - 1)
          return { error: 'a quoted string holds an escape other than \\" or \\\\' };
        out += n;
        i++;
      } else if (c === '"') return { error: 'a quoted string holds a stray quote' };
      else out += c;
    }
    return { value: out };
  }
  if (raw.charCodeAt(0) === 91) return { error: 'a bare string opens on [' };
  return { value: raw };
}

/** One key's value, or why it is refused. */
function valueOf(key, raw) {
  switch (key) {
    case 'title':
    case 'summary': {
      const s = stringOf(raw);
      return 'error' in s ? { error: `key "${key}": ${s.error}` } : s;
    }
    case 'date': {
      const m = DATE_RE.exec(raw);
      const y = m ? Number(m[1]) : 0;
      const mo = m ? Number(m[2]) : 0;
      const d = m ? Number(m[3]) : 0;
      if (!m || y < 1970 || y > 2099 || mo < 1 || mo > 12 || d < 1 || d > daysIn(y, mo))
        return { error: 'key "date": not a date from 1970-01-01 to 2099-12-31 (YYYY-MM-DD)' };
      return { value: raw };
    }
    case 'tags': {
      if (!raw.startsWith('[') || !raw.endsWith(']')) return { error: 'key "tags": not a list [a, b]' };
      const inner = raw.slice(1, -1);
      if (inner.trim() === '') return { value: [] };
      const tags = inner.split(',').map((t) => t.trim());
      if (tags.some((t) => t === '' || !TAG_RE.test(t)))
        return { error: 'key "tags": an empty tag, or one holding " [ or ]' };
      return { value: tags };
    }
    case 'draft':
      return raw === 'true' ? { value: true } : raw === 'false' ? { value: false } : { error: 'key "draft": true or false' };
    case 'layout':
      return NAME_RE.test(raw) ? { value: raw } : { error: 'key "layout": not a template name' };
    case 'slug':
      return SLUG_RE.test(raw) && raw.length <= 64 ? { value: raw } : { error: 'key "slug": not a slug' };
    default:
      return { error: `unknown key "${key}"` };
  }
}

/**
 * A source's front matter and body: { data, body }, or { error }.
 * `text` has "\n" line ends. The closing `---` is found first, and only
 * then are the lines between it and the opening one validated.
 */
function parseFrontMatter(text) {
  const firstNl = text.indexOf('\n');
  const firstEnd = firstNl === -1 ? text.length : firstNl;
  if (text.slice(0, firstEnd) !== '---') return { error: 'no front matter' };
  // The closing `---` line, if any.
  let closeStart = -1;
  let bodyStart = text.length + 1;
  let cur = firstEnd + 1;
  while (cur <= text.length) {
    const eol = text.indexOf('\n', cur);
    const end = eol === -1 ? text.length : eol;
    if (text.slice(cur, end) === '---') {
      closeStart = cur;
      bodyStart = eol === -1 ? text.length + 1 : eol + 1;
      break;
    }
    if (eol === -1) break;
    cur = eol + 1;
  }
  if (closeStart === -1) return { error: 'the front matter is not closed' };
  const data = {};
  let lineStart = firstEnd + 1;
  let no = 1;
  while (lineStart < closeStart) {
    const eol = text.indexOf('\n', lineStart);
    const line = text.slice(lineStart, eol);
    no++;
    if (!isBlank(line) && line.charCodeAt(0) !== 35) {
      // "key: value": a key of a-z and _, a colon, one space and the value.
      let j = 0;
      while (j < line.length) {
        const c = line.charCodeAt(j);
        if ((c >= 97 && c <= 122) || c === 95) j++;
        else break;
      }
      if (j === 0 || line.charCodeAt(j) !== 58) return { error: `line ${no} is not "key: value"` };
      const key = line.slice(0, j);
      let raw;
      if (j + 1 === line.length) raw = '';
      else if (line.charCodeAt(j + 1) === 32) raw = line.slice(j + 2);
      else return { error: `line ${no} is not "key: value"` };
      raw = rstripST(raw);
      if (!KEYS.has(key)) return { error: `unknown key "${key}"` };
      if (Object.hasOwn(data, key)) return { error: `key "${key}" is given twice` };
      if (raw === '') return { error: `key "${key}" has no value` };
      const v = valueOf(key, raw);
      if ('error' in v) return v;
      data[key] = v.value;
    }
    lineStart = eol + 1;
  }
  if (!Object.hasOwn(data, 'title')) return { error: 'no title' };
  return { data, body: text.slice(bodyStart) };
}

// ---------------------------------------------------------------- Markdown

/** The characters a backslash escapes. */
const ESCAPABLE = new Uint8Array(128);
for (const ch of '\\`*_[]()#+-.!>') ESCAPABLE[ch.charCodeAt(0)] = 1;

/** Whether `s[j]` is escaped: the backslashes directly before it, counted from `a`, are odd in number. */
function isEscaped(s, j, a) {
  let k = 0;
  for (let t = j - 1; t >= a && s[t] === '\\'; t--) k++;
  return (k & 1) === 1;
}

/** The first index from `from` where `s` holds `]` outside an escape, or -1. */
function findUnescapedBracket(s, from, end) {
  let j = s.indexOf(']', from);
  while (j !== -1 && j < end) {
    if (!isEscaped(s, j, from)) return j;
    j = s.indexOf(']', j + 1);
  }
  return -1;
}

/** The first index from `from` where `s` holds `**` outside an escape, or -1. */
function findUnescapedStrong(s, from, end) {
  let j = s.indexOf('**', from);
  while (j !== -1 && j + 1 < end) {
    if (!isEscaped(s, j, from)) return j;
    j = s.indexOf('**', j + 1);
  }
  return -1;
}

/** The first single * from `from` (one whose run is not **), outside an escape, or -1. */
function findSingleStar(s, from, end) {
  let j = s.indexOf('*', from);
  while (j !== -1 && j < end) {
    if (!isEscaped(s, j, from)) {
      if (j + 1 < end && s[j + 1] === '*') j = s.indexOf('*', j + 2);
      else return j;
    } else j = s.indexOf('*', j + 1);
  }
  return -1;
}

/** Every character inline rendering must stop at: a construct, or one to escape. */
const INLINE_RE = /[\\`*\[&<>"']/g;

/**
 * `s[a..b)` rendered inline into `out`; `env.link(target)` is a link's href.
 * One native scan finds each character that needs handling; the plain text
 * between two such characters holds none of them, so it is pushed as-is.
 */
function inlineRange(s, a, b, env, out) {
  let i = a;
  for (;;) {
    INLINE_RE.lastIndex = i;
    const m = INLINE_RE.exec(s);
    if (m === null || m.index >= b) break;
    const j = m.index;
    if (j > i) out.push(s.slice(i, j));
    const c = m[0];
    if (c === '\\') {
      const n = s[j + 1];
      if (j + 1 < b && n !== undefined && ESCAPABLE[n.charCodeAt(0)] === 1) {
        out.push(n);
        i = j + 2;
      } else {
        out.push('\\');
        i = j + 1;
      }
    } else if (c === '`') {
      const k = s.indexOf('`', j + 1);
      if (k !== -1 && k < b && k > j + 1) {
        out.push('<code>');
        escAppend(out, s.slice(j + 1, k));
        out.push('</code>');
        i = k + 1;
      } else {
        out.push('`');
        i = j + 1;
      }
    } else if (c === '*') {
      if (j + 1 < b && s[j + 1] === '*') {
        const k = findUnescapedStrong(s, j + 2, b);
        if (k !== -1 && k > j + 2) {
          out.push('<strong>');
          inlineRange(s, j + 2, k, env, out);
          out.push('</strong>');
          i = k + 2;
        } else {
          out.push('**');
          i = j + 2;
        }
      } else {
        const k = findSingleStar(s, j + 1, b);
        if (k !== -1 && k > j + 1) {
          out.push('<em>');
          inlineRange(s, j + 1, k, env, out);
          out.push('</em>');
          i = k + 1;
        } else {
          out.push('*');
          i = j + 1;
        }
      }
    } else if (c === '[') {
      const k = findUnescapedBracket(s, j + 1, b);
      let m2 = -1;
      if (k !== -1 && k + 1 < b && s[k + 1] === '(') m2 = s.indexOf(')', k + 2);
      if (m2 !== -1 && m2 < b) {
        const target = s.slice(k + 2, m2);
        if (target !== '' && !hasWS(target)) {
          out.push('<a href="');
          escAppend(out, env.link(target));
          out.push('">');
          inlineRange(s, j + 1, k, env, out);
          out.push('</a>');
          i = m2 + 1;
          continue;
        }
      }
      out.push('[');
      i = j + 1;
    } else {
      // One of & < > " ': write its entity.
      out.push(ESC_MAP[c]);
      i = j + 1;
    }
  }
  if (i < b) out.push(s.slice(i, b));
}

/** A fence's language, or null when `line` does not open one. */
function fenceOpen(line) {
  if (line.charCodeAt(0) !== 96 || line.charCodeAt(1) !== 96 || line.charCodeAt(2) !== 96) return null;
  let i = 3;
  while (i < line.length) {
    const c = line.charCodeAt(i);
    if ((c >= 65 && c <= 90) || (c >= 97 && c <= 122) || (c >= 48 && c <= 57) || c === 95 || c === 43 || c === 45) i++;
    else break;
  }
  for (let j = i; j < line.length; j++) {
    const c = line.charCodeAt(j);
    if (c !== 32 && c !== 9) return null;
  }
  return line.slice(3, i);
}

/** Whether `line` closes a fence. */
function isFenceClose(line) {
  if (line.charCodeAt(0) !== 96 || line.charCodeAt(1) !== 96 || line.charCodeAt(2) !== 96) return false;
  for (let i = 3; i < line.length; i++) {
    const c = line.charCodeAt(i);
    if (c !== 32 && c !== 9) return false;
  }
  return true;
}

/** A heading line's level and text span, or null. */
function headingOf(line) {
  let d = 0;
  while (d < line.length && line.charCodeAt(d) === 35) d++;
  if (d === 0 || d > 6) return null;
  if (d >= line.length || (line.charCodeAt(d) !== 32 && line.charCodeAt(d) !== 9)) return null;
  let s = d;
  while (s < line.length && (line.charCodeAt(s) === 32 || line.charCodeAt(s) === 9)) s++;
  let e = line.length;
  while (e > s && (line.charCodeAt(e - 1) === 32 || line.charCodeAt(e - 1) === 9)) e--;
  if (e === s) return null;
  return { depth: d, start: s, end: e };
}

/** Whether `line` is a thematic break. */
function isHr(line) {
  if (!line.startsWith('---') && !line.startsWith('***')) return false;
  for (let i = 3; i < line.length; i++) {
    const c = line.charCodeAt(i);
    if (c !== 32 && c !== 9) return false;
  }
  return true;
}

/** A bullet item's text, or null when `line` does not open one. */
function bulletOf(line) {
  const c = line.charCodeAt(0);
  if ((c === 45 || c === 42) && line.charCodeAt(1) === 32) return line.slice(2);
  return null;
}

/** An ordered item's start and text, or null when `line` does not open one. */
function orderedOf(line) {
  let d = 0;
  while (d < line.length && d < 9 && line.charCodeAt(d) >= 48 && line.charCodeAt(d) <= 57) d++;
  if (d === 0) return null;
  if (d === 9 && line.length > 9 && line.charCodeAt(9) >= 48 && line.charCodeAt(9) <= 57) return null;
  if (line.charCodeAt(d) !== 46 || line.charCodeAt(d + 1) !== 32) return null;
  return { start: Number(line.slice(0, d)), text: line.slice(d + 2) };
}

/** Whether `line` continues a list item. */
function isContinued(line) {
  let s = 0;
  while (s < line.length && line.charCodeAt(s) === 32) s++;
  if (s < 2 || s >= line.length) return false;
  return !isWS(line.charCodeAt(s));
}

/**
 * `src` rendered: its HTML, its table of contents (level 2 and 3 headings)
 * and its excerpt (the first paragraph's inline HTML, or "").
 * Each line is classified once up front (blank / fence / heading / break);
 * a paragraph ends at any line that is not plain text.
 */
function renderMarkdown(src, env) {
  const lines = src.split('\n');
  const n = lines.length;
  // Line kinds: 0 plain, 1 blank, 2 fence open, 3 heading, 4 thematic break.
  // Routed on the first character: a fence, heading or break is anchored at
  // column 0, and a line opening on a space can only be blank.
  const kind = new Uint8Array(n);
  for (let i = 0; i < n; i++) {
    const line = lines[i];
    if (line === '') {
      kind[i] = 1;
      continue;
    }
    const c0 = line.charCodeAt(0);
    if (c0 === 32 || c0 === 9) {
      if (isBlank(line)) kind[i] = 1;
    } else if (c0 === 96) {
      if (fenceOpen(line) !== null) kind[i] = 2;
    } else if (c0 === 35) {
      if (headingOf(line) !== null) kind[i] = 3;
    } else if (c0 === 45 || c0 === 42) {
      if (isHr(line)) kind[i] = 4;
    }
  }
  const ids = new Set();
  const out = [];
  const toc = [];
  let excerpt = null;
  let i = 0;
  while (i < n) {
    const line = lines[i];
    const k = kind[i];
    if (k === 1) {
      i++;
      continue;
    }
    if (k === 2) {
      const lang = fenceOpen(line);
      out.push('<pre><code', lang === '' ? '' : ` class="language-${lang}"`, '>');
      i++;
      while (i < n && !isFenceClose(lines[i])) {
        escAppend(out, lines[i]);
        out.push('\n');
        i++;
      }
      i++;
      out.push('</code></pre>');
      out.push('\n');
      continue;
    }
    if (k === 3) {
      const h = headingOf(line);
      const id = uniqueSlug(slugify(line.slice(h.start, h.end)), ids);
      out.push(`<h${h.depth} id="${id}">`);
      const mark = out.length;
      inlineRange(line, h.start, h.end, env, out);
      if (h.depth === 2 || h.depth === 3) toc.push({ level: h.depth, id, html: out.slice(mark).join('') });
      out.push(`</h${h.depth}>`);
      out.push('\n');
      i++;
      continue;
    }
    if (k === 4) {
      out.push('<hr>');
      out.push('\n');
      i++;
      continue;
    }
    if (line.charCodeAt(0) === 62) {
      const kept = [];
      while (i < n && lines[i].charCodeAt(0) === 62) {
        let l = lines[i++];
        l = l.length > 1 && l.charCodeAt(1) === 32 ? l.slice(2) : l.slice(1);
        l = trimST(l);
        if (l !== '') kept.push(l);
      }
      if (kept.length === 0) {
        out.push('<blockquote>\n</blockquote>');
        out.push('\n');
      } else {
        const joined = kept.join('\n');
        out.push('<blockquote>\n<p>');
        inlineRange(joined, 0, joined.length, env, out);
        out.push('</p>\n</blockquote>');
        out.push('\n');
      }
      continue;
    }
    const bText = bulletOf(line);
    const o = bText === null ? orderedOf(line) : null;
    if (bText !== null || o !== null) {
      const isOrdered = o !== null;
      const items = [];
      while (i < n) {
        if (isOrdered) {
          const m = orderedOf(lines[i]);
          if (m !== null) {
            items.push([trimST(m.text)]);
            i++;
            continue;
          }
        } else {
          const m = bulletOf(lines[i]);
          if (m !== null) {
            items.push([trimST(m)]);
            i++;
            continue;
          }
        }
        if (isContinued(lines[i])) {
          items[items.length - 1].push(trimST(lines[i]));
          i++;
        } else break;
      }
      const tag = isOrdered ? 'ol' : 'ul';
      const open = isOrdered && o.start !== 1 ? `<ol start="${o.start}">` : `<${tag}>`;
      out.push(`${open}\n`);
      for (const partsArr of items) {
        const joined = partsArr.join('\n');
        out.push('<li>');
        inlineRange(joined, 0, joined.length, env, out);
        out.push('</li>\n');
      }
      out.push(`</${tag}>`);
      out.push('\n');
      continue;
    }
    const body = [trimST(line)];
    i++;
    while (i < n && kind[i] === 0) body.push(trimST(lines[i++]));
    const text = body.join('\n');
    out.push('<p>');
    const mark = out.length;
    inlineRange(text, 0, text.length, env, out);
    if (excerpt === null) excerpt = out.slice(mark).join('');
    out.push('</p>');
    out.push('\n');
  }
  return { html: out.join(''), toc, excerpt: excerpt ?? '' };
}

// ---------------------------------------------------------------- templates

const INCLUDE_DEPTH = 8;

class TemplateError extends Error {}

const PATH_RE = /^[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)*$/;
const FOR_RE = /^for ([A-Za-z_][A-Za-z0-9_]*) in (\S+)$/;
const IF_RE = /^if (not )?(\S+)$/;
const INCLUDE_RE = /^include "([a-z0-9-]+)"$/;

function pathOf(name, text) {
  if (!PATH_RE.test(text)) throw new TemplateError(`template "${name}": ${JSON.stringify(text)} is not a path`);
  return text.split('.');
}

/** `src`'s tokens: text, {{ }}, {{{ }}} and {% %}, a standalone tag's line taken with it. */
function tokenize(name, src) {
  const tokens = [];
  let text = '';
  let i = 0;
  while (i < src.length) {
    const open = src.indexOf('{', i);
    if (open === -1 || open === src.length - 1) {
      text += src.slice(i);
      break;
    }
    const next = src[open + 1];
    if (next !== '{' && next !== '%') {
      text += src.slice(i, open + 1);
      i = open + 1;
      continue;
    }
    text += src.slice(i, open);
    if (next === '{') {
      const raw = src[open + 2] === '{';
      const close = src.indexOf(raw ? '}}}' : '}}', open + (raw ? 3 : 2));
      if (close === -1) throw new TemplateError(`template "${name}": a ${raw ? '{{{' : '{{'} is not closed`);
      if (text !== '') tokens.push({ t: 'text', text });
      text = '';
      tokens.push({ t: raw ? 'raw' : 'var', path: pathOf(name, src.slice(open + (raw ? 3 : 2), close).trim()) });
      i = close + (raw ? 3 : 2);
      continue;
    }
    const close = src.indexOf('%}', open + 2);
    if (close === -1) throw new TemplateError(`template "${name}": a {% is not closed`);
    const end = close + 2;
    const lineStart = src.lastIndexOf('\n', open - 1) + 1;
    const nl = src.indexOf('\n', end);
    const lineEnd = nl === -1 ? src.length : nl;
    const standalone =
      /^[ \t]*$/.test(src.slice(lineStart, open)) && /^[ \t]*$/.test(src.slice(end, lineEnd));
    if (standalone) text = text.slice(0, text.length - (open - lineStart));
    if (text !== '') tokens.push({ t: 'text', text });
    text = '';
    tokens.push({ t: 'tag', tag: src.slice(open + 2, close).trim() });
    i = standalone ? (nl === -1 ? src.length : nl + 1) : end;
  }
  if (text !== '') tokens.push({ t: 'text', text });
  return tokens;
}

/** `src` parsed into its tree of nodes (a TemplateError when it does not parse). */
function parseTemplate(name, src) {
  const root = { kind: 'root', body: [] };
  const stack = [root];
  let body = root.body;
  for (const tok of tokenize(name, src)) {
    if (tok.t === 'text') body.push({ kind: 'text', text: tok.text });
    else if (tok.t === 'var' || tok.t === 'raw') body.push({ kind: tok.t, path: tok.path });
    else {
      const tag = tok.tag;
      const top = stack[stack.length - 1];
      let m;
      if ((m = FOR_RE.exec(tag)) !== null) {
        const node = { kind: 'for', name: m[1], path: pathOf(name, m[2]), body: [] };
        body.push(node);
        stack.push(node);
        body = node.body;
      } else if ((m = IF_RE.exec(tag)) !== null) {
        const node = { kind: 'if', not: m[1] !== undefined, path: pathOf(name, m[2]), then: [], else: null };
        body.push(node);
        stack.push(node);
        body = node.then;
      } else if (tag === 'else') {
        if (top.kind !== 'if' || top.else !== null)
          throw new TemplateError(`template "${name}": an else outside an if`);
        top.else = [];
        body = top.else;
      } else if (tag === 'endfor' || tag === 'endif') {
        if (top.kind !== (tag === 'endfor' ? 'for' : 'if'))
          throw new TemplateError(`template "${name}": an ${tag} with no open ${tag.slice(3)}`);
        stack.pop();
        const parent = stack[stack.length - 1];
        body = parent.kind === 'root' ? parent.body : parent.kind === 'for' ? parent.body : parent.else ?? parent.then;
      } else if ((m = INCLUDE_RE.exec(tag)) !== null) body.push({ kind: 'include', name: m[1] });
      else throw new TemplateError(`template "${name}": {% ${tag} %} is not a tag`);
    }
  }
  if (stack.length > 1)
    throw new TemplateError(`template "${name}": a ${stack[stack.length - 1].kind} is not closed`);
  return root.body;
}

/** The value at `path` in the scope chain. */
function lookup(scope, path) {
  let s = scope;
  while (s !== null && !Object.hasOwn(s.vars, path[0])) s = s.parent;
  if (s === null) return undefined;
  let v = s.vars[path[0]];
  for (let k = 1; k < path.length; k++) {
    if (v === null || typeof v !== 'object' || !Object.hasOwn(v, path[k])) return undefined;
    v = v[path[k]];
  }
  return v;
}

/** A value as text. */
function textOf(v) {
  if (typeof v === 'string') return v;
  if (typeof v === 'number') return String(v);
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  if (Array.isArray(v)) return v.map(textOf).join(', ');
  return '';
}

/** Whether a value counts as true in an if. */
function truthy(v) {
  if (Array.isArray(v)) return v.length > 0;
  return v !== undefined && v !== null && v !== false && v !== '' && v !== 0;
}

/** `nodes` rendered in `scope` into `out`. */
function renderNodes(nodes, scope, ctx, depth, out) {
  for (let n = 0; n < nodes.length; n++) {
    const node = nodes[n];
    switch (node.kind) {
      case 'text':
        out.push(node.text);
        break;
      case 'var':
        escAppend(out, textOf(lookup(scope, node.path)));
        break;
      case 'raw':
        out.push(textOf(lookup(scope, node.path)));
        break;
      case 'if': {
        const v = truthy(lookup(scope, node.path));
        const branch = v !== node.not ? node.then : node.else;
        if (branch !== null) renderNodes(branch, scope, ctx, depth, out);
        break;
      }
      case 'for': {
        const xs = lookup(scope, node.path);
        if (!Array.isArray(xs)) break;
        const len = xs.length;
        // One scope for the whole loop, its bindings rewritten per element:
        // rendering is synchronous, so nothing outlives one iteration.
        const vars = {};
        const loop = { index: 0, first: false, last: false, length: len };
        const child = { vars, parent: scope };
        for (let k = 0; k < len; k++) {
          vars[node.name] = xs[k];
          vars.loop = loop;
          loop.index = k + 1;
          loop.first = k === 0;
          loop.last = k === len - 1;
          renderNodes(node.body, child, ctx, depth, out);
        }
        break;
      }
      case 'include': {
        const t = ctx.templates.get(node.name);
        if (t !== undefined && depth < INCLUDE_DEPTH) renderNodes(t, scope, ctx, depth + 1, out);
        break;
      }
    }
  }
}

// ---------------------------------------------------------------- the build

const REPORT_FILE = 'build-report.txt';
const RESERVED = ['posts', 'tags', 'page'];
const SCHEME_RE = /^[A-Za-z][A-Za-z0-9+.-]*:/;

/** One site's output tree: path -> text. */
function build(input) {
  const templates = new Map();
  const report = [];
  for (const name of Object.keys(input.templates).sort(byCodeUnits)) {
    try {
      templates.set(name, parseTemplate(name, input.templates[name]));
    } catch (err) {
      if (!(err instanceof TemplateError)) throw err;
      report.push(err.message);
    }
  }

  const base = input.site.base_url.replace(/\/+$/, '');

  // 1. Sources, in code-unit order of their paths; a source that is not .md is static.
  const files = [...input.files].sort((x, y) => byCodeUnits(x.path, y.path));
  const sources = [];
  const statics = [];
  for (const f of files) {
    if (f.path.endsWith('.md'))
      sources.push({ path: f.path, text: f.content.includes('\r') ? f.content.replace(/\r\n?/g, '\n') : f.content });
    else statics.push({ path: f.path, content: f.content });
  }

  // 2. Front matter: a refused source is reported and dropped, and so is a draft.
  const kept = [];
  for (const s of sources) {
    const fm = parseFrontMatter(s.text);
    if ('error' in fm) {
      report.push(`refused ${s.path}: ${fm.error}`);
      continue;
    }
    s.data = fm.data;
    s.body = fm.body;
    s.post = s.path.startsWith('posts/');
    let own;
    for (const d of RESERVED) {
      if (d !== 'posts' && s.path.startsWith(`${d}/`)) {
        own = d;
        break;
      }
    }
    if (own !== undefined) {
      report.push(`refused ${s.path}: ${own}/ is the generator's own`);
      continue;
    }
    if (s.post && !Object.hasOwn(s.data, 'date')) {
      report.push(`refused ${s.path}: a post needs a date`);
      continue;
    }
    const layout = s.data.layout ?? (s.post ? 'post' : 'page');
    if (!templates.has(layout)) {
      report.push(`refused ${s.path}: layout "${layout}" is no template that parses`);
      continue;
    }
    s.layout = layout;
    if (s.data.draft === true) {
      report.push(`draft ${s.path}`);
      continue;
    }
    kept.push(s);
  }

  // 3. Permalinks: each page's output directory and url.
  const taken = new Map();
  const takenIn = (dir) => {
    let set = taken.get(dir);
    if (set === undefined) {
      set = new Set(dir === '' ? RESERVED : []);
      taken.set(dir, set);
    }
    return set;
  };
  const bySource = new Map();
  for (const s of kept) {
    const dir = s.post ? 'posts' : dirOf(s.path);
    const slug = uniqueSlug(s.data.slug ?? slugify(s.data.title), takenIn(dir));
    s.slug = slug;
    s.outDir = dir === '' ? slug : `${dir}/${slug}`;
    s.url = `${base}/${s.outDir}/`;
    bySource.set(s.path, s);
  }

  // 4. Markdown, each body's links resolved.
  const staticPaths = new Set(statics.map((f) => f.path));
  const broken = new Set();
  for (const s of kept) {
    const dir = dirOf(s.path);
    const srcPath = s.path;
    const env = {
      link: (target) => {
        if (SCHEME_RE.test(target) || target.startsWith('/') || target.startsWith('#')) return target;
        const hash = target.indexOf('#');
        const rel = hash === -1 ? target : target.slice(0, hash);
        const frag = hash === -1 ? '' : target.slice(hash);
        const path = rel === '' ? null : resolvePath(dir, rel);
        if (path !== null) {
          const pg = bySource.get(path);
          if (pg !== undefined) return `${pg.url}${frag}`;
          if (staticPaths.has(path)) return `${base}/${path}${frag}`;
        }
        broken.add(`broken-link ${srcPath} -> ${target}`);
        return target;
      },
    };
    const md = renderMarkdown(s.body, env);
    s.html = md.html;
    s.toc = md.toc;
    s.excerpt = md.excerpt;
  }

  // 5. Collections: posts newest first, then by slug; newer/older neighbours.
  const posts = kept.filter((s) => s.post);
  posts.sort((x, y) => byCodeUnits(y.data.date, x.data.date) || byCodeUnits(x.slug, y.slug));
  posts.forEach((p, k) => {
    p.newer = k === 0 ? null : posts[k - 1];
    p.older = k === posts.length - 1 ? null : posts[k + 1];
  });

  // 6. Tags, grouped by slug, each named as first met in the posts' order.
  const bySlug = new Map();
  const ownTags = (s) => {
    const seen = new Set();
    const out = [];
    for (const name of s.data.tags ?? []) {
      const slug = slugify(name);
      if (!seen.has(slug)) {
        seen.add(slug);
        out.push(name);
      }
    }
    return out;
  };
  for (const p of posts) {
    p.tagRefs = [];
    for (const name of ownTags(p)) {
      const slug = slugify(name);
      let tag = bySlug.get(slug);
      if (tag === undefined) {
        tag = { name, slug, url: `${base}/tags/${slug}/`, posts: [] };
        bySlug.set(slug, tag);
      }
      tag.posts.push(p);
      p.tagRefs.push(tag);
    }
  }
  for (const s of kept) {
    if (s.post) continue;
    s.tagRefs = ownTags(s).map((name) => {
      const slug = slugify(name);
      return bySlug.get(slug) ?? { name, slug, url: '', posts: [] };
    });
  }
  const tags = [...bySlug.values()].sort((x, y) => y.posts.length - x.posts.length || byCodeUnits(x.slug, y.slug));

  // Cards and pages as templates read them.
  const cardOf = (s) => ({
    title: s.data.title,
    url: s.url,
    date: s.data.date ?? '',
    date_long: s.data.date === undefined ? '' : longDate(s.data.date),
    summary: s.data.summary ?? '',
    excerpt: s.excerpt,
    reading_minutes: Math.max(1, Math.ceil(wordsOf(s.body) / 200)),
    tags: s.tagRefs.map((t) => ({ name: t.name, slug: t.slug, url: t.url })),
  });
  for (const s of kept) s.card = cardOf(s);
  const cards = new Map(posts.map((p) => [p, p.card]));
  const linkOf = (s) =>
    s === null
      ? null
      : { title: s.data.title, url: s.url, date: s.data.date ?? '', date_long: s.data.date === undefined ? '' : longDate(s.data.date) };
  const pageOf = (s) => ({
    ...s.card,
    slug: s.slug,
    content: s.html,
    toc: s.toc.map((h) => ({ level: h.level, id: h.id, html: h.html })),
    newer: linkOf(s.newer ?? null),
    older: linkOf(s.older ?? null),
    is_post: s.post,
  });

  // 7. Layouts: every page, the index pages and the tag pages.
  const output = {};
  const site = { title: input.site.title, base_url: base };
  const allTags = tags.map((t) => ({ name: t.name, slug: t.slug, url: t.url, count: t.posts.length }));
  const recent = posts.slice(0, input.site.recent).map((p) => cards.get(p));
  const ctx = { templates };
  const render = (name, vars) => {
    const nodes = templates.get(name);
    if (nodes === undefined) return null;
    const out = [];
    renderNodes(nodes, { vars: { site, tags: allTags, recent, ...vars }, parent: null }, ctx, 0, out);
    return out.join('');
  };
  for (const s of kept) output[`${s.outDir}/index.html`] = render(s.layout, { page: pageOf(s) });
  const per = input.site.per_page;
  const pages = Math.max(1, Math.ceil(posts.length / per));
  const indexUrl = (k) => (k === 1 ? `${base}/` : `${base}/page/${k}/`);
  for (let k = 1; k <= pages; k++) {
    const html = render('index', {
      posts: posts.slice((k - 1) * per, k * per).map((p) => cards.get(p)),
      pager: {
        number: k,
        total: pages,
        url: indexUrl(k),
        newer_url: k === 1 ? '' : indexUrl(k - 1),
        older_url: k === pages ? '' : indexUrl(k + 1),
      },
    });
    if (html !== null) output[k === 1 ? 'index.html' : `page/${k}/index.html`] = html;
  }
  for (const t of tags) {
    const html = render('tag', {
      tag: { name: t.name, slug: t.slug, url: t.url, count: t.posts.length, posts: t.posts.map((p) => cards.get(p)) },
    });
    if (html !== null) output[`tags/${t.slug}/index.html`] = html;
  }
  const tagsHtml = render('tags', {});
  if (tagsHtml !== null) output['tags/index.html'] = tagsHtml;
  for (const f of statics) {
    if (Object.hasOwn(output, f.path)) report.push(`shadowed ${f.path}: a built page has its path`);
    else output[f.path] = f.content;
  }

  // 8. The report.
  const lines = [...report, ...broken].sort(byCodeUnits);
  const pageCount = kept.filter((s) => !s.post).length;
  lines.push(`built ${pageCount} pages, ${posts.length} posts, ${tags.length} tags and ${statics.length} static files`);
  output[REPORT_FILE] = `${lines.join('\n')}\n`;
  return output;
}
