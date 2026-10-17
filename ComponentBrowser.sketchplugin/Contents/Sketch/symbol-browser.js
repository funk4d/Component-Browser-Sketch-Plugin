//
//  MochaJSDelegate.js
//  MochaJSDelegate
//
//  Created by Matt Curtis
//  Copyright (c) 2015. All rights reserved.
//

var MochaJSDelegate = function(selectorHandlerDict){
        var uniqueClassName = "MochaJSDelegate_DynamicClass_" + NSUUID.UUID().UUIDString();

        var delegateClassDesc = MOClassDescription.allocateDescriptionForClassWithName_superclass_(uniqueClassName, NSObject);


        delegateClassDesc.registerClass();

        //      Handler storage

        var handlers = {};

        //      Define interface

        this.setHandlerForSelector = function(selectorString, func){
                var handlerHasBeenSet = (selectorString in handlers);
                var selector = NSSelectorFromString(selectorString);

                handlers[selectorString] = func;

                if(!handlerHasBeenSet){
                        /*
                                For some reason, Mocha acts weird about arguments:
                                https://github.com/logancollins/Mocha/issues/28

                                We have to basically create a dynamic handler with a likewise dynamic number of predefined arguments.

                        */

                        var dynamicHandler = function(){
                                var functionToCall = handlers[selectorString];

                                if(!functionToCall) return;

                                return functionToCall.apply(delegateClassDesc, arguments);
                        };

                        var args = [], regex = /:/g;
                        while(match = regex.exec(selectorString)) args.push("arg"+args.length);

                        dynamicFunction = eval("(function("+args.join(",")+"){ return dynamicHandler.apply(this, arguments); })");


                        delegateClassDesc.addInstanceMethodWithSelector_function_(selector, dynamicFunction);

                }
        };

        this.removeHandlerForSelector = function(selectorString){
                delete handlers[selectorString];
        };

        this.getHandlerForSelector = function(selectorString){
                return handlers[selectorString];
        };

        this.getAllHandlers = function(){
                return handlers;
        };

        this.getClass = function(){
                return NSClassFromString(uniqueClassName);
        };

        this.getClassInstance = function(){
                return NSClassFromString(uniqueClassName).new();
        };

        //      Conveience

        if(typeof selectorHandlerDict == "object"){
                for(var selectorString in selectorHandlerDict){
                        this.setHandlerForSelector(selectorString, selectorHandlerDict[selectorString]);
                }
        }
};

const sketch = require('sketch');
const UI = require('sketch/ui');
const Settings = require('sketch/settings');
const PREVIEW_MEMORY_CACHE_LIMIT = 4096;
// v2: bumped because v1 entries were built by a scan path that mis-classified
// local symbols whose names matched a library entry (e.g. local "Cursors/default"
// when Object Kit also has one) — they got tagged as library imports and
// disappeared from the picker. Bumping forces a one-time fresh scan with the
// isForeign-aware classifier.
const SYMBOLS_CACHE_KEY = "com.funkyplugins.componentbrowser.symbolsCache.v2";
// v2 forces one clean scan after switching to Sketch 2026.2+'s document-aware
// library enumeration. v1 could permanently preserve empty lists from the
// old global-only API.
const LIBRARIES_CACHE_KEY = "com.funkyplugins.componentbrowser.librariesCache.v2";
const BROWSER_PREFERENCES_KEY = "com.funkyplugins.componentbrowser.stable.browserPreferences.v1";
const HOTKEY_DELEGATE_REVISION_KEY = "com.funkyplugins.componentbrowser.stable.hotkeyDelegateRevision";
const HOTKEY_DELEGATE_REVISION = "preview-cache-2";
const CUSTOM_HOTKEY_KEY = "com.funkyplugins.componentbrowser.stable.customHotkey.v1";
const LEGACY_CUSTOM_HOTKEY_KEY = "com.funkyplugins.componentbrowser.customHotkey.v1";
const UI_STATE_CACHE_KEY = "com.funkyplugins.componentbrowser.uiStateCache.v1";
const UPDATE_NOTICE_DISMISSED_VERSION_KEY = "com.funkyplugins.componentbrowser.updateNoticeDismissedVersion";
const UPDATE_NOTICE_LAST_VERSION_KEY = "com.funkyplugins.componentbrowser.updateNoticeLastVersion";
const UPDATE_NOTICE_PENDING_VERSION_KEY = "com.funkyplugins.componentbrowser.updateNoticePendingVersion";
const UPDATE_NOTICE_VERSION = "2.0";
const PREVIEW_DISK_INDEX_KEY = "com.funkyplugins.componentbrowser.previewDiskIndex.v1";
const PREVIEW_DISK_DIR_NAME = "previews-v1";
const PREVIEW_RENDER_SIZE = 128;
const PREVIEW_CACHE_QUALITY_TAG = "128px-v1";
const PREVIEW_QUEUE_DELAY_MS = 90;
const SYMBOL_SCAN_BATCH_SIZE = 600;
const SYMBOL_SCAN_LIBRARY_BATCH_SIZE = 4;
const RESPONSIVE_SYMBOL_SCAN_BATCH_SIZE = 320;
const RESPONSIVE_SYMBOL_SCAN_LIBRARY_BATCH_SIZE = 1;
const RESPONSIVE_SCAN_START_DELAY_MS = 16;
const INITIAL_BROWSER_WORK_DELAY_MS = 520;
const DOCUMENT_WATCH_INTERVAL_MS = 450;
const DEBUG_VERBOSE_SYMBOL_SCAN_LOGS = false;
const DEBUG_VERBOSE_PREVIEW_LOGS = false;
const WINDOW_IDENTIFIER = "com.funkyplugins.componentbrowser.stable.liquid.window";
const WEBVIEW_IDENTIFIER = "com.funkyplugins.componentbrowser.stable.liquid.webView";
const DELEGATE_IDENTIFIER = "com.funkyplugins.componentbrowser.stable.liquid.delegate";
const LAST_DOC_ID_KEY = "com.funkyplugins.componentbrowser.stable.liquid.lastDocId";
const WINDOW_VISIBLE_KEY = "com.funkyplugins.componentbrowser.stable.liquid.visible";
const DOC_LOCAL_COUNT_KEY = "com.funkyplugins.componentbrowser.stable.liquid.localSymbolCount";
const DOC_LIBRARY_COUNT_KEY = "com.funkyplugins.componentbrowser.stable.liquid.enabledLibraryCount";
const DOC_LIBRARY_SIGNATURE_KEY = "com.funkyplugins.componentbrowser.stable.liquid.enabledLibrarySignature";
const HOTKEY_AGENT_INSTANCE_KEY = "com.funkyplugins.componentbrowser.stable.hotkeyAgent";
const HOTKEY_AGENT_DELEGATE_KEY = "com.funkyplugins.componentbrowser.stable.hotkeyDelegate";

const symbolLookupCache = {
  docId: null,
  localById: {},
  libraryRefById: {},
  // symbolId → owning library's id (String). MSShareableObjectReference doesn't
  // expose a working libraryID getter on the JS wrapper, so we record it
  // ourselves at scan time. Without this the disk-cache versionTag for library
  // symbols comes out empty, and writeDiskPreview silently skips the save —
  // that's why on-demand previews stopped accumulating on disk.
  libraryIdById: {},
  libraryRefsLoadedById: {}
};
const previewVersionTagBySymbol = Object.create(null);
const localPreviewVersionMemo = new Map();
const pendingForegroundPreviewIDs = new Set();
let previewQueueBuildToken = 0;

// Keep the live preview cache bounded. Rendering is delegated to PreviewAgent.
const previewMemoryCache = new Map();

let runtimeBrowserState = null;

// Native hotkey agent state. Holding refs to the agent instance and the Mocha
// delegate keeps them alive across COScript GC.
let hotkeyAgent = null;
let hotkeyDelegate = null;
let previewAgent = null;
let previewAgentResultsTimer = null;
let startupPreviewPrewarmTimer = null;
let startupPreviewPrewarmToken = 0;
let componentCountAgentTimer = null;
const COMPONENT_COUNT_AGENT_KEY = 'com.funkyplugins.componentbrowser.stable.countAgent';
const COMPONENT_COUNT_DIRTY_KEY = 'com.funkyplugins.componentbrowser.stable.countDirty';
const STARTUP_PREVIEW_PREWARM_MAX_RETRIES = 8;
const STARTUP_PREVIEW_PREWARM_BATCH_SIZE = 128;
let hotkeyContext = null; // last context (for scriptURL)

// When set to 'settings', the next plugin open enters settings mode directly
// (the user invoked the Settings menu command). Reset to null after consumption.
let nextLaunchMode = null;

// Carbon modifier constants (HIToolbox).
const CARBON_CMD_KEY    = 1 << 8;   // 256
const CARBON_SHIFT_KEY  = 1 << 9;   // 512
const CARBON_OPTION_KEY = 1 << 11;  // 2048
const CARBON_CONTROL_KEY = 1 << 12; // 4096

// Default launch shortcut: Cmd+; (key code 41).
const DEFAULT_HOTKEY = { keyCode: 41, modifiers: CARBON_CMD_KEY };

function getStoredHotkey() {
  try {
    let raw = Settings.settingForKey(CUSTOM_HOTKEY_KEY);
    if (!raw) {
      // Preserve shortcuts saved before Stable received its own preference key.
      raw = Settings.settingForKey(LEGACY_CUSTOM_HOTKEY_KEY);
      if (raw) Settings.setSettingForKey(CUSTOM_HOTKEY_KEY, raw);
    }
    if (raw && typeof raw === 'object' && Number.isFinite(Number(raw.keyCode)) && Number.isFinite(Number(raw.modifiers))) {
      return { keyCode: Number(raw.keyCode), modifiers: Number(raw.modifiers) };
    }
  } catch (e) {}
  return DEFAULT_HOTKEY;
}

function storeHotkey(hk) {
  try {
    Settings.setSettingForKey(CUSTOM_HOTKEY_KEY, { keyCode: Number(hk.keyCode), modifiers: Number(hk.modifiers) });
  } catch (e) {
    log("[HotkeyAgent] storeHotkey error: " + e);
  }
}

function isNewerPluginVersion(current, previous) {
  const left = String(current).split('.').map(Number);
  const right = String(previous).split('.').map(Number);
  for (let i = 0; i < Math.max(left.length, right.length); i++) {
    const difference = (left[i] || 0) - (right[i] || 0);
    if (difference) return difference > 0;
  }
  return false;
}

function prepareUpdateNotice() {
  const previous = String(Settings.settingForKey(UPDATE_NOTICE_LAST_VERSION_KEY) || '');
  if (previous === UPDATE_NOTICE_VERSION) return;
  const dismissed = String(Settings.settingForKey(UPDATE_NOTICE_DISMISSED_VERSION_KEY) || '');
  // Versions before 2.0 tracked dismissal but not installation. Existing
  // preferences/cache provide the one-time migration when no dismissal exists.
  const legacyInstall = !previous && (dismissed
    || Settings.settingForKey(BROWSER_PREFERENCES_KEY)
    || Settings.settingForKey(CUSTOM_HOTKEY_KEY)
    || Settings.settingForKey(LEGACY_CUSTOM_HOTKEY_KEY)
    || Settings.settingForKey(SYMBOLS_CACHE_KEY));
  const upgraded = previous ? isNewerPluginVersion(UPDATE_NOTICE_VERSION, previous) : !!legacyInstall;
  Settings.setSettingForKey(UPDATE_NOTICE_PENDING_VERSION_KEY,
    upgraded && dismissed !== UPDATE_NOTICE_VERSION ? UPDATE_NOTICE_VERSION : null);
  Settings.setSettingForKey(UPDATE_NOTICE_LAST_VERSION_KEY, UPDATE_NOTICE_VERSION);
}

function shouldShowUpdateNotice() {
  try {
    prepareUpdateNotice();
    return String(Settings.settingForKey(UPDATE_NOTICE_PENDING_VERSION_KEY) || '') === UPDATE_NOTICE_VERSION
      && String(Settings.settingForKey(UPDATE_NOTICE_DISMISSED_VERSION_KEY) || '') !== UPDATE_NOTICE_VERSION;
  } catch (e) {
    log('[UpdateNotice] version check failed: ' + e);
    return false;
  }
}

function dismissUpdateNotice(version) {
  if (String(version || '') !== UPDATE_NOTICE_VERSION) return;
  try {
    Settings.setSettingForKey(UPDATE_NOTICE_DISMISSED_VERSION_KEY, UPDATE_NOTICE_VERSION);
    Settings.setSettingForKey(UPDATE_NOTICE_PENDING_VERSION_KEY, null);
  } catch (e) {
    log("[UpdateNotice] dismiss failed: " + e);
  }
}

function reRegisterHotkey(hk) {
  hotkeyAgent = hotkeyAgent || getThreadDictionaryObject(HOTKEY_AGENT_INSTANCE_KEY);
  hotkeyDelegate = hotkeyDelegate || getThreadDictionaryObject(HOTKEY_AGENT_DELEGATE_KEY);
  if (!hotkeyAgent) return false;
  try { hotkeyAgent.unregister(); } catch (e) {}
  const ok = hotkeyAgent.registerHotkeyWithKeyCode_modifiers_(hk.keyCode, hk.modifiers);
  log("[HotkeyAgent] re-register keyCode=" + hk.keyCode + " modifiers=" + hk.modifiers + " → " + (ok ? "YES" : "NO"));
  return !!ok;
}

function showHotkeyRecordingState(jsCall) {
  const webView = getThreadDictionaryObject(WEBVIEW_IDENTIFIER);
  if (webView) evaluateWebScriptSafely(webView, jsCall);
}

function handleRecordedHotkey(keyCode, modifiers) {
  const requested = { keyCode: Number(keyCode), modifiers: Number(modifiers) };
  if (!Number.isFinite(requested.keyCode) || !Number.isFinite(requested.modifiers)) return;

  if (requested.modifiers === 0) {
    showHotkeyRecordingState("window.hotkeyRecordingNeedsModifier && window.hotkeyRecordingNeedsModifier();");
    return;
  }

  const previous = getStoredHotkey();
  if (hotkeyAgent && hotkeyAgent.endRecording) hotkeyAgent.endRecording();
  const registered = reRegisterHotkey(requested);
  if (registered) {
    storeHotkey(requested);
    showHotkeyRecordingState("window.finishHotkeyRecording && window.finishHotkeyRecording(" + requested.keyCode + "," + requested.modifiers + ",true);");
    log("[HotkeyAgent] shortcut saved keyCode=" + requested.keyCode + " modifiers=" + requested.modifiers);
  } else {
    reRegisterHotkey(previous);
    showHotkeyRecordingState("window.finishHotkeyRecording && window.finishHotkeyRecording(" + previous.keyCode + "," + previous.modifiers + ",false);");
    log("[HotkeyAgent] shortcut rejected; registration failed keyCode=" + requested.keyCode + " modifiers=" + requested.modifiers);
  }
}

function loadHotkeyAgentFramework(scriptFolderURL) {
  try {
    const fwURL = scriptFolderURL
      .URLByDeletingLastPathComponent()  // → Contents/
      .URLByAppendingPathComponent("Resources")
      .URLByAppendingPathComponent("HotkeyAgent.framework");
    const fwPath = fwURL.path();
    const bundle = NSBundle.bundleWithPath_(fwPath);
    if (!bundle) {
      log("[HotkeyAgent] bundle not found at " + fwPath);
      return null;
    }
    if (!bundle.load()) {
      log("[HotkeyAgent] bundle.load() returned NO (path=" + fwPath + ")");
      return null;
    }
    const klass = NSClassFromString("CBStableHotkeyAgent");
    if (!klass) {
      log("[HotkeyAgent] CBStableHotkeyAgent class missing after load");
      return null;
    }
    const agent = klass.sharedAgent();
    log("[HotkeyAgent] framework loaded, agent=" + agent);
    return agent;
  } catch (e) {
    log("[HotkeyAgent] load exception: " + e);
    return null;
  }
}

function setupHotkeyAgent(context) {
  if (!hotkeyAgent) {
    hotkeyAgent = getThreadDictionaryObject(HOTKEY_AGENT_INSTANCE_KEY);
    hotkeyDelegate = getThreadDictionaryObject(HOTKEY_AGENT_DELEGATE_KEY);
  }
  if (hotkeyAgent && String(getThreadDictionaryObject(HOTKEY_DELEGATE_REVISION_KEY) || '') === HOTKEY_DELEGATE_REVISION) {
    if (context) hotkeyContext = context;
    return true;
  }
  if (!context || !context.scriptURL) return false;
  const scriptFolderURL = context.scriptURL.URLByDeletingLastPathComponent();

  const agent = hotkeyAgent || loadHotkeyAgentFramework(scriptFolderURL);
  if (!agent) return false;

  const delegate = new MochaJSDelegate({
    "hotkeyDidTrigger": function() {
      log("[HotkeyAgent] hotkeyDidTrigger");
      try {
        // Defer until after the local NSEvent monitor has returned.
        setTimeout(function() {
          try {
            // Reuse the same context that was passed to onStartup/onRun. onRun
            // is the plugin's real entry point — it picks the active document,
            // creates the window, and renders symbols.
            onRun(hotkeyContext);
          } catch (e) {
            log("[HotkeyAgent] open failed: " + e);
          }
        }, 0);
      } catch (e) {
        log("[HotkeyAgent] trigger handler error: " + e);
      }
    },
    "hotkeyDidRecordKeyCode:modifiers:": function(keyCode, modifiers) {
      handleRecordedHotkey(keyCode, modifiers);
    }
  });

  agent.setDelegate_(delegate.getClassInstance());
  const hk = getStoredHotkey();
  const ok = agent.registerHotkeyWithKeyCode_modifiers_(hk.keyCode, hk.modifiers);
  log("[HotkeyAgent] register keyCode=" + hk.keyCode + " modifiers=" + hk.modifiers + " → " + (ok ? "YES" : "NO"));

  hotkeyAgent = agent;
  hotkeyDelegate = delegate;
  setThreadDictionaryObject(HOTKEY_AGENT_INSTANCE_KEY, agent);
  setThreadDictionaryObject(HOTKEY_AGENT_DELEGATE_KEY, delegate);
  setThreadDictionaryObject(HOTKEY_DELEGATE_REVISION_KEY, HOTKEY_DELEGATE_REVISION);

  // Keep COScript alive so the AppKit event monitor can call into JS later.
  try {
    if (COScript.currentCOScript()) COScript.currentCOScript().setShouldKeepAround(true);
  } catch (e) {}

  startComponentCountAgent();

  return ok;
}

function teardownHotkeyAgent() {
  hotkeyAgent = hotkeyAgent || getThreadDictionaryObject(HOTKEY_AGENT_INSTANCE_KEY);
  hotkeyDelegate = hotkeyDelegate || getThreadDictionaryObject(HOTKEY_AGENT_DELEGATE_KEY);
  try {
    if (hotkeyAgent) {
      if (hotkeyAgent.endRecording) hotkeyAgent.endRecording();
      hotkeyAgent.unregister();
      hotkeyAgent.setDelegate_(null);
    }
  } catch (e) {
    log("[HotkeyAgent] teardown error: " + e);
  }
  try {
    const threadDictionary = NSThread.mainThread().threadDictionary();
    if (threadDictionary.removeObjectForKey) {
      threadDictionary.removeObjectForKey(HOTKEY_AGENT_INSTANCE_KEY);
      threadDictionary.removeObjectForKey(HOTKEY_AGENT_DELEGATE_KEY);
    }
  } catch (e) {}
  hotkeyAgent = null;
  hotkeyDelegate = null;
}

