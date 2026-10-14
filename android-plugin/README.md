# Android platform

Capacitor generates the Android project from `capacitor.config.ts` with:

```bash
npx cap add android
npx cap sync android
```

That directory is **not** committed. The only native source this project owns is
`android-plugin/SafPlugin.java`, and the CI workflow copies it into the generated
project before building:

```
android/app/src/main/java/com/dsh/apkevaluator/SafPlugin.java
```

## Why a custom plugin

Capacitor's stock Filesystem plugin can only address the app's own sandbox
(`Directory.Documents`, `Directory.Data`, ...). Cleaning datasets that live in the
user's own folders needs the Storage Access Framework, so `SafPlugin` exposes:

| Method | Android action |
| --- | --- |
| `pickFiles()` | `ACTION_OPEN_DOCUMENT`, multiple |
| `pickDirectory({recursive})` | `ACTION_OPEN_DOCUMENT_TREE`, then a recursive listing |
| `readFile({uri})` | reads through `ContentResolver` |
| `readManyFiles({uris})` | batched read, one bridge round-trip |
| `writeFile({treeUri,name,data})` | creates or replaces a file in the granted tree |

Because access flows through URI grants, **no storage permission is declared in
the manifest** and the app works on Android 10+ scoped storage.

## Local build

Requires JDK 17 and the Android SDK (`ANDROID_HOME` set, with a platform and
build-tools installed).

```bash
npm install
npm run build
npx cap add android
npx cap sync android
Copy-Item android-plugin\SafPlugin.java `
  android\app\src\main\java\com\dsh\apkevaluator\SafPlugin.java
npm run android:apk
```

The APK lands in `android/app/build/outputs/apk/debug/`.

## Notes

- `pickDirectory` takes a **persistable** URI permission, so the export
  destination survives the picker Activity being dismissed.
- Directory walking is capped at depth 8 and 5000 files so pointing the picker
  at a very large tree cannot hang the UI.
- File reads and writes run on a background executor; the WebView never blocks
  on I/O.
