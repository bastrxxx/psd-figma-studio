// PSD Figma Studio → Figma importer
// Rebuilds every PSD layer as native Figma nodes: groups, image layers, editable TEXT, clipping masks, effects.
figma.showUI(__html__, { width: 380, height: 330 });

var BLEND = {
  'normal': 'NORMAL', 'dissolve': 'NORMAL', 'darken': 'DARKEN', 'multiply': 'MULTIPLY', 'color burn': 'COLOR_BURN',
  'linear burn': 'LINEAR_BURN', 'darker color': 'DARKEN', 'lighten': 'LIGHTEN', 'screen': 'SCREEN', 'color dodge': 'COLOR_DODGE',
  'linear dodge': 'LINEAR_DODGE', 'lighter color': 'LIGHTEN', 'overlay': 'OVERLAY', 'soft light': 'SOFT_LIGHT',
  'hard light': 'HARD_LIGHT', 'vivid light': 'HARD_LIGHT', 'linear light': 'HARD_LIGHT', 'pin light': 'HARD_LIGHT',
  'hard mix': 'HARD_LIGHT', 'difference': 'DIFFERENCE', 'exclusion': 'EXCLUSION', 'subtract': 'DIFFERENCE',
  'divide': 'COLOR_DODGE', 'hue': 'HUE', 'saturation': 'SATURATION', 'color': 'COLOR', 'luminosity': 'LUMINOSITY',
  'pass through': 'PASS_THROUGH'
};

function progress(text, pct) { figma.ui.postMessage({ type: 'progress', text: text, pct: pct }); }
function norm(s) { return String(s || '').toLowerCase().replace(/[^a-z0-9]/g, ''); }
function rgb(c) { return { r: c[0] / 255, g: c[1] / 255, b: c[2] / 255 }; }

var bufferCache = {};
async function getBytes(ref) {
  if (!bufferCache[ref.url]) {
    bufferCache[ref.url] = fetch(ref.url).then(function (r) {
      if (!r.ok) throw new Error('HTTP ' + r.status + ' ' + ref.url);
      return r.arrayBuffer();
    });
  }
  var buf = await bufferCache[ref.url];
  if (ref.offset != null && ref.length != null) return new Uint8Array(buf, ref.offset, ref.length).slice();
  return new Uint8Array(buf);
}

// ---------- Fonts ----------
var fontIndex = null;
var missingFonts = {};
async function buildFontIndex() {
  var list = await figma.listAvailableFontsAsync();
  var full = {}, fam = {};
  list.forEach(function (f) {
    var fn = f.fontName;
    full[norm(fn.family + fn.style)] = fn;
    full[norm(fn.family + '-' + fn.style)] = fn;
    var k = norm(fn.family);
    if (!fam[k]) fam[k] = [];
    fam[k].push(fn);
  });
  fontIndex = { full: full, fam: fam };
}
function pickStyle(fonts, wanted) {
  var w = norm(wanted || 'regular');
  for (var i = 0; i < fonts.length; i++) if (norm(fonts[i].style) === w) return fonts[i];
  for (var j = 0; j < fonts.length; j++) if (norm(fonts[j].style) === 'regular') return fonts[j];
  return fonts[0];
}
function resolveFont(ps) {
  var n = norm(ps);
  if (fontIndex.full[n]) return fontIndex.full[n];
  if (fontIndex.fam[n]) return pickStyle(fontIndex.fam[n], 'Regular');
  // "Family-Style" PostScript convention
  var parts = String(ps || '').split('-');
  if (parts.length > 1) {
    var style = parts.pop();
    var f = fontIndex.fam[norm(parts.join(''))];
    if (f) return pickStyle(f, style);
  }
  // Suffix style words: e.g. "UVNLaXanhBold"
  var styles = ['bold', 'semibold', 'medium', 'light', 'regular', 'italic', 'black', 'thin', 'heavy'];
  for (var s = 0; s < styles.length; s++) {
    if (n.length > styles[s].length && n.slice(-styles[s].length) === styles[s]) {
      var fam2 = fontIndex.fam[n.slice(0, -styles[s].length)];
      if (fam2) return pickStyle(fam2, styles[s]);
    }
  }
  missingFonts[ps] = true;
  return null;
}
var loadedFonts = {};
async function loadFont(fn) {
  var k = fn.family + '|' + fn.style;
  if (!loadedFonts[k]) loadedFonts[k] = figma.loadFontAsync(fn);
  await loadedFonts[k];
  return fn;
}
var FALLBACK = { family: 'Inter', style: 'Regular' };

