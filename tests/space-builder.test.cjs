// Execute the actual mod with in-memory Herdr I/O. No real spaces are changed.
const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const folder = path.resolve(__dirname, '../mods/space-builder');
const configSource = fs.readFileSync(path.join(folder, 'config.js'), 'utf8').replace(/^export /gm, '');
const source = fs.readFileSync(path.join(folder, 'main.js'), 'utf8')
  .replace(/^import[\s\S]*?from "[^"]+";\n/gm, '')
  .replace('export default class SpaceBuilder', 'class SpaceBuilder');
const STATE = 'space-builder.operations';
const result = (value = {}) => ({code: 0, stdout: JSON.stringify(value), stderr: ''});
const shell = () => ({shell: true, agent: false, name: 'bash', key: 'shell'});
const config = (extra = {}) => ({name: 'example', tabs: [{name: 'dev', panes: [{id: 'root'}]}], ...extra});
const location = (folder = '/repo') => ({space: null, tab: null, pane: null, root: folder, cwd: folder, on: null, fresh: false});
function fixture() {
  const env = {spaces: [], panes: [], machines: [{name: null, layout: 'ready'}, {name: 'remote', layout: 'ready'}],
    state: {}, calls: [], sends: [], notices: [], tasks: [], timers: [], focus: null, next: 0, missing: [],
    homeFails: false, failClose: false, root: '/repo', notifications: 0, closed: false, textFiles: {},
    commands: [], waiters: [], commandRequests: 0, overlayCloses: 0, now: Date.now()};
  env.handlers = {};
  env.paints = [];
  const element = () => {
    let id;
    const el = new Proxy({}, {get: (_o, key) => (...args) => {
      if (key === 'id') id = args[0];
      if (['bg', 'text_color', 'border_color'].includes(key)) env.paints.push({id,kind:key,color:args[0]});
      if (id && String(key).startsWith('on_')) (env.handlers[id] ??= {})[key] = args[0];
      if (key === 'when' && args[0]) args[1](el);
      return el;
    }});
    return el;
  };
  const removeSpace = (id) => {
    const tabs = new Set(env.spaces.find(s => s.id === id)?.tabs.map(t => t.id));
    env.panes = env.panes.filter(p => !tabs.has(p.tab));
    env.spaces = env.spaces.filter(s => s.id !== id);
  };
  const makePane = (tab, cwd) => {
    const id = ++env.next;
    const pane = {pane: `pane-${id}`, terminal: `terminal-${id}`, tab, cwd, status: null, program: shell()};
    env.panes.push(pane);
    return pane;
  };
  env.command = value => {
    const waiting = env.waiters.shift();
    if (waiting) waiting(value);
    else env.commands.push(value);
  };
  const context = {
    Date: class extends Date { static now() { return env.now; } },
    View: class {}, div: element, svg: element, v_flex: element, h_flex: element,
    Input: {new: element},
    InputState: {new: () => {
      const handlers = {}, input = {text: '', handlers, focusCount: 0,
        on(name, fn) {handlers[name] = fn;}, value() {return input.text;},
        set_value(text) {input.text = text;}, focus() {input.focusCount++;}};
      return input;
    }},
    spaces: () => env.spaces, panes: () => env.panes, machines: () => env.machines,
    shared: key => env.state[key], setShared: (key, value) => {env.state[key] = value;},
    home: () => '/home/local', appHome: () => '/mock',
    focused: () => ({space: env.spaces.find(s => s.active)?.id, cwd: env.cwd ?? '/repo'}),
    props: () => env.bare ? {} : ({overlay: 'test-overlay'}), keys: () => [], theme: () => env.palette ?? ({}),
    nextCommand: () => {
      env.commandRequests++;
      return new Promise(resolve => {
        if (env.commands.length) resolve(env.commands.shift());
        else env.waiters.push(resolve);
      });
    },
    closeOverlay: () => {env.closed = true; env.overlayCloses++;}, notify: item => env.notices.push(item),
    run: (cmd, args) => env.calls.push([cmd, args]), console,
    pickFolder: async () => env.picked ?? null,
    readTextFile: async file => {if (env.onRead) await env.onRead(file);return env.textFiles[file] ?? null;},
    hc: async args => {env.sends.push(args); if (env.onSend) await env.onSend(args); return result();},
    exec: async (cmd, args, options) => {
      if (cmd === 'git') return {code: 0, stdout: env.root, stderr: ''};
      if (['sh', 'pwsh', 'powershell'].includes(cmd)) {
        if (env.probeHook) return env.probeHook(cmd, args, options);
        const script = args[args.length - 1];
        if (script.includes('$HOME')) {
          env.calls.push(['home', options.on]);
          if (env.homeFails) throw new Error('transport unavailable');
          return {code: 0, stdout: '/home/remote', stderr: ''};
        }
        env.calls.push(['check-folder', script]);
        return {code: env.missing.some(dir => script.includes(dir)) ? 1 : 0, stdout: '', stderr: ''};
      }
      assert.equal(cmd, 'herdr-app');
      const command = args[1];
      // Herdr accepts one JSON object, or flags whose values are parsed as JSON
      // when possible (so --name 123 is a number, not a string).
      const params = args[2]?.startsWith('{') ? JSON.parse(args[2]) : {};
      if (!args[2]?.startsWith('{')) for (let i = 2; i < args.length; i += 2) {
        let value;
        try { value = JSON.parse(args[i + 1]); } catch { value = args[i + 1]; }
        params[args[i].slice(2)] = value;
      }
      env.calls.push([command, params]);
      for (const key of ['name', 'tab', 'machine', 'folder', 'space', 'id', 'pane', 'direction']) {
        if (params[key] != null && typeof params[key] !== 'string') {
          return {code: 1, stdout: '', stderr: `${key} must be a string`};
        }
      }
      if (env.beforeCommand) await env.beforeCommand(command, params);
      if (env.failCommand === command) return {code: 1, stdout: '', stderr: `failed ${command}`};
      if (command === 'space.close') {
        if (env.failClose) return {code: 1, stdout: '', stderr: 'close unavailable'};
        removeSpace(params.id);
      } else if (command === 'space.new') {
        const id = ++env.next, space = `space-${id}`, tab = `tab-${id}`;
        const p = makePane(tab, params.folder || env.nativeCwd || env.cwd || '/repo');
        env.spaces.push({id: space, machine: params.machine || null, folder: params.folder,
          name: params.name || 'repo', named: !!params.name, tabs: [{id: tab, name: params.tab || '1', named: !!params.tab}]});
        return result({space, tab, pane: p.pane, terminal: p.terminal});
      } else if (command === 'tab.new') {
        const tab = `tab-${++env.next}`, space = env.spaces.find(s => s.id === params.space);
        space.tabs.push({id: tab, name: params.name || '2', named: !!params.name});
        const p = makePane(tab, params.folder || env.nativeCwd || env.cwd || '/repo');
        return result({tab, pane: p.pane, terminal: p.terminal});
      } else if (command === 'pane.split') {
        const parent = env.panes.find(p => p.pane === params.pane);
        assert.ok(parent, 'explicit split parent must exist');
        const p = makePane(parent.tab, parent.cwd);
        env.focus = p.pane;
        return result({pane: p.pane, terminal: p.terminal});
      } else if (command === 'pane.close') {
        env.panes = env.panes.filter(p => p.pane !== params.pane);
      } else if (command === 'tab.close') {
        env.spaces.forEach(s => {s.tabs = s.tabs.filter(t => t.id !== params.id);});
        env.panes = env.panes.filter(p => p.tab !== params.id);
      } else if (command === 'space.rename') {
        const space = env.spaces.find(s => s.id === params.id);
        if (space) Object.assign(space, {name: params.name || 'repo', named: !!params.name});
      } else if (command === 'tab.rename') {
        const tab = env.spaces.flatMap(s => s.tabs).find(t => t.id === params.id);
        if (tab) Object.assign(tab, {name: params.name || '1', named: !!params.name});
      } else if (command === 'pane.focus') {
        env.focus = params.pane;
      }
      return result();
    },
  };
  vm.createContext(context);
  vm.runInContext(configSource + '\n' + source + '\nthis.api={SpaceBuilder, validate, norm, pathKey, expand, homeOn, spaceKey, nameOf, parseConfigs, targetOf, withCd, Cancelled};', context);
  const api = context.api, builder = new api.SpaceBuilder();
  Object.assign(builder, {busy: false, loading: false, browsing: false, closed: false, created: null, operation: null,
    query: '', configState: 'found', input: {focus() {}}, handle: {focus() {}}, globalSpaces: [], globalMeta: [], where: location(), selected: 0, top: 0});
  const schedule = (ms, fn, repeat) => {
    const task = {at: env.now + ms, ms, fn, repeat, active: true,
      cancel() {task.active = false;}, is_done() {return !task.active;}};
    env.timers.push(task);
    return task;
  };
  const cx = {notify: () => env.notifications++, stop_propagation() {}, focus_handle: () => ({focus() {}}),
    timer: {after: (ms, fn) => schedule(ms, fn, false), every: (ms, fn) => schedule(ms, fn, true)},
    spawn: fn => env.tasks.push(Promise.resolve().then(() => fn(cx))),
    sleep: async () => {if (env.onSleep) await env.onSleep();},
  };
  env.advance = ms => {
    const end = env.now + ms;
    for (;;) {
      const task = env.timers.filter(t => t.active && t.at <= end).sort((a, b) => a.at - b.at)[0];
      if (!task) break;
      env.now = task.at;
      if (!task.repeat) task.active = false;
      task.fn(cx);
      if (task.repeat && task.active) task.at = env.now + task.ms;
    }
    env.now = end;
  };
  const flush = async () => {for (let i = 0; i < env.tasks.length; i++) await env.tasks[i];};
  const addFresh = () => {
    const p = makePane('old-tab', '/repo');
    const space = {id: 'old-space', name: 'repo', named: false, active: true, machine: null,
      folder: '/repo', tabs: [{id: 'old-tab', name: '1', named: false, active: true}]};
    env.spaces.push(space);
    return {space, pane: p};
  };
  return {api, builder, env, cx, flush, addFresh};
}
const mutations = env => env.calls.filter(([cmd]) => /^(space\.|tab\.|pane\.|terminal\.)/.test(cmd));
const rootConfig = (dir = '/repo', extra = {}) => config({tabs:[{name:'dev',panes:[{id:'root',working_dir:dir}]}],...extra});
const plain = value => JSON.parse(JSON.stringify(value));
const load = async (builder, list) => {builder.globalSpaces=list;await builder.resolveGlobals();};
const initialize = (builder,env,cx) => {env.bare=true;builder.init({},cx);env.bare=false;};
const existing = (env,name='example',machine=null,id='existing') => {
  const space={id,name,machine,named:true,folder:'/unrelated',tabs:[]};env.spaces.push(space);return space;
};

