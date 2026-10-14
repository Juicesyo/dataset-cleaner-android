package com.dsh.apkevaluator;

import android.app.Activity;
import android.content.ContentResolver;
import android.content.Intent;
import android.database.Cursor;
import android.net.Uri;
import android.provider.DocumentsContract;

import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.Logger;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.ActivityCallback;
import com.getcapacitor.annotation.CapacitorPlugin;

import org.json.JSONException;

import java.io.BufferedReader;
import java.io.InputStream;
import java.io.InputStreamReader;
import java.io.OutputStream;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.List;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

/**
 * Storage Access Framework bridge.
 *
 * Capacitor's stock Filesystem plugin can only address the app's own sandbox,
 * which is useless for cleaning datasets that live in the user's Downloads or
 * Documents folder. This plugin surfaces the system pickers and then reads and
 * writes through ContentResolver, so no runtime storage permission is required
 * on any supported API level.
 *
 * Persistable URI permissions are taken on the returned tree so the export path
 * keeps working after the picker Activity is gone.
 */
@CapacitorPlugin(name = "Saf")
public class SafPlugin extends Plugin {

    /** Guards against pathological folder trees stalling the UI. */
    private static final int MAX_FILES = 5000;
    private static final int MAX_DEPTH = 8;

    /** File I/O runs off the bridge thread so the WebView never blocks. */
    private final ExecutorService io = Executors.newFixedThreadPool(3);

    /* ------------------------------------------------------------ picking */

    @PluginMethod
    public void pickFiles(PluginCall call) {
        Intent intent = new Intent(Intent.ACTION_OPEN_DOCUMENT);
        intent.addCategory(Intent.CATEGORY_OPENABLE);
        intent.setType("*/*");
        intent.putExtra(Intent.EXTRA_ALLOW_MULTIPLE, true);
        startActivityForResult(call, intent, "pickFilesResult");
    }

    @ActivityCallback
    private void pickFilesResult(PluginCall call, androidx.activity.result.ActivityResult result) {
        if (call == null) return;
        if (result.getResultCode() != Activity.RESULT_OK || result.getData() == null) {
            call.reject("未选择文件");
            return;
        }
        Intent data = result.getData();
        List<Uri> uris = new ArrayList<>();
        if (data.getClipData() != null) {
            for (int i = 0; i < data.getClipData().getItemCount(); i++) {
                uris.add(data.getClipData().getItemAt(i).getUri());
            }
        } else if (data.getData() != null) {
            uris.add(data.getData());
        }

        JSArray arr = new JSArray();
        for (Uri uri : uris) {
            JSObject o = new JSObject();
            o.put("uri", uri.toString());
            o.put("name", queryName(uri));
            arr.put(o);
        }
        JSObject ret = new JSObject();
        ret.put("files", arr);
        call.resolve(ret);
    }