function loadPreviewAgentFramework(scriptFolderURL) {
  try {
    const fwURL = scriptFolderURL
      .URLByDeletingLastPathComponent()
      .URLByAppendingPathComponent("Resources")
      .URLByAppendingPathComponent("PreviewAgent.framework");
    const fwPath = fwURL.path();
    const bundle = NSBundle.bundleWithPath_(fwPath);
    if (!bundle) {
      log("[PreviewAgent] framework bundle not found at " + fwPath);
      return null;
    }
    if (!bundle.load()) {
      log("[PreviewAgent] failed to load framework at " + fwPath);
      return null;
    }
    const klass = NSClassFromString("CBStablePreviewAgent");
    if (!klass) {
      log("[PreviewAgent] CBStablePreviewAgent class missing after load");
      return null;
    }
    const agent = klass.agent();
    return agent;
  } catch (e) {
    log("[PreviewAgent] framework load exception: " + e);
    return null;
  }
}

function previewAgentDidRenderSymbol(symbolId, pngPath, versionTag) {
  const id = String(symbolId || '');
  const tag = String(versionTag || '');
  if (!id || !tag) return;
  if (previewVersionTagBySymbol[id] && previewVersionTagBySymbol[id] !== tag) return;
  pendingForegroundPreviewIDs.delete(id);
  try {
    const expectedPath = getPreviewDiskFilePath(id);
    if (!expectedPath || String(pngPath || '') !== expectedPath) {
      log("[PreviewAgent] rejected unexpected cache path for " + id);
      return;
    }
    const fm = NSFileManager.defaultManager();
    if (!fm.fileExistsAtPath(expectedPath)) return;
    // The worker has already written the PNG and its version sidecar atomically.
    // Rewriting the entire legacy Settings index for each completed thumbnail
    // serialized thousands of entries on Sketch's UI thread.

    const state = runtimeBrowserState;
    if (state && state.isVisible && !state.closed && state.webView) {
      const preview = readDiskPreview(id, tag);
      if (preview) {
        setCachedPreview(id, preview);
        sendPreviewToUI(state.webView, id, preview);
      }
    }
  } catch (e) {
    log("[PreviewAgent] cache registration failed for " + id + ": " + e);
  }
}

function setupPreviewAgent(context) {
  if (previewAgent) {
    log("[PreviewAgent] setup skipped; already running");
    return true;
  }
  if (!context || !context.scriptURL) {
    log("[PreviewAgent] setup skipped; Sketch context has no scriptURL");
    return false;
  }
  const scriptFolderURL = context.scriptURL.URLByDeletingLastPathComponent();
  const agent = loadPreviewAgentFramework(scriptFolderURL);
  if (!agent) return false;

  try {
    const cachePath = getPreviewDiskCacheRoot();
    const appPath = String(NSBundle.mainBundle().bundlePath());
    const sketchtoolPath = appPath + "/Contents/MacOS/sketchtool";
    if (!cachePath || !NSFileManager.defaultManager().fileExistsAtPath(sketchtoolPath)) {
      log("[PreviewAgent] unavailable cachePath=" + cachePath + " sketchtool=" + sketchtoolPath);
      return false;
    }

    agent.setCacheDirectory_(cachePath);
    agent.setSketchtoolPath_(sketchtoolPath);
    agent.setRenderSize_(PREVIEW_RENDER_SIZE);
    agent.setIntervalFastMs_slowMs_(60000, 60);
    // Pull plain JSON from the native worker. Calling a Mocha dynamic delegate
    // asynchronously from PreviewAgent caused recursive native-object unboxing.
    agent.setDelegate_(null);
    agent.start();
    previewAgent = agent;
    let completedSequence = 0;
    const collectCompletedPreviews = function() {
      try {
        const completed = JSON.parse(String(agent.completedPreviewsJSONAfterSequence_(completedSequence)));
        completed.forEach(function(item) {
          completedSequence = Math.max(completedSequence, Number(item.sequence) || 0);
          previewAgentDidRenderSymbol(item.symbolId, item.path, item.versionTag);
        });
      } catch (e) { log("[PreviewAgent] result collection failed: " + e); }
      previewAgentResultsTimer = setTimeout(collectCompletedPreviews, isBrowserVisible() ? 120 : 2000);
    };
    previewAgentResultsTimer = setTimeout(collectCompletedPreviews, 120);
    log("[PreviewAgent] started with sketchtool=" + sketchtoolPath);
    return true;
  } catch (e) {
    log("[PreviewAgent] setup failed: " + e);
    return false;
  }
}

function setPreviewAgentBusy(isBusy) {
  if (!isBusy) pendingForegroundPreviewIDs.clear();
  if (!previewAgent) return;
  try { previewAgent.setForegroundActive_(!!isBusy); }
  catch (e) { log("[PreviewAgent] foreground update failed: " + e); }
}

function teardownPreviewAgent() {
  if (previewAgentResultsTimer) clearTimeout(previewAgentResultsTimer);
  previewAgentResultsTimer = null;
  try {
    if (previewAgent) {
      previewAgent.stop();
      previewAgent.setDelegate_(null);
    }
  } catch (e) {
    log("[PreviewAgent] teardown error: " + e);
  }
  previewAgent = null;
}

function onStartup(context) {
  log("=== Component Browser onStartup ===");
  shouldShowUpdateNotice();
  hotkeyContext = context;
  setupHotkeyAgent(context);
  setupPreviewAgent(context);
  scheduleStartupPreviewPrewarm(0);
}

function onShutdown(context) {
  log("=== Component Browser onShutdown ===");
  cancelStartupPreviewPrewarm();
  if (componentCountAgentTimer) clearTimeout(componentCountAgentTimer);
  componentCountAgentTimer = null;
  NSThread.mainThread().threadDictionary().removeObjectForKey_(COMPONENT_COUNT_AGENT_KEY);
  teardownPreviewAgent();
  teardownHotkeyAgent();
}

function cancelStartupPreviewPrewarm() {
  startupPreviewPrewarmToken++;
  if (startupPreviewPrewarmTimer) {
    clearTimeout(startupPreviewPrewarmTimer);
    startupPreviewPrewarmTimer = null;
  }
}

function scheduleStartupPreviewPrewarm(retry) {
  if (!previewAgent || startupPreviewPrewarmTimer) return;
  const retryCount = Math.max(0, Number(retry) || 0);
  startupPreviewPrewarmTimer = setTimeout(function() {
    startupPreviewPrewarmTimer = null;
    if (!previewAgent || isBrowserVisible()) return;

    const document = getActiveDocument();
    if (!document) {
      if (retryCount < STARTUP_PREVIEW_PREWARM_MAX_RETRIES) {
        scheduleStartupPreviewPrewarm(retryCount + 1);
      } else {
        log("[PreviewAgent] startup prewarm skipped; no document opened");
      }
      return;
    }

    const documentId = getDocumentIdentifier(document);
    if (!documentId) return;
    const token = ++startupPreviewPrewarmToken;
    const shouldContinue = function() {
      if (token !== startupPreviewPrewarmToken || isBrowserVisible()) return false;
      const activeDocument = getActiveDocument();
      return !!activeDocument && getDocumentIdentifier(activeDocument) === documentId;
    };

    log("[PreviewAgent] startup prewarm scan started");
    getSymbolsJsonAsync(document, function(symbolsJson, symbolCount) {
      if (!shouldContinue()) return;
      log("[PreviewAgent] startup prewarm scan found " + symbolCount + " components");
      storeComponentCount(document, symbolCount, getDocumentContentSignature(document));
      setTimeout(function() {
        if (shouldContinue()) queuePreviewAgentFromSymbolsJson(symbolsJson, document);
      }, 0);
    }, shouldContinue, {
      symbolBatchSize: STARTUP_PREVIEW_PREWARM_BATCH_SIZE,
      libraryBatchSize: 1
    });
  }, retryCount === 0 ? 8000 : 15000);
}

// The resident hotkey context warms a tiny, separate count cache while the
// browser is closed. No raster, DOM wrappers, previews or live library loads.
// Document events only mark this work dirty; rapid edits are debounced.
function getComponentCountCachePath() {
  const root = getPreviewDiskCacheRoot();
  return root ? root + '/component-counts-stable-v1.json' : null;
}

function readComponentCounts() {
  try {
    const path = getComponentCountCachePath();
    const json = path && NSString.stringWithContentsOfFile_encoding_error_(path, NSUTF8StringEncoding, null);
    return json ? JSON.parse(String(json)) : {};
  } catch (e) { return {}; }
}

function storeComponentCount(document, count, signature) {
  const id = getDocumentIdentifier(document);
  if (!id || !Number.isFinite(count) || count < 0) return;
  try {
    const entries = readComponentCounts();
    entries[id] = {
      count: count,
      localCount: signature.localSymbolCount,
      librarySignature: signature.enabledLibrarySignature,
      fingerprint: previewContentHash(getLocalSymbolsFingerprint(document)),
      updatedAt: Date.now()
    };
    // Small and bounded even when many different documents are opened.
    Object.keys(entries).sort(function(a, b) {
      return Number(entries[b].updatedAt) - Number(entries[a].updatedAt);
    }).slice(64).forEach(function(key) { delete entries[key]; });
    const path = getComponentCountCachePath();
    if (path) NSString.stringWithString_(JSON.stringify(entries))
      .writeToFile_atomically_encoding_error_(path, true, NSUTF8StringEncoding, null);
  } catch (e) { log('[ComponentCount] save failed: ' + e); }
}

function getReadyComponentCount(document) {
  const entry = readComponentCounts()[getDocumentIdentifier(document)];
  // Native NSArray.count is constant time. Reject a known changed document
  // without scanning components or querying libraries before first paint.
  if (!entry || !Number.isFinite(entry.count)
    || entry.localCount !== getDocumentSymbolCount(document)) return null;
  return entry.count;
}

function startComponentCountAgent() {
  if (componentCountAgentTimer || getThreadDictionaryObject(COMPONENT_COUNT_AGENT_KEY)) return;
  const owner = String(NSUUID.UUID().UUIDString());
  setThreadDictionaryObject(COMPONENT_COUNT_AGENT_KEY, owner);
  let lastDocumentId = null, lastDirty = '', lastChecked = 0, scanToken = 0;
  let pendingMetadataChange = false;
  const verifiedEmptyLibraries = new Set();

  function tick() {
    if (String(getThreadDictionaryObject(COMPONENT_COUNT_AGENT_KEY) || '') !== owner) return;
    componentCountAgentTimer = setTimeout(tick, 500);
    if (isBrowserVisible()) return;
    const document = getActiveDocument();
    const id = getDocumentIdentifier(document);
    if (!document || !id) return;
    const dirty = String(getThreadDictionaryObject(COMPONENT_COUNT_DIRTY_KEY) || '');
    if (dirty && Date.now() - Number(dirty) < 600) return;
    if (id === lastDocumentId && dirty === lastDirty && Date.now() - lastChecked < 15000) return;
    lastDocumentId = id;
    lastDirty = dirty;
    lastChecked = Date.now();
    const token = ++scanToken;
    const shouldContinue = function() {
      const active = getActiveDocument();
      return token === scanToken && !isBrowserVisible()
        && String(getThreadDictionaryObject(COMPONENT_COUNT_DIRTY_KEY) || '') === dirty
        && active && getDocumentIdentifier(active) === id;
    };
    const signature = getDocumentContentSignature(document);
    const fingerprint = previewContentHash(getLocalSymbolsFingerprint(document));
    const entry = readComponentCounts()[id];
    const libraries = getEnabledLibraries(document);
    const refs = [];
    let metadataChanged = pendingMetadataChange;
    for (let i = 0; i < libraries.length; i++) {
      const library = libraries[i];
      let cached = getCachedLibrarySymbols(library);
      const verificationKey = getLibraryCacheKey(library) + '|' + getLibraryVersionTag(library);
      // Older cold-start scans could persist [] before a library was ready.
      // Verify empty/missing metadata from its archive on the native worker.
      if (!cached || (!cached.symbols.length && !verifiedEmptyLibraries.has(verificationKey))) {
        const path = getLibraryFilePathForPreviewAgent(library);
        if (!previewAgent || !path || typeof previewAgent.componentMetadataJSONForLibraryPath_version_ !== 'function') return;
        const json = previewAgent.componentMetadataJSONForLibraryPath_version_(path, getLibraryVersionTag(library));
        if (!json) { lastChecked = Date.now() - 14500; return; }
        const rows = JSON.parse(String(json));
        verifiedEmptyLibraries.add(verificationKey);
        metadataChanged = metadataChanged || !cached || cached.symbols.length !== rows.length;
        pendingMetadataChange = metadataChanged;
        setCachedLibrarySymbols(library, rows);
        cached = { symbols: rows };
      }
      refs.push(cached.symbols);
    }
    if (metadataChanged) {
      const listCache = getOrCreateSymbolsCache();
      delete listCache[id];
      Settings.setSettingForKey(SYMBOLS_CACHE_KEY, listCache);
    }
    if (!metadataChanged && entry && entry.librarySignature === signature.enabledLibrarySignature
      && entry.fingerprint === fingerprint) return;
    const local = getDocumentSymbolMetadata(document);
    const names = new Set(), ids = new Set();
    let localIndex = 0, libraryIndex = 0, refIndex = 0, count = local.length;
    function step() {
      if (!shouldContinue()) { lastChecked = 0; return; }
      const start = Date.now();
      let processed = 0;
      while (localIndex < local.length && processed++ < 256 && Date.now() - start < 4) {
        const item = local[localIndex++];
        ids.add(String(item.id));
        names.add(item.name);
      }
      while (localIndex === local.length && libraryIndex < refs.length
        && processed++ < 256 && Date.now() - start < 4) {
        if (refIndex >= refs[libraryIndex].length) { libraryIndex++; refIndex = 0; continue; }
        const item = refs[libraryIndex][refIndex++];
        // Match the browser's exact local/library deduplication rules.
        if (!ids.has(String(item.id)) && !names.has(item.name)) count++;
      }
      if (localIndex < local.length || libraryIndex < refs.length) {
        setTimeout(step, 12);
        return;
      }
      storeComponentCount(document, count, signature);
      pendingMetadataChange = false;
      log('[ComponentCount] ready: ' + count + ' for ' + id);
    }
    step();
  }
  componentCountAgentTimer = setTimeout(tick, 100);
}

// Menu command: opens the plugin and switches straight to the Settings view.
// Implementation: set the launch-mode flag, then defer to the normal onRun
// path. The flag is consumed either by HTML injection (fresh window) or by an
// evaluateWebScript to window.enterSettingsMode (existing window).
function onRunSettings(context) {
  nextLaunchMode = 'settings';
  onRun(context);
}

function verboseSymbolScanLog(message) {
  if (DEBUG_VERBOSE_SYMBOL_SCAN_LOGS) {
    log(message);
  }
}

function verbosePreviewLog(message) {
  if (DEBUG_VERBOSE_PREVIEW_LOGS) {
    log(message);
  }
}

function getThreadDictionaryObject(key) {
  const threadDictionary = NSThread.mainThread().threadDictionary();

  try {
    if (threadDictionary.objectForKey) {
      return threadDictionary.objectForKey(key);
    }
    if (threadDictionary.valueForKey) {
      return threadDictionary.valueForKey(key);
    }
    return null;
  } catch (e) {
    return null;
  }
}

function setThreadDictionaryObject(key, value) {
  const threadDictionary = NSThread.mainThread().threadDictionary();
  if (!threadDictionary) return;

  try {
    if (threadDictionary.setObject_forKey) {
      threadDictionary.setObject_forKey(value, key);
      return;
    }

    if (threadDictionary.setObject_forKey_) {
      threadDictionary.setObject_forKey_(value, key);
      return;
    }

    if (threadDictionary.setValue_forKey) {
      threadDictionary.setValue_forKey(value, key);
      return;
    }
  } catch (e) {
    log("Thread dictionary write failed for " + key + ": " + e);
  }
}

function getEnabledLibraries(document) {
  const targetDocument = document || getActiveDocument();
  let libraries = null;

  // The default library query omits enabled, locally available team libraries
  // in a Cloud document on Sketch 2026.3.1. Ask for the full registry, then
  // apply the user-enabled and Sketch-valid filters ourselves.
  try {
    if (sketch.Library && typeof sketch.Library.getLibraries === 'function') {
      libraries = targetDocument
        ? sketch.Library.getLibraries(targetDocument, { includeUnavailable: true })
        : sketch.Library.getLibraries({ includeUnavailable: true });
    }
  } catch (e) {
    log("[Libraries] Library.getLibraries failed: " + e);
  }
  if (!libraries) {
    try {
      if (targetDocument && typeof targetDocument.getLibraries === 'function') {
        libraries = targetDocument.getLibraries();
      } else {
        libraries = targetDocument ? sketch.getLibraries(targetDocument) : sketch.getLibraries();
      }
    } catch (e) {
      log("[Libraries] sketch.getLibraries(document) failed: " + e);
      try { libraries = sketch.getLibraries(); } catch (fallbackError) {
        log("[Libraries] sketch.getLibraries failed: " + fallbackError);
        libraries = [];
      }
    }
  }

  if (!Array.isArray(libraries)) libraries = [];
  return libraries.filter(function(lib) { return lib && lib.enabled && lib.valid !== false; });
}

function getEnabledLibrarySignatureFromLibraries(libraries) {
  if (!Array.isArray(libraries) || libraries.length === 0) {
    return "";
  }

  // Include each library's version tag (lastModifiedAt) so the L1 cache
  // invalidates not just when libraries are enabled/disabled but also when a
  // library's contents change. Falls back to id-only when the tag is empty.
  return libraries
    .map(function(library) {
      const idPart = String(library.id || library.name || "");
      const verPart = getLibraryVersionTag(library);
      return idPart + (verPart ? "@" + verPart : "");
    })
    .sort()
    .join("|");
}

// Sketch's MSSymbolMaster exposes -isForeign which truthfully tells us whether
// the master is a live library import (true) or a regular local SymbolMaster
// (false). Confirmed via the Sketch MCP run-code probe on a sample document:
//   - Cursors/Beachball after unlink: isForeign=false (correctly local)
//   - Logo/Facebook app/White (live import): isForeign=true (correctly foreign)
// We previously also probed foreignSymbol / libraryID but those methods aren't
// on MSSymbolMaster in this Sketch build; isForeign is the one that works.
function isSymbolMasterForeign(symbolMaster) {
  if (!symbolMaster) return null;
  const native = symbolMaster.sketchObject || symbolMaster;
  if (!native) return null;
  try {
    if (typeof native.isForeign === 'function') {
      return !!native.isForeign();
    }
  } catch (e) {}
  return null;
}

function getDocumentIdentifier(document) {
  if (!document || !document.sketchObject) return null;
  const docStr = String(document.sketchObject);
  const uuidMatch = docStr.match(/\(([a-f0-9-]+)\)/i);
  return uuidMatch ? uuidMatch[1] : docStr;
}

