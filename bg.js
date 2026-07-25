// Ears background event page (Firefox MV3).
//
// The audio graph itself lives in eq-content.js, injected into each tab the
// user equalizes. This script owns the shared filter/gain state, the preset
// store, and the message routing between the popup and those content scripts.

const CONTENT_SCRIPT = 'eq-content.js';

const DEFAULT_FILTERS = [
  { type: 'lowshelf', frequency: 60, q: 0.7, gain: 0 },
  { type: 'peaking', frequency: 170, q: 1, gain: 0 },
  { type: 'peaking', frequency: 310, q: 1, gain: 0 },
  { type: 'peaking', frequency: 600, q: 1, gain: 0 },
  { type: 'peaking', frequency: 1000, q: 1, gain: 0 },
  { type: 'peaking', frequency: 3000, q: 1, gain: 0 },
  { type: 'peaking', frequency: 6000, q: 1, gain: 0 },
  { type: 'peaking', frequency: 12000, q: 1, gain: 0 },
  { type: 'highshelf', frequency: 14000, q: 0.7, gain: 0 }
];

const VALID_FILTER_TYPES = new Set(['peaking', 'lowshelf', 'highshelf']);
const PRESETS_STORAGE_KEY = 'ears_presets_v1';
const SESSION_STATE_KEY = 'ears_session_v1';

const workspace = {
  eqFilters: structuredClone(DEFAULT_FILTERS),
  gain: 1,
  sampleRate: 44100,
  streams: [],
  frames: {},
  presets: {}
};

function toFiniteNumber(value, fallback) {
  const num = Number(value);
  return Number.isFinite(num) ? num : fallback;
}

function sanitizeFilter(inputFilter, fallbackFilter) {
  const fallback = fallbackFilter || DEFAULT_FILTERS[0];
  const type = VALID_FILTER_TYPES.has(inputFilter?.type) ? inputFilter.type : fallback.type;

  return {
    type,
    frequency: toFiniteNumber(inputFilter?.frequency, fallback.frequency),
    q: toFiniteNumber(inputFilter?.q, fallback.q),
    gain: toFiniteNumber(inputFilter?.gain, fallback.gain)
  };
}

function normalizePresetValue(rawPreset) {
  if (!rawPreset) {
    return null;
  }

  const rawFilters = Array.isArray(rawPreset.eqFilters)
    ? rawPreset.eqFilters
    : Array.isArray(rawPreset.filters)
      ? rawPreset.filters
      : Array.isArray(rawPreset)
        ? rawPreset
        : null;

  if (!rawFilters) {
    return null;
  }

  const eqFilters = DEFAULT_FILTERS.map((defaultFilter, index) => {
    const rawFilter = rawFilters[index] || {};
    return sanitizeFilter(rawFilter, defaultFilter);
  });

  return {
    eqFilters,
    gain: toFiniteNumber(rawPreset.gain, 1)
  };
}

function normalizeImportedPresets(rawPresets) {
  const source = rawPresets?.presets && typeof rawPresets.presets === 'object'
    ? rawPresets.presets
    : rawPresets;

  if (!source || typeof source !== 'object') {
    return {};
  }

  const normalized = {};
  for (const [name, rawPreset] of Object.entries(source)) {
    if (!name || typeof name !== 'string') {
      continue;
    }
    const parsed = normalizePresetValue(rawPreset);
    if (parsed) {
      normalized[name] = parsed;
    }
  }
  return normalized;
}

// --- persistence -------------------------------------------------------
// The event page is suspended when idle, which would otherwise wipe the live
// EQ settings and the list of equalized tabs. Presets go to local storage;
// the volatile runtime state goes to session storage.

let initPromise = null;

