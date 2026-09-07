import test from 'node:test';
import assert from 'node:assert/strict';
import { parsePortStatistics } from '../src/tplink-easy-smart.mjs';

test('parses Easy Smart port statistics including 100M and 1000M links', () => {
  const text = `
  <script>
  var max_port_num = 4;
  var all_info = {
    state:[1,1,1,1,0,0],
    link_status:[6,5,6,6,0,0],
    pkts:[257892539,0,180624584,0,86624562,0,21095063,0,187017381,0,78617048,0,273429038,0,390733905,0,0,0]
  };
  </script>`;
  const p = parsePortStatistics(text);
  assert.equal(p.length, 4);
  assert.equal(p[0].link, '1000M Full');
  assert.equal(p[1].link, '100M Full');
  assert.equal(p[3].rxGood, 390733905);
  assert.equal(p[2].rxBad, 0);
});

test('parses five-port statistics and preserves non-zero lifetime bad counters', () => {
  const text = `
  <script>
  var max_port_num = 5;
  var all_info = {
    state:[1,1,1,1,1,0,0],
    link_status:[6,6,0,6,5,0,0],
    pkts:[100,0,200,30,300,0,400,31,500,0,600,245,700,0,800,31,900,0,1000,32,0,0]
  };
  </script>`;
  const p = parsePortStatistics(text);
  assert.equal(p.length, 5);
  assert.equal(p[2].link, 'Link Down');
  assert.equal(p[4].link, '100M Full');
  assert.equal(p[0].rxBad, 30);
  assert.equal(p[2].rxBad, 245);
});
