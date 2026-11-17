chrome.action.onClicked.addListener(function (tab) {
  if (!tab.id || !tab.url || tab.url.indexOf('http') !== 0) return

  chrome.tabs.sendMessage(tab.id, { type: 'DEVNOTES_TOGGLE' }, function () {
    if (!chrome.runtime.lastError) return

    chrome.scripting.executeScript({
      target: { tabId: tab.id },
      files: ['content.js'],
    }, function () {
      if (chrome.runtime.lastError) {
        console.warn('DevNotes could not be injected on this page:', chrome.runtime.lastError.message)
        return
      }
      chrome.tabs.sendMessage(tab.id, { type: 'DEVNOTES_TOGGLE' })
    })
  })
})
