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
const PREVIEW_CACHE_KEY = "com.funkyplugins.componentbrowser.previewCache.v2";
const SYMBOLS_CACHE_KEY = "com.funkyplugins.componentbrowser.symbolsCache.v1";
const LIBRARIES_CACHE_KEY = "com.funkyplugins.componentbrowser.librariesCache.v1";
const UI_STATE_CACHE_KEY = "com.funkyplugins.componentbrowser.uiStateCache.v1";
const PREVIEW_RENDER_SIZE = 64;
const PREVIEW_QUEUE_DELAY_MS = 8;
const SYMBOL_SCAN_BATCH_SIZE = 600;
const SYMBOL_SCAN_LIBRARY_BATCH_SIZE = 4;
const RESPONSIVE_SYMBOL_SCAN_BATCH_SIZE = 320;
const RESPONSIVE_SYMBOL_SCAN_LIBRARY_BATCH_SIZE = 1;
const RESPONSIVE_SCAN_START_DELAY_MS = 16;
const DOCUMENT_WATCH_INTERVAL_MS = 450;
const DEBUG_VERBOSE_SYMBOL_SCAN_LOGS = false;
const DEBUG_VERBOSE_PREVIEW_LOGS = false;
const WINDOW_IDENTIFIER = "com.funkyplugins.componentbrowser.window";
const WEBVIEW_IDENTIFIER = "com.funkyplugins.componentbrowser.webView";
const DELEGATE_IDENTIFIER = "com.funkyplugins.componentbrowser.delegate";
const LAST_DOC_ID_KEY = "com.funkyplugins.componentbrowser.lastDocId";
const WINDOW_VISIBLE_KEY = "com.funkyplugins.componentbrowser.visible";
const DOC_LOCAL_COUNT_KEY = "com.funkyplugins.componentbrowser.localSymbolCount";
const DOC_LIBRARY_COUNT_KEY = "com.funkyplugins.componentbrowser.enabledLibraryCount";
const DOC_LIBRARY_SIGNATURE_KEY = "com.funkyplugins.componentbrowser.enabledLibrarySignature";

const symbolLookupCache = {
  docId: null,
  localById: {},
  libraryRefById: {}
};
const importPreviewFallbackTried = {};

// Tracks in-flight background ref warmup (see startLibraryRefsWarmup). Used
// to dedupe re-entrant calls and to cancel when the browser closes.
const refWarmupState = {
  inProgress: false,
  cancelToken: 0
};

let runtimeBrowserState = null;

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

function removeThreadDictionaryObject(key) {
  const threadDictionary = NSThread.mainThread().threadDictionary();
  if (!threadDictionary) return;

  try {
    if (threadDictionary.removeObjectForKey) {
      threadDictionary.removeObjectForKey(key);
      return;
    }

    if (threadDictionary.setValue_forKey) {
      threadDictionary.setValue_forKey(null, key);
    }
  } catch (e) {
    log("Thread dictionary remove failed for " + key + ": " + e);
  }
}

