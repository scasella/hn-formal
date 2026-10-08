// Runs inside the page via page.evaluate(source). Plain JS: no TS, no bundler transforms.
// Returns { checked, min, failures[] } for every visible text node.
(() => {
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = 1;
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  const cache = new Map();
  function parse(c) {
    const hit = cache.get(c);
    if (hit) return hit;
    let out;
    const m = c.match(/^rgba?\(\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)\s*(?:,\s*([\d.]+)\s*)?\)$/);
    if (m) out = [+m[1], +m[2], +m[3], m[4] === undefined ? 1 : +m[4]];
    else {
      ctx.clearRect(0, 0, 1, 1);
      ctx.fillStyle = c;
      ctx.fillRect(0, 0, 1, 1);
      const d = ctx.getImageData(0, 0, 1, 1).data;
      out = [d[0], d[1], d[2], d[3] / 255];
    }
    cache.set(c, out);
    return out;
  }
  function over(top, bottom) {
    const a = top[3] + bottom[3] * (1 - top[3]);
    if (a === 0) return [0, 0, 0, 0];
    const ch = (i) => (top[i] * top[3] + bottom[i] * bottom[3] * (1 - top[3])) / a;
    return [ch(0), ch(1), ch(2), a];
  }
  function lum(c) {
    const f = (v) => {
      const s = v / 255;
      return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
    };
    return 0.2126 * f(c[0]) + 0.7152 * f(c[1]) + 0.0722 * f(c[2]);
  }
  function ratio(a, b) {
    const la = lum(a);
    const lb = lum(b);
    return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
  }
  function selector(el) {
    const parts = [];
    let e = el;
    while (e && e !== document.body && parts.length < 5) {
      let s = e.tagName.toLowerCase();
      if (e.id) s += `#${e.id}`;
      else if (e.classList.length) s += "." + Array.from(e.classList).slice(0, 2).join(".");
      parts.unshift(s);
      e = e.parentElement;
    }
    return parts.join(" > ");
  }
  const SKIP = new Set(["SCRIPT", "STYLE", "NOSCRIPT", "TEMPLATE", "TITLE"]);
  const results = [];
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  let node;
  let checked = 0;
  while ((node = walker.nextNode())) {
    const text = (node.textContent ?? "").trim();
    if (!text) continue;
    const el = node.parentElement;
    if (!el || SKIP.has(el.tagName)) continue;
    const range = document.createRange();
    range.selectNodeContents(node);
    const rect = range.getBoundingClientRect();
    if (rect.width < 1 || rect.height < 1) continue;
    const cs = getComputedStyle(el);
    if (cs.visibility === "hidden" || cs.display === "none") continue;
    // Effective text color: alpha scaled by ancestor opacity.
    let opacity = 1;
    let unknownBg = false;
    const layers = [];
    for (let e = el; e; e = e.parentElement) {
      const s = e === el ? cs : getComputedStyle(e);
      opacity *= parseFloat(s.opacity || "1");
      const bg = parse(s.backgroundColor);
      if (s.backgroundImage && s.backgroundImage !== "none") unknownBg = true;
      layers.push(bg);
      if (bg[3] >= 1) break;
    }
    if (opacity === 0) continue;
    // Compose from the bottom-most opaque layer (or white) upwards.
    let bg = [255, 255, 255, 1];
    for (let i = layers.length - 1; i >= 0; i--) bg = over(layers[i], bg);
    const fgRaw = parse(cs.color);
    const fg = over([fgRaw[0], fgRaw[1], fgRaw[2], fgRaw[3] * opacity], bg);
    const size = parseFloat(cs.fontSize);
    const weight = cs.fontWeight === "bold" ? 700 : parseInt(cs.fontWeight, 10) || 400;
    const large = size >= 24 || (size >= 18.66 && weight >= 700);
    const required = large ? 3 : 4.5;
    const r = ratio(fg, bg);
    checked++;
    if (unknownBg || r < required) {
      results.push({
        ratio: Math.round(r * 100) / 100,
        required,
        text: text.slice(0, 60),
        selector: selector(el),
        fg: `rgb(${fg.slice(0, 3).map(Math.round).join(",")})`,
        bg: `rgb(${bg.slice(0, 3).map(Math.round).join(",")})`,
        unknownBg: unknownBg || undefined,
      });
    }
    window.__minRatio = Math.min(
      window.__minRatio ?? Infinity,
      unknownBg ? Infinity : r,
    );
  }
  const min = window.__minRatio ?? Infinity;
  return { checked, min: Number.isFinite(min) ? Math.round(min * 100) / 100 : null, failures: results };
})()