// ---------- Effects ----------
function figmaEffects(fx) {
  var out = [];
  if (!fx) return out;
  (fx.dropShadow || []).forEach(function (d) {
    var a = d.angle * Math.PI / 180;
    out.push({ type: 'DROP_SHADOW', visible: true, blendMode: 'NORMAL', color: { r: d.color[0] / 255, g: d.color[1] / 255, b: d.color[2] / 255, a: d.opacity },
      offset: { x: -Math.cos(a) * d.distance, y: Math.sin(a) * d.distance }, radius: d.size, spread: 0, showShadowBehindNode: false });
  });
  (fx.innerShadow || []).forEach(function (d) {
    var a = d.angle * Math.PI / 180;
    out.push({ type: 'INNER_SHADOW', visible: true, blendMode: 'NORMAL', color: { r: d.color[0] / 255, g: d.color[1] / 255, b: d.color[2] / 255, a: d.opacity },
      offset: { x: -Math.cos(a) * d.distance, y: Math.sin(a) * d.distance }, radius: d.size, spread: 0 });
  });
  if (fx.outerGlow) {
    var g = fx.outerGlow;
    out.push({ type: 'DROP_SHADOW', visible: true, blendMode: 'NORMAL', color: { r: g.color[0] / 255, g: g.color[1] / 255, b: g.color[2] / 255, a: g.opacity },
      offset: { x: 0, y: 0 }, radius: g.size, spread: 0, showShadowBehindNode: false });
  }
  return out;
}

function applyCommon(node, l, isGroup) {
  node.name = l.name;
  node.visible = !!l.visible;
  node.opacity = Math.max(0, Math.min(1, isGroup ? l.opacity : l.opacity * l.fillOpacity));
  var bm = BLEND[l.blendMode] || 'NORMAL';
  if (!isGroup && bm === 'PASS_THROUGH') bm = 'NORMAL';
  try { node.blendMode = bm; } catch (e) {}
  var fx = l.meta && l.meta.effects;
  if (fx && 'effects' in node) { try { node.effects = figmaEffects(fx); } catch (e) { console.warn('effects', e); } }
}

async function imageNode(l, ref, parent, name) {
  var bytes = await getBytes(ref);
  var img = figma.createImage(bytes);
  var size = await img.getSizeAsync();
  var r = figma.createRectangle();
  parent.appendChild(r);
  r.resize(Math.max(1, size.width), Math.max(1, size.height));
  r.x = l.left; r.y = l.top;
  r.fills = [{ type: 'IMAGE', scaleMode: 'FILL', imageHash: img.hash }];
  r.name = name || l.name;
  return r;
}

