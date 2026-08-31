import { createStore, loadDoc, emptyDoc } from './store.js';
import { createCanvas } from './canvas.js';
import { attachTools } from './tools.js';
import { createHierarchy, createInspector, createArtList, createAnimList } from './panels.js';
import { createLanes } from './lanes.js';
import { makeAnimation, endsAt, advanceFrame } from './animation.js';
import { exportYaml, exportJson, importJson, download } from './serialize.js';
import { makeZip, readZip } from './zip.js';
import { makeBone } from './skeleton.js';
import {
  makeArt, parseArt, readAnchors, writeAnchors, artById, viewportTransform,
} from './art.js';

const store = createStore(loadDoc() ?? emptyDoc());
const svg = document.getElementById('viewport');
const canvas = createCanvas(svg, store);
attachTools(svg, store, canvas);
const inspector = createInspector(document.getElementById('inspector'), store, {
  onDownload: (id) => {
    const item = artById(store.doc, id);
    if (!item) return;
    const { svg, error } = writeAnchors(item.svg, item.anchors ?? []);
    if (error) return alert(`Could not write anchors: ${error}`);
    download(item.filename || `${item.name}.svg`, svg, 'image/svg+xml');
  },
});
createHierarchy(document.getElementById('hierarchy'), store, {
  onRename: () => inspector.focusName(),
});
createArtList(document.getElementById('art-list'), store, {
  onRename: () => inspector.focusName(),
});
createAnimList(document.getElementById('anim-list'), store);
createLanes(document.getElementById('swim-lanes'), store);

const on = (id, fn) => { document.getElementById(id).onclick = fn; };

on('add-root', () => store.update((d) => {
  const n = d.nextId++;
  d.bones.push(makeBone(`b${n}`, `root${n}`, null, 40));
  d.selection = { kind: 'bone', id: `b${n}` };
}));

// --- art ---------------------------------------------------------------------
// every art item owns its own copy of the markup, so the same file dropped
// twice yields two independent items. there is no asset library to reconcile.
async function addArtFiles(files) {
  // a dropped bundle is a whole rig, not another art chunk -- different
  // meaning, so it replaces rather than adds, and asks first
  const bundle = [...files].find((f) => /\.(zip|json)$/i.test(f.name));
  if (bundle) {
    const has = store.doc.bones.length || (store.doc.art ?? []).length;
    if (!has || confirm(`Replace the current rig with ${bundle.name}?`)) await openRig(bundle);
    return;
  }

  const svgs = [...files].filter((f) => /\.svgz?$/i.test(f.name) || f.type === 'image/svg+xml');
  if (!svgs.length) return;

  const loaded = [];
  for (const file of svgs) {
    const text = await file.text();
    const { root, error } = parseArt(text);
    if (error) {
      alert(`${file.name}: ${error}`);
      continue;
    }
    loaded.push({
      name: file.name.replace(/\.svgz?$/i, ''),
      filename: file.name,
      text,
      // whatever the file already carries -- names only, no roles inferred
      anchors: readAnchors(root),
      // stored so placement stays computable without re-parsing
      viewport: viewportTransform(root),
    });
  }
  if (!loaded.length) return;

  store.update((d) => {
    for (const l of loaded) {
      const n = d.nextId++;
      // new art goes to the FRONT of the list, which is the front of the scene
      const item = makeArt(`art${n}`, l.name, l.filename, l.text, l.anchors);
      item.viewport = l.viewport;
      d.art.unshift(item);
      d.selection = { kind: 'art', id: `art${n}` };
    }
  });
}

on('add-art', () => document.getElementById('art-file').click());
document.getElementById('art-file').onchange = async (e) => {
  await addArtFiles(e.target.files ?? []);
  e.target.value = '';
};

// drag and drop anywhere on the window
for (const type of ['dragenter', 'dragover']) {
  window.addEventListener(type, (e) => {
    if (![...(e.dataTransfer?.types ?? [])].includes('Files')) return;
    e.preventDefault();
    document.body.classList.add('dropping');
  });
}
for (const type of ['dragleave', 'drop']) {
  window.addEventListener(type, (e) => {
    if (type === 'dragleave' && e.relatedTarget) return;   // still inside
    document.body.classList.remove('dropping');
  });
}
window.addEventListener('drop', async (e) => {
  if (![...(e.dataTransfer?.types ?? [])].includes('Files')) return;
  e.preventDefault();
  await addArtFiles(e.dataTransfer.files ?? []);
});

on('undo', () => store.undo());
on('redo', () => store.redo());
on('reset-view', () => canvas.fitToContent());

for (const mode of ['rest', 'solve', 'pose', 'anim']) {
  on(`mode-${mode}`, () => store.setView((v) => { v.mode = mode; }));
}

// --- playback ----------------------------------------------------------------
// The playhead is a clock, not a loop. It counts up; every lane wraps on its
// own period as it goes. The lane view shows a WINDOW onto that clock, so what
// plays stays continuous no matter how the periods relate.
on('play', () => store.setView((v) => { v.playing = !v.playing; }));
document.getElementById('fps').onchange = (e) => {
  const n = Math.max(1, Math.min(60, Math.round(Number(e.target.value) || 12)));
  e.target.value = n;
  store.setView((v) => { v.fps = n; });
};

