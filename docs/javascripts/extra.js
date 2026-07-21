(() => {
  const CIRCUMFERENCE = 2 * Math.PI * 11;
  const CONSOLE_THEME_KEY = "soc.theme";
  const systemTheme = window.matchMedia?.("(prefers-color-scheme: dark)");

  const readConsoleTheme = () => {
    try {
      const saved = window.localStorage.getItem(CONSOLE_THEME_KEY);
      return saved === "light" || saved === "dark" || saved === "system" ? saved : "system";
    } catch (_) {
      return "system";
    }
  };

  const writeConsoleTheme = (mode) => {
    try {
      window.localStorage.setItem(CONSOLE_THEME_KEY, mode);
    } catch (_) {
      /* Storage may be unavailable; the current document can still switch. */
    }

    // The Console reconciles its local first-paint mirror with the signed-in
    // user's effective preference. Persist the same choice there as a best-effort
    // same-origin request so switching inside a guide also survives the return to
    // the application. A disconnected/legacy backend must never prevent the local
    // documentation theme from changing.
    void window.fetch("/api/prefs/user", {
      method: "PUT",
      credentials: "include",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ theme_mode: mode }),
    }).catch(() => undefined);
  };

  const resolveDark = (mode) => mode === "dark" || (mode === "system" && Boolean(systemTheme?.matches));

  const applyRootTheme = (dark) => {
    const root = document.documentElement;
    root.dataset.tlsocTheme = dark ? "dark" : "light";
    root.style.colorScheme = dark ? "dark" : "light";
  };

  const getToggle = (id) => {
    const element = document.getElementById(id);
    return element instanceof HTMLInputElement ? element : null;
  };

  const setToggle = (id, checked) => {
    const toggle = getToggle(id);
    if (!toggle || toggle.checked === checked) return;
    toggle.checked = checked;
    toggle.dispatchEvent(new Event("change", { bubbles: true }));
  };

  const syncDrawerButtons = () => {
    const expanded = Boolean(getToggle("__drawer")?.checked);
    const mobile = window.matchMedia("(max-width: 47.999rem)").matches;
    const sidebar = document.querySelector(".md-sidebar--primary");
    if (sidebar instanceof HTMLElement) {
      sidebar.inert = mobile && !expanded;
      if (mobile && !expanded) sidebar.setAttribute("aria-hidden", "true");
      else sidebar.removeAttribute("aria-hidden");
    }
    document.querySelectorAll("[data-tlsoc-open-drawer]").forEach((button) => {
      button.setAttribute("aria-expanded", String(expanded));
      button.setAttribute("aria-label", expanded ? "Close navigation" : "Open navigation");
    });
  };

  const openSearch = () => {
    setToggle("__search", true);
    window.setTimeout(() => {
      const searchInput = document.querySelector(".md-search__input");
      if (searchInput instanceof HTMLInputElement) searchInput.focus();
    }, 50);
  };

  const syncThemeSwitch = () => {
    const dark = document.body.getAttribute("data-md-color-scheme") === "slate";
    applyRootTheme(dark);
    document.querySelectorAll("[data-tlsoc-theme-toggle]").forEach((button) => {
      const label = dark ? "Switch to light mode" : "Switch to dark mode";
      button.setAttribute("aria-label", label);
      button.setAttribute("aria-pressed", String(dark));
      button.setAttribute("title", label);
      button.setAttribute("data-tlsoc-current-theme", dark ? "dark" : "light");
    });
  };

  const setPaletteScheme = (targetScheme, persistedMode) => {
    const input = document.querySelector(
      `.tlsoc-palette-engine input[data-md-color-scheme="${targetScheme}"]`,
    );
    if (!(input instanceof HTMLInputElement)) return;
    if (persistedMode) writeConsoleTheme(persistedMode);
    applyRootTheme(targetScheme === "slate");
    if (!input.checked) input.click();
    syncThemeSwitch();
  };

  const toggleTheme = () => {
    const dark = document.body.getAttribute("data-md-color-scheme") === "slate";
    setPaletteScheme(dark ? "default" : "slate", dark ? "light" : "dark");
  };

  const syncFromConsoleTheme = () => {
    const mode = readConsoleTheme();
    setPaletteScheme(resolveDark(mode) ? "slate" : "default");
  };

  const tocButton = () => document.querySelector("[data-tlsoc-mobile-toc-toggle]");
  const tocPopover = () => document.getElementById("tlsoc-mobile-toc-popover");

  const setTocOpen = (open) => {
    const button = tocButton();
    const popover = tocPopover();
    if (!(button instanceof HTMLButtonElement) || !(popover instanceof HTMLElement)) return;
    button.setAttribute("aria-expanded", String(open));
    popover.hidden = !open;
  };

  document.addEventListener("click", (event) => {
    const target = event.target;
    if (!(target instanceof Element)) return;

    if (target.closest("[data-tlsoc-theme-toggle]")) {
      toggleTheme();
      return;
    }

    if (target.closest("[data-tlsoc-open-search]")) {
      openSearch();
      return;
    }

    if (target.closest("[data-tlsoc-open-drawer]")) {
      const drawer = getToggle("__drawer");
      if (drawer) setToggle("__drawer", !drawer.checked);
      return;
    }

    if (target.closest("[data-tlsoc-close-drawer]")) {
      setToggle("__drawer", false);
      document.querySelector("[data-tlsoc-open-drawer]")?.focus();
      return;
    }

    if (target.closest("[data-tlsoc-mobile-toc-toggle]")) {
      const button = tocButton();
      setTocOpen(button?.getAttribute("aria-expanded") !== "true");
      return;
    }

    const popover = tocPopover();
    if (target.closest("#tlsoc-mobile-toc-popover a")) {
      setTocOpen(false);
      return;
    }

    if (popover && !popover.hidden && !target.closest("#tlsoc-mobile-toc-popover")) {
      setTocOpen(false);
    }
  });

  document.addEventListener("change", (event) => {
    const target = event.target;
    if (target instanceof HTMLInputElement && target.id === "__drawer") syncDrawerButtons();
  });

  document.addEventListener("keydown", (event) => {
    if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
      event.preventDefault();
      openSearch();
      return;
    }

    if (event.key !== "Escape") return;
    setTocOpen(false);
    setToggle("__drawer", false);
  });

  let scrollFrame = 0;
  const updateReadingState = () => {
    scrollFrame = 0;
    const root = document.documentElement;
    const maxScroll = Math.max(0, root.scrollHeight - window.innerHeight);
    const progress = maxScroll ? Math.min(1, Math.max(0, window.scrollY / maxScroll)) : 0;
    const ring = document.querySelector(".tlsoc-progress-ring circle:last-child");
    if (ring instanceof SVGElement) {
      ring.style.strokeDashoffset = String(CIRCUMFERENCE * (1 - progress));
    }

    const headings = Array.from(document.querySelectorAll(".md-content__inner h2[id], .md-content__inner h3[id]"));
    const active = headings.reduce((current, heading) => {
      return heading.getBoundingClientRect().top <= 180 ? heading : current;
    }, null);
    const label = document.querySelector(".tlsoc-mobile-tocbar__label");
    if (label && active) {
      const cleanHeading = active.cloneNode(true);
      if (cleanHeading instanceof HTMLElement) {
        cleanHeading.querySelectorAll(".headerlink").forEach((permalink) => permalink.remove());
        label.textContent = cleanHeading.textContent?.trim() || label.textContent;
      }
    }
  };

  const requestReadingUpdate = () => {
    if (scrollFrame) return;
    scrollFrame = window.requestAnimationFrame(updateReadingState);
  };

  window.addEventListener("scroll", requestReadingUpdate, { passive: true });
  window.addEventListener("resize", () => {
    syncDrawerButtons();
    requestReadingUpdate();
  });
  systemTheme?.addEventListener?.("change", () => {
    if (readConsoleTheme() === "system") syncFromConsoleTheme();
  });
  window.addEventListener("storage", (event) => {
    if (event.key === CONSOLE_THEME_KEY) syncFromConsoleTheme();
  });
  new MutationObserver(syncThemeSwitch).observe(document.body, {
    attributes: true,
    attributeFilter: ["data-md-color-scheme"],
  });
  syncDrawerButtons();
  syncFromConsoleTheme();
  syncThemeSwitch();
  updateReadingState();
})();
