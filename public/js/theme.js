// Light or dark look: follows the phone's setting unless someone picks one in the menu (Appearance).
// A plain script loaded before the page draws, so the app never flashes the wrong colors.
(function () {
  var mq = window.matchMedia ? window.matchMedia("(prefers-color-scheme: dark)") : null;
  var chosen = null; // kept here too, for a browser that won't store it (private mode)
  function pick() {
    if (chosen) return chosen;
    try { return localStorage.getItem("gc-theme") || "auto"; } catch (e) { return "auto"; }
  }
  function apply() {
    var p = pick();
    var dark = p === "dark" || (p === "auto" && !!mq && mq.matches);
    document.documentElement.setAttribute("data-theme", dark ? "dark" : "light");
    try { document.dispatchEvent(new Event("gc-theme")); } catch (e) { /* very old browser */ }
  }
  apply();
  if (mq && mq.addEventListener) mq.addEventListener("change", apply);
  else if (mq && mq.addListener) mq.addListener(apply);
  window.gcTheme = {
    /** "auto", "light" or "dark" */
    get: pick,
    set: function (v) {
      chosen = v;
      try {
        if (v === "auto") localStorage.removeItem("gc-theme");
        else localStorage.setItem("gc-theme", v);
      } catch (e) { /* not stored: applies until the app is closed */ }
      apply();
    },
    dark: function () { return document.documentElement.getAttribute("data-theme") === "dark"; },
  };
})();
