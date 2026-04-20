# Releasing Component Browser

Sketch expects plugin updates to point to a ZIP archive that contains the plugin bundle.

## Release checklist

1. Bump the version in `ComponentBrowser.sketchplugin/Contents/Sketch/manifest.json`
2. Update `appcast.json`
3. Commit and push those metadata changes to `main`
4. Verify `main` serves the updated files:

```sh
curl -s https://raw.githubusercontent.com/funk4d/Component-Browser-Sketch-Plugin/main/appcast.json
curl -s https://raw.githubusercontent.com/funk4d/Component-Browser-Sketch-Plugin/main/ComponentBrowser.sketchplugin/Contents/Sketch/manifest.json
```

5. Create the release archive:

```sh
ditto -c -k --keepParent ComponentBrowser.sketchplugin ComponentBrowser.sketchplugin.zip
```

6. Verify the archive contains the bundle at the top level:

```sh
unzip -l ComponentBrowser.sketchplugin.zip | head
```

You should see paths starting with `ComponentBrowser.sketchplugin/`.

7. Upload `ComponentBrowser.sketchplugin.zip` to the GitHub release
8. Do not rename the ZIP archive to `.sketchplugin`
9. Make sure `appcast.json` points to the uploaded `.zip` asset and uses a plain semantic `versionID`, for example `1.2.1`

## Notes

- Sketch installs plugins when the user opens a real `.sketchplugin` bundle.
- Sketch updates expect the `downloadURL` in the updating JSON to point to a downloadable ZIP archive.
- The plugin manifest must include the `appcast` URL so Sketch can discover updates.