async function textNode(l, parent) {
  var t = l.text;
  var node = figma.createText();
  parent.appendChild(node);
  var base = resolveFont(t.font) || FALLBACK;
  await loadFont(base);
  node.fontName = base;
  node.characters = t.text || ' ';
  node.fontSize = Math.max(1, t.fontSize);
  node.fills = [{ type: 'SOLID', color: rgb(t.color), opacity: t.color[3] == null ? 1 : t.color[3] }];
  if (t.tracking) node.letterSpacing = { unit: 'PERCENT', value: t.tracking / 10 };
  if (t.leading) node.lineHeight = { unit: 'PIXELS', value: t.leading };
  node.textAlignHorizontal = t.align === 'center' ? 'CENTER' : t.align === 'right' ? 'RIGHT' : t.align === 'justify' ? 'JUSTIFIED' : 'LEFT';
  // Per-run styling (font / size / color)
  var len = node.characters.length;
  for (var i = 0; i < (t.runs || []).length; i++) {
    var run = t.runs[i];
    var s = Math.max(0, Math.min(len, run.start)), e = Math.max(0, Math.min(len, run.end));
    if (e <= s) continue;
    try {
      if (run.font && run.font !== t.font) {
        var f = resolveFont(run.font) || base;
        await loadFont(f);
        node.setRangeFontName(s, e, f);
      }
      if (run.fontSize && Math.abs(run.fontSize - t.fontSize) > 0.01) node.setRangeFontSize(s, e, run.fontSize);
      if (run.color) node.setRangeFills(s, e, [{ type: 'SOLID', color: rgb(run.color) }]);
      if (run.underline) node.setRangeTextDecoration(s, e, 'UNDERLINE');
    } catch (err) { console.warn('run style', err); }
  }
  var fx = l.meta && l.meta.effects;
  if (fx && fx.stroke) {
    try {
      node.strokes = [{ type: 'SOLID', color: rgb(fx.stroke.color), opacity: fx.stroke.opacity }];
      node.strokeWeight = fx.stroke.size;
      node.strokeAlign = fx.stroke.position === 'inside' ? 'INSIDE' : fx.stroke.position === 'center' ? 'CENTER' : 'OUTSIDE';
    } catch (err) {}
  }
  if (t.shapeType === 'box' && t.box) {
    node.textAutoResize = 'HEIGHT';
    node.resize(Math.max(1, t.box.width), Math.max(1, node.height));
    node.x = t.box.left; node.y = t.box.top;
  } else {
    node.textAutoResize = 'WIDTH_AND_HEIGHT';
    // place the text box centred on the rendered pixels of the PSD text layer
    if (l.width > 0 && l.height > 0) {
      node.x = t.align === 'left' ? l.left : t.align === 'right' ? l.left + l.width - node.width : l.left + (l.width - node.width) / 2;
      node.y = l.top + (l.height - node.height) / 2;
    } else {
      node.x = t.transform[4]; node.y = t.transform[5] - t.fontSize;
    }
  }
  return node;
}

// ---------- Tree build ----------
var doc, opts, counter = 0, totalLayers = 1;
function kids(pid) {
  return doc.layers.filter(function (l) { return l.parentId === pid; }).sort(function (a, b) { return a.position - b.position; });
}

async function buildLeaf(l, root) {
  var nodes = [];
  if (l.kind === 'adjustment') return nodes;
  if (l.kind === 'text' && l.text) {
    if (opts.raster && l.image) {
      var r = await imageNode(l, l.image, root, l.name + ' (ảnh gốc)');
      r.visible = false;
      nodes.push(r);
    }
    var t = await textNode(l, root);
    applyCommon(t, l, false);
    nodes.push(t);
    if (nodes.length > 1) {
      var g = figma.group(nodes, root);
      g.name = l.name;
      return [g];
    }
    return nodes;
  }
  if (!l.image) return nodes;
  var img = await imageNode(l, l.image, root);
  applyCommon(img, l, false);
  nodes.push(img);
  return nodes;
}