function getNativeDocumentSymbols(document) {
  try {
    const object = document.sketchObject;
    const data = typeof object.documentData === 'function' ? object.documentData() : object;
    return data && typeof data.allSymbols === 'function' ? data.allSymbols() : null;
  } catch (e) { return null; }
}

let documentTurnSnapshot = null;
function getDocumentTurnSnapshot(document) {
  const id = getDocumentIdentifier(document);
  if (!documentTurnSnapshot || documentTurnSnapshot.id !== id) {
    const snapshot = { id: id, metadata: null, signature: null };
    documentTurnSnapshot = snapshot;
    setTimeout(function() {
      if (documentTurnSnapshot === snapshot) documentTurnSnapshot = null;
    }, 0);
  }
  return documentTurnSnapshot;
}

function getDocumentSymbolCount(document) {
  const models = getNativeDocumentSymbols(document);
  return models ? Number(models.count()) : document.getSymbols().length;
}

function getDocumentSymbolMetadata(document) {
  const snapshot = getDocumentTurnSnapshot(document);
  if (snapshot.metadata) return snapshot.metadata;
  const models = getNativeDocumentSymbols(document);
  if (!models) return (snapshot.metadata = document.getSymbols());
  try {
    const klass = NSClassFromString('CBStablePreviewAgent');
    if (klass && typeof klass.componentSummaryJSONForModels_ === 'function') {
      const json = klass.componentSummaryJSONForModels_(models);
      if (json) {
        const result = JSON.parse(String(json));
        result.forEach(function(meta, index) {
          Object.defineProperty(meta, 'sketchObject', {
            get: function() { return models.objectAtIndex(index); }
          });
        });
        return (snapshot.metadata = result);
      }
    }
  } catch (e) { log('[Components] native summary unavailable: ' + e); }
  const result = [];
  for (let i = 0, count = Number(models.count()); i < count; i++) {
    const model = models.objectAtIndex(i);
    result.push({ id: String(model.objectID()), name: String(model.name()), sketchObject: model });
  }
  return (snapshot.metadata = result);
}

function createLazyLocalSymbolLookup(symbols) {
  const lookup = {};
  symbols.forEach(function(meta) {
    Object.defineProperty(lookup, String(meta.id), {
      enumerable: true, configurable: true,
      get: function() {
        const master = sketch.fromNative(meta.sketchObject || meta);
        Object.defineProperty(lookup, String(meta.id), { value: master, enumerable: true, configurable: true, writable: true });
        return master;
      }
    });
  });
  return lookup;
}

function invalidateSymbolLookupCache() {
  symbolLookupCache.docId = null;
  symbolLookupCache.localById = {};
  symbolLookupCache.libraryRefById = {};
  symbolLookupCache.libraryIdById = {};
  symbolLookupCache.libraryRefsLoadedById = {};
}

function rebuildSymbolLookupCache(document) {
  const localById = createLazyLocalSymbolLookup(getDocumentSymbolMetadata(document));

  symbolLookupCache.docId = getDocumentIdentifier(document);
  symbolLookupCache.localById = localById;
  symbolLookupCache.libraryRefById = {};
  symbolLookupCache.libraryIdById = {};
  symbolLookupCache.libraryRefsLoadedById = {};
}

function ensureSymbolLookupCache(document) {
  const currentDocId = getDocumentIdentifier(document);
  if (!currentDocId) {
    invalidateSymbolLookupCache();
    return;
  }

  if (symbolLookupCache.docId !== currentDocId) {
    rebuildSymbolLookupCache(document);
  }
}

function getEnabledLibraryById(libraryId, document) {
  if (libraryId === null || libraryId === undefined || libraryId === '') return null;
  const wantedId = String(libraryId);
  const libraries = getEnabledLibraries(document);
  for (let i = 0; i < libraries.length; i++) {
    if (String(libraries[i].id || '') === wantedId) return libraries[i];
  }
  return null;
}

function ensureLibraryReferenceCache(document, libraryId) {
  if (!document || libraryId === null || libraryId === undefined || libraryId === '') return null;
  ensureSymbolLookupCache(document);
  const wantedId = String(libraryId);
  if (symbolLookupCache.libraryRefsLoadedById[wantedId]) return getEnabledLibraryById(wantedId, document);

  const library = getEnabledLibraryById(wantedId, document);
  if (!library) return null;

  try {
    const refs = library.getImportableSymbolReferencesForDocument(document) || [];
    for (let i = 0; i < refs.length; i++) {
      const ref = refs[i];
      if (!ref || !ref.id) continue;
      const id = String(ref.id);
      symbolLookupCache.libraryRefById[id] = ref;
      symbolLookupCache.libraryIdById[id] = wantedId;
    }
    symbolLookupCache.libraryRefsLoadedById[wantedId] = true;
    return library;
  } catch (e) {
    log("[Preview] failed to load references for library " + wantedId + ": " + e);
    return null;
  }
}

// ============================================================
// Persistent preview disk cache
// ============================================================
// PNGs live in ~/Library/Caches and are reused across Sketch launches while
// the OS retains them. Version sidecars are written by the native worker;
// the old Settings index is read only as a compatibility fallback.

let _previewDiskCacheRootPath = null;

function getPreviewDiskCacheRoot() {
  if (_previewDiskCacheRootPath) return _previewDiskCacheRootPath;
  try {
    const fm = NSFileManager.defaultManager();
    const cacheDirectories = fm.URLsForDirectory_inDomains(NSCachesDirectory, NSUserDomainMask);
    if (!cacheDirectories || cacheDirectories.count() === 0) return null;
    const root = cacheDirectories.objectAtIndex(0)
      .URLByAppendingPathComponent("com.funkyplugins.componentbrowser")
      .URLByAppendingPathComponent(PREVIEW_DISK_DIR_NAME);
    fm.createDirectoryAtURL_withIntermediateDirectories_attributes_error(root, true, null, null);
    _previewDiskCacheRootPath = String(root.path());
    return _previewDiskCacheRootPath;
  } catch (e) {
    log("[PreviewCache] failed to get cache root: " + e);
    return null;
  }
}

function getSafePreviewFileName(symbolId) {
  return String(symbolId || '').replace(/[^A-Za-z0-9_.-]/g, "_") + ".png";
}

function getPreviewDiskFilePath(symbolId) {
  const root = getPreviewDiskCacheRoot();
  if (!root || !symbolId) return null;
  return root + "/" + getSafePreviewFileName(symbolId);
}

function getPreviewDiskVersionFilePath(symbolId) {
  const pngPath = getPreviewDiskFilePath(symbolId);
  return pngPath ? pngPath + ".version" : null;
}

function readPreviewDiskVersionTag(symbolId) {
  const versionPath = getPreviewDiskVersionFilePath(symbolId);
  if (!versionPath) return null;
  try {
    const data = NSData.dataWithContentsOfFile(versionPath);
    if (!data || data.length() === 0) return null;
    return String(NSString.alloc().initWithData_encoding(data, NSUTF8StringEncoding));
  } catch (e) {
    return null;
  }
}

let _previewDiskIndexMemo = null;
function getPreviewDiskIndex() {
  if (_previewDiskIndexMemo) return _previewDiskIndexMemo;
  const stored = Settings.settingForKey(PREVIEW_DISK_INDEX_KEY);
  _previewDiskIndexMemo = (stored && typeof stored === 'object' && !Array.isArray(stored))
    ? Object.assign({}, stored) : {};
  return _previewDiskIndexMemo;
}

function hasValidDiskPreview(symbolId, expectedVersionTag) {
  if (!symbolId || !expectedVersionTag) return false;
  const path = getPreviewDiskFilePath(symbolId);
  if (!path) return false;
  try {
    const fm = NSFileManager.defaultManager();
    if (!fm.fileExistsAtPath(path)) {
      return false;
    }
    const wantedTag = getPreviewCacheVersionTag(expectedVersionTag);
    const sidecarTag = readPreviewDiskVersionTag(symbolId);
    if (sidecarTag !== null) return sidecarTag === wantedTag;
    const entry = getPreviewDiskIndex()[String(symbolId)];
    if (entry && String(entry.versionTag || '') === wantedTag) return true;
  } catch (e) {}
  return false;
}

function getPreviewCacheVersionTag(versionTag) {
  return PREVIEW_CACHE_QUALITY_TAG + ":" + String(versionTag || '');
}

function previewContentHash(value) {
  const text = String(value || '');
  let first = 2166136261, second = 2654435769;
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    first = Math.imul(first ^ code, 16777619);
    second = Math.imul(second ^ code, 2246822519);
  }
  return text.length + '-' + (first >>> 0).toString(16) + '-' + (second >>> 0).toString(16);
}

// A version tag is whatever string changes when the symbol's rendered content
// changes. Library components use the library revision; local components use
// a persistent checksum of their metadata, memoized by the live model revision.
function getSymbolVersionTag(symbolMaster, libraryRef, symbolId, document) {
  // For library symbols, derive the owning library's version. We can't ask
  // the JS ref wrapper directly (no working libraryID accessor) — instead
  // look up the library id recorded at scan time in symbolLookupCache.
  // Fall back to iterating libraries if the cache miss happens (rare).
  try {
    if (libraryRef) {
      let libIdRaw = symbolId ? symbolLookupCache.libraryIdById[symbolId] : null;
      if (!libIdRaw) {
        try {
          if (libraryRef.libraryID) libIdRaw = libraryRef.libraryID;
        } catch (e) {}
      }
      if (libIdRaw) {
        const library = getEnabledLibraryById(libIdRaw, document || getActiveDocument());
        if (library) {
          const t = getLibraryVersionTag(library);
          if (t) return "lib:" + t;
        }
      }
    }
  } catch (e) {}

  try {
    const native = symbolMaster ? (symbolMaster.sketchObject || symbolMaster) : null;
    if (!native) return "";
    // Native immutable-object hashes identify a revision only within a process.
    // Persist a checksum of JSON metadata instead; this does not rasterize the
    // component, and memoization avoids serializing it again until it changes.
    if (symbolMaster && !libraryRef) {
      const key = String(getDocumentIdentifier(document) || '') + '|' + String(symbolId || symbolMaster.id || '');
      let revision = '';
      try { revision = String(symbolMaster._revision || native.immutableModelObject().hash()); } catch (e) {}
      const memo = localPreviewVersionMemo.get(key);
      if (revision && memo && memo.revision === revision) return memo.tag;
      const json = sketch.export(sketch.fromNative(native), { formats: 'json', output: false });
      const serialized = JSON.stringify(json);
      const tag = 'local-json-v1:' + previewContentHash(serialized);
      const references = [];
      const pattern = /"symbolID"\s*:\s*"([^"]+)"/g;
      let match;
      while ((match = pattern.exec(serialized))) references.push(match[1]);
      localPreviewVersionMemo.set(key, { revision: revision, tag: tag, references: references });
      if (localPreviewVersionMemo.size > 4096) localPreviewVersionMemo.delete(localPreviewVersionMemo.keys().next().value);
      return tag;
    }
    if (typeof native.lastChangedAt === 'function') {
      const d = native.lastChangedAt();
      if (d && typeof d.timeIntervalSince1970 === 'function') {
        return "ts:" + Math.floor(Number(d.timeIntervalSince1970()) * 1000);
      }
    }
    let w = 0, h = 0, childCount = 0;
    try {
      const frame = native.frame ? native.frame() : null;
      if (frame) {
        w = Math.round(Number(frame.width()));
        h = Math.round(Number(frame.height()));
      }
    } catch (_) {}
    try {
      if (typeof native.layers === 'function') {
        childCount = Number(native.layers().count() || 0);
      }
    } catch (_) {}
    return "struct:" + w + "x" + h + ":" + childCount;
  } catch (e) {}
  return "";
}

function readDiskPreview(symbolId, expectedVersionTag) {
  if (!symbolId || !expectedVersionTag) return null;
  const filePath = getPreviewDiskFilePath(symbolId);
  if (!filePath) return null;
  try {
    const fm = NSFileManager.defaultManager();
    if (!fm.fileExistsAtPath(filePath)) {
      return null;
    }
    const wantedTag = getPreviewCacheVersionTag(expectedVersionTag);
    const sidecarTag = readPreviewDiskVersionTag(symbolId);
    if (sidecarTag !== null) {
      if (sidecarTag !== wantedTag) return null;
    } else {
      const entry = getPreviewDiskIndex()[symbolId];
      if (!entry || String(entry.versionTag || '') !== wantedTag) return null;
    }
    // Let WebKit read/decode the cached file asynchronously. Main-thread PNG
    // reads, base64 encoding and large evaluateWebScript payloads caused pauses.
    const url = String(NSURL.fileURLWithPath(filePath).absoluteString());
    return url + '?v=' + encodeURIComponent(wantedTag);
  } catch (e) {
    log("[PreviewCache] read failed for " + symbolId + ": " + e);
    return null;
  }
}

// In-memory thumbnails are an LRU. Persistent PNGs are read lazily from disk;
// copying thousands of base64 strings through Sketch settings on every render
// made cache hits quadratic in library size.
function getCachedPreview(symbolId) {
  if (!symbolId) return null;
  const key = String(symbolId);
  if (!previewMemoryCache.has(key)) return null;
  const value = previewMemoryCache.get(key);
  previewMemoryCache.delete(key);
  previewMemoryCache.set(key, value);
  return value;
}

function setCachedPreview(symbolId, preview) {
  if (!symbolId || !preview) return;
  const key = String(symbolId);
  if (previewMemoryCache.has(key)) previewMemoryCache.delete(key);
  previewMemoryCache.set(key, String(preview));
  while (previewMemoryCache.size > PREVIEW_MEMORY_CACHE_LIMIT) {
    const oldestKey = previewMemoryCache.keys().next().value;
    previewMemoryCache.delete(oldestKey);
  }
}

// Symbols cache is persistent (NSUserDefaults-backed via Settings.setSettingForKey)
// so a scan done in one Sketch session survives a Sketch restart. Critically,
// we only store the LEAN metadata (no inlined preview data URLs) — see
// setCachedSymbolsJson. Bloated JSON would otherwise grow into tens of MB and
// make NSUserDefaults reads/writes (and the subsequent evaluateWebScript) slow
// enough to hang the UI on cache hits.
function getOrCreateSymbolsCache() {
  const cache = Settings.settingForKey(SYMBOLS_CACHE_KEY);
  return cache && typeof cache === 'object' && !Array.isArray(cache) ? Object.assign({}, cache) : {};
}

function getOrCreateUiStateCache() {
  const cache = Settings.sessionVariable(UI_STATE_CACHE_KEY);
  return cache && typeof cache === 'object' && !Array.isArray(cache) ? Object.assign({}, cache) : {};
}

function invalidateSymbolsListCache() {
  Settings.setSettingForKey(SYMBOLS_CACHE_KEY, null);
}

// Removes inlined preview data URLs from a symbols JSON string. Each preview
// can be ~5 KB of base64 — for thousands of symbols this is the difference
// between a 500 KB cache write and a 25 MB one.
function stripPreviewsFromSymbolsJson(symbolsJson) {
  if (!symbolsJson) return symbolsJson;
  try {
    const symbols = JSON.parse(String(symbolsJson));
    if (!Array.isArray(symbols)) return symbolsJson;
    let stripped = false;
    for (let i = 0; i < symbols.length; i++) {
      const s = symbols[i];
      if (s && s.preview) {
        s.preview = null;
        stripped = true;
      }
    }
    return stripped ? JSON.stringify(symbols) : symbolsJson;
  } catch (e) {
    return symbolsJson;
  }
}

// L2 cache: library symbol metadata per library, shared across all documents.
// Keyed by library.id, validated against the library's lastModifiedAt so a
// library only re-scans when its contents actually change. The values are
// LEAN — { id, name } per symbol — so a 5000-symbol library is ~150 KB on
// disk, not megabytes.
//
// Live reference objects are loaded only for a component's owning library
// when its thumbnail is requested.
// Reading from NSUserDefaults is not free, especially for a multi-MB blob —
// deserializing 10× per scan (once per library probe) adds up. Memoize for
// a short window so the per-library reads within a single scan only hit
// disk once. Manually invalidated by writers (setCachedLibrarySymbols /
// invalidateLibraryCachesByKey).
const _librariesCacheMemo = { value: null, time: 0 };
const LIBRARIES_CACHE_MEMO_TTL_MS = 200;

function getOrCreateLibrariesCache() {
  const now = Date.now();
  if (_librariesCacheMemo.value && (now - _librariesCacheMemo.time) < LIBRARIES_CACHE_MEMO_TTL_MS) {
    return _librariesCacheMemo.value;
  }
  const cache = Settings.settingForKey(LIBRARIES_CACHE_KEY);
  const result = cache && typeof cache === 'object' && !Array.isArray(cache) ? Object.assign({}, cache) : {};

  // Migration: drop legacy bare-id keys (no '|' separator) left over from
  // pre-composite-key plugin versions. They shadow valid entries inside
  // findL2EntryForSymbolId (which iterates the map), causing [Stale] purges
  // to log/operate on the wrong key.
  let removed = 0;
  for (const k in result) {
    if (Object.prototype.hasOwnProperty.call(result, k) && typeof k === 'string' && k.indexOf('|') === -1) {
      delete result[k];
      removed++;
    }
  }
  if (removed > 0) {
    try { Settings.setSettingForKey(LIBRARIES_CACHE_KEY, result); } catch (e) {}
    log("[Migrate] dropped " + removed + " legacy bare-id L2 entries");
  }

  _librariesCacheMemo.value = result;
  _librariesCacheMemo.time = now;
  return result;
}

function getLibraryVersionTag(library) {
  // Combine two signals so the cache busts when EITHER changes:
  //   a) Sketch's own library.lastModifiedAt (unreliable for in-place edits
  //      like renames in some Sketch builds)
  //   b) Filesystem mtime of the .sketch file the library lives in — bumps
  //      whenever Sketch writes the file to disk, which it always does on
  //      symbol rename / add / remove
  const parts = [];
  try {
    if (library && library.lastModifiedAt) {
      const v = library.lastModifiedAt;
      const t = (v && typeof v.getTime === 'function') ? v.getTime() : v;
      if (t) parts.push("a" + String(t));
    }
  } catch (e) {}
  try {
    const path = getLibraryFilePathForPreviewAgent(library);
    if (path) {
      const attrs = NSFileManager.defaultManager().attributesOfItemAtPath_error_(path, null);
      if (attrs) {
        const modDate = attrs.objectForKey("NSFileModificationDate");
        if (modDate && typeof modDate.timeIntervalSince1970 === 'function') {
          parts.push("f" + Math.floor(Number(modDate.timeIntervalSince1970()) * 1000));
        }
      }
    }
  } catch (e) {}
  // Always return SOMETHING when we have a library — without it the disk
  // cache skips the write entirely. Falling back to library.id means we
  // never invalidate via this tag, but the post-cache-hit verify scan
  // catches in-memory renames either way.
  if (parts.length === 0) {
    try {
      const id = library && library.id;
      if (id) return "id:" + String(id);
    } catch (e) {}
  }
  return parts.join('+');
}

