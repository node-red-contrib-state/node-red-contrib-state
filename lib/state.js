/**
* The MIT License
* 
* Copyright (c) 2020, Loren West and other contributors
* 
* Permission is hereby granted, free of charge, to any person obtaining a copy
* of this software and associated documentation files (the "Software"), to
* deal in the Software without restriction, including without limitation the
* rights to use, copy, modify, merge, publish, distribute, sublicense, and/or
* sell copies of the Software, and to permit persons to whom the Software is
* furnished to do so, subject to the following conditions:
* 
* The above copyright notice and this permission notice shall be included in
* all copies or substantial portions of the Software.
* 
* THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
* IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
* FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
* AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
* LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING
* FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS
* IN THE SOFTWARE.
**/

/**
 * State
 * Node-Red Config Node: state
 * Node-Red Package: shared-state
 *
 * Attributes:
 *   initialized  - Don't rely on state until after the `change` event
 *   value        - Current state value
 *   prev         - Previous state value
 *   timestamp    - Date object of the last state change
 *   history      - Array of `{val:value, ts=timestamp Date}` objects.
 *
 * Methods:
 *   update(newState) - Change the state value. If this is different from the 
 *                      current state it will be persisted and a change event emitted.
 *
 * Events:
 *   init   - The state is being initialized on program load.
 *   change - State has changed. This object is passed with the event.
 */
const fs = require('fs')
const fsp = fs.promises
const path = require('path')
const convertUnits = require('convert-units');

let RED;
const state = module.exports = function(red) {
  RED = red;
  RED.nodes.registerType("shared-state", stateNode);
  stateNode.registerEndpoints(RED);
}

const PERSIST_MODES = ['off', 'on', 'on+backup'];

// Persistence mode for a state config. Nodes created before the "persist"
// option existed only persisted when history was kept, so keep that behavior.
const resolvePersist = state.resolvePersist = function(config) {
  if (PERSIST_MODES.indexOf(config.persist) >= 0) {
    return config.persist;
  }
  return parseInt(config.historyCount, 10) > 0 ? 'on' : 'off';
}

// Minimum ms between history entries. Missing or invalid values mean "save every change" (#13).
const resolveSaveInterval = state.resolveSaveInterval = function(config) {
  let interval = parseInt(config.saveInterval, 10);
  return (isNaN(interval) || interval < 0) ? 0 : interval;
}

// Whether a state config keeps any history at all.
const keepsHistory = state.keepsHistory = function(config) {
  return parseInt(config.historyCount, 10) > 0;
}

// The Node-RED node for state
class stateNode {

  constructor(config) {
    let node = this;
    RED.nodes.createNode(node, config);
    let globalContext = node.context().global;
    node.id = config.id;
    node.name = config.name;
    node.config = config;
    node.persist = resolvePersist(config);
    node.saveInterval = resolveSaveInterval(config);
    node.lastHistoryTs = 0;

    node.initialized = false;
    node.value = "";
    node.prev = "";
    node.timestamp = 0;
    node.history = [];

    let stateDir = globalContext.get('sharedStateDir') || './shared-state';
    node.stateFile = stateDir + '/' + node.name;
    if (node.persist !== 'off') {
      try { fs.mkdirSync(stateDir, { recursive: true }); }
      catch (e) {
        node.error('Unable to create storage directory: ' + stateDir);
        node.error(e);
      }
    }

    // Initialize from global context if available
    if (globalContext.keys().indexOf('state') < 0) {
      globalContext.set('state', {});
    }
    node.globalState = globalContext.get('state');
    let thisState = node.globalState[node.name];
    if (thisState) {
      node.initFromObj(thisState);
    }

    // Initialize from the filesystem on Node-RED reboot. All file I/O for this
    // node is chained on node.io so loads and writes never overlap.
    node.io = Promise.resolve();
    // "off" still loads an existing file (as before), it just never writes.
    if (!node.initialized) {
      node.io = node.initFromFS().catch((e) => {
        node.error('Error reading state file: ' + node.stateFile);
        node.error(e);
      });
    }

    // Set pre-initialized global state
    if (!node.initialized) {
      node.globalState[node.name] = node.exposedState();
    }

    // On redeploy/shutdown, let pending file I/O finish before the node is
    // gone, so a new instance never races an unfinished write.
    node.on('close', function(removed, done) {
      node.io.then(() => done(), () => done());
    });
  }

  // Produce an object to be shared as state
  exposedState() {
    let node = this;
    return {
      value: node.value,
      prev: node.prev,
      timestamp: node.timestamp,
      history: node.history,
      config: node.config,
    };
  }

