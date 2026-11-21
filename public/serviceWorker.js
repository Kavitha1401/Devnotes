chrome.action.onClicked.addListener(function (tab) {
  if (typeof tab.id !== 'number') return
  if (!tab.url || !/^https?:/.test(tab.url)) {
    chrome.action.setBadgeText({ tabId: tab.id, text: '!' })
    chrome.action.setBadgeBackgroundColor({ tabId: tab.id, color: '#8d6259' })
    chrome.action.setTitle({ tabId: tab.id, title: 'DevNotes is unavailable on this browser page' })
    setTimeout(function () {
      chrome.action.setBadgeText({ tabId: tab.id, text: '' })
      chrome.action.setTitle({ tabId: tab.id, title: 'Open DevNotes' })
    }, 2500)
    return
  }

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
  chrome.contextMenus.removeAll(function () {
    chrome.contextMenus.create({
      id: 'devnotes-save-selection',
      title: 'Save selection to DevNotes',
      contexts: ['selection'],
    })
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
  sendToActiveTab({ type: 'DEVNOTES_CAPTURE_SELECTION' })
})

chrome.commands.onCommand.addListener(function (command) {
  if (command === 'toggle-sidebar') sendToActiveTab({ type: 'DEVNOTES_TOGGLE' })
  if (command === 'focus-search') sendToActiveTab({ type: 'DEVNOTES_FOCUS_SEARCH' })
  if (command === 'quick-capture') sendToActiveTab({ type: 'DEVNOTES_CAPTURE_SELECTION' })
  if (command === 'new-note') sendToActiveTab({ type: 'DEVNOTES_NEW_NOTE' })
})