test('builds tabs and explicit topology with each tab root directory inherited independently', async () => {
  const {builder,env,cx,flush}=fixture();
  const data=config({tabs:[{name:'dev',panes:[
    {id:'root',working_dir:'/repo/src',command:'nvim'},
    {id:'other',working_dir:'tools',command:'codex',split_from:'root',split:'right'},
    {id:'inherit',split_from:'other',split:'down'}]},
    {name:'git',panes:[{id:'git',working_dir:'/repo/test',command:'lazygit'},{id:'shell',split_from:'git',split:'right'}]}]});
  builder.startBuild(data,cx);await flush();
  assert.equal(env.notices.length,0);assert.equal(env.spaces.length,1);
  assert.deepEqual(env.spaces[0].tabs.map(t=>t.name),['dev','git']);assert.equal(env.panes.length,5);
  assert.match(env.sends[0][2],/cd '\/repo\/src' && nvim/);
  assert.match(env.sends[1][2],/cd '\/repo\/src\/tools' && codex/);
  assert.equal(env.sends[2][2],"cd '/repo/src'");assert.equal(env.sends[4][2],"cd '/repo/test'");
  const splits=env.calls.filter(([c])=>c==='pane.split');
  assert.equal(splits[1][1].pane,env.panes[1].pane);assert.notEqual(splits[1][1].pane,splits[0][1].pane);
  assert.equal(env.focus,env.panes[0].pane);assert.equal(env.closed,true);
  assert.equal(Object.keys(env.state[STATE]).length,0);assert.equal(env.sends.some(a=>a[2].endsWith('\n')),false);
  await builder.close();assert.equal(env.spaces.length,1);
});

