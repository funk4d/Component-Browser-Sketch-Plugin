FRAMEWORK_DIR := ../ComponentBrowser.sketchplugin/Contents/Resources/BrowserPanel.framework
SDK_PATH := $(shell xcrun --sdk macosx --show-sdk-path)

build:
	rm -rf $(FRAMEWORK_DIR)
	mkdir -p $(FRAMEWORK_DIR)/Versions/A/Headers $(FRAMEWORK_DIR)/Versions/A/Resources
	cp BrowserPanel.h $(FRAMEWORK_DIR)/Versions/A/Headers/
	cp Info.plist $(FRAMEWORK_DIR)/Versions/A/Resources/
	xcrun clang -dynamiclib -fobjc-arc -isysroot $(SDK_PATH) \
		-arch arm64 -arch x86_64 -mmacosx-version-min=10.13 \
		-framework Cocoa -framework QuartzCore -framework CoreImage \
		-Wl,-install_name,@rpath/BrowserPanel.framework/Versions/A/BrowserPanel \
		-compatibility_version 1 -current_version 1 \
		-o $(FRAMEWORK_DIR)/Versions/A/BrowserPanel BrowserPanel.m
	ln -sfn A $(FRAMEWORK_DIR)/Versions/Current
	ln -sfn Versions/Current/Headers $(FRAMEWORK_DIR)/Headers
	ln -sfn Versions/Current/Resources $(FRAMEWORK_DIR)/Resources
	ln -sfn Versions/Current/BrowserPanel $(FRAMEWORK_DIR)/BrowserPanel
	codesign --force --deep --sign - --timestamp=none $(FRAMEWORK_DIR)

.PHONY: build
