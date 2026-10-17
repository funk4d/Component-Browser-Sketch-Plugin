#import "BrowserPanel.h"
#import <QuartzCore/QuartzCore.h>
#import <CoreImage/CoreImage.h>
#import <math.h>

@interface CBStablePanelTransition : NSAnimation
@property (nonatomic, weak) CBStableBrowserPanel *panel;
@property NSRect startFrame;
@property NSRect targetFrame;
@property CGFloat startRadius;
@property CGFloat targetRadius;
@property BOOL scalesContent;
@end

@interface CBStablePanelFade : NSAnimation
@property (nonatomic, weak) CBStableBrowserPanel *panel;
@property CGFloat startAlpha;
@property CGFloat targetAlpha;
@property BOOL orderOutWhenFinished;
@property CGFloat startBlur;
@property CGFloat targetBlur;
@end

@interface CBStableBrowserPanel () <NSAnimationDelegate>
@property (nonatomic, strong) CBStablePanelTransition *presentationTransition;
@property (nonatomic, strong) CBStablePanelFade *fadeTransition;
@property BOOL presentationExpanded;
@property CGFloat baseWidth;
@property BOOL entranceScaling;
@property BOOL savedAutoresizesSubviews;
@property CGFloat entranceContentHeight;
@property CGFloat windowBlurRadius;
@property (nonatomic, strong) CIFilter *windowBlur;
- (void)applyPanelRadius:(CGFloat)radius;
- (void)applyTransitionFrame:(NSRect)frame scalesContent:(BOOL)scalesContent;
- (void)endEntranceScaling;
- (void)applyWindowBlurRadius:(CGFloat)radius;
@end

@implementation CBStablePanelTransition
- (NSArray<NSRunLoopMode> *)runLoopModesForAnimating {
    return @[NSRunLoopCommonModes];
}
- (void)setCurrentProgress:(NSAnimationProgress)progress {
    [super setCurrentProgress:progress];
    CBStableBrowserPanel *panel = self.panel;
    if (!panel) return;
    CGFloat t = progress;
    CGFloat spring = t >= 1 ? 1 : 1 - exp(-9 * t) * (cos(7 * t) + (9.0 / 7.0) * sin(7 * t));
    NSRect frame = self.startFrame;
    frame.size.width += (self.targetFrame.size.width - frame.size.width) * spring;
    frame.origin.x = self.startFrame.origin.x + (self.targetFrame.origin.x - self.startFrame.origin.x) * spring;
    frame.size.height += (self.targetFrame.size.height - frame.size.height) * spring;
    frame.origin.y = NSMaxY(self.startFrame) - frame.size.height;
    [panel applyTransitionFrame:frame scalesContent:self.scalesContent];
    CGFloat radius = self.startRadius + (self.targetRadius - self.startRadius) * MIN(1, MAX(0, spring));
    [panel applyPanelRadius:radius];
    if (t >= 1) {
        if (self.scalesContent) [panel endEntranceScaling];
        [panel invalidateShadow];
    }
}
@end

@implementation CBStablePanelFade
- (NSArray<NSRunLoopMode> *)runLoopModesForAnimating {
    return @[NSRunLoopCommonModes];
}
- (void)setCurrentProgress:(NSAnimationProgress)progress {
    [super setCurrentProgress:progress];
    CBStableBrowserPanel *panel = self.panel;
    if (!panel) return;
    CGFloat t = MIN(1, MAX(0, progress));
    CGFloat easeOut = 1 - pow(1 - t, 3);
    panel.alphaValue = self.startAlpha + (self.targetAlpha - self.startAlpha) * easeOut;
    [panel applyWindowBlurRadius:self.startBlur + (self.targetBlur - self.startBlur) * easeOut];
}
@end