for (const wd of [undefined,null,'']) test(`missing child working_dir ${String(wd)} inherits root instead of split parent`,async()=>{
  const {builder}=fixture();const plan=await builder.preflight(config({tabs:[{panes:[
    {id:'root',working_dir:'/root'}, {id:'parent',working_dir:'/other',split_from:'root',split:'right'},
    {id:'child',working_dir:wd,split_from:'parent',split:'down'}]}]}));
  assert.deepEqual(Array.from(plan.tabs[0].panes,p=>p.dir),['/root','/other','/root']);
});

for (const command of [undefined,'pwd']) test(`unspecified root keeps Herdr default without synthetic cd (${String(command)})`,async()=>{
  const {builder,env,cx,flush}=fixture();env.nativeCwd='/native-default';
  builder.startBuild(config({tabs:[{panes:[{id:'root',command},{id:'child',split_from:'root',split:'right'}]}]}),cx);await flush();
  const made=env.calls.find(([c])=>c==='space.new');assert.equal('folder' in made[1],false);
  if(command) assert.equal(env.sends[0][2],'pwd');
  assert.equal(env.sends.at(-1)[2],"cd '/native-default'");assert.equal(env.notices.length,0);
});

test('an unspecified later tab uses native tab default and its children inherit that root',async()=>{
  const {builder,env,cx,flush}=fixture();env.nativeCwd='/later-default';
  builder.startBuild(config({tabs:[{panes:[{id:'r',working_dir:'/first'}]},
    {panes:[{id:'r'},{id:'c',working_dir:'child',split_from:'r',split:'right'}]}]}),cx);await flush();
  assert.equal('folder' in env.calls.find(([c])=>c==='tab.new')[1],false);
  assert.equal(env.sends.at(-1)[2],"cd '/later-default/child'");
});

test('relative root paths resolve against focused target cwd, and child paths against root',async()=>{
  const {builder,env}=fixture();env.cwd='/focused';
  const plan=await builder.preflight(config({tabs:[{panes:[{id:'r',working_dir:'src'},{id:'c',working_dir:'test',split_from:'r',split:'down'}]}]}));
  assert.deepEqual(Array.from(plan.tabs[0].panes,p=>p.dir),['/focused/src','/focused/src/test']);
});

test('native default roots defer dependent child paths instead of probing a guessed directory',async()=>{
  const {builder,env}=fixture();env.cwd='/original';env.missing=['/original/tests'];
  const plan=await builder.preflight(config({tabs:[
    {panes:[{id:'root',working_dir:'/project'}]},
    {panes:[{id:'root'},{id:'tests',working_dir:'tests',split_from:'root',split:'right'}]}
  ]}));
  assert.equal(plan.tabs[1].root.dir,null);
  assert.equal(plan.tabs[1].panes[1].dir,null);
  assert.equal(env.calls.some(([c,script])=>c==='check-folder' && script.includes('/original/tests')),false);
});

