/* hn-formal loop dashboard. Served at <prefix>/loop/index.html; reads
   releases.json and runs.json (CONTRACT.md shapes) from next to this document
   and fills the static page. Every site URL here is relative to the document,
   so the Pages path prefix (/hn-formal) needs no configuration. All data is inserted with
   textContent; nothing from the JSON is ever parsed as HTML. */
(function () {
  'use strict';

  var ALLOWED_AXIOMS = { 'propext': 1, 'Classical.choice': 1, 'Quot.sound': 1 };

  function $(id) { return document.getElementById(id); }

  function el(tag, attrs, children) {
    var e = document.createElement(tag);
    if (attrs) {
      Object.keys(attrs).forEach(function (k) {
        if (k === 'text') e.textContent = attrs[k];
        else if (k === 'class') e.className = attrs[k];
        else if (attrs[k] !== null && attrs[k] !== undefined) e.setAttribute(k, attrs[k]);
      });
    }
    if (children) {
      children.forEach(function (c) {
        if (c === null || c === undefined) return;
        e.appendChild(typeof c === 'string' ? document.createTextNode(c) : c);
      });
    }
    return e;
  }

  function clear(node) { while (node.firstChild) node.removeChild(node.firstChild); }

  function isNum(x) { return typeof x === 'number' && isFinite(x); }

  function pad(n) { return n < 10 ? '0' + n : String(n); }

  /* "20261009-031500-ab12cd3" or "20261009-030000" -> Date (UTC) or null */
  function dateFromId(id) {
    var m = /^(\d{4})(\d{2})(\d{2})-(\d{2})(\d{2})(\d{2})/.exec(String(id || ''));
    if (!m) return null;
    return new Date(Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]));
  }

  /* epoch seconds or milliseconds -> Date or null */
  function dateFromEpoch(t) {
    if (!isNum(t) || t <= 0) return null;
    return new Date(t > 1e12 ? t : t * 1000);
  }

  function fmtDate(d) {
    if (!d || isNaN(d.getTime())) return '–';
    return d.getUTCFullYear() + '-' + pad(d.getUTCMonth() + 1) + '-' + pad(d.getUTCDate()) +
      ' ' + pad(d.getUTCHours()) + ':' + pad(d.getUTCMinutes()) + ' UTC';
  }

  function fmtUsd(x) { return isNum(x) ? '$' + x.toFixed(2) : '–'; }

  function fmtNum(x, digits) { return isNum(x) ? (digits ? x.toFixed(digits) : String(x)) : '–'; }

  function fmtDuration(a, b) {
    var da = dateFromEpoch(a), db = dateFromEpoch(b);
    if (!da || !db) return '';
    var s = Math.max(0, Math.round((db - da) / 1000));
    var h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60);
    return h ? h + 'h ' + m + 'm' : m + 'm';
  }

  function scoreNode(judge) {
    var score = judge && isNum(judge.score) ? judge.score : null;
    var wrap = el('span', { 'class': 'score' });
    if (score === null) { wrap.appendChild(el('span', { 'class': 'score-n', text: 'no score' })); return wrap; }
    var meter = el('meter', { min: '0', max: '100', low: '40', high: '70', optimum: '100', value: String(score) });
    meter.setAttribute('aria-label', 'Judge score ' + score + ' of 100');
    wrap.appendChild(meter);
    wrap.appendChild(el('span', { 'class': 'score-n', text: score + ' / 100' }));
    return wrap;
  }

  function axiomsNode(axioms) {
    var wrap = el('span', { 'class': 'axioms' });
    if (!Array.isArray(axioms)) { wrap.appendChild(el('span', { 'class': 'empty', text: 'unknown' })); return wrap; }
    if (axioms.length === 0) { wrap.appendChild(el('code', { text: 'none' })); return wrap; }
    axioms.forEach(function (a) {
      wrap.appendChild(el('code', { 'class': ALLOWED_AXIOMS[a] ? '' : 'axiom-bad', text: String(a) }));
    });
    return wrap;
  }

  function screenshot(id, file, alt, cls) {
    var img = el('img', { 'class': cls || 'shot', src: 'releases/' + encodeURIComponent(id) + '/' + file, alt: alt, loading: 'lazy', decoding: 'async' });
    img.addEventListener('error', function () {
      var ph = el('div', { 'class': 'shot-missing', text: 'screenshot missing' });
      if (img.parentNode) img.parentNode.replaceChild(ph, img);
    });
    return img;
  }

  function pill(kind, text) { return el('span', { 'class': 'pill pill-' + kind, text: text }); }

  /* ---------- current release ---------- */
  function renderCurrent(rel) {
    var box = $('current');
    clear(box);
    if (!rel) {
      box.appendChild(el('p', { 'class': 'empty', text: 'No releases yet. The site is serving the hand-written baseline renderer.' }));
      box.className = 'current current-empty';
      return;
    }
    var t1 = rel.tier1 || {}, t2 = rel.tier2 || {};
    var left = el('div', null, [
      screenshot(rel.id, 'index-1280.png', 'Front page of release ' + rel.id + ' at 1280px')
    ]);
    var meta = el('dl', { 'class': 'release-meta' }, [
      el('dt', { text: 'Release' }), el('dd', null, [el('span', { 'class': 'release-id', text: rel.id })]),
      el('dt', { text: 'Date' }), el('dd', { text: fmtDate(dateFromId(rel.id)) }),
      el('dt', { text: 'Run' }), el('dd', null, [el('a', { href: '#run-' + encodeURIComponent(rel.runId || ''), 'class': 'release-id', text: rel.runId || '–' })]),
      el('dt', { text: 'Judge' }), el('dd', null, [scoreNode(rel.judge)]),
      el('dt', { text: 'Tier 1' }), el('dd', null, [
        el('div', null, [
          'lake build ', pill(t1.lakeBuild === 'ok' ? 'ok' : 'fail', String(t1.lakeBuild || '?')),
          ' selftest ', pill(t1.selftest === 'ok' ? 'ok' : 'fail', String(t1.selftest || '?'))
        ]),
        el('div', null, ['axioms ', axiomsNode(t1.axioms)])
      ]),
      el('dt', { text: 'Tier 2' }), el('dd', null, [
        el('dl', { 'class': 't2' }, [
          el('div', null, [el('dt', { text: 'vnu errors' }), el('dd', { text: fmtNum(t2.vnu) })]),
          el('div', null, [el('dt', { text: 'axe' }), el('dd', { text: fmtNum(t2.axe) })]),
          el('div', null, [el('dt', { text: 'min contrast' }), el('dd', { text: isNum(t2.contrastMin) ? t2.contrastMin.toFixed(2) + ':1' : '–' })]),
          el('div', null, [el('dt', { text: 'reflow' }), el('dd', { text: isNum(t2.reflowWidth) ? t2.reflowWidth + 'px' : '–' })]),
          el('div', null, [el('dt', { text: 'csp' }), el('dd', { text: String(t2.csp || '–') })])
        ])
      ]),
      el('dt', { text: 'Model' }), el('dd', { text: (rel.model || '–') + (isNum(rel.repairRounds) ? ', ' + rel.repairRounds + ' repair round' + (rel.repairRounds === 1 ? '' : 's') : '') }),
      el('dt', { text: 'Cost' }), el('dd', { text: fmtUsd(rel.costUsd) }),
      el('dt', { text: 'Diff' }), el('dd', { text: (rel.diffStat || '–') + (rel.previousRelease ? ' vs ' + rel.previousRelease : '') }),
      el('dt', { text: 'Spec' }), el('dd', { text: isNum(rel.specVersion) ? 'v' + rel.specVersion : '–' })
    ]);
    var right = el('div', null, [meta]);
    if (rel.judge && rel.judge.notes) right.appendChild(el('p', { 'class': 'notes', text: rel.judge.notes }));
    right.appendChild(el('div', { 'class': 'actions' }, [
      el('a', { href: '../', text: 'Open the site' }),
      el('a', { href: 'https://github.com/scasella/hn-formal/tree/main/releases/' + encodeURIComponent(rel.id), text: 'Release files on GitHub' }),
      el('a', { href: 'releases/' + encodeURIComponent(rel.id) + '/index-375.png', text: '375px screenshot' })
    ]));
    box.appendChild(left);
    box.appendChild(right);
  }

  /* ---------- gallery ---------- */
  function renderGallery(releases) {
    var ul = $('gallery');
    clear(ul);
    if (!releases.length) {
      ul.appendChild(el('li', { 'class': 'empty-li' }, [el('p', { 'class': 'empty', text: 'No releases yet.' })]));
      ul.className = 'gallery gallery-empty';
      return;
    }
    releases.forEach(function (rel, i) {
      var li = el('li', { 'class': i === 0 ? 'is-current' : '' }, [
        screenshot(rel.id, 'index-375.png', 'Front page of release ' + rel.id + ' at 375px'),
        el('div', { 'class': 'card-body' }, [
          i === 0 ? el('span', { 'class': 'badge-current', text: 'current' }) : null,
          el('span', { 'class': 'card-id', text: rel.id }),
          el('span', { 'class': 'card-date', text: fmtDate(dateFromId(rel.id)) }),
          scoreNode(rel.judge),
          el('span', { 'class': 'card-date', text: 'cost ' + fmtUsd(rel.costUsd) + (isNum(rel.repairRounds) ? ' · ' + rel.repairRounds + ' rounds' : '') })
        ])
      ]);
      ul.appendChild(li);
    });
  }

  /* ---------- runs ---------- */
  function stopPill(run) {
    var r = String(run.stopReason || (run.released ? 'released' : 'unknown'));
    var kind = r === 'released' ? 'ok' : (r === 'cap-hit' || r === 'killed') ? 'warn' : 'fail';
    return pill(kind, r);
  }

  function tierPill(v) {
    var s = String(v || '–');
    if (s === 'ok') return pill('ok', 'ok');
    if (s === '–') return pill('muted', '–');
    return pill('fail', s);
  }

  function candidatesTable(run) {
    var pc = Array.isArray(run.perCandidate) ? run.perCandidate : [];
    if (!pc.length) return el('p', { 'class': 'empty', text: (run.lastError ? 'No per-candidate records. ' + run.lastError : 'No per-candidate records.') });
    var tbody = el('tbody');
    pc.forEach(function (c) {
      tbody.appendChild(el('tr', null, [
        el('td', { 'class': 'num', text: fmtNum(c.n) }),
        el('td', { 'class': 'num', text: fmtNum(c.rounds) }),
        el('td', null, [tierPill(c.tier1)]),
        el('td', null, [tierPill(c.tier2)]),
        el('td', { 'class': 'num', text: fmtNum(c.judge) }),
        el('td', { 'class': 'err', text: c.lastError ? String(c.lastError) : '' })
      ]));
    });
    return el('table', { 'class': 'cands' }, [
      el('thead', null, [el('tr', null, [
        el('th', { scope: 'col', text: '#' }), el('th', { scope: 'col', text: 'Rounds' }),
        el('th', { scope: 'col', text: 'Tier 1' }), el('th', { scope: 'col', text: 'Tier 2' }),
        el('th', { scope: 'col', text: 'Judge' }), el('th', { scope: 'col', text: 'Last error' })
      ])]),
      tbody
    ]);
  }

  function renderRuns(runs) {
    var tbody = $('runs-body');
    clear(tbody);
    var empty = $('runs-empty');
    if (!runs.length) { empty.hidden = false; $('runs-table').hidden = true; return; }
    empty.hidden = true; $('runs-table').hidden = false;
    var total = 0;
    runs.forEach(function (run, i) {
      if (isNum(run.costUsd)) total += run.costUsd;
      var detailsId = 'run-details-' + i;
      var btn = el('button', { 'class': 'toggle', type: 'button', 'aria-expanded': 'false', 'aria-controls': detailsId, text: 'Candidates' });
      var started = dateFromEpoch(run.startedAt) || dateFromId(run.runId);
      var row = el('tr', { 'class': 'run-row', id: 'run-' + encodeURIComponent(run.runId || String(i)) }, [
        el('td', null, [
          el('span', { 'class': 'mono', text: run.runId || '–' }),
          el('br'),
          el('span', { 'class': 'card-date', text: fmtDate(started) + (fmtDuration(run.startedAt, run.finishedAt) ? ' · ' + fmtDuration(run.startedAt, run.finishedAt) : '') })
        ]),
        el('td', { 'class': 'num', text: fmtNum(run.candidates) }),
        el('td', { 'class': 'num', text: fmtNum(run.passedTier1) }),
        el('td', { 'class': 'num', text: fmtNum(run.passedTier2) }),
        el('td', null, [run.released ? el('span', { 'class': 'mono', text: String(run.released) }) : pill('muted', 'none')]),
        el('td', { 'class': 'num', text: fmtUsd(run.costUsd) + (isNum(run.calls) ? ' · ' + run.calls + ' calls' : '') }),
        el('td', null, [stopPill(run)]),
        el('td', null, [btn])
      ]);
      var details = el('tr', { 'class': 'details-row', id: detailsId, hidden: '' }, [
        el('td', { colspan: '8' }, [candidatesTable(run)])
      ]);
      btn.addEventListener('click', function () {
        var open = btn.getAttribute('aria-expanded') === 'true';
        btn.setAttribute('aria-expanded', open ? 'false' : 'true');
        details.hidden = open;
        row.classList.toggle('is-open', !open);
      });
      tbody.appendChild(row);
      tbody.appendChild(details);
    });
    $('stat-spend').textContent = fmtUsd(total);
  }

  /* ---------- load ---------- */
  function load(url) {
    return fetch(url, { cache: 'no-cache' }).then(function (r) {
      if (!r.ok) throw new Error(url + ': HTTP ' + r.status);
      return r.json();
    }).then(function (j) {
      if (!Array.isArray(j)) throw new Error(url + ': expected a JSON array');
      return j;
    });
  }

  function fail(where, err) {
    var box = $(where);
    clear(box);
    box.appendChild(el('p', { 'class': 'error', text: 'Could not load data: ' + (err && err.message ? err.message : String(err)) }));
  }

  load('releases.json').then(function (releases) {
    $('stat-releases').textContent = String(releases.length);
    var cur = releases[0] || null;
    $('stat-spec').textContent = cur && isNum(cur.specVersion) ? 'v' + cur.specVersion : '–';
    renderCurrent(cur);
    renderGallery(releases);
  }).catch(function (e) { fail('current', e); fail('gallery', e); });

  load('runs.json').then(function (runs) {
    $('stat-runs').textContent = String(runs.length);
    renderRuns(runs);
  }).catch(function (e) {
    $('runs-table').hidden = true;
    var p = $('runs-empty'); p.hidden = false; p.className = 'error';
    p.textContent = 'Could not load runs: ' + (e && e.message ? e.message : String(e));
  });
})();
