// Workflows for the canvas perf runner. "realistic" is examples/stress-workflow.json
// (about 300 nodes and 400 edges of mixed types, groups, hidden and bundled
// links) carrying media the way a working canvas does: photos at generation
// sizes, PNG outputs with and without alpha, a 4K output, a playing-size video,
// long prompts and comments. About half the media nodes are filled, as on a
// canvas mid-way through a project; filling all of them would make the JSON
// the drop path reads larger than a string can be. Built in the page, where
// the app decodes it.
const fs = require('node:fs/promises');
const path = require('node:path');

const LONG_PROMPT = 'A cinematic wide shot of a coastal village at golden hour, warm light raking across whitewashed walls, '
  + 'fishing boats pulled up on a pebble beach, gulls overhead, soft haze over the water, shot on 35mm film with gentle grain, '
  + 'shallow depth of field on the nearest boat, muted teal and amber grade, no text, no watermark. Keep the horizon level and '
  + 'the composition balanced; the village should occupy the right third of the frame with the sea opening out to the left.';

async function realisticWorkflow(root) {
  const workflow = JSON.parse(await fs.readFile(path.join(root, 'examples/stress-workflow.json'), 'utf8'));
  const dir = path.join(root, 'examples/sample-images');
  const photos = await Promise.all((await fs.readdir(dir)).filter(name => /\.jpe?g$/i.test(name)).sort()
    .map(async name => `data:image/jpeg;base64,${(await fs.readFile(path.join(dir, name))).toString('base64')}`));
  workflow.name = 'Canvas performance fixture';
  return { workflow, photos, prompt: LONG_PROMPT };
}

// Runs in the page (serialised, so it uses nothing from this module).
async function fillRealisticMedia({ workflow, photos, prompt }) {
  const bitmaps = await Promise.all(photos.map(async url => createImageBitmap(await (await fetch(url)).blob())));
  const toDataUrl = blob => new Promise(resolve => { const reader = new FileReader(); reader.onload = () => resolve(reader.result); reader.readAsDataURL(blob); });
  async function render(index, size, type, { hue = 0, alpha = false } = {}) {
    const bitmap = bitmaps[index % bitmaps.length];
    const scale = size / Math.max(bitmap.width, bitmap.height);
    const canvas = new OffscreenCanvas(Math.round(bitmap.width * scale), Math.round(bitmap.height * scale));
    const context = canvas.getContext('2d');
    context.filter = `hue-rotate(${hue}deg)`;
    context.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    if (alpha) {
      // A cut-out: transparent outside a soft-edged ellipse, as background removal leaves.
      const mask = context.createRadialGradient(canvas.width / 2, canvas.height / 2, Math.min(canvas.width, canvas.height) * .3, canvas.width / 2, canvas.height / 2, Math.min(canvas.width, canvas.height) * .5);
      mask.addColorStop(0, 'rgba(0,0,0,1)'); mask.addColorStop(1, 'rgba(0,0,0,0)');
      context.globalCompositeOperation = 'destination-in';
      context.fillStyle = mask;
      context.fillRect(0, 0, canvas.width, canvas.height);
    }
    return toDataUrl(await canvas.convertToBlob(type === 'png' ? { type: 'image/png' } : { type: 'image/jpeg', quality: .9 }));
  }
  async function video() {
    const canvas = document.createElement('canvas');
    canvas.width = 1280; canvas.height = 720;
    const context = canvas.getContext('2d');
    const recorder = new MediaRecorder(canvas.captureStream(30), { mimeType: 'video/webm' });
    const chunks = [];
    recorder.ondataavailable = event => chunks.push(event.data);
    const done = new Promise(resolve => { recorder.onstop = resolve; });
    recorder.start();
    // Timers, not animation frames, which stop while the window is covered.
    const start = performance.now();
    await new Promise(resolve => {
      const frame = () => {
        const t = (performance.now() - start) / 1000;
        context.drawImage(bitmaps[Math.floor(t * 2) % bitmaps.length], 0, 0, 1280, 720);
        context.fillStyle = `hsla(${t * 120} 70% 50% / .35)`;
        context.fillRect(0, 0, 1280 * (t % 1), 720);
        if (t < 2) setTimeout(frame, 33); else resolve();
      };
      frame();
    });
    recorder.stop();
    await done;
    return toDataUrl(new Blob(chunks, { type: 'video/webm' }));
  }
  const byId = new Map(workflow.nodes.map(node => [node.id, node]));
  const sourceOf = id => byId.get(workflow.edges.find(edge => edge.target === id && !edge.data?.hidden)?.source);
  const outputs = [];
  for (let i = 0; i < 9; i++) outputs.push(await render(i + 3, 1024, 'png', { hue: i * 40, alpha: i % 3 === 0 }));
  const fourK = await render(6, 4096, 'png');
  const clip = await video();
  let inputs = 0, generated = 0, seen = 0;
  for (const [i, node] of workflow.nodes.entries()) {
    if (i % 10 === 0) node.data.comment = 'Check the framing against the brief before the next run. The client wants the horizon lower.';
    if (node.type === 'prompt') node.data.prompt = prompt;
    if (!['imageInput', 'nanoBanana', 'generateVideo'].includes(node.type) || seen++ % 2) continue;
    if (node.type === 'imageInput') {
      node.data.image = await render(inputs, 2048, 'jpeg', { hue: inputs++ * 23 });
      node.data.filename = `reference-${inputs}.jpg`;
    } else if (node.type === 'nanoBanana') node.data.outputImage = generated++ === 0 ? fourK : outputs[generated % outputs.length];
    else node.data.outputVideo = clip;
  }
  for (const node of workflow.nodes) {
    if (node.type !== 'output') continue;
    const source = sourceOf(node.id);
    if (source?.type === 'generateVideo') Object.assign(node.data, { video: clip, contentType: 'video' });
    else if (source?.data.outputImage) Object.assign(node.data, { image: source.data.outputImage, contentType: 'image' });
  }
  return workflow;
}

