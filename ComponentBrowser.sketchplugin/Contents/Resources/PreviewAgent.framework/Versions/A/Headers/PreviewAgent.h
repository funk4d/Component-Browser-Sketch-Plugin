//
//  PreviewAgent.h
//  Low-priority preview prewarmer for the Component Browser plugin.
//
//  The worker groups missing preview IDs by saved local library and calls the
//  bundled Sketch `sketchtool` CLI at low process priority. Sketch stays
//  responsive because rendering happens in a child process, not on its UI
//  thread. The resulting PNGs are written into the plugin's ~/Library/Caches
//  directory.
//

#import <Foundation/Foundation.h>

// Kept for binary compatibility. Results are delivered through
// takeCompletedPreviewsJSON; the worker does not invoke these callbacks.
@protocol CBStablePreviewAgentDelegate <NSObject>
@optional
// Called on the main thread after one preview is rendered and persisted.
- (void)previewAgentDidRenderSymbol:(NSString *)symbolId
                               path:(NSString *)pngPath
                         versionTag:(NSString *)versionTag;
// Called on the main thread when the pending queue is drained.
- (void)previewAgentDidFinishQueueWithCount:(NSUInteger)totalRendered;
@end

@interface CBStablePreviewAgent : NSObject

// Process-wide instance. Sketch loads Startup and Launch handlers in separate
// CocoaScript contexts, so the native worker must be shared across them.
+ (instancetype)agent;
// Cheap metadata snapshot: one native-to-JS crossing instead of constructing
// a Sketch DOM wrapper for every component during counts/freshness checks.
+ (NSString *)componentSummaryJSONForModels:(NSArray *)models;
// Nonblocking metadata request. nil while the low-priority worker indexes the
// archive; then lean [{id,name}] JSON. Never loads a Sketch library on the UI.
- (NSString *)componentMetadataJSONForLibraryPath:(NSString *)path version:(NSString *)version;

@property (nonatomic, strong) id<CBStablePreviewAgentDelegate> delegate;

// Where PNG files are written. Must be set before -start.
@property (nonatomic, copy) NSString *cacheDirectory;
@property (nonatomic, copy) NSString *sketchtoolPath;

// Square preview size in pixels (default 128).
@property (nonatomic, assign) NSInteger renderSize;

// JS hands us the work list. Each item is an NSDictionary with keys:
//   "symbolId"    NSString  — Sketch symbol UUID
//   "libraryID"   NSString  — owning library UUID
//   "libraryName" NSString  — display name (for logging only)
//   "versionTag"  NSString  — passed through to the delegate as proof of freshness
// Replaces any existing queue.
- (void)setPendingItems:(NSArray<NSDictionary *> *)items;

// Promote an already queued preview so it may render while the browser is
// visible. The worker still runs sketchtool at low priority off Sketch's UI
// thread.
- (BOOL)requestPreviewForSymbolID:(NSString *)symbolId;

// Read completed file metadata as JSON. No native-to-JavaScript callbacks:
// Mocha dynamic delegates can recurse while unboxing asynchronous arguments.
- (NSString *)takeCompletedPreviewsJSON;
// Each CocoaScript context keeps its own cursor; Startup must not consume the
// visible browser's results. Entries include a monotonically increasing sequence.
- (NSString *)completedPreviewsJSONAfterSequence:(NSUInteger)sequence;

// Pacing between export batches. Defaults: idle=60s, foreground=60ms.
- (void)setIntervalFastMs:(NSInteger)fast slowMs:(NSInteger)slow;

// While the browser is visible, process only explicitly requested previews,
// up to six per batch. Idle prewarming resumes when the window is hidden.
- (void)setForegroundActive:(BOOL)active;

- (void)start;
- (void)stop;

// Quick disk check used by JS to avoid scheduling already-cached symbols.
- (BOOL)hasCachedPreviewForSymbol:(NSString *)symbolId;

@end