  // Update the state
  async update(newState, fromMsg) {
    let node = this;
    // Ignore undefined values (e.g. msg.payload missing) rather than crashing
    // on JSON.parse(undefined) below. See issue #18.
    if (newState === undefined) {
      node.warn('Ignoring undefined value for shared state: ' + node.name);
      return;
    }
    let typedNewState = node.getTypedValue(newState, fromMsg);
			// @colincoder Changes to deal with issues when the node type is Object
    let newvalstr = JSON.stringify(typedNewState);
    let currentvalstr = JSON.stringify(node.value);
    if (newvalstr === undefined) {
      node.warn('Ignoring value that cannot be serialized for shared state: ' + node.name);
      return;
    }
    if (newvalstr == currentvalstr) {
		return;
	}

	// With objects this makes prev and value share the same memory which 
	// makes the .prev value and .value value point to the same Object. 
	// So create new objects so that the comparison above detects an actual change.
	// This fix will work for non-objects too.
	//    node.prev = node.value;
	//    node.value = typedNewState;
    node.prev = currentvalstr === undefined ? undefined : JSON.parse(currentvalstr);
    node.value = JSON.parse(newvalstr);
			// @colincoder End of changes to deal with issues when the node type is Object
    node.timestamp = Date.now();
    node.initialized = true;
    try {
      // saveInterval only rate-limits history entries; the state file always
      // gets the current value.
      if (keepsHistory(node.config) && node.timestamp - node.lastHistoryTs >= node.saveInterval) {
        node.lastHistoryTs = node.timestamp;
        node.history.splice(0,0,{val:node.value, ts:node.timestamp});
        node.trimHistory();
      }
      if (node.persist !== 'off') {
        await node.save();
      }
      node.globalState[node.name] = node.exposedState();
      node.emit('change', node.exposedState());
    } 
    catch (e) {
      node.error('Error writing state file: ' + node.stateFile);
      node.error(e);
    }

  }

  // Perform simple data type conversions
  getTypedValue(newState, fromMsg) {
    let node = this;
    let fnName = "getTypedValue_" + node.config.dataType;
    let fromConfig = (fromMsg && fromMsg.state && fromMsg.state.config) ? fromMsg.state.config : {};
    if (!node[fnName]) {return newState}
    return node[fnName](newState, fromConfig);
  }

  getTypedValue_str(newState, fromConfig) {
    let node = this;
    let val = '' + newState;
    if (val[0] == '[' && val.match(/^\[object Object\].*/)) {
      try {
        return JSON.stringify(newState);
      } catch(e){};
    }
    return val;
  }

  getTypedValue_bool(newState, fromConfig) {
    let node = this;
    let boolType = node.config.boolType; // bool, num, str
    let boolStrTrue = node.config.boolStrTrue || 'on'; // On, Active, ...
    let boolStrFalse = node.config.boolStrFalse || 'off';  // Off, Inactive, ...

    // Convert newState to boolean if coming from another boolean state node
    if (fromConfig.dataType == 'bool' && fromConfig.boolType == 'str' && fromConfig.boolStrTrue) {
      newState = (newState == fromConfig.boolStrTrue);
    }

    // Assign to boolean if coming in as a number or number-like string
    if (Number(newState) + '' == (newState + '').trim()) {
      newState = Number(newState);
    }
    if ((typeof newState) === 'number') {
      newState = !!newState;
    }

    // Assign to boolean if coming in as a string
    if ((typeof newState) === 'string') {
      newState = newState.trim().toLowerCase();
      // Try the known string first
      if (boolType == 'str' && (newState == boolStrTrue.toLowerCase() || newState == boolStrFalse.toLowerCase())) {
        newState = (newState == boolStrTrue.toLowerCase());
      }
      // Process the only sane string conversions ("1" and "0" processed as numbers earlier)
      else if (newState == 'true' || newState == 'false') {
        newState = (newState == 'true');
      }
      // Fallback to regular javascript string->boolean mapping
      else {
        newState = !!newState;
      }
    }

    // Assign to correct boolean mapping
    if (boolType == 'str') {
      return (newState ? boolStrTrue : boolStrFalse);
    }
    else if (boolType == 'num') {
      return (newState ? 1 : 0);
    }
    return !!newState;
  }

  getTypedValue_num(newState, fromConfig) {
    let node = this;
    newState = parseFloat(newState); // Force a number
    if (isNaN(newState)) {
      return newState; // Fail miserably if source can't be made a number
    }

    // Convert units if coming from another numeric node
    if (node.config.unit && fromConfig.dataType == 'num' && fromConfig.unit) {
      try {
        newState = convertUnits(newState).from(fromConfig.unit).to(node.config.unit);
        newState = Number(newState.toFixed(10)); // Don't convert to extremely large precisions
      } catch(e){
        // Don't create a number if it can't be used.
        newState = NaN;
      }
    }

    // Round to precision
    if (node.config.precision) {
      newState = Number(newState.toFixed(node.config.precision));
    }

    // Apply min/max
    if (node.config.numMin && newState < node.config.numMin) {
      newState = node.config.numMin;
    }
    if (node.config.numMax && newState > node.config.numMax) {
      newState = node.config.numMax;
    }

    return newState;
  }

  getTypedValue_obj(newState, fromConfig) {
    let node = this;
    // Try JSON parsing a string
    if (typeof newState === 'string') {
      try {
        newState = JSON.parse(newState);
      } catch(e) {}
    }
    return newState;
  }

