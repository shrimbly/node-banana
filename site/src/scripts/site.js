/* Node Banana landing page.
   Everything here is an enhancement: the page reads and works without it.
   1. (The entry animation is gated by the inline script in the page head.)
   2. Read the visitor's platform and point the main download at it.
   3. Close the platform menu on outside click and Escape.
   4. Show the live GitHub star count.
   5. Reveal sections as they arrive, play the agent's one turn in its window, and
      play a feature card's video while it is hovered, and run the Comfy node.
   6. The app window: tabs switch workflows, the canvas pans and zooms, the
      nodes drag and the edges follow, the video plays with its scrub row. */
(function () {
  "use strict";

  var reducedMotion = window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches;

  /* A drift that gathers, travels and settles: phases of [target, ms], each eased
     in and out from the previous target, looping. Returns the value at a time. */
  function driftTimeline(phases, start) {
    var total = 0;
    phases.forEach(function (phase) { total += phase[1]; });
    var ease = function (t) { return t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2; };
    return function (ms) {
      var t = ((ms % total) + total) % total, from = start;
      for (var i = 0; i < phases.length; i++) {
        var to = phases[i][0], dur = phases[i][1];
        if (t < dur) return from + (to - from) * ease(t / dur);
        t -= dur; from = to;
      }
      return from;
    };
  }

  /* 2. Platform. Only the label and the target change; every platform stays in the menu.
     While Windows is "coming soon" it has no download item, so the Mac download is the main button everywhere. */
  var main = document.querySelector("[data-download-main]");
  var label = document.querySelector("[data-platform-label]");
  var items = Array.prototype.slice.call(document.querySelectorAll(".menu__item[data-platform]"));
  var platformHint = (navigator.userAgentData && navigator.userAgentData.platform) || navigator.platform || "";
  var isWindows = /win/i.test(platformHint) || /Windows NT/.test(navigator.userAgent);
  var current = isWindows && items.some(function (item) { return item.getAttribute("data-platform") === "windows"; }) ? "windows" : "mac";
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

  /* Count the download clicks. Vercel Web Analytics counts page views by
     itself, but /download/* answers with a redirect, not a page, so each
     click is sent as an event (the queue the analytics script installs). */
  document.addEventListener("click", function (event) {
    var link = event.target.closest && event.target.closest('a[href^="/download"]');
    if (!link || !window.va) return;
    var platform = (link.getAttribute("href").split("/")[2] || "latest").split("?")[0];
    window.va("event", { name: "Download", data: { platform: platform } });
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

  /* 5b. The agent section: its one turn plays once as the window arrives. The
     markup is the finished turn; this hides it, then brings it back in order. */
  /* Its own scope: section 6 below declares names of its own (start, ...). */
  (function (play) {
    if (!play || reducedMotion || !("IntersectionObserver" in window)) return;
    var pick = function (step) { return play.querySelector('[data-step="' + step + '"]'); };
    var steps = { send: pick("send"), status: pick("status"), think: pick("think"), reply: pick("reply"), meta: pick("meta") };
    var toolRows = play.querySelectorAll("[data-tool]");
    var built = play.querySelector(".astage");
    var input = play.querySelector(".aw__input");
    var typed = play.querySelector("[data-typed]");
    if (steps.send && steps.reply && built && input && typed && toolRows.length === 3) {
      var message = steps.send.textContent;
      var replyText = steps.reply.textContent;
      play.classList.add("is-armed");

      var t = 0;
      var at = function (delay, fn) { t += delay; setTimeout(fn, t); };
      var on = function (el) { el.classList.add("is-on"); };
      var run = function (row) { on(row); row.classList.add("is-running"); };
      var done = function (row) { row.classList.remove("is-running"); };

      var start = function () {
        input.classList.add("is-typing");
        var n = 0;
        var type = setInterval(function () {
          typed.textContent = message.slice(0, ++n);
          if (n < message.length) return;
          clearInterval(type);
          at(380, function () {
            typed.textContent = "";
            input.classList.remove("is-typing");
            play.classList.add("is-busy");
            on(steps.send);
            if (steps.status) on(steps.status);
          });
          at(1100, function () {
            if (steps.status) steps.status.classList.remove("is-on");
            on(steps.think);
            run(toolRows[0]);
          });
          at(900, function () { done(toolRows[0]); run(toolRows[1]); built.classList.add("is-built"); });
          at(1100, function () { built.classList.add("is-wired"); });
          at(700, function () { done(toolRows[1]); run(toolRows[2]); });
          at(800, function () { done(toolRows[2]); built.classList.add("is-tidy"); });
          at(500, function () {
            var words = replyText.split(" ");
            var w = 0;
            steps.reply.textContent = "";
            on(steps.reply);
            var stream = setInterval(function () {
              steps.reply.textContent = words.slice(0, ++w).join(" ");
              if (w < words.length) return;
              clearInterval(stream);
              if (steps.meta) on(steps.meta);
              play.classList.remove("is-busy");
            }, 45);
          });
        }, 18);
      };

      var watch = new IntersectionObserver(function (entries) {
        if (!entries[0].isIntersecting) return;
        watch.disconnect();
        setTimeout(start, 300);
      }, { threshold: 0.45 });
      watch.observe(play);
    }
  })(document.querySelector("[data-agent-play]"));

  /* 5b'. On a phone the agent window's graph is wider than the screen and scrolls sideways;
     it drifts across by itself, after the build animation, until the first touch. */
  (function (graph) {
    if (!graph || reducedMotion || !window.matchMedia || !window.matchMedia("(max-width: 599px)").matches || !("IntersectionObserver" in window)) return;
    var done = false, started = false, paused = true, pausedAt = 0, shift = 0, t0 = null, frame = 0;
    /* From the left end: a breath, across to the right, a pause, back, a pause. */
    var at = driftTimeline([[0, 1500], [1, 7000], [1, 2400], [0, 7000], [0, 2400]], 0);
    function step(now) {
      if (done || paused) return;
      if (t0 === null) t0 = now;
      graph.scrollLeft = (graph.scrollWidth - graph.clientWidth) * at(now - t0 - shift);
      frame = requestAnimationFrame(step);
    }
    function play() { if (done || !paused) return; paused = false; if (pausedAt) shift += performance.now() - pausedAt; frame = requestAnimationFrame(step); }
    function rest() { if (paused) return; paused = true; pausedAt = performance.now(); cancelAnimationFrame(frame); }
    function stop() { done = true; cancelAnimationFrame(frame); }
    graph.addEventListener("touchstart", stop, { passive: true });
    graph.addEventListener("pointerdown", stop, { passive: true });
    graph.addEventListener("wheel", stop, { passive: true });
    new IntersectionObserver(function (entries) {
      if (done) return;
      if (!entries[0].isIntersecting) { rest(); return; }
      if (!started) { started = true; setTimeout(play, 2600); } else play();
    }, { threshold: 0.4 }).observe(graph);
  })(document.querySelector(".agraph"));

  /* 5c. The feature cards play on hover (CSS); a card's video plays with it, from the start. */
  (function () {
    if (reducedMotion || !window.matchMedia || !window.matchMedia("(hover: hover)").matches) return;
    Array.prototype.forEach.call(document.querySelectorAll(".dcard"), function (card) {
      var video = card.querySelector("video[data-hover-play]");
      if (!video) return;
      video.muted = true;
      card.addEventListener("pointerenter", function () {
        // The view pans up first; the cars start as they come into view.
        video.currentTime = 0;
        clearTimeout(video._start);
        video._start = setTimeout(function () { var p = video.play(); if (p && p.catch) p.catch(function () {}); }, 500);
      });
      card.addEventListener("pointerleave", function () {
        clearTimeout(video._start);
        video.pause();
        video.currentTime = 0;
      });
    });
  })();

  /* 5c'. Without hover (phones, tablets) a card plays as it scrolls into view and resets
     when it leaves, so it reads with its motion every time. */
  (function () {
    if (reducedMotion || !window.matchMedia || !("IntersectionObserver" in window)) return;
    if (window.matchMedia("(hover: hover)").matches && !window.matchMedia("(max-width: 899px)").matches) return;
    var cards = Array.prototype.slice.call(document.querySelectorAll(".dcard"));
    if (!cards.length) return;
    var watch = new IntersectionObserver(function (entries) {
      entries.forEach(function (entry) {
        var card = entry.target, video = card.querySelector("video[data-hover-play]");
        if (entry.isIntersecting) {
          card.classList.add("is-live");
          if (video) { video.muted = true; video.currentTime = 0; clearTimeout(video._start); video._start = setTimeout(function () { var p = video.play(); if (p && p.catch) p.catch(function () {}); }, 500); }
        } else {
          card.classList.remove("is-live");
          if (video) { clearTimeout(video._start); video.pause(); video.currentTime = 0; }
        }
      });
    }, { threshold: 0.6 });
    cards.forEach(function (card) { watch.observe(card); });
  })();

  /* 5e. On a phone the agent facts are an accordion: the first open, the others closed.
     Without this script they all stay open, which still reads. */
  (function () {
    if (!window.matchMedia || !window.matchMedia("(max-width: 599px)").matches) return;
    Array.prototype.forEach.call(document.querySelectorAll("details.fact"), function (fact, i) { if (i > 0) fact.open = false; });
  })();

  /* 5d. The Comfy node: click to select it, drag a side edge to resize it as the app does
     (260px up to its column, the media keeps its aspect), open its settings from the summary row. */
  (function (node) {
    if (!node) return;
    var graph = node.parentElement;
    var MIN_W = 260, MAX_W = 1200;
    var toggle = node.querySelector("[data-ccard-toggle]");
    var card = node.querySelector("[data-ccard]");
    var num = function (name) { return parseFloat(node.style.getPropertyValue(name)) || 0; };
    var set = function (w, x) { node.style.setProperty("--w", Math.round(w) + "px"); node.style.setProperty("--x", Math.round(x) + "px"); };
    var room = function () { return Math.min(MAX_W, graph.clientWidth); };
    // Keep it inside its column when the page narrows.
    var fit = function () {
      var w = num("--w"), x = num("--x"), max = room();
      if (x + w > max) { x = Math.max(0, max - w); w = Math.min(w, max - x); set(Math.max(Math.min(MIN_W, max), w), x); }
    };
    fit();
    window.addEventListener("resize", fit);

    var select = function (on) { node.classList.toggle("is-selected", on); };
    document.addEventListener("pointerdown", function (event) { select(node.contains(event.target)); });
    document.addEventListener("keydown", function (event) { if (event.key === "Escape") select(false); });

    if (toggle && card) {
      var flip = function () {
        var open = !card.classList.contains("is-open");
        card.classList.toggle("is-open", open);
        toggle.setAttribute("aria-expanded", String(open));
        toggle.setAttribute("aria-label", open ? "Hide settings" : "Show settings");
      };
      toggle.addEventListener("click", function (event) { if (!event.target.closest("button")) flip(); });
      toggle.addEventListener("keydown", function (event) {
        if ((event.key === "Enter" || event.key === " ") && event.target === toggle) { event.preventDefault(); flip(); }
      });

      // WidthGrip: both edges resize the card symmetrically, 160–720px; double-click hands it back to the node width.
      Array.prototype.forEach.call(card.querySelectorAll("[data-wgrip]"), function (grip) {
        var sign = grip.getAttribute("data-wgrip") === "right" ? 1 : -1;
        var drag = null;
        grip.addEventListener("pointerdown", function (event) {
          if (event.button !== 0) return;
          event.preventDefault();
          event.stopPropagation();
          grip.setPointerCapture(event.pointerId);
          drag = { x0: event.clientX, w: card.getBoundingClientRect().width };
        });
        grip.addEventListener("pointermove", function (event) {
          if (!drag) return;
          var w = Math.round(Math.max(160, Math.min(720, drag.w + (event.clientX - drag.x0) * sign * 2)));
          card.style.width = w + "px";
          card.style.maxWidth = "none";
        });
        var end = function () { drag = null; };
        grip.addEventListener("pointerup", end);
        grip.addEventListener("pointercancel", end);
        grip.addEventListener("dblclick", function (event) {
          event.preventDefault();
          card.style.width = "";
          card.style.maxWidth = "";
        });
      });
    }

    // Drag: the node follows the pointer and its controls card trails the media card, as NodeShell's
    // useTrailingOffset does (eases 40% of the gap per frame, never more than 18px behind). Let go
    // and it springs back to where it sat.
    (function () {
      var TRAIL_EASE = 0.4, TRAIL_MAX = 18, SNAP_MS = 420;
      var trail = { x: 0, y: 0 }, target = { x: 0, y: 0 }, frame = null, last = 0, snap = null;
      var base = null, drag = null, moved = false;
      var place = function (dx, dy) {
        target.x = dx; target.y = dy;
        node.style.setProperty("--x", (base.x + dx).toFixed(1) + "px");
        node.style.setProperty("--y", (base.y + dy).toFixed(1) + "px");
        if (frame === null) { last = performance.now(); frame = requestAnimationFrame(step); }
      };
      var step = function (now) {
        frame = null;
        var dt = Math.min(64, now - last); last = now;
        if (snap) {
          var t = Math.min(1, (now - snap.t0) / SNAP_MS), e = 1 - Math.pow(1 - t, 3);
          var sx = snap.x * (1 - e), sy = snap.y * (1 - e);
          target.x = sx; target.y = sy;
          node.style.setProperty("--x", (base.x + sx).toFixed(1) + "px");
          node.style.setProperty("--y", (base.y + sy).toFixed(1) + "px");
          if (t >= 1) { snap = null; node.classList.remove("is-dragging"); }
        }
        var k = 1 - Math.pow(1 - TRAIL_EASE, dt / 16.7);
        trail.x += (target.x - trail.x) * k;
        trail.y += (target.y - trail.y) * k;
        var dx = trail.x - target.x, dy = trail.y - target.y, dist = Math.hypot(dx, dy);
        if (dist > TRAIL_MAX) { dx *= TRAIL_MAX / dist; dy *= TRAIL_MAX / dist; trail.x = target.x + dx; trail.y = target.y + dy; }
        var settled = Math.abs(dx) < 0.2 && Math.abs(dy) < 0.2;
        if (card) card.style.transform = settled ? "" : "translate3d(" + dx.toFixed(2) + "px, " + dy.toFixed(2) + "px, 0)";
        if (!settled || snap || drag) frame = requestAnimationFrame(step);
      };
      var nodrag = "[data-resize], [data-wgrip], .socket, .ccard__body, button, input, select, [data-dd]";
      node.addEventListener("pointerdown", function (event) {
        if (event.button !== 0 || event.target.closest(nodrag)) return;
        if (snap) { snap = null; } else { base = { x: num("--x"), y: num("--y") }; }
        drag = { x0: event.clientX - target.x, y0: event.clientY - target.y, id: event.pointerId };
        moved = false;
      });
      window.addEventListener("pointermove", function (event) {
        if (!drag || event.pointerId !== drag.id) return;
        var dx = event.clientX - drag.x0, dy = event.clientY - drag.y0;
        if (!moved && Math.hypot(dx, dy) < 3) return;
        if (!moved) { moved = true; node.classList.add("is-dragging"); node.setPointerCapture && node.setPointerCapture(drag.id); }
        event.preventDefault();
        place(dx, dy);
      });
      var release = function (event) {
        if (!drag || (event && event.pointerId !== drag.id)) return;
        drag = null;
        if (!moved) return;
        snap = { t0: performance.now(), x: target.x, y: target.y };
        if (frame === null) { last = performance.now(); frame = requestAnimationFrame(step); }
      };
      window.addEventListener("pointerup", release);
      window.addEventListener("pointercancel", release);
      // A drag that started on the summary row is not a click on it.
      node.addEventListener("click", function (event) { if (moved) { event.stopPropagation(); event.preventDefault(); moved = false; } }, true);
    })();

    // Seed: Randomise.
    Array.prototype.forEach.call(node.querySelectorAll("[data-randomise]"), function (button) {
      button.addEventListener("click", function () {
        var input = button.parentElement.querySelector("input");
        if (input) input.value = String(Math.floor(Math.random() * 1000000000));
      });
    });

    // Dropdowns: open under their trigger, pick with the pointer or the keys, close on outside click or Escape.
    var openDd = null;
    var closeDd = function () {
      if (!openDd) return;
      openDd.list.hidden = true;
      openDd.trigger.setAttribute("aria-expanded", "false");
      openDd = null;
    };
    Array.prototype.forEach.call(node.querySelectorAll("[data-dd]"), function (dd) {
      var trigger = dd.querySelector(".dd__trigger");
      var list = dd.querySelector(".dd__list");
      var value = dd.querySelector(".dd__value");
      var opts = Array.prototype.slice.call(list.querySelectorAll(".dd__opt"));
      var pick = function (opt) {
        opts.forEach(function (o) { o.setAttribute("aria-selected", String(o === opt)); });
        value.textContent = opt.getAttribute("data-value");
        closeDd();
        trigger.focus();
      };
      trigger.addEventListener("click", function () {
        if (openDd && openDd.list === list) { closeDd(); return; }
        closeDd();
        // Fixed inside the transformed node, so its coordinates are the node's.
        var t = trigger.getBoundingClientRect(), n = node.getBoundingClientRect();
        list.style.left = Math.round(t.left - n.left) + "px";
        list.style.top = Math.round(t.bottom - n.top + 4) + "px";
        // Dropdown size "node": 160px at least, 280px at most.
        list.style.minWidth = Math.min(280, Math.max(160, Math.round(t.width))) + "px";
        list.style.maxWidth = "280px";
        list.hidden = false;
        trigger.setAttribute("aria-expanded", "true");
        openDd = { list: list, trigger: trigger };
      });
      opts.forEach(function (opt) { opt.addEventListener("click", function () { pick(opt); }); });
      dd.addEventListener("keydown", function (event) {
        if (!openDd || openDd.list !== list) return;
        var i = opts.indexOf(list.querySelector(".is-active") || list.querySelector('[aria-selected="true"]'));
        if (event.key === "ArrowDown" || event.key === "ArrowUp") {
          event.preventDefault();
          i = Math.max(0, Math.min(opts.length - 1, i + (event.key === "ArrowDown" ? 1 : -1)));
          opts.forEach(function (o, k) { o.classList.toggle("is-active", k === i); });
        } else if (event.key === "Enter") {
          event.preventDefault();
          if (opts[i]) pick(opts[i]);
        } else if (event.key === "Escape") {
          event.stopPropagation();
          closeDd();
          trigger.focus();
        }
      });
    });
    document.addEventListener("pointerdown", function (event) {
      if (openDd && !openDd.list.contains(event.target) && !openDd.trigger.contains(event.target)) closeDd();
    });

    Array.prototype.forEach.call(node.querySelectorAll("[data-resize]"), function (handle) {
      var side = handle.getAttribute("data-resize");
      var drag = null;
      handle.addEventListener("pointerdown", function (event) {
        if (event.button !== 0) return;
        event.preventDefault();
        event.stopPropagation();
        select(true);
        handle.setPointerCapture(event.pointerId);
        drag = { x0: event.clientX, w: num("--w"), x: num("--x") };
        node.classList.add("is-resizing");
        node.classList.add("is-resized");
      });
      handle.addEventListener("pointermove", function (event) {
        if (!drag) return;
        var dx = event.clientX - drag.x0, max = room(), w;
        if (side === "right") {
          w = Math.max(MIN_W, Math.min(max - drag.x, drag.w + dx));
          set(w, drag.x);
        } else {
          // The left edge moves; the right edge stays put, as on the canvas.
          w = Math.max(MIN_W, Math.min(drag.w + drag.x, drag.w - dx));
          set(w, drag.x + drag.w - w);
        }
      });
      var end = function () { drag = null; node.classList.remove("is-resizing"); };
      handle.addEventListener("pointerup", end);
      handle.addEventListener("pointercancel", end);
    });
  })(document.querySelector("[data-comfy-node]"));

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
    homeTop(stage);
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

  /* --- scroll handoff: the fold owns the wheel until the graph has been panned
     HANDOFF px up from where it started, or until the page has scrolled. It never
     moves below where it started, so scrolling up stops there. A quiet "Scroll"
     mark appears after two seconds without a gesture, until the first scroll. */
  var HANDOFF = 120;
  function graphTop(stage) {
    var top = Infinity;
    Array.prototype.forEach.call(stage.querySelectorAll("[data-node]"), function (n) {
      top = Math.min(top, n.getBoundingClientRect().top);
    });
    return top - canvas.getBoundingClientRect().top;
  }
  /* Where the graph's top edge sat before the first gesture on this stage. */
  function homeTop(stage) {
    if (stage._homeTop === undefined) stage._homeTop = graphTop(stage);
    return stage._homeTop;
  }
  function pastThreshold(stage) {
    return graphTop(stage) <= homeTop(stage) - HANDOFF;
  }
  /* Pan by (dx, dy), never bringing the graph down past its starting place. */
  function panBy(stage, dx, dy) {
    var home = homeTop(stage);
    var v = viewOf(stage);
    v.x += dx;
    v.y += Math.min(dy, Math.max(0, home - graphTop(stage)));
    applyView(stage);
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

  /* --- phones: at phone zoom the graph is wider than the screen, so it drifts
     across by itself, out to one end and back, until the first touch on the
     canvas hands the panning to the visitor for good. It rests while the fold
     is off screen, and never runs for a visitor who asked for less motion. */
  var autoPan = null, autoPanDone = false;
  var phone = window.matchMedia ? window.matchMedia("(max-width: 599px)") : null;

  /* On a phone the mannequin workflow is laid out in two columns instead of one
     long row, so most of it is on screen at once; the rest is below, and the
     drift runs down the graph instead of across it. World positions only: the
     edges are redrawn from the sockets as they are after the move. */
  var PHONE_LAYOUTS = {
    mannequin: {
      /* Under 900px the stylesheet centres the view on (cx, cy): the graph's middle across, and
         a point a little under its top row down, so the first view starts at the top. */
      gx: 0, gy: 0, gw: 907, cx: 453, cy: 380, zoom: 0.38,
      nodes: { "imageInput-22": [0, 0], "prompt-23": [0, 680], "nanoBanana-3": [520, 0], "promptConstructor-13": [520, 640], "generateVideo-17": [520, 900] },
    },
  };
  function layoutForPhone(stage) {
    var layout = PHONE_LAYOUTS[stage.getAttribute("data-stage")];
    if (!layout || !phone || !phone.matches || stage._phoneLaidOut) return;
    stage._phoneLaidOut = true;
    Object.keys(layout.nodes).forEach(function (id) {
      var node = stage.querySelector('[data-node="' + id + '"]');
      if (!node) return;
      node.style.setProperty("--x", layout.nodes[id][0] + "px");
      node.style.setProperty("--y", layout.nodes[id][1] + "px");
    });
    stage.style.setProperty("--gx", layout.gx + "px");
    stage.style.setProperty("--gy", layout.gy + "px");
    stage.style.setProperty("--gw", layout.gw + "px");
    stage.style.setProperty("--cx", layout.cx + "px");
    stage.style.setProperty("--cy", layout.cy + "px");
    stage.style.setProperty("--zoom-phone", String(layout.zoom));
    /* Any view the script had written stays inline and would win over the new
       CSS centring; drop it so the stylesheet lays the graph out afresh. */
    ["--zoom", "--pan-x", "--pan-y"].forEach(function (name) { stage.style.removeProperty(name); });
    stage._view = undefined;
    redraw(stage);
    homeTop(stage);        /* the scroll handoff measures from the laid-out top, not a drifted one */
  }
  Array.prototype.forEach.call(canvas.querySelectorAll(".stage"), layoutForPhone);

  function startAutoPan() {
    if (autoPan || autoPanDone || reducedMotion || !phone || !phone.matches) return;
    var stage = activeStage();
    if (!stage) return;
    var r = canvas.getBoundingClientRect(), left = Infinity, right = -Infinity, top = Infinity, bottom = -Infinity;
    Array.prototype.forEach.call(stage.querySelectorAll("[data-node]"), function (n) {
      var b = n.getBoundingClientRect();
      left = Math.min(left, b.left - r.left);
      right = Math.max(right, b.right - r.left);
      top = Math.min(top, b.top - r.top);
      bottom = Math.max(bottom, b.bottom - r.top);
    });
    if (!isFinite(left)) return;
    /* Drift along the axis the graph overflows most; none if it fits. */
    var acrossBy = right - left - r.width, downBy = bottom - top - r.height;
    if (acrossBy <= 0 && downBy <= 0) return;
    var vertical = downBy > acrossBy;
    var v = viewOf(stage), x0 = v.x, y0 = v.y;
    var margin = 20;
    var reachRight = vertical ? Math.min(0, (r.height - margin) - bottom) : Math.min(0, (r.width - margin) - right); /* pan this far to show the far end */
    var reachLeft = vertical ? Math.max(0, margin - top) : Math.max(0, margin - left);                               /* and this far to show the near end */
    /* From the centre: a breath, out to the right end, a pause there, across to
       the left end, a pause, back to the centre; eased, so it gathers and settles. */
    var at = driftTimeline([[0, 1400], [1, 6500], [1, 2200], [-1, 9000], [-1, 2200], [0, 6500]], 0);
    var t0 = null, shift = 0;
    var run = { stage: stage, frame: 0, paused: false, pausedAt: 0 };
    function step(now) {
      if (autoPan !== run || run.paused) return;
      if (t0 === null) t0 = now;
      var s = at(now - t0 - shift); /* -1..1, from the start */
      var d = s > 0 ? reachRight * s : reachLeft * -s;
      if (vertical) v.y = y0 + d; else v.x = x0 + d;
      applyView(stage);
      run.frame = requestAnimationFrame(step);
    }
    run.pause = function () { if (run.paused) return; run.paused = true; run.pausedAt = performance.now(); cancelAnimationFrame(run.frame); };
    run.resume = function () { if (!run.paused) return; run.paused = false; shift += performance.now() - run.pausedAt; run.frame = requestAnimationFrame(step); };
    autoPan = run;
    run.frame = requestAnimationFrame(step);
  }
  function stopAutoPan() {
    if (!autoPan) return;
    cancelAnimationFrame(autoPan.frame);
    autoPan = null;
  }
  /* The first touch on the canvas ends the drift; the pan and pinch below take over. */
  canvas.addEventListener("pointerdown", function () { autoPanDone = true; stopAutoPan(); }, true);
  if ("IntersectionObserver" in window) {
    new IntersectionObserver(function (entries) {
      var seen = entries[0].isIntersecting;
      if (autoPan) { if (seen) autoPan.resume(); else autoPan.pause(); }
      else if (seen) startAutoPan();
    }, { threshold: 0.3 }).observe(canvas);
  }
  /* After the entry animation has settled the view. */
  setTimeout(startAutoPan, 1500);

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
        panBy(stage, dx, dy);
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
      panBy(stage, -event.deltaX, -event.deltaY);
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
    stopAutoPan();
    var next = stageFor(id);
    if (next) layoutForPhone(next);
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
    setTimeout(startAutoPan, 50);
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
