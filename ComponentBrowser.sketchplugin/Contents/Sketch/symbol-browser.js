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
const PREVIEW_CACHE_KEY = "com.funkyplugins.componentbrowser.previewCache.v2";
const PREVIEW_RENDER_SIZE = 64;
const PREVIEW_QUEUE_DELAY_MS = 8;
const PRIORITY_PREVIEW_DEBOUNCE_MS = 140;

const symbolLookupCache = {
  docId: null,
  localById: {},
  libraryRefById: {}
};
const importPreviewFallbackTried = {};

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
  const threadDictionary = NSThread.mainThread().threadDictionary();
  let cache = null;

  try {
    if (threadDictionary.objectForKey) {
      cache = threadDictionary.objectForKey(PREVIEW_CACHE_KEY);
    } else {
      cache = threadDictionary[PREVIEW_CACHE_KEY];
    }
  } catch (e) {
    cache = null;
  }

  const isMutableDictionary = cache
    && typeof cache.objectForKey === 'function'
    && typeof cache.setObject_forKey === 'function';

  if (!isMutableDictionary) {
    const migrated = NSMutableDictionary.dictionary();

    // Migrate plain JS object cache if it exists.
    if (cache && typeof cache === 'object' && !Array.isArray(cache)) {
      Object.keys(cache).forEach(function(key) {
        const value = cache[key];
        if (value) {
          migrated.setObject_forKey(String(value), String(key));
        }
      });
    }

    if (threadDictionary.setObject_forKey) {
      threadDictionary.setObject_forKey(migrated, PREVIEW_CACHE_KEY);
    } else {
      threadDictionary[PREVIEW_CACHE_KEY] = migrated;
    }
    cache = migrated;
  }

  return cache;
}

function getCachedPreview(symbolId) {
  if (!symbolId) return null;

  const cache = getOrCreatePreviewCache();
  try {
    const value = cache.objectForKey(String(symbolId));
    return value ? String(value) : null;
  } catch (e) {
    return null;
  }
}

function setCachedPreview(symbolId, preview) {
  if (!symbolId || !preview) return;

  const cache = getOrCreatePreviewCache();
  try {
    cache.setObject_forKey(String(preview), String(symbolId));
  } catch (e) {
    log("Failed to write preview cache for " + symbolId + ": " + e);
  }
}

