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

chrome.runtime.onInstalled.addListener(function () {
  chrome.contextMenus.create({
    id: 'devnotes-save-selection',
    title: 'Save selection to DevNotes',
    contexts: ['selection'],
  })
})

function sendToActiveTab(message) {
  chrome.tabs.query({ active: true, lastFocusedWindow: true }, function (tabs) {
    var tab = tabs[0]
    if (!tab || !tab.id || !tab.url || tab.url.indexOf('http') !== 0) return
    chrome.tabs.sendMessage(tab.id, message, function () {
      if (!chrome.runtime.lastError) return
      chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ['content.js'] }, function () {
        if (chrome.runtime.lastError) return
        chrome.tabs.sendMessage(tab.id, message)
      })
    })
  })
}

chrome.contextMenus.onClicked.addListener(function (_info, tab) {
  if (!tab || !tab.id) return
  chrome.tabs.sendMessage(tab.id, { type: 'DEVNOTES_CAPTURE_SELECTION' })
})

chrome.commands.onCommand.addListener(function (command) {
  if (command === 'quick-capture') sendToActiveTab({ type: 'DEVNOTES_CAPTURE_SELECTION' })
  if (command === 'new-note') sendToActiveTab({ type: 'DEVNOTES_NEW_NOTE' })
})
