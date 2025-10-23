// Minimal background service worker (Manifest V3)
// Original analytics removed from worker because SW cannot inject script tags.
// Add event listeners needed by the extension here.

console.log('Ears background service worker started. Version:', chrome.runtime.getManifest().version);

chrome.runtime.onInstalled.addListener((details) => {
  console.log('Ears installed/updated', details);
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  // Simple ping handler - keep for testing
  if (message && message.type === 'PING') {
    sendResponse({ reply: 'PONG' });
  }
  // Return true if you plan to respond asynchronously
  return false;
});