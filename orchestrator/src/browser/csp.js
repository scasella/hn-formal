// Runs inside the page via page.evaluate(source). Plain JS.
// Returns { problems[], warnings[] } simulating CSP script-src 'none' + same-origin resources.
(() => {
  const problems = [];
  const warnings = [];
  const origin = location.origin;
  const scripts = document.querySelectorAll("script");
  if (scripts.length) problems.push(`${scripts.length} <script> element(s)`);
  for (const el of Array.from(document.querySelectorAll("*"))) {
    for (const a of Array.from(el.attributes)) {
      if (/^on[a-z]+$/i.test(a.name)) problems.push(`inline handler ${a.name} on <${el.tagName.toLowerCase()}>`);
      if ((a.name === "href" || a.name === "src" || a.name === "action" || a.name === "formaction") && /^\s*javascript:/i.test(a.value)) {
        problems.push(`javascript: URL in ${a.name} on <${el.tagName.toLowerCase()}>`);
      }
      if (a.name === "style") warnings.push(`inline style attribute on <${el.tagName.toLowerCase()}>`);
    }
  }
  if (document.querySelectorAll("style").length) warnings.push(`${document.querySelectorAll("style").length} <style> element(s)`);
  const resourceSel = "link[rel~='stylesheet'], link[rel~='icon'], link[rel~='preload'], img, iframe, object, embed, video, audio, source, track, picture source";
  for (const el of Array.from(document.querySelectorAll(resourceSel))) {
    const url = el.href || el.src || el.srcset || "";
    if (!url) continue;
    try {
      const u = new URL(url, location.href);
      if (u.origin !== origin) problems.push(`external resource ${u.href} via <${el.tagName.toLowerCase()}>`);
    } catch {
      problems.push(`unparseable resource URL ${url}`);
    }
  }
  for (const sheet of Array.from(document.styleSheets)) {
    let rules;
    try {
      rules = sheet.cssRules;
    } catch {
      problems.push(`stylesheet ${sheet.href} not readable (cross-origin?)`);
      continue;
    }
    const base = sheet.href ?? location.href;
    for (const rule of Array.from(rules)) {
      const text = rule.cssText;
      if (/@import/i.test(text)) problems.push(`@import in ${sheet.href ?? "inline stylesheet"}`);
      for (const m of text.matchAll(/url\(\s*(['"]?)([^'")]+)\1\s*\)/g)) {
        const ref = m[2];
        if (/^data:/i.test(ref)) {
          problems.push(`data: URL in stylesheet: ${ref.slice(0, 40)}...`);
          continue;
        }
        try {
          const u = new URL(ref, base);
          if (u.origin !== origin) problems.push(`external url() ${u.href} in stylesheet`);
          else if (!u.pathname.startsWith("/fonts/")) problems.push(`url() outside /fonts/ in stylesheet: ${u.pathname}`);
        } catch {
          problems.push(`unparseable url() ${ref}`);
        }
      }
    }
  }
  return { problems, warnings };
})()