// Sketch can return the same library.id for multiple distinct libraries
// (e.g. Apple ships several UI Kits under one libraryID). Combine id + name
// as the L2 key so they don't collide and overwrite each other.
function getLibraryCacheKey(library) {
  if (!library) return null;
  const id = String(library.id || '');
  const name = String(library.name || '');
  if (!id && !name) return null;
  return id + '|' + name;
}

function getLibraryFilePathForPreviewAgent(library) {
  try {
    // Library.getDocument() calls loadSynchronously() in Sketch's API. Reading
    // a path must never open every enabled library on the main thread.
    const native = library && library.sketchObject;
    if (!native || typeof native.locationOnDisk !== 'function') return null;
    const url = native.locationOnDisk();
    if (!url || !url.isFileURL()) return null;
    let path = String(url.path() || '');
    try { path = decodeURIComponent(path); } catch (e) {}
    if (!path || !/\.sketch$/i.test(path)) return null;
    return NSFileManager.defaultManager().fileExistsAtPath(path) ? path : null;
  } catch (e) {
    return null;
  }
}

function getLibraryPreviewSources(library) {
  try {
    if (!library || typeof library.getDocument !== 'function') return null;
    const libraryDocument = library.getDocument();
    if (!libraryDocument || typeof libraryDocument.getSymbols !== 'function') return null;

    const sourceIdsByName = Object.create(null);
    const sourceIdsByComponentId = Object.create(null);
    const sourceSymbols = libraryDocument.getSymbols();
    for (let i = 0; i < sourceSymbols.length; i++) {
      const source = sourceSymbols[i];
      const name = String(source && source.name || '');
      const id = String(source && source.id || '');
      if (!name || !id) continue;
      const info = { id: id, scale: getExportScaleForSymbol(source, PREVIEW_RENDER_SIZE) };
      let componentId = String(source.symbolId || '');
      try {
        const native = source.sketchObject || source;
        if (!componentId && native && typeof native.symbolID === 'function') componentId = String(native.symbolID());
      } catch (e) {}
      if (componentId) sourceIdsByComponentId[componentId] = info;
      if (Object.prototype.hasOwnProperty.call(sourceIdsByName, name)) {
        sourceIdsByName[name] = null;
      } else {
        sourceIdsByName[name] = info;
      }
    }
    return { byName: sourceIdsByName, byComponentId: sourceIdsByComponentId };
  } catch (e) {
    log("[PreviewAgent] could not inspect library sources for " + String(library && library.name || '?') + ": " + e);
    return null;
  }
}

function queuePreviewAgentFromSymbolsJson(symbolsJson, document) {
  if (!previewAgent) return;
  const buildToken = ++previewQueueBuildToken;
  const queue = [];
  try {
    const symbols = JSON.parse(String(symbolsJson || '[]'));
    const rowsByLibrary = {};
    symbols.forEach(function(row) {
      if (!row || row.library === null || row.library === undefined || row.library === '' || !row.id) return;
      const key = String(row.library) + '|' + String(row.libraryName || '');
      if (!rowsByLibrary[key]) rowsByLibrary[key] = [];
      rowsByLibrary[key].push(row);
    });

    const libraries = getEnabledLibraries(document);
    const libraryVersionTags = [];
    let cachedCount = 0, libraryIndex = 0, rowIndex = 0;
    function scanLibraryChunk() {
      if (!previewAgent || buildToken !== previewQueueBuildToken) return;
      if (libraryIndex >= libraries.length) {
        prepareLocalPreviewSnapshot(symbols, document, submitQueue, function() {
          return !!previewAgent && buildToken === previewQueueBuildToken;
        }, libraryVersionTags.sort().join('|'));
        return;
      }
      const library = libraries[libraryIndex];
      const key = getLibraryCacheKey(library);
      const rows = key ? rowsByLibrary[key] : null;
      const libraryVersion = getLibraryVersionTag(library);
      const libraryPath = getLibraryFilePathForPreviewAgent(library);
      if (!rows || !rows.length || !libraryVersion || !libraryPath) {
        libraryIndex++; rowIndex = 0;
        setTimeout(scanLibraryChunk, 8);
        return;
      }
      const versionTag = 'lib:' + libraryVersion;
      if (rowIndex === 0) libraryVersionTags.push(versionTag);
      const started = Date.now();
      let processed = 0;
      while (rowIndex < rows.length && processed < 32 && Date.now() - started < 6) {
        const row = rows[rowIndex++];
        processed++;
        const id = String(row.id);
        if (previewVersionTagBySymbol[id] && previewVersionTagBySymbol[id] !== versionTag) previewMemoryCache.delete(id);
        previewVersionTagBySymbol[id] = versionTag;
        if (hasValidDiskPreview(id, versionTag)) { cachedCount++; continue; }
        // Only metadata crosses the bridge. The worker resolves component IDs
        // to layer IDs and sizes directly from the archive, off the UI thread.
        queue.push({
          symbolId: id,
          name: String(row.name || ''),
          libraryID: String(library.id || ''),
          libraryName: String(library.name || ''),
          libraryPath: libraryPath,
          versionTag: versionTag
        });
      }
      if (rowIndex >= rows.length) { libraryIndex++; rowIndex = 0; }
      setTimeout(scanLibraryChunk, 8);
    }

    function submitQueue(localItems) {
      if (!previewAgent || buildToken !== previewQueueBuildToken) return;
      localItems.forEach(function(item) { queue.push(item); });
      queue.sort(function(a, b) {
        const pathOrder = a.libraryPath.localeCompare(b.libraryPath);
        if (pathOrder) return pathOrder;
        const scaleOrder = Number(a.scale) - Number(b.scale);
        return scaleOrder || a.symbolId.localeCompare(b.symbolId);
      });
      previewAgent.setPendingItems_(queue);
      const state = runtimeBrowserState;
      pendingForegroundPreviewIDs.forEach(function(id) {
        const tag = previewVersionTagBySymbol[id];
        const cached = tag && readDiskPreview(id, tag);
        if (cached && state && state.isVisible && state.docId === getDocumentIdentifier(document)) {
          setCachedPreview(id, cached);
          sendPreviewToUI(state.webView, id, cached);
          pendingForegroundPreviewIDs.delete(id);
          return;
        }
        try { previewAgent.requestPreviewForSymbolID_(id); } catch (e) {}
      });
      if (state && state.webView && !state.closed && getDocumentIdentifier(document) === state.docId) {
        state.localPreviewLiveRevision = getLocalPreviewLiveRevision(document);
        evaluateWebScriptSafely(state.webView, 'window.applyPreviewVersionTags && window.applyPreviewVersionTags(' + JSON.stringify(previewVersionTagBySymbol) + ');');
      }
      log("[PreviewAgent] cache scan: " + cachedCount + " valid library previews, " + queue.length + " pending previews including " + localItems.length + " local");
    }
    setTimeout(scanLibraryChunk, 0);
  } catch (e) {
    log("[PreviewAgent] failed to queue previews: " + e);
  }
}

function prepareLocalPreviewSnapshot(symbols, document, callback, shouldContinue, librarySignature) {
  const rows = symbols.filter(function(row) { return row && row.library === null && row.id; });
  if (rows.length === 0) { callback([]); return; }
  ensureSymbolLookupCache(document);
  // Refresh wrappers after edits; retain the independently cached library refs.
  const localModels = getDocumentSymbolMetadata(document);
  symbolLookupCache.localById = createLazyLocalSymbolLookup(localModels);
  const localModelsById = {};
  localModels.forEach(function(meta) { localModelsById[meta.id] = meta; });
  const missing = [];
  const localItems = [];
  const itemsByComponentID = {};
  const documentId = String(getDocumentIdentifier(document));
  const dependencyVersions = new Map();
  const visitingDependencies = new Set();
  let index = 0;
  function scanChunk() {
    if (!shouldContinue()) return;
    const chunkStarted = Date.now();
    const end = Math.min(index + 16, rows.length);
    for (; index < end; index++) {
      if (index > 0 && Date.now() - chunkStarted >= 6) break;
      const id = String(rows[index].id);
      const master = localModelsById[id];
      if (!master) continue;
      const versionTag = getSymbolVersionTag(master, null, id, document);
      if (!versionTag) continue;
      const item = {
        symbolId: id, sourceSymbolId: id,
        scale: getExportScaleForSymbol(master, PREVIEW_RENDER_SIZE),
        libraryID: '', libraryName: 'Local Document', baseVersionTag: versionTag
      };
      localItems.push(item);
      const componentID = master.componentId || String(master.sketchObject.symbolID());
      itemsByComponentID[componentID] = item;
    }
    if (index < rows.length) { setTimeout(scanChunk, 8); return; }
    checkCacheChunk(0);
  }
  function dependencyRevision(root) {
    if (dependencyVersions.has(root.symbolId)) return dependencyVersions.get(root.symbolId);
    if (visitingDependencies.has(root.symbolId)) return root.baseVersionTag;
    visitingDependencies.add(root.symbolId);
    const parts = [root.symbolId + ':' + root.baseVersionTag];
    const memo = localPreviewVersionMemo.get(documentId + '|' + root.symbolId);
    (memo && memo.references || []).forEach(function(reference) {
      const child = itemsByComponentID[reference];
      if (child && child !== root) parts.push(child.symbolId + ':' + dependencyRevision(child));
    });
    visitingDependencies.delete(root.symbolId);
    const revision = previewContentHash(parts.sort().join('|') + '|' + String(librarySignature || ''));
    dependencyVersions.set(root.symbolId, revision);
    return revision;
  }
  function checkCacheChunk(start) {
    if (!shouldContinue()) return;
    const end = Math.min(start + 32, localItems.length);
    for (let i = start; i < end; i++) {
      const item = localItems[i];
      item.versionTag = item.baseVersionTag + ':doc:' + dependencyRevision(item);
      if (previewVersionTagBySymbol[item.symbolId] && previewVersionTagBySymbol[item.symbolId] !== item.versionTag) previewMemoryCache.delete(item.symbolId);
      previewVersionTagBySymbol[item.symbolId] = item.versionTag;
      if (!hasValidDiskPreview(item.symbolId, item.versionTag)) missing.push(item);
    }
    if (end < localItems.length) { setTimeout(function() { checkCacheChunk(end); }, 8); return; }
    if (!missing.length) { callback([]); return; }
    try {
      const snapshotRoot = getPreviewDiskCacheRoot() + '/local-snapshots';
      NSFileManager.defaultManager().createDirectoryAtPath_withIntermediateDirectories_attributes_error_(snapshotRoot, true, null, null);
      const snapshotPath = snapshotRoot + '/' + String(getDocumentIdentifier(document)).replace(/[^A-Za-z0-9_.-]/g, '_') + '.sketch';
      // SaveTo is Sketch's asynchronous copy operation. It preserves the live
      // document's path and unsaved changes, including cloud/unsaved documents.
      document.save(snapshotPath, { saveMode: sketch.Document.SaveMode.SaveTo }, function(error) {
        if (!shouldContinue()) return;
        if (error) { log('[PreviewAgent] local snapshot failed: ' + error); callback([]); return; }
        missing.forEach(function(item) { item.libraryPath = snapshotPath; });
        callback(missing);
      });
    } catch (e) { log('[PreviewAgent] local snapshot failed: ' + e); callback([]); }
  }
  setTimeout(scanChunk, 0);
}

function deferPreviewAgentQueueFromSymbolsJson(symbolsJson, document, browserState, reloadToken, expectedDocId) {
  setTimeout(function() {
    if (!previewAgent || !document) return;
    if (browserState && (browserState.closed || browserState.reloadToken !== reloadToken || browserState.docId !== expectedDocId)) return;
    if (getDocumentIdentifier(document) !== expectedDocId) return;
    queuePreviewAgentFromSymbolsJson(symbolsJson, document);
  }, 0);
}

function getCachedLibrarySymbols(library) {
  const key = getLibraryCacheKey(library);
  if (!key) return null;
  const cache = getOrCreateLibrariesCache();
  const entry = cache[key];
  if (!entry || !Array.isArray(entry.symbols)) return null;
  if (String(entry.versionTag || '') !== getLibraryVersionTag(library)) return null;
  return entry;
}

function setCachedLibrarySymbols(library, leanSymbols) {
  const key = getLibraryCacheKey(library);
  if (!key || !Array.isArray(leanSymbols)) return;
  const cache = getOrCreateLibrariesCache();
  cache[key] = {
    name: String(library.name || ''),
    versionTag: getLibraryVersionTag(library),
    symbols: leanSymbols,
    updatedAt: String(Date.now())
  };
  Settings.setSettingForKey(LIBRARIES_CACHE_KEY, cache);
  // Bust memoization so subsequent reads see the new entry.
  _librariesCacheMemo.value = null;
}

// Self-healing: invalidate caches when we detect a stale entry. Called
// from preview / insert fallback paths when the L2 cache claims a symbol
// lives in some library but the live library doesn't actually contain it
// (Sketch's library.lastModifiedAt doesn't bump on every library change,
// so the mtime-based staleness check sometimes lies).
// Ghost-symbol recovery: L1 cache holds a doc's symbol list. When a library
// changes contents WITHOUT bumping lastModifiedAt, L1 keeps stale entries
// that no live library claims — and no L2 entry owns them either, so
// invalidateLibraryCachesByKey can't help. Drop the current doc's L1 entry
// and trigger a silent rebuild so the picker reflects reality.
function invalidateCurrentDocL1AndRefresh() {
  try {
    const bs = runtimeBrowserState;
    if (!bs || bs.closed || !bs.document) return;
    const docId = getDocumentIdentifier(bs.document);
    if (!docId) return;
    const symCache = Settings.settingForKey(SYMBOLS_CACHE_KEY) || {};
    if (symCache[docId]) {
      delete symCache[docId];
      Settings.setSettingForKey(SYMBOLS_CACHE_KEY, symCache);
      log("[Ghost] dropped L1 entry for doc=" + docId + " — symbol vanished from all libraries");
    }
  } catch (e) {}
  scheduleSilentRefresh();
}

function invalidateLibraryCachesByKey(libraryCacheKey) {
  if (!libraryCacheKey) return;
  try {
    const libCache = getOrCreateLibrariesCache();
    if (libCache[libraryCacheKey]) {
      delete libCache[libraryCacheKey];
      Settings.setSettingForKey(LIBRARIES_CACHE_KEY, libCache);
    }
  } catch (e) {}
  // Bust the in-memory L2 memoization too — see getOrCreateLibrariesCache.
  _librariesCacheMemo.value = null;
  // L1 is intentionally NOT wiped here. The silent refresh that fires next
  // overwrites the current doc's L1 entry with fresh data, so the wipe was
  // redundant — and wiping ALL docs (the old behavior) destroyed cache
  // utility every time the user encountered a single stale symbol.
  log("[Stale] invalidated L2 key '" + libraryCacheKey + "'");

  // Silently rebuild the visible list in the background. The user just clicked
  // a symbol that turned out to be stale; instead of showing them a "reopen the
  // plugin" message, refresh in place — they'll just see the list update.
  scheduleSilentRefresh();
}

let _silentRefreshScheduled = false;
function scheduleSilentRefresh() {
  if (_silentRefreshScheduled) return;
  const bs = runtimeBrowserState;
  if (!bs || bs.closed || !bs.document) return;
  _silentRefreshScheduled = true;
  setTimeout(function() {
    _silentRefreshScheduled = false;
    const current = runtimeBrowserState;
    if (!current || current.closed || !current.document) return;
    log("[Stale] silent refresh: rebuilding symbol list in background");
    loadSymbolsIntoBrowser(current, { showLoader: false, forceRefresh: true });
  }, 0);
}

// Look up the L2 entry that claims to own a given symbolId. Returns
// { key, name } or null. Used both for diagnostic logging and for
// driving self-healing invalidation.
function findL2EntryForSymbolId(symbolId) {
  try {
    const cache = getOrCreateLibrariesCache();
    for (const key in cache) {
      const entry = cache[key];
      if (!entry || !Array.isArray(entry.symbols)) continue;
      for (let i = 0; i < entry.symbols.length; i++) {
        if (entry.symbols[i].id === symbolId) {
          return { key: key, name: String(entry.name || '') };
        }
      }
    }
  } catch (e) {}
  return null;
}

// L1 cache: full merged symbol JSON per document. Keyed by docId, so switching
// documents preserves caches for previously-visited docs. Each entry stores its
// own validity signature (library set + local symbol count) so we can detect
// staleness without invalidating other docs' entries.
// Cheap fingerprint of local symbol IDs+names. Used to bust L1 when the user
// renames a symbol — count + library signature don't change on rename so the
// previous validation kept serving the stale name. We don't compute one for
// library symbols here because that would require iterating every library's
// refs on every cache read (defeats the cache).
function getLocalSymbolsFingerprint(document) {
  try {
    const syms = getDocumentSymbolMetadata(document);
    const parts = [];
    for (let i = 0; i < syms.length; i++) {
      parts.push(String(syms[i].id || '') + ':' + String(syms[i].name || ''));
    }
    parts.sort();
    return parts.join('|');
  } catch (e) {
    return '';
  }
}

// Runtime-only identity: cheap enough to check on reopening, never persisted.
// Content checksums are calculated in small chunks only when this changes.
function getLocalPreviewLiveRevision(document) {
  try {
    return getDocumentSymbolMetadata(document).map(function(master) {
      return String(master.id) + ':' + String(master._revision || master.sketchObject.immutableModelObject().hash());
    }).sort().join('|');
  } catch (e) { return ''; }
}

function getCachedSymbolsJson(document) {
  const docId = getDocumentIdentifier(document);
  if (!docId) return null;

  const cache = getOrCreateSymbolsCache();
  const entry = cache[docId];
  if (!entry || !entry.symbolsJson) return null;

  const signature = getDocumentContentSignature(document);
  if (Number(entry.localSymbolCount || 0) !== signature.localSymbolCount) return null;
  if (Number(entry.enabledLibraryCount || 0) !== signature.enabledLibraryCount) return null;
  if (String(entry.enabledLibrarySignature || "") !== signature.enabledLibrarySignature) return null;
  // Rename detection for local symbols.
  if (String(entry.localSymbolsFingerprint || "") !== getLocalSymbolsFingerprint(document)) {
    log("[L1] local symbol name change detected — invalidating cache for doc=" + docId);
    return null;
  }

  return String(entry.symbolsJson);
}

function setCachedSymbolsJson(document, symbolsJson) {
  const docId = getDocumentIdentifier(document);
  if (!docId || !symbolsJson) return;

  // Strip previews before persisting — see stripPreviewsFromSymbolsJson.
  const lean = stripPreviewsFromSymbolsJson(symbolsJson);

  const cache = getOrCreateSymbolsCache();
  // If the previous read returned an old single-doc-shaped blob (from earlier
  // plugin versions), it would have a top-level `docId` field. Drop those
  // stray top-level fields so the cache becomes purely a docId → entry map.
  delete cache.docId;
  delete cache.symbolsJson;
  delete cache.localSymbolCount;
  delete cache.enabledLibraryCount;
  delete cache.enabledLibrarySignature;

  const enabledLibraries = getEnabledLibraries(document);
  cache[docId] = {
    symbolsJson: String(lean),
    localSymbolCount: String(getDocumentSymbolCount(document)),
    enabledLibraryCount: String(enabledLibraries.length),
    enabledLibrarySignature: getEnabledLibrarySignatureFromLibraries(enabledLibraries),
    localSymbolsFingerprint: getLocalSymbolsFingerprint(document),
    updatedAt: String(Date.now())
  };
  Settings.setSettingForKey(SYMBOLS_CACHE_KEY, cache);
  storeComponentCount(document, JSON.parse(String(lean)).length, {
    localSymbolCount: Number(cache[docId].localSymbolCount),
    enabledLibrarySignature: cache[docId].enabledLibrarySignature
  });
  return cache[docId].localSymbolsFingerprint;
}

