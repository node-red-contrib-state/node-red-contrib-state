const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const helper = require('node-red-node-test-helper');
const stateNode = require('../lib/state');
const getStateNode = require('../lib/getState');
const setStateNode = require('../lib/setState');
const injectNode = require('@node-red/nodes/core/common/20-inject');
const debugNode = require('@node-red/nodes/core/common/21-debug');
const functionNode = require('@node-red/nodes/core/function/10-function');
const changeNode = require('@node-red/nodes/core/function/15-change');

const nodes = [stateNode, getStateNode, setStateNode, injectNode, debugNode, functionNode, changeNode];
const examplesDir = path.join(__dirname, '..', 'examples');
const load = (file) => JSON.parse(fs.readFileSync(path.join(examplesDir, file), 'utf8'));
const byName = (flow, type, name) => flow.find(n => n.type === type && n.name === name).id;

// Resolves with the next message (or the next `count` messages) a node receives.
const nextInput = (id, count = 1) => new Promise(resolve => {
  const msgs = [];
  const node = helper.getNode(id);
  const onInput = (msg) => {
    msgs.push(msg);
    if (msgs.length === count) {
      node.removeListener('input', onInput);
      resolve(count === 1 ? msgs[0] : msgs);
    }
  };
  node.on('input', onInput);
});

describe('example flows', function () {
  this.timeout(10000);
  let dir;
  beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'state-examples-')); process.chdir(dir); });
  afterEach(async () => { await helper.unload(); fs.rmSync(dir, { recursive: true, force: true }); });

  const stateNames = new Map();
  for (const file of fs.readdirSync(examplesDir).filter(f => f.endsWith('.json'))) {
    it(`${file} has its own tab, config nodes, unique state names and Persist Off`, function () {
      const flow = load(file);
      const tabs = flow.filter(n => n.type === 'tab');
      assert.equal(tabs.length, 1);
      for (const n of flow) {
        if (n.type === 'tab' || n.type === 'shared-state') { assert.equal(n.z, undefined); continue; }
        assert.equal(n.z, tabs[0].id, `${n.id} is on the example tab`);
        if (n.state) { assert.ok(flow.some(c => c.id === n.state && c.type === 'shared-state')); }
      }
      for (const s of flow.filter(n => n.type === 'shared-state')) {
        if (file !== 'persistence.json') { assert.equal(s.persist, 'off', `${s.name} has Persist Off`); }
        assert.ok(!stateNames.has(s.name), `${s.name} is also used in ${stateNames.get(s.name)}`);
        stateNames.set(s.name, file);
      }
    });
  }

  it('example ids are unique across all files', function () {
    const ids = fs.readdirSync(examplesDir).filter(f => f.endsWith('.json')).flatMap(f => load(f).map(n => n.id));
    assert.equal(new Set(ids).size, ids.length);
  });

  it('basic.json sends the injected value to the debug node', async function () {
    const flow = load('basic.json');
    await helper.load(nodes, flow);
    const got = nextInput(byName(flow, 'debug', 'Value'));
    helper.getNode(byName(flow, 'inject', 'Set to timestamp')).receive({});
    assert.equal(typeof (await got).payload, 'number');
  });

  it('persistence.json saves state and backup to disk', async function () {
    const flow = load('persistence.json');
    await helper.load(nodes, flow);
    const debugId = flow.find(n => n.type === 'debug').id;
    const got = nextInput(debugId);
    helper.getNode(flow.find(n => n.type === 'inject').id).receive({});
    await got;
    const saved = JSON.parse(fs.readFileSync(path.join(dir, 'shared-state', 'examplePersisted'), 'utf8'));
    assert.equal(saved.history.length, 1);
    assert.ok(fs.existsSync(path.join(dir, 'shared-state', 'examplePersisted.bkp')));
  });

  it('global-context.json reads the state with a function node and a change node', async function () {
    const flow = load('global-context.json');
    await helper.load(nodes, flow);
    for (const [inject, expected] of [['Occupied', true], ['Not occupied', false]]) {
      const fromFunction = nextInput(byName(flow, 'debug', 'From function'));
      const fromChange = nextInput(byName(flow, 'debug', 'From change'));
      helper.getNode(byName(flow, 'inject', inject)).receive({});
      assert.strictEqual((await fromFunction).payload, expected);
      assert.strictEqual((await fromChange).occupied, expected);
    }
  });

  it('units.json converts C to F through msg.state.config', async function () {
    const flow = load('units.json');
    await helper.load(nodes, flow);
    for (const [inject, expected] of [['21.5 C', 70.7], ['100 C', 212]]) {
      const got = nextInput(byName(flow, 'debug', 'Temperature (F)'));
      helper.getNode(byName(flow, 'inject', inject)).receive({});
      const msg = await got;
      assert.strictEqual(msg.payload, expected);
      assert.equal(msg.state.config.unit, 'F');
    }
  });

  it('logical-state.json derives examplePersonInRoom from motion and door', async function () {
    const flow = load('logical-state.json');
    await helper.load(nodes, flow);
    const debugId = byName(flow, 'debug', 'Person in room');
    const press = (name) => helper.getNode(byName(flow, 'inject', name)).receive({});

    let got = nextInput(debugId);
    press('Motion');
    assert.strictEqual((await got).payload, true);

    got = nextInput(debugId);
    press('Door open');
    assert.strictEqual((await got).payload, false);

    got = nextInput(debugId);
    press('Door closed');
    assert.strictEqual((await got).payload, true);

    got = nextInput(debugId);
    press('No motion');
    assert.strictEqual((await got).payload, false);
  });
});
