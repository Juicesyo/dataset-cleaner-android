import type { CapacitorConfig } from '@capacitor/cli';

const config: CapacitorConfig = {
  appId: 'com.dsh.apkevaluator',
  appName: '数据集清理',
  webDir: 'dist',
  android: {
    // Dataset files are read/written through the Storage Access Framework,
    // so the WebView itself needs no broad filesystem access.
    allowMixedContent: true,
  },
  server: {
    androidScheme: 'https',
  },
};

export default config;
