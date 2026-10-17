//
//  PreviewAgent.m
//

#import "PreviewAgent.h"
#import <Cocoa/Cocoa.h>
#import <ImageIO/ImageIO.h>
#import <stdarg.h>
#import <math.h>

@interface CBStablePreviewAgent () {
    NSThread *_workerThread;
    NSMutableArray<NSDictionary *> *_queue;
    NSUInteger _cursor;
    BOOL _foregroundActive;
    NSInteger _intervalFastMs;
    NSInteger _intervalSlowMs;
    NSUInteger _batchSize;
    NSUInteger _totalRendered;
    volatile BOOL _stopRequested;
    BOOL _queueFinishedNotified;
    NSTask *_activeTask;
    NSMutableArray<NSDictionary *> *_completedPreviews;
    NSMutableSet<NSString *> *_foregroundRequestedSymbolIDs;
    NSMutableSet<NSString *> *_activeSymbolIDs;
    NSCondition *_workCondition;
    NSUInteger _workSignalVersion;
    NSUInteger _completionSequence;
    NSMutableDictionary<NSString *, NSDictionary *> *_sourceIndexes;
    NSMutableArray<NSDictionary *> *_metadataRequests;
    NSMutableSet<NSString *> *_metadataPending;
    NSMutableDictionary<NSString *, NSString *> *_metadataResults;
}
@end

static void CBLog(NSString *format, ...) {
    va_list args;
    va_start(args, format);
    NSString *message = [[NSString alloc] initWithFormat:format arguments:args];
    va_end(args);
    NSString *line = [@"[CBStablePreviewAgent] " stringByAppendingString:message ?: @""];
    NSLog(@"%@", line);
}

@implementation CBStablePreviewAgent

+ (NSString *)componentSummaryJSONForModels:(NSArray *)models {
    @autoreleasepool {
        NSMutableArray *rows = [NSMutableArray arrayWithCapacity:models.count];
        @try {
            for (id model in models) {
                id immutable = [model valueForKey:@"immutableModelObject"];
                [rows addObject:@{
                    @"id": [model valueForKey:@"objectID"] ?: @"",
                    @"name": [model valueForKey:@"name"] ?: @"",
                    @"componentId": [model valueForKey:@"symbolID"] ?: @"",
                    @"_revision": [NSString stringWithFormat:@"%lu", (unsigned long)[immutable hash]]
                }];
            }
            NSData *data = [NSJSONSerialization dataWithJSONObject:rows options:0 error:nil];
            return data ? [[NSString alloc] initWithData:data encoding:NSUTF8StringEncoding] : nil;
        } @catch (NSException *exception) {
            CBLog(@"component summary unavailable: %@", exception.reason);
            return nil;
        }
    }
}

+ (instancetype)agent {
    static CBStablePreviewAgent *sharedAgent = nil;
    static dispatch_once_t onceToken;
    dispatch_once(&onceToken, ^{
        sharedAgent = [[self alloc] init];
    });
    return sharedAgent;
}

- (instancetype)init {
    if ((self = [super init])) {
        _queue = [NSMutableArray array];
        _completedPreviews = [NSMutableArray array];
        _foregroundRequestedSymbolIDs = [NSMutableSet set];
        _activeSymbolIDs = [NSMutableSet set];
        _workCondition = [[NSCondition alloc] init];
        _sourceIndexes = [NSMutableDictionary dictionary];
        _metadataRequests = [NSMutableArray array];
        _metadataPending = [NSMutableSet set];
        _metadataResults = [NSMutableDictionary dictionary];
        _intervalFastMs = 60000;
        _intervalSlowMs = 60;
        _batchSize = 8;
        _renderSize = 128;
    }
    return self;
}

#pragma mark - Public API

- (NSString *)componentMetadataJSONForLibraryPath:(NSString *)path version:(NSString *)version {
    if (!path.length) return nil;
    NSString *key = [NSString stringWithFormat:@"%@|%@", path, version ?: @""];
    @synchronized (self) {
        if (_metadataResults[key]) return _metadataResults[key];
        if (![_metadataPending containsObject:key]) {
            [_metadataPending addObject:key];
            [_metadataRequests addObject:@{@"key": key, @"path": path, @"version": version ?: @""}];
            [self _signalWorker];
        }
    }
    return nil;
}

