const tabAudio = new Map();

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

async function startTabAudio(tabId, streamId, filters, gain) {
  if (tabAudio.has(tabId)) {
    return { sampleRate: tabAudio.get(tabId).context.sampleRate };
  }

  const stream = await navigator.mediaDevices.getUserMedia({
    audio: {
      mandatory: {
        chromeMediaSource: 'tab',
        chromeMediaSourceId: streamId
      }
    },
    video: false
  });

  const context = new AudioContext();
  const source = context.createMediaStreamSource(stream);
  const gainNode = context.createGain();
  gainNode.gain.value = gain;
  const analyser = context.createAnalyser();
  analyser.fftSize = 512;
  analyser.smoothingTimeConstant = 0.7;

  const filterNodes = buildFilterNodes(context, filters);

  let previous = source;
  for (const filterNode of filterNodes) {
    previous.connect(filterNode);
    previous = filterNode;
  }

  previous.connect(gainNode);
  gainNode.connect(analyser);
  analyser.connect(context.destination);

  tabAudio.set(tabId, {
    stream,
    context,
    source,
    filterNodes,
    gainNode,
    analyser
  });

  return { sampleRate: context.sampleRate };
}

async function stopTabAudio(tabId) {
  const session = tabAudio.get(tabId);
  if (!session) {
    return;
  }

  session.stream.getTracks().forEach((track) => track.stop());
  session.filterNodes.forEach((node) => node.disconnect());
  session.gainNode.disconnect();
  session.analyser.disconnect();
  session.source.disconnect();
  await session.context.close();
  tabAudio.delete(tabId);
}

function updateAllFilters(filters, gain) {
  for (const session of tabAudio.values()) {
    applyFilterValues(session.filterNodes, filters);
    session.gainNode.gain.value = gain;
  }
}


function getActiveTabSessions() {
  const sessions = [];
  for (const [tabId, session] of tabAudio.entries()) {
    sessions.push({ tabId, sampleRate: session.context.sampleRate });
  }
  return { sessions };
}

function getFFT(tabId) {
  const session = tabAudio.get(tabId);
  if (!session) {
    return { fft: [] };
  }

  const values = new Float32Array(session.analyser.frequencyBinCount);
  session.analyser.getFloatFrequencyData(values);
  return { fft: Array.from(values) };
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.target !== 'offscreen') {
    return false;
  }

  (async () => {
    switch (message.command) {
      case 'startTabAudio':
        sendResponse(await startTabAudio(message.tabId, message.streamId, message.filters, message.gain));
        return;
      case 'stopTabAudio':
        await stopTabAudio(message.tabId);
        sendResponse({ ok: true });
        return;
      case 'updateAllFilters':
        updateAllFilters(message.filters, message.gain);
        sendResponse({ ok: true });
        return;
      case 'getFFT':
        sendResponse(getFFT(message.tabId));
        return;
      case 'getActiveTabSessions':
        sendResponse(getActiveTabSessions());
        return;
      default:
        sendResponse({ ok: false });
    }
  })().catch((error) => {
    console.error('Ears offscreen error:', error);
    sendResponse({ ok: false, error: error.message });
  });

  return true;
});