function onRun(context) {
  log("=== Component Browser Started ===");
  
  const threadDictionary = NSThread.mainThread().threadDictionary();
  const identifier = "com.funkyplugins.componentbrowser.window";
  const delegateIdentifier = "com.funkyplugins.componentbrowser.delegate";

  // Get document first (needed for document change detection)
  const document = sketch.getSelectedDocument();
  if (!document) {
    UI.message("❌ No document open");
    return;
  }
  
  // Get current document ID (extract UUID from sketchObject)
  const currentDocId = getDocumentIdentifier(document);
  
  // Get last document ID (if any) - convert to JS string and clear old format if needed
  let lastDocId = threadDictionary["com.funkyplugins.componentbrowser.lastDocId"];
  if (lastDocId) {
    lastDocId = String(lastDocId); // Convert NSString to JS string
    if (lastDocId.includes('<MSDocument:')) {
      // Old format, extract UUID or clear it
      const oldMatch = lastDocId.match(/\(([a-f0-9-]+)\)/i);
      lastDocId = oldMatch ? oldMatch[1] : null;
    }
  }
  
  // Check if window exists
  const existingWindow = threadDictionary[identifier];
  
  // If document changed and window exists, close it to recreate with new symbols
  if (existingWindow && lastDocId && lastDocId !== currentDocId) {
    log("Document changed, recreating window");
    existingWindow.close();
    threadDictionary.removeObjectForKey(identifier);
    threadDictionary.removeObjectForKey(delegateIdentifier);
    // Continue to create new window
  } else if (existingWindow) {
    // Same document, reload symbols and bring to front
    existingWindow.makeKeyAndOrderFront(nil);
    const webView = existingWindow.contentView().subviews().firstObject();
    if (webView) {
      // Focus and select immediately (don't wait for reload)
      webView.windowScriptObject().evaluateWebScript_('document.getElementById("searchInput").focus(); document.getElementById("searchInput").select();');
      // Show loader and reload symbols asynchronously in background
      webView.windowScriptObject().evaluateWebScript_('window.setLoading(true);');
      setTimeout(function() {
        const symbols = getAllSymbolsWithPreviews(document);
        const symbolsJson = JSON.stringify(symbols);
        webView.windowScriptObject().evaluateWebScript_('window.loadSymbols(' + symbolsJson + ', "");');
        log("Window already open, reloading " + symbols.length + " symbols");
      }, 10);
    } else {
      log("Window already open, bringing to front");
    }
    return;
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
  
  // Hide titlebar buttons; close via Esc inside the UI.
  webViewWindow.standardWindowButton(NSWindowCloseButton).setHidden(true);
  webViewWindow.standardWindowButton(NSWindowMiniaturizeButton).setHidden(true);
  webViewWindow.standardWindowButton(NSWindowZoomButton).setHidden(true);

  webViewWindow.becomeKeyWindow();
  webViewWindow.setLevel(NSFloatingWindowLevel);
  threadDictionary[identifier] = webViewWindow;
  threadDictionary["com.funkyplugins.componentbrowser.lastDocId"] = currentDocId;
  COScript.currentCOScript().setShouldKeepAround_(true);

  const scriptFolder = context.scriptURL.URLByDeletingLastPathComponent();
  const htmlUrl = scriptFolder.URLByAppendingPathComponent("symbol-browser-ui.html");
  const htmlData = NSData.dataWithContentsOfURL(htmlUrl);
  const html = NSString.alloc().initWithData_encoding(htmlData, NSUTF8StringEncoding);

  // WebView covers entire window including titlebar area
  const webView = WebView.alloc().initWithFrame(NSMakeRect(0, 0, windowWidth, windowHeight));
  webView.setDrawsBackground(true);

  const delegate = new MochaJSDelegate({
    "webView:runJavaScriptAlertPanelWithMessage:initiatedByFrame:": function(webView, message, frame) {
      // log("Received message: " + message);
      if (message.startsWith('insert-symbol:')) {
        try {
          const symbolId = message.substring(14);
          insertSymbol(symbolId, document, false, null, false);
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
          // Get ALL CURRENT selected layers (not cached) for replacement
          const currentSelection = document.selectedLayers.layers;
          insertSymbol(symbolId, document, true, currentSelection, preserveDims);
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
      } else if (message.startsWith('get-preview:')) {
        // Generate list thumbnails in background queue
        const symbolId = message.substring(12);
        log("Preview requested for: " + symbolId);
        queuePreviewRequest(symbolId, document, webView, false);
      } else if (message === 'close') {
        try {
          if (COScript.currentCOScript()) {
            COScript.currentCOScript().setShouldKeepAround(false);
          }
        } catch (e) {}
        threadDictionary.removeObjectForKey(identifier);
        threadDictionary.removeObjectForKey(delegateIdentifier);
        webViewWindow.close();
      }
    }
  });

  threadDictionary[delegateIdentifier] = delegate;
  webView.setUIDelegate_(delegate.getClassInstance());
  webView.mainFrame().loadHTMLString_baseURL(html, scriptFolder);

  webViewWindow.contentView().addSubview(webView);
  webViewWindow.center();
  webViewWindow.makeKeyAndOrderFront(nil);
  
  // Make webView first responder for keyboard input
  webViewWindow.makeFirstResponder(webView);

  // Focus search input and start loading symbols after page loads
  setTimeout(function() {
    webView.windowScriptObject().evaluateWebScript_('setTimeout(function() { var el = document.getElementById("searchInput"); if (el) { el.focus(); el.select(); } }, 200);');
    
    // Show loader and load symbols asynchronously
    webView.windowScriptObject().evaluateWebScript_('window.setLoading(true);');
    
    setTimeout(function() {
      const symbols = getAllSymbolsWithPreviews(document);
      log("Found " + symbols.length + " symbols");
      
      if (symbols.length === 0) {
        webView.windowScriptObject().evaluateWebScript_('window.setLoading(false); window.loadSymbols([], "");');
        UI.message("❌ No symbols found");
      } else {
        const symbolsJson = JSON.stringify(symbols);
        webView.windowScriptObject().evaluateWebScript_('window.loadSymbols(' + symbolsJson + ', "");');
      }
    }, 50);
  }, 300);

}

function getAllSymbolsWithPreviews(document) {
  const symbols = [];
  
  // Get all enabled libraries
  const libraries = sketch.getLibraries();
  const enabledLibraries = libraries.filter(function(lib) { return lib.enabled; });
  const localSymbols = document.getSymbols();
  
  // Build lookup maps from libraries (single pass)
  const librarySymbolNames = new Set();
  const librarySymbolMap = {}; // id -> {library, libraryName, name}
  const libraryRefById = {};
  
  enabledLibraries.forEach(function(library) {
    try {
      const refs = library.getImportableSymbolReferencesForDocument(document);
      refs.forEach(function(ref) {
        librarySymbolNames.add(ref.name);
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
      log("DOC symbol ID matches library: " + symbolName + " -> " + libInfoById.libraryName);
      symbols.push({
        id: symbolMaster.id,
        name: symbolName,
        library: libInfoById.library,
        libraryName: libInfoById.libraryName,
        isOriginallyLocal: false,
        colorIndex: index % 10,
        preview: getCachedPreview(symbolMaster.id)
      });
    } else if (librarySymbolNames.has(symbolName)) {
      // Name matches but ID doesn't - this is likely an imported copy from library
      // Find which library this symbol belongs to by name
      let sourceLibrary = null;
      for (let i = 0; i < enabledLibraries.length; i++) {
        try {
          const refs = enabledLibraries[i].getImportableSymbolReferencesForDocument(document);
          for (let j = 0; j < refs.length; j++) {
            if (refs[j].name === symbolName) {
              sourceLibrary = enabledLibraries[i];
              break;
            }
          }
          if (sourceLibrary) break;
        } catch (e) {}
      }
      
      if (sourceLibrary) {
        log("DOC symbol name matches library (imported copy): " + symbolName + " -> " + sourceLibrary.name);
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
        log("DOC symbol name matches library (but source unknown): " + symbolName + " -> Local");
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
      log("DOC truly local symbol: " + symbolName);
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
      const refs = library.getImportableSymbolReferencesForDocument(document);
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

  return symbols;
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
    UI.message("❌ Symbol not found");
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
  const threadDictionary = NSThread.mainThread().threadDictionary();
  const win = threadDictionary["com.funkyplugins.componentbrowser.window"];
  if (win) {
    win.close();
  }
}

// Preview queue for throttling
const previewQueue = [];
let isProcessingPreview = false;
let latestPriorityRequestToken = 0;
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
  const { symbolId, document, webView, priority } = item;
  
  log("Processing preview for: " + symbolId + " (priority: " + priority + ")");
  
  // Generate preview
  const preview = generateAndCachePreview(symbolId, document);
  if (preview) {
    sendPreviewToUI(webView, symbolId, preview);
    log("Preview sent to UI for: " + symbolId);
  } else {
    log("Preview generation failed for: " + symbolId);
  }
  
  // Tiny yield between background items keeps UI responsive without adding visible lag.
  const delay = priority ? 0 : PREVIEW_QUEUE_DELAY_MS;
  setTimeout(function() {
    isProcessingPreview = false;
    processPreviewQueue();
  }, delay);
}

function queuePreviewRequest(symbolId, document, webView, priority) {
  const cached = getCachedPreview(symbolId);
  if (cached) {
    sendPreviewToUI(webView, symbolId, cached);
    return;
  }

  // For priority (selected symbol), generate async to not block UI
  if (priority) {
    const requestToken = ++latestPriorityRequestToken;
    log("Queueing priority preview for selected: " + symbolId + " (token: " + requestToken + ")");
    // Debounce fast selection changes: process only the newest symbol.
    setTimeout(function() {
      if (requestToken !== latestPriorityRequestToken) {
        return;
      }

      const preview = generateAndCachePreview(symbolId, document);
      if (preview) {
        sendPreviewToUI(webView, symbolId, preview);
      }
    }, PRIORITY_PREVIEW_DEBOUNCE_MS);
    return;
  }
  
  // Background previews use queue
  const exists = previewQueue.some(item => item.symbolId === symbolId);
  if (!exists) {
    previewQueue.push({ symbolId, document, webView, priority: false });
    processPreviewQueue();
  }
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

  log("Preview unavailable for symbol: " + symbolId);
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
    const identifier = "com.funkyplugins.componentbrowser.window";
    const delegateIdentifier = "com.funkyplugins.componentbrowser.delegate";
    
    if (threadDictionary[identifier]) {
      if (COScript.currentCOScript()) {
        COScript.currentCOScript().setShouldKeepAround(false);
      }
      threadDictionary[identifier].close();
      threadDictionary.removeObjectForKey(identifier);
      threadDictionary.removeObjectForKey(delegateIdentifier);
    }
  } catch (e) {
    log("Window close error (ignored): " + e);
  }
}
