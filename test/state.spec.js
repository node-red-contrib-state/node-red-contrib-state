const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const helper = require('node-red-node-test-helper');
const stateNode = require('../lib/state');
const getStateNode = require('../lib/getState');
const setStateNode = require('../lib/setState');

describe('shared state', function () {
  this.timeout(10000);
  let dir;
  beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'state-test-')); process.chdir(dir); });
  afterEach(async () => { await helper.unload(); fs.rmSync(dir, { recursive: true, force: true }); });

  const flow = [
    { id:'s', type:'shared-state', name:'licht', dataType:'bool', historyCount:0, saveInterval:'0', wires:[] },
    { id:'g', type:'get-shared-state', state:'s', triggerOnChange:true, wires:[['h']] },
    { id:'w', type:'set-shared-state', state:'s', wires:[[]] },
    { id:'h', type:'helper' },
  ];

  it('emits exactly one message per state change', async function () {
    await helper.load([stateNode, getStateNode, setStateNode], flow);
    let count = 0;
    helper.getNode('h').on('input', () => count++);
    await helper.getNode('s').update(true);
    await new Promise(r => setTimeout(r, 25));
    assert.equal(count, 1);
  });

  it('removes its listeners from the shared state when a get/set node is closed', async function () {
    await helper.load([stateNode, getStateNode, setStateNode], flow);
    const s = helper.getNode('s');
    assert.equal(s.listenerCount('change'), 2);
    assert.equal(s.listenerCount('init'), 2);
    await helper.getNode('g').close();
    await helper.getNode('w').close();
    assert.equal(s.listenerCount('change'), 0);
    assert.equal(s.listenerCount('init'), 0);
  });

  it('ignores a message with an undefined payload instead of crashing (#18)', async function () {
    const objFlow = [
      { id:'s', type:'shared-state', name:'obj', dataType:'obj', historyCount:2, saveInterval:'0', wires:[] },
      { id:'w', type:'set-shared-state', state:'s', wires:[[]] },
    ];
    await helper.load([stateNode, setStateNode], objFlow);
    const s = helper.getNode('s');
    await s.update({ a: 1 });
    const warnings = [];
    s.warn = (m) => warnings.push(m);

    // Same shape as the issue: a function node returned msg.payload as the msg
    helper.getNode('w').receive({ action: null, state_left: 'OFF' });
    await new Promise(r => setTimeout(r, 25));

    assert.deepEqual(s.value, { a: 1 });
    assert.equal(warnings.length, 1);
    assert.match(warnings[0], /undefined/);
  });
});