async function buildChildren(pid, root) {
  var list = kids(pid);
  var result = [];
  for (var i = 0; i < list.length; i++) {
    var l = list[i];
    if (!opts.keepHidden && !l.visible) continue;
    counter++;
    if (counter % 10 === 0) { progress('Đang dựng layer ' + counter + '/' + totalLayers + '…', 30 + 65 * counter / totalLayers); await new Promise(function (r) { setTimeout(r, 0); }); }
    // clipping stack: base + following layers with clipping=true
    var clipped = [];
    for (var j = i + 1; j < list.length && list[j].clipping; j++) clipped.push(list[j]);
    var baseNodes = await buildNode(l, root);
    if (clipped.length && baseNodes.length === 1 && l.kind !== 'group') {
      var base = baseNodes[0];
      var mask = base.clone();
      root.insertChild(root.children.indexOf(base), mask);
      mask.isMask = true;
      mask.visible = true;
      mask.opacity = 1;
      mask.name = l.name + ' (mask)';
      var members = [mask, base];
      for (var k = 0; k < clipped.length; k++) {
        counter++;
        var cn = await buildNode(clipped[k], root);
        members = members.concat(cn);
      }
      var cg = figma.group(members, root);
      cg.name = l.name + ' ⟂ clip';
      result.push(cg);
      i += clipped.length;
    } else {
      result = result.concat(baseNodes);
    }
  }
  return result;
}

async function buildNode(l, root) {
  if (l.kind !== 'group') return buildLeaf(l, root);
  var children = await buildChildren(l.id, root);
  var gm = l.meta && l.meta.groupMask;
  if (gm && gm.image && gm.image.url && children.length) {
    var m = await imageNode({ left: gm.left, top: gm.top, name: 'mask' }, gm.image, root, l.name + ' (mask)');
    root.insertChild(root.children.indexOf(children[0]), m);
    m.isMask = true;
    m.maskType = 'ALPHA';
    children.unshift(m);
  }
  if (!children.length) return [];
  var g = figma.group(children, root);
  applyCommon(g, l, true);
  return [g];
}

figma.ui.onmessage = async function (msg) {
  if (msg.type !== 'import') return;
  try {
    opts = msg;
    progress('Đang tải dữ liệu layer…', 2);
    var res = await fetch(msg.url);
    if (!res.ok) throw new Error('Không tải được dữ liệu (HTTP ' + res.status + ')');
    doc = await res.json();
    if (!doc.layers) throw new Error('URL không đúng định dạng PSD Figma Studio');
    totalLayers = doc.layers.length;
    progress('Đang đọc danh sách font…', 6);
    await buildFontIndex();
    await loadFont(FALLBACK);
    // prefetch bundles
    var urls = {};
    doc.layers.forEach(function (l) { if (l.image) urls[l.image.url] = 1; if (l.meta && l.meta.groupMask && l.meta.groupMask.image.url) urls[l.meta.groupMask.image.url] = 1; });
    var keys = Object.keys(urls), loaded = 0;
    await Promise.all(keys.map(function (u) { return getBytes({ url: u }).then(function () { loaded++; progress('Đang tải ảnh ' + loaded + '/' + keys.length + '…', 8 + 22 * loaded / keys.length); }); }));

    var frame = figma.createFrame();
    frame.name = doc.name;
    frame.resize(doc.width, doc.height);
    frame.fills = [{ type: 'SOLID', color: { r: 1, g: 1, b: 1 } }];
    frame.clipsContent = true;
    var c = figma.viewport.center;
    frame.x = Math.round(c.x - doc.width / 2); frame.y = Math.round(c.y - doc.height / 2);
    figma.currentPage.appendChild(frame);
    counter = 0;
    await buildChildren(null, frame);
    figma.currentPage.selection = [frame];
    figma.viewport.scrollAndZoomIntoView([frame]);
    var missing = Object.keys(missingFonts);
    var text = 'Hoàn tất! Đã nhập ' + totalLayers + ' layer.' + (missing.length ? '\nFont chưa có trong Figma (đã dùng Inter thay thế — cài font rồi đổi lại): ' + missing.join(', ') : '');
    figma.ui.postMessage({ type: 'done', text: text });
    figma.notify('Đã nhập "' + doc.name + '" vào Figma');
  } catch (e) {
    console.error(e);
    figma.ui.postMessage({ type: 'error', text: 'Lỗi: ' + (e && e.message ? e.message : e) });
  }
};