function getSavedUiState(document) {
  const docId = getDocumentIdentifier(document);
  if (!docId) return null;

  const cache = getOrCreateUiStateCache();
  const cachedDocId = cache.docId;
  const cachedJson = cache.uiStateJson;

  if (!cachedDocId || String(cachedDocId) !== docId) return null;
  if (!cachedJson) return null;

  return String(cachedJson);
}

function setSavedUiState(document, uiStateJson) {
  const docId = getDocumentIdentifier(document);
  if (!docId || !uiStateJson) return;

  const cache = getOrCreateUiStateCache();
  cache.docId = String(docId);
  cache.uiStateJson = String(uiStateJson);
  Settings.setSessionVariable(UI_STATE_CACHE_KEY, cache);
}

function getActiveDocument() {
  try {
    return sketch.getSelectedDocument();
  } catch (e) {
    return null;
  }
}

function getBrowserPreferences() {
  const stored = Settings.settingForKey(BROWSER_PREFERENCES_KEY) || {};
  return {
    appearance: ['light', 'dark', 'auto'].indexOf(String(stored.appearance)) >= 0 ? String(stored.appearance) : 'auto'
  };
}

function loadBrowserPanelClass(context) {
  try {
    const path = context.scriptURL.URLByDeletingLastPathComponent()
      .URLByDeletingLastPathComponent().URLByAppendingPathComponent('Resources')
      .URLByAppendingPathComponent('BrowserPanel.framework').path();
    const bundle = NSBundle.bundleWithPath_(path);
    if (!bundle || !bundle.load()) throw new Error('BrowserPanel.framework could not load');
    return NSClassFromString('CBStableBrowserPanel');
  } catch (error) {
    log('[BrowserPanel] ' + error);
    return null;
  }
}

function retireLegacyBrowserWindow() {
  const prefix = 'com.funkyplugins.componentbrowser.stable.';
  const oldWindow = getThreadDictionaryObject(prefix + 'window');
  const oldWebView = getThreadDictionaryObject(prefix + 'webView');
  if (oldWebView) evaluateWebScriptSafely(oldWebView, 'window.setBrowserActive && window.setBrowserActive(false);');
  setThreadDictionaryObject(prefix + 'visible', '0');
  if (oldWindow) {
    try { oldWindow.orderOut(nil); } catch (error) {}
  }
}

function createBackgroundEffectView(frameRect) {
  try {
    const effectView = NSVisualEffectView.alloc().initWithFrame(frameRect);
    effectView.setAutoresizingMask(NSViewWidthSizable | NSViewHeightSizable);

    if (typeof NSVisualEffectBlendingModeBehindWindow !== 'undefined' && effectView.setBlendingMode) {
      effectView.setBlendingMode(NSVisualEffectBlendingModeBehindWindow);
    }

    if (typeof NSVisualEffectStateActive !== 'undefined' && effectView.setState) {
      effectView.setState(NSVisualEffectStateActive);
    }

    const material =
      typeof NSVisualEffectMaterialHUDWindow !== 'undefined' ? NSVisualEffectMaterialHUDWindow :
      typeof NSVisualEffectMaterialSidebar !== 'undefined' ? NSVisualEffectMaterialSidebar :
      typeof NSVisualEffectMaterialUnderWindowBackground !== 'undefined' ? NSVisualEffectMaterialUnderWindowBackground :
      typeof NSVisualEffectMaterialAppearanceBased !== 'undefined' ? NSVisualEffectMaterialAppearanceBased :
      null;

    if (material !== null && effectView.setMaterial) {
      effectView.setMaterial(material);
    }

    return effectView;
  } catch (e) {
    log("Visual effect view unavailable: " + e);
    return null;
  }
}

function clearQueuedPreviewRequestsForWebView(webView) {
  for (let i = previewQueue.length - 1; i >= 0; i--) {
    if (!webView || previewQueue[i].webView === webView) {
      previewQueue.splice(i, 1);
    }
  }
}

function applyBrowserDocument(browserState, document) {
  if (!browserState || !document) return;

  const nextDocId = getDocumentIdentifier(document);
  if (browserState.docId && nextDocId && browserState.docId !== nextDocId) {
    browserState.libraryScanData = null;
    browserState.localSymbolCount = null;
    browserState.enabledLibraryCount = null;
    browserState.enabledLibrarySignature = null;
  }

  browserState.document = document;
  browserState.docId = nextDocId;

  setThreadDictionaryObject(LAST_DOC_ID_KEY, browserState.docId);
}

function getDocumentContentSignature(document) {
  const snapshot = document && getDocumentTurnSnapshot(document);
  if (snapshot && snapshot.signature) return snapshot.signature;
  const enabledLibraries = document ? getEnabledLibraries(document) : [];

  if (!document) {
    return {
      localSymbolCount: 0,
      enabledLibraryCount: 0,
      enabledLibrarySignature: ""
    };
  }

  return (snapshot.signature = {
    localSymbolCount: getDocumentSymbolCount(document),
    enabledLibraryCount: enabledLibraries.length,
    enabledLibrarySignature: getEnabledLibrarySignatureFromLibraries(enabledLibraries)
  });
}

function updateBrowserContentSignature(browserState, document) {
  if (!browserState || !document) return;

  const signature = getDocumentContentSignature(document);
  browserState.localSymbolCount = signature.localSymbolCount;
  browserState.enabledLibraryCount = signature.enabledLibraryCount;
  browserState.enabledLibrarySignature = signature.enabledLibrarySignature;
  browserState.localPreviewLiveRevision = getLocalPreviewLiveRevision(document);
  setThreadDictionaryObject(DOC_LOCAL_COUNT_KEY, String(signature.localSymbolCount));
  setThreadDictionaryObject(DOC_LIBRARY_COUNT_KEY, String(signature.enabledLibraryCount));
  setThreadDictionaryObject(DOC_LIBRARY_SIGNATURE_KEY, String(signature.enabledLibrarySignature));
}

function getSymbolsReloadMode(browserState, document) {
  if (!browserState || !document) return 'full';

  const signature = getDocumentContentSignature(document);
  const currentDocId = getDocumentIdentifier(document);
  if (browserState.docId !== currentDocId) {
    return 'full';
  }

  if (browserState.enabledLibraryCount !== signature.enabledLibraryCount
    || String(browserState.enabledLibrarySignature || "") !== signature.enabledLibrarySignature) {
    return 'full';
  }

  if (browserState.localSymbolCount !== signature.localSymbolCount) {
    return browserState.libraryScanData ? 'local' : 'full';
  }

  return null;
}

function setBrowserVisibility(isVisible) {
  setThreadDictionaryObject(WINDOW_VISIBLE_KEY, isVisible ? "1" : "0");
}

function isBrowserVisible() {
  return String(getThreadDictionaryObject(WINDOW_VISIBLE_KEY) || "0") === "1";
}

function getStoredCount(key) {
  const raw = getThreadDictionaryObject(key);
  if (raw === null || raw === undefined) return null;

  const value = Number(raw);
  return Number.isFinite(value) ? value : null;
}

function getStoredString(key) {
  const raw = getThreadDictionaryObject(key);
  if (raw === null || raw === undefined) return null;
  return String(raw);
}

function buildBrowserStateFromRuntime(document) {
  const webViewWindow = getThreadDictionaryObject(WINDOW_IDENTIFIER);
  const webView = getThreadDictionaryObject(WEBVIEW_IDENTIFIER);
  if (!webViewWindow || !webView) return null;

  const existingState = runtimeBrowserState;
  if (existingState && typeof existingState === 'object') {
    existingState.closed = existingState.closed === true;
    existingState.isVisible = isBrowserVisible();
    existingState.docId = String(getThreadDictionaryObject(LAST_DOC_ID_KEY) || existingState.docId || getDocumentIdentifier(document) || "");
    existingState.document = document;
    existingState.localSymbolCount = getStoredCount(DOC_LOCAL_COUNT_KEY);
    existingState.enabledLibraryCount = getStoredCount(DOC_LIBRARY_COUNT_KEY);
    existingState.enabledLibrarySignature = getStoredString(DOC_LIBRARY_SIGNATURE_KEY);
    existingState.reloadToken = Number(existingState.reloadToken || 0);
    existingState.webView = webView;
    existingState.webViewWindow = webViewWindow;
    if (!existingState.libraryScanData) {
      existingState.libraryScanData = null;
    }
    return existingState;
  }

  return {
    closed: false,
    isVisible: isBrowserVisible(),
    docId: String(getThreadDictionaryObject(LAST_DOC_ID_KEY) || getDocumentIdentifier(document) || ""),
    document: document,
    localSymbolCount: getStoredCount(DOC_LOCAL_COUNT_KEY),
    enabledLibraryCount: getStoredCount(DOC_LIBRARY_COUNT_KEY),
    enabledLibrarySignature: getStoredString(DOC_LIBRARY_SIGNATURE_KEY),
    libraryScanData: null,
    reloadToken: 0,
    webView: webView,
    webViewWindow: webViewWindow
  };
}

function syncBrowserRuntimeHandles(browserState) {
  if (!browserState) return;

  setThreadDictionaryObject(WINDOW_IDENTIFIER, browserState.webViewWindow);
  setThreadDictionaryObject(WEBVIEW_IDENTIFIER, browserState.webView);
  runtimeBrowserState = browserState;
  setBrowserVisibility(browserState.isVisible !== false);
}

function getActionDocument(browserState) {
  return getActiveDocument() || (browserState ? browserState.document : null);
}

function focusBrowserSearch(webView, selectionMode) {
  if (!webView) return;

  const mode = selectionMode || "caret";
  const focusScript = 'if (window.focusSearchInput) { window.focusSearchInput(' + JSON.stringify(mode) + '); }';
  evaluateWebScriptSafely(webView, focusScript);

  // WebView focus can be flaky right after a panel becomes key.
  setTimeout(function() {
    evaluateWebScriptSafely(webView, focusScript);
  }, 80);

  setTimeout(function() {
    evaluateWebScriptSafely(webView, focusScript);
  }, 220);
}

function getBrowserWebView(browserState, webViewWindow) {
  if (browserState && browserState.webView) {
    return browserState.webView;
  }

  if (!webViewWindow || !webViewWindow.contentView) return null;

  try {
    const subviews = webViewWindow.contentView().subviews();
    if (!subviews || !subviews.count) return null;

    for (let i = subviews.count() - 1; i >= 0; i--) {
      const view = subviews.objectAtIndex(i);
      if (view && String(view.className && view.className()) === 'WebView') {
        return view;
      }
    }

    return subviews.lastObject ? subviews.lastObject() : null;
  } catch (e) {
    return null;
  }
}

function hideBrowserWindow(browserState, animated) {
  if (!browserState || browserState.closed) return;

  browserState.isVisible = false;
  setBrowserVisibility(false);
  setPreviewAgentBusy(false);
  clearQueuedPreviewRequestsForWebView(browserState.webView);
  evaluateWebScriptSafely(browserState.webView,
    'if (window.setBrowserActive) { window.setBrowserActive(false); }');

  const webViewWindow = browserState.webViewWindow || getThreadDictionaryObject(WINDOW_IDENTIFIER);
  if (webViewWindow) {
    try {
      if (animated) webViewWindow.fadeOut();
      else webViewWindow.orderOut(nil);
    } catch (e) {}
  }
}

function destroyBrowserWindow(browserState) {
  if (!browserState || browserState.closed) return;

  browserState.closed = true;
  browserState.isVisible = false;
  setBrowserVisibility(false);
  setPreviewAgentBusy(false);
  clearQueuedPreviewRequestsForWebView(browserState.webView);

  const threadDictionary = NSThread.mainThread().threadDictionary();
  const webViewWindow = browserState.webViewWindow || getThreadDictionaryObject(WINDOW_IDENTIFIER);
  if (webViewWindow) {
    try {
      webViewWindow.close();
    } catch (e) {}
  }

  try {
    if (COScript.currentCOScript()) {
      COScript.currentCOScript().setShouldKeepAround(false);
    }
  } catch (e) {}

  threadDictionary.removeObjectForKey(WINDOW_IDENTIFIER);
  threadDictionary.removeObjectForKey(WEBVIEW_IDENTIFIER);
  threadDictionary.removeObjectForKey(DELEGATE_IDENTIFIER);
  threadDictionary.removeObjectForKey(LAST_DOC_ID_KEY);
  threadDictionary.removeObjectForKey(WINDOW_VISIBLE_KEY);
  threadDictionary.removeObjectForKey(DOC_LOCAL_COUNT_KEY);
  threadDictionary.removeObjectForKey(DOC_LIBRARY_COUNT_KEY);
  threadDictionary.removeObjectForKey(DOC_LIBRARY_SIGNATURE_KEY);
  runtimeBrowserState = null;
}

function loadSymbolsIntoBrowser(browserState, options) {
  if (!browserState || browserState.closed || !browserState.document) return;

  const settings = options || {};
  const showLoader = settings.showLoader !== false;
  const forceRefresh = settings.forceRefresh === true;
  const requestedReloadMode = settings.reloadMode || 'full';
  const preserveCurrentContents = settings.preserveCurrentContents === true;
  const reloadToken = ++browserState.reloadToken;
  const expectedDocId = browserState.docId;
  const document = browserState.document;
  const webView = browserState.webView;
  const savedUiStateJson = getSavedUiState(document) || 'null';
  const scanConfig = showLoader || preserveCurrentContents ? {
    symbolBatchSize: RESPONSIVE_SYMBOL_SCAN_BATCH_SIZE,
    libraryBatchSize: RESPONSIVE_SYMBOL_SCAN_LIBRARY_BATCH_SIZE
  } : {
    symbolBatchSize: SYMBOL_SCAN_BATCH_SIZE,
    libraryBatchSize: SYMBOL_SCAN_LIBRARY_BATCH_SIZE
  };

  clearQueuedPreviewRequestsForWebView(webView);
  invalidateSymbolLookupCache();

  if (showLoader && !preserveCurrentContents) {
    evaluateWebScriptSafely(webView, 'window.setLoading(true);');
  }

  const cachedSymbolsJson = forceRefresh ? null : getCachedSymbolsJson(document);
  if (cachedSymbolsJson) {
    if (!browserState.closed && browserState.reloadToken === reloadToken && browserState.docId === expectedDocId) {
      if (preserveCurrentContents && requestedReloadMode !== 'full') {
        updateBrowserContentSignature(browserState, document);
        log("Kept current UI after cache validation");
        deferPreviewAgentQueueFromSymbolsJson(cachedSymbolsJson, document, browserState, reloadToken, expectedDocId);
        return;
      }

      updateBrowserContentSignature(browserState, document);
      setTimeout(function() {
        if (browserState.closed || browserState.reloadToken !== reloadToken || browserState.docId !== expectedDocId) return;
        evaluateWebScriptSafely(webView, 'window.loadSymbols(' + cachedSymbolsJson + ', ' + savedUiStateJson + ', ' + JSON.stringify(expectedDocId) + ');');
      }, 8);
      log("Loaded symbols from cache");
      deferPreviewAgentQueueFromSymbolsJson(cachedSymbolsJson, document, browserState, reloadToken, expectedDocId);
    }
    return;
  }

  const startScan = function() {
    const shouldContinue = function() {
      return !browserState.closed
        && browserState.reloadToken === reloadToken
        && browserState.docId === expectedDocId;
    };

    if (requestedReloadMode === 'local' && browserState.libraryScanData) {
      getSymbolsJsonFromLocalChangesAsync(
        document,
        browserState.libraryScanData,
        function(resultSymbolsJson, resultSymbolCount) {
          if (browserState.closed || browserState.reloadToken !== reloadToken || browserState.docId !== expectedDocId) {
            return;
          }

          onSymbolsScanned(resultSymbolsJson, resultSymbolCount);
        },
        shouldContinue,
        scanConfig
      );
      return;
    }

    getSymbolsJsonAsync(
      document,
      function(resultSymbolsJson, resultSymbolCount, resultLibraryScanData) {
        if (browserState.closed || browserState.reloadToken !== reloadToken || browserState.docId !== expectedDocId) {
          return;
        }

        browserState.libraryScanData = resultLibraryScanData || null;
        onSymbolsScanned(resultSymbolsJson, resultSymbolCount);
      },
      shouldContinue,
      scanConfig
    );
  };

  function onSymbolsScanned(symbolsJson, symbolCount) {
    log("Found " + symbolCount + " components");

    if (!symbolsJson || symbolsJson === "[]") {
      evaluateWebScriptSafely(webView, 'window.setLoading(false); window.loadSymbols([], ' + savedUiStateJson + ', ' + JSON.stringify(expectedDocId) + ');');
      UI.message("❌ No components found");
      return;
    }

    // Strip previews once and persist only lean metadata. Thumbnails remain in
    // the durable PNG cache and are loaded from disk as rows become visible.
    const lean = stripPreviewsFromSymbolsJson(symbolsJson);
    browserState.localFingerprint = setCachedSymbolsJson(document, lean);
    updateBrowserContentSignature(browserState, document);
    evaluateWebScriptSafely(webView, 'window.loadSymbols(' + lean + ', ' + savedUiStateJson + ', ' + JSON.stringify(expectedDocId) + ');');
    deferPreviewAgentQueueFromSymbolsJson(lean, document, browserState, reloadToken, expectedDocId);
  }

  if (showLoader) {
    setTimeout(startScan, RESPONSIVE_SCAN_START_DELAY_MS);
  } else {
    startScan();
  }
}

function startDocumentSwitchWatcher(browserState) {
  if (!browserState || browserState.closed) return;

  function tick() {
    if (!browserState || browserState.closed) {
      return;
    }

    if (!isBrowserVisible()) {
      setTimeout(tick, DOCUMENT_WATCH_INTERVAL_MS);
      return;
    }

    const activeDocument = getActiveDocument();
    const activeDocId = getDocumentIdentifier(activeDocument);

    if (activeDocument && activeDocId && activeDocId !== browserState.docId) {
      log("Active document switched, reloading component list");
      applyBrowserDocument(browserState, activeDocument);
      loadSymbolsIntoBrowser(browserState, { showLoader: true });
    }

    setTimeout(tick, DOCUMENT_WATCH_INTERVAL_MS);
  }

  setTimeout(tick, DOCUMENT_WATCH_INTERVAL_MS);
}

