'use strict';

/*
 * Finding the right day on the SimplePractice calendar, in Day / Week / Month
 * view and with different heading formats, on a fake FullCalendar page. A day
 * that can't be found or attributed must never be treated as "empty".
 */

const path = require('path');
const { JSDOM } = require('jsdom');
const book = require(path.join(__dirname, '..', 'src', 'main', 'book'));

let passed = 0;
let failed = 0;
function check(name, cond) { if (cond) { passed++; console.log('  ok  ' + name); } else { failed++; console.log('  FAIL ' + name); } }

const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const DOW = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const iso = (d) => book.isoDay(d);
const addDays = (d, n) => new Date(d.getFullYear(), d.getMonth(), d.getDate() + n);

/** A tiny FullCalendar look-alike driven through a Playwright-shaped page object. */
function fakeCalendar({ start, view = 'day', tags = true, titleFmt, events = [] }) {
  const dom = new JSDOM('<!doctype html><body></body>');
  const doc = dom.window.document;
  let cur = start;
  const days = () => {
    if (view === 'day') return [cur];
    if (view === 'week') { const s = addDays(cur, -cur.getDay()); return [0, 1, 2, 3, 4, 5, 6].map((i) => addDays(s, i)); }
    const first = new Date(cur.getFullYear(), cur.getMonth(), 1);
    const n = new Date(cur.getFullYear(), cur.getMonth() + 1, 0).getDate();
    return Array.from({ length: n }, (_, i) => addDays(first, i));
  };
  const render = () => {
    const ds = days();
    const title = titleFmt ? titleFmt(ds) : `${DOW[cur.getDay()]}, ${MON[cur.getMonth()]} ${cur.getDate()}, ${cur.getFullYear()}`;
    const cols = ds.map((d) => {
      const evs = events.filter((e) => e.iso === iso(d)).map((e) => `<div data-appt-title="${e.title}"></div>`).join('');
      return tags ? `<div class="fc-timegrid-col" data-date="${iso(d)}">${evs}</div>` : `<div>${evs}</div>`;
    }).join('');
    doc.body.innerHTML = `<h2 class="fc-toolbar-title">${title}</h2><button class="fc-prev-button"></button><button class="fc-next-button"></button><div class="fc-view-harness">${cols}</div>`;
  };
  render();
  const step = (dir) => {
    if (view === 'day') cur = addDays(cur, dir);
    else if (view === 'week') cur = addDays(cur, 7 * dir);
    else cur = new Date(cur.getFullYear(), cur.getMonth() + dir, 1);
    render();
  };
  const wrap = (el) => el && { textContent: async () => el.textContent, isVisible: async () => true, click: async () => {}, evaluate: async () => {} };
  return {
    goto: async () => {}, waitForSelector: async () => true,
    $: async (sel) => wrap(doc.querySelector(sel)), $$: async () => [],
    keyboard: { press: async () => {} },
    click: async (sel) => { if (sel.includes('prev')) step(-1); else if (sel.includes('next')) step(1); },
    evaluate: async (fn, arg) => { global.document = doc; global.window = dom.window; try { return fn(arg); } finally { delete global.document; delete global.window; } },
  };
}

(function testTitles() {
  console.log('# Calendar headings in the formats SimplePractice might show');
  const same = (r, a, b) => r && iso(r.start) === a && iso(r.end) === b;
  check('"Sat, Jun 27, 2026"', same(book.parseCalTitle('Sat, Jun 27, 2026'), '2026-06-27', '2026-06-27'));
  check('"Monday, October 26, 2026"', same(book.parseCalTitle('Monday, October 26, 2026'), '2026-10-26', '2026-10-26'));
  check('"Oct 26" with no year uses the target year', same(book.parseCalTitle('Oct 26', 2026), '2026-10-26', '2026-10-26'));
  check('week "Oct 25 – 31, 2026"', same(book.parseCalTitle('Oct 25 – 31, 2026'), '2026-10-25', '2026-10-31'));
  check('week "Oct 25 – Nov 1, 2026"', same(book.parseCalTitle('Oct 25 – Nov 1, 2026'), '2026-10-25', '2026-11-01'));
  check('week across the year "Dec 27, 2026 – Jan 2, 2027"', same(book.parseCalTitle('Dec 27, 2026 – Jan 2, 2027'), '2026-12-27', '2027-01-02'));
  check('nonsense → null', book.parseCalTitle('Loading…') === null);
})();

(async function run() {
  console.log('# Getting to the day, in each view');
  const say = () => {};
  const target = '10/26/2026';
  const events = [
    { iso: '2026-10-26', title: 'Jamie PT Rivera' },
    { iso: '2026-10-27', title: 'Dana Whitfield' },
  ];
  let p = fakeCalendar({ start: new Date(2026, 9, 23), view: 'day', events });
  check('day view, 3 days ahead → arrives', await book.spNavigateToDate(p, target, say));
  let r = await book.spReadDay(p, target);
  check('day view → reads only that day', r.ok && r.titles.join('|') === 'Jamie PT Rivera');

  p = fakeCalendar({ start: new Date(2026, 9, 23), view: 'week', events });
  check('week view → arrives on the week holding the day', await book.spNavigateToDate(p, target, say));
  r = await book.spReadDay(p, target);
  check('week view → only that day\'s column counts', r.ok && r.titles.join('|') === 'Jamie PT Rivera');

  p = fakeCalendar({ start: new Date(2026, 7, 10), view: 'month', events });
  check('month view, two months back → arrives', await book.spNavigateToDate(p, target, say));
  r = await book.spReadDay(p, target);
  check('month view → only that day counts', r.ok && r.titles.join('|') === 'Jamie PT Rivera');

  p = fakeCalendar({ start: new Date(2026, 9, 28), view: 'day', tags: false, titleFmt: (ds) => `${MON[ds[0].getMonth()]} ${ds[0].getDate()}`, events });
  check('no day tags + a heading without year → still arrives (going back)', await book.spNavigateToDate(p, target, say));
  r = await book.spReadDay(p, target);
  check('…and reads the single day shown', r.ok && r.titles.join('|') === 'Jamie PT Rivera');

  p = fakeCalendar({ start: new Date(2026, 9, 23), view: 'week', tags: false, titleFmt: (ds) => `${MON[ds[0].getMonth()]} ${ds[0].getDate()} – ${ds[6].getDate()}, ${ds[6].getFullYear()}`, events });
  check('week view with no day tags → refuses (can\'t tell the days apart)', !(await book.spNavigateToDate(p, target, say)));
  r = await book.spReadDay(p, target);
  check('…and the read refuses too, never "empty"', !r.ok);

  console.log(`${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})();
