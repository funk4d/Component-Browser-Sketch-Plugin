FRAMEWORK_NAME := PreviewAgent
PLUGIN_PATH := ../ComponentBrowser.sketchplugin
FRAMEWORK_DIR := $(PLUGIN_PATH)/Contents/Resources/$(FRAMEWORK_NAME).framework
SDK_PATH := $(shell xcrun --sdk macosx --show-sdk-path)

build:
	@echo "→ Building Stable $(FRAMEWORK_NAME).framework into $(PLUGIN_PATH)"
	rm -rf $(FRAMEWORK_DIR)
	mkdir -p $(FRAMEWORK_DIR)/Versions/A/Headers $(FRAMEWORK_DIR)/Versions/A/Resources
	cp PreviewAgent.h $(FRAMEWORK_DIR)/Versions/A/Headers/
	cp Info.plist $(FRAMEWORK_DIR)/Versions/A/Resources/
	xcrun clang -dynamiclib -fobjc-arc -isysroot $(SDK_PATH) \
		-arch arm64 -arch x86_64 -mmacosx-version-min=10.13 \
		-framework Foundation -framework Cocoa -framework ImageIO \
		-Wl,-install_name,@rpath/$(FRAMEWORK_NAME).framework/Versions/A/$(FRAMEWORK_NAME) \
		-compatibility_version 1 -current_version 1 \
		-o $(FRAMEWORK_DIR)/Versions/A/$(FRAMEWORK_NAME) PreviewAgent.m
	ln -sfn A $(FRAMEWORK_DIR)/Versions/Current
	ln -sfn Versions/Current/Headers $(FRAMEWORK_DIR)/Headers
	ln -sfn Versions/Current/Resources $(FRAMEWORK_DIR)/Resources
	ln -sfn Versions/Current/$(FRAMEWORK_NAME) $(FRAMEWORK_DIR)/$(FRAMEWORK_NAME)
	codesign --force --deep --sign - --timestamp=none $(FRAMEWORK_DIR)

.PHONY: build