  // history[0] = current, history[1] = current - 1, history[2] = current - 2, ...
  trimHistory() {
    let node = this;
    let trimNum = node.history.length - node.config.historyCount;
    if (trimNum > 0) {
      node.history.splice(node.history.length - trimNum, trimNum);
    }
  }

  // Initialize from an external state object
  initFromObj(external) {
    let node = this;
    node.value = external.value;
    node.prev = external.prev;
    node.timestamp = external.timestamp;
    // Without history configured, drop any history from an older file or context
    node.history = (keepsHistory(node.config) && Array.isArray(external.history)) ? external.history : [];
    node.lastHistoryTs = (node.history[0] && node.history[0].ts) || 0;
    node.globalState[node.name] = node.exposedState();
    node.emit('init', node.exposedState());
    node.initialized = true;
  }

  // Write the current state to disk. Serialized through node.io.
  save() {
    let node = this;
    if (!keepsHistory(node.config)) {
      node.history = [];
    }
    let data = JSON.stringify(node.exposedState());
    let result = node.io.then(() => node.writeStateFile(data));
    node.io = result.catch(() => {});
    return result;
  }

  // Atomic write: write <file>.tmp, flush it, rename it over <file>, then
  // flush the directory so the rename itself survives a power loss.
  async writeAtomic(file, data) {
    let node = this;
    let tmp = file + '.tmp';
    let handle = await fsp.open(tmp, 'w');
    try {
      await handle.writeFile(data);
      await handle.sync();
    } finally {
      await handle.close();
    }
    await fsp.rename(tmp, file);
    // Directories can't be opened for fsync on Windows.
    if (process.platform !== 'win32') {
      let dir = path.dirname(file);
      try {
        let dirHandle = await fsp.open(dir, 'r');
        try { await dirHandle.sync(); }
        finally { await dirHandle.close(); }
      } catch (e) {
        node.warn('Unable to sync state directory: ' + dir + ' (' + e.message + ')');
      }
    }
  }

  // Write <file>, and with "on+backup" also <file>.bkp with the same content.
  async writeStateFile(data) {
    let node = this;
    await node.writeAtomic(node.stateFile, data);
    if (node.persist === 'on+backup') {
      await node.writeAtomic(node.stateFile + '.bkp', data);
    }
  }

  // Read and parse a state file. Returns undefined if it doesn't exist,
  // throws if it exists but isn't valid JSON.
  async readStateFile(file) {
    let content;
    try {
      content = await fsp.readFile(file, 'utf8');
    } catch (e) {
      if (e.code === 'ENOENT') { return undefined; }
      throw e;
    }
    let obj = JSON.parse(content);
    if (!obj || typeof obj !== 'object') {
      throw new Error('State file does not contain a state object');
    }
    return obj;
  }

  // Initialize state from the filesystem
  async initFromFS() {
    let node = this;
    let file = node.stateFile;
    let bkpFile = file + '.bkp';

    // A leftover .tmp means a write was interrupted; it was never committed.
    // "off" never touches the files, so it leaves these alone.
    if (node.persist !== 'off') {
      for (let tmp of [file + '.tmp', bkpFile + '.tmp']) {
        try { await fsp.unlink(tmp); }
        catch (e) { /* no stale tmp file */ }
      }
    }

    let obj, mainError;
    try {
      obj = await node.readStateFile(file);
    } catch (e) {
      mainError = e;
    }

    if (obj === undefined && node.persist === 'on+backup') {
      let bkp;
      try {
        bkp = await node.readStateFile(bkpFile);
      } catch (e) {
        // Only worth mentioning on its own if there's no main file error to report
        if (!mainError) {
          node.warn('State backup file is not valid, ignoring: ' + bkpFile + ' (' + e.message + ')');
        }
      }
      if (bkp !== undefined) {
        node.warn((mainError ? 'State file is not valid' : 'State file is missing') +
          ', restoring from backup: ' + bkpFile);
        try {
          // Keep the broken file for inspection instead of silently discarding it
          if (mainError) {
            try { await fsp.rename(file, file + '.corrupt'); }
            catch (e) { if (e.code !== 'ENOENT') { throw e; } }
          }
          await node.writeAtomic(file, JSON.stringify(bkp));
        } catch (e) {
          node.error('Unable to restore state file from backup: ' + file);
          node.error(e);
        }
        obj = bkp;
        mainError = undefined;
      }
    }

    if (mainError) {
      node.warn('State file is not valid, ignoring: ' + file + ' (' + mainError.message + ')');
    }
    if (obj !== undefined && !node.initialized) {
      node.initFromObj(obj);
    }
  }

}

// Register config support endpoints
stateNode.registerEndpoints = function(RED) {
  RED.httpAdmin.get('/shared-state/units', RED.auth.needsPermission('sharedstate.read'), function(req, response) {
    response.json(convertUnits().list());
  });
}
