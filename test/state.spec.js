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
  const logged = (level) => () => helper.log().args
    .map(a => a[0])
    .filter(m => m && m.level === helper.log()[level])
    .map(m => m.msg);
  const warnings = logged('WARN');
  const errors = logged('ERROR');

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

    it('finishes a pending write before close, so a redeploy loads the new value', async function () {
      const s = await load({ persist: 'on', historyCount: 0, saveInterval: '0' });
      const origRename = fs.promises.rename;
      fs.promises.rename = async (from, to) => {
        await new Promise(r => setTimeout(r, 50));
        return origRename(from, to);
      };
      try {
        s.update(1);                // not awaited: write is still in flight
        await helper.unload();      // redeploy: close the old instance...
      } finally {
        fs.promises.rename = origRename;
      }
      const s2 = await load({ persist: 'on', historyCount: 0, saveInterval: '0' });  // ...start a new one
      assert.equal(s2.value, 1);
      assert.equal(fs.existsSync(stateFile('st.tmp')), false);
      assert.equal(JSON.parse(fs.readFileSync(stateFile('st'), 'utf8')).value, 1);
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
    const read = (name) => fs.readFileSync(stateFile(name), 'utf8');

    it('writes the same content to <file>.bkp as to <file> on every save', async function () {
      const s = await load({ persist: 'on+backup', historyCount: 2, saveInterval: '0' });
      for (const v of [1, 2]) {
        await s.update(v);
        assert.equal(JSON.parse(read('st')).value, v);
        assert.equal(read('st.bkp'), read('st'));
      }
      assert.deepEqual(fs.readdirSync(stateDir()).sort(), ['st', 'st.bkp']);
    });

    it('writes both files atomically via their own .tmp and never rotates', async function () {
      const s = await load({ persist: 'on+backup', historyCount: 0, saveInterval: '0' });
      const renames = [];
      const origRename = fs.promises.rename;
      fs.promises.rename = async (from, to) => { renames.push([from, to]); return origRename(from, to); };
      try {
        await s.update(1);
        await s.update(2);
      } finally {
        fs.promises.rename = origRename;
      }
      const f = s.stateFile;
      assert.deepEqual(renames, [
        [f + '.tmp', f], [f + '.bkp.tmp', f + '.bkp'],
        [f + '.tmp', f], [f + '.bkp.tmp', f + '.bkp'],
      ]);
    });

    it('syncs the state directory after each rename, and only warns if that fails', async function () {
      if (process.platform === 'win32') { this.skip(); }
      const s = await load({ persist: 'on+backup', historyCount: 0, saveInterval: '0' });
      const dirPath = path.dirname(s.stateFile);
      const opened = [];
      const origOpen = fs.promises.open;
      fs.promises.open = async (p, flags) => {
        opened.push(p);
        if (p === dirPath) { throw Object.assign(new Error('EISDIR test'), { code: 'EISDIR' }); }
        return origOpen(p, flags);
      };
      try {
        await s.update(1);
      } finally {
        fs.promises.open = origOpen;
      }
      assert.equal(opened.filter(p => p === dirPath).length, 2);
      assert.equal(JSON.parse(read('st')).value, 1);
      assert.equal(read('st.bkp'), read('st'));
      assert.equal(warnings().filter(m => /Unable to sync state directory/.test(m)).length, 2);
    });

    it('restores from .bkp when the main file is corrupt and keeps it as .corrupt', async function () {
      fs.mkdirSync(stateDir());
      const corrupt = '{"value": 3, "prev"';  // truncated write
      const backup = JSON.stringify({ value: 2, prev: 1, timestamp: 1, history: [{ val: 2, ts: 1 }] });
      fs.writeFileSync(stateFile('st'), corrupt);
      fs.writeFileSync(stateFile('st.bkp'), backup);
      const s = await load({ persist: 'on+backup', historyCount: 2, saveInterval: '0' });
      assert.equal(s.value, 2);
      assert.equal(s.initialized, true);
      assert.ok(warnings().some(m => /not valid, restoring from backup/.test(m)), 'expected a restore warning');
      assert.equal(read('st.corrupt'), corrupt);
      assert.deepEqual(JSON.parse(read('st')), JSON.parse(backup));
      assert.equal(read('st.bkp'), backup);
      await s.update(4);
      assert.equal(JSON.parse(read('st')).value, 4);
      assert.equal(read('st.bkp'), read('st'));
      assert.equal(read('st.corrupt'), corrupt);
    });

    it('restores from .bkp when the main file is missing', async function () {
      fs.mkdirSync(stateDir());
      fs.writeFileSync(stateFile('st.bkp'), JSON.stringify({ value: 5, prev: 4, timestamp: 1, history: [] }));
      const s = await load({ persist: 'on+backup', historyCount: 2, saveInterval: '0' });
      assert.equal(s.value, 5);
      assert.ok(warnings().some(m => /missing, restoring from backup/.test(m)));
      assert.equal(JSON.parse(read('st')).value, 5);
      assert.equal(fs.existsSync(stateFile('st.corrupt')), false);
    });

    it('reports the main file error as an error when both files are unusable', async function () {
      fs.mkdirSync(stateDir());
      fs.writeFileSync(stateFile('st'), '{"value": 3, "prev"');
      fs.writeFileSync(stateFile('st.bkp'), 'not json either');
      const s = await load({ persist: 'on+backup', historyCount: 2, saveInterval: '0' });
      assert.equal(s.initialized, false);
      const e = errors();
      assert.ok(e.some(m => m.startsWith('State file is not valid, ignoring: ' + s.stateFile + ' (')), e.join('\n'));
      assert.ok(!warnings().some(m => /not valid|restoring from backup/.test(m)), warnings().join('\n'));
      assert.equal(fs.existsSync(stateFile('st.corrupt')), false);
      // The next save replaces both
      await s.update(1);
      assert.equal(JSON.parse(read('st')).value, 1);
      assert.equal(read('st.bkp'), read('st'));
    });

    it('reports a corrupt main file as an error when there is no backup', async function () {
      fs.mkdirSync(stateDir());
      fs.writeFileSync(stateFile('st'), 'not json');
      const s = await load({ persist: 'on+backup', historyCount: 2, saveInterval: '0' });
      assert.equal(s.initialized, false);
      assert.ok(errors().some(m => /^State file is not valid, ignoring: /.test(m)), errors().join('\n'));
    });

    it('removes stale .tmp files of both the main file and the backup on load', async function () {
      fs.mkdirSync(stateDir());
      fs.writeFileSync(stateFile('st'), JSON.stringify({ value: 7, prev: 6, timestamp: 1, history: [] }));
      fs.writeFileSync(stateFile('st.tmp'), '{"value": 8, "pr');
      fs.writeFileSync(stateFile('st.bkp.tmp'), '{"value": 8, "pr');
      const s = await load({ persist: 'on+backup', historyCount: 2, saveInterval: '0' });
      assert.equal(s.value, 7);
      assert.equal(fs.existsSync(stateFile('st.tmp')), false);
      assert.equal(fs.existsSync(stateFile('st.bkp.tmp')), false);
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

  describe('historyCount <= 0', function () {
    const oldHistory = [{ val: 7, ts: 3 }, { val: 6, ts: 2 }, { val: 5, ts: 1 }];

    for (const historyCount of [0, '0', -1]) {
      it(`drops old history from the file (historyCount ${JSON.stringify(historyCount)})`, async function () {
        fs.mkdirSync(stateDir());
        fs.writeFileSync(stateFile('st'), JSON.stringify({ value: 7, prev: 6, timestamp: 3, history: oldHistory }));
        const s = await load({ persist: 'on', historyCount, saveInterval: '0' });
        assert.equal(s.value, 7);
        assert.deepEqual(s.history, []);
        assert.deepEqual(s.exposedState().history, []);
        await s.update(8);
        const saved = JSON.parse(fs.readFileSync(stateFile('st'), 'utf8'));
        assert.equal(saved.value, 8);
        assert.deepEqual(saved.history, []);
      });
    }

    it('drops old history when initialized from the global context', async function () {
      const s = await load({ persist: 'on', historyCount: 0, saveInterval: '0' });
      s.initFromObj({ value: 7, prev: 6, timestamp: 3, history: oldHistory });
      assert.equal(s.value, 7);
      assert.deepEqual(s.history, []);
      assert.deepEqual(s.globalState.st.history, []);
    });

    it('clears history set in memory before saving', async function () {
      const s = await load({ persist: 'on', historyCount: 0, saveInterval: '0' });
      s.history = oldHistory.slice();
      await s.update(1);
      assert.deepEqual(s.history, []);
      assert.deepEqual(JSON.parse(fs.readFileSync(stateFile('st'), 'utf8')).history, []);
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

    it('rate-limits history with a valid saveInterval, but saves every change', async function () {
      const s = await load({ persist: 'on', historyCount: 3, saveInterval: '60000' });
      await s.update(1);
      await s.update(2);
      await s.update(3);
      assert.deepEqual(s.history.map(h => h.val), [1]);
      const saved = JSON.parse(fs.readFileSync(stateFile('st'), 'utf8'));
      assert.equal(saved.value, 3);
      assert.equal(saved.prev, 2);
      assert.deepEqual(saved.history.map(h => h.val), [1]);
    });

    it('saves every change despite saveInterval, also to the backup and without history', async function () {
      const s = await load({ persist: 'on+backup', historyCount: 0, saveInterval: '60000' });
      for (const v of [1, 2, 3]) {
        await s.update(v);
        assert.equal(JSON.parse(fs.readFileSync(stateFile('st'), 'utf8')).value, v);
        assert.equal(JSON.parse(fs.readFileSync(stateFile('st.bkp'), 'utf8')).value, v);
      }
    });

    it('records history again once saveInterval has passed', async function () {
      const s = await load({ persist: 'on', historyCount: 3, saveInterval: '1000' });
      await s.update(1);
      s.lastHistoryTs -= 1000;  // pretend the interval has passed
      await s.update(2);
      await s.update(3);
      assert.deepEqual(s.history.map(h => h.val), [2, 1]);
      assert.equal(JSON.parse(fs.readFileSync(stateFile('st'), 'utf8')).value, 3);
    });
  });
});