- (BOOL)_processOneMetadataRequest {
    NSDictionary *request = nil;
    @synchronized (self) {
        if (_metadataRequests.count) {
            request = _metadataRequests.firstObject;
            [_metadataRequests removeObjectAtIndex:0];
        }
    }
    if (!request) return NO;
    NSDictionary *index = [self _sourceIndexForPath:request[@"path"] version:request[@"version"]];
    NSArray *rows = index[@"components"];
    NSData *data = rows ? [NSJSONSerialization dataWithJSONObject:rows options:0 error:nil] : nil;
    @synchronized (self) {
        if (data) _metadataResults[request[@"key"]] = [[NSString alloc] initWithData:data encoding:NSUTF8StringEncoding];
        [_metadataPending removeObject:request[@"key"]];
        if (_metadataResults.count > 32) [_metadataResults removeObjectForKey:_metadataResults.allKeys.firstObject];
    }
    return YES;
}

- (void)setIntervalFastMs:(NSInteger)fast slowMs:(NSInteger)slow {
    @synchronized (self) {
        _intervalFastMs = fast > 0 ? fast : _intervalFastMs;
        _intervalSlowMs = slow > 0 ? slow : _intervalSlowMs;
    }
}

- (void)_signalWorker {
    [_workCondition lock];
    _workSignalVersion++;
    [_workCondition signal];
    [_workCondition unlock];
}

- (void)setForegroundActive:(BOOL)active {
    @synchronized (self) {
        _foregroundActive = active;
    }
    [self _signalWorker];
}

- (void)setPendingItems:(NSArray<NSDictionary *> *)items {
    BOOL changed = YES;
    NSUInteger pendingCount = 0;
    @synchronized (self) {
        NSMutableArray<NSDictionary *> *uniqueItems = [NSMutableArray array];
        NSMutableSet<NSString *> *seenIDs = [NSMutableSet set];
        for (NSDictionary *item in items ?: @[]) {
            NSString *symbolId = [item[@"symbolId"] isKindOfClass:[NSString class]] ? item[@"symbolId"] : nil;
            if (!symbolId.length || [seenIDs containsObject:symbolId] || [_activeSymbolIDs containsObject:symbolId]) continue;
            [seenIDs addObject:symbolId];
            [uniqueItems addObject:item];
        }
        pendingCount = _queue.count >= _cursor ? _queue.count - _cursor : 0;
        if (pendingCount == uniqueItems.count) {
            changed = NO;
            for (NSUInteger i = 0; i < uniqueItems.count; i++) {
                if (![_queue[_cursor + i] isEqualToDictionary:uniqueItems[i]]) {
                    changed = YES;
                    break;
                }
            }
        }
        if (changed) {
            [_queue setArray:uniqueItems];
            _cursor = 0;
            // A metadata refresh may reorder the queue after visible requests
            // arrive. Keep those requests when their components still exist.
            [_foregroundRequestedSymbolIDs intersectSet:seenIDs];
            _queueFinishedNotified = NO;
            _totalRendered = 0;
            pendingCount = uniqueItems.count;
        }
    }
    if (changed) {
        CBLog(@"queue set: %lu items", (unsigned long)pendingCount);
        [self _signalWorker];
    } else {
        CBLog(@"queue unchanged: %lu pending items", (unsigned long)pendingCount);
    }
}

- (BOOL)requestPreviewForSymbolID:(NSString *)symbolId {
    if (![symbolId isKindOfClass:[NSString class]] || symbolId.length == 0) return NO;
    BOOL found = NO;
    @synchronized (self) {
        if ([_activeSymbolIDs containsObject:symbolId]) return YES;
        for (NSUInteger i = 0; i < _queue.count; i++) {
            NSDictionary *item = _queue[i];
            if (![item[@"symbolId"] isEqualToString:symbolId]) continue;
            if (i < _cursor) {
                // A prior export may have failed or the OS may have evicted a
                // cached file. Permit an explicit miss to retry that item.
                [_queue removeObjectAtIndex:i];
                _cursor--;
                [_queue insertObject:item atIndex:_cursor];
            } else if (i > _cursor) {
                [_queue removeObjectAtIndex:i];
                [_queue insertObject:item atIndex:_cursor];
            }
            [_foregroundRequestedSymbolIDs addObject:symbolId];
            found = YES;
            break;
        }
    }
    if (found) {
        [self _signalWorker];
    }
    return found;
}

- (NSString *)takeCompletedPreviewsJSON {
    return [self completedPreviewsJSONAfterSequence:0];
}

- (NSString *)completedPreviewsJSONAfterSequence:(NSUInteger)sequence {
    @synchronized (self) {
        if (_completedPreviews.count == 0) return @"[]";
        NSMutableArray *results = [NSMutableArray array];
        for (NSDictionary *item in _completedPreviews) {
            if ([item[@"sequence"] unsignedIntegerValue] > sequence) [results addObject:item];
        }
        NSData *data = [NSJSONSerialization dataWithJSONObject:results options:0 error:nil];
        if (!data) return @"[]";
        return [[NSString alloc] initWithData:data encoding:NSUTF8StringEncoding];
    }
}

- (void)start {
    @synchronized (self) {
        if (_workerThread) return;
        _stopRequested = NO;
        _workerThread = [[NSThread alloc] initWithTarget:self selector:@selector(_workerMain) object:nil];
        _workerThread.name = @"com.funkyplugins.componentbrowser.previewAgent";
        _workerThread.qualityOfService = NSQualityOfServiceBackground;
        [_workerThread start];
    }
    CBLog(@"started");
}

- (void)stop {
    _stopRequested = YES;
    @synchronized (self) {
        if (_activeTask && [_activeTask isRunning]) [_activeTask terminate];
        _workerThread = nil;
    }
    [self _signalWorker];
    CBLog(@"stopped (rendered %lu)", (unsigned long)_totalRendered);
}

- (BOOL)hasCachedPreviewForSymbol:(NSString *)symbolId {
    NSString *path = [self _filePathForSymbol:symbolId];
    return path && [[NSFileManager defaultManager] fileExistsAtPath:path];
}

#pragma mark - Worker

- (void)_pruneLocalSnapshots {
    NSString *directory = [self.cacheDirectory stringByAppendingPathComponent:@"local-snapshots"];
    NSFileManager *fm = NSFileManager.defaultManager;
    NSMutableSet<NSString *> *protectedPaths = [NSMutableSet set];
    @synchronized (self) {
        for (NSUInteger i = _cursor; i < _queue.count; i++) {
            NSString *path = _queue[i][@"libraryPath"];
            if (path) [protectedPaths addObject:path];
        }
    }
    NSMutableArray<NSDictionary *> *files = [NSMutableArray array];
    unsigned long long totalSize = 0;
    for (NSString *name in [fm contentsOfDirectoryAtPath:directory error:nil]) {
        if (![name.pathExtension.lowercaseString isEqualToString:@"sketch"]) continue;
        NSString *path = [directory stringByAppendingPathComponent:name];
        NSDictionary *attributes = [fm attributesOfItemAtPath:path error:nil];
        NSDate *date = attributes[NSFileModificationDate];
        if (!date) continue;
        unsigned long long size = [attributes[NSFileSize] unsignedLongLongValue];
        totalSize += size;
        [files addObject:@{@"path": path, @"date": date, @"size": @(size)}];
    }
    [files sortUsingComparator:^NSComparisonResult(NSDictionary *a, NSDictionary *b) {
        return [a[@"date"] compare:b[@"date"]];
    }];
    NSUInteger remaining = files.count;
    for (NSDictionary *file in files) {
        NSTimeInterval age = -[file[@"date"] timeIntervalSinceNow];
        if ([protectedPaths containsObject:file[@"path"]] || age < 60) continue;
        if (age < 86400 && remaining <= 8 && totalSize <= 256ULL * 1024 * 1024) continue;
        if ([fm removeItemAtPath:file[@"path"] error:nil]) {
            remaining--;
            totalSize -= [file[@"size"] unsignedLongLongValue];
        }
    }
}

- (void)_workerMain {
    @autoreleasepool {
        while (!_stopRequested) {
            @autoreleasepool {
                [_workCondition lock];
                NSUInteger observedSignalVersion = _workSignalVersion;
                [_workCondition unlock];
                if ([self _processOneMetadataRequest]) continue;
                BOOL isForeground = NO;
                BOOL hasWork = NO;
                NSInteger idleDelay = 60000;
                NSInteger foregroundDelay = 60;
                @synchronized (self) {
                    isForeground = _foregroundActive;
                    idleDelay = _intervalFastMs;
                    foregroundDelay = _intervalSlowMs;
                    if (!isForeground) {
                        hasWork = _cursor < _queue.count;
                    } else {
                        for (NSUInteger i = _cursor; i < _queue.count; i++) {
                            NSString *symbolId = _queue[i][@"symbolId"];
                            if (symbolId && [_foregroundRequestedSymbolIDs containsObject:symbolId]) {
                                hasWork = YES;
                                break;
                            }
                        }
                    }
                }
                if (hasWork) {
                    // Briefly coalesce the visible viewport. Rendering remains
                    // serial and low priority, with no Sketch API on this thread.
                    if (isForeground) [NSThread sleepForTimeInterval:0.075];
                    [self _pruneLocalSnapshots];
                    [self _processOneBatch];
                }
                NSTimeInterval delay = (isForeground ? foregroundDelay : idleDelay) / 1000.0;
                [_workCondition lock];
                if (!_stopRequested && _workSignalVersion == observedSignalVersion) {
                    [_workCondition waitUntilDate:[NSDate dateWithTimeIntervalSinceNow:delay]];
                }
                [_workCondition unlock];
            }
        }
    }
}