async function initWorkspace() {
  if (initPromise) {
    return initPromise;
  }

  initPromise = (async () => {
    const stored = await browser.storage.local.get(PRESETS_STORAGE_KEY);
    workspace.presets = normalizeImportedPresets(stored[PRESETS_STORAGE_KEY]);

    const session = await browser.storage.session.get(SESSION_STATE_KEY);
    const saved = session[SESSION_STATE_KEY];
    if (saved) {
      workspace.eqFilters = DEFAULT_FILTERS.map((defaultFilter, index) =>
        sanitizeFilter(saved.eqFilters?.[index], defaultFilter));
      workspace.gain = toFiniteNumber(saved.gain, 1);
      workspace.sampleRate = toFiniteNumber(saved.sampleRate, 44100);
      workspace.streams = Array.isArray(saved.streams) ? saved.streams : [];
      workspace.frames = saved.frames && typeof saved.frames === 'object' ? saved.frames : {};
    }
  })().catch((error) => {
    console.error('Unable to restore Ears state:', error);
    workspace.presets = {};
  });

  return initPromise;
}

async function persistPresets() {
  await browser.storage.local.set({
    [PRESETS_STORAGE_KEY]: workspace.presets
  });
}

function persistSession() {
  browser.storage.session
    .set({
      [SESSION_STATE_KEY]: {
        eqFilters: workspace.eqFilters,
        gain: workspace.gain,
        sampleRate: workspace.sampleRate,
        streams: workspace.streams,
        frames: workspace.frames
      }
    })
    .catch(() => {});
}

// --- messaging --------------------------------------------------------------

// Nothing is listening whenever the popup is closed, which is the normal case.
function broadcast(message) {
  browser.runtime.sendMessage(message).catch(() => {});
}

function cloneWorkspaceState() {
  return {
    eqFilters: structuredClone(workspace.eqFilters),
    gain: workspace.gain,
    streams: workspace.streams.map((stream) => ({
      id: stream.id,
      title: stream.title,
      favIconUrl: stream.favIconUrl || ''
    }))
  };
}

function pushWorkspaceUpdates() {
  broadcast({ type: 'sendWorkspaceStatus', ...cloneWorkspaceState() });
  broadcast({ type: 'sendPresets', presets: workspace.presets });
  broadcast({ type: 'sendSampleRate', Fs: workspace.sampleRate });
}

async function getActiveTabId(fallbackSenderTabId) {
  if (fallbackSenderTabId) {
    return fallbackSenderTabId;
  }

  const tabs = await browser.tabs.query({ active: true, currentWindow: true });
  return tabs[0]?.id ?? null;
}

function findStream(tabId) {
  return workspace.streams.find((stream) => stream.id === tabId);
}

async function injectContentScript(tabId) {
  const results = await browser.scripting.executeScript({
    target: { tabId, allFrames: true },
    files: [CONTENT_SCRIPT]
  });

  return results
    .map((result) => result.frameId)
    .filter((frameId) => Number.isInteger(frameId));
}

// A frame can disappear mid-flight, so per-frame failures are not fatal.
async function sendToFrames(tabId, frameIds, message) {
  const payload = { target: 'ears-content', ...message };
  const responses = [];

  for (const frameId of frameIds) {
    try {
      responses.push(await browser.tabs.sendMessage(tabId, payload, { frameId }));
    } catch (error) {
      responses.push(null);
    }
  }

  return responses;
}

function framesFor(tabId) {
  const frameIds = workspace.frames[tabId];
  return Array.isArray(frameIds) && frameIds.length ? frameIds : [0];
}

async function startEqForTab(tabId) {
  const tab = await browser.tabs.get(tabId);

  let frameIds;
  try {
    frameIds = await injectContentScript(tabId);
  } catch (error) {
    // about:, view-source:, addons.mozilla.org and friends refuse injection.
    return { ok: false, reason: 'restricted-page' };
  }

  if (!frameIds.length) {
    return { ok: false, reason: 'restricted-page' };
  }

  const responses = await sendToFrames(tabId, frameIds, {
    command: 'enable',
    filters: workspace.eqFilters,
    gain: workspace.gain
  });

  const live = responses.filter((response) => response?.ok);
  if (!live.length) {
    return { ok: false, reason: 'audio-unavailable' };
  }

  const withMedia = live.find((response) => response.mediaCount > 0);
  workspace.sampleRate = (withMedia || live[0]).sampleRate || workspace.sampleRate;
  workspace.frames[tabId] = frameIds;

  if (!findStream(tabId)) {
    workspace.streams.push({
      id: tab.id,
      title: tab.title || `Tab ${tab.id}`,
      favIconUrl: tab.favIconUrl || ''
    });
  }
  persistSession();

  return { ok: true, reason: withMedia ? withMedia.reason || null : 'no-media' };
}