let lastTick = performance.now();
function tick(now) {
  requestAnimationFrame(tick);
  const v = store.view;
  const dt = (now - lastTick) / 1000;
  lastTick = now;

  if (!v.playing || v.mode !== 'anim') return;
  if (!(store.doc.animations ?? []).some((a) => a.active)) return;

  // time runs free -- each lane wraps on its own period, so there is no shared
  // wrap point. only a set with no loops in it has somewhere to stop.
  const stopAt = endsAt(store.doc);
  const next = advanceFrame(v.frame ?? 0, dt, v.fps ?? 12, { stopAt });
  if (next === v.frame) return;
  store.setView((s2) => {
    s2.frame = next;
    if (stopAt != null && next >= stopAt) s2.playing = false;
  });
}
requestAnimationFrame(tick);

on('add-anim', () => store.update((d) => {
  d.animations ??= [];
  const n = d.nextId++;
  const anim = makeAnimation(`anim${n}`, `anim ${d.animations.length + 1}`);
  d.animations.push(anim);
  d.selection = { kind: 'anim', id: anim.id };
}));

// Output paths for the art bundle.
//
// Two items can come from one file yet carry different anchors, so they cannot
// share an output path -- but two items whose written markup is byte-identical
// should, so the engine loads once and draws twice.
function artBundle(doc) {
  const paths = new Map();
  const byContent = new Map();
  const files = [];
  const used = new Set();

  for (const item of doc.art ?? []) {
    const { svg, error } = writeAnchors(item.svg, item.anchors ?? []);
    if (error) continue;

    const existing = byContent.get(svg);
    if (existing) {
      paths.set(item.id, existing);
      continue;
    }

    let base = item.filename || `${item.name}.svg`;
    if (!/\.svgz?$/i.test(base)) base += '.svg';
    let path = `art/${base}`;
    for (let n = 2; used.has(path); n += 1) {
      path = `art/${base.replace(/(\.svgz?)$/i, `-${n}$1`)}`;
    }

    used.add(path);
    byContent.set(svg, path);
    paths.set(item.id, path);
    files.push({ name: path, text: svg });
  }

  return { paths, files };
}

on('export', async () => {
  const { paths, files } = artBundle(store.doc);
  const zip = makeZip([
    { name: 'skeleton.yaml', text: exportYaml(store.doc, paths) },
    // the authoring graph -- refs, anchors, inline markup -- so the bundle can
    // be reopened. the yaml is resolved and cannot be loaded back.
    { name: 'rig.json', text: exportJson(store.doc) },
    ...files,
  ]);
  const url = URL.createObjectURL(zip);
  const a = Object.assign(document.createElement('a'), { href: url, download: 'rig.zip' });
  document.body.append(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
});

on('load-json', () => document.getElementById('file').click());

// Load a rig from either a bundle or a bare rig.json.
//
// Nothing resolves file paths: rig.json carries each art item's markup inline,
// so art/*.svg in the bundle are outputs for the engine, not inputs. That also
// means a hand-edited SVG inside a bundle is IGNORED on re-import -- drag the
// edited file in as art instead.
async function loadRig(file) {
  const isZip = /\.zip$/i.test(file.name) || file.type === 'application/zip';
  if (!isZip) return importJson(await file.text());

  const entries = await readZip(await file.arrayBuffer());
  // tolerate a wrapping folder, which is what unzip-then-rezip produces
  const key = [...entries.keys()].find((n) => n === 'rig.json' || n.endsWith('/rig.json'));
  if (!key) throw new Error('no rig.json in the archive');
  return importJson(entries.get(key));
}

async function openRig(file) {
  try {
    const next = await loadRig(file);
    store.replace(next);
    canvas.fitToContent();
  } catch (err) {
    alert(`Could not open ${file.name}: ${err.message}`);
  }
}

document.getElementById('file').onchange = async (e) => {
  const file = e.target.files?.[0];
  if (file) await openRig(file);
  e.target.value = '';
};

on('clear', () => {
  if (store.doc.bones.length && !confirm('Discard everything?')) return;
  store.replace(emptyDoc());
});

store.subscribe((doc, view) => {
  document.getElementById('undo').disabled = !store.canUndo;
  document.getElementById('redo').disabled = !store.canRedo;
  for (const mode of ['rest', 'solve', 'pose', 'anim']) {
    document.getElementById(`mode-${mode}`).classList.toggle('active', view.mode === mode);
  }
  // the inspector shows four different things -- say which
  document.getElementById('inspector-title').textContent = {
    bone: 'bone', art: 'art', anim: 'animation', keyframe: 'keyframe',
  }[doc.selection?.kind] ?? 'inspector';

  document.body.classList.toggle('mode-solve', view.mode === 'solve');
  document.body.classList.toggle('mode-pose', view.mode === 'pose');
  document.body.classList.toggle('mode-anim', view.mode === 'anim');

  const play = document.getElementById('play');
  play.textContent = view.playing ? '❚❚' : '▶';
  play.classList.toggle('playing', !!view.playing);

  // toggle art vs animation list visibility
  for (const el of document.querySelectorAll('.art-section')) el.hidden = view.mode === 'anim';
  for (const el of document.querySelectorAll('.anim-section')) el.hidden = view.mode !== 'anim';
});

// tells the boot guard in index.html that modules loaded fine
window.__riggerBooted = true;