- (void)_processOneBatch {
    NSArray<NSDictionary *> *batch = nil;
    NSString *libraryPath = nil;
    NSString *scale = nil;
    BOOL notifyFinished = NO;
    NSUInteger countAtFinish = 0;

    @synchronized (self) {
        if (_stopRequested) return;
        if (_cursor >= _queue.count) {
            if (!_queueFinishedNotified && _queue.count > 0) {
                _queueFinishedNotified = YES;
                notifyFinished = YES;
                countAtFinish = _totalRendered;
            }
        } else {
            if (_foregroundActive) {
                NSUInteger requestedIndex = NSNotFound;
                for (NSUInteger i = _cursor; i < _queue.count; i++) {
                    NSString *symbolId = _queue[i][@"symbolId"];
                    if (symbolId && [_foregroundRequestedSymbolIDs containsObject:symbolId]) {
                        requestedIndex = i;
                        break;
                    }
                }
                if (requestedIndex == NSNotFound) return;
                if (requestedIndex > _cursor) {
                    NSDictionary *requestedItem = _queue[requestedIndex];
                    [_queue removeObjectAtIndex:requestedIndex];
                    [_queue insertObject:requestedItem atIndex:_cursor];
                }
            }
            NSDictionary *first = _queue[_cursor];
            libraryPath = [first[@"libraryPath"] isKindOfClass:[NSString class]] ? first[@"libraryPath"] : nil;
            scale = [first[@"scale"] isKindOfClass:[NSString class]] ? first[@"scale"] : @"1";
            NSMutableArray<NSDictionary *> *items = [NSMutableArray array];
            NSUInteger scan = _cursor;
            NSUInteger maxBatchSize = _foregroundActive ? 6 : _batchSize;
            while (scan < _queue.count && items.count < maxBatchSize) {
                NSDictionary *item = _queue[scan];
                NSString *itemPath = [item[@"libraryPath"] isKindOfClass:[NSString class]] ? item[@"libraryPath"] : nil;
                BOOL requested = !_foregroundActive || [_foregroundRequestedSymbolIDs containsObject:item[@"symbolId"]];
                if (![itemPath isEqualToString:libraryPath] || !requested) { scan++; continue; }
                if (scan != _cursor) {
                    [_queue removeObjectAtIndex:scan];
                    [_queue insertObject:item atIndex:_cursor];
                }
                [items addObject:item];
                _cursor++;
                scan = _cursor;
            }
            batch = [items copy];
            for (NSDictionary *item in batch) {
                NSString *symbolId = [item[@"symbolId"] isKindOfClass:[NSString class]] ? item[@"symbolId"] : nil;
                if (symbolId) {
                    [_activeSymbolIDs addObject:symbolId];
                    [_foregroundRequestedSymbolIDs removeObject:symbolId];
                }
            }
        }
    }

    if (notifyFinished) {
        CBLog(@"queue finished; rendered %lu previews", (unsigned long)countAtFinish);
        return;
    }
    if (batch.count == 0) return;
    CBLog(@"processing batch of %lu from %@", (unsigned long)batch.count, libraryPath.lastPathComponent);
    @try {
        [self _exportBatch:batch libraryPath:libraryPath scale:scale];
    } @finally {
        @synchronized (self) {
            for (NSDictionary *item in batch) {
                NSString *symbolId = [item[@"symbolId"] isKindOfClass:[NSString class]] ? item[@"symbolId"] : nil;
                if (symbolId) [_activeSymbolIDs removeObject:symbolId];
            }
        }
    }
}