async function stopEqForTab(tabId) {
  await sendToFrames(tabId, framesFor(tabId), { command: 'disable' });
  delete workspace.frames[tabId];
  workspace.streams = workspace.streams.filter((stream) => stream.id !== tabId);
  persistSession();
}

function applyPreset(name) {
  if (name === 'bassBoost') {
    workspace.eqFilters = workspace.eqFilters.map((filter) => {
      if (filter.type === 'lowshelf') {
        return { ...filter, gain: 10 };
      }
      if (filter.frequency < 250) {
        return { ...filter, gain: 5 };
      }
      if (filter.frequency > 6000) {
        return { ...filter, gain: -2 };
      }
      return { ...filter, gain: 0 };
    });
    return;
  }

  const preset = normalizePresetValue(workspace.presets[name]);
  if (!preset) {
    return;
  }

  workspace.eqFilters = preset.eqFilters.map((filter) => ({ ...filter }));
  workspace.gain = preset.gain;
}

async function syncProcessingNodes() {
  persistSession();

  await Promise.all(
    workspace.streams.map((stream) =>
      sendToFrames(stream.id, framesFor(stream.id), {
        command: 'updateFilters',
        filters: workspace.eqFilters,
        gain: workspace.gain
      })
    )
  );
}

async function handleGetFFT(senderTabId) {
  await initWorkspace();

  const tabId = await getActiveTabId(senderTabId);
  if (!tabId || !findStream(tabId)) {
    return { fft: [] };
  }

  for (const frameId of framesFor(tabId)) {
    const response = await sendToFrames(tabId, [frameId], { command: 'getFFT' });
    if (response[0]?.fft?.length) {
      return response[0];
    }
  }

  return { fft: [] };
}

// --- lifecycle ---------------------------------------------------------

browser.tabs.onRemoved.addListener(async (tabId) => {
  await initWorkspace();
  if (!findStream(tabId)) {
    return;
  }
  // The tab is gone, so there is nothing left to tell the content script.
  delete workspace.frames[tabId];
  workspace.streams = workspace.streams.filter((stream) => stream.id !== tabId);
  persistSession();
  pushWorkspaceUpdates();
});

// Navigating destroys the content script, so re-inject and re-apply.
browser.tabs.onUpdated.addListener(async (tabId, changeInfo) => {
  if (changeInfo.status !== 'complete') {
    return;
  }

  await initWorkspace();
  const stream = findStream(tabId);
  if (!stream) {
    return;
  }

  try {
    const frameIds = await injectContentScript(tabId);
    workspace.frames[tabId] = frameIds;
    await sendToFrames(tabId, frameIds, {
      command: 'enable',
      filters: workspace.eqFilters,
      gain: workspace.gain
    });

    const tab = await browser.tabs.get(tabId);
    stream.title = tab.title || stream.title;
    stream.favIconUrl = tab.favIconUrl || '';
  } catch (error) {
    // Without a granted host permission, activeTab does not survive a
    // navigation. Drop the tab rather than pretending it is still equalized.
    delete workspace.frames[tabId];
    workspace.streams = workspace.streams.filter((entry) => entry.id !== tabId);
    broadcast({ type: 'sendEqNotice', reason: 'reattach-failed' });
  }

  persistSession();
  pushWorkspaceUpdates();
});

browser.runtime.onInstalled.addListener(() => {
  console.log('Ears installed/updated', browser.runtime.getManifest().version);
});

void initWorkspace();