test('runtime paths under default roots are validated before any tab command is submitted',async()=>{
  const {builder,env,cx,flush}=fixture();env.nativeCwd='/native';env.missing=['/native/missing'];
  builder.startBuild(config({tabs:[{panes:[{id:'root',command:'pwd'},
    {id:'child',working_dir:'missing',split_from:'root',split:'right'}]}]}),cx);
  await flush();assert.equal(env.sends.length,0);assert.equal(env.spaces.length,0);
  assert.match(env.notices[0].body,/Folder does not exist/);
});

test('live name and machine detect open spaces without tracking or folder matching',async()=>{
  const {builder,env,cx}=fixture();const s=existing(env);await load(builder,[config()]);
  assert.equal(builder.entries()[0].open,true);assert.equal(builder.askReload(config(),cx),true);assert.equal(builder.pending.space,s.id);
  env.state['space-builder.spaces']={stale:{space:s.id,name:'obsolete'}};
  s.name='renamed';assert.equal(builder.entries()[0].open,false);assert.equal(builder.askReload(config(),cx),false);
});

test('same name on different machines is independent; omitted and blank machine mean local',async()=>{
  const {builder,env,api}=fixture();existing(env,'example','remote','remote/x');
  await load(builder,[config(),config({machine:'remote'}),config({name:'other',machine:' '})]);
  assert.equal(builder.openInfo(0).open,false);assert.equal(builder.openInfo(1).open,true);
  assert.equal(api.targetOf(config({machine:''})),null);assert.equal(api.targetOf(config({machine:' remote '})),'remote');
  assert.notEqual(api.spaceKey(config()),api.spaceKey(config({machine:'remote'})));
  env.spaces[0].name='Example';assert.equal(builder.openInfo(1).open,false,'names match case sensitively');
});

test('duplicate config pairs are disabled, while identical names on different machines are valid',async()=>{
  const {builder}=fixture();await load(builder,[config(),config({machine:' '}),config({machine:'remote'})]);
  assert.match(builder.globalMeta[0].error,/Duplicate/);assert.match(builder.globalMeta[1].error,/Duplicate/);
  assert.equal(builder.entryEnabled({index:2}),true);
});

test('invalid machine fields do not shadow a valid configuration identity',async()=>{
  const {builder}=fixture();await load(builder,[config({machine:{}}),config()]);
  assert.match(builder.globalMeta[0].error,/Space machine/);
  assert.equal(builder.entryEnabled({index:1}),true);
});

test('ambiguous live pairs report an error without closing or building any space',async()=>{
  const {builder,env,cx,flush}=fixture();existing(env);existing(env,'example',null,'second');await load(builder,[config()]);
  builder.choose(0,cx);await flush();assert.match(env.notices[0].body,/Multiple spaces/);assert.equal(mutations(env).length,0);
});

for(const change of ['rename','machine','duplicate','replace']) test(`reload rechecks confirmed identity after preflight: ${change}`,async()=>{
  const {builder,env,cx,flush}=fixture();const s=existing(env);assert.equal(builder.askReload(rootConfig(),cx),true);
  const original=builder.preflight.bind(builder);builder.preflight=async data=>{
    const plan=await original(data);
    if(change==='rename')s.name='archived';
    if(change==='machine')s.machine='remote';
    if(change==='duplicate')existing(env,'example',null,'other');
    if(change==='replace'){env.spaces=[];existing(env,'example',null,'replacement');}
    return plan;
  };
  builder.reload(cx);await flush();assert.equal(mutations(env).length,0);assert.equal(env.notices.length,1);
});

for(const kind of ['schema','pane directory','machine']) test(`reload preflights ${kind} before closing existing terminals`,async()=>{
  const {builder,env,cx,flush}=fixture();const s=existing(env);const data=rootConfig();
  if(kind==='schema')data.tabs[0].panes.push({id:'root'});
  if(kind==='pane directory')env.missing=['/repo'];
  if(kind==='machine')env.machines[0].layout='unavailable';
  builder.pending={data,name:'example',space:s.id};builder.reload(cx);await flush();
  assert.equal(env.spaces[0].id,s.id);assert.equal(mutations(env).length,0);assert.equal(env.notices.length,1);
});

test('reload replaces the confirmed same-name same-machine space after preflight',async()=>{
  const {builder,env,cx,flush}=fixture();const s=existing(env);const data=rootConfig();builder.askReload(data,cx);
  builder.key({key:'left'},cx);builder.key({key:'enter'},cx);assert.equal(builder.pending,null);assert.equal(mutations(env).length,0);
  builder.askReload(data,cx);builder.key({key:'enter'},cx);await flush();
  assert.equal(env.spaces.length,1);assert.notEqual(env.spaces[0].id,s.id);assert.equal(env.spaces[0].name,'example');
  assert.equal(Object.keys(env.state[STATE]).length,0);
});

