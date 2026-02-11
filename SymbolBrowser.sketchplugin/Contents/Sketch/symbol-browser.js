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
  const docStr = String(document.sketchObject);
  const uuidMatch = docStr.match(/\(([a-f0-9-]+)\)/i);
  const currentDocId = uuidMatch ? uuidMatch[1] : docStr;
  
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
  
  // Hide all window buttons
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
        // Preview disabled - ignore these messages
        // log("Preview request ignored: " + message.substring(12));
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

  const closeButton = webViewWindow.standardWindowButton(NSWindowCloseButton);
  closeButton.setCOSJSTargetFunction(function() {
    // Save search before closing
    webView.windowScriptObject().evaluateWebScript_('(function() { var el = document.getElementById("searchInput"); return el ? el.value : ""; })();');
    try {
      if (COScript.currentCOScript()) {
        COScript.currentCOScript().setShouldKeepAround(false);
      }
    } catch (e) {}
    threadDictionary.removeObjectForKey(identifier);
    threadDictionary.removeObjectForKey(delegateIdentifier);
    webViewWindow.close();
  });
  closeButton.setAction("callAction:");
}

function getAllSymbolsWithPreviews(document) {
  const symbols = [];
  
  // Get all enabled libraries
  const libraries = sketch.getLibraries();
  const enabledLibraries = libraries.filter(function(lib) { return lib.enabled; });
  
  // Build Set of all library symbol names for fast lookup
  const librarySymbolNames = new Set();
  const librarySymbolMap = {}; // name -> {library, libraryName}
  
  enabledLibraries.forEach(function(library) {
    try {
      const refs = library.getImportableSymbolReferencesForDocument(document);
      refs.forEach(function(ref) {
        librarySymbolNames.add(ref.name);
        librarySymbolMap[ref.name] = { library: library.id, libraryName: library.name };
      });
    } catch (e) {
      log("Error getting refs from " + library.name + ": " + e);
    }
  });
  
  // Build Set of existing symbol names from document
  const existingSymbolNames = new Set();
  
  // Process document symbols - check against library names
  document.getSymbols().forEach(function(symbolMaster, index) {
    const symbolName = symbolMaster.name;
    existingSymbolNames.add(symbolName);
    
    // Check if symbol name exists in library refs
    if (librarySymbolNames.has(symbolName)) {
      // Symbol is from a library
      const libInfo = librarySymbolMap[symbolName];
      symbols.push({
        id: symbolMaster.id,
        name: symbolName,
        library: libInfo.library,
        libraryName: libInfo.libraryName,
        isOriginallyLocal: false,
        colorIndex: index % 10,
        preview: null
      });
    } else {
      // Truly local symbol
      symbols.push({
        id: symbolMaster.id,
        name: symbolName,
        library: null,
        libraryName: 'Local',
        isOriginallyLocal: true,
        colorIndex: index % 10,
        preview: null
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
            preview: null
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

  return symbols;
}

function insertSymbol(symbolId, document, replace, targetLayers, preserveDims) {
  log("Inserting symbol: " + symbolId + (replace ? " (replace mode, preserve=" + preserveDims + ")" : ""));
  
  // Find symbol master - check local symbols first
  let symbolMaster = null;
  
  // Try to find in local symbols
  const localSymbols = document.getSymbols();
  for (let i = 0; i < localSymbols.length; i++) {
    if (localSymbols[i].id === symbolId) {
      symbolMaster = localSymbols[i];
      break;
    }
  }
  
  // If not found locally, try to import from libraries
  if (!symbolMaster) {
    try {
      const libraries = sketch.getLibraries();
      for (let i = 0; i < libraries.length; i++) {
        const library = libraries[i];
        if (library.enabled) {
          const refs = library.getImportableSymbolReferencesForDocument(document);
          for (let j = 0; j < refs.length; j++) {
            if (refs[j].id === symbolId) {
              // Import the symbol master into the document
              symbolMaster = refs[j].import();
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
    UI.message("❌ Symbol not found");
    return;
  }

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
  const win = threadDictionary["com.funkyplugins.symbolbrowser.window"];
  if (win) {
    win.close();
  }
}

// Preview queue for throttling
const previewQueue = [];
let isProcessingPreview = false;

function processPreviewQueue() {
  if (isProcessingPreview || previewQueue.length === 0) return;
  
  isProcessingPreview = true;
  const item = previewQueue.shift();
  const { symbolId, document, webView } = item;
  
  // Generate preview
  const preview = generatePreviewForSymbolSync(symbolId, document);
  if (preview && webView) {
    webView.windowScriptObject().evaluateWebScript_('updateSymbolPreview("' + symbolId + '", "' + preview + '");');
  }
  
  // Process next after short delay
  setTimeout(function() {
    isProcessingPreview = false;
    processPreviewQueue();
  }, 50); // 50ms between previews
}

function queuePreviewRequest(symbolId, document, webView, priority) {
  // Check if already in queue
  const exists = previewQueue.some(item => item.symbolId === symbolId);
  if (!exists) {
    // Priority items (for immediate actions) go to front of queue
    const item = { symbolId, document, webView, priority: priority || false };
    if (priority) {
      previewQueue.unshift(item);
    } else {
      previewQueue.push(item);
    }
    processPreviewQueue();
  }
}

function generatePreviewForSymbolSync(symbolId, document) {
  // Find symbol master
  let symbolMaster = null;
  
  // Try local symbols first
  const localSymbols = document.getSymbols();
  for (let i = 0; i < localSymbols.length; i++) {
    if (localSymbols[i].id === symbolId) {
      symbolMaster = localSymbols[i];
      break;
    }
  }
  
  // If not found locally, import from library
  if (!symbolMaster) {
    try {
      const libraries = sketch.getLibraries();
      for (let i = 0; i < libraries.length; i++) {
        const library = libraries[i];
        if (library.enabled) {
          const refs = library.getImportableSymbolReferencesForDocument(document);
          for (let j = 0; j < refs.length; j++) {
            if (refs[j].id === symbolId) {
              symbolMaster = refs[j].import();
              break;
            }
          }
          if (symbolMaster) break;
        }
      }
    } catch (e) {
      log("Error importing symbol for preview: " + e);
    }
  }
  
  if (symbolMaster) {
    return generateSymbolPreview(symbolMaster, 24);
  }
  return null;
}

function generateSymbolPreview(symbolMaster, size) {
  try {
    const nativeMaster = symbolMaster.sketchObject;
    if (!nativeMaster) return null;
    
    // Get symbol frame
    const frame = nativeMaster.frame();
    const width = frame.width();
    const height = frame.height();
    
    if (width === 0 || height === 0) return null;
    
    // Calculate scale to fit desired size
    const maxDim = Math.max(width, height);
    const scale = size / maxDim;
    
    // Create temp file path
    const tempDir = NSTemporaryDirectory();
    const fileName = "preview_" + nativeMaster.objectID() + ".png";
    const exportPath = tempDir.stringByAppendingPathComponent(fileName);
    
    // Export using sketch.export with filename (like dockpreview plugin)
    const wasExported = sketch.export(symbolMaster, {
      output: tempDir,
      filename: fileName,
      formats: 'png',
      scales: String(scale),
      overwriting: true
    });
    
    if (!wasExported) {
      return null;
    }
    
    // Read the exported file
    const imageData = NSData.dataWithContentsOfFile(exportPath);
    
    // Clean up
    NSFileManager.defaultManager().removeItemAtPath_error(exportPath, null);
    
    if (imageData && imageData.length() > 0) {
      const base64String = imageData.base64EncodedStringWithOptions(0);
      return "data:image/png;base64," + base64String;
    }
  } catch (e) {
    log("Preview error: " + e);
  }
  return null;
}

function closeWindow() {
  try {
    const threadDictionary = NSThread.mainThread().threadDictionary();
    const identifier = "com.funkyplugins.symbolbrowser.window";
    const delegateIdentifier = "com.funkyplugins.symbolbrowser.delegate";
    
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
