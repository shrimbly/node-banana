/* Node Banana landing page.
   Everything here is an enhancement: the page reads and works without it.
   1. (The entry animation is gated by the inline script in the page head.)
   2. Read the visitor's platform and point the main download at it.
   3. Close the platform menu on outside click and Escape.
   4. Show the live GitHub star count.
   5. The app window: tabs switch workflows, the canvas pans and zooms, the
      nodes drag and the edges follow, the video plays with its scrub row. */
(function () {
  "use strict";

  var reducedMotion = window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches;

  /* 2. Platform. Only the label and the target change; both platforms stay in the menu. */
  var main = document.querySelector("[data-download-main]");
  var label = document.querySelector("[data-platform-label]");
  var items = Array.prototype.slice.call(document.querySelectorAll(".menu__item[data-platform]"));
  var platformHint = (navigator.userAgentData && navigator.userAgentData.platform) || navigator.platform || "";
  var isWindows = /win/i.test(platformHint) || /Windows NT/.test(navigator.userAgent);
  var current = isWindows ? "windows" : "mac";
  items.forEach(function (item) {
    var mine = item.getAttribute("data-platform") === current;
    if (mine) {
      item.setAttribute("aria-current", "true");
      if (main) main.setAttribute("href", item.getAttribute("href"));
      if (label) label.textContent = item.getAttribute("data-label");
    } else {
      item.removeAttribute("aria-current");
    }
  });

  /* 3. Menu. <details> works on its own; this just closes it politely. */
  var more = document.querySelector("[data-download-more]");
  if (more) {
    document.addEventListener("pointerdown", function (event) {
      if (more.open && !more.contains(event.target)) more.open = false;
    });
    document.addEventListener("keydown", function (event) {
      if (event.key === "Escape" && more.open) {
        more.open = false;
        more.querySelector("summary").focus();
      }
    });
  }

  /* 4. Stars. The number in the HTML is the fallback; the count appears in the fold and again in the open-source section. */
  var starEls = document.querySelectorAll("[data-stars]");
  var stars = starEls.length ? { set textContent(v) { Array.prototype.forEach.call(starEls, function (el) { el.textContent = v; }); } } : null;
  if (stars && window.fetch) {
    var cached = null;
    try { cached = sessionStorage.getItem("nb-stars"); } catch (e) { /* storage may be blocked */ }
    if (cached) {
      stars.textContent = cached;
    } else {
      fetch("https://api.github.com/repos/shrimbly/node-banana", { headers: { Accept: "application/vnd.github+json" } })
        .then(function (r) { return r.ok ? r.json() : null; })
        .then(function (data) {
          if (!data || typeof data.stargazers_count !== "number") return;
          var n = data.stargazers_count;
          var text = n >= 1000 ? (n / 1000).toFixed(1).replace(/\.0$/, "") + "k" : String(n);
          stars.textContent = text;
          try { sessionStorage.setItem("nb-stars", text); } catch (e) { /* ignore */ }
        })
        .catch(function () { /* keep the fallback */ });
    }
  }

  /* 5. Reveal: a section gets .is-in once, as it enters the viewport. The CSS
     decides what each block does with it; without this, everything is visible. */
  var sections = document.querySelectorAll(".section");
  if (sections.length && "IntersectionObserver" in window) {
    var seen = new IntersectionObserver(function (entries) {
      entries.forEach(function (entry) {
        if (!entry.isIntersecting) return;
        entry.target.classList.add("is-in");
        seen.unobserve(entry.target);
      });
    }, { rootMargin: "0px 0px -12% 0px", threshold: 0.12 });
    Array.prototype.forEach.call(sections, function (s) { seen.observe(s); });
  } else {
    Array.prototype.forEach.call(sections, function (s) { s.classList.add("is-in"); });
  }

  /* 6. The app window. */
  var canvas = document.querySelector("[data-canvas]");
  var tabs = document.querySelector("[data-tabs]");
  if (!canvas || !tabs || !window.PointerEvent) return;

  var MIN_ZOOM = 0.25, MAX_ZOOM = 2;

  function activeStage() { return canvas.querySelector(".stage--active"); }
  function stageFor(id) { return canvas.querySelector('.stage[data-stage="' + id + '"]'); }

  /* --- viewport: pan and zoom live in --pan-x/--pan-y/--zoom on the stage. The
     CSS default centres the workflow; the first read takes over from there. */
  function viewOf(stage) {
    if (stage._view) return stage._view;
    var m = /matrix\(([^)]+)\)/.exec(getComputedStyle(stage).transform);
    var p = m ? m[1].split(",").map(parseFloat) : [1, 0, 0, 1, 0, 0];
    stage._view = { z: p[0] || 1, x: p[4] || 0, y: p[5] || 0 };
    return stage._view;
  }
  function applyView(stage) {
    var v = viewOf(stage);
    stage.style.setProperty("--zoom", String(v.z));
    stage.style.setProperty("--pan-x", v.x + "px");
    stage.style.setProperty("--pan-y", v.y + "px");
  }
  function zoomAt(stage, factor, cx, cy) {
    var v = viewOf(stage);
    var z = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, v.z * factor));
    var r = canvas.getBoundingClientRect();
    var px = cx - r.left, py = cy - r.top;
    v.x = px - (px - v.x) * (z / v.z);
    v.y = py - (py - v.y) * (z / v.z);
    v.z = z;
    applyView(stage);
  }

  /* --- edges: recomputed from the sockets' own positions inside each node. */
  function pos(node) {
    var cs = getComputedStyle(node);
    return { x: parseFloat(cs.getPropertyValue("--x")) || 0, y: parseFloat(cs.getPropertyValue("--y")) || 0 };
  }
  function socketCenter(node, handle, out) {
    var s = node.querySelector(".socket--" + (out ? "out" : "in") + '[data-handle="' + handle + '"]');
    if (!s) return null;
    var p = pos(node);
    return { x: p.x + s.offsetLeft + (out ? 8.5 : 9.5), y: p.y + s.offsetTop + 14 };
  }
  function curve(sx, sy, tx, ty) {
    var dx = Math.max(60, Math.abs(tx - sx) / 2);
    return "M " + sx + " " + sy + " C " + (sx + dx) + " " + sy + ", " + (tx - dx) + " " + ty + ", " + tx + " " + ty;
  }
  function redraw(stage) {
    Array.prototype.forEach.call(stage.querySelectorAll(".edges path"), function (path) {
      var from = stage.querySelector('[data-node="' + path.getAttribute("data-from") + '"]');
      var to = stage.querySelector('[data-node="' + path.getAttribute("data-to") + '"]');
      if (!from || !to) return;
      var a = socketCenter(from, path.getAttribute("data-from-handle"), true);
      var b = socketCenter(to, path.getAttribute("data-to-handle"), false);
      if (a && b) path.setAttribute("d", curve(a.x, a.y, b.x, b.y));
    });
  }

  /* --- scroll handoff: the fold owns the wheel until the graph's bottom edge has
     been panned above 40% of the canvas, or until the page has scrolled. A quiet
     "Scroll" mark appears after two seconds without a gesture, until the first scroll. */
  var THRESHOLD = 0.4;
  function pastThreshold(stage) {
    var r = canvas.getBoundingClientRect(), bottom = -Infinity;
    Array.prototype.forEach.call(stage.querySelectorAll("[data-node]"), function (n) {
      bottom = Math.max(bottom, n.getBoundingClientRect().bottom);
    });
    return bottom <= r.top + r.height * THRESHOLD;
  }
  var fold = canvas.closest(".fold");
  var hintTimer = null, hintDone = false;
  function touched() {
    if (!fold || hintDone) return;
    fold.classList.remove("is-idle");
    clearTimeout(hintTimer);
    hintTimer = setTimeout(function () { if (!hintDone) fold.classList.add("is-idle"); }, 2000);
  }
  window.addEventListener("scroll", function () {
    if (window.scrollY > 0 && fold) { hintDone = true; fold.classList.remove("is-idle"); clearTimeout(hintTimer); }
  }, { passive: true });
  touched();

  /* --- pointer handling on the canvas: drag a node, or pan the stage. Two
     pointers pinch-zoom. Wheel pans, as the app does; ctrl/cmd + wheel zooms. */
  var pointers = {};
  var gesture = null; /* {kind: "node" | "pan" | "pinch", ...} */

  canvas.addEventListener("pointerdown", function (event) {
    if (event.button !== 0 && event.pointerType === "mouse") return;
    var stage = activeStage();
    if (!stage) return;
    pointers[event.pointerId] = { x: event.clientX, y: event.clientY };
    canvas.setPointerCapture(event.pointerId);
    var ids = Object.keys(pointers);
    if (ids.length === 2) {
      var a = pointers[ids[0]], b = pointers[ids[1]];
      if (gesture && gesture.node) gesture.node.classList.remove("is-dragging");
      canvas.classList.remove("is-panning");
      gesture = { kind: "pinch", dist: Math.hypot(a.x - b.x, a.y - b.y) };
      return;
    }
    var node = event.target.closest("[data-node]");
    var v = viewOf(stage);
    if (node && stage.contains(node)) {
      var p = pos(node);
      gesture = { kind: "node", node: node, ox: event.clientX, oy: event.clientY, x: p.x, y: p.y, z: v.z };
      node.classList.add("is-dragging");
    } else {
      gesture = { kind: "pan", ox: event.clientX, oy: event.clientY, x: v.x, y: v.y };
      canvas.classList.add("is-panning");
    }
    event.preventDefault();
  });
  canvas.addEventListener("pointermove", function (event) {
    if (!pointers[event.pointerId]) return;
    pointers[event.pointerId] = { x: event.clientX, y: event.clientY };
    var stage = activeStage();
    if (!stage || !gesture) return;
    if (gesture.kind === "node") {
      gesture.node.style.setProperty("--x", Math.round(gesture.x + (event.clientX - gesture.ox) / gesture.z) + "px");
      gesture.node.style.setProperty("--y", Math.round(gesture.y + (event.clientY - gesture.oy) / gesture.z) + "px");
      redraw(stage);
    } else if (gesture.kind === "pan") {
      var dx = event.clientX - gesture.ox, dy = event.clientY - gesture.oy;
      gesture.ox = event.clientX; gesture.oy = event.clientY;
      /* Past the threshold, dragging the graph further up scrolls the page instead;
         dragging back down scrolls it back before the graph moves again. */
      if (window.scrollY > 0 || (dy < 0 && pastThreshold(stage))) {
        window.scrollBy(0, -dy);
      } else {
        var v = viewOf(stage);
        v.x += dx;
        v.y += dy;
        applyView(stage);
      }
      touched();
    } else if (gesture.kind === "pinch") {
      var ids = Object.keys(pointers);
      if (ids.length < 2) return;
      var a = pointers[ids[0]], b = pointers[ids[1]];
      var dist = Math.hypot(a.x - b.x, a.y - b.y);
      if (gesture.dist > 0) zoomAt(stage, dist / gesture.dist, (a.x + b.x) / 2, (a.y + b.y) / 2);
      gesture.dist = dist;
    }
  });
  function release(event) {
    delete pointers[event.pointerId];
    var left = Object.keys(pointers);
    if (left.length === 1 && gesture && gesture.kind === "pinch") {
      /* One finger lifted mid-pinch: the other carries on as a pan. */
      gesture = { kind: "pan", ox: pointers[left[0]].x, oy: pointers[left[0]].y };
      canvas.classList.add("is-panning");
      return;
    }
    if (left.length === 0) {
      if (gesture && gesture.node) gesture.node.classList.remove("is-dragging");
      canvas.classList.remove("is-panning");
      gesture = null;
    }
  }
  canvas.addEventListener("pointerup", release);
  canvas.addEventListener("pointercancel", release);

  canvas.addEventListener("wheel", function (event) {
    var stage = activeStage();
    if (!stage) return;
    touched();
    /* The wheel belongs to the page once it has scrolled, and hands over to it as
       soon as the graph has been panned up past the threshold. */
    if (window.scrollY > 0) return;
    if (!(event.ctrlKey || event.metaKey) && event.deltaY > 0 && pastThreshold(stage)) return;
    event.preventDefault();
    if (event.ctrlKey || event.metaKey) {
      zoomAt(stage, Math.exp(-event.deltaY * 0.0025), event.clientX, event.clientY);
    } else {
      var v = viewOf(stage);
      v.x -= event.deltaX;
      v.y -= event.deltaY;
      applyView(stage);
    }
  }, { passive: false });

  /* --- video: every video in a stage plays with its own scrub row following, unless motion is unwelcome. */
  function wireVideo(video) {
    if (video._wired) return;
    video._wired = true;
    var node = video.closest("[data-node]") || video.parentNode;
    var fill = node.querySelector("[data-scrub-fill]"), thumb = node.querySelector("[data-scrub-thumb]"), time = node.querySelector("[data-scrub-time]");
    var fmt = function (t) { t = Math.floor(t || 0); return Math.floor(t / 60) + ":" + ("0" + (t % 60)).slice(-2); };
    video.addEventListener("timeupdate", function () {
      var d = video.duration || 5, pct = Math.min(100, (video.currentTime / d) * 100);
      if (fill) fill.style.setProperty("--pct", pct + "%");
      if (thumb) thumb.style.setProperty("--pct", pct + "%");
      if (time) time.textContent = fmt(video.currentTime) + " / " + fmt(d);
    });
  }
  function playVideo(stage) {
    Array.prototype.forEach.call(stage.querySelectorAll("[data-video]"), function (video) {
      wireVideo(video);
      if (reducedMotion) return;
      var p = video.play();
      if (p && p.catch) p.catch(function () { /* autoplay refused: the poster stays */ });
    });
  }
  function pauseVideo(stage) {
    Array.prototype.forEach.call(stage.querySelectorAll("[data-video]"), function (video) { video.pause(); });
  }

  /* --- tabs: click switches, the × closes, + opens an empty Untitled tab. */
  var untitled = 0;
  function activate(id) {
    Array.prototype.forEach.call(tabs.querySelectorAll("[data-tab]"), function (t) {
      var on = t.getAttribute("data-tab") === id;
      t.classList.toggle("tab--active", on);
      t.classList.toggle("tab--rest", !on);
    });
    Array.prototype.forEach.call(canvas.querySelectorAll(".stage"), function (s) {
      var on = s.getAttribute("data-stage") === id;
      s.classList.toggle("stage--active", on);
      if (on) { viewOf(s); applyView(s); redraw(s); playVideo(s); } else { pauseVideo(s); }
    });
  }
  function closeTab(id) {
    var tab = tabs.querySelector('[data-tab="' + id + '"]');
    var stage = stageFor(id);
    if (!tab) return;
    var wasActive = tab.classList.contains("tab--active");
    var prev = tab.previousElementSibling, next = tab.nextElementSibling;
    var neighbour = (prev && prev.hasAttribute("data-tab")) ? prev : (next && next.hasAttribute("data-tab")) ? next : null;
    tab.remove();
    if (stage) stage.remove();
    if (!neighbour) { newTab(); return; }
    if (wasActive) activate(neighbour.getAttribute("data-tab"));
  }
  function newTab() {
    var id = "untitled-" + (++untitled);
    var proto = tabs.querySelector("[data-tab]");
    var tab = proto ? proto.cloneNode(true) : document.createElement("div");
    if (!proto) tab.innerHTML = '<span class="tab__label"></span>';
    tab.className = "tab tab--untitled";
    tab.setAttribute("data-tab", id);
    tab.querySelector(".tab__label").textContent = "Untitled";
    tabs.insertBefore(tab, tabs.querySelector("[data-new-tab]"));
    var template = canvas.querySelector("[data-empty-stage]");
    var stage = template ? template.content.firstElementChild.cloneNode(true) : document.createElement("div");
    stage.className = "stage";
    stage.setAttribute("data-stage", id);
    canvas.insertBefore(stage, template);
    activate(id);
  }
  tabs.addEventListener("click", function (event) {
    var close = event.target.closest("[data-close]");
    var tab = event.target.closest("[data-tab]");
    if (close && tab) { closeTab(tab.getAttribute("data-tab")); return; }
    if (event.target.closest("[data-new-tab]")) { newTab(); return; }
    if (tab && !tab.classList.contains("tab--active")) activate(tab.getAttribute("data-tab"));
  });

  /* Start: adopt the CSS viewport, draw the edges from the live layout, roll the video. */
  var first = activeStage();
  if (first) {
    var start = function () { viewOf(first); applyView(first); redraw(first); playVideo(first); };
    if (document.fonts && document.fonts.ready) document.fonts.ready.then(start, start); else start();
  }
})();