- (BOOL)_readArchivePagesFromPath:(NSString *)path byID:(NSMutableDictionary *)byID byName:(NSMutableDictionary *)byName {
    NSTask *task = [[NSTask alloc] init];
    task.launchPath = @"/usr/bin/nice";
    task.arguments = @[@"-n", @"19", @"/usr/bin/unzip", @"-p", path, @"pages/*.json"];
    NSPipe *pipe = [NSPipe pipe];
    task.standardOutput = pipe;
    task.standardError = [NSFileHandle fileHandleForWritingAtPath:@"/dev/null"];
    @synchronized (self) {
        if (_stopRequested || ![task launchAndReturnError:nil]) return NO;
        _activeTask = task;
    }
    // unzip emits adjacent JSON pages. Split them as a stream, respecting JSON
    // strings and escapes; retain at most one page rather than the full archive.
    NSMutableData *buffer = [NSMutableData data];
    NSUInteger scanned = 0, depth = 0;
    BOOL inString = NO, escaped = NO;
    while (!_stopRequested) {
        @autoreleasepool {
            NSData *chunk = [pipe.fileHandleForReading readDataOfLength:128 * 1024];
            if (!chunk.length) break;
            [buffer appendData:chunk];
            const uint8_t *bytes = buffer.bytes;
            NSUInteger consumed = 0;
            for (NSUInteger i = scanned; i < buffer.length; i++) {
                uint8_t c = bytes[i];
                if (inString) {
                    if (escaped) escaped = NO;
                    else if (c == '\\') escaped = YES;
                    else if (c == '"') inString = NO;
                    continue;
                }
                if (c == '"') { inString = YES; continue; }
                if (c == '{' || c == '[') depth++;
                else if ((c == '}' || c == ']') && depth > 0 && --depth == 0) {
                    @autoreleasepool {
                        NSData *data = [buffer subdataWithRange:NSMakeRange(consumed, i + 1 - consumed)];
                        NSDictionary *page = [NSJSONSerialization JSONObjectWithData:data options:0 error:nil];
                        [self _indexNode:page byID:byID byName:byName];
                    }
                    consumed = i + 1;
                }
            }
            if (consumed) [buffer replaceBytesInRange:NSMakeRange(0, consumed) withBytes:NULL length:0];
            scanned = buffer.length;
        }
    }
    if (_stopRequested && task.running) [task terminate];
    [task waitUntilExit];
    @synchronized (self) { if (_activeTask == task) _activeTask = nil; }
    return task.terminationStatus == 0 && depth == 0;
}

- (void)_indexNode:(NSDictionary *)node byID:(NSMutableDictionary *)byID byName:(NSMutableDictionary *)byName {
    if (![node isKindOfClass:NSDictionary.class]) return;
    if ([node[@"_class"] isEqual:@"symbolMaster"]) {
        NSString *layerID = node[@"do_objectID"];
        NSString *componentID = node[@"symbolID"];
        NSString *name = node[@"name"];
        NSDictionary *frame = node[@"frame"];
        double dimension = MAX([frame[@"width"] doubleValue], [frame[@"height"] doubleValue]);
        if ([layerID isKindOfClass:NSString.class] && layerID.length) {
            NSDictionary *info = @{@"id": layerID, @"dimension": @(dimension),
                @"name": [name isKindOfClass:NSString.class] ? name : @"",
                @"componentId": [componentID isKindOfClass:NSString.class] ? componentID : layerID,
                @"preventInserting": @([node[@"preventInserting"] boolValue])};
            byID[layerID] = info;
            if ([componentID isKindOfClass:NSString.class] && componentID.length) byID[componentID] = info;
            if ([name isKindOfClass:NSString.class] && name.length) byName[name] = byName[name] ? NSNull.null : info;
        }
    }
    for (NSDictionary *child in node[@"layers"]) [self _indexNode:child byID:byID byName:byName];
}