async function handleCommand(message, senderTabId) {
  await initWorkspace();

  switch (message?.type) {
    case 'onPopupOpen':
    case 'getFullRefresh':
      pushWorkspaceUpdates();
      return;

    case 'eqTab': {
      const tabId = await getActiveTabId(senderTabId);
      if (!tabId) {
        return;
      }

      if (message.on) {
        const result = await startEqForTab(tabId);
        // Opening the popup attaches automatically, so staying quiet about a
        // page that simply has no media yet keeps the notice meaningful.
        const quiet = message.auto && result.reason === 'no-media';
        if (result.reason && !quiet) {
          broadcast({ type: 'sendEqNotice', reason: result.reason });
        }
      } else {
        await stopEqForTab(tabId);
      }

      broadcast({
        type: 'sendCurrentTabStatus',
        streaming: Boolean(findStream(tabId))
      });
      pushWorkspaceUpdates();
      return;
    }

    case 'disconnectTab':
      if (message.tab?.id) {
        await stopEqForTab(message.tab.id);
        pushWorkspaceUpdates();
      }
      return;

    case 'modifyFilter':
      if (workspace.eqFilters[message.index]) {
        workspace.eqFilters[message.index] = {
          ...workspace.eqFilters[message.index],
          frequency: message.frequency,
          gain: message.gain,
          q: message.q
        };
        await syncProcessingNodes();
        pushWorkspaceUpdates();
      }
      return;

    case 'resetFilter':
      if (workspace.eqFilters[message.index]) {
        workspace.eqFilters[message.index] = {
          ...workspace.eqFilters[message.index],
          gain: 0
        };
        await syncProcessingNodes();
        pushWorkspaceUpdates();
      }
      return;

    case 'modifyGain':
    case 'gainUpdated':
      workspace.gain = toFiniteNumber(message.gain, workspace.gain);
      await syncProcessingNodes();
      pushWorkspaceUpdates();
      return;

    case 'filterUpdated':
      await syncProcessingNodes();
      pushWorkspaceUpdates();
      return;

    case 'resetFilters':
      workspace.eqFilters = workspace.eqFilters.map((filter) => ({ ...filter, gain: 0 }));
      await syncProcessingNodes();
      pushWorkspaceUpdates();
      return;

    case 'preset':
      applyPreset(message.preset);
      await syncProcessingNodes();
      pushWorkspaceUpdates();
      return;

    case 'savePreset':
      workspace.presets[message.preset] = {
        eqFilters: workspace.eqFilters.map((filter) => ({ ...filter })),
        gain: workspace.gain
      };
      await persistPresets();
      broadcast({ type: 'sendPresets', presets: workspace.presets });
      return;

    case 'deletePreset':
      delete workspace.presets[message.preset];
      await persistPresets();
      broadcast({ type: 'sendPresets', presets: workspace.presets });
      return;

    case 'exportPresets': {
      const payload = JSON.stringify(workspace.presets, null, 2);
      const url = `data:application/json;charset=utf-8,${encodeURIComponent(payload)}`;
      await browser.downloads.download({
        url,
        filename: 'ears-presets.json',
        saveAs: true
      });
      return;
    }

    case 'importPresets': {
      const imported = normalizeImportedPresets(message.presets);
      workspace.presets = { ...workspace.presets, ...imported };
      await persistPresets();
      broadcast({ type: 'sendPresets', presets: workspace.presets });
      return;
    }

    default:
  }
}

// Firefox resolves the sender's promise with whatever a listener returns, so
// return a promise only for the messages that actually expect a reply.
browser.runtime.onMessage.addListener((message, sender) => {
  const senderTabId = sender?.tab?.id;

  switch (message?.type) {
    case 'PING':
      return Promise.resolve({ reply: 'PONG' });

    case 'getFFT':
      return handleGetFFT(senderTabId).catch(() => ({ fft: [] }));

    case 'earsNotice':
      broadcast({ type: 'sendEqNotice', reason: message.reason });
      return false;

    default:
      handleCommand(message, senderTabId).catch((error) => {
        console.error('Ears background error:', error);
      });
      return false;
  }
});