for (const name of ['123', 'true', 'false', 'null', '[1]', '{"x":1}', '"quoted"']) {
  test(`reload preserves JSON-looking space and tab names: ${name}`, async () => {
    const {builder,env,cx,flush}=fixture();existing(env,name);
    const data=config({name,tabs:[
      {name,panes:[{id:'r',working_dir:'/repo'}]},
      {name,panes:[{id:'r',working_dir:'/repo'}]},
    ]});
    builder.askReload(data,cx);builder.reload(cx);await flush();
    assert.equal(env.notices.length,0);assert.equal(env.spaces.length,1);
    assert.equal(env.spaces[0].name,name);
    assert.deepEqual(env.spaces[0].tabs.map(tab=>tab.name),[name,name]);
    assert.equal(env.calls.find(([command])=>command==='space.close')[1].confirmed,true);
  });
}

test('JSON-looking machine names remain strings and null tab names use native defaults',async()=>{
  const {builder,env,cx,flush}=fixture();env.machines.push({name:'123',layout:'ready'});
  builder.startBuild(config({machine:'123',tabs:[
    {name:null,panes:[{id:'r'}]},{name:null,panes:[{id:'r'}]},
  ]}),cx);await flush();
  assert.equal(env.notices.length,0);assert.equal(env.spaces[0].machine,'123');
  assert.deepEqual(env.spaces[0].tabs.map(tab=>tab.name),['1','2']);
});

test('a matching space appearing during preflight cannot create an unconfirmed duplicate',async()=>{
  const {builder,env,cx,flush}=fixture();const original=builder.preflight.bind(builder);
  builder.preflight=async data=>{const plan=await original(data);existing(env);return plan;};
  builder.startBuild(rootConfig(),cx);await flush();assert.equal(mutations(env).length,0);assert.equal(env.spaces.length,1);
});

test('another builder reservation is preserved, and is not evidence that a space is loaded',async()=>{
  const {builder,env,api,cx,flush}=fixture();const data=rootConfig();const key=api.spaceKey(data);
  env.state[STATE]={[key]:{phase:'building',token:'other',at:Date.now(),machine:null}};await load(builder,[data]);
  assert.equal(builder.openInfo(0).open,false);builder.startBuild(data,cx);await flush();
  assert.equal(env.state[STATE][key].token,'other');assert.equal(mutations(env).length,0);
});

test('reload holds its reservation through close and replacement creation',async()=>{
  const {builder,env,api,cx,flush}=fixture();existing(env);const data=rootConfig();builder.askReload(data,cx);
  env.beforeCommand=async command=>{if(command==='space.close'||command==='space.new')assert.equal(env.state[STATE][api.spaceKey(data)].phase,'building');};
  builder.reload(cx);await flush();assert.equal(env.notices.length,0);
});

test('reservation remains exclusive during directory checks longer than its lease',async()=>{
  const {builder,env,api,cx,flush}=fixture();
  const data=config({tabs:[{panes:[{id:'r'},{id:'c',working_dir:'child',split_from:'r',split:'right'}]}]});
  const competitor=new api.SpaceBuilder();competitor.handle={focus(){}};
  env.probeHook=async()=>{
    assert.equal(env.spaces.length,1);
    env.advance(125000);
    assert.throws(()=>competitor.askReload(data,cx),/already being built/);
    assert.equal(env.timers.filter(task=>task.repeat && task.active).length,1);
    return {code:0,stdout:'',stderr:''};
  };
  builder.startBuild(data,cx);await flush();
  assert.equal(env.notices.length,0);assert.equal(env.spaces.length,1);
  assert.equal(env.timers.filter(task=>task.active).length,0);
  env.advance(120000);assert.equal(Object.keys(env.state[STATE]).length,0);
});

test('reservation remains exclusive while destructive reload waits for a close',async()=>{
  const {builder,env,api,cx,flush}=fixture();existing(env);const data=rootConfig();
  const competitor=new api.SpaceBuilder();competitor.handle={focus(){}};
  env.beforeCommand=async command=>{
    if(command==='space.close'){
      env.advance(125000);
      assert.throws(()=>competitor.askReload(data,cx),/already being built/);
    }
    assert.equal(env.timers.filter(task=>task.repeat && task.active).length,1);
  };
  builder.askReload(data,cx);builder.reload(cx);await flush();
  assert.equal(env.notices.length,0);assert.equal(env.spaces.length,1);
  assert.equal(env.timers.filter(task=>task.active).length,0);
});

test('reservation refresh never overwrites another operation token',async()=>{
  const {builder,env,api,cx,flush}=fixture();const data=rootConfig();
  const replacement={phase:'building',token:'other',at:env.now,machine:null};
  env.onSend=async()=>{
    env.state[STATE][api.spaceKey(data)]=replacement;
    env.advance(20000);
    assert.deepEqual(env.state[STATE][api.spaceKey(data)],replacement);
    assert.equal(env.timers.filter(task=>task.active).length,0);
  };
  builder.startBuild(data,cx);await flush();
  assert.deepEqual(env.state[STATE][api.spaceKey(data)],replacement);
});

test('Escape during creation records a late result for owned cleanup, with no submitted commands',async()=>{
  const {builder,env,cx,flush}=fixture();env.beforeCommand=async c=>{if(c==='space.new'){builder.escape(cx);await builder.close();}};
  builder.startBuild(rootConfig(),cx);await flush();assert.equal(env.spaces.length,0);assert.equal(env.sends.length,0);
  assert.equal(Object.keys(env.state[STATE]).length,0);assert.equal(builder.operation.committed,false);
});