@implementation CBStableBrowserPanel
+ (instancetype)browserPanel {
    CBStableBrowserPanel *panel = [[self alloc] initWithContentRect:NSMakeRect(0, 0, 701, 64)
                                                       styleMask:NSWindowStyleMaskBorderless
                                                         backing:NSBackingStoreBuffered
                                                           defer:NO];
    panel.opaque = NO;
    panel.backgroundColor = NSColor.clearColor;
    panel.hasShadow = YES;
    panel.floatingPanel = YES;
    panel.hidesOnDeactivate = YES;
    panel.becomesKeyOnlyIfNeeded = NO;
    panel.collectionBehavior = NSWindowCollectionBehaviorMoveToActiveSpace | NSWindowCollectionBehaviorFullScreenAuxiliary;
    panel.releasedWhenClosed = NO;
    panel.animationBehavior = NSWindowAnimationBehaviorNone;
    panel.level = NSFloatingWindowLevel;
    panel.baseWidth = 701;
    [panel applyPanelRadius:32];
    return panel;
}
- (BOOL)canBecomeKeyWindow { return YES; }
- (BOOL)canBecomeMainWindow { return NO; }
- (void)setPreferredAppearance:(NSString *)appearance {
    if ([appearance isEqualToString:@"dark"]) {
        if (@available(macOS 10.14, *)) self.appearance = [NSAppearance appearanceNamed:NSAppearanceNameDarkAqua];
        else self.appearance = [NSAppearance appearanceNamed:NSAppearanceNameVibrantDark];
    }
    else if ([appearance isEqualToString:@"light"]) self.appearance = [NSAppearance appearanceNamed:NSAppearanceNameAqua];
    else self.appearance = nil;
}
- (void)applyPanelRadius:(CGFloat)radius {
    self.contentView.wantsLayer = YES;
    [CATransaction begin];
    [CATransaction setDisableActions:YES];
    self.contentView.layer.cornerRadius = radius;
    self.contentView.layer.masksToBounds = YES;
    [CATransaction commit];
}
- (void)applyTransitionFrame:(NSRect)frame scalesContent:(BOOL)scalesContent {
    [self setFrame:frame display:NO];
    if (scalesContent) {
        // Keep the WebView's logical width fixed while the actual NSPanel
        // changes width. The entire window content stretches together; WebKit
        // does not reflow the search field and images on every animation frame.
        self.contentView.bounds = NSMakeRect(0, 0, self.baseWidth, self.entranceContentHeight);
    }
    [self displayIfNeeded];
}
- (void)endEntranceScaling {
    if (!self.entranceScaling) return;
    self.entranceScaling = NO;
    self.contentView.bounds = NSMakeRect(0, 0, self.frame.size.width, self.frame.size.height);
    for (NSView *view in self.contentView.subviews) view.frame = self.contentView.bounds;
    self.contentView.autoresizesSubviews = self.savedAutoresizesSubviews;
}
- (void)applyWindowBlurRadius:(CGFloat)radius {
    self.windowBlurRadius = MAX(0, radius);
    if (radius < 0.01) {
        if (self.windowBlur) {
            self.contentView.layer.filters = nil;
            self.contentView.layerUsesCoreImageFilters = NO;
            self.windowBlur = nil;
        }
        return;
    }
    if (!self.windowBlur) {
        self.contentView.wantsLayer = YES;
        self.contentView.layerUsesCoreImageFilters = YES;
        CIFilter *filter = [CIFilter filterWithName:@"CIGaussianBlur"];
        filter.name = @"cbWindowBlur";
        [filter setValue:@(radius) forKey:kCIInputRadiusKey];
        self.contentView.layer.filters = @[filter];
        self.windowBlur = filter;
    } else {
        [self.contentView.layer setValue:@(radius) forKeyPath:@"filters.cbWindowBlur.inputRadius"];
    }
}
- (void)setPresentationExpanded:(BOOL)expanded animated:(BOOL)animated {
    BOOL changed = self.presentationExpanded != expanded;
    self.presentationExpanded = expanded;
    if (self.entranceScaling && !changed) return;
    [self.presentationTransition stopAnimation];
    self.presentationTransition = nil;
    [self endEntranceScaling];
    NSRect startFrame = self.frame;
    NSRect targetFrame = startFrame;
    targetFrame.size.width = self.baseWidth > 0 ? self.baseWidth : startFrame.size.width;
    targetFrame.origin.x = NSMidX(startFrame) - targetFrame.size.width / 2;
    targetFrame.size.height = expanded ? 490 : 64;
    targetFrame.origin.y = NSMaxY(startFrame) - targetFrame.size.height;
    CGFloat radius = expanded ? 26 : 32;
    BOOL reduceMotion = NSWorkspace.sharedWorkspace.accessibilityDisplayShouldReduceMotion;
    if (!animated || reduceMotion || (fabs(startFrame.size.height - targetFrame.size.height) < 0.5
                                      && fabs(startFrame.size.width - targetFrame.size.width) < 0.5)) {
        [self setFrame:targetFrame display:YES];
        [self applyPanelRadius:radius];
        [self invalidateShadow];
        return;
    }
    CBStablePanelTransition *transition = [[CBStablePanelTransition alloc] initWithDuration:0.46 animationCurve:NSAnimationLinear];
    transition.panel = self;
    transition.startFrame = startFrame;
    transition.targetFrame = targetFrame;
    transition.startRadius = self.contentView.layer.cornerRadius;
    transition.targetRadius = radius;
    transition.animationBlockingMode = NSAnimationNonblocking;
    transition.frameRate = 60;
    self.presentationTransition = transition;
    [transition startAnimation];
}
- (void)finishPresentationTransition {
    [self.presentationTransition stopAnimation];
    self.presentationTransition = nil;
    [self endEntranceScaling];
    NSRect frame = self.frame;
    frame.size.width = self.baseWidth > 0 ? self.baseWidth : frame.size.width;
    frame.origin.x = NSMidX(frame) - frame.size.width / 2;
    frame.size.height = self.presentationExpanded ? 490 : 64;
    frame.origin.y = NSMaxY(self.frame) - frame.size.height;
    [self setFrame:frame display:YES];
    [self applyPanelRadius:self.presentationExpanded ? 26 : 32];
    [self invalidateShadow];
}
- (void)fadeIn {
    [self.fadeTransition stopAnimation];
    self.fadeTransition = nil;
    BOOL reduceMotion = NSWorkspace.sharedWorkspace.accessibilityDisplayShouldReduceMotion;
    if (reduceMotion || self.alphaValue >= 0.999) {
        [self endEntranceScaling];
        [self applyWindowBlurRadius:0];
        self.alphaValue = 1;
        return;
    }
    [self.presentationTransition stopAnimation];
    self.presentationTransition = nil;
    [self endEntranceScaling];
    NSRect targetFrame = self.frame;
    targetFrame.size.width = self.baseWidth > 0 ? self.baseWidth : targetFrame.size.width;
    targetFrame.origin.x = NSMidX(targetFrame) - targetFrame.size.width / 2;
    targetFrame.size.height = self.presentationExpanded ? 490 : 64;
    targetFrame.origin.y = NSMaxY(self.frame) - targetFrame.size.height;
    NSRect startFrame = targetFrame;
    startFrame.size.width = targetFrame.size.width * 1.5;
    startFrame.origin.x = NSMidX(targetFrame) - startFrame.size.width / 2;
    CGFloat radius = self.contentView.layer.cornerRadius;
    self.savedAutoresizesSubviews = self.contentView.autoresizesSubviews;
    self.contentView.autoresizesSubviews = NO;
    self.entranceContentHeight = targetFrame.size.height;
    self.entranceScaling = YES;
    for (NSView *view in self.contentView.subviews) view.frame = NSMakeRect(0, 0, self.baseWidth, self.entranceContentHeight);
    [self applyTransitionFrame:startFrame scalesContent:YES];
    [self applyWindowBlurRadius:8];
    CBStablePanelTransition *resize = [[CBStablePanelTransition alloc] initWithDuration:0.46 animationCurve:NSAnimationLinear];
    resize.panel = self;
    resize.startFrame = startFrame;
    resize.targetFrame = targetFrame;
    resize.startRadius = radius;
    resize.targetRadius = radius;
    resize.scalesContent = YES;
    resize.animationBlockingMode = NSAnimationNonblocking;
    resize.frameRate = 60;
    self.presentationTransition = resize;
    [resize startAnimation];

    CBStablePanelFade *transition = [[CBStablePanelFade alloc] initWithDuration:0.20 animationCurve:NSAnimationLinear];
    transition.panel = self;
    transition.startAlpha = self.alphaValue;
    transition.targetAlpha = 1;
    transition.startBlur = self.windowBlurRadius;
    transition.targetBlur = 0;
    transition.animationBlockingMode = NSAnimationNonblocking;
    transition.frameRate = 60;
    transition.delegate = self;
    self.fadeTransition = transition;
    [transition startAnimation];
}
- (void)fadeOut {
    [self.presentationTransition stopAnimation];
    self.presentationTransition = nil;
    [self.fadeTransition stopAnimation];
    self.fadeTransition = nil;
    BOOL reduceMotion = NSWorkspace.sharedWorkspace.accessibilityDisplayShouldReduceMotion;
    if (reduceMotion || self.alphaValue <= 0.001) {
        self.alphaValue = 0;
        [super orderOut:nil];
        [self endEntranceScaling];
        [self applyWindowBlurRadius:0];
        return;
    }
    CBStablePanelFade *transition = [[CBStablePanelFade alloc] initWithDuration:0.22 animationCurve:NSAnimationLinear];
    transition.panel = self;
    transition.startAlpha = self.alphaValue;
    transition.targetAlpha = 0;
    transition.startBlur = self.windowBlurRadius;
    transition.targetBlur = 8;
    transition.orderOutWhenFinished = YES;
    transition.animationBlockingMode = NSAnimationNonblocking;
    transition.frameRate = 60;
    transition.delegate = self;
    self.fadeTransition = transition;
    [transition startAnimation];
}
- (void)animationDidEnd:(NSAnimation *)animation {
    if (animation != self.fadeTransition) return;
    CBStablePanelFade *transition = self.fadeTransition;
    self.fadeTransition = nil;
    if (transition.orderOutWhenFinished) {
        [super orderOut:nil];
        [self endEntranceScaling];
        [self applyWindowBlurRadius:0];
    } else {
        self.alphaValue = 1;
        [self applyWindowBlurRadius:0];
    }
}
- (void)animationDidStop:(NSAnimation *)animation {
    // Interrupted fades are replaced by the next show or hide request.
}
- (void)orderOut:(id)sender {
    [self.fadeTransition stopAnimation];
    self.fadeTransition = nil;
    [self endEntranceScaling];
    [self applyWindowBlurRadius:0];
    self.alphaValue = 1;
    [self setPresentationExpanded:self.presentationExpanded animated:NO];
    [super orderOut:sender];
}
- (void)close {
    [self.presentationTransition stopAnimation];
    self.presentationTransition = nil;
    [self.fadeTransition stopAnimation];
    self.fadeTransition = nil;
    [self endEntranceScaling];
    [self applyWindowBlurRadius:0];
    self.alphaValue = 1;
    [super close];
}
@end
