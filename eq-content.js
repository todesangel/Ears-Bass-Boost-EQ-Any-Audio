// Ears content script: hosts the Web Audio graph inside the page.
//
// Firefox has no tabCapture and no offscreen documents, so the equalizer runs
// here instead of in the background. Every <audio>/<video> element on the page
// is routed through a shared filter chain:
//
//   media sources -> biquad[0..n] -> gain -> analyser -> destination
//
// createMediaElementSource() is irreversible, so disabling re-routes the
// sources straight to the destination rather than tearing the graph down.

(function () {
  'use strict';

  // Content scripts from the same extension share a sandbox per document, so
  // repeated scripting.executeScript() injections must not re-register.
  if (window.__earsEq) {
    return;
  }

  const SILENCE_PROBE_MS = 1500;
  const SILENCE_PROBES_BEFORE_BYPASS = 4;

  const state = {
    context: null,
    filterNodes: [],
    gainNode: null,
    analyser: null,
    sources: new WeakMap(),
    unattachable: new WeakSet(),
    attached: [],
    enabled: false,
    observer: null,
    filters: [],
    gain: 1,
    silenceTimer: null,
    silentProbes: 0,
    notice: null
  };

  window.__earsEq = state;

  function isMediaElement(node) {
    const tag = node && node.tagName;
    return tag === 'AUDIO' || tag === 'VIDEO';
  }

  function notify(reason) {
    state.notice = reason;
    browser.runtime.sendMessage({ type: 'earsNotice', reason }).catch(() => {});
  }

  // --- graph -------------------------------------------------------------

  function buildFilterNodes(context, filters) {
    return filters.map((filter) => {
      const node = context.createBiquadFilter();
      node.type = filter.type;
      node.frequency.value = filter.frequency;
      node.gain.value = filter.gain;
      node.Q.value = filter.q;
      return node;
    });
  }

  function applyFilterValues(nodes, filters) {
    for (let i = 0; i < nodes.length; i += 1) {
      const filter = filters[i];
      if (!filter) {
        continue;
      }
      const node = nodes[i];
      node.type = filter.type;
      node.frequency.value = filter.frequency;
      node.gain.value = filter.gain;
      node.Q.value = filter.q;
    }
  }

  function ensureGraph(filters) {
    if (!state.context) {
      state.context = new AudioContext();
      state.gainNode = state.context.createGain();
      state.analyser = state.context.createAnalyser();
      state.analyser.fftSize = 512;
      state.analyser.smoothingTimeConstant = 0.7;
    }

    if (filters.length && state.filterNodes.length !== filters.length) {
      state.filterNodes.forEach((node) => node.disconnect());
      state.filterNodes = buildFilterNodes(state.context, filters);

      let previous = null;
      for (const node of state.filterNodes) {
        if (previous) {
          previous.connect(node);
        }
        previous = node;
      }
      if (previous) {
        previous.connect(state.gainNode);
      }
      state.gainNode.connect(state.analyser);
      state.analyser.connect(state.context.destination);
    }

    return state.context;
  }

  // Sends a source either through the filter chain or straight to the speakers.
  function routeSource(source) {
    source.disconnect();
    if (state.enabled && state.filterNodes.length) {
      source.connect(state.filterNodes[0]);
    } else {
      source.connect(state.context.destination);
    }
  }

  function rerouteAll() {
    for (const entry of state.attached) {
      routeSource(entry.source);
    }
  }

  // --- media discovery ---------------------------------------------------

  function attachElement(element) {
    if (state.sources.has(element) || state.unattachable.has(element)) {
      return;
    }

    const context = ensureGraph(state.filters);

    let source;
    try {
      source = context.createMediaElementSource(element);
    } catch (error) {
      // Most often InvalidStateError: the page already built its own
      // MediaElementAudioSourceNode for this element and we cannot take it.
      state.unattachable.add(element);
      if (!state.notice) {
        notify('already-claimed');
      }
      return;
    }

    state.sources.set(element, source);
    state.attached.push({ element, source });
    routeSource(source);
  }

  function collectMedia(root, found) {
    if (!root || typeof root.querySelectorAll !== 'function') {
      return;
    }

    for (const element of root.querySelectorAll('audio, video')) {
      found.push(element);
    }

    // Media inside web components is invisible to a light-DOM query.
    for (const element of root.querySelectorAll('*')) {
      if (element.shadowRoot) {
        collectMedia(element.shadowRoot, found);
      }
    }
  }

  function scanForMedia() {
    const found = [];
    collectMedia(document, found);
    found.forEach(attachElement);
    return state.attached.length;
  }

  function onNodeAdded(node) {
    if (isMediaElement(node)) {
      attachElement(node);
      return;
    }
    if (node && typeof node.querySelectorAll === 'function') {
      node.querySelectorAll('audio, video').forEach(attachElement);
    }
  }

  function startObserving() {
    if (state.observer || !document.documentElement) {
      return;
    }
    state.observer = new MutationObserver((records) => {
      if (!state.enabled) {
        return;
      }
      for (const record of records) {
        record.addedNodes.forEach(onNodeAdded);
      }
    });
    state.observer.observe(document.documentElement, {
      childList: true,
      subtree: true
    });
  }

  function stopObserving() {
    if (state.observer) {
      state.observer.disconnect();
      state.observer = null;
    }
  }

  // Catches players that create their element outside the observed subtree.
  document.addEventListener(
    'play',
    (event) => {
      if (state.enabled && isMediaElement(event.target)) {
        attachElement(event.target);
      }
    },
    true
  );

  // --- cross-origin silence detection ------------------------------------

  // A MediaElementAudioSourceNode fed by cross-origin media without CORS
  // headers outputs digital silence. Detect that and fall back to untouched
  // playback rather than leaving the user with a dead tab.
  function isAudiblyPlaying() {
    return state.attached.some(
      ({ element }) =>
        !element.paused &&
        !element.ended &&
        element.readyState >= 2 &&
        !element.muted &&
        element.volume > 0
    );
  }

  function runSilenceProbe() {
    state.silenceTimer = null;

    if (!state.enabled || !state.analyser || state.gain <= 0) {
      return;
    }

    if (!isAudiblyPlaying()) {
      scheduleSilenceProbe();
      return;
    }

    const samples = new Float32Array(state.analyser.fftSize);
    state.analyser.getFloatTimeDomainData(samples);
    const silent = samples.every((value) => value === 0);

    if (!silent) {
      state.silentProbes = 0;
      return;
    }

    state.silentProbes += 1;
    if (state.silentProbes < SILENCE_PROBES_BEFORE_BYPASS) {
      scheduleSilenceProbe();
      return;
    }

    state.enabled = false;
    rerouteAll();
    notify('cross-origin-silent');
  }

  function scheduleSilenceProbe() {
    if (state.silenceTimer) {
      return;
    }
    state.silenceTimer = setTimeout(runSilenceProbe, SILENCE_PROBE_MS);
  }

  // --- commands ----------------------------------------------------------

  async function enable(filters, gain) {
    state.filters = Array.isArray(filters) ? filters : [];
    state.gain = Number.isFinite(gain) ? gain : 1;
    state.notice = null;
    state.silentProbes = 0;

    const context = ensureGraph(state.filters);
    applyFilterValues(state.filterNodes, state.filters);
    state.gainNode.gain.value = state.gain;

    state.enabled = true;
    startObserving();
    const mediaCount = scanForMedia();
    rerouteAll();

    if (context.state === 'suspended') {
      try {
        await context.resume();
      } catch (error) {
        // Autoplay policy can refuse until the user interacts; harmless here
        // because playback itself is what resumes the context.
      }
    }

    scheduleSilenceProbe();

    return {
      ok: true,
      // The observer stays armed, so media that appears later is still caught.
      reason: mediaCount === 0 ? state.notice || 'no-media' : state.notice,
      mediaCount,
      sampleRate: context.sampleRate
    };
  }

  function disable() {
    state.enabled = false;
    clearTimeout(state.silenceTimer);
    state.silenceTimer = null;
    state.silentProbes = 0;
    stopObserving();
    if (state.context) {
      rerouteAll();
    }
    return { ok: true };
  }

  function updateFilters(filters, gain) {
    state.filters = Array.isArray(filters) ? filters : state.filters;
    state.gain = Number.isFinite(gain) ? gain : state.gain;

    if (!state.context) {
      return { ok: true };
    }

    ensureGraph(state.filters);
    applyFilterValues(state.filterNodes, state.filters);
    state.gainNode.gain.value = state.gain;

    // A probe skipped because the gain was muted should resume once it is not.
    if (state.enabled) {
      state.silentProbes = 0;
      scheduleSilenceProbe();
    }

    return { ok: true };
  }

  function getFFT() {
    if (!state.enabled || !state.analyser) {
      return { fft: [] };
    }
    const values = new Float32Array(state.analyser.frequencyBinCount);
    state.analyser.getFloatFrequencyData(values);
    return { fft: Array.from(values) };
  }

  browser.runtime.onMessage.addListener((message) => {
    if (!message || message.target !== 'ears-content') {
      return false;
    }

    switch (message.command) {
      case 'probe':
        return Promise.resolve({
          ok: true,
          enabled: state.enabled,
          mediaCount: state.attached.length,
          sampleRate: state.context ? state.context.sampleRate : 0
        });
      case 'enable':
        return enable(message.filters, message.gain).catch((error) => ({
          ok: false,
          reason: 'audio-unavailable',
          mediaCount: 0,
          error: String(error && error.message)
        }));
      case 'disable':
        return Promise.resolve(disable());
      case 'updateFilters':
        return Promise.resolve(updateFilters(message.filters, message.gain));
      case 'getFFT':
        return Promise.resolve(getFFT());
      default:
        return false;
    }
  });
})();