test('closing while waiting for shell availability prevents later command submission',async()=>{
  const {builder,env,cx,flush}=fixture();env.onSleep=async()=>{await builder.close();};
  builder.startBuild(rootConfig(),cx);await flush();assert.equal(env.spaces.length,0);assert.equal(env.sends.length,0);
  assert.equal(env.timers.filter(task=>task.active).length,0);
  env.advance(120000);assert.equal(Object.keys(env.state[STATE]).length,0);
});

test('failed cleanup retains owned partial state and retry removes it',async()=>{
  const {builder,env,cx,flush}=fixture();env.failCommand='pane.split';env.failClose=true;
  builder.startBuild(config({tabs:[{panes:[{id:'r'},{id:'c',split_from:'r',split:'down'}]}]}),cx);await flush();
  assert.equal(env.spaces.length,1);assert.match(builder.error,/Cleanup failed/);
  assert.equal(Object.values(env.state[STATE])[0].phase,'partial');
  assert.equal(env.timers.filter(task=>task.active).length,0);
  env.advance(120000);assert.equal(Object.values(env.state[STATE])[0].phase,'partial');env.failClose=false;
  builder.closePartial(cx);await flush();assert.equal(env.spaces.length,0);assert.equal(Object.keys(env.state[STATE]).length,0);
});

for(const status of ['loading','unavailable']) test(`offline target ${status} is disabled and its operation state is preserved`,async()=>{
  const {builder,env,cx,flush}=fixture();env.machines[1].layout=status;
  env.state[STATE]={partial:{space:'remote/existing',machine:'remote',phase:'partial'}};
  await load(builder,[config({machine:'remote'})]);assert.equal(builder.entryEnabled({index:0}),false);
  builder.choose(0,cx);await flush();assert.equal(mutations(env).length,0);builder.prune();assert.ok(env.state[STATE].partial);
  assert.equal(builder.openInfo(0).open,false,'markers do not assert loaded status');
});

test('prune drops abandoned reservations but preserves recent and partial owned spaces',()=>{
  const {builder,env}=fixture();existing(env);
  env.state[STATE]={old:{phase:'building',at:0,machine:null},recent:{phase:'building',at:Date.now(),machine:null},
    partial:{phase:'partial',space:'existing',machine:null}};builder.prune();assert.equal(env.state[STATE].old,undefined);
  assert.ok(env.state[STATE].recent);assert.ok(env.state[STATE].partial);
});

test('typing search selects first enabled result and retains input focus',async()=>{
  const {builder,env,cx}=fixture();initialize(builder,env,cx);env.machines[1].layout='unavailable';
  await load(builder,[config({name:'api offline',machine:'remote'}),config({name:'api local'})]);
  builder.pickFirst(cx);const before=builder.input.focusCount;builder.input.set_value('api');builder.input.handlers.change({},cx);
  assert.equal(builder.selected,1);assert.equal(builder.input.focusCount,before);
  let chosen=null;builder.choose=i=>chosen=i;builder.input.handlers.submit({},cx);assert.equal(chosen,1);
});

test('live open-first sorting preserves selected configuration and Enter target',async()=>{
  const {builder,env,cx}=fixture();await load(builder,[config({name:'first'}),config({name:'selected'}),config({name:'last'})]);
  builder.selected=1;builder.listView();existing(env,'last');let chosen=null;builder.choose=i=>chosen=i;
  assert.deepEqual(Array.from(builder.listView().entries,e=>e.index),[2,0,1]);builder.chooseVisible(cx);assert.equal(chosen,1);
});

test('keyboard navigation wraps, skips disabled rows and scrolls the stable selection into view',async()=>{
  const {builder,cx,env}=fixture();await load(builder,Array.from({length:30},(_,i)=>config({name:`entry-${i}`,machine:i===1?'remote':null})));
  env.machines[1].layout='unavailable';builder.pickFirst(cx);builder.key({key:'down'},cx);assert.equal(builder.selected,2);
  for(let i=0;i<27;i++)builder.key({key:'down'},cx);assert.equal(builder.selected,29);
  assert.ok(builder.listView().shown.some(e=>e.index===29));builder.key({key:'down'},cx);assert.equal(builder.selected,0);
  builder.key({key:'up'},cx);assert.equal(builder.selected,29);
});

test('no matching search results leave no activatable selection',async()=>{
  const {builder,cx}=fixture();await load(builder,[config()]);builder.query='missing';let chosen=false;builder.choose=()=>chosen=true;
  assert.equal(builder.listView().shown.length,0);assert.equal(builder.selected,null);builder.chooseVisible(cx);assert.equal(chosen,false);
});

for(const [text,state] of [[null,'missing'],['{','invalid'],['{"spaces":[]}','found'],['42','invalid'],['{"spaces":[null]}','invalid']])
  test(`central config loading handles ${String(text)} as ${state}`,async()=>{
    const {builder,env,cx}=fixture();initialize(builder,env,cx);env.textFiles['/mock/spaces.json']=text;
    await builder.loadConfig(cx);assert.equal(builder.configState,state);assert.doesNotThrow(()=>builder.render(cx));
  });