    @PluginMethod
    public void pickDirectory(PluginCall call) {
        Intent intent = new Intent(Intent.ACTION_OPEN_DOCUMENT_TREE);
        intent.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION
                | Intent.FLAG_GRANT_WRITE_URI_PERMISSION
                | Intent.FLAG_GRANT_PERSISTABLE_URI_PERMISSION
                | Intent.FLAG_GRANT_PREFIX_URI_PERMISSION);
        startActivityForResult(call, intent, "pickDirectoryResult");
    }

    @ActivityCallback
    private void pickDirectoryResult(PluginCall call, androidx.activity.result.ActivityResult result) {
        if (call == null) return;
        if (result.getResultCode() != Activity.RESULT_OK || result.getData() == null) {
            call.reject("未选择目录");
            return;
        }
        Uri treeUri = result.getData().getData();
        if (treeUri == null) {
            call.reject("未选择目录");
            return;
        }

        // Keep the grant across process restarts so exports do not re-prompt.
        // Anything other than a security failure here would abort the method
        // before resolving, leaving the JS promise pending forever, so the
        // catch is deliberately broad.
        try {
            getContext().getContentResolver().takePersistableUriPermission(
                    treeUri,
                    Intent.FLAG_GRANT_READ_URI_PERMISSION | Intent.FLAG_GRANT_WRITE_URI_PERMISSION);
        } catch (Exception ignored) {
            // Some providers refuse persistable grants; the session grant still works.
        }

        boolean recursive = call.getBoolean("recursive", true);
        final String treeUriStr = treeUri.toString();
        final String name = queryName(treeUri);

        io.execute(() -> {
            JSArray files = new JSArray();
            try {
                collect(treeUri, files, 0, recursive);
            } catch (Exception e) {
                // Never leave the caller waiting: a failed walk is reported, and
                // whatever was collected before the failure is still returned.
                Logger.warn("Saf walk failed: " + e.getMessage());
            }
            JSObject ret = new JSObject();
            ret.put("uri", treeUriStr);
            ret.put("name", name);
            ret.put("files", files);
            call.resolve(ret);
        });
    }

    /** Depth-first listing of a granted tree; unreadable subtrees are skipped. */
    private void collect(Uri dir, JSArray out, int depth, boolean recursive) {
        if (depth > MAX_DEPTH || out.length() >= MAX_FILES) return;

        Uri children = DocumentsContract.buildChildDocumentsUriUsingTree(
                dir, DocumentsContract.getDocumentId(dir));

        try (Cursor c = getContext().getContentResolver().query(
                children,
                new String[]{
                        DocumentsContract.Document.COLUMN_DOCUMENT_ID,
                        DocumentsContract.Document.COLUMN_DISPLAY_NAME,
                        DocumentsContract.Document.COLUMN_MIME_TYPE,
                        DocumentsContract.Document.COLUMN_SIZE,
                },
                null, null, null)) {

            if (c == null) return;
            while (c.moveToNext() && out.length() < MAX_FILES) {
                String docId = c.getString(0);
                String displayName = c.getString(1);
                String mime = c.getString(2);
                long size = c.isNull(3) ? -1 : c.getLong(3);

                Uri childUri = DocumentsContract.buildDocumentUriUsingTree(dir, docId);

                if (DocumentsContract.Document.MIME_TYPE_DIR.equals(mime)) {
                    if (recursive) collect(childUri, out, depth + 1, recursive);
                } else if (isDataset(displayName)) {
                    JSObject o = new JSObject();
                    o.put("uri", childUri.toString());
                    o.put("name", displayName);
                    if (size >= 0) o.put("size", size);
                    out.put(o);
                }
            }
        } catch (Exception ignored) {
            // A provider may deny or not implement listing for a subtree.
        }
    }

    private static boolean isDataset(String name) {
        if (name == null) return false;
        String lower = name.toLowerCase();
        return lower.endsWith(".json") || lower.endsWith(".jsonl") || lower.endsWith(".ndjson");
    }

    /* ------------------------------------------------------------- reading */

    @PluginMethod
    public void readFile(PluginCall call) {
        String uriStr = call.getString("uri");
        if (uriStr == null) {
            call.reject("缺少 uri 参数");
            return;
        }
        final Uri uri = Uri.parse(uriStr);
        io.execute(() -> {
            try {
                String text = readText(uri);
                JSObject ret = new JSObject();
                ret.put("data", text);
                call.resolve(ret);
            } catch (Exception e) {
                call.reject("读取失败: " + e.getMessage());
            }
        });
    }

    @PluginMethod
    public void readManyFiles(PluginCall call) {
        JSArray uris = call.getArray("uris");
        if (uris == null) {
            call.reject("缺少 uris 参数");
            return;
        }
        io.execute(() -> {
            JSArray out = new JSArray();
            for (int i = 0; i < uris.length(); i++) {
                try {
                    String uriStr = uris.getString(i);
                    JSObject o = new JSObject();
                    o.put("uri", uriStr);
                    o.put("data", readText(Uri.parse(uriStr)));
                    out.put(o);
                } catch (Exception e) {
                    // Report the failure per file rather than failing the batch.
                    try {
                        JSObject o = new JSObject();
                        o.put("uri", uris.getString(i));
                        o.put("error", String.valueOf(e.getMessage()));
                        out.put(o);
                    } catch (JSONException ignored) {
                    }
                }
            }
            JSObject ret = new JSObject();
            ret.put("files", out);
            call.resolve(ret);
        });
    }

    private String readText(Uri uri) throws Exception {
        ContentResolver cr = getContext().getContentResolver();
        StringBuilder sb = new StringBuilder();
        try (InputStream in = cr.openInputStream(uri)) {
            if (in == null) throw new Exception("无法打开输入流");
            try (BufferedReader r = new BufferedReader(
                    new InputStreamReader(in, StandardCharsets.UTF_8))) {
                char[] buf = new char[8192];
                int n;
                while ((n = r.read(buf)) != -1) sb.append(buf, 0, n);
            }
        }
        return sb.toString();
    }

    /* ------------------------------------------------------------- writing */

    /**
     * Writes `name` inside the granted tree, replacing any existing file of the
     * same name so repeated exports do not pile up.
     */
    @PluginMethod
    public void writeFile(PluginCall call) {
        String treeUriStr = call.getString("treeUri");
        String name = call.getString("name");
        String data = call.getString("data");

        if (treeUriStr == null || name == null || data == null) {
            call.reject("缺少 treeUri / name / data 参数");
            return;
        }
        final Uri treeUri = Uri.parse(treeUriStr);

        io.execute(() -> {
            try {
                Uri target = findChild(treeUri, name);
                if (target == null) {
                    target = DocumentsContract.createDocument(
                            getContext().getContentResolver(),
                            DocumentsContract.buildDocumentUriUsingTree(
                                    treeUri, DocumentsContract.getTreeDocumentId(treeUri)),
                            "application/jsonl",
                            name);
                }
                if (target == null) throw new Exception("无法在目标目录创建文件");

                ContentResolver cr = getContext().getContentResolver();
                try (OutputStream os = cr.openOutputStream(target, "wt")) {
                    if (os == null) throw new Exception("无法打开输出流");
                    os.write(data.getBytes(StandardCharsets.UTF_8));
                    os.flush();
                }

                JSObject ret = new JSObject();
                ret.put("uri", target.toString());
                call.resolve(ret);
            } catch (Exception e) {
                call.reject("写入失败: " + e.getMessage());
            }
        });
    }

    /** Looks for an existing direct child by display name. */
    private Uri findChild(Uri treeUri, String name) {
        Uri children = DocumentsContract.buildChildDocumentsUriUsingTree(
                treeUri, DocumentsContract.getTreeDocumentId(treeUri));
        try (Cursor c = getContext().getContentResolver().query(
                children,
                new String[]{
                        DocumentsContract.Document.COLUMN_DOCUMENT_ID,
                        DocumentsContract.Document.COLUMN_DISPLAY_NAME,
                },
                null, null, null)) {
            if (c == null) return null;
            while (c.moveToNext()) {
                if (name.equals(c.getString(1))) {
                    return DocumentsContract.buildDocumentUriUsingTree(treeUri, c.getString(0));
                }
            }
        } catch (Exception ignored) {
        }
        return null;
    }

    /** Resolves a document's display name, falling back to the last path segment. */
    private String queryName(Uri uri) {
        try (Cursor c = getContext().getContentResolver().query(
                uri, new String[]{DocumentsContract.Document.COLUMN_DISPLAY_NAME},
                null, null, null)) {
            if (c != null && c.moveToFirst() && c.getString(0) != null) {
                return c.getString(0);
            }
        } catch (Exception ignored) {
        }
        String path = uri.getLastPathSegment();
        return path == null ? "未命名" : path;
    }

    @Override
    protected void handleOnDestroy() {
        io.shutdownNow();
        super.handleOnDestroy();
    }
}