function onRun(context) {
  log("=== Component Browser Started ===");
  retireLegacyBrowserWindow();
  cancelStartupPreviewPrewarm();

  // Bootstrap the hotkey agent if Sketch's Startup action hasn't fired yet
  // (e.g. just-installed plugin). Subsequent restarts fire onStartup directly.
  hotkeyContext = context;
  setPreviewAgentBusy(true);
  const threadDictionary = NSThread.mainThread().threadDictionary();

  // Get document first (needed for document change detection)
  const document = getActiveDocument();
  if (!document) {
    UI.message("❌ No document open");
    return;
  }
  
  // Get current document ID (extract UUID from sketchObject)
  const currentDocId = getDocumentIdentifier(document);
  
  const existingWindow = getThreadDictionaryObject(WINDOW_IDENTIFIER);
  runtimeBrowserState = buildBrowserStateFromRuntime(document);

  if (existingWindow && runtimeBrowserState && !runtimeBrowserState.closed) {
    const isDifferentDocument = runtimeBrowserState.docId !== currentDocId;
    const foregroundOpenToken = Number(runtimeBrowserState.foregroundOpenToken || 0) + 1;
    runtimeBrowserState.foregroundOpenToken = foregroundOpenToken;

    // Always reuse the existing WebView when one is around — even on a doc
    // switch with the window hidden. Destroying + recreating costs an HTML
    // reload and a full JS init (hundreds of ms) just to get back to the
    // same UI; reusing only needs an evaluateWebScript call to push the
    // new symbol list.
    if (isDifferentDocument) {
      log("Document changed, reusing browser window (was " + (runtimeBrowserState.isVisible ? "visible" : "hidden") + ")");
      applyBrowserDocument(runtimeBrowserState, document);
      evaluateWebScriptSafely(runtimeBrowserState.webView, 'window.setLoading(true);');
    }

    evaluateWebScriptSafely(runtimeBrowserState.webView,
      'window.setComponentCount(' + JSON.stringify(getReadyComponentCount(document)) + ');');

    runtimeBrowserState.isVisible = true;
    setBrowserVisibility(true);
    setPreviewAgentBusy(true);
    existingWindow.setAlphaValue_(0);
    existingWindow.fadeIn();
    existingWindow.makeKeyAndOrderFront(nil);
    const webView = getBrowserWebView(runtimeBrowserState, existingWindow);
    if (webView) {
      try {
        existingWindow.makeFirstResponder(webView);
      } catch (e) {}
      focusBrowserSearch(webView, 'select-existing');
      evaluateWebScriptSafely(webView,
        'if (window.setBrowserActive) { window.setBrowserActive(true); }');
      evaluateWebScriptSafely(webView,
        "window.applyUpdateNotice && window.applyUpdateNotice("
        + JSON.stringify(UPDATE_NOTICE_VERSION) + ","
        + (shouldShowUpdateNotice() ? "true" : "false") + ");");
      // If the user invoked the Settings menu while the window already
      // existed, ask the UI to switch into settings mode AND push the latest
      // stored hotkey so the display is always in sync.
      if (nextLaunchMode === 'settings') {
        const hkNow = getStoredHotkey();
        evaluateWebScriptSafely(webView,
          'if (window.enterSettingsMode) { window.enterSettingsMode(); }' +
          'if (window.applyCurrentHotkey) { window.applyCurrentHotkey(' + hkNow.keyCode + ',' + hkNow.modifiers + '); }');
        nextLaunchMode = null;
      } else {
        evaluateWebScriptSafely(webView, 'if (window.enterBrowserMode) { window.enterBrowserMode(); }');
      }
      evaluateWebScriptSafely(webView, 'if (window.requestPreviewsForVisibleItems) { window.requestPreviewsForVisibleItems(); }');
    } else {
      log("Window already open, bringing to front");
    }

    // Freshness checks walk every local component and query Sketch's enabled
    // libraries. Let the panel render and finish its entrance first so the
    // first visible response is immediate, then validate in the background.
    setTimeout(function() {
      if (runtimeBrowserState.closed || !runtimeBrowserState.isVisible
        || runtimeBrowserState.foregroundOpenToken !== foregroundOpenToken) return;
      const activeDocument = getActiveDocument();
      if (!activeDocument || getDocumentIdentifier(activeDocument) !== currentDocId) return;
      const reloadMode = isDifferentDocument ? 'full' : getSymbolsReloadMode(runtimeBrowserState, document);
      let localFingerprintChanged = false;
      if (!reloadMode) {
        try {
          const liveFp = getLocalSymbolsFingerprint(document);
          if (runtimeBrowserState.localFingerprint !== liveFp) {
            runtimeBrowserState.localFingerprint = liveFp;
            localFingerprintChanged = true;
          }
        } catch (e) {}
      }

      if (reloadMode || localFingerprintChanged) {
        loadSymbolsIntoBrowser(runtimeBrowserState, {
          showLoader: isDifferentDocument,
          preserveCurrentContents: !isDifferentDocument,
          reloadMode: localFingerprintChanged ? 'local' : reloadMode
        });
      } else if (runtimeBrowserState.localPreviewLiveRevision !== getLocalPreviewLiveRevision(document)) {
        const currentSymbolsJson = getCachedSymbolsJson(document);
        if (currentSymbolsJson) {
          deferPreviewAgentQueueFromSymbolsJson(currentSymbolsJson, document, runtimeBrowserState,
            runtimeBrowserState.reloadToken, currentDocId);
        }
      }
    }, INITIAL_BROWSER_WORK_DELAY_MS);

    // Startup actions normally initialize the agents before the user invokes
    // the hotkey. Keep the first-run fallback off the visible-window path too.
    setTimeout(function() {
      if (!hotkeyAgent) setupHotkeyAgent(context);
      if (!previewAgent) setupPreviewAgent(context);
      setPreviewAgentBusy(true);
    }, INITIAL_BROWSER_WORK_DELAY_MS);
    return;
  }

  if (existingWindow && (!runtimeBrowserState || !runtimeBrowserState.closed)) {
    try {
      existingWindow.close();
    } catch (e) {}
    threadDictionary.removeObjectForKey(WINDOW_IDENTIFIER);
    threadDictionary.removeObjectForKey(WEBVIEW_IDENTIFIER);
    threadDictionary.removeObjectForKey(DELEGATE_IDENTIFIER);
    threadDictionary.removeObjectForKey(LAST_DOC_ID_KEY);
    threadDictionary.removeObjectForKey(WINDOW_VISIBLE_KEY);
    threadDictionary.removeObjectForKey(DOC_LOCAL_COUNT_KEY);
    threadDictionary.removeObjectForKey(DOC_LIBRARY_COUNT_KEY);
    threadDictionary.removeObjectForKey(DOC_LIBRARY_SIGNATURE_KEY);
    runtimeBrowserState = null;
  }

  // Show window immediately with loading state
  // Symbols will be loaded asynchronously

  const panelClass = loadBrowserPanelClass(context);
  if (!panelClass) {
    UI.message('Component Browser could not load its window framework');
    return;
  }
  let initialSavedState = {};
  try { initialSavedState = JSON.parse(getSavedUiState(document) || '{}') || {}; } catch (error) {}
  const initialExpanded = nextLaunchMode === 'settings' || shouldShowUpdateNotice()
    || !!String(initialSavedState.query || '').trim();
  const windowWidth = 701, windowHeight = initialExpanded ? 490 : 64;
  const webViewWindow = panelClass.browserPanel();
  webViewWindow.setPresentationExpanded_animated_(initialExpanded, false);
  webViewWindow.setPreferredAppearance_(getBrowserPreferences().appearance);

  webViewWindow.becomeKeyWindow();
  webViewWindow.setLevel(NSFloatingWindowLevel);
  setThreadDictionaryObject(WINDOW_IDENTIFIER, webViewWindow);
  setThreadDictionaryObject(LAST_DOC_ID_KEY, currentDocId);
  COScript.currentCOScript().setShouldKeepAround_(true);

  const scriptFolder = context.scriptURL.URLByDeletingLastPathComponent();
  const htmlUrl = scriptFolder.URLByAppendingPathComponent("symbol-browser-ui.html");
  const htmlData = NSData.dataWithContentsOfURL(htmlUrl);
  let html = String(NSString.alloc().initWithData_encoding(htmlData, NSUTF8StringEncoding));
  // Legacy WebView caches local stylesheets across document reloads. Read the
  // bundled CSS into this document so installed updates cannot reuse old rules.
  const cssUrl = scriptFolder.URLByAppendingPathComponent('browser-redesign.css');
  const cssData = NSData.dataWithContentsOfURL(cssUrl);
  if (cssData) {
    const css = String(NSString.alloc().initWithData_encoding(cssData, NSUTF8StringEncoding));
    html = html.replace('<link rel="stylesheet" href="browser-redesign.css">', function() {
      return '<style id="browser-redesign-styles">' + css + '</style>';
    });
  }
  const contentView = webViewWindow.contentView();

  let injectScript = '';
  if (nextLaunchMode) {
    injectScript += 'window.INITIAL_MODE = ' + JSON.stringify(nextLaunchMode) + ';';
    log("[Init] injected INITIAL_MODE=" + nextLaunchMode);
    nextLaunchMode = null;
  }
  // Inject the stored hotkey so the Settings UI can render it without an
  // alert→evaluateWebScript round-trip. The round-trip can race against the
  // WebView's JS engine still being paused inside the alert delegate, which
  // is why the display sometimes stuck on the HTML's hardcoded ⌘;.
  {
    const initialHk = getStoredHotkey();
    injectScript += 'window.INITIAL_HOTKEY = ' + JSON.stringify(initialHk) + ';';
  }
  injectScript += 'window.INITIAL_PREFERENCES = ' + JSON.stringify(getBrowserPreferences()) + ';';
  injectScript += 'window.INITIAL_DOCUMENT_ID = ' + JSON.stringify(currentDocId) + ';';
  const initialComponentCount = getReadyComponentCount(document);
  injectScript += 'window.INITIAL_COMPONENT_COUNT = ' + JSON.stringify(initialComponentCount) + ';';
  if (initialComponentCount !== null) {
    html = html.replace('placeholder="Search components..."',
      'placeholder="Search by ' + initialComponentCount + ' components..."');
  }
  injectScript += 'window.NATIVE_WINDOW_ANIMATIONS = true;';
  injectScript += 'window.UPDATE_NOTICE = ' + JSON.stringify({
    version: UPDATE_NOTICE_VERSION,
    visible: shouldShowUpdateNotice()
  }) + ';';
  if (injectScript) {
    const initScript = '<script>' + injectScript + '</script>';
    if (html.indexOf('</head>') !== -1) {
      html = html.replace('</head>', initScript + '</head>');
    } else {
      html = initScript + html;
    }
  }

  // WebView covers entire window including titlebar area
  const webView = WebView.alloc().initWithFrame(NSMakeRect(0, 0, windowWidth, windowHeight));
  webView.setDrawsBackground(false);
  webView.setAutoresizingMask(NSViewWidthSizable | NSViewHeightSizable);
  const browserState = {
    closed: false,
    isVisible: true,
    docId: currentDocId,
    document: document,
    localSymbolCount: null,
    enabledLibraryCount: null,
    enabledLibrarySignature: null,
    libraryScanData: null,
    reloadToken: 0,
    foregroundOpenToken: 1,
    webView: webView,
    webViewWindow: webViewWindow,
    // Calculated after the first frame, so large documents do not delay show.
    localFingerprint: null
  };
  syncBrowserRuntimeHandles(browserState);
  applyBrowserDocument(browserState, document);

  const effectView = createBackgroundEffectView(NSMakeRect(0, 0, windowWidth, windowHeight));
  if (effectView) {
    contentView.addSubview(effectView);
  }

  const delegate = new MochaJSDelegate({
    "webView:runJavaScriptAlertPanelWithMessage:initiatedByFrame:": function(webView, message, frame) {
      const bridgeMessage = String(message || '');
      if (bridgeMessage.startsWith('insert-symbol:')) {
        try {
          const symbolId = bridgeMessage.substring(14);
          const activeDocument = getActionDocument(browserState);
          if (!activeDocument) return;
          insertSymbol(symbolId, activeDocument, false, null, false);
        } catch (e) {
          log("ERROR: " + e);
          UI.message("❌ Error: " + e.message);
        }
      } else if (bridgeMessage.startsWith('goto-symbol:')) {
        try {
          const symbolId = bridgeMessage.substring(12);
          const activeDocument = getActionDocument(browserState);
          if (!activeDocument) return;
          gotoSymbolSource(symbolId, activeDocument, browserState);
        } catch (e) {
          log("[Goto] error: " + e);
          UI.message("❌ Could not navigate: " + e.message);
        }
      } else if (bridgeMessage.startsWith('replace-symbol:')) {
        try {
          // Parse: replace-symbol:SYMBOL_ID:preserve or replace-symbol:SYMBOL_ID:original
          const parts = bridgeMessage.substring(15).split(':');
          const symbolId = parts[0];
          const preserveDims = parts[1] === 'preserve';
          const activeDocument = getActionDocument(browserState);
          if (!activeDocument) return;
          // Get ALL CURRENT selected layers (not cached) for replacement
          const currentSelection = activeDocument.selectedLayers.layers;
          insertSymbol(symbolId, activeDocument, true, currentSelection, preserveDims);
        } catch (e) {
          log("ERROR: " + e);
          UI.message("❌ Error: " + e.message);
        }
      } else if (bridgeMessage.startsWith('browser-presentation:')) {
        const parts = bridgeMessage.split(':');
        if (['compact', 'results', 'settings'].indexOf(parts[1]) < 0) return;
        clearQueuedPreviewRequestsForWebView(webView);
        setTimeout(function() {
          webViewWindow.setPresentationExpanded_animated_(parts[1] !== 'compact', parts[2] === '1');
        }, 0);
      } else if (bridgeMessage.startsWith('browser-preferences:')) {
        try {
          const requested = JSON.parse(decodeURIComponent(bridgeMessage.substring(20)));
          const preferences = {
            appearance: ['light', 'dark', 'auto'].indexOf(requested.appearance) >= 0 ? requested.appearance : 'auto'
          };
          Settings.setSettingForKey(BROWSER_PREFERENCES_KEY, preferences);
          webViewWindow.setPreferredAppearance_(preferences.appearance);
        } catch (error) { log('[BrowserPreferences] ' + error); }
      } else if (bridgeMessage.startsWith('drag-window:')) {
        // Handle window dragging
        const parts = bridgeMessage.substring(12).split(':');
        const dx = parseFloat(parts[0]);
        const dy = parseFloat(parts[1]);
        const frame = webViewWindow.frame();
        webViewWindow.setFrame_display(NSMakeRect(frame.origin.x + dx, frame.origin.y - dy, frame.size.width, frame.size.height), true);
      } else if (bridgeMessage === 'finish-window-transition') {
        if (webViewWindow && webViewWindow.finishPresentationTransition) {
          webViewWindow.finishPresentationTransition();
        }
      } else if (bridgeMessage.startsWith('get-preview-priority:')) {
        const request = parsePreviewRequestPayload(bridgeMessage.substring(21));
        const symbolId = request.id;
        const previewDocument = browserState.document;
        if (!previewDocument || !symbolId) return;
        verbosePreviewLog("Priority preview requested for: " + symbolId);
        queuePreviewRequest(symbolId, previewDocument, webView, true, browserState, request);
      } else if (bridgeMessage.startsWith('get-preview:')) {
        // Render only the requested row; the UI asks for additional rows while idle.
        const request = parsePreviewRequestPayload(bridgeMessage.substring(12));
        const symbolId = request.id;
        const previewDocument = browserState.document;
        if (!previewDocument || !symbolId) return;
        verbosePreviewLog("Preview requested for: " + symbolId);
        queuePreviewRequest(symbolId, previewDocument, webView, false, browserState, request);
      } else if (bridgeMessage.startsWith('close-browser-animated:')) {
        try {
          const stateDocument = browserState.document;
          if (stateDocument) {
            const payload = bridgeMessage.substring('close-browser-animated:'.length);
            setSavedUiState(stateDocument, decodeURIComponent(payload));
          }
        } catch (e) {}
        setTimeout(function() {
          hideBrowserWindow(browserState, true);
        }, 0);
      } else if (bridgeMessage.startsWith('close-browser:')) {
        try {
          const stateDocument = browserState.document;
          if (stateDocument) {
            setSavedUiState(stateDocument, decodeURIComponent(bridgeMessage.substring(14)));
          }
        } catch (e) {}
        setTimeout(function() {
          hideBrowserWindow(browserState);
        }, 0);
      } else if (bridgeMessage.startsWith('save-ui-state:')) {
        const stateDocument = browserState.document;
        if (stateDocument) {
          setSavedUiState(stateDocument, decodeURIComponent(bridgeMessage.substring(14)));
        }
      } else if (bridgeMessage.startsWith('dismiss-update-notice:')) {
        dismissUpdateNotice(bridgeMessage.substring(22));
      } else if (bridgeMessage === 'close') {
        setTimeout(function() {
          hideBrowserWindow(browserState);
        }, 0);
      } else if (bridgeMessage.startsWith('set-hotkey:')) {
        // Payload: "keyCode,modifiers" (e.g. "11,2304")
        try {
          const payload = bridgeMessage.substring(11);
          const parts = payload.split(',');
          const keyCode = parseInt(parts[0], 10);
          const modifiers = parseInt(parts[1], 10);
          if (Number.isFinite(keyCode) && Number.isFinite(modifiers)) {
            handleRecordedHotkey(keyCode, modifiers);
          }
        } catch (e) {
          log("[HotkeyAgent] set-hotkey parse error: " + e);
        }
      } else if (bridgeMessage === 'reset-hotkey') {
        storeHotkey(DEFAULT_HOTKEY);
        reRegisterHotkey(DEFAULT_HOTKEY);
        // Push new value to UI so the displayed shortcut updates immediately.
        evaluateWebScriptSafely(browserState.webView,
          "window.applyCurrentHotkey && window.applyCurrentHotkey("
          + DEFAULT_HOTKEY.keyCode + "," + DEFAULT_HOTKEY.modifiers + ");");
        UI.message("Shortcut reset to default");
      } else if (bridgeMessage === 'request-hotkey') {
        // UI asks for the current binding to display.
        const hk = getStoredHotkey();
        evaluateWebScriptSafely(browserState.webView,
          "window.applyCurrentHotkey && window.applyCurrentHotkey(" + hk.keyCode + "," + hk.modifiers + ");");
      } else if (bridgeMessage === 'start-hotkey-recording' || bridgeMessage === 'pause-hotkey') {
        // Reuse the shared Startup agent. Module globals are per Sketch plugin
        // invocation, so a command-local instance can be a failed duplicate;
        // pausing only that duplicate leaves the real shortcut active.
        hotkeyAgent = hotkeyAgent || getThreadDictionaryObject(HOTKEY_AGENT_INSTANCE_KEY);
        hotkeyDelegate = hotkeyDelegate || getThreadDictionaryObject(HOTKEY_AGENT_DELEGATE_KEY);
        if (hotkeyAgent) {
          try {
            hotkeyAgent.unregister();
            if (hotkeyAgent.beginRecording) hotkeyAgent.beginRecording();
            log("[HotkeyAgent] paused; native recorder started");
          } catch (e) {
            log("[HotkeyAgent] recorder start failed: " + e);
          }
        } else {
          log("[HotkeyAgent] recorder start failed: no shared agent");
        }
      } else if (bridgeMessage === 'resume-hotkey') {
        // UI exited record mode without saving — re-register the stored
        // binding. (Successful record sends set-hotkey, which re-registers
        // on its own.)
        hotkeyAgent = hotkeyAgent || getThreadDictionaryObject(HOTKEY_AGENT_INSTANCE_KEY);
        if (hotkeyAgent && hotkeyAgent.endRecording) hotkeyAgent.endRecording();
        const hk = getStoredHotkey();
        reRegisterHotkey(hk);
      }
    }
  });

  setThreadDictionaryObject(DELEGATE_IDENTIFIER, delegate);
  webView.setUIDelegate_(delegate.getClassInstance());
  webView.mainFrame().loadHTMLString_baseURL(html, scriptFolder);

  contentView.addSubview(webView);
  webViewWindow.center();
  webViewWindow.setAlphaValue_(0);
  webViewWindow.fadeIn();
  webViewWindow.makeKeyAndOrderFront(nil);
  
  // Make webView first responder for keyboard input
  webViewWindow.makeFirstResponder(webView);

  // Focus immediately, then perform Sketch's document/library API work after
  // the panel's first paint and entrance animation.
  focusBrowserSearch(webView, 'smart');
  setTimeout(function() {
    if (browserState.closed || !browserState.isVisible) return;
    const activeDocument = getActiveDocument();
    if (!activeDocument || getDocumentIdentifier(activeDocument) !== currentDocId) return;
    loadSymbolsIntoBrowser(browserState, {
      showLoader: true,
      preserveCurrentContents: true
    });
  }, INITIAL_BROWSER_WORK_DELAY_MS);

  setTimeout(function() {
    if (!hotkeyAgent) setupHotkeyAgent(context);
    if (!previewAgent) setupPreviewAgent(context);
    setPreviewAgentBusy(true);
  }, INITIAL_BROWSER_WORK_DELAY_MS);

  startDocumentSwitchWatcher(browserState);

}