- (NSDictionary *)_sourceIndexForPath:(NSString *)path version:(NSString *)version {
    NSDictionary *attrs = [NSFileManager.defaultManager attributesOfItemAtPath:path error:nil];
    NSString *identity = [NSString stringWithFormat:@"%@|%@|%@|%@", path, version, attrs[NSFileModificationDate], attrs[NSFileSize]];
    uint64_t hash = 14695981039346656037ULL;
    NSData *identityData = [identity dataUsingEncoding:NSUTF8StringEncoding];
    const uint8_t *bytes = identityData.bytes;
    for (NSUInteger i = 0; i < identityData.length; i++) { hash ^= bytes[i]; hash *= 1099511628211ULL; }
    NSString *key = [NSString stringWithFormat:@"%016llx", (unsigned long long)hash];
    if (_sourceIndexes[key]) return _sourceIndexes[key];
    NSString *directory = [self.cacheDirectory stringByAppendingPathComponent:@"library-index-v1"];
    NSString *cachePath = [directory stringByAppendingPathComponent:[key stringByAppendingPathExtension:@"json"]];
    NSData *cachedData = [NSData dataWithContentsOfFile:cachePath];
    NSDictionary *index = cachedData ? [NSJSONSerialization JSONObjectWithData:cachedData options:0 error:nil] : nil;
    if (![index isKindOfClass:NSDictionary.class] || [index[@"componentMetadataVersion"] integerValue] != 2) {
        NSMutableDictionary *byID = [NSMutableDictionary dictionary], *byName = [NSMutableDictionary dictionary];
        if (![self _readArchivePagesFromPath:path byID:byID byName:byName]) return nil;
        NSMutableArray *components = [NSMutableArray array];
        NSMutableSet *seen = [NSMutableSet set];
        for (NSDictionary *info in byID.allValues) {
            // Match Sketch's importable list. Internal components remain in
            // the render index, but cannot be inserted from a library.
            if ([info[@"preventInserting"] boolValue]) continue;
            NSString *identity = info[@"id"];
            if ([seen containsObject:identity]) continue;
            [seen addObject:identity];
            [components addObject:@{@"id": info[@"componentId"], @"name": info[@"name"]}];
        }
        index = @{@"byID": byID, @"byName": byName, @"components": components,
            @"componentMetadataVersion": @2};
        NSData *data = [NSJSONSerialization dataWithJSONObject:index options:0 error:nil];
        [NSFileManager.defaultManager createDirectoryAtPath:directory withIntermediateDirectories:YES attributes:nil error:nil];
        [data writeToFile:cachePath options:NSDataWritingAtomic error:nil];
        CBLog(@"indexed %lu source IDs from %@ off the UI thread", (unsigned long)byID.count, path.lastPathComponent);
    }
    if (_sourceIndexes.count >= 12) [_sourceIndexes removeAllObjects];
    _sourceIndexes[key] = index;
    return index;
}

- (void)_exportBatch:(NSArray<NSDictionary *> *)items libraryPath:(NSString *)libraryPath scale:(NSString *)scale {
    NSMutableDictionary<NSString *, NSMutableArray *> *groups = [NSMutableDictionary dictionary];
    NSMutableDictionary<NSString *, NSNumber *> *largestScales = [NSMutableDictionary dictionary];
    NSMutableArray<NSString *> *groupOrder = [NSMutableArray array];
    NSDictionary *index = nil;
    for (NSDictionary *item in items) {
        NSString *cachePath = [self _filePathForSymbol:item[@"symbolId"]];
        NSString *wanted = [NSString stringWithFormat:@"%ldpx-v1:%@", (long)self.renderSize, item[@"versionTag"]];
        NSString *actual = [NSString stringWithContentsOfFile:[cachePath stringByAppendingString:@".version"] encoding:NSUTF8StringEncoding error:nil];
        if ([actual isEqualToString:wanted] && [NSFileManager.defaultManager fileExistsAtPath:cachePath]) {
            @synchronized (self) {
                [_completedPreviews addObject:@{@"symbolId": item[@"symbolId"], @"path": cachePath, @"versionTag": item[@"versionTag"], @"sequence": @(++_completionSequence)}];
                if (_completedPreviews.count > 4096) [_completedPreviews removeObjectAtIndex:0];
            }
            continue;
        }
        NSMutableDictionary *resolved = [item mutableCopy];
        if (![resolved[@"sourceSymbolId"] length]) {
            if (!index) index = [self _sourceIndexForPath:libraryPath version:item[@"versionTag"]];
            id info = index[@"byID"][item[@"symbolId"]] ?: index[@"byName"][item[@"name"] ?: @""];
            if (![info isKindOfClass:NSDictionary.class]) { CBLog(@"no source for component %@", item[@"symbolId"]); continue; }
            resolved[@"sourceSymbolId"] = info[@"id"];
            double dimension = [info[@"dimension"] doubleValue];
            resolved[@"scale"] = [NSString stringWithFormat:@"%.6f", dimension > 0 ? self.renderSize / dimension : 0.25];
        }
        NSString *resolvedScale = resolved[@"scale"] ?: scale ?: @"1";
        double value = resolvedScale.doubleValue > 0 ? resolvedScale.doubleValue : 1;
        NSString *group = [NSString stringWithFormat:@"%.0f", floor(log2(value))];
        if (!groups[group]) { groups[group] = [NSMutableArray array]; [groupOrder addObject:group]; }
        largestScales[group] = @(MAX([largestScales[group] doubleValue], value));
        [groups[group] addObject:resolved];
    }
    for (NSString *group in groupOrder) {
        if (_stopRequested) break;
        // Nearby sizes share a document load; no source is rendered above
        // twice the target dimension. ImageIO produces the final 128px PNG.
        [self _exportResolvedBatch:groups[group] libraryPath:libraryPath scale:[NSString stringWithFormat:@"%.6f", [largestScales[group] doubleValue]]];
    }
}