test('config supports wrapper, array and single object, and reports obsolete fields per row',async()=>{
  const {builder,env,cx,api}=fixture();initialize(builder,env,cx);
  for(const value of [[config()],{spaces:[config()]},config()])assert.equal(api.parseConfigs(JSON.stringify(value)).length,1);
  await load(builder,[config({folder:'/legacy'}),config({id:'legacy',name:'id'}),config({name:'valid'})]);
  assert.match(builder.globalMeta[0].error,/Move directories to panes/);assert.match(builder.globalMeta[1].error,/Space id/);
  assert.equal(builder.entryEnabled({index:2}),true);assert.doesNotThrow(()=>builder.render(cx));
});

test('Configuration changes the centralized file, persists its path and resets the search',async()=>{
  const {builder,env,cx,flush}=fixture();initialize(builder,env,cx);env.picked='/chosen';
  env.textFiles['/chosen/spaces.json']=JSON.stringify({spaces:[config()]});builder.query='old';builder.browse(cx);await flush();
  assert.equal(builder.configPath,'/chosen/spaces.json');assert.equal(env.state['space-builder.config'],builder.configPath);
  assert.equal(builder.configState,'found');assert.equal(builder.query,'');assert.equal(env.spaces.length,0);
});

test('closing while folder picker or file read is pending prevents late config changes and autofocus',async()=>{
  const {builder,env,cx,flush}=fixture();initialize(builder,env,cx);env.picked='/chosen';builder.browse(cx);await builder.close();await flush();
  assert.equal(env.state['space-builder.config'],undefined);
  const other=fixture();initialize(other.builder,other.env,other.cx);other.env.onRead=async()=>{await other.builder.close();};
  await other.builder.loadConfig(other.cx);assert.equal(other.builder.globalSpaces.length,0);assert.equal(other.builder.input.focusCount,0);
});

test('stored configuration path is read on next invocation',async()=>{
  const {builder,env,cx}=fixture();env.state['space-builder.config']='/chosen/spaces.json';
  env.textFiles['/chosen/spaces.json']=JSON.stringify(config());builder.init({},cx);await env.tasks[1];
  assert.equal(builder.configPath,'/chosen/spaces.json');assert.equal(builder.globalSpaces.length,1);
  env.command('escape');await env.tasks[0];assert.equal(env.overlayCloses,1);
});

test('Escape command and key fallback cancel a reload question and close the dialog exactly once',async()=>{
  const {builder,env,cx}=fixture();existing(env);builder.askReload(config(),cx);builder.listenForCommands(cx);
  env.command('escape');await new Promise(setImmediate);assert.equal(builder.pending,null);assert.equal(env.closed,false);
  env.command('unrelated');env.command('escape');await env.tasks[0];builder.key({key:'escape'},cx);assert.equal(env.overlayCloses,1);
  assert.equal(env.spaces.length,1);assert.equal(mutations(env).length,0);
});

test('bare native check installs neither loader nor command listener',()=>{
  const {builder,env,cx}=fixture();initialize(builder,env,cx);assert.equal(env.tasks.length,0);assert.equal(env.commandRequests,0);
});

test('remote home failures are retryable and do not substitute the local home',async()=>{
  const {api,env}=fixture();env.homeFails=true;await assert.rejects(api.homeOn('remote'),/Could not inspect/);
  env.homeFails=false;assert.equal(await api.homeOn('remote'),'/home/remote');assert.equal(await api.homeOn('remote'),'/home/remote');
  assert.equal(env.calls.filter(([c])=>c==='home').length,4);
});

test('absolute remote pane paths do not require a remote home lookup',async()=>{
  const {builder,env}=fixture();env.homeFails=true;const plan=await builder.preflight(rootConfig('/srv/api',{machine:'remote'}));
  assert.equal(plan.tabs[0].root.dir,'/srv/api');assert.equal(env.calls.some(([c])=>c==='home'),false);
});

test('path preflight fails closed on transport errors and falls back to native PowerShell probes',async()=>{
  const {builder,env}=fixture();env.probeHook=async()=>{throw new Error('offline');};
  await assert.rejects(builder.preflight(rootConfig()),/Could not inspect/);
  const probes=[];env.probeHook=async(cmd,args)=>{probes.push(cmd);if(cmd==='sh')throw new Error('not installed');return {code:0,stdout:'',stderr:''};};
  await builder.preflight(rootConfig('C:/repo'));assert.deepEqual(probes,['sh','pwsh']);
});

test('paths preserve UNC roots, drive identity, dot segments and supported home syntax',async()=>{
  const {api,builder}=fixture();assert.equal(api.norm('C:\\repo\\..\\app\\'),'C:/app');
  assert.equal(api.pathKey('C:\\Repo'),api.pathKey('c:/repo'));assert.equal(api.norm('/'),'/');
  const root=await api.expand('\\\\Server\\Share\\Repo','C:/base',null);
  assert.equal(root,'//Server/Share/Repo');assert.equal(await api.expand('src',root,null),'//Server/Share/Repo/src');
  assert.equal((await builder.preflight(rootConfig(root))).tabs[0].root.dir,root);
  await assert.rejects(api.expand('~other/repo','/repo',null),/Unsupported home path/);
  assert.equal(await api.expand('~','/repo',null),'/home/local');
});

