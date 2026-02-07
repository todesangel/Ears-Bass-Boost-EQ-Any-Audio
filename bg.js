const OFFSCREEN_PATH = 'offscreen.html';
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

const workspace = {
  eqFilters: structuredClone(DEFAULT_FILTERS),
  gain: 1,
  sampleRate: 44100,
  streams: [],
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
  if (!rawPresets || typeof rawPresets !== 'object') {
    return {};
  }

  const normalized = {};
  for (const [name, rawPreset] of Object.entries(rawPresets)) {
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

async function ensureOffscreenDocument() {
  const url = chrome.runtime.getURL(OFFSCREEN_PATH);
  const contexts = await chrome.runtime.getContexts({
    contextTypes: ['OFFSCREEN_DOCUMENT'],
    documentUrls: [url]
  });

  if (contexts.length > 0) {
    return;
  }

  await chrome.offscreen.createDocument({
    url: OFFSCREEN_PATH,
    reasons: ['AUDIO_PLAYBACK'],
    justification: 'Equalize captured tab audio and return FFT data for visualizer.'
  });
}

async function sendToOffscreen(message) {
  await ensureOffscreenDocument();
  return chrome.runtime.sendMessage({ target: 'offscreen', ...message });
}

async function getActiveTabId(fallbackSenderTabId) {
  if (fallbackSenderTabId) {
    return fallbackSenderTabId;
  }

  const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
  if (tabs[0]?.id) {
    return tabs[0].id;
  }
  return null;
}

function pushWorkspaceUpdates() {
  chrome.runtime.sendMessage({ type: 'sendWorkspaceStatus', ...cloneWorkspaceState() });
  chrome.runtime.sendMessage({ type: 'sendPresets', presets: workspace.presets });
  chrome.runtime.sendMessage({ type: 'sendSampleRate', Fs: workspace.sampleRate });
}

function findStream(tabId) {
  return workspace.streams.find((stream) => stream.id === tabId);
}

async function startEqForTab(tabId) {
  if (findStream(tabId)) {
    return;
  }

  const tab = await chrome.tabs.get(tabId);
  const streamId = await chrome.tabCapture.getMediaStreamId({ targetTabId: tabId });

  const response = await sendToOffscreen({
    command: 'startTabAudio',
    tabId,
    streamId,
    filters: workspace.eqFilters,
    gain: workspace.gain
  });

  workspace.sampleRate = response?.sampleRate || workspace.sampleRate;
  workspace.streams.push({
    id: tab.id,
    title: tab.title || `Tab ${tab.id}`,
    favIconUrl: tab.favIconUrl || ''
  });
}

async function stopEqForTab(tabId) {
  await sendToOffscreen({ command: 'stopTabAudio', tabId });
  workspace.streams = workspace.streams.filter((stream) => stream.id !== tabId);
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
  await sendToOffscreen({
    command: 'updateAllFilters',
    filters: workspace.eqFilters,
    gain: workspace.gain
  });
}

chrome.tabs.onRemoved.addListener(async (tabId) => {
  if (!findStream(tabId)) {
    return;
  }
  await stopEqForTab(tabId);
  pushWorkspaceUpdates();
});

chrome.runtime.onInstalled.addListener(() => {
  console.log('Ears installed/updated', chrome.runtime.getManifest().version);
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  const senderTabId = sender?.tab?.id;

  (async () => {
    switch (message?.type) {
      case 'PING':
        sendResponse({ reply: 'PONG' });
        return;
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
          await startEqForTab(tabId);
        } else {
          await stopEqForTab(tabId);
        }

        chrome.runtime.sendMessage({
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
        workspace.gain = message.gain;
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
        chrome.runtime.sendMessage({ type: 'sendPresets', presets: workspace.presets });
        return;
      case 'deletePreset':
        delete workspace.presets[message.preset];
        chrome.runtime.sendMessage({ type: 'sendPresets', presets: workspace.presets });
        return;
      case 'exportPresets': {
        const payload = JSON.stringify(workspace.presets, null, 2);
        const url = `data:application/json;charset=utf-8,${encodeURIComponent(payload)}`;
        await chrome.downloads.download({
          url,
          filename: 'ears-presets.json',
          saveAs: true
        });
        return;
      }
      case 'importPresets': {
        const imported = normalizeImportedPresets(message.presets);
        workspace.presets = { ...workspace.presets, ...imported };
        chrome.runtime.sendMessage({ type: 'sendPresets', presets: workspace.presets });
        return;
      }
      case 'getFFT': {
        const tabId = await getActiveTabId(senderTabId);
        if (!tabId || !findStream(tabId)) {
          sendResponse({ fft: [] });
          return;
        }

        const response = await sendToOffscreen({ command: 'getFFT', tabId });
        sendResponse(response || { fft: [] });
        return;
      }
      default:
        return;
    }
  })().catch((error) => {
    console.error('Ears background error:', error);
    if (message?.type === 'getFFT') {
      sendResponse({ fft: [] });
    }
  });

  return true;
});