- (void)_exportResolvedBatch:(NSArray<NSDictionary *> *)items libraryPath:(NSString *)libraryPath scale:(NSString *)scale {
    if (!self.sketchtoolPath.length || !libraryPath.length || !self.cacheDirectory.length) return;
    if (_stopRequested) return;

    NSMutableArray<NSString *> *ids = [NSMutableArray arrayWithCapacity:items.count];
    for (NSDictionary *item in items) {
        NSString *sourceSymbolId = [item[@"sourceSymbolId"] isKindOfClass:[NSString class]] ? item[@"sourceSymbolId"] : nil;
        if (sourceSymbolId.length == 0) {
            sourceSymbolId = [item[@"symbolId"] isKindOfClass:[NSString class]] ? item[@"symbolId"] : nil;
        }
        if (sourceSymbolId.length > 0) [ids addObject:sourceSymbolId];
    }
    if (ids.count == 0) return;

    NSFileManager *fm = [NSFileManager defaultManager];
    NSString *temporaryRoot = [NSTemporaryDirectory() stringByAppendingPathComponent:@"com.funkyplugins.componentbrowser.preview-agent"];
    NSString *batchDirectory = [temporaryRoot stringByAppendingPathComponent:NSUUID.UUID.UUIDString];
    NSError *directoryError = nil;
    if (![fm createDirectoryAtPath:batchDirectory withIntermediateDirectories:YES attributes:nil error:&directoryError]) {
        CBLog(@"could not create batch folder: %@", directoryError);
        return;
    }

    NSString *itemsArgument = [NSString stringWithFormat:@"--items=%@", [ids componentsJoinedByString:@","]];
    NSArray<NSString *> *arguments = @[
        @"-n", @"19", self.sketchtoolPath,
        @"export", @"layers", libraryPath,
        itemsArgument,
        [NSString stringWithFormat:@"--output=%@", batchDirectory],
        @"--formats=png", [NSString stringWithFormat:@"--scales=%@", scale ?: @"1"],
        @"--trimmed=YES", @"--overwriting=YES", @"--use-id-for-name=YES"
    ];

    NSTask *task = [[NSTask alloc] init];
    task.launchPath = @"/usr/bin/nice";
    task.arguments = arguments;
    NSFileHandle *nullHandle = [NSFileHandle fileHandleForWritingAtPath:@"/dev/null"];
    if (nullHandle) {
        task.standardOutput = nullHandle;
        task.standardError = nullHandle;
    }

    NSError *launchError = nil;
    BOOL launched = NO;
    @synchronized (self) {
        // Foreground mode permits only explicitly requested visible previews.
        // The worker already applies that limit
        // when choosing the batch, so rejecting all work here also rejected
        // every on-demand preview while the browser was open.
        if (_stopRequested) {
            [fm removeItemAtPath:batchDirectory error:nil];
            return;
        }
        _activeTask = task;
        launched = [task launchAndReturnError:&launchError];
        if (!launched) _activeTask = nil;
    }

    if (!launched) {
        CBLog(@"sketchtool launch failed: %@", launchError);
        [fm removeItemAtPath:batchDirectory error:nil];
        return;
    }
    CBLog(@"launched sketchtool for %lu previews from %@", (unsigned long)ids.count, libraryPath.lastPathComponent);
    [task waitUntilExit];
    @synchronized (self) { if (_activeTask == task) _activeTask = nil; }

    if (_stopRequested) {
        [fm removeItemAtPath:batchDirectory error:nil];
        return;
    }
    if (task.terminationStatus != 0) {
        CBLog(@"sketchtool export failed (%d) for %@", (int)task.terminationStatus, libraryPath.lastPathComponent);
        [fm removeItemAtPath:batchDirectory error:nil];
        return;
    }
    CBLog(@"sketchtool exported batch from %@", libraryPath.lastPathComponent);
    NSArray<NSString *> *exportedFileNames = [fm contentsOfDirectoryAtPath:batchDirectory error:nil];

    NSUInteger batchRendered = 0;
    for (NSDictionary *item in items) {
        NSString *symbolId = [item[@"symbolId"] isKindOfClass:[NSString class]] ? item[@"symbolId"] : nil;
        NSString *sourceSymbolId = [item[@"sourceSymbolId"] isKindOfClass:[NSString class]] ? item[@"sourceSymbolId"] : symbolId;
        NSString *versionTag = [item[@"versionTag"] isKindOfClass:[NSString class]] ? item[@"versionTag"] : nil;
        if (!symbolId.length || !sourceSymbolId.length || !versionTag.length) continue;

        NSString *exportedPath = [batchDirectory stringByAppendingPathComponent:[sourceSymbolId stringByAppendingPathExtension:@"png"]];
        if (![fm fileExistsAtPath:exportedPath]) {
            // Current Sketch adds a rounded scale suffix, e.g. ID@0.2x.png,
            // even when exporting one scale and suffixing is disabled.
            NSString *scaledPrefix = [sourceSymbolId stringByAppendingString:@"@"];
            for (NSString *fileName in exportedFileNames) {
                if ([fileName hasPrefix:scaledPrefix] && [fileName.pathExtension.lowercaseString isEqualToString:@"png"]) {
                    exportedPath = [batchDirectory stringByAppendingPathComponent:fileName];
                    break;
                }
            }
        }
        NSString *cachePath = [self _filePathForSymbol:symbolId];
        if (!cachePath || ![fm fileExistsAtPath:exportedPath]) continue;
        if (![fm createDirectoryAtPath:[cachePath stringByDeletingLastPathComponent] withIntermediateDirectories:YES attributes:nil error:nil]) continue;
        const NSUInteger renderSize = (NSUInteger)MAX(1, self.renderSize);
        if (![self _writeDownsampledPNGFromPath:exportedPath toPath:cachePath maxPixelSize:renderSize]) continue;
        NSString *cacheVersionTag = [NSString stringWithFormat:@"%ldpx-v1:%@", (long)self.renderSize, versionTag];
        NSData *versionData = [cacheVersionTag dataUsingEncoding:NSUTF8StringEncoding];
        if (versionData.length > 0) {
            NSString *versionPath = [cachePath stringByAppendingString:@".version"];
            [versionData writeToFile:versionPath options:NSDataWritingAtomic error:nil];
        }

        @synchronized (self) {
            _totalRendered++;
            [_completedPreviews addObject:@{@"symbolId": symbolId, @"path": cachePath, @"versionTag": versionTag, @"sequence": @(++_completionSequence)}];
            if (_completedPreviews.count > 4096) [_completedPreviews removeObjectAtIndex:0];
        }
        batchRendered++;
    }
    CBLog(@"cached %lu/%lu previews from %@", (unsigned long)batchRendered, (unsigned long)items.count, libraryPath.lastPathComponent);
    [fm removeItemAtPath:batchDirectory error:nil];
}

