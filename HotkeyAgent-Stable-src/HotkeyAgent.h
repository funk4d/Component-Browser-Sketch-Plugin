// Native, Sketch-local hotkey agent for the Stable Component Browser bundle.

#import <Foundation/Foundation.h>

@protocol CBStableHotkeyDelegate <NSObject>
- (void)hotkeyDidTrigger;
- (void)hotkeyDidRecordKeyCode:(NSNumber *)keyCode modifiers:(NSNumber *)modifiers;
@end

@interface CBStableHotkeyAgent : NSObject

// Return a fresh instance so each plugin variant can own its own event monitor.
+ (instancetype)sharedAgent;

// keyCode uses Carbon virtual key codes; modifiers use Carbon modifier masks.
- (BOOL)registerHotkeyWithKeyCode:(UInt32)keyCode modifiers:(UInt32)modifiers;
- (void)unregister;
- (void)beginRecording;
- (void)endRecording;

@property (nonatomic, strong) id<CBStableHotkeyDelegate> delegate;

@end
