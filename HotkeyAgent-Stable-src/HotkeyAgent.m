#import "HotkeyAgent.h"
#import <Carbon/Carbon.h>
#import <AppKit/AppKit.h>

@implementation CBStableHotkeyAgent {
    id _eventMonitor;
    BOOL _hasRegisteredHotkey;
    BOOL _isRecording;
    UInt32 _registeredKeyCode;
    UInt32 _registeredModifiers;
}

+ (instancetype)sharedAgent {
    return [[self alloc] init];
}

- (BOOL)registerHotkeyWithKeyCode:(UInt32)keyCode modifiers:(UInt32)modifiers {
    [self unregister];
    _registeredKeyCode = keyCode;
    _registeredModifiers = modifiers;
    _hasRegisteredHotkey = YES;
    [self installEventMonitorIfNeeded];

    if (!_eventMonitor) {
        _hasRegisteredHotkey = NO;
        return NO;
    }
    NSLog(@"[CBStableHotkeyAgent] listening keyCode=%u modifiers=%u",
          (unsigned)keyCode, (unsigned)modifiers);
    return YES;
}

- (void)unregister {
    _hasRegisteredHotkey = NO;
    if (!_isRecording) [self removeEventMonitor];
}

- (void)beginRecording {
    [self unregister];
    _isRecording = YES;
    [self installEventMonitorIfNeeded];
    NSLog(@"[CBStableHotkeyAgent] shortcut recording started");
}

- (void)endRecording {
    _isRecording = NO;
    if (!_hasRegisteredHotkey) [self removeEventMonitor];
    NSLog(@"[CBStableHotkeyAgent] shortcut recording stopped");
}

- (void)installEventMonitorIfNeeded {
    if (_eventMonitor) return;

    __weak CBStableHotkeyAgent *weakSelf = self;
    _eventMonitor = [NSEvent addLocalMonitorForEventsMatchingMask:NSEventMaskKeyDown
                                                           handler:^NSEvent *(NSEvent *event) {
        CBStableHotkeyAgent *strongSelf = weakSelf;
        if (!strongSelf) return event;

        NSEventModifierFlags flags = event.modifierFlags & NSEventModifierFlagDeviceIndependentFlagsMask;
        UInt32 modifiers = 0;
        if (flags & NSEventModifierFlagCommand) modifiers |= cmdKey;
        if (flags & NSEventModifierFlagShift) modifiers |= shiftKey;
        if (flags & NSEventModifierFlagOption) modifiers |= optionKey;
        if (flags & NSEventModifierFlagControl) modifiers |= controlKey;

        if (strongSelf->_isRecording) {
            // Let Escape reach the WebView so it can cancel recording.
            if (event.keyCode == kVK_Escape && modifiers == 0) return event;

            id<CBStableHotkeyDelegate> delegate = strongSelf.delegate;
            if (delegate && [delegate respondsToSelector:@selector(hotkeyDidRecordKeyCode:modifiers:)]) {
                [delegate hotkeyDidRecordKeyCode:@(event.keyCode) modifiers:@(modifiers)];
            }
            // Consume the captured key before Sketch menus or text fields see it.
            return nil;
        }

        if (strongSelf->_hasRegisteredHotkey &&
            (UInt32)event.keyCode == strongSelf->_registeredKeyCode &&
            modifiers == strongSelf->_registeredModifiers) {
            [strongSelf fire];
            return nil;
        }
        return event;
    }];
}

- (void)removeEventMonitor {
    if (!_eventMonitor) return;
    [NSEvent removeMonitor:_eventMonitor];
    _eventMonitor = nil;
}

- (void)dealloc {
    _hasRegisteredHotkey = NO;
    _isRecording = NO;
    [self removeEventMonitor];
}

- (void)fire {
    id<CBStableHotkeyDelegate> delegate = self.delegate;
    if (delegate && [delegate respondsToSelector:@selector(hotkeyDidTrigger)]) {
        [delegate hotkeyDidTrigger];
    }
}

@end
