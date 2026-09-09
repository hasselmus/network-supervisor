import test from 'node:test';
import assert from 'node:assert/strict';
import { diagnose, FaultLatch } from '../src/diagnose.mjs';

const config = {
  badPacketDeltaWarn: 100,
  observer: { ethernetInterface:'eth0', wifiInterface:'wlan0' },
  switches:[
    { id:'a', name:'A', ports:{ '1':{name:'uplink',expectedUp:true,expectedLink:'1000M Full'}, '2':{name:'optional',expectedUp:false,expectedLink:'1000M Full'} } },
    { id:'b', name:'B', ports:{ '1':{name:'uplink',expectedUp:true,expectedLink:'1000M Full'} } }
  ],
  links:[{ id:'a-b', name:'A ↔ B', a:{switch:'a',port:1}, b:{switch:'b',port:1}, expectedUp:true }]
};

function sw(link='1000M Full', up=true){return {ok:true,ports:[{port:1,up,link,badDelta:0},{port:2,up:false,link:'Link Down',badDelta:0}]}}

test('one physical link fault suppresses independent switch-management noise', () => {
  const obs={switches:{a:sw('Link Down',false),b:{ok:false,error:'timeout',ports:[]}},interfaces:{},witnesses:{}};
  const d=diagnose(config,obs);
  assert.ok(d.some(x=>x.id==='link:a-b'));
  assert.ok(!d.some(x=>x.id==='switch:b:management'));
});

test('negotiation mismatch is reported while optional-down port is not', () => {
  const a=sw('100M Full',true); const b=sw();
  const d=diagnose(config,{switches:{a,b},interfaces:{},witnesses:{}});
  assert.ok(d.some(x=>x.id==='port:a:1:negotiation'));
  assert.ok(!d.some(x=>x.id==='port:a:2:down'));
});

test('fault latch debounces starts and recoveries', () => {
  const l=new FaultLatch(2,2), f={id:'x',severity:'warning',title:'x'};
  assert.equal(l.update([f]).active.length,0);
  assert.equal(l.update([f]).active.length,1);
  assert.equal(l.update([]).active.length,1);
  assert.equal(l.update([]).active.length,0);
});

test('bad packet totals are ignored until the per-poll delta reaches threshold', () => {
  const a = sw();
  a.ports[0].rxBad = 5000;
  a.ports[0].badDelta = 99;
  let d = diagnose(config,{switches:{a,b:sw()},interfaces:{},witnesses:{}});
  assert.ok(!d.some(x=>x.id==='port:a:1:errors'));
  a.ports[0].badDelta = 100;
  d = diagnose(config,{switches:{a,b:sw()},interfaces:{},witnesses:{}});
  assert.ok(d.some(x=>x.id==='port:a:1:errors'));
});

test('missing unreliable Wi-Fi witness is not itself a network diagnosis', () => {
  const d = diagnose(config, {
    switches:{a:sw(),b:sw()},
    interfaces:{},
    witnesses:{pooh:{ok:false,name:'pooh.local',unreliable:true}}
  });
  assert.ok(!d.some(x=>x.category==='witness'));
  assert.ok(!d.some(x=>x.id==='witness:pooh'));
});

test('local Ethernet carrier loss is identified as a physical fault and suppresses vague path fault', () => {
  const cfg={observer:{ethernetInterface:'eth0',wifiInterface:'wlan0'},switches:[],links:[]};
  const obs={
    switches:{}, witnesses:{},
    interfaces:{
      eth0:{configured:true,link:{available:true,carrier:false,link:'Link Down'},router:{ok:false},internet:[],dns:{ok:false}},
      wlan0:{configured:true,link:{available:true,carrier:true,link:'Link Up'},router:{ok:true},internet:[{ok:true,ms:30}],dns:{ok:true}}
    }
  };
  const d=diagnose(cfg,obs);
  assert.ok(d.some(x=>x.id==='path:ethernet-carrier'&&x.category==='physical'));
  assert.ok(!d.some(x=>x.id==='path:ethernet'));
  assert.ok(!d.some(x=>x.id==='router:lan-unreachable'));
});

test('carrier-up Ethernet failure remains a forwarding/service-path diagnosis', () => {
  const cfg={observer:{ethernetInterface:'eth0',wifiInterface:'wlan0'},switches:[],links:[]};
  const obs={switches:{},witnesses:{},interfaces:{
    eth0:{configured:true,link:{available:true,carrier:true,link:'1000M Full'},router:{ok:false},internet:[],dns:{ok:false}},
    wlan0:{configured:true,router:{ok:true},internet:[{ok:true,ms:30}],dns:{ok:true}}
  }};
  const d=diagnose(cfg,obs);
  assert.ok(d.some(x=>x.id==='path:ethernet'));
  assert.ok(!d.some(x=>x.id==='path:ethernet-carrier'));
});

test('supervisor Ethernet negotiation can be checked without a managed switch', () => {
  const cfg={observer:{ethernetInterface:'eth0',ethernetExpectedLink:'1000M Full'},switches:[],links:[]};
  const obs={switches:{},witnesses:{},interfaces:{
    eth0:{configured:true,link:{available:true,carrier:true,link:'100M Full'},router:{ok:true},internet:[{ok:true,ms:30}],dns:{ok:true}}
  }};
  const d=diagnose(cfg,obs);
  assert.ok(d.some(x=>x.id==='path:ethernet-negotiation'));
});