function getSymbolsJsonAsync(document, callback, shouldContinue, scanConfig) {
  const enabledLibraries = getEnabledLibraries(document);
  const localSymbols = getDocumentSymbolMetadata(document);
  const symbols = [];
  const existingSymbolNames = new Set();
  // Also track ids that the document already covers (live import or unlinked-
  // local with the same id as a library entry). The library scan dedups by
  // BOTH name and id so we don't double-list a symbol after the user unlinked
  // and renamed it (Sketch keeps the original library id on the new local).
  const existingSymbolIds = new Set();
  const librarySymbolMap = {};
  const libraryRefById = {};
  const libraryBySymbolName = {};
  const libraryRefsByLibraryId = {};
  const libraryRefsLoadedById = {};
  const libraryEntries = [];
  const effectiveScanConfig = scanConfig || {};
  const symbolBatchSize = Math.max(1, Number(effectiveScanConfig.symbolBatchSize) || SYMBOL_SCAN_BATCH_SIZE);
  const libraryBatchSize = Math.max(1, Number(effectiveScanConfig.libraryBatchSize) || SYMBOL_SCAN_LIBRARY_BATCH_SIZE);

  let libraryIndex = 0;

  function isCancelled() {
    return typeof shouldContinue === 'function' && !shouldContinue();
  }

  function finish() {
    if (isCancelled()) {
      return;
    }

    symbols.sort(function(a, b) {
      return a.name.localeCompare(b.name);
    });

    symbolLookupCache.docId = getDocumentIdentifier(document);
    symbolLookupCache.localById = createLazyLocalSymbolLookup(localSymbols);
    symbolLookupCache.libraryRefById = libraryRefById;
    const libraryIdsByComponentId = {};
    Object.keys(librarySymbolMap).forEach(function(id) {
      const entry = librarySymbolMap[id];
      if (entry && entry.library !== null && entry.library !== undefined) {
        libraryIdsByComponentId[String(id)] = String(entry.library);
      }
    });
    symbolLookupCache.libraryIdById = libraryIdsByComponentId;
    symbolLookupCache.libraryRefsLoadedById = libraryRefsLoadedById;

    log("Collected " + symbols.length + " symbols from " + localSymbols.length + " local symbols and " + enabledLibraries.length + " libraries");
    callback(JSON.stringify(symbols), symbols.length, {
      enabledLibrarySignature: getEnabledLibrarySignatureFromLibraries(enabledLibraries),
      libraryEntries: libraryEntries,
      librarySymbolMap: librarySymbolMap,
      libraryBySymbolName: libraryBySymbolName,
      libraryRefById: libraryRefById,
      libraryRefsLoadedById: libraryRefsLoadedById
    });
  }

  function processLibraryOnlySymbolsBatch(startLibraryIndex, startRefIndex) {
    if (isCancelled()) {
      return;
    }

    let currentLibraryIndex = startLibraryIndex;
    let currentRefIndex = startRefIndex;
    let processed = 0;

    while (currentLibraryIndex < enabledLibraries.length) {
      const library = enabledLibraries[currentLibraryIndex];
      const refs = libraryRefsByLibraryId[getLibraryCacheKey(library)] || [];

      while (currentRefIndex < refs.length) {
        const ref = refs[currentRefIndex];
        const refIdStr = String(ref.id);
        // Dedup by both id and name. Id catches the unlinked-renamed case
        // (library id matches a local that's been renamed); name catches
        // imports with a fresh local id but same name.
        if (!existingSymbolIds.has(refIdStr) && !existingSymbolNames.has(ref.name)) {
          symbols.push({
            id: ref.id,
            name: ref.name,
            library: library.id,
            libraryName: library.name,
            isOriginallyLocal: false,
            colorIndex: (symbols.length + currentRefIndex) % 10,
            preview: getCachedPreview(ref.id)
          });
        }

        currentRefIndex += 1;
        processed += 1;
        if (processed >= symbolBatchSize) {
          setTimeout(function() {
            processLibraryOnlySymbolsBatch(currentLibraryIndex, currentRefIndex);
          }, 0);
          return;
        }
      }

      currentLibraryIndex += 1;
      currentRefIndex = 0;
    }

    finish();
  }

  function processLocalSymbolsBatch(startIndex) {
    if (isCancelled()) {
      return;
    }

    const endIndex = Math.min(startIndex + symbolBatchSize, localSymbols.length);

    for (let i = startIndex; i < endIndex; i++) {
      const symbolMaster = sketch.fromNative(localSymbols[i].sketchObject);
      const symbolName = symbolMaster.name;
      const localIdStr = String(symbolMaster.id);
      existingSymbolNames.add(symbolName);
      existingSymbolIds.add(localIdStr);

      // Sketch knows whether this master is a live foreign (library) import or
      // a real local. Trust it — much more reliable than id/name overlap
      // heuristics which break in both directions (unlinked masters keep the
      // original library id, distinct symbols sometimes share a name).
      const foreignStatus = isSymbolMasterForeign(symbolMaster);

      if (foreignStatus === false) {
        verboseSymbolScanLog("DOC truly local (isForeign=false): " + symbolName);
        symbols.push({
          id: symbolMaster.id,
          name: symbolName,
          library: null,
          libraryName: 'Local',
          isOriginallyLocal: true,
          colorIndex: i % 10,
          preview: getCachedPreview(symbolMaster.id)
        });
        continue;
      }

      if (foreignStatus === true) {
        // Live import — classify under its source library. Match by id first
        // (the local master's id usually matches a library ref), fall back to
        // name match if the library wasn't enumerated for some reason.
        const libInfoById = librarySymbolMap[symbolMaster.id];
        const sourceLib = libInfoById || libraryBySymbolName[symbolName];
        const libraryId = libInfoById ? libInfoById.library : (sourceLib ? sourceLib.id : null);
        const libraryName = libInfoById ? libInfoById.libraryName : (sourceLib ? sourceLib.name : 'Library');
        verboseSymbolScanLog("DOC live foreign import: " + symbolName + " -> " + libraryName);
        symbols.push({
          id: symbolMaster.id,
          name: symbolName,
          library: libraryId,
          libraryName: libraryName,
          isOriginallyLocal: false,
          colorIndex: i % 10,
          preview: getCachedPreview(symbolMaster.id)
        });
        continue;
      }

      // foreignStatus === null: API unavailable, fall back to the previous
      // id/name heuristic so we still handle the unlink+rename case.
      const libInfoById = librarySymbolMap[symbolMaster.id];
      if (libInfoById) {
        if (libInfoById.name === symbolName) {
          symbols.push({
            id: symbolMaster.id,
            name: symbolName,
            library: libInfoById.library,
            libraryName: libInfoById.libraryName,
            isOriginallyLocal: false,
            colorIndex: i % 10,
            preview: getCachedPreview(symbolMaster.id)
          });
        } else {
          symbols.push({
            id: symbolMaster.id,
            name: symbolName,
            library: null,
            libraryName: 'Local',
            isOriginallyLocal: true,
            colorIndex: i % 10,
            preview: getCachedPreview(symbolMaster.id)
          });
        }
        continue;
      }

      const sourceLibrary = libraryBySymbolName[symbolName];
      if (sourceLibrary) {
        symbols.push({
          id: symbolMaster.id,
          name: symbolName,
          library: sourceLibrary.id,
          libraryName: sourceLibrary.name,
          isOriginallyLocal: false,
          colorIndex: i % 10,
          preview: getCachedPreview(symbolMaster.id)
        });
      } else {
        symbols.push({
          id: symbolMaster.id,
          name: symbolName,
          library: null,
          libraryName: 'Local',
          isOriginallyLocal: true,
          colorIndex: i % 10,
          preview: getCachedPreview(symbolMaster.id)
        });
      }
    }

    if (endIndex < localSymbols.length) {
      setTimeout(function() {
        processLocalSymbolsBatch(endIndex);
      }, 0);
      return;
    }

    processLibraryOnlySymbolsBatch(0, 0);
  }

  function processLibraryBatch() {
    if (isCancelled()) {
      return;
    }

    let processedLibraries = 0;

    while (libraryIndex < enabledLibraries.length && processedLibraries < libraryBatchSize) {
      const library = enabledLibraries[libraryIndex];

      // Persistent list metadata avoids enumerating live references here.
      // Live references are resolved only when a requested component needs a
      // fresh render.
      const cachedLib = getCachedLibrarySymbols(library);
      if (cachedLib) {
        const leanRefs = cachedLib.symbols;
        libraryRefsByLibraryId[getLibraryCacheKey(library)] = leanRefs;
        leanRefs.forEach(function(meta) {
          if (!libraryBySymbolName[meta.name]) {
            libraryBySymbolName[meta.name] = { id: library.id, name: library.name };
          }
          librarySymbolMap[meta.id] = { library: library.id, libraryName: library.name, name: meta.name };
          libraryEntries.push({
            id: meta.id,
            name: meta.name,
            library: library.id,
            libraryName: library.name,
            isOriginallyLocal: false
          });
        });
      } else {
        try {
          const refs = library.getImportableSymbolReferencesForDocument(document);
          libraryRefsByLibraryId[getLibraryCacheKey(library)] = refs;
          libraryRefsLoadedById[String(library.id || '')] = true;
          const leanForCache = [];
          refs.forEach(function(ref) {
            if (!libraryBySymbolName[ref.name]) {
              libraryBySymbolName[ref.name] = { id: library.id, name: library.name };
            }
            librarySymbolMap[ref.id] = { library: library.id, libraryName: library.name, name: ref.name };
            libraryRefById[ref.id] = ref;
            libraryEntries.push({
              id: ref.id,
              name: ref.name,
              library: library.id,
              libraryName: library.name,
              isOriginallyLocal: false
            });
            leanForCache.push({ id: String(ref.id), name: String(ref.name) });
          });
          setCachedLibrarySymbols(library, leanForCache);
        } catch (e) {
          log("Error getting refs from " + library.name + ": " + e);
        }
      }

      libraryIndex += 1;
      processedLibraries += 1;
    }

    if (libraryIndex >= enabledLibraries.length) {
      processLocalSymbolsBatch(0);
      return;
    }
    setTimeout(processLibraryBatch, 0);
  }

  processLibraryBatch();
}

function getSymbolsJsonFromLocalChangesAsync(document, libraryScanData, callback, shouldContinue, scanConfig) {
  const localSymbols = getDocumentSymbolMetadata(document);
  const symbols = [];
  const existingSymbolNames = new Set();
  const effectiveLibraryScanData = libraryScanData || {};
  const librarySymbolMap = effectiveLibraryScanData.librarySymbolMap || {};
  const libraryBySymbolName = effectiveLibraryScanData.libraryBySymbolName || {};
  const libraryEntries = Array.isArray(effectiveLibraryScanData.libraryEntries) ? effectiveLibraryScanData.libraryEntries : [];
  const libraryRefById = effectiveLibraryScanData.libraryRefById || {};
  const libraryRefsLoadedById = effectiveLibraryScanData.libraryRefsLoadedById || {};
  const effectiveScanConfig = scanConfig || {};
  const symbolBatchSize = Math.max(1, Number(effectiveScanConfig.symbolBatchSize) || SYMBOL_SCAN_BATCH_SIZE);

  function isCancelled() {
    return typeof shouldContinue === 'function' && !shouldContinue();
  }

  function finish() {
    if (isCancelled()) {
      return;
    }

    symbols.sort(function(a, b) {
      return a.name.localeCompare(b.name);
    });

    symbolLookupCache.docId = getDocumentIdentifier(document);
    symbolLookupCache.localById = createLazyLocalSymbolLookup(localSymbols);
    symbolLookupCache.libraryRefById = libraryRefById;
    const libraryIdsByComponentId = {};
    Object.keys(librarySymbolMap).forEach(function(id) {
      const entry = librarySymbolMap[id];
      if (entry && entry.library !== null && entry.library !== undefined) {
        libraryIdsByComponentId[String(id)] = String(entry.library);
      }
    });
    symbolLookupCache.libraryIdById = libraryIdsByComponentId;
    symbolLookupCache.libraryRefsLoadedById = libraryRefsLoadedById;

    log("Rebuilt local symbols using cached library index: " + symbols.length + " total symbols");
    callback(JSON.stringify(symbols), symbols.length);
  }

  function processCachedLibrarySymbolsBatch(startIndex) {
    if (isCancelled()) {
      return;
    }

    let currentIndex = startIndex;
    let processed = 0;

    while (currentIndex < libraryEntries.length) {
      const entry = libraryEntries[currentIndex];
      if (!existingSymbolNames.has(entry.name)) {
        symbols.push({
          id: entry.id,
          name: entry.name,
          library: entry.library,
          libraryName: entry.libraryName,
          isOriginallyLocal: false,
          colorIndex: (symbols.length + currentIndex) % 10,
          preview: getCachedPreview(entry.id)
        });
      }

      currentIndex += 1;
      processed += 1;
      if (processed >= symbolBatchSize) {
        setTimeout(function() {
          processCachedLibrarySymbolsBatch(currentIndex);
        }, 0);
        return;
      }
    }

    finish();
  }

  function processLocalSymbolsBatch(startIndex) {
    if (isCancelled()) {
      return;
    }

    const endIndex = Math.min(startIndex + symbolBatchSize, localSymbols.length);

    for (let i = startIndex; i < endIndex; i++) {
      const symbolMaster = sketch.fromNative(localSymbols[i].sketchObject);
      const symbolName = symbolMaster.name;
      existingSymbolNames.add(symbolName);

      // Sketch's MSSymbolMaster.isForeign tells us authoritatively whether the
      // master is a live foreign (library) import or a real local. Trust it —
      // the id+name heuristics below collapse truly-local masters whose name
      // happens to match a library entry into the library, which made them
      // disappear from the picker entirely. See getSymbolsJsonAsync for the
      // same classification.
      const foreignStatus = isSymbolMasterForeign(symbolMaster);

      if (foreignStatus === false) {
        symbols.push({
          id: symbolMaster.id,
          name: symbolName,
          library: null,
          libraryName: 'Local',
          isOriginallyLocal: true,
          colorIndex: i % 10,
          preview: getCachedPreview(symbolMaster.id)
        });
        continue;
      }

      if (foreignStatus === true) {
        const libInfoById = librarySymbolMap[symbolMaster.id];
        const sourceLib = libInfoById || libraryBySymbolName[symbolName];
        const libraryId = libInfoById ? libInfoById.library : (sourceLib ? sourceLib.id : null);
        const libraryName = libInfoById ? libInfoById.libraryName : (sourceLib ? sourceLib.name : 'Library');
        symbols.push({
          id: symbolMaster.id,
          name: symbolName,
          library: libraryId,
          libraryName: libraryName,
          isOriginallyLocal: false,
          colorIndex: i % 10,
          preview: getCachedPreview(symbolMaster.id)
        });
        continue;
      }

      // foreignStatus === null — Sketch build doesn't expose isForeign. Use
      // the legacy id+name heuristic. Same behaviour as before this fix.
      const libInfoById = librarySymbolMap[symbolMaster.id];
      if (libInfoById) {
        symbols.push({
          id: symbolMaster.id,
          name: symbolName,
          library: libInfoById.library,
          libraryName: libInfoById.libraryName,
          isOriginallyLocal: false,
          colorIndex: i % 10,
          preview: getCachedPreview(symbolMaster.id)
        });
        continue;
      }

      const sourceLibrary = libraryBySymbolName[symbolName];
      if (sourceLibrary) {
        symbols.push({
          id: symbolMaster.id,
          name: symbolName,
          library: sourceLibrary.id,
          libraryName: sourceLibrary.name,
          isOriginallyLocal: false,
          colorIndex: i % 10,
          preview: getCachedPreview(symbolMaster.id)
        });
      } else {
        symbols.push({
          id: symbolMaster.id,
          name: symbolName,
          library: null,
          libraryName: 'Local',
          isOriginallyLocal: true,
          colorIndex: i % 10,
          preview: getCachedPreview(symbolMaster.id)
        });
      }
    }

    if (endIndex < localSymbols.length) {
      setTimeout(function() {
        processLocalSymbolsBatch(endIndex);
      }, 0);
      return;
    }

    processCachedLibrarySymbolsBatch(0);
  }

  processLocalSymbolsBatch(0);
}

function evaluateWebScriptSafely(webView, script) {
  try {
    if (!webView || !webView.windowScriptObject()) {
      return false;
    }
    webView.windowScriptObject().evaluateWebScript_(script);
    return true;
  } catch (e) {
    log("WebView evaluation skipped: " + e);
    return false;
  }
}