function getEnabledLibraries() {
  return sketch.getLibraries().filter(function(lib) { return lib.enabled; });
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

function invalidateSymbolLookupCache() {
  symbolLookupCache.docId = null;
  symbolLookupCache.localById = {};
  symbolLookupCache.libraryRefById = {};
}

function rebuildSymbolLookupCache(document) {
  const localById = {};
  const libraryRefById = {};

  const localSymbols = document.getSymbols();
  localSymbols.forEach(function(symbolMaster) {
    localById[symbolMaster.id] = symbolMaster;
  });

  const libraries = sketch.getLibraries();
  const enabledLibraries = libraries.filter(function(lib) { return lib.enabled; });
  enabledLibraries.forEach(function(library) {
    try {
      const refs = library.getImportableSymbolReferencesForDocument(document);
      refs.forEach(function(ref) {
        libraryRefById[ref.id] = ref;
      });
    } catch (e) {
      log("Error building preview ref cache for " + library.name + ": " + e);
    }
  });

  symbolLookupCache.docId = getDocumentIdentifier(document);
  symbolLookupCache.localById = localById;
  symbolLookupCache.libraryRefById = libraryRefById;
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

function getOrCreatePreviewCache() {
  const cache = Settings.sessionVariable(PREVIEW_CACHE_KEY);
  return cache && typeof cache === 'object' && !Array.isArray(cache) ? Object.assign({}, cache) : {};
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
// The actual MSShareableObjectReference objects are intentionally NOT cached
// — they don't survive a Sketch restart and are needed live for preview
// generation. After a cache hit they're warmed back into memory via
// startLibraryRefsWarmup, scanned per-library in the background.
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
  _librariesCacheMemo.value = result;
  _librariesCacheMemo.time = now;
  return result;
}

function getLibraryVersionTag(library) {
  // library.lastModifiedAt is a Date in newer Sketch builds; in older ones the
  // attribute may be missing. When unavailable we fall back to an empty tag —
  // the cache will still survive enabling/disabling libraries but will NOT
  // detect a new symbol added inside an existing library. The release notes
  // mention this; the workaround is to disable + re-enable that library.
  try {
    if (library && library.lastModifiedAt) {
      const v = library.lastModifiedAt;
      const t = (v && typeof v.getTime === 'function') ? v.getTime() : v;
      if (t) return String(t);
    }
  } catch (e) {}
  return '';
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
function invalidateLibraryCachesByKey(libraryCacheKey) {
  if (!libraryCacheKey) return;
  try {
    const libCache = getOrCreateLibrariesCache();
    if (libCache[libraryCacheKey]) {
      delete libCache[libraryCacheKey];
      Settings.setSettingForKey(LIBRARIES_CACHE_KEY, libCache);
    }
  } catch (e) {}
  // L1 entries embed the (now-stale) library symbol set; wipe them all so the
  // next plugin open does a fresh scan instead of serving the same dead IDs.
  try {
    Settings.setSettingForKey(SYMBOLS_CACHE_KEY, {});
  } catch (e) {}
  // Bust the in-memory L2 memoization too — see getOrCreateLibrariesCache.
  _librariesCacheMemo.value = null;
  log("[Stale] invalidated L2 key '" + libraryCacheKey + "' and L1 (all docs)");

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

// After an L1 (full symbols JSON) cache hit, the UI is rendered instantly but
// the live MSShareableObjectReference objects are NOT in
// symbolLookupCache.libraryRefById. The first preview request would then fall
// back to scanning every enabled library to find a single symbol — sync, slow,
// and repeats per library. Instead, after a successful cache-hit render we
// fire-and-forget this warmup: one library per setTimeout tick, populating
// libraryRefById from a single getImportableSymbolReferencesForDocument call
// per library. By the time the user scrolls and lands on a previewed item,
// the refs are usually ready.
//
// Cooperatively cancels via cancelToken if the browser closes or another
// warmup starts.
function startLibraryRefsWarmup(browserState) {
  if (!browserState || browserState.closed || !browserState.document) return;
  if (refWarmupState.inProgress) return;

  const document = browserState.document;
  const enabledLibraries = getEnabledLibraries();
  if (enabledLibraries.length === 0) return;

  refWarmupState.inProgress = true;
  refWarmupState.cancelToken += 1;
  const myToken = refWarmupState.cancelToken;

  ensureSymbolLookupCache(document);

  let index = 0;

  function step() {
    if (myToken !== refWarmupState.cancelToken) {
      refWarmupState.inProgress = false;
      return;
    }
    if (!browserState || browserState.closed) {
      refWarmupState.inProgress = false;
      return;
    }
    if (index >= enabledLibraries.length) {
      refWarmupState.inProgress = false;
      log("[Warmup] library refs ready");
      return;
    }

    const library = enabledLibraries[index++];

    // Quick check: probe whether refs from this library are already warmed.
    // We use a single id from the L2 cache as a marker.
    let alreadyWarmed = false;
    const cachedLib = getCachedLibrarySymbols(library);
    if (cachedLib && cachedLib.symbols.length > 0) {
      const probeId = cachedLib.symbols[0].id;
      if (symbolLookupCache.libraryRefById[probeId]) {
        alreadyWarmed = true;
      }
    }

    if (!alreadyWarmed) {
      try {
        const refs = library.getImportableSymbolReferencesForDocument(document);
        const leanForCache = [];
        refs.forEach(function(ref) {
          symbolLookupCache.libraryRefById[ref.id] = ref;
          leanForCache.push({ id: String(ref.id), name: String(ref.name) });
        });
        // Keep L2 fresh while we're at it — if the library's lastModifiedAt
        // changed under us, this stores the new symbol set for future opens.
        setCachedLibrarySymbols(library, leanForCache);
      } catch (e) {
        log("[Warmup] failed for " + library.name + ": " + e);
      }
    }

    setTimeout(step, 0);
  }

  step();
}

function cancelLibraryRefsWarmup() {
  refWarmupState.cancelToken += 1;
  refWarmupState.inProgress = false;
}

// L1 cache: full merged symbol JSON per document. Keyed by docId, so switching
// documents preserves caches for previously-visited docs. Each entry stores its
// own validity signature (library set + local symbol count) so we can detect
// staleness without invalidating other docs' entries.
function getCachedSymbolsJson(document) {
  const docId = getDocumentIdentifier(document);
  if (!docId) return null;

  const cache = getOrCreateSymbolsCache();
  const entry = cache[docId];
  if (!entry || !entry.symbolsJson) return null;

  const currentLocalCount = document.getSymbols().length;
  const enabledLibraries = getEnabledLibraries();
  const currentEnabledLibraryCount = enabledLibraries.length;
  const currentLibrarySignature = getEnabledLibrarySignatureFromLibraries(enabledLibraries);
  if (Number(entry.localSymbolCount || 0) !== currentLocalCount) return null;
  if (Number(entry.enabledLibraryCount || 0) !== currentEnabledLibraryCount) return null;
  if (String(entry.enabledLibrarySignature || "") !== currentLibrarySignature) return null;

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

  const enabledLibraries = getEnabledLibraries();
  cache[docId] = {
    symbolsJson: String(lean),
    localSymbolCount: String(document.getSymbols().length),
    enabledLibraryCount: String(enabledLibraries.length),
    enabledLibrarySignature: getEnabledLibrarySignatureFromLibraries(enabledLibraries),
    updatedAt: String(Date.now())
  };
  Settings.setSettingForKey(SYMBOLS_CACHE_KEY, cache);
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

function getCachedPreview(symbolId) {
  if (!symbolId) return null;

  const cache = getOrCreatePreviewCache();
  const value = cache[String(symbolId)];
  return value ? String(value) : null;
}

function setCachedPreview(symbolId, preview) {
  if (!symbolId || !preview) return;

  const cache = getOrCreatePreviewCache();
  cache[String(symbolId)] = String(preview);
  Settings.setSessionVariable(PREVIEW_CACHE_KEY, cache);
}

function hydrateSymbolsJsonWithCachedPreviews(symbolsJson) {
  if (!symbolsJson) return symbolsJson;

  try {
    const symbols = JSON.parse(String(symbolsJson));
    if (!Array.isArray(symbols) || symbols.length === 0) {
      return symbolsJson;
    }

    let changed = false;
    symbols.forEach(function(symbol) {
      if (!symbol || symbol.preview || !symbol.id) return;
      const cachedPreview = getCachedPreview(symbol.id);
      if (cachedPreview) {
        symbol.preview = cachedPreview;
        changed = true;
      }
    });

    return changed ? JSON.stringify(symbols) : symbolsJson;
  } catch (e) {
    return symbolsJson;
  }
}

function getActiveDocument() {
  try {
    return sketch.getSelectedDocument();
  } catch (e) {
    return null;
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
  const enabledLibraries = document ? getEnabledLibraries() : [];

  if (!document) {
    return {
      localSymbolCount: 0,
      enabledLibraryCount: 0,
      enabledLibrarySignature: ""
    };
  }

  return {
    localSymbolCount: document.getSymbols().length,
    enabledLibraryCount: enabledLibraries.length,
    enabledLibrarySignature: getEnabledLibrarySignatureFromLibraries(enabledLibraries)
  };
}

function updateBrowserContentSignature(browserState, document) {
  if (!browserState || !document) return;

  const signature = getDocumentContentSignature(document);
  browserState.localSymbolCount = signature.localSymbolCount;
  browserState.enabledLibraryCount = signature.enabledLibraryCount;
  browserState.enabledLibrarySignature = signature.enabledLibrarySignature;
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

function hideBrowserWindow(browserState) {
  if (!browserState || browserState.closed) return;

  browserState.isVisible = false;
  setBrowserVisibility(false);
  clearQueuedPreviewRequestsForWebView(browserState.webView);
  cancelLibraryRefsWarmup();

  const webViewWindow = browserState.webViewWindow || getThreadDictionaryObject(WINDOW_IDENTIFIER);
  if (webViewWindow) {
    try {
      webViewWindow.orderOut(nil);
    } catch (e) {}
  }
}

function destroyBrowserWindow(browserState) {
  if (!browserState || browserState.closed) return;

  browserState.closed = true;
  browserState.isVisible = false;
  setBrowserVisibility(false);
  clearQueuedPreviewRequestsForWebView(browserState.webView);
  cancelLibraryRefsWarmup();

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
  const reloadToken = ++browserState.reloadToken;
  const expectedDocId = browserState.docId;
  const document = browserState.document;
  const webView = browserState.webView;
  const savedUiStateJson = getSavedUiState(document) || 'null';
  const scanConfig = showLoader ? {
    symbolBatchSize: RESPONSIVE_SYMBOL_SCAN_BATCH_SIZE,
    libraryBatchSize: RESPONSIVE_SYMBOL_SCAN_LIBRARY_BATCH_SIZE
  } : {
    symbolBatchSize: SYMBOL_SCAN_BATCH_SIZE,
    libraryBatchSize: SYMBOL_SCAN_LIBRARY_BATCH_SIZE
  };

  clearQueuedPreviewRequestsForWebView(webView);
  invalidateSymbolLookupCache();

  if (showLoader) {
    evaluateWebScriptSafely(webView, 'window.setLoading(true);');
  }

  const cachedSymbolsJson = forceRefresh ? null : getCachedSymbolsJson(document);
  if (cachedSymbolsJson) {
    if (!browserState.closed && browserState.reloadToken === reloadToken && browserState.docId === expectedDocId) {
      log("[Diag] L1 hit doc=" + (browserState.docId || '?') + " jsonBytes=" + cachedSymbolsJson.length + " libSig=" + getEnabledLibrarySignatureFromLibraries(getEnabledLibraries()));
      // If createBrowserWindow already baked the same data into INITIAL_SYMBOLS
      // we'd just be re-running loadSymbols against a freshly-loaded HTML and
      // resetting UI state (scroll, selection). Skip the evaluate; the UI is
      // about to (or has already) auto-loaded from window.INITIAL_SYMBOLS.
      if (browserState.initialSymbolsInjected) {
        browserState.initialSymbolsInjected = false;
        updateBrowserContentSignature(browserState, document);
        log("Loaded symbols from cache (via initial HTML inject)");
        // Refs for the cached libraries are not in symbolLookupCache yet —
        // warm them in background so preview generation is fast when the
        // user starts scrolling.
        setTimeout(function() { startLibraryRefsWarmup(browserState); }, 0);
        return;
      }

      // Re-open against a window that's already past DOMContentLoaded: safe
      // to call window.loadSymbols directly. cachedSymbolsJson is lean so
      // the payload is small.
      updateBrowserContentSignature(browserState, document);
      evaluateWebScriptSafely(webView, 'window.loadSymbols(' + cachedSymbolsJson + ', ' + savedUiStateJson + ');');
      log("Loaded symbols from cache");
      setTimeout(function() { startLibraryRefsWarmup(browserState); }, 0);
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
    log("Found " + symbolCount + " symbols");

    if (!symbolsJson || symbolsJson === "[]") {
      evaluateWebScriptSafely(webView, 'window.setLoading(false); window.loadSymbols([], ' + savedUiStateJson + ');');
      UI.message("❌ No symbols found");
      return;
    }

    // Strip previews once and use the lean version both for persistence and
    // for the evaluateWebScript payload. Previews remain in the session cache
    // and are pushed lazily via update-symbol-preview as items become visible.
    const lean = stripPreviewsFromSymbolsJson(symbolsJson);
    setCachedSymbolsJson(document, lean);
    updateBrowserContentSignature(browserState, document);
    evaluateWebScriptSafely(webView, 'window.loadSymbols(' + lean + ', ' + savedUiStateJson + ');');
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
  const runtimeBrowserState = buildBrowserStateFromRuntime(document);

  if (existingWindow && runtimeBrowserState && !runtimeBrowserState.closed) {
    const isDifferentDocument = runtimeBrowserState.docId !== currentDocId;
    const reloadMode = isDifferentDocument ? 'full' : getSymbolsReloadMode(runtimeBrowserState, document);

    // Always reuse the existing WebView when one is around — even on a doc
    // switch with the window hidden. Destroying + recreating costs an HTML
    // reload and a full JS init (hundreds of ms) just to get back to the
    // same UI; reusing only needs an evaluateWebScript call to push the
    // new symbol list.
    if (isDifferentDocument) {
      log("Document changed, reusing browser window (was " + (runtimeBrowserState.isVisible ? "visible" : "hidden") + ")");
      applyBrowserDocument(runtimeBrowserState, document);
    }

    runtimeBrowserState.isVisible = true;
    setBrowserVisibility(true);
    existingWindow.makeKeyAndOrderFront(nil);
    const webView = getBrowserWebView(runtimeBrowserState, existingWindow);
    if (webView) {
      try {
        existingWindow.makeFirstResponder(webView);
      } catch (e) {}
      focusBrowserSearch(webView, 'select-existing');
      evaluateWebScriptSafely(webView, 'if (window.requestPreviewsForVisibleItems) { window.requestPreviewsForVisibleItems(); }');
    } else {
      log("Window already open, bringing to front");
    }

    if (reloadMode) {
      loadSymbolsIntoBrowser(runtimeBrowserState, {
        showLoader: isDifferentDocument,
        reloadMode: reloadMode
      });
    }
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

  const windowWidth = 700, windowHeight = 600;

  const webViewWindow = NSPanel.alloc().init();
  webViewWindow.setFrame_display(NSMakeRect(0, 0, windowWidth, windowHeight), true);
  
  // Full size content view window - content extends to titlebar area
  webViewWindow.setStyleMask(NSTitledWindowMask | NSClosableWindowMask | NSTexturedBackgroundWindowMask | NSFullSizeContentViewWindowMask);
  webViewWindow.setTitlebarAppearsTransparent(true);
  webViewWindow.setTitleVisibility(NSWindowTitleHidden);
  webViewWindow.setTitle("");
  webViewWindow.setOpaque(false);
  webViewWindow.setBackgroundColor(NSColor.clearColor());
  
  // Hide titlebar buttons; close via Esc inside the UI.
  webViewWindow.standardWindowButton(NSWindowCloseButton).setHidden(true);
  webViewWindow.standardWindowButton(NSWindowMiniaturizeButton).setHidden(true);
  webViewWindow.standardWindowButton(NSWindowZoomButton).setHidden(true);

  webViewWindow.becomeKeyWindow();
  webViewWindow.setLevel(NSFloatingWindowLevel);
  setThreadDictionaryObject(WINDOW_IDENTIFIER, webViewWindow);
  setThreadDictionaryObject(LAST_DOC_ID_KEY, currentDocId);
  COScript.currentCOScript().setShouldKeepAround_(true);

  const scriptFolder = context.scriptURL.URLByDeletingLastPathComponent();
  const htmlUrl = scriptFolder.URLByAppendingPathComponent("symbol-browser-ui.html");
  const htmlData = NSData.dataWithContentsOfURL(htmlUrl);
  let html = String(NSString.alloc().initWithData_encoding(htmlData, NSUTF8StringEncoding));
  const contentView = webViewWindow.contentView();

  // If we have a valid persistent cache for this document, inject the symbol
  // data directly into the HTML *before* loadHTMLString runs. The UI's
  // DOMContentLoaded handler picks up window.INITIAL_SYMBOLS and renders
  // immediately, sidestepping the race where evaluateWebScript fires against
  // an empty document (no window.loadSymbols defined yet) and the spinner
  // stays up forever.
  const initialSymbolsJson = getCachedSymbolsJson(document);
  let initialSymbolsInjected = false;
  if (initialSymbolsJson) {
    const initialStateJson = getSavedUiState(document) || 'null';
    const initScript = '<script>window.INITIAL_SYMBOLS = ' + initialSymbolsJson + '; window.INITIAL_UI_STATE = ' + initialStateJson + ';</script>';
    if (html.indexOf('</head>') !== -1) {
      html = html.replace('</head>', initScript + '</head>');
    } else {
      html = initScript + html;
    }
    initialSymbolsInjected = true;
    log("[Init] injected " + initialSymbolsJson.length + " bytes of cached symbols into HTML");
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
    webView: webView,
    webViewWindow: webViewWindow,
    // One-shot flag: the first loadSymbolsIntoBrowser call after a fresh
    // createBrowserWindow can skip its cache-hit evaluate because the data
    // was already baked into the HTML via INITIAL_SYMBOLS.
    initialSymbolsInjected: initialSymbolsInjected
  };
  syncBrowserRuntimeHandles(browserState);
  applyBrowserDocument(browserState, document);

  const effectView = createBackgroundEffectView(NSMakeRect(0, 0, windowWidth, windowHeight));
  if (effectView) {
    contentView.addSubview(effectView);
  }

  const delegate = new MochaJSDelegate({
    "webView:runJavaScriptAlertPanelWithMessage:initiatedByFrame:": function(webView, message, frame) {
      // log("Received message: " + message);
      if (message.startsWith('insert-symbol:')) {
        try {
          const symbolId = message.substring(14);
          const activeDocument = getActionDocument(browserState);
          if (!activeDocument) return;
          insertSymbol(symbolId, activeDocument, false, null, false);
        } catch (e) {
          log("ERROR: " + e);
          UI.message("❌ Error: " + e.message);
        }
      } else if (message.startsWith('replace-symbol:')) {
        try {
          // Parse: replace-symbol:SYMBOL_ID:preserve or replace-symbol:SYMBOL_ID:original
          const parts = message.substring(15).split(':');
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
      } else if (message.startsWith('drag-window:')) {
        // Handle window dragging
        const parts = message.substring(12).split(':');
        const dx = parseFloat(parts[0]);
        const dy = parseFloat(parts[1]);
        const frame = webViewWindow.frame();
        webViewWindow.setFrame_display(NSMakeRect(frame.origin.x + dx, frame.origin.y - dy, frame.size.width, frame.size.height), true);
      } else if (message.startsWith('get-preview-priority:')) {
        const symbolId = message.substring(21);
        const previewDocument = browserState.document;
        if (!previewDocument) return;
        verbosePreviewLog("Priority preview requested for: " + symbolId);
        queuePreviewRequest(symbolId, previewDocument, webView, true, browserState);
      } else if (message.startsWith('get-preview:')) {
        // Generate list thumbnails in background queue
        const symbolId = message.substring(12);
        const previewDocument = browserState.document;
        if (!previewDocument) return;
        verbosePreviewLog("Preview requested for: " + symbolId);
        queuePreviewRequest(symbolId, previewDocument, webView, false, browserState);
      } else if (message.startsWith('close-browser:')) {
        try {
          const stateDocument = browserState.document;
          if (stateDocument) {
            setSavedUiState(stateDocument, decodeURIComponent(message.substring(14)));
          }
        } catch (e) {}
        setTimeout(function() {
          hideBrowserWindow(browserState);
        }, 0);
      } else if (message.startsWith('save-ui-state:')) {
        const stateDocument = browserState.document;
        if (stateDocument) {
          setSavedUiState(stateDocument, decodeURIComponent(message.substring(14)));
        }
      } else if (message === 'close') {
        setTimeout(function() {
          hideBrowserWindow(browserState);
        }, 0);
      }
    }
  });

  setThreadDictionaryObject(DELEGATE_IDENTIFIER, delegate);
  webView.setUIDelegate_(delegate.getClassInstance());
  webView.mainFrame().loadHTMLString_baseURL(html, scriptFolder);

  contentView.addSubview(webView);
  webViewWindow.center();
  webViewWindow.makeKeyAndOrderFront(nil);
  
  // Make webView first responder for keyboard input
  webViewWindow.makeFirstResponder(webView);

  // Start loading immediately; UI side already handles DOM-not-ready retries.
  focusBrowserSearch(webView, 'smart');
  loadSymbolsIntoBrowser(browserState, { showLoader: true });

  startDocumentSwitchWatcher(browserState);

}

function getAllSymbolsWithPreviews(document) {
  const symbols = [];
  
  // Get all enabled libraries once; this scan is the heaviest part of cold open.
  const enabledLibraries = getEnabledLibraries();
  const localSymbols = document.getSymbols();
  
  // Build lookup maps from libraries in a single pass and reuse the refs later.
  const librarySymbolMap = {}; // id -> {library, libraryName, name}
  const libraryRefById = {};
  const libraryBySymbolName = {};
  const libraryRefsByLibraryId = {};
  
  enabledLibraries.forEach(function(library) {
    try {
      const refs = library.getImportableSymbolReferencesForDocument(document);
      libraryRefsByLibraryId[getLibraryCacheKey(library)] = refs;
      refs.forEach(function(ref) {
        if (!libraryBySymbolName[ref.name]) {
          libraryBySymbolName[ref.name] = library;
        }
        librarySymbolMap[ref.id] = { library: library.id, libraryName: library.name, name: ref.name };
        libraryRefById[ref.id] = ref;
      });
    } catch (e) {
      log("Error getting refs from " + library.name + ": " + e);
    }
  });
  
  // Build Set of existing symbol names from document
  const existingSymbolNames = new Set();
  
  // Process document symbols - check by ID first, then by name
  localSymbols.forEach(function(symbolMaster, index) {
    const symbolName = symbolMaster.name;
    existingSymbolNames.add(symbolName);
    
    // First check by ID - if ID matches library, it's a library symbol
    const libInfoById = librarySymbolMap[symbolMaster.id];
    
    if (libInfoById) {
      // Symbol ID matches library - this is a library symbol
      verboseSymbolScanLog("DOC symbol ID matches library: " + symbolName + " -> " + libInfoById.libraryName);
      symbols.push({
        id: symbolMaster.id,
        name: symbolName,
        library: libInfoById.library,
        libraryName: libInfoById.libraryName,
        isOriginallyLocal: false,
        colorIndex: index % 10,
        preview: getCachedPreview(symbolMaster.id)
      });
    } else if (libraryBySymbolName[symbolName]) {
      // Name matches but ID doesn't - this is likely an imported copy from library
      const sourceLibrary = libraryBySymbolName[symbolName];
      
      if (sourceLibrary) {
        verboseSymbolScanLog("DOC symbol name matches library (imported copy): " + symbolName + " -> " + sourceLibrary.name);
        symbols.push({
          id: symbolMaster.id,
          name: symbolName,
          library: sourceLibrary.id,
          libraryName: sourceLibrary.name,
          isOriginallyLocal: false,
          colorIndex: index % 10,
          preview: getCachedPreview(symbolMaster.id)
        });
      } else {
        verboseSymbolScanLog("DOC symbol name matches library (but source unknown): " + symbolName + " -> Local");
        symbols.push({
          id: symbolMaster.id,
          name: symbolName,
          library: null,
          libraryName: 'Local',
          isOriginallyLocal: true,
          colorIndex: index % 10,
          preview: getCachedPreview(symbolMaster.id)
        });
      }
    } else {
      // Truly local symbol
      verboseSymbolScanLog("DOC truly local symbol: " + symbolName);
      symbols.push({
        id: symbolMaster.id,
        name: symbolName,
        library: null,
        libraryName: 'Local',
        isOriginallyLocal: true,
        colorIndex: index % 10,
        preview: getCachedPreview(symbolMaster.id)
      });
    }
  });

  // Add library symbols that are NOT yet imported
  enabledLibraries.forEach(function(library) {
    try {
      const refs = libraryRefsByLibraryId[getLibraryCacheKey(library)] || [];
      refs.forEach(function(ref, idx) {
        // Only add if not already in document
        if (!existingSymbolNames.has(ref.name)) {
          symbols.push({
            id: ref.id,
            name: ref.name,
            library: library.id,
            libraryName: library.name,
            isOriginallyLocal: false,
            colorIndex: (symbols.length + idx) % 10,
            preview: getCachedPreview(ref.id)
          });
        }
      });
    } catch (e) {
      log("Error getting refs from " + library.name + ": " + e);
    }
  });

  // Sort by name
  symbols.sort(function(a, b) {
    return a.name.localeCompare(b.name);
  });

  // Keep fast runtime lookup for preview generation
  symbolLookupCache.docId = getDocumentIdentifier(document);
  symbolLookupCache.localById = {};
  localSymbols.forEach(function(symbolMaster) {
    symbolLookupCache.localById[symbolMaster.id] = symbolMaster;
  });
  symbolLookupCache.libraryRefById = libraryRefById;

  log("Collected " + symbols.length + " symbols from " + localSymbols.length + " local symbols and " + enabledLibraries.length + " libraries");

  return symbols;
}

function getSymbolsJsonAsync(document, callback, shouldContinue, scanConfig) {
  const enabledLibraries = getEnabledLibraries();
  const localSymbols = document.getSymbols();
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
    symbolLookupCache.localById = {};
    localSymbols.forEach(function(symbolMaster) {
      symbolLookupCache.localById[symbolMaster.id] = symbolMaster;
    });
    symbolLookupCache.libraryRefById = libraryRefById;

    log("Collected " + symbols.length + " symbols from " + localSymbols.length + " local symbols and " + enabledLibraries.length + " libraries");
    callback(JSON.stringify(symbols), symbols.length, {
      enabledLibrarySignature: getEnabledLibrarySignatureFromLibraries(enabledLibraries),
      libraryEntries: libraryEntries,
      librarySymbolMap: librarySymbolMap,
      libraryBySymbolName: libraryBySymbolName,
      libraryRefById: libraryRefById
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
      const symbolMaster = localSymbols[i];
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

      // L2 cache hit: use the lean metadata. Live refs are NOT populated here
      // — they'll be lazily refilled by startLibraryRefsWarmup so previews can
      // resolve to MSShareableObjectReference objects. The downstream code
      // only reads .id and .name from libraryRefsByLibraryId[], so feeding
      // it the lean cache entries is correct.
      const cachedLib = getCachedLibrarySymbols(library);
      if (cachedLib) {
        const leanRefs = cachedLib.symbols;
        log("[Diag] L2 hit  '" + library.name + "' libId=" + library.id + " mtime=" + getLibraryVersionTag(library) + " refs=" + leanRefs.length);
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
          log("[Diag] L2 miss '" + library.name + "' libId=" + library.id + " mtime=" + getLibraryVersionTag(library) + " refs=" + refs.length + " (live scan)");
          libraryRefsByLibraryId[getLibraryCacheKey(library)] = refs;
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
  const localSymbols = document.getSymbols();
  const symbols = [];
  const existingSymbolNames = new Set();
  const effectiveLibraryScanData = libraryScanData || {};
  const librarySymbolMap = effectiveLibraryScanData.librarySymbolMap || {};
  const libraryBySymbolName = effectiveLibraryScanData.libraryBySymbolName || {};
  const libraryEntries = Array.isArray(effectiveLibraryScanData.libraryEntries) ? effectiveLibraryScanData.libraryEntries : [];
  const libraryRefById = effectiveLibraryScanData.libraryRefById || {};
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
    symbolLookupCache.localById = {};
    localSymbols.forEach(function(symbolMaster) {
      symbolLookupCache.localById[symbolMaster.id] = symbolMaster;
    });
    symbolLookupCache.libraryRefById = libraryRefById;

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
      const symbolMaster = localSymbols[i];
      const symbolName = symbolMaster.name;
      existingSymbolNames.add(symbolName);

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

function insertSymbol(symbolId, document, replace, targetLayers, preserveDims) {
  log("=== INSERT SYMBOL START: " + symbolId + " ===");
  
  // Find symbol master - check local symbols first
  let symbolMaster = null;
  
  // Try to find in local symbols by ID
  const localSymbols = document.getSymbols();
  log("Checking " + localSymbols.length + " local symbols by ID...");
  for (let i = 0; i < localSymbols.length; i++) {
    if (localSymbols[i].id === symbolId) {
      symbolMaster = localSymbols[i];
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
        const localSymbols = document.getSymbols();
        log("Current local symbols count: " + localSymbols.length);
        for (let i = 0; i < localSymbols.length; i++) {
          if (localSymbols[i].name === symbolName) {
            symbolMaster = localSymbols[i];
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
      UI.message("Symbol no longer in library — refreshing list");
    } else {
      UI.message("❌ Symbol not found");
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
      
      // Insert symbol at same index as target
      if (parent) {
        parent.addLayers([nativeInstance]);
        // Remove target layer
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

function sendPreviewToUI(webView, symbolId, preview) {
  if (!webView || !symbolId || !preview) return;
  webView.windowScriptObject().evaluateWebScript_('updateSymbolPreview("' + symbolId + '", "' + preview + '");');
}

function generateAndCachePreview(symbolId, document) {
  if (!symbolId) return null;

  const cached = getCachedPreview(symbolId);
  if (cached) return cached;

  if (inFlightPreviewBySymbol[symbolId]) {
    return null;
  }

  inFlightPreviewBySymbol[symbolId] = true;
  try {
    const generated = generatePreviewForSymbolSync(symbolId, document);
    if (generated) {
      setCachedPreview(symbolId, generated);
      return generated;
    }
    return null;
  } finally {
    delete inFlightPreviewBySymbol[symbolId];
  }
}

function processPreviewQueue() {
  if (isProcessingPreview || previewQueue.length === 0) return;
  
  isProcessingPreview = true;
  const item = previewQueue.shift();
  const { symbolId, document, requestDocId, webView, priority, browserState, reloadToken } = item;

  if (browserState && (browserState.closed || browserState.reloadToken !== reloadToken || browserState.docId !== requestDocId)) {
    isProcessingPreview = false;
    processPreviewQueue();
    return;
  }
  
  verbosePreviewLog("Processing preview for: " + symbolId + " (priority: " + priority + ")");
  
  // Generate preview
  const preview = generateAndCachePreview(symbolId, document);
  if (preview) {
    sendPreviewToUI(webView, symbolId, preview);
    verbosePreviewLog("Preview sent to UI for: " + symbolId);
  } else {
    verbosePreviewLog("Preview generation failed for: " + symbolId);
  }
  
  // Tiny yield between background items keeps UI responsive without adding visible lag.
  const delay = priority ? 0 : PREVIEW_QUEUE_DELAY_MS;
  setTimeout(function() {
    isProcessingPreview = false;
    processPreviewQueue();
  }, delay);
}

function queuePreviewRequest(symbolId, document, webView, priority, browserState) {
  const reloadToken = browserState ? browserState.reloadToken : 0;
  const requestDocId = getDocumentIdentifier(document) || (browserState ? browserState.docId : null);

  const cached = getCachedPreview(symbolId);
  if (cached) {
    if (!browserState || (!browserState.closed && browserState.reloadToken === reloadToken && browserState.docId === requestDocId)) {
      sendPreviewToUI(webView, symbolId, cached);
    }
    return;
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
      previewQueue.unshift(existingItem);
    }
    return;
  }

  const queueItem = { symbolId, document, requestDocId, webView, priority: priority === true, browserState, reloadToken };
  if (priority) {
    previewQueue.unshift(queueItem);
  } else {
    previewQueue.push(queueItem);
  }
  processPreviewQueue();
}

function generatePreviewForSymbolSync(symbolId, document) {
  ensureSymbolLookupCache(document);

  let localSymbol = symbolLookupCache.localById[symbolId] || null;
  let libraryRef = symbolLookupCache.libraryRefById[symbolId] || null;

  // Fallback scan if cache misses (can happen when symbols changed after initial load)
  if (!localSymbol) {
    const localSymbols = document.getSymbols();
    for (let i = 0; i < localSymbols.length; i++) {
      if (localSymbols[i].id === symbolId) {
        localSymbol = localSymbols[i];
        symbolLookupCache.localById[symbolId] = localSymbol;
        break;
      }
    }
  }

  if (!libraryRef) {
    try {
      const libraries = sketch.getLibraries();
      for (let i = 0; i < libraries.length; i++) {
        const library = libraries[i];
        if (!library.enabled) continue;
        const refs = library.getImportableSymbolReferencesForDocument(document);
        for (let j = 0; j < refs.length; j++) {
          if (refs[j].id === symbolId) {
            libraryRef = refs[j];
            symbolLookupCache.libraryRefById[symbolId] = libraryRef;
            break;
          }
        }
        if (libraryRef) break;
      }
    } catch (e) {
      log("Library ref fallback scan failed: " + e);
    }
  }

  const preview = generateSymbolPreview(localSymbol, libraryRef, PREVIEW_RENDER_SIZE, document, symbolId);
  if (preview) return preview;

  // Live libraries don't have this symbol but our cache claims they do →
  // the cache is stale. Find which L2 entry is lying, drop it (and L1),
  // so the next plugin open does a fresh scan. Sketch's
  // library.lastModifiedAt is unreliable for some library updates.
  const owner = findL2EntryForSymbolId(symbolId);
  if (owner) {
    log("[Stale] Preview lookup failed id=" + symbolId + " — L2 said '" + owner.name + "', purging cache");
    invalidateLibraryCachesByKey(owner.key);
  } else {
    log("Preview unavailable for symbol: " + symbolId);
  }
  return null;
}

function generateSymbolPreview(symbolMaster, symbolReference, size, document, symbolId) {
  try {
    if (!symbolMaster && !symbolReference) {
      return null;
    }

    // 1) Fast path via private/native preview APIs (no import, no file IO)
    const nativeSymbolMaster = symbolMaster ? (symbolMaster.sketchObject || symbolMaster) : null;
    const nativeSymbolReference = symbolReference ? (symbolReference.sketchObject || symbolReference) : null;
    const privatePreview = generatePreviewUsingPrivateAPI(nativeSymbolMaster, nativeSymbolReference, size);
    if (privatePreview) {
      return privatePreview;
    }

    // 2) Try resolving a master from the reference (without importing)
    let resolvedNativeMaster = nativeSymbolMaster;
    if (!resolvedNativeMaster && nativeSymbolReference) {
      resolvedNativeMaster = resolveNativeMasterFromReference(nativeSymbolReference);
    }

    // 3) Export fallback (in-memory first, then file fallback)
    const exportCandidate = symbolMaster || resolvedNativeMaster;
    if (exportCandidate) {
      const exportedPreview = exportSymbolToDataUrl(exportCandidate);
      if (exportedPreview) return exportedPreview;
    }

    // 4) Last-resort: import once per symbol for preview, then export
    if (!exportCandidate && symbolReference && symbolId && !importPreviewFallbackTried[symbolId]) {
      importPreviewFallbackTried[symbolId] = true;
      try {
        log("Preview fallback import for symbol: " + symbolId);
        const imported = symbolReference.import();
        if (imported) {
          invalidateSymbolLookupCache();
          invalidateSymbolsListCache();
          const importedPreview = exportSymbolToDataUrl(imported);
          if (importedPreview) return importedPreview;
        }
      } catch (e) {
        log("Preview fallback import failed: " + e);
      }
    }
    
    return null;
  } catch (e) {
    log("Preview error: " + e);
    return null;
  }
}

function resolveNativeMasterFromReference(nativeSymbolReference) {
  if (!nativeSymbolReference) return null;

  try {
    const selector = NSSelectorFromString("symbolMaster");
    if (nativeSymbolReference.respondsToSelector && nativeSymbolReference.respondsToSelector(selector)) {
      if (typeof nativeSymbolReference.symbolMaster === 'function') {
        const master = nativeSymbolReference.symbolMaster();
        if (master) return master;
      }
    }
  } catch (e) {
    log("resolveNativeMasterFromReference failed: " + e);
  }

  return null;
}

function exportSymbolToDataUrl(symbolLike) {
  const exportScale = getExportScaleForSymbol(symbolLike, PREVIEW_RENDER_SIZE);

  // In-memory export (preferred)
  try {
    const exportedData = sketch.export(symbolLike, {
      output: false,
      formats: "png",
      scales: exportScale,
      trimmed: true
    });
    const dataUrl = binaryToDataUrl(exportedData);
    if (dataUrl) return dataUrl;
  } catch (e) {
    log("In-memory export failed: " + e);
  }

  // File-based fallback for compatibility with older API/runtime behavior
  try {
    const tempDir = NSTemporaryDirectory();
    const fileName = "preview_" + Date.now() + "_" + Math.floor(Math.random() * 100000) + ".png";
    const filePath = tempDir.stringByAppendingPathComponent(fileName);
    sketch.export(symbolLike, {
      output: tempDir,
      filename: fileName,
      formats: "png",
      scales: exportScale,
      trimmed: true,
      overwriting: true
    });

    const fileManager = NSFileManager.defaultManager();
    if (fileManager.fileExistsAtPath(filePath)) {
      const imageData = NSData.dataWithContentsOfFile(filePath);
      if (imageData && imageData.length() > 0) {
        const base64String = imageData.base64EncodedStringWithOptions(0);
        try {
          fileManager.removeItemAtPath_error(filePath, null);
        } catch (cleanupErr) {}
        return "data:image/png;base64," + base64String;
      }
    }
  } catch (e) {
    log("File export fallback failed: " + e);
  }

  return null;
}

function getExportScaleForSymbol(symbolLike, targetSize) {
  const fallbackScale = "0.25";
  if (!symbolLike || !targetSize || targetSize <= 0) return fallbackScale;

  const dimensions = getSymbolDimensions(symbolLike);
  if (!dimensions) return fallbackScale;

  const maxDim = Math.max(dimensions.width, dimensions.height);
  if (!isFinite(maxDim) || maxDim <= 0) return fallbackScale;

  const rawScale = targetSize / maxDim;
  const clampedScale = Math.max(0.05, Math.min(rawScale, 4));
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

function binaryToResizedDataUrl(binaryData, size) {
  const nsData = extractNSDataFromBinary(binaryData);
  if (nsData) {
    const nsImage = NSImage.alloc().initWithData(nsData);
    const resizedDataUrl = convertNSImageToBase64(nsImage, size);
    if (resizedDataUrl) {
      return resizedDataUrl;
    }
  }
  return binaryToDataUrl(binaryData);
}

function extractNSDataFromBinary(binaryData) {
  try {
    let data = binaryData;
    if (Array.isArray(data)) {
      data = data[0];
    }
    if (!data) return null;

    if (data.base64EncodedStringWithOptions && data.length) {
      return data;
    }

    if (typeof data.toString === 'function') {
      const maybeBase64 = data.toString('base64');
      if (typeof maybeBase64 === 'string' && /^[A-Za-z0-9+/=]+$/.test(maybeBase64)) {
        return NSData.alloc().initWithBase64EncodedString_options(maybeBase64, 0);
      }
    }
  } catch (e) {
    log("extractNSDataFromBinary failed: " + e);
  }
  return null;
}

function generatePreviewUsingPrivateAPI(nativeSymbolMaster, nativeSymbolReference, size) {
  const colorSpace = getPreviewColorSpace();
  const previewSize = NSMakeSize(size, size);

  // Try existing reference first (works for library symbols without importing)
  const referencePreview = previewFromNativeObject(nativeSymbolReference, previewSize, colorSpace);
  if (referencePreview) return referencePreview;

  // Try symbol master directly
  const masterPreview = previewFromNativeObject(nativeSymbolMaster, previewSize, colorSpace);
  if (masterPreview) return masterPreview;

  // Try creating a shareable reference from local symbol master and preview through that
  if (nativeSymbolMaster) {
    const generatedRef = makeShareableReferenceFromMaster(nativeSymbolMaster);
    const generatedRefPreview = previewFromNativeObject(generatedRef, previewSize, colorSpace);
    if (generatedRefPreview) return generatedRefPreview;
  }

  return null;
}

function getPreviewColorSpace() {
  try {
    if (NSColorSpace && NSColorSpace.sRGBColorSpace) {
      return NSColorSpace.sRGBColorSpace();
    }
  } catch (e) {}

  try {
    if (NSColorSpace && NSColorSpace.deviceRGBColorSpace) {
      return NSColorSpace.deviceRGBColorSpace();
    }
  } catch (e) {}

  return null;
}

function makeShareableReferenceFromMaster(nativeSymbolMaster) {
  try {
    if (typeof MSShareableObjectReference === 'undefined' || !nativeSymbolMaster) {
      return null;
    }

    const refSelector = NSSelectorFromString("referenceForShareableObject:");
    if (MSShareableObjectReference.respondsToSelector(refSelector) && MSShareableObjectReference.referenceForShareableObject) {
      return MSShareableObjectReference.referenceForShareableObject(nativeSymbolMaster);
    }
  } catch (e) {
    log("Failed to create shareable reference: " + e);
  }

  return null;
}

function previewFromNativeObject(nativeObject, previewSize, colorSpace) {
  if (!nativeObject) return null;

  const methods = [
    {
      selector: "previewImageOfSize:colorSpace:clippingAsBorder:borderWidth:",
      method: "previewImageOfSize_colorSpace_clippingAsBorder_borderWidth",
      args: [previewSize, colorSpace, false, 0],
      needsTargetResolution: true
    },
    {
      selector: "previewImageForSize:colorSpace:",
      method: "previewImageForSize_colorSpace",
      args: [previewSize, colorSpace],
      needsTargetResolution: true
    },
    {
      selector: "previewImage",
      method: "previewImage",
      args: []
    },
    {
      selector: "cachedPreviewImage",
      method: "cachedPreviewImage",
      args: []
    }
  ];

  for (let i = 0; i < methods.length; i++) {
    try {
      const entry = methods[i];
      const selector = NSSelectorFromString(entry.selector);
      if (!nativeObject.respondsToSelector || !nativeObject.respondsToSelector(selector)) {
        continue;
      }
      if (typeof nativeObject[entry.method] !== 'function') {
        continue;
      }

      const image = nativeObject[entry.method].apply(nativeObject, entry.args);
      const pixelSize = (previewSize && previewSize.width) ? previewSize.width : 128;

      const maxImageDim = getNSImageMaxDimension(image);
      const isLastMethod = i === methods.length - 1;
      if (entry.needsTargetResolution && maxImageDim > 0 && maxImageDim < (pixelSize * 0.9) && !isLastMethod) {
        continue;
      }

      const dataUrl = convertNSImageToBase64(image, pixelSize);
      if (dataUrl) return dataUrl;
    } catch (e) {
      log("Private preview method failed (" + methods[i].selector + "): " + e);
    }
  }

  return null;
}

function getNSImageMaxDimension(nsImage) {
  try {
    if (!nsImage || typeof nsImage.size !== 'function') return 0;
    const size = nsImage.size();
    if (!size) return 0;
    const width = Number(size.width) || 0;
    const height = Number(size.height) || 0;
    return Math.max(width, height);
  } catch (e) {
    return 0;
  }
}

function binaryToDataUrl(binaryData) {
  try {
    let data = binaryData;
    if (Array.isArray(data)) {
      data = data[0];
    }
    if (!data) return null;

    if (data.base64EncodedStringWithOptions) {
      return "data:image/png;base64," + data.base64EncodedStringWithOptions(0);
    }

    if (typeof data.toString === 'function') {
      const maybeBase64 = data.toString('base64');
      if (typeof maybeBase64 === 'string' && /^[A-Za-z0-9+/=]+$/.test(maybeBase64)) {
        return "data:image/png;base64," + maybeBase64;
      }
    }
  } catch (e) {
    log("Binary conversion failed: " + e);
  }

  return null;
}

function convertNSImageToBase64(nsImage, size) {
  try {
    if (!nsImage) return null;
    
    // Resize image
    const originalSize = nsImage.size();
    const maxDim = Math.max(originalSize.width, originalSize.height);
    const scale = size / maxDim;
    
    const newWidth = originalSize.width * scale;
    const newHeight = originalSize.height * scale;
    
    const newSize = NSMakeSize(newWidth, newHeight);
    const resizedImage = NSImage.alloc().initWithSize(newSize);
    
    resizedImage.lockFocus();
    nsImage.drawInRect_fromRect_operation_fraction_(
      NSMakeRect(0, 0, newWidth, newHeight),
      NSMakeRect(0, 0, originalSize.width, originalSize.height),
      NSCompositeSourceOver,
      1.0
    );
    resizedImage.unlockFocus();
    
    // Convert to PNG
    const imageData = resizedImage.TIFFRepresentation();
    if (!imageData) return null;
    
    const imageRep = NSBitmapImageRep.imageRepWithData(imageData);
    if (!imageRep) return null;
    
    const pngData = imageRep.representationUsingType_properties_(
      NSBitmapImageFileTypePNG,
      {}
    );
    
    if (pngData && pngData.length() > 0) {
      const base64String = pngData.base64EncodedStringWithOptions(0);
      return "data:image/png;base64," + base64String;
    }
  } catch (e) {
    log("Image conversion error: " + e);
  }
  return null;
}

function closeWindow() {
  try {
    const threadDictionary = NSThread.mainThread().threadDictionary();
    const browserState = runtimeBrowserState;

    if (browserState) {
      destroyBrowserWindow(browserState);
    } else {
      const windowHandle = getThreadDictionaryObject(WINDOW_IDENTIFIER);
      if (!windowHandle) {
        return;
      }

      windowHandle.close();
      threadDictionary.removeObjectForKey(WINDOW_IDENTIFIER);
      threadDictionary.removeObjectForKey(DELEGATE_IDENTIFIER);
    }
  } catch (e) {
    log("Window close error (ignored): " + e);
  }
}