describe('shared state persistence', function () {
  this.timeout(10000);
  let dir;
  beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'state-test-')); process.chdir(dir); });
  afterEach(async () => { await helper.unload(); fs.rmSync(dir, { recursive: true, force: true }); });

  const stateDir = () => path.join(dir, 'shared-state');
  const stateFile = (name) => path.join(stateDir(), name);
  const load = async (config) => {
    await helper.load([stateNode], [Object.assign({ id:'s', type:'shared-state', name:'st', dataType:'num', wires:[] }, config)]);
    const s = helper.getNode('s');
    await s.io;
    return s;
  };
  const warnings = () => helper.log().args
    .map(a => a[0])
    .filter(m => m && m.level === helper.log().WARN)
    .map(m => m.msg);

  describe('migration defaults', function () {
    it('uses "on" for existing nodes with history and "off" without', function () {
      assert.equal(stateNode.resolvePersist({ historyCount: 2 }), 'on');
      assert.equal(stateNode.resolvePersist({ historyCount: '5' }), 'on');
      assert.equal(stateNode.resolvePersist({ historyCount: 0 }), 'off');
      assert.equal(stateNode.resolvePersist({ historyCount: '0' }), 'off');
      assert.equal(stateNode.resolvePersist({}), 'off');
    });

    it('never enables backup automatically and respects an explicit setting', function () {
      assert.equal(stateNode.resolvePersist({ historyCount: 100 }), 'on');
      assert.equal(stateNode.resolvePersist({ persist: 'off', historyCount: 2 }), 'off');
      assert.equal(stateNode.resolvePersist({ persist: 'on', historyCount: 0 }), 'on');
      assert.equal(stateNode.resolvePersist({ persist: 'on+backup', historyCount: 0 }), 'on+backup');
      assert.equal(stateNode.resolvePersist({ persist: 'bogus', historyCount: 0 }), 'off');
    });

    it('defaults new nodes to "on" in the editor', function () {
      const html = fs.readFileSync(path.join(__dirname, '..', 'lib', 'state.html'), 'utf8');
      assert.match(html, /persist:\s*\{\s*value:\s*"on"\s*\}/);
    });

    it('applies the migration to a loaded node without the field', async function () {
      const s = await load({ historyCount: 0, saveInterval: '0' });
      assert.equal(s.persist, 'off');
      await s.update(1);
      assert.equal(fs.existsSync(stateFile('st')), false);
    });
  });

  it('"off" writes nothing to disk, but still keeps history in memory', async function () {
    const s = await load({ persist: 'off', historyCount: 3, saveInterval: '0' });
    await s.update(1);
    await s.update(2);
    await s.io;
    assert.equal(fs.existsSync(stateDir()), false);
    assert.deepEqual(s.history.map(h => h.val), [2, 1]);
  });

  it('"off" still loads an existing state file at startup, but never writes it', async function () {
    fs.mkdirSync(stateDir());
    const original = JSON.stringify({ value: 7, prev: 6, timestamp: 1, history: [{ val: 7, ts: 1 }] });
    fs.writeFileSync(stateFile('st'), original);
    fs.writeFileSync(stateFile('st.tmp'), 'leftover');
    const s = await load({ persist: 'off', historyCount: 2, saveInterval: '0' });
    assert.equal(s.value, 7);
    assert.equal(s.initialized, true);
    await s.update(8);
    await s.io;
    assert.equal(s.value, 8);
    assert.equal(fs.readFileSync(stateFile('st'), 'utf8'), original);
    assert.equal(fs.readFileSync(stateFile('st.tmp'), 'utf8'), 'leftover');
    assert.deepEqual(fs.readdirSync(stateDir()).sort(), ['st', 'st.tmp']);
  });

  describe('"on"', function () {
    it('saves state even with historyCount 0', async function () {
      const s = await load({ persist: 'on', historyCount: 0, saveInterval: '0' });
      await s.update(42);
      const saved = JSON.parse(fs.readFileSync(stateFile('st'), 'utf8'));
      assert.equal(saved.value, 42);
      assert.deepEqual(saved.history, []);
    });

    it('writes atomically via <file>.tmp and rename', async function () {
      const s = await load({ persist: 'on', historyCount: 2, saveInterval: '0' });
      const renames = [];
      const origRename = fs.promises.rename;
      fs.promises.rename = async (from, to) => { renames.push([from, to]); return origRename(from, to); };
      try {
        await s.update(1);
        await s.update(2);
      } finally {
        fs.promises.rename = origRename;
      }
      assert.deepEqual(renames, [
        [s.stateFile + '.tmp', s.stateFile],
        [s.stateFile + '.tmp', s.stateFile],
      ]);
      assert.equal(fs.existsSync(stateFile('st.tmp')), false);
      assert.equal(fs.existsSync(stateFile('st.bkp')), false);
      assert.equal(JSON.parse(fs.readFileSync(stateFile('st'), 'utf8')).value, 2);
    });

    it('serializes concurrent writes so the file ends with the last value', async function () {
      const s = await load({ persist: 'on', historyCount: 0, saveInterval: '0' });
      await Promise.all([1, 2, 3, 4, 5].map(v => s.update(v)));
      await s.io;
      assert.equal(JSON.parse(fs.readFileSync(stateFile('st'), 'utf8')).value, 5);
    });

    it('removes a stale .tmp file on load and loads the main file', async function () {
      fs.mkdirSync(stateDir());
      fs.writeFileSync(stateFile('st'), JSON.stringify({ value: 7, prev: 6, timestamp: 1, history: [] }));
      fs.writeFileSync(stateFile('st.tmp'), '{"value": 8, "pr');
      const s = await load({ persist: 'on', historyCount: 2, saveInterval: '0' });
      assert.equal(s.value, 7);
      assert.equal(fs.existsSync(stateFile('st.tmp')), false);
    });
  });

  describe('"on+backup"', function () {
    it('keeps the previous file as <file>.bkp', async function () {
      const s = await load({ persist: 'on+backup', historyCount: 0, saveInterval: '0' });
      await s.update(1);
      assert.equal(fs.existsSync(stateFile('st.bkp')), false);
      await s.update(2);
      assert.equal(JSON.parse(fs.readFileSync(stateFile('st'), 'utf8')).value, 2);
      assert.equal(JSON.parse(fs.readFileSync(stateFile('st.bkp'), 'utf8')).value, 1);
    });

    it('restores from .bkp when the main file is corrupt', async function () {
      fs.mkdirSync(stateDir());
      fs.writeFileSync(stateFile('st'), '{"value": 3, "prev"');  // truncated write
      fs.writeFileSync(stateFile('st.bkp'), JSON.stringify({ value: 2, prev: 1, timestamp: 1, history: [{ val: 2, ts: 1 }] }));
      const s = await load({ persist: 'on+backup', historyCount: 2, saveInterval: '0' });
      assert.equal(s.value, 2);
      assert.equal(s.initialized, true);
      assert.ok(warnings().some(m => /restoring from backup/.test(m)), 'expected a restore warning');
      // The main file is repaired, so the next save can't push the corrupt file over the backup
      assert.equal(JSON.parse(fs.readFileSync(stateFile('st'), 'utf8')).value, 2);
      await s.update(4);
      assert.equal(JSON.parse(fs.readFileSync(stateFile('st.bkp'), 'utf8')).value, 2);
      assert.equal(JSON.parse(fs.readFileSync(stateFile('st'), 'utf8')).value, 4);
    });

    it('overwrites a corrupt main file instead of rotating it to .bkp', async function () {
      fs.mkdirSync(stateDir());
      fs.writeFileSync(stateFile('st'), '{"value": 3, "prev"');  // corrupt, no backup
      const s = await load({ persist: 'on+backup', historyCount: 2, saveInterval: '0' });
      assert.equal(s.initialized, false);
      assert.ok(warnings().some(m => /not valid/.test(m)));
      await s.update(1);
      assert.equal(fs.existsSync(stateFile('st.bkp')), false, 'corrupt file must not become the backup');
      assert.equal(JSON.parse(fs.readFileSync(stateFile('st'), 'utf8')).value, 1);
      // Once the main file is valid again, rotation resumes
      await s.update(2);
      assert.equal(JSON.parse(fs.readFileSync(stateFile('st.bkp'), 'utf8')).value, 1);
      assert.equal(JSON.parse(fs.readFileSync(stateFile('st'), 'utf8')).value, 2);
    });

    it('restores from .bkp when the main file is missing', async function () {
      fs.mkdirSync(stateDir());
      fs.writeFileSync(stateFile('st.bkp'), JSON.stringify({ value: 5, prev: 4, timestamp: 1, history: [] }));
      const s = await load({ persist: 'on+backup', historyCount: 2, saveInterval: '0' });
      assert.equal(s.value, 5);
      assert.ok(warnings().some(m => /missing, restoring from backup/.test(m)));
    });

    it('does not restore from .bkp in "on" mode', async function () {
      fs.mkdirSync(stateDir());
      fs.writeFileSync(stateFile('st'), 'not json');
      fs.writeFileSync(stateFile('st.bkp'), JSON.stringify({ value: 5, prev: 4, timestamp: 1, history: [] }));
      const s = await load({ persist: 'on', historyCount: 2, saveInterval: '0' });
      assert.equal(s.initialized, false);
      assert.ok(warnings().some(m => /not valid/.test(m)));
    });
  });

  describe('saveInterval (#13)', function () {
    for (const [label, saveInterval] of [['a missing', undefined], ['an empty', ''], ['an invalid', 'abc']]) {
      it(`treats ${label} saveInterval as 0`, async function () {
        const config = { persist: 'on', historyCount: 3 };
        if (saveInterval !== undefined) { config.saveInterval = saveInterval; }
        const s = await load(config);
        assert.equal(s.saveInterval, 0);
        await s.update(1);
        await s.update(2);
        assert.deepEqual(s.history.map(h => h.val), [2, 1]);
        assert.equal(s.history[0].val, s.value);
        assert.equal(JSON.parse(fs.readFileSync(stateFile('st'), 'utf8')).value, 2);
      });
    }

    it('still rate-limits with a valid saveInterval', async function () {
      const s = await load({ persist: 'on', historyCount: 3, saveInterval: '60000' });
      await s.update(1);
      await s.update(2);
      assert.deepEqual(s.history.map(h => h.val), [1]);
      assert.equal(JSON.parse(fs.readFileSync(stateFile('st'), 'utf8')).value, 1);
    });
  });
});