- (BOOL)_writeDownsampledPNGFromPath:(NSString *)sourcePath toPath:(NSString *)destinationPath maxPixelSize:(NSUInteger)maxPixelSize {
    NSURL *sourceURL = [NSURL fileURLWithPath:sourcePath];
    CGImageSourceRef source = CGImageSourceCreateWithURL((__bridge CFURLRef)sourceURL, NULL);
    if (!source) return NO;

    NSDictionary *options = @{
        (__bridge NSString *)kCGImageSourceCreateThumbnailFromImageAlways: @YES,
        (__bridge NSString *)kCGImageSourceCreateThumbnailWithTransform: @YES,
        (__bridge NSString *)kCGImageSourceThumbnailMaxPixelSize: @(maxPixelSize)
    };
    CGImageRef image = CGImageSourceCreateThumbnailAtIndex(source, 0, (__bridge CFDictionaryRef)options);
    CFRelease(source);
    if (!image) return NO;

    NSMutableData *pngData = [NSMutableData data];
    CGImageDestinationRef destination = CGImageDestinationCreateWithData((__bridge CFMutableDataRef)pngData, CFSTR("public.png"), 1, NULL);
    if (!destination) {
        CGImageRelease(image);
        return NO;
    }
    CGImageDestinationAddImage(destination, image, NULL);
    BOOL finalized = CGImageDestinationFinalize(destination);
    CFRelease(destination);
    CGImageRelease(image);
    if (!finalized || pngData.length == 0) return NO;
    return [pngData writeToFile:destinationPath options:NSDataWritingAtomic error:nil];
}

#pragma mark - File paths

- (NSString *)_filePathForSymbol:(NSString *)symbolId {
    if (!self.cacheDirectory.length || symbolId.length == 0) return nil;
    NSCharacterSet *allowed = [NSCharacterSet characterSetWithCharactersInString:
      @"abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789_.-"];
    NSMutableString *safe = [NSMutableString stringWithCapacity:symbolId.length];
    for (NSUInteger i = 0; i < symbolId.length; i++) {
        unichar character = [symbolId characterAtIndex:i];
        if ([allowed characterIsMember:character]) [safe appendFormat:@"%C", character];
        else [safe appendString:@"_"];
    }
    return [self.cacheDirectory stringByAppendingPathComponent:[safe stringByAppendingPathExtension:@"png"]];
}

@end
