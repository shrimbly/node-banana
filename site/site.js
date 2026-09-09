/* Node Banana landing page.
   Everything here is an enhancement: the page reads and works without it.
   1. (The entry animation is gated by the inline script in the page head.)
   2. Read the visitor's platform and point the main download at it.
   3. Close the platform menu on outside click and Escape.
   4. Show the live GitHub star count.
   5. Let the nodes be dragged; the edges follow. */
(function () {
  "use strict";

  var root = document.documentElement;

  /* 1. The entry animation is started by the inline script in index.html. */

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

  /* 4. Stars. The number in the HTML is the fallback. */
  var stars = document.querySelector("[data-stars]");
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

  /* 5. Drag. Node positions live in --x/--y (stage px); the stage is CSS-scaled by --k. */
  var stage = document.querySelector("[data-stage]");
  if (!stage || !window.PointerEvent) return;

  var OUT = { n1: [220, 24], n2: [220, 24], n3: [220, 24] };
  var IN = { n3: [[0, 24], [0, 54]], n4: [[0, 24]] };

  function scale() {
    var t = getComputedStyle(stage).transform;
    var m = /matrix\(([^,]+)/.exec(t);
    return m ? parseFloat(m[1]) || 1 : 1;
  }
  function pos(node) {
    var cs = getComputedStyle(node);
    return { x: parseFloat(cs.getPropertyValue("--x")) || 0, y: parseFloat(cs.getPropertyValue("--y")) || 0 };
  }
  function curve(sx, sy, tx, ty) {
    var dx = Math.max(60, Math.abs(tx - sx) / 2);
    return "M " + sx + " " + sy + " C " + (sx + dx) + " " + sy + ", " + (tx - dx) + " " + ty + ", " + tx + " " + ty;
  }
  function redraw() {
    var svg = Array.prototype.filter.call(stage.querySelectorAll(".edges"), function (s) {
      return getComputedStyle(s).display !== "none";
    })[0];
    if (!svg) return;
    var nodes = {};
    Array.prototype.forEach.call(stage.querySelectorAll("[data-node]"), function (n) { nodes[n.getAttribute("data-node")] = pos(n); });
    Array.prototype.forEach.call(svg.querySelectorAll("path"), function (path) {
      var f = path.getAttribute("data-from"), t = path.getAttribute("data-to"), i = +path.getAttribute("data-in");
      if (!nodes[f] || !nodes[t]) return;
      var sx = nodes[f].x + OUT[f][0] + 5.5, sy = nodes[f].y + OUT[f][1];
      var tx = nodes[t].x + IN[t][i][0] - 5.5, ty = nodes[t].y + IN[t][i][1];
      path.setAttribute("d", curve(sx, sy, tx, ty));
    });
  }

  Array.prototype.forEach.call(stage.querySelectorAll("[data-node]"), function (node) {
    var drag = null;
    node.addEventListener("pointerdown", function (event) {
      if (event.button !== 0) return;
      var p = pos(node);
      drag = { id: event.pointerId, k: scale(), ox: event.clientX, oy: event.clientY, x: p.x, y: p.y };
      node.classList.add("is-dragging");
      node.setPointerCapture(event.pointerId);
      event.preventDefault();
    });
    node.addEventListener("pointermove", function (event) {
      if (!drag || event.pointerId !== drag.id) return;
      node.style.setProperty("--x", Math.round(drag.x + (event.clientX - drag.ox) / drag.k) + "px");
      node.style.setProperty("--y", Math.round(drag.y + (event.clientY - drag.oy) / drag.k) + "px");
      redraw();
    });
    function end(event) {
      if (!drag || event.pointerId !== drag.id) return;
      drag = null;
      node.classList.remove("is-dragging");
    }
    node.addEventListener("pointerup", end);
    node.addEventListener("pointercancel", end);
  });

  /* Dragged positions are per layout; drop them when the layout changes. */
  var lastWidth = window.innerWidth;
  window.addEventListener("resize", function () {
    var crossed = [600, 900].some(function (bp) { return (lastWidth < bp) !== (window.innerWidth < bp); });
    lastWidth = window.innerWidth;
    if (!crossed) return;
    Array.prototype.forEach.call(stage.querySelectorAll("[data-node]"), function (n) {
      n.style.removeProperty("--x");
      n.style.removeProperty("--y");
    });
    redraw();
  });
})();