// One tab of the installed app's last session, set up in a disposable profile
// for the app to restore at launch, the way the user's own canvas loads. The
// installed app's recovery store is only read. Returns the tab's workflow.
async function seedRecoveredTab({ from, profile, name }) {
  const source = path.join(from, 'recovery');
  const record = JSON.parse(await fs.readFile(path.join(source, 'checkpoint-v1.json'), 'utf8'));
  const checkpoint = JSON.parse(record.payload);
  const tab = checkpoint.tabs.find(t => t.snapshot?.workflowName === name);
  if (!tab) throw new Error(`No tab named "${name}" in ${source}; tabs are ${checkpoint.tabs.map(t => JSON.stringify(t.snapshot?.workflowName)).join(', ')}`);
  const assets = new Set();
  (function visit(value) {
    if (!value || typeof value !== 'object') return;
    if (typeof value.$recoveryAsset === 'string') assets.add(value.$recoveryAsset);
    else for (const child of Object.values(value)) visit(child);
  })(tab.snapshot);
  const target = path.join(profile, 'recovery');
  await fs.mkdir(path.join(target, 'assets'), { recursive: true });
  for (const asset of assets) await fs.copyFile(path.join(source, 'assets', asset), path.join(target, 'assets', asset));
  const payload = JSON.stringify({ ...checkpoint, activeTabId: tab.id, tabs: [tab] });
  await fs.writeFile(path.join(target, 'checkpoint-v1.json'), JSON.stringify({ sha256: require('node:crypto').createHash('sha256').update(payload).digest('hex'), payload }));
  // An unclean session is what makes the app offer its checkpoint.
  await fs.writeFile(path.join(target, 'session-v1.json'), JSON.stringify({ clean: false, discarded: [] }));
  return { name, nodes: tab.snapshot.nodes, edges: tab.snapshot.edges, assets: assets.size };
}

module.exports = { realisticWorkflow, fillRealisticMedia, seedRecoveredTab };
