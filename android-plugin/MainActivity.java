package com.dsh.apkevaluator;

import android.os.Bundle;

import com.getcapacitor.BridgeActivity;

/**
 * Application entry point.
 *
 * `SafPlugin` is registered explicitly here because Capacitor discovers plugins
 * from `assets/capacitor.plugins.json`, and that file is produced by the
 * annotation processor of a *plugin module's* build. An app-local plugin gets no
 * such entry, so without this call the `Saf` bridge would be absent at runtime
 * and every import or export would fail in the packaged APK.
 *
 * Registration must happen before `super.onCreate()`, which is what constructs
 * the bridge and loads the plugin list.
 */
public class MainActivity extends BridgeActivity {
    @Override
    public void onCreate(Bundle savedInstanceState) {
        registerPlugin(SafPlugin.class);
        super.onCreate(savedInstanceState);
    }
}
