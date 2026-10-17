#import <AppKit/AppKit.h>

@interface CBStableBrowserPanel : NSPanel
+ (instancetype)browserPanel;
- (void)setPresentationExpanded:(BOOL)expanded animated:(BOOL)animated;
- (void)finishPresentationTransition;
- (void)setPreferredAppearance:(NSString *)appearance;
- (void)fadeIn;
- (void)fadeOut;
@end