// Option+Enter handler: navigate the canvas to the symbol's master so the
// user can edit it. Currently handles local masters (most common case). For
// library symbols we open the .sketch file the library lives in and select
// the master there.
function gotoSymbolSource(symbolId, document, browserState) {
  // 1) Local master in the current doc — fastest path.
  try {
    const locals = getDocumentSymbolMetadata(document);
    for (let i = 0; i < locals.length; i++) {
      if (locals[i].id === symbolId) {
        const master = sketch.fromNative(locals[i].sketchObject);
        navigateToMasterInDocument(master, document);
        try { hideBrowserWindow(browserState); } catch (e) {}
        UI.message("→ " + master.name);
        return;
      }
    }
  } catch (e) {}

  // 2) Library symbol — open the library .sketch file, then navigate.
  try {
    const libIdRaw = symbolLookupCache.libraryIdById[symbolId];
    if (libIdRaw) {
      const libs = sketch.getLibraries();
      for (let i = 0; i < libs.length; i++) {
        if (String(libs[i].id) !== String(libIdRaw)) continue;
        const lib = libs[i];
        let path = null;
        try {
          const native = lib.sketchObject || lib;
          if (native && typeof native.locationOnDisk === 'function') {
            const url = native.locationOnDisk();
            if (url) path = String(url.path());
          }
        } catch (e) {}
        if (!path) {
          UI.message("⚠ Library has no file on disk");
          return;
        }
        try { hideBrowserWindow(browserState); } catch (e) {}
        sketch.Document.open(path, function(err, libDoc) {
          if (err || !libDoc) {
            UI.message("⚠ Could not open library: " + (err && err.message ? err.message : 'unknown'));
            return;
          }
          // After open, find and navigate to the master.
          setTimeout(function() {
            try {
              const libSyms = libDoc.getSymbols();
              for (let j = 0; j < libSyms.length; j++) {
                if (libSyms[j].id === symbolId) {
                  navigateToMasterInDocument(libSyms[j], libDoc);
                  UI.message("→ " + libSyms[j].name + " (in " + (lib.name || 'library') + ")");
                  return;
                }
              }
              UI.message("⚠ Component not found in library document");
            } catch (e) {
              log("[Goto] navigate in lib doc failed: " + e);
            }
          }, 150);
        });
        return;
      }
    }
  } catch (e) {
    log("[Goto] library lookup failed: " + e);
  }

  UI.message("⚠ Component source not found");
}

function navigateToMasterInDocument(master, document) {
  const masterNative = master.sketchObject || master;
  const docData = document.sketchObject ? document.sketchObject.documentData() : null;

  // Switch the current page to the page that owns the master. Most often
  // that's the Symbols page; this also handles symbols on regular pages.
  try {
    const masterPage = masterNative.parentPage ? masterNative.parentPage() : null;
    if (masterPage && docData && typeof docData.setCurrentPage === 'function') {
      docData.setCurrentPage(masterPage);
    } else if (docData && typeof docData.symbolsPage === 'function') {
      const sp = docData.symbolsPage();
      if (sp) docData.setCurrentPage(sp);
    }
  } catch (e) {}

  // Select the master so editing affordances are visible.
  try {
    document.selectedLayers.clear();
    master.selected = true;
  } catch (e) {}

  // Zoom-to-fit the master so it's centered in the viewport.
  try {
    const canvasView = document.sketchObject.contentDrawView();
    if (canvasView && typeof canvasView.zoomToFitRect_ === 'function') {
      const frame = masterNative.frame();
      const rect = (typeof frame.rect === 'function') ? frame.rect() : NSMakeRect(frame.x(), frame.y(), frame.width(), frame.height());
      canvasView.zoomToFitRect_(rect);
    }
  } catch (e) {}
}

function insertSymbol(symbolId, document, replace, targetLayers, preserveDims) {
  log("=== INSERT SYMBOL START: " + symbolId + " ===");
  
  // Find symbol master - check local symbols first
  let symbolMaster = null;
  
  // Try to find in local symbols by ID
  const localSymbols = getDocumentSymbolMetadata(document);
  log("Checking " + localSymbols.length + " local symbols by ID...");
  for (let i = 0; i < localSymbols.length; i++) {
    if (localSymbols[i].id === symbolId) {
      symbolMaster = sketch.fromNative(localSymbols[i].sketchObject);
      log("Found by ID: " + symbolMaster.name);
      break;
    }
  }
  
  // If not found locally, try to find by name (for imported copies with different IDs)
  if (!symbolMaster) {
    log("Not found by ID, trying name lookup...");
    try {
      const libraries = sketch.getLibraries();
      let symbolName = null;
      
      // First, find the symbol name from library refs by ID
      // Retry up to 3 times with small delay if libraries not loaded yet
      for (let attempt = 0; attempt < 3 && !symbolName; attempt++) {
        if (attempt > 0) {
          log("Retrying library lookup (attempt " + attempt + ")...");
          // Small delay to let libraries load
          const start = Date.now();
          while (Date.now() - start < 100) {} // 100ms busy wait
        }
        
        for (let i = 0; i < libraries.length; i++) {
          const library = libraries[i];
          if (library.enabled) {
            try {
              const refs = library.getImportableSymbolReferencesForDocument(document);
              for (let j = 0; j < refs.length; j++) {
                if (refs[j].id === symbolId) {
                  symbolName = refs[j].name;
                  log("Found name in library " + library.name + ": " + symbolName);
                  break;
                }
              }
            } catch (e) {
              log("Error getting refs from " + library.name + ": " + e);
            }
            if (symbolName) break;
          }
        }
      }
      
      // If we found the name, look for local symbol with same name
      if (symbolName) {
        log("Looking for local copy of: " + symbolName);
        const localSymbols = getDocumentSymbolMetadata(document);
        log("Current local symbols count: " + localSymbols.length);
        for (let i = 0; i < localSymbols.length; i++) {
          if (localSymbols[i].name === symbolName) {
            symbolMaster = sketch.fromNative(localSymbols[i].sketchObject);
            log("Found local copy: " + symbolMaster.id);
            break;
          }
        }
        if (!symbolMaster) {
          log("No local copy found with name: " + symbolName);
        }
      } else {
        log("Could not find symbol name in any library after retries");
      }
    } catch (e) {
      log("Error finding symbol by name: " + e);
    }
  }
  
  // If still not found, try to import from libraries
  if (!symbolMaster) {
    log("Trying to import from libraries...");
    try {
      const libraries = sketch.getLibraries();
      for (let i = 0; i < libraries.length; i++) {
        const library = libraries[i];
        if (library.enabled) {
          log("Checking library: " + library.name);
          const refs = library.getImportableSymbolReferencesForDocument(document);
          for (let j = 0; j < refs.length; j++) {
            if (refs[j].id === symbolId) {
              // Import the symbol master into the document
              log("Importing from " + library.name + "...");
              symbolMaster = refs[j].import();
              if (symbolMaster) {
                log("Imported symbol: " + symbolMaster.name + " (ID: " + symbolMaster.id + ")");
                invalidateSymbolLookupCache();
                invalidateSymbolsListCache();
              } else {
                log("Import returned null");
              }
              break;
            }
          }
          if (symbolMaster) break;
        }
      }
    } catch (e) {
      log("Error importing library symbol: " + e);
    }
  }

  if (!symbolMaster) {
    log("=== SYMBOL NOT FOUND: " + symbolId + " ===");
    const owner = findL2EntryForSymbolId(symbolId);
    if (owner) {
      // The symbol id was carried from a stale cache entry; invalidate +
      // schedule a silent refresh so the UI updates on its own.
      log("[Stale] Insert lookup failed id=" + symbolId + " — L2 said '" + owner.name + "', purging cache");
      invalidateLibraryCachesByKey(owner.key);
      UI.message("Component no longer in library — refreshing list");
    } else {
      // Ghost: not in any L2 entry — L1 has a stale entry from before a
      // library change that didn't bump lastModifiedAt.
      log("[Ghost] Insert lookup failed id=" + symbolId + " — no L2 owner, refreshing list");
      invalidateCurrentDocL1AndRefresh();
      UI.message("Component no longer available — refreshing list");
    }
    return;
  }
  
  log("=== SYMBOL FOUND: " + symbolMaster.name + " (" + symbolMaster.id + ") ===");

  if (replace && targetLayers && targetLayers.length > 0) {
    // Replace mode - replace all selected layers
    const newLayers = [];
    
    targetLayers.forEach(function(targetLayer) {
      // Create instance for each layer
      const jsInstance = symbolMaster.createNewInstance();
      const nativeInstance = jsInstance.sketchObject || jsInstance;
      const frame = nativeInstance.frame();
      
      const targetFrame = targetLayer.frame;
      frame.setX(targetFrame.x);
      frame.setY(targetFrame.y);
      
      if (preserveDims) {
        // Preserve target layer dimensions
        frame.setWidth(targetFrame.width);
        frame.setHeight(targetFrame.height);
      }
      // else: keep symbol's original dimensions
      
      // Get parent of target layer
      const targetNative = targetLayer.sketchObject;
      const parent = targetNative.parentGroup();

      // Insert symbol at the SAME z-position the target occupied. The old
      // code did parent.addLayers([...]) which appends to the top of the
      // parent group — when the target was nested inside a group, the
      // replacement got teleported to the top of that group instead of
      // staying in place. Use insertLayer:atIndex: with the target's
      // original index so the symbol slots in where the layer used to be.
      if (parent) {
        let targetIndex = -1;
        try {
          if (typeof parent.indexOfLayer_ === 'function') {
            targetIndex = Number(parent.indexOfLayer_(targetNative));
          }
        } catch (e) {}

        let inserted = false;
        if (targetIndex >= 0) {
          try {
            parent.insertLayer_atIndex_(nativeInstance, targetIndex);
            inserted = true;
          } catch (e) {
            log("[Replace] insertLayer:atIndex: failed (" + e + ") — falling back");
          }
        }
        if (!inserted) {
          parent.addLayers([nativeInstance]);
        }

        // Remove target layer. With insertLayer:atIndex: the new symbol now
        // sits at targetIndex and the original target was bumped to
        // targetIndex+1 — removing it leaves the new symbol in place.
        targetNative.removeFromParent();
      } else {
        // Fallback: add to current page
        const nativePage = document.selectedPage.sketchObject;
        nativePage.addLayers([nativeInstance]);
      }
      
      newLayers.push(sketch.fromNative(nativeInstance));
    });
    
    // Select all new layers
    document.selectedLayers.clear();
    newLayers.forEach(function(layer) {
      layer.selected = true;
    });
    
    UI.message("✅ Replaced " + targetLayers.length + " layer(s) with: " + symbolMaster.name);
  } else {
    // Insert mode: position at viewport center
    const jsInstance = symbolMaster.createNewInstance();
    const nativeInstance = jsInstance.sketchObject || jsInstance;
    const frame = nativeInstance.frame();
    
    const canvasView = document.sketchObject.contentDrawView();
    const viewPort = canvasView.viewPort();
    const viewCenter = canvasView.viewCenterInAbsoluteCoordinatesForViewPort(viewPort);
    
    frame.setX(viewCenter.x - frame.width() / 2);
    frame.setY(viewCenter.y - frame.height() / 2);
    
    // Add to page
    const nativePage = document.selectedPage.sketchObject;
    nativePage.addLayers([nativeInstance]);
    
    // Select the new layer
    document.selectedLayers.clear();
    const newLayer = sketch.fromNative(nativeInstance);
    newLayer.selected = true;
    
    UI.message("✅ Inserted: " + symbolMaster.name);
  }
  
  // Close window after insertion
  const browserState = runtimeBrowserState;
  if (browserState) {
    setTimeout(function() {
      hideBrowserWindow(browserState);
    }, 0);
    return;
  }

  const win = getThreadDictionaryObject(WINDOW_IDENTIFIER);
  if (win) {
    try {
      setTimeout(function() {
        win.close();
      }, 0);
    } catch (e) {}
  }
}

// Preview queue for throttling
const previewQueue = [];
let isProcessingPreview = false;
const inFlightPreviewBySymbol = {};

function parsePreviewRequestPayload(rawPayload) {
  let decoded = String(rawPayload || '');
  try { decoded = decodeURIComponent(decoded); } catch (e) {}
  try {
    const request = JSON.parse(decoded);
    if (request && request.id) {
      request.id = String(request.id);
      return request;
    }
  } catch (e) {}
  return { id: decoded };
}

function sendPreviewToUI(webView, symbolId, preview) {
  if (!webView || !symbolId || !preview) return;
  evaluateWebScriptSafely(webView, 'window.updateSymbolPreview(' + JSON.stringify(String(symbolId)) + ', ' + JSON.stringify(String(preview)) + ', ' + JSON.stringify(previewVersionTagBySymbol[String(symbolId)] || '') + ');');
}

function processPreviewQueue() {
  if (isProcessingPreview || previewQueue.length === 0) return;
  
  isProcessingPreview = true;
  const item = previewQueue.shift();
  const { symbolId, document, requestDocId, webView, priority, browserState, reloadToken, componentInfo } = item;

  if (browserState && (browserState.closed || browserState.reloadToken !== reloadToken || browserState.docId !== requestDocId)) {
    isProcessingPreview = false;
    processPreviewQueue();
    return;
  }
  
  verbosePreviewLog("Processing preview for: " + symbolId + " (priority: " + priority + ")");
  pendingForegroundPreviewIDs.add(String(symbolId));
  
  let handedOff = false;
  try {
    if (previewAgent && typeof previewAgent.requestPreviewForSymbolID_ === 'function') {
      handedOff = !!previewAgent.requestPreviewForSymbolID_(String(symbolId));
    }
  } catch (e) {
    log("[PreviewAgent] on-demand request failed id=" + symbolId + ": " + e);
  }
  if (handedOff) {
    verbosePreviewLog("Preview handed to background agent for: " + symbolId);
  } else {
    log("[PreviewAgent] no background source queued for component id=" + symbolId
      + (componentInfo && componentInfo.library === null ? " (local or unsaved component)" : ""));
  }

  // Keep alert-to-plugin dispatches short; all rendering happens in sketchtool.
  const delay = priority ? 0 : PREVIEW_QUEUE_DELAY_MS;
  setTimeout(function() {
    isProcessingPreview = false;
    processPreviewQueue();
  }, delay);
}

function queuePreviewRequest(symbolId, document, webView, priority, browserState, componentInfo) {
  const reloadToken = browserState ? browserState.reloadToken : 0;
  const requestDocId = getDocumentIdentifier(document) || (browserState ? browserState.docId : null);
  const row = componentInfo && typeof componentInfo === 'object' ? componentInfo : null;

  // The hotkey and WebView delegate may belong to different CocoaScript
  // contexts. Honor the UI's current revision before using this context's LRU.
  if (row && row.previewVersionTag && previewVersionTagBySymbol[String(symbolId)] !== String(row.previewVersionTag)) {
    previewVersionTagBySymbol[String(symbolId)] = String(row.previewVersionTag);
    previewMemoryCache.delete(String(symbolId));
  }

  const cached = getCachedPreview(symbolId);
  if (cached) {
    if (!browserState || (!browserState.closed && browserState.reloadToken === reloadToken && browserState.docId === requestDocId)) {
      sendPreviewToUI(webView, symbolId, cached);
    }
    return;
  }

  // A row already identifies its owning library. Check the disk thumbnail with
  // that library's version before asking Sketch for live references.
  try {
    let versionTag = String((row && row.previewVersionTag) || previewVersionTagBySymbol[String(symbolId)] || '');
    if (!versionTag && row && row.library !== null && row.library !== undefined && row.library !== '') {
      const libraryId = String(row.library);
      symbolLookupCache.libraryIdById[String(symbolId)] = libraryId;
      const library = getEnabledLibraryById(libraryId, document);
      if (library) {
        const libraryVersion = getLibraryVersionTag(library);
        if (libraryVersion) versionTag = 'lib:' + libraryVersion;
      }
    } else if (!versionTag && row && row.library === null) {
      // Show the durable local thumbnail immediately while the chunked content
      // check runs. applyPreviewVersionTags replaces it if the model changed.
      const persisted = readPreviewDiskVersionTag(String(symbolId));
      const qualityPrefix = PREVIEW_CACHE_QUALITY_TAG + ':';
      if (persisted && persisted.indexOf(qualityPrefix + 'local-json-v1:') === 0) {
        versionTag = persisted.slice(qualityPrefix.length);
        previewVersionTagBySymbol[String(symbolId)] = versionTag;
      }
    } else if (!versionTag && row && row.library !== undefined) {
      ensureSymbolLookupCache(document);
      const localSymbol = symbolLookupCache.localById[String(symbolId)] || null;
      const libraryRef = symbolLookupCache.libraryRefById[String(symbolId)] || null;
      if (localSymbol || libraryRef) versionTag = getSymbolVersionTag(localSymbol, libraryRef, String(symbolId), document);
    } else if (!versionTag) {
      // Compatibility for an older WebView that sends only an ID.
      ensureSymbolLookupCache(document);
      const localSymbol = symbolLookupCache.localById[String(symbolId)] || null;
      const libraryRef = symbolLookupCache.libraryRefById[String(symbolId)] || null;
      if (localSymbol || libraryRef) versionTag = getSymbolVersionTag(localSymbol, libraryRef, String(symbolId), document);
    }

    if (versionTag) {
      const diskCached = readDiskPreview(String(symbolId), versionTag);
      if (diskCached) {
        setCachedPreview(symbolId, diskCached);
        if (!browserState || (!browserState.closed && browserState.reloadToken === reloadToken && browserState.docId === requestDocId)) {
          sendPreviewToUI(webView, symbolId, diskCached);
        }
        return;
      }
    }
  } catch (e) {
    // Enqueue a background export when cache metadata is incomplete.
  }

  const existingIndex = previewQueue.findIndex(item =>
    item.symbolId === symbolId
    && item.webView === webView
    && item.reloadToken === reloadToken
    && item.requestDocId === requestDocId
  );

  if (existingIndex >= 0) {
    if (priority && !previewQueue[existingIndex].priority) {
      const existingItem = previewQueue.splice(existingIndex, 1)[0];
      existingItem.priority = true;
      existingItem.componentInfo = row;
      previewQueue.unshift(existingItem);
    }
    return;
  }

  const queueItem = { symbolId, document, requestDocId, webView, priority: priority === true, browserState, reloadToken, componentInfo: row };
  if (priority) previewQueue.unshift(queueItem);
  else previewQueue.push(queueItem);
  processPreviewQueue();
}

function getExportScaleForSymbol(symbolLike, targetSize) {
  const fallbackScale = "0.25";
  if (!symbolLike || !targetSize || targetSize <= 0) return fallbackScale;

  const dimensions = getSymbolDimensions(symbolLike);
  if (!dimensions) return fallbackScale;

  const maxDim = Math.max(dimensions.width, dimensions.height);
  if (!isFinite(maxDim) || maxDim <= 0) return fallbackScale;

  const rawScale = targetSize / maxDim;
  const clampedScale = Math.max(0.05, Math.min(rawScale, 8));
  if (!isFinite(clampedScale) || clampedScale <= 0) return fallbackScale;

  return String(Math.round(clampedScale * 1000) / 1000);
}

function getSymbolDimensions(symbolLike) {
  let width = null;
  let height = null;

  try {
    const native = symbolLike.sketchObject || symbolLike;
    if (native && typeof native.frame === 'function') {
      const frame = native.frame();
      if (frame) {
        width = typeof frame.width === 'function' ? Number(frame.width()) : Number(frame.width);
        height = typeof frame.height === 'function' ? Number(frame.height()) : Number(frame.height);
      }
    }
  } catch (e) {}

  if (!(isFinite(width) && width > 0 && isFinite(height) && height > 0)) {
    try {
      const frame = symbolLike && symbolLike.frame;
      if (frame) {
        width = typeof frame.width === 'function' ? Number(frame.width()) : Number(frame.width);
        height = typeof frame.height === 'function' ? Number(frame.height()) : Number(frame.height);
      }
    } catch (e) {}
  }

  if (!isFinite(width) || width <= 0 || !isFinite(height) || height <= 0) {
    return null;
  }

  return { width, height };
}