test('shell directory quoting handles apostrophes and empty or comment-only commands',()=>{
  const {api}=fixture();assert.match(api.withCd('nvim',null,"C:\\O'Brien",'pwsh'),/O''Brien/);
  for(const command of ['',null,'# comment','\n # one\n# two'])assert.equal(api.withCd(command,null,'/repo'),"cd '/repo'");
  assert.equal(api.withCd('pwd',null,null),'pwd');assert.match(api.withCd('pwd',null,"/O'Brien"),/'\\''/);
});

test('validation rejects missing names, invalid field types, NULs and invalid split topology',async()=>{
  const {api,builder,env}=fixture();
  for(const extra of [{name:undefined},{name:' '},{machine:{}},{name:'a\0b'}])assert.throws(()=>api.validate(config(extra)));
  for(const panes of [[{id:'r'},{id:'r'}],[{id:'r'},{id:'c',split_from:'missing',split:'right'}],
    [{id:'c',split_from:'r',split:'right'},{id:'r'}],[{id:'r'},{id:'c',split_from:'r',split:'left'}],
    [{id:'r',working_dir:{}}]])await assert.rejects(builder.preflight(config({tabs:[{panes}]})));
  assert.equal(mutations(env).length,0);
});


test('wheel scrolling chooses an enabled visible row without changing it during live resort', async () => {
  const {builder,env,cx}=fixture();env.machines[1].layout='unavailable';
  await load(builder,Array.from({length:12},(_,i)=>config({name:`row-${i}`,machine:i===1?'remote':null})));
  builder.pickFirst(cx);builder.list({},builder.listView(),cx);
  env.handlers['wb-list'].on_scroll_wheel({delta:{y:1}},cx);
  assert.equal(builder.top,1);assert.equal(builder.selected,2);
  existing(env,'row-11');builder.listView();assert.equal(builder.selected,2);
});

test('every dialog state follows live light, dark, and custom theme palettes',async()=>{
  const {builder,env,cx}=fixture();initialize(builder,env,cx);
  await load(builder,[config(),config({name:'another'})]);
  existing(env);existing(env,'another',null,'another-space');builder.selected=0;
  const keys=['background','popover','raised','hover','selected','border','input',
    'foreground','muted','dim','accent','accent_foreground','solid_foreground','blocked','done'];
  const palettes=[
    ['#101418','#171c22','#222932','#2b3540','#253d56','#344252','#516273',
      '#eef2f6','#b4c0cc','#8695a5','#70b5ff','#071525','#ffffff','#ff8181','#4eb894'],
    ['#ffffff','#f5f7fa','#edf0f5','#e0e7ef','#d8e8ff','#c4cfdb','#8796a8',
      '#17212e','#45566a','#627388','#1648a0','#f8fbff','#000000','#a51c30','#16734b'],
  ].map(colors=>Object.fromEntries(keys.map((key,index)=>[key,colors[index]])));
  palettes.push({...palettes[0],done:'#bb66dd80',accent:'#b6e34c',accent_foreground:'#17200b'});
  for(const palette of palettes){
    env.palette=palette;
    const allowed=new Set(Object.values(palette).map(color=>color.slice(0,7)));
    for(const state of ['list','reload','error','loading','missing']){
      builder.configState=state==='missing'?'missing':'found';
      builder.pending=state==='reload'?{name:'example'}:null;
      builder.error=state==='error'?'Build failed':null;
      builder.loading=state==='loading';env.paints=[];
      builder.render(cx);
      assert.ok(env.paints.some(p=>p.color===palette.popover),state);
      for(const paint of env.paints)assert.ok(allowed.has(paint.color?.slice(0,7)),`${state}: ${paint.color}`);
      if(state==='list')assert.ok(env.paints.some(p=>p.color===palette.done));
      if(state==='reload')assert.equal(env.paints.find(p=>p.id==='wb-reload' && p.kind==='text_color').color,palette.accent_foreground);
      if(state==='missing'){
        assert.equal(env.paints.find(p=>p.id==='wb-config' && p.kind==='bg').color,palette.accent);
        assert.ok(env.paints.some(p=>p.kind==='text_color' && p.color===palette.accent_foreground));
      }
    }
  }
});

test('loaded-space highlights retain a custom theme color opacity',()=>{
  const {builder,env,cx}=fixture();
  builder.globalSpaces=[config()];builder.globalMeta=[{}];
  const palette={done:'#bb66dd80',accent:'#abcdef',selected:'#123456',raised:'#234567',
    border:'#345678',foreground:'#456789',muted:'#56789a',dim:'#6789ab',hover:'#789abc'};
  builder.globalRow(palette,{index:0,open:true},cx,false);
  const highlights=env.paints.filter(p=>p.color?.startsWith('#bb66dd') && p.color!==palette.done);
  assert.deepEqual(highlights.map(p=>p.color).sort(),['#bb66dd09','#bb66dd17','#bb66dd24']);
});
