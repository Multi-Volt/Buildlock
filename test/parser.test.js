// Run with: node test/parser.test.js
// Checks the tracklock parsers against small fixtures shaped like tracklock's pages.
'use strict';
const assert = require('assert');
const { parseProbuild, parseBuild } = require('../server.js');

const item = (name, tier, pct) =>
  `<div class="item"><img alt="${name}" src="https://static.bigbrain.gg/x.webp"><div>${tier}</div><span>${name}${pct != null ? `<!-- -->${pct}%` : ''}</span></div>`;

const probuild = `<html><head><script>self.__next_f.push(["Swift Striker 12%"])</script></head><body>
<nav>Heroes Items</nav><h1>Warden</h1><div>Win Rate<span>68.6%</span></div><div>Games<span>204</span></div>
<p>Tracklock&#x27;s Warden Pro Builds page tracks item builds...</p>
<h3>Early Game<span>· 0-10 min</span></h3>${item('High-Velocity Rounds', 'I', 99)}${item('Quicksilver Reload', 'II', 98)}${item('Enchanter&#x27;s Emblem', 'II', 40)}
<h3>Mid Game<span>· 10-20 min</span></h3>${item('Mercurial Magnum', 'IV', 98)}${item('Fleetfoot', 'II', 69)}
<h3>Late Game<span>· 20+ min</span></h3>${item('Spiritual Overflow', 'IV', 78)}${item('Not A Real Item', 'II', 50)}
<div>Laned with any</div>${item('Silencer', 'IV', null)}
</body></html>`;

const p = parseProbuild(probuild);
assert.strictEqual(p.wr, 68.6);
assert.strictEqual(p.g, 204);
assert.deepStrictEqual(p.p.Early.map(x => x[1]), [99, 98, 40]);
assert.ok(p.p.Early[2][0], 'apostrophes in item names are decoded and matched');
assert.strictEqual(p.p.Mid.length, 2);
assert.strictEqual(p.p.Late.length, 1, 'unknown items are skipped, match-history items after "Laned with" are ignored');
assert.ok(p.unknown.includes('Not A Real Item'));

// Text-only fallback (no alt attributes), like "IILong Range90%"
const textOnly = `<body><div>Win Rate 54.4%</div><div>Games 90</div><div>Early Game· 0-10 min</div><div>IILong Range90%IISwift Striker88%</div>
<div>Mid Game· 10-20 min</div><div>IIIStamina Mastery84%</div><div>Late Game· 20+ min</div><div>IIImproved Spirit69%</div><div>Laned with any</div></body>`;
const t = parseProbuild(textOnly);
assert.deepStrictEqual(t.p.Early.map(x => x[1]), [90, 88]);
assert.strictEqual(t.p.Late.length, 1, 'tier prefix II + "Improved Spirit" is split correctly');

const build = `<body><h1>Warden</h1><h2>Build Summary</h2><div>60.0% WR (633 Matches)</div>
<div>Unlock Order</div><img alt="Alchemical Flask"><b>1</b><img alt="Willpower"><b>2</b><img alt="Binding Word"><img alt="Last Stand">
<h2>Skill Path</h2>
<div>Core Build<span>· Buy in order from left to right</span></div>${item('High-Velocity Rounds', 'I')}${item('Opening Rounds', 'II')}${item('Mercurial Magnum', 'IV')}
<div>Early<span>· Situational early-game items</span></div>${item('Monster Rounds', 'I')}
<div>Late<span>· Situational late-game items</span></div>${item('Silencer', 'IV')}
<div>Defensives<span>· Increase your survivability</span></div>${item('Spirit Resilience', 'III')}
<div>Counter Picks<span>·</span></div>${item('Metal Skin', 'III')}
<div>Actives<span>·</span></div>${item('Unstoppable', 'IV')}
<div class="summary"><img alt="Hollow Point"><div>III</div><img alt="Battle Vest"><div>II</div></div></body>`;
const b = parseBuild(build, 'hero_warden');
assert.strictEqual(b.wr, 60);
assert.strictEqual(b.matches, 633);
assert.strictEqual(b.core.length, 3);
assert.strictEqual(b.early.length, 1);
assert.strictEqual(b.late.length, 1);
assert.strictEqual(b.defensive.length, 1);
assert.strictEqual(b.actives.length, 1, 'unnamed icons after the last section are not part of it');
assert.deepStrictEqual(b.unlock, [0, 1, 2, 3]);

console.log('All parser tests passed.');
