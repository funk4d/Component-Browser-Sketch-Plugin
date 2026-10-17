// Event handlers stay deliberately tiny. The resident hotkey context performs
// debounced count work; editing a document never starts a component scan here.
function markComponentCountDirty() {
  NSThread.mainThread().threadDictionary().setObject_forKey_(
    String(Date.now()), 'com.funkyplugins.componentbrowser.stable.countDirty');
}

function onDocumentChanged(context) {
  const changes = context.actionContext;
  const count = changes && (typeof changes.count === 'function' ? Number(changes.count()) : Number(changes.length || 0));
  if (count > 0) markComponentCountDirty();
}

function onDocumentLifecycle(context) {
  markComponentCountDirty();
}
