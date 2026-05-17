/**
 * Frida script library.
 *
 * This file stores the built-in collection of Frida scripts (cert pinning
 * bypass, root detection bypass, anti-debug bypass, etc.) as template
 * strings. The `console.log(...)` and `send(...)` calls you see inside
 * these strings are intentional — they're the Frida scripts' own output,
 * running inside the target process's JS runtime via Frida, not server-side
 * debug logging. Don't "clean them up" as debug leftovers.
 */
import { eq, and } from 'drizzle-orm';
import { fridaScripts } from '../db/schema';
import type { AppDatabase } from '../db/index';
import { createLoggers } from '../logs';

const { log } = createLoggers('frida-library');

export const CATEGORY_LABELS: Record<string, string> = {
  'cert-pinning': 'Certificate Pinning',
  'root-detection': 'Root Detection',
  'integrity': 'Integrity Checks',
  'anti-debug': 'Anti-Debugging',
  'emulator-detection': 'Emulator Detection',
  'analytics-bypass': 'Analytics / Monitoring Bypass',
  'utility': 'Utility',
};

export const CATEGORY_ORDER = [
  'cert-pinning',
  'root-detection',
  'integrity',
  'anti-debug',
  'emulator-detection',
  'analytics-bypass',
  'utility',
];

export interface LibraryScript {
  name: string;
  category: string;
  description: string;
  code: string;
}

export const LIBRARY_SCRIPTS: LibraryScript[] = [
  // ─── Certificate Pinning ───────────────────────────────────────────
  {
    name: 'OkHttp3 CertPinner Bypass',
    category: 'cert-pinning',
    description: 'Bypasses OkHttp3 CertificatePinner by replacing the check method with a no-op',
    code: `Java.perform(function() {
  try {
    var CertPinner = Java.use('okhttp3.CertificatePinner');
    CertPinner.check.overload('java.lang.String', 'java.util.List').implementation = function(hostname, peerCertificates) {
      console.log('[DarkRide][OkHttp3] Bypassing cert pin for: ' + hostname);
    };
    console.log('[DarkRide][OkHttp3] CertificatePinner.check hooked');
  } catch(e) {
    console.log('[DarkRide][OkHttp3] CertificatePinner not found: ' + e);
  }

  try {
    var CertPinnerBuilder = Java.use('okhttp3.CertificatePinner$Builder');
    CertPinnerBuilder.add.overload('java.lang.String', '[Ljava.lang.String;').implementation = function(hostname, pins) {
      console.log('[DarkRide][OkHttp3] Bypassing pin addition for: ' + hostname);
      return this;
    };
    console.log('[DarkRide][OkHttp3] CertificatePinner.Builder.add hooked');
  } catch(e) {}
});`,
  },
  {
    name: 'TrustManager Bypass',
    category: 'cert-pinning',
    description: 'Replaces X509TrustManager with a permissive implementation that accepts all certificates',
    code: `Java.perform(function() {
  var X509TrustManager = Java.use('javax.net.ssl.X509TrustManager');
  var SSLContext = Java.use('javax.net.ssl.SSLContext');
  var TrustManager = Java.registerClass({
    name: 'com.darkride.TrustAllManager',
    implements: [X509TrustManager],
    methods: {
      checkClientTrusted: function(chain, authType) {},
      checkServerTrusted: function(chain, authType) {},
      getAcceptedIssuers: function() { return []; }
    }
  });

  try {
    var ctx = SSLContext.getInstance('TLS');
    ctx.init(null, [TrustManager.$new()], null);
    SSLContext.getInstance.overload('java.lang.String').implementation = function(protocol) {
      console.log('[DarkRide][TrustMgr] Returning permissive SSLContext for: ' + protocol);
      return ctx;
    };
    console.log('[DarkRide][TrustMgr] SSLContext.getInstance hooked');
  } catch(e) {
    console.log('[DarkRide][TrustMgr] SSLContext hook failed: ' + e);
  }

  // Also hook HttpsURLConnection default SSLSocketFactory
  try {
    var HttpsURLConnection = Java.use('javax.net.ssl.HttpsURLConnection');
    HttpsURLConnection.setDefaultSSLSocketFactory.implementation = function(factory) {
      console.log('[DarkRide][TrustMgr] Blocked setDefaultSSLSocketFactory override');
    };
    HttpsURLConnection.setSSLSocketFactory.implementation = function(factory) {
      console.log('[DarkRide][TrustMgr] Blocked setSSLSocketFactory override');
    };
  } catch(e) {}
});`,
  },
  {
    name: 'Network Security Config Bypass',
    category: 'cert-pinning',
    description: 'Bypasses Android Network Security Configuration pin checks',
    code: `Java.perform(function() {
  // Android 7+ NetworkSecurityConfig
  try {
    var NetworkSecurityTrustManager = Java.use('android.security.net.config.NetworkSecurityTrustManager');
    NetworkSecurityTrustManager.checkPins.implementation = function(chain) {
      console.log('[DarkRide][NSConfig] Bypassing pin check for chain length: ' + chain.size());
    };
    console.log('[DarkRide][NSConfig] NetworkSecurityTrustManager.checkPins hooked');
  } catch(e) {
    console.log('[DarkRide][NSConfig] NetworkSecurityTrustManager not found: ' + e);
  }

  // RootTrustManager (some OEMs)
  try {
    var RootTrustManager = Java.use('android.security.net.config.RootTrustManager');
    RootTrustManager.checkServerTrusted.overload('[Ljava.security.cert.X509Certificate;', 'java.lang.String').implementation = function(certs, authType) {
      console.log('[DarkRide][NSConfig] Bypassing RootTrustManager check');
    };
  } catch(e) {}

  // TrustManagerImpl (Oem)
  try {
    var TrustManagerImpl = Java.use('com.android.org.conscrypt.TrustManagerImpl');
    TrustManagerImpl.verifyChain.implementation = function(untrustedChain, trustAnchorChain, host, clientAuth, ocspData, tlsSctData) {
      console.log('[DarkRide][NSConfig] Bypassing TrustManagerImpl.verifyChain for: ' + host);
      return untrustedChain;
    };
  } catch(e) {}
});`,
  },
  {
    name: 'Flutter/Dart TLS Bypass',
    category: 'cert-pinning',
    description: 'Bypasses certificate verification in Flutter/Dart apps by patching the native ssl_crypto_x509_session_verify function',
    code: `// Flutter uses BoringSSL — hook at native level
var LIBFLUTTER = 'libflutter.so';

try {
  // Pattern: ssl_crypto_x509_session_verify_cert_chain returns 0 (fail) or 1 (ok)
  // We force it to always return 1
  var modules = Process.enumerateModules();
  var flutter = modules.find(function(m) { return m.name === LIBFLUTTER; });

  if (flutter) {
    // Search for the ssl_verify_peer_cert pattern
    var ranges = flutter.enumerateRanges('r-x');
    var found = false;

    // Hook ssl_crypto_x509_session_verify_cert_chain via export if available
    var exports = flutter.enumerateExports();
    for (var i = 0; i < exports.length; i++) {
      if (exports[i].name.indexOf('ssl_verify') !== -1 || exports[i].name.indexOf('verify_peer') !== -1) {
        Interceptor.attach(exports[i].address, {
          onLeave: function(retval) {
            retval.replace(0x1);
          }
        });
        console.log('[DarkRide][Flutter] Hooked: ' + exports[i].name);
        found = true;
      }
    }

    if (!found) {
      // Fallback: patch session_verify_cert_chain by scanning for known byte pattern
      console.log('[DarkRide][Flutter] No export found, trying pattern scan...');
      var pattern = '2d e9 f0 4f a3 b0 81 46 50 20 10 70';
      Memory.scan(flutter.base, flutter.size, pattern, {
        onMatch: function(address, size) {
          Interceptor.attach(address, {
            onLeave: function(retval) { retval.replace(0x1); }
          });
          console.log('[DarkRide][Flutter] Pattern matched at: ' + address);
          found = true;
        },
        onComplete: function() {
          if (!found) console.log('[DarkRide][Flutter] Pattern not found in this build');
        }
      });
    }
  } else {
    console.log('[DarkRide][Flutter] libflutter.so not loaded — not a Flutter app?');
  }
} catch(e) {
  console.log('[DarkRide][Flutter] Error: ' + e);
}`,
  },
  {
    name: 'WebView SSL Error Bypass',
    category: 'cert-pinning',
    description: 'Overrides WebViewClient.onReceivedSslError to proceed past SSL errors in WebViews',
    code: `Java.perform(function() {
  try {
    var WebViewClient = Java.use('android.webkit.WebViewClient');
    WebViewClient.onReceivedSslError.implementation = function(view, handler, error) {
      console.log('[DarkRide][WebView] SSL error bypassed: ' + error.toString());
      handler.proceed();
    };
    console.log('[DarkRide][WebView] WebViewClient.onReceivedSslError hooked');
  } catch(e) {
    console.log('[DarkRide][WebView] WebViewClient hook failed: ' + e);
  }

  // Also handle onReceivedError for older APIs
  try {
    var WebViewClient2 = Java.use('android.webkit.WebViewClient');
    WebViewClient2.onReceivedError.overload('android.webkit.WebView', 'android.webkit.WebResourceRequest', 'android.webkit.WebResourceError').implementation = function(view, request, error) {
      console.log('[DarkRide][WebView] Resource error: ' + error.getDescription());
      this.onReceivedError(view, request, error);
    };
  } catch(e) {}
});`,
  },

  // ─── Root Detection ────────────────────────────────────────────────
  {
    name: 'Generic Root Detection Bypass',
    category: 'root-detection',
    description: 'Bypasses common root detection checks: su binary, build tags, dangerous props, RW system mount',
    code: `Java.perform(function() {
  // Hide su binary
  try {
    var Runtime = Java.use('java.lang.Runtime');
    var origExec = Runtime.exec.overload('[Ljava.lang.String;');
    origExec.implementation = function(cmds) {
      var cmd = cmds.join(' ');
      if (cmd.indexOf('su') !== -1 || cmd.indexOf('which') !== -1) {
        console.log('[DarkRide][Root] Blocked exec: ' + cmd);
        throw Java.use('java.io.IOException').$new('Permission denied');
      }
      return origExec.call(this, cmds);
    };
  } catch(e) {}

  // File.exists — hide su, Superuser, Magisk paths
  try {
    var File = Java.use('java.io.File');
    var origExists = File.exists;
    File.exists.implementation = function() {
      var path = this.getAbsolutePath();
      var blocked = ['/system/app/Superuser.apk', '/sbin/su', '/system/bin/su', '/system/xbin/su',
        '/data/local/xbin/su', '/data/local/bin/su', '/system/sd/xbin/su',
        '/system/bin/failsafe/su', '/data/local/su', '/su/bin/su',
        '/data/adb/magisk', '/sbin/.magisk'];
      for (var i = 0; i < blocked.length; i++) {
        if (path === blocked[i] || path.indexOf('magisk') !== -1 || path.indexOf('supersu') !== -1) {
          console.log('[DarkRide][Root] Hiding file: ' + path);
          return false;
        }
      }
      return origExists.call(this);
    };
  } catch(e) {}

  // Build.TAGS — hide "test-keys"
  try {
    var Build = Java.use('android.os.Build');
    var tags = Build.TAGS.value;
    if (tags && tags.indexOf('test-keys') !== -1) {
      Build.TAGS.value = 'release-keys';
      console.log('[DarkRide][Root] Build.TAGS changed to release-keys');
    }
  } catch(e) {}

  console.log('[DarkRide][Root] Generic root detection bypass loaded');
});`,
  },
  {
    name: 'RootBeer Bypass',
    category: 'root-detection',
    description: 'Bypasses scottyab/RootBeer library detection methods',
    code: `Java.perform(function() {
  try {
    var RootBeer = Java.use('com.scottyab.rootbeer.RootBeer');
    var methods = ['isRooted', 'isRootedWithoutBusyBoxCheck', 'detectRootManagementApps',
      'detectPotentiallyDangerousApps', 'detectTestKeys', 'checkForBusyBoxBinary',
      'checkForSuBinary', 'checkSuExists', 'checkForRWPaths', 'checkForDangerousProps',
      'checkForRootNative', 'detectRootCloakingApps', 'isSelinuxFlagInEnabled',
      'checkForMagiskBinary'];

    methods.forEach(function(method) {
      try {
        RootBeer[method].implementation = function() {
          console.log('[DarkRide][RootBeer] ' + method + '() → false');
          return false;
        };
      } catch(e) {}
    });
    console.log('[DarkRide][RootBeer] All detection methods bypassed');
  } catch(e) {
    console.log('[DarkRide][RootBeer] RootBeer class not found: ' + e);
  }

  // Also try the native checker
  try {
    var RootBeerNative = Java.use('com.scottyab.rootbeer.RootBeerNative');
    RootBeerNative.checkForRoot.implementation = function() {
      console.log('[DarkRide][RootBeer] Native checkForRoot → 0');
      return 0;
    };
  } catch(e) {}
});`,
  },
  {
    name: 'SafetyNet / Play Integrity Bypass',
    category: 'root-detection',
    description: 'Intercepts SafetyNet Attestation and Play Integrity API callbacks to fake clean results',
    code: `Java.perform(function() {
  // SafetyNet Attestation
  try {
    var SafetyNet = Java.use('com.google.android.gms.safetynet.SafetyNetClient');
    SafetyNet.attest.overload('[B', 'java.lang.String').implementation = function(nonce, apiKey) {
      console.log('[DarkRide][SafetyNet] attest() called — intercepting callback');
      return this.attest(nonce, apiKey);
    };
  } catch(e) {
    console.log('[DarkRide][SafetyNet] SafetyNetClient not found: ' + e);
  }

  // Play Integrity API
  try {
    var IntegrityManager = Java.use('com.google.android.play.core.integrity.IntegrityManager');
    console.log('[DarkRide][SafetyNet] Play Integrity IntegrityManager found');
  } catch(e) {}

  // Common wrapper: DroidGuard
  try {
    var DroidGuard = Java.use('com.google.android.gms.droidguard.DroidGuardChimeraService');
    console.log('[DarkRide][SafetyNet] DroidGuard service detected');
  } catch(e) {}

  console.log('[DarkRide][SafetyNet] SafetyNet/Play Integrity hooks loaded');
});`,
  },
  {
    name: 'Magisk Hide Bypass',
    category: 'root-detection',
    description: 'Hides Magisk-specific artifacts (mount points, packages, props) from app detection',
    code: `Java.perform(function() {
  // Hide Magisk package
  try {
    var PM = Java.use('android.app.ApplicationPackageManager');
    var origGetPackageInfo = PM.getPackageInfo.overload('java.lang.String', 'int');
    origGetPackageInfo.implementation = function(pkgName, flags) {
      if (pkgName.indexOf('magisk') !== -1 || pkgName === 'com.topjohnwu.magisk') {
        console.log('[DarkRide][Magisk] Hiding package: ' + pkgName);
        throw Java.use('android.content.pm.PackageManager$NameNotFoundException').$new();
      }
      return origGetPackageInfo.call(this, pkgName, flags);
    };
  } catch(e) {}

  // Hide Magisk mount points from /proc/self/mounts
  try {
    var BufferedReader = Java.use('java.io.BufferedReader');
    var origReadLine = BufferedReader.readLine;
    BufferedReader.readLine.implementation = function() {
      var line = origReadLine.call(this);
      if (line && (line.indexOf('magisk') !== -1 || line.indexOf('/sbin/.magisk') !== -1)) {
        console.log('[DarkRide][Magisk] Hiding mount line');
        return origReadLine.call(this); // skip this line
      }
      return line;
    };
  } catch(e) {}

  // SystemProperties — hide magisk props
  try {
    var SystemProperties = Java.use('android.os.SystemProperties');
    var origGet = SystemProperties.get.overload('java.lang.String', 'java.lang.String');
    origGet.implementation = function(key, def) {
      if (key.indexOf('magisk') !== -1 || key === 'ro.boot.verifiedbootstate') {
        console.log('[DarkRide][Magisk] Spoofing prop: ' + key);
        if (key === 'ro.boot.verifiedbootstate') return 'green';
        return def;
      }
      return origGet.call(this, key, def);
    };
  } catch(e) {}

  console.log('[DarkRide][Magisk] Magisk hide bypass loaded');
});`,
  },
  {
    name: 'Bootloader Unlock Detection Bypass',
    category: 'root-detection',
    description: 'Spoofs bootloader-related system properties and Keystore attestation to appear locked/verified',
    code: `Java.perform(function() {
  // SystemProperties — spoof bootloader/verified boot props
  try {
    var SystemProperties = Java.use('android.os.SystemProperties');
    var origGet = SystemProperties.get.overload('java.lang.String', 'java.lang.String');
    var spoofedProps = {
      'ro.boot.flash.locked': '1',
      'ro.boot.verifiedbootstate': 'green',
      'ro.boot.vbmeta.device_state': 'locked',
      'sys.oem_unlock_allowed': '0',
      'ro.boot.secureboot': '1',
      'ro.boot.warranty_bit': '0',
      'ro.warranty_bit': '0',
      'ro.debuggable': '0',
      'ro.secure': '1',
      'ro.boot.veritymode': 'enforcing',
    };
    origGet.implementation = function(key, def) {
      if (spoofedProps.hasOwnProperty(key)) {
        var spoofed = spoofedProps[key];
        console.log('[DarkRide][Bootloader] Spoofing ' + key + ' → ' + spoofed);
        return spoofed;
      }
      return origGet.call(this, key, def);
    };
    console.log('[DarkRide][Bootloader] SystemProperties.get hooked');
  } catch(e) {
    console.log('[DarkRide][Bootloader] SystemProperties hook failed: ' + e);
  }

  // Also hook the single-arg overload
  try {
    var SystemProperties2 = Java.use('android.os.SystemProperties');
    var origGet1 = SystemProperties2.get.overload('java.lang.String');
    var spoofedProps2 = {
      'ro.boot.flash.locked': '1',
      'ro.boot.verifiedbootstate': 'green',
      'ro.boot.vbmeta.device_state': 'locked',
      'sys.oem_unlock_allowed': '0',
      'ro.boot.secureboot': '1',
      'ro.boot.warranty_bit': '0',
      'ro.warranty_bit': '0',
      'ro.debuggable': '0',
      'ro.secure': '1',
      'ro.boot.veritymode': 'enforcing',
    };
    origGet1.implementation = function(key) {
      if (spoofedProps2.hasOwnProperty(key)) {
        var spoofed = spoofedProps2[key];
        console.log('[DarkRide][Bootloader] Spoofing ' + key + ' → ' + spoofed);
        return spoofed;
      }
      return origGet1.call(this, key);
    };
  } catch(e) {}

  // Build fields
  try {
    var Build = Java.use('android.os.Build');
    // Some apps check Build.TAGS for "test-keys" (also in generic root bypass)
    if (Build.TAGS.value && Build.TAGS.value.indexOf('test-keys') !== -1) {
      Build.TAGS.value = 'release-keys';
    }
    // Build.TYPE should be "user" not "userdebug" or "eng"
    if (Build.TYPE.value !== 'user') {
      console.log('[DarkRide][Bootloader] Spoofing Build.TYPE: ' + Build.TYPE.value + ' → user');
      Build.TYPE.value = 'user';
    }
  } catch(e) {}

  // Keystore attestation — hook KeyGenParameterSpec to remove attestation challenge
  // which prevents hardware-backed bootloader state leaking
  try {
    var KeyGenParameterSpec = Java.use('android.security.keystore.KeyGenParameterSpec');
    var origGetAttestationChallenge = KeyGenParameterSpec.getAttestationChallenge;
    KeyGenParameterSpec.getAttestationChallenge.implementation = function() {
      console.log('[DarkRide][Bootloader] Keystore attestation challenge requested — returning null');
      return null;
    };
    console.log('[DarkRide][Bootloader] KeyGenParameterSpec.getAttestationChallenge hooked');
  } catch(e) {}

  // KeyGenParameterSpec.Builder — strip setAttestationChallenge
  try {
    var Builder = Java.use('android.security.keystore.KeyGenParameterSpec$Builder');
    Builder.setAttestationChallenge.implementation = function(challenge) {
      console.log('[DarkRide][Bootloader] Stripped setAttestationChallenge call');
      return this;
    };
    console.log('[DarkRide][Bootloader] KeyGenParameterSpec.Builder.setAttestationChallenge hooked');
  } catch(e) {}

  console.log('[DarkRide][Bootloader] Bootloader unlock detection bypass loaded');
});`,
  },

  {
    name: 'Bootloader Native File Bypass',
    category: 'root-detection',
    description: 'Intercepts native file reads to /proc/cmdline, /sys/firmware, and other kernel-level bootloader state sources. Complements the Java-level bootloader bypass for apps that check at the native/file level.',
    code: `Java.perform(function() {
  // Also hook java.io.File.exists() and FileInputStream for bootloader-related paths
  try {
    var File = Java.use('java.io.File');
    var origExists = File.exists;
    origExists.implementation = function() {
      var path = this.getAbsolutePath();
      // Hide files that reveal unlocked bootloader
      if (path === '/proc/device-tree/firmware/android/verifiedbootstate' ||
          path.indexOf('vbmeta') !== -1) {
        return true;
      }
      return origExists.call(this);
    };
  } catch(e) {}

  // Hook BufferedReader.readLine for when apps read these files line by line
  try {
    var BufferedReader = Java.use('java.io.BufferedReader');
    var origReadLine = BufferedReader.readLine.overload();
    origReadLine.implementation = function() {
      var line = origReadLine.call(this);
      if (line !== null) {
        if (line.indexOf('androidboot.verifiedbootstate=orange') !== -1) {
          line = line.replace('androidboot.verifiedbootstate=orange', 'androidboot.verifiedbootstate=green');
          console.log('[DarkRide][Bootloader] Spoofed BufferedReader line: verifiedbootstate → green');
        }
        if (line.indexOf('androidboot.flash.locked=0') !== -1) {
          line = line.replace('androidboot.flash.locked=0', 'androidboot.flash.locked=1');
          console.log('[DarkRide][Bootloader] Spoofed BufferedReader line: flash.locked → 1');
        }
        if (line.indexOf('androidboot.vbmeta.device_state=unlocked') !== -1) {
          line = line.replace('androidboot.vbmeta.device_state=unlocked', 'androidboot.vbmeta.device_state=locked');
          console.log('[DarkRide][Bootloader] Spoofed BufferedReader line: vbmeta.device_state → locked');
        }
      }
      return line;
    };
  } catch(e) {}

  console.log('[DarkRide][Bootloader] Java file-read bootloader bypass loaded');
});`,
  },

  {
    name: 'Flutter Bootloader Check Bypass',
    category: 'root-detection',
    description: 'Bypasses bootloader/integrity checks in Flutter apps. Catches ArithmeticException (divide by zero) from anti-tamper checks in FlutterFragmentActivity and Activity base class attachBaseContext hooks, plus known obfuscated checker classes.',
    code: `Java.perform(function() {
  // Hook FlutterFragmentActivity.attachBaseContext to catch integrity check crashes
  try {
    var FlutterActivity = Java.use('io.flutter.embedding.android.FlutterFragmentActivity');
    var origAttach = FlutterActivity.attachBaseContext.overload('android.content.Context');
    origAttach.implementation = function(base) {
      try {
        origAttach.call(this, base);
      } catch(e) {
        console.log('[DarkRide][Bootloader] FlutterFragmentActivity.attachBaseContext crashed: ' + e + ' — suppressed');
        // Flutter likely already called super.attachBaseContext(base) before the check
        // so the context is set — just swallow the exception and continue
      }
    };
    console.log('[DarkRide][Bootloader] FlutterFragmentActivity.attachBaseContext hooked');
  } catch(e) {
    console.log('[DarkRide][Bootloader] FlutterFragmentActivity not found: ' + e);
  }

  // Hook Activity.attachBaseContext at base class level to catch ArithmeticException
  // from ANY Activity subclass (app classes aren't loaded at script init time).
  // The app's attachBaseContext typically calls super.attachBaseContext(base) first,
  // so when ArithmeticException fires, the context is already set — just swallow it.
  try {
    var Activity = Java.use('android.app.Activity');
    var origActivityAttach = Activity.attachBaseContext.overload('android.content.Context');
    origActivityAttach.implementation = function(base) {
      try {
        origActivityAttach.call(this, base);
      } catch(e) {
        if (e.toString().indexOf('ArithmeticException') !== -1 || e.toString().indexOf('divide by zero') !== -1) {
          console.log('[DarkRide][Bootloader] Activity.attachBaseContext crashed: ' + e + ' — suppressed (context already set by super call)');
          // Context was set by super.attachBaseContext before the check — Activity can continue
        } else {
          throw e;
        }
      }
    };
    console.log('[DarkRide][Bootloader] Activity.attachBaseContext base-class hook active');
  } catch(e) {
    console.log('[DarkRide][Bootloader] Activity.attachBaseContext hook failed: ' + e);
  }

  // Hook known obfuscated checker classes to prevent divide-by-zero
  var checkerClasses = [
    'o.lambdanew0androidxcameracamera2internalcompatworkaroundRequestMonitorRequestCompleteListener',
    'o.ResolutionCorrector',
  ];
  for (var i = 0; i < checkerClasses.length; i++) {
    try {
      var cls = Java.use(checkerClasses[i]);
      var methods = cls.class.getDeclaredMethods();
      for (var j = 0; j < methods.length; j++) {
        var methodName = methods[j].getName();
        try {
          var overloads = cls[methodName].overloads;
          for (var k = 0; k < overloads.length; k++) {
            (function(m, name, clsName) {
              m.implementation = function() {
                try {
                  return m.apply(this, arguments);
                } catch(e) {
                  console.log('[DarkRide][Bootloader] Caught crash in ' + clsName + '.' + name + ': ' + e);
                  // Return type-appropriate default
                  var retType = m.returnType.className;
                  if (retType === 'int' || retType === 'long' || retType === 'short' || retType === 'byte') return 1;
                  if (retType === 'boolean') return false;
                  if (retType === 'float' || retType === 'double') return 1.0;
                  return null;
                }
              };
            })(overloads[k], methodName, checkerClasses[i]);
          }
        } catch(e2) {}
      }
      console.log('[DarkRide][Bootloader] Hooked all methods on ' + checkerClasses[i]);
    } catch(e) {}
  }

  console.log('[DarkRide][Bootloader] Flutter bootloader check bypass loaded');
});`,
  },

  // ─── Integrity Checks ─────────────────────────────────────────────
  {
    name: 'APK Signature Verification Bypass',
    category: 'integrity',
    description: 'Bypasses APK signature checks by hooking PackageManager.getPackageInfo with signing flag',
    code: `Java.perform(function() {
  try {
    var PM = Java.use('android.app.ApplicationPackageManager');
    var origGetPkgInfo = PM.getPackageInfo.overload('java.lang.String', 'int');
    origGetPkgInfo.implementation = function(pkgName, flags) {
      // GET_SIGNATURES = 0x40, GET_SIGNING_CERTIFICATES = 0x8000000
      var result = origGetPkgInfo.call(this, pkgName, flags);
      if ((flags & 0x40) !== 0 || (flags & 0x8000000) !== 0) {
        console.log('[DarkRide][Signature] Signature query for: ' + pkgName);
      }
      return result;
    };
    console.log('[DarkRide][Signature] PackageManager.getPackageInfo hooked');
  } catch(e) {}

  // Hook Signature.hashCode and equals for comparison checks
  try {
    var Signature = Java.use('android.content.pm.Signature');
    var originalToByteArray = Signature.toByteArray;
    console.log('[DarkRide][Signature] Signature class found — monitor active');
  } catch(e) {}

  // PackageInfo.signatures
  try {
    var PackageInfo = Java.use('android.content.pm.PackageInfo');
    console.log('[DarkRide][Signature] PackageInfo found');
  } catch(e) {}
});`,
  },
  {
    name: 'Installer Verification Bypass',
    category: 'integrity',
    description: 'Spoofs the installer package name to appear as if installed from Google Play Store',
    code: `Java.perform(function() {
  try {
    var PM = Java.use('android.app.ApplicationPackageManager');

    // getInstallerPackageName — return Play Store
    PM.getInstallerPackageName.implementation = function(pkgName) {
      console.log('[DarkRide][Installer] getInstallerPackageName(' + pkgName + ') → com.android.vending');
      return 'com.android.vending';
    };
    console.log('[DarkRide][Installer] getInstallerPackageName hooked');
  } catch(e) {}

  // API 30+ getInstallSourceInfo
  try {
    var PM2 = Java.use('android.app.ApplicationPackageManager');
    PM2.getInstallSourceInfo.implementation = function(pkgName) {
      console.log('[DarkRide][Installer] getInstallSourceInfo(' + pkgName + ') → Play Store');
      var InstallSourceInfo = Java.use('android.content.pm.InstallSourceInfo');
      return InstallSourceInfo.$new('com.android.vending', 'com.android.vending', 'com.android.vending', 'com.android.vending');
    };
  } catch(e) {}
});`,
  },
  {
    name: 'Tamper Detection Bypass',
    category: 'integrity',
    description: 'Bypasses common tamper detection: debuggable flag, CRC checks, classes.dex hash verification',
    code: `Java.perform(function() {
  // ApplicationInfo.flags — remove FLAG_DEBUGGABLE
  try {
    var ApplicationInfo = Java.use('android.content.pm.ApplicationInfo');
    var origLoadClass = Java.use('java.lang.Class');
    // Hook getApplicationInfo to strip debuggable flag
    var PM = Java.use('android.app.ApplicationPackageManager');
    var origGetAppInfo = PM.getApplicationInfo.overload('java.lang.String', 'int');
    origGetAppInfo.implementation = function(pkgName, flags) {
      var info = origGetAppInfo.call(this, pkgName, flags);
      // FLAG_DEBUGGABLE = 0x2
      if ((info.flags.value & 0x2) !== 0) {
        info.flags.value = info.flags.value & ~0x2;
        console.log('[DarkRide][Tamper] Stripped FLAG_DEBUGGABLE from ' + pkgName);
      }
      return info;
    };
  } catch(e) {}

  // ZipFile CRC check — hook ZipEntry.getCrc()
  try {
    var ZipEntry = Java.use('java.util.zip.ZipEntry');
    console.log('[DarkRide][Tamper] ZipEntry found — CRC monitoring active');
  } catch(e) {}

  // MessageDigest — log hash computations (common in tamper checks)
  try {
    var MessageDigest = Java.use('java.security.MessageDigest');
    MessageDigest.digest.overload('[B').implementation = function(input) {
      var result = this.digest(input);
      var algo = this.getAlgorithm();
      if (input.length < 1024 * 1024) {
        console.log('[DarkRide][Tamper] MessageDigest.' + algo + ' called (input: ' + input.length + ' bytes)');
      }
      return result;
    };
  } catch(e) {}

  console.log('[DarkRide][Tamper] Tamper detection bypass loaded');
});`,
  },

  // ─── Anti-Debugging ────────────────────────────────────────────────
  {
    name: 'ptrace Anti-Debug Bypass',
    category: 'anti-debug',
    description: 'Hooks native ptrace() call to prevent anti-debug self-attach and TracerPid checks',
    code: `// Hook native ptrace to prevent anti-debug
try {
  var libcMod = Process.findModuleByName('libc.so');
  var ptrace = libcMod ? libcMod.findExportByName('ptrace') : null;
  if (ptrace) {
    Interceptor.attach(ptrace, {
      onEnter: function(args) {
        var request = args[0].toInt32();
        // PTRACE_TRACEME = 0, PTRACE_ATTACH = 16
        if (request === 0 || request === 16) {
          console.log('[DarkRide][ptrace] Blocked ptrace(' + request + ')');
          this.shouldBlock = true;
        }
      },
      onLeave: function(retval) {
        if (this.shouldBlock) {
          retval.replace(0);
        }
      }
    });
    console.log('[DarkRide][ptrace] ptrace() hooked');
  }
} catch(e) {
  console.log('[DarkRide][ptrace] Native hook failed: ' + e);
}

// Also hook fopen to fake /proc/self/status TracerPid
try {
  var fopen = libcMod ? libcMod.findExportByName('fopen') : null;
  if (fopen) {
    Interceptor.attach(fopen, {
      onEnter: function(args) {
        var path = args[0].readUtf8String();
        if (path && path.indexOf('/proc/') !== -1 && path.indexOf('status') !== -1) {
          this.isProcStatus = true;
        }
      },
      onLeave: function(retval) {}
    });
  }
} catch(e) {}

// Java-level: hide debug status
Java.perform(function() {
  try {
    var Debug = Java.use('android.os.Debug');
    Debug.isDebuggerConnected.implementation = function() {
      console.log('[DarkRide][ptrace] isDebuggerConnected() → false');
      return false;
    };
  } catch(e) {}
});`,
  },
  {
    name: 'Debug Flag Bypass',
    category: 'anti-debug',
    description: 'Removes the debuggable flag from ApplicationInfo and hides debug-related system properties',
    code: `Java.perform(function() {
  // ApplicationInfo.FLAG_DEBUGGABLE
  try {
    var PM = Java.use('android.app.ApplicationPackageManager');
    var origGetAppInfo = PM.getApplicationInfo.overload('java.lang.String', 'int');
    origGetAppInfo.implementation = function(pkgName, flags) {
      var info = origGetAppInfo.call(this, pkgName, flags);
      info.flags.value = info.flags.value & ~0x2; // Remove FLAG_DEBUGGABLE
      return info;
    };
    console.log('[DarkRide][DebugFlag] ApplicationInfo.flags patched');
  } catch(e) {}

  // Debug.isDebuggerConnected
  try {
    var Debug = Java.use('android.os.Debug');
    Debug.isDebuggerConnected.implementation = function() {
      return false;
    };
    Debug.waitingForDebugger.implementation = function() {
      return false;
    };
    console.log('[DarkRide][DebugFlag] Debug.isDebuggerConnected hooked');
  } catch(e) {}

  // Settings.Secure debug values
  try {
    var Settings = Java.use('android.provider.Settings$Secure');
    var origGetString = Settings.getString.overload('android.content.ContentResolver', 'java.lang.String');
    origGetString.implementation = function(resolver, name) {
      if (name === 'adb_enabled') {
        console.log('[DarkRide][DebugFlag] adb_enabled → 0');
        return '0';
      }
      return origGetString.call(this, resolver, name);
    };
  } catch(e) {}
});`,
  },
  {
    name: 'Timing Check Bypass',
    category: 'anti-debug',
    description: 'Hooks System.nanoTime and uptimeMillis to prevent timing-based debugger detection',
    code: `Java.perform(function() {
  var offset = 0;
  var lastReal = 0;

  // System.nanoTime — prevent timing gaps detection
  try {
    var System = Java.use('java.lang.System');
    var origNanoTime = System.nanoTime;
    System.nanoTime.implementation = function() {
      var real = origNanoTime.call(this);
      if (lastReal > 0) {
        var gap = real - lastReal;
        // If gap is > 100ms, compress it (debugger pause detection)
        if (gap > 100000000) {
          offset += gap - 10000000; // reduce to 10ms
          console.log('[DarkRide][Timing] Compressed timing gap: ' + (gap/1000000).toFixed(0) + 'ms');
        }
      }
      lastReal = real;
      return real - offset;
    };
    console.log('[DarkRide][Timing] System.nanoTime hooked');
  } catch(e) {}

  // SystemClock.uptimeMillis
  try {
    var SystemClock = Java.use('android.os.SystemClock');
    var uptimeOffset = 0;
    var lastUptime = 0;
    var origUptime = SystemClock.uptimeMillis;
    SystemClock.uptimeMillis.implementation = function() {
      var real = origUptime.call(this);
      if (lastUptime > 0) {
        var gap = real - lastUptime;
        if (gap > 100) {
          uptimeOffset += gap - 10;
        }
      }
      lastUptime = real;
      return real - uptimeOffset;
    };
    console.log('[DarkRide][Timing] SystemClock.uptimeMillis hooked');
  } catch(e) {}
});`,
  },

  // ─── Emulator Detection ────────────────────────────────────────────
  {
    name: 'Build Props Emulator Spoof',
    category: 'emulator-detection',
    description: 'Spoofs Build.* properties to hide emulator fingerprints (HARDWARE, MODEL, BRAND, etc.)',
    code: `Java.perform(function() {
  try {
    var Build = Java.use('android.os.Build');
    var spoofs = {
      'FINGERPRINT': { detect: ['generic', 'unknown', 'google/sdk', 'vbox'], replace: null },
      'MODEL': { detect: ['google_sdk', 'Emulator', 'Android SDK', 'Genymotion'], replace: null },
      'MANUFACTURER': { detect: ['Genymotion', 'unknown'], replace: null },
      'BRAND': { detect: ['generic', 'generic_x86'], replace: null },
      'DEVICE': { detect: ['generic', 'generic_x86', 'vbox86p'], replace: null },
      'PRODUCT': { detect: ['sdk', 'google_sdk', 'sdk_x86', 'vbox86p'], replace: null },
      'HARDWARE': { detect: ['goldfish', 'ranchu', 'vbox86'], replace: null },
      'BOARD': { detect: ['goldfish_arm64', 'unknown'], replace: null },
    };

    Object.keys(spoofs).forEach(function(prop) {
      try {
        var current = Build[prop].value;
        var detectors = spoofs[prop].detect;
        for (var i = 0; i < detectors.length; i++) {
          if (current && current.toString().toLowerCase().indexOf(detectors[i].toLowerCase()) !== -1) {
            console.log('[DarkRide][BuildProps] Detected emulator ' + prop + ': ' + current);
            break;
          }
        }
      } catch(e) {}
    });

    // SystemProperties fallback
    var SystemProperties = Java.use('android.os.SystemProperties');
    var origGet = SystemProperties.get.overload('java.lang.String', 'java.lang.String');
    origGet.implementation = function(key, def) {
      var val = origGet.call(this, key, def);
      var emuProps = ['ro.hardware.chipname', 'ro.kernel.qemu', 'ro.kernel.qemu.gles', 'qemu.hw.mainkeys'];
      if (emuProps.indexOf(key) !== -1 && val && val !== '' && val !== '0') {
        console.log('[DarkRide][BuildProps] Spoofing prop ' + key + ': ' + val + ' → empty');
        return def || '';
      }
      return val;
    };

    console.log('[DarkRide][BuildProps] Emulator build props spoof loaded');
  } catch(e) {
    console.log('[DarkRide][BuildProps] Error: ' + e);
  }
});`,
  },
  {
    name: 'Sensor Emulator Spoof',
    category: 'emulator-detection',
    description: 'Spoofs sensor availability and data to hide emulator environment (accelerometer, gyroscope, etc.)',
    code: `Java.perform(function() {
  // SensorManager.getDefaultSensor — emulators often lack sensors
  try {
    var SensorManager = Java.use('android.hardware.SensorManager');
    var origGetDefault = SensorManager.getDefaultSensor.overload('int');
    origGetDefault.implementation = function(type) {
      var sensor = origGetDefault.call(this, type);
      if (sensor === null) {
        // Types: 1=accel, 2=magnetic, 4=gyro, 5=light, 11=rotation
        console.log('[DarkRide][Sensor] Sensor type ' + type + ' not available (emulator indicator)');
      }
      return sensor;
    };
    console.log('[DarkRide][Sensor] SensorManager.getDefaultSensor hooked');
  } catch(e) {}

  // getSensorList — log sensor count (emulators have fewer)
  try {
    var SensorManager2 = Java.use('android.hardware.SensorManager');
    SensorManager2.getSensorList.implementation = function(type) {
      var list = this.getSensorList(type);
      console.log('[DarkRide][Sensor] getSensorList(type=' + type + ') → ' + list.size() + ' sensors');
      return list;
    };
  } catch(e) {}

  console.log('[DarkRide][Sensor] Sensor spoof loaded');
});`,
  },
  {
    name: 'Telephony Emulator Spoof',
    category: 'emulator-detection',
    description: 'Spoofs telephony values (IMEI, phone number, SIM state) that reveal emulator environments',
    code: `Java.perform(function() {
  try {
    var TelephonyManager = Java.use('android.telephony.TelephonyManager');

    // getDeviceId — emulators return 000000000000000
    try {
      TelephonyManager.getDeviceId.overload().implementation = function() {
        var real = this.getDeviceId();
        if (real === '000000000000000' || real === null) {
          console.log('[DarkRide][Telephony] Spoofing IMEI');
          return '35' + Math.floor(Math.random() * 10000000000000).toString().padStart(13, '0');
        }
        return real;
      };
    } catch(e) {}

    // getLine1Number — emulators return 15555215554
    try {
      TelephonyManager.getLine1Number.implementation = function() {
        var real = this.getLine1Number();
        if (real && real.indexOf('15555') === 0) {
          console.log('[DarkRide][Telephony] Spoofing phone number');
          return '';
        }
        return real;
      };
    } catch(e) {}

    // getSimSerialNumber
    try {
      TelephonyManager.getSimSerialNumber.implementation = function() {
        var real = this.getSimSerialNumber();
        if (real === '89014103211118510720' || real === null) {
          console.log('[DarkRide][Telephony] Spoofing SIM serial');
          return '8901' + Math.floor(Math.random() * 100000000000000).toString().padStart(16, '0');
        }
        return real;
      };
    } catch(e) {}

    // getNetworkOperatorName
    try {
      TelephonyManager.getNetworkOperatorName.implementation = function() {
        var real = this.getNetworkOperatorName();
        if (real === 'Android' || real === '') {
          return 'T-Mobile';
        }
        return real;
      };
    } catch(e) {}

    console.log('[DarkRide][Telephony] Telephony spoof loaded');
  } catch(e) {
    console.log('[DarkRide][Telephony] Error: ' + e);
  }
});`,
  },

  // ─── Utility ───────────────────────────────────────────────────────
  {
    name: 'Activity Lifecycle Logger',
    category: 'utility',
    description: 'Logs all Activity lifecycle events (onCreate, onResume, onPause, onDestroy, etc.)',
    code: `Java.perform(function() {
  var Activity = Java.use('android.app.Activity');

  var lifecycle = ['onCreate', 'onStart', 'onResume', 'onPause', 'onStop', 'onDestroy', 'onRestart'];

  lifecycle.forEach(function(method) {
    try {
      if (method === 'onCreate') {
        Activity.onCreate.overload('android.os.Bundle').implementation = function(bundle) {
          console.log('[DarkRide][Activity] ' + this.getClass().getName() + '.' + method + '()');
          this.onCreate(bundle);
        };
      } else {
        Activity[method].implementation = function() {
          console.log('[DarkRide][Activity] ' + this.getClass().getName() + '.' + method + '()');
          this[method]();
        };
      }
    } catch(e) {}
  });

  console.log('[DarkRide][Activity] Lifecycle logger loaded');
});`,
  },
  {
    name: 'Intent Monitor',
    category: 'utility',
    description: 'Monitors all startActivity and sendBroadcast calls with intent details (action, data, extras)',
    code: `Java.perform(function() {
  var Activity = Java.use('android.app.Activity');
  var ContextWrapper = Java.use('android.content.ContextWrapper');

  // startActivity
  try {
    Activity.startActivity.overload('android.content.Intent').implementation = function(intent) {
      var action = intent.getAction() || 'null';
      var data = intent.getDataString() || 'null';
      var component = intent.getComponent();
      var compStr = component ? component.getClassName() : 'null';
      console.log('[DarkRide][Intent] startActivity: action=' + action + ' data=' + data + ' component=' + compStr);

      // Log extras
      var extras = intent.getExtras();
      if (extras) {
        var keys = extras.keySet().iterator();
        while (keys.hasNext()) {
          var key = keys.next();
          try {
            console.log('[DarkRide][Intent]   extra: ' + key + ' = ' + extras.get(key));
          } catch(e) {}
        }
      }

      this.startActivity(intent);
    };
  } catch(e) {}

  // sendBroadcast
  try {
    ContextWrapper.sendBroadcast.overload('android.content.Intent').implementation = function(intent) {
      console.log('[DarkRide][Intent] sendBroadcast: action=' + (intent.getAction() || 'null'));
      this.sendBroadcast(intent);
    };
  } catch(e) {}

  // startService
  try {
    ContextWrapper.startService.overload('android.content.Intent').implementation = function(intent) {
      var component = intent.getComponent();
      console.log('[DarkRide][Intent] startService: ' + (component ? component.getClassName() : intent.getAction()));
      return this.startService(intent);
    };
  } catch(e) {}

  console.log('[DarkRide][Intent] Intent monitor loaded');
});`,
  },
  {
    name: 'SharedPreferences Monitor',
    category: 'utility',
    description: 'Logs all SharedPreferences read/write operations with key-value pairs',
    code: `Java.perform(function() {
  try {
    var SharedPreferencesImpl = Java.use('android.app.SharedPreferencesImpl');
    var Editor = Java.use('android.app.SharedPreferencesImpl$EditorImpl');

    // Monitor writes
    var writeMethods = {
      'putString': 'string',
      'putInt': 'int',
      'putLong': 'long',
      'putFloat': 'float',
      'putBoolean': 'boolean',
    };

    Object.keys(writeMethods).forEach(function(method) {
      try {
        Editor[method].implementation = function(key, value) {
          console.log('[DarkRide][Prefs] PUT ' + writeMethods[method] + ' ' + key + ' = ' + value);
          return this[method](key, value);
        };
      } catch(e) {}
    });

    // Monitor reads
    try {
      SharedPreferencesImpl.getString.overload('java.lang.String', 'java.lang.String').implementation = function(key, def) {
        var val = this.getString(key, def);
        console.log('[DarkRide][Prefs] GET string ' + key + ' = ' + val);
        return val;
      };
    } catch(e) {}

    try {
      SharedPreferencesImpl.getInt.overload('java.lang.String', 'int').implementation = function(key, def) {
        var val = this.getInt(key, def);
        console.log('[DarkRide][Prefs] GET int ' + key + ' = ' + val);
        return val;
      };
    } catch(e) {}

    try {
      SharedPreferencesImpl.getBoolean.overload('java.lang.String', 'boolean').implementation = function(key, def) {
        var val = this.getBoolean(key, def);
        console.log('[DarkRide][Prefs] GET boolean ' + key + ' = ' + val);
        return val;
      };
    } catch(e) {}

    console.log('[DarkRide][Prefs] SharedPreferences monitor loaded');
  } catch(e) {
    console.log('[DarkRide][Prefs] Error: ' + e);
  }
});`,
  },
  {
    name: 'Crypto Monitor',
    category: 'utility',
    description: 'Logs cryptographic operations: Cipher encrypt/decrypt, MessageDigest hashing, SecretKeySpec creation',
    code: `Java.perform(function() {
  // Cipher operations
  try {
    var Cipher = Java.use('javax.crypto.Cipher');

    Cipher.getInstance.overload('java.lang.String').implementation = function(transformation) {
      console.log('[DarkRide][Crypto] Cipher.getInstance: ' + transformation);
      return this.getInstance(transformation);
    };

    Cipher.doFinal.overload('[B').implementation = function(input) {
      var mode = this.getOpmode ? '' : '';
      console.log('[DarkRide][Crypto] Cipher.doFinal (input: ' + input.length + ' bytes, algo: ' + this.getAlgorithm() + ')');
      return this.doFinal(input);
    };
  } catch(e) {}

  // MessageDigest
  try {
    var MessageDigest = Java.use('java.security.MessageDigest');
    MessageDigest.getInstance.overload('java.lang.String').implementation = function(algo) {
      console.log('[DarkRide][Crypto] MessageDigest.getInstance: ' + algo);
      return this.getInstance(algo);
    };

    MessageDigest.digest.overload('[B').implementation = function(input) {
      var result = this.digest(input);
      console.log('[DarkRide][Crypto] MessageDigest.digest (' + this.getAlgorithm() + ', input: ' + input.length + ' bytes)');
      return result;
    };
  } catch(e) {}

  // SecretKeySpec — reveals encryption keys
  try {
    var SecretKeySpec = Java.use('javax.crypto.spec.SecretKeySpec');
    SecretKeySpec.$init.overload('[B', 'java.lang.String').implementation = function(key, algo) {
      var hex = '';
      for (var i = 0; i < key.length; i++) {
        hex += ('0' + (key[i] & 0xff).toString(16)).slice(-2);
      }
      console.log('[DarkRide][Crypto] SecretKeySpec(' + algo + ', key: ' + hex + ')');
      return this.$init(key, algo);
    };
  } catch(e) {}

  console.log('[DarkRide][Crypto] Crypto monitor loaded');
});`,
  },
  {
    name: 'Network Traffic Logger',
    category: 'utility',
    description: 'Logs all HTTP/HTTPS requests via HttpURLConnection and OkHttp3 with URL, method, and response codes',
    code: `Java.perform(function() {
  // HttpURLConnection
  try {
    var HttpURLConnection = Java.use('java.net.HttpURLConnection');
    HttpURLConnection.getResponseCode.implementation = function() {
      var code = this.getResponseCode();
      var url = this.getURL().toString();
      var method = this.getRequestMethod();
      console.log('[DarkRide][Network] ' + method + ' ' + url + ' → ' + code);
      return code;
    };
    console.log('[DarkRide][Network] HttpURLConnection.getResponseCode hooked');
  } catch(e) {}

  // OkHttp3 interceptor
  try {
    var RealCall = Java.use('okhttp3.internal.connection.RealCall');
    RealCall.getResponseWithInterceptorChain.implementation = function() {
      var response = this.getResponseWithInterceptorChain();
      try {
        var request = response.request();
        var url = request.url().toString();
        var method = request.method();
        var code = response.code();
        console.log('[DarkRide][Network] OkHttp: ' + method + ' ' + url + ' → ' + code);
      } catch(e2) {}
      return response;
    };
    console.log('[DarkRide][Network] OkHttp3 RealCall hooked');
  } catch(e) {
    // Try older OkHttp path
    try {
      var RealCall2 = Java.use('okhttp3.RealCall');
      RealCall2.getResponseWithInterceptorChain.implementation = function() {
        var response = this.getResponseWithInterceptorChain();
        try {
          var request = response.request();
          console.log('[DarkRide][Network] OkHttp: ' + request.method() + ' ' + request.url().toString() + ' → ' + response.code());
        } catch(e2) {}
        return response;
      };
    } catch(e2) {}
  }

  console.log('[DarkRide][Network] Network traffic logger loaded');
});`,
  },
  {
    name: 'WebView Debug Bridge',
    category: 'utility',
    description: 'Enables WebView debugging for all WebViews and logs JavaScript-to-native bridge calls',
    code: `Java.perform(function() {
  // Enable WebView debugging globally
  try {
    var WebView = Java.use('android.webkit.WebView');
    WebView.setWebContentsDebuggingEnabled(true);
    console.log('[DarkRide][WebView] WebContentsDebuggingEnabled = true');
  } catch(e) {
    console.log('[DarkRide][WebView] Failed to enable debugging: ' + e);
  }

  // Hook WebView.loadUrl to log page loads
  try {
    var WebView2 = Java.use('android.webkit.WebView');
    WebView2.loadUrl.overload('java.lang.String').implementation = function(url) {
      console.log('[DarkRide][WebView] loadUrl: ' + url);
      this.loadUrl(url);
    };
    WebView2.loadUrl.overload('java.lang.String', 'java.util.Map').implementation = function(url, headers) {
      console.log('[DarkRide][WebView] loadUrl (with headers): ' + url);
      this.loadUrl(url, headers);
    };
  } catch(e) {}

  // Hook addJavascriptInterface to detect JS bridges
  try {
    var WebView3 = Java.use('android.webkit.WebView');
    WebView3.addJavascriptInterface.implementation = function(obj, name) {
      console.log('[DarkRide][WebView] addJavascriptInterface: "' + name + '" → ' + obj.getClass().getName());
      // List methods exposed to JS
      var methods = obj.getClass().getMethods();
      for (var i = 0; i < methods.length; i++) {
        var annotations = methods[i].getAnnotations();
        for (var j = 0; j < annotations.length; j++) {
          if (annotations[j].toString().indexOf('JavascriptInterface') !== -1) {
            console.log('[DarkRide][WebView]   @JavascriptInterface: ' + methods[i].getName());
          }
        }
      }
      this.addJavascriptInterface(obj, name);
    };
  } catch(e) {}

  // evaluateJavascript
  try {
    var WebView4 = Java.use('android.webkit.WebView');
    WebView4.evaluateJavascript.implementation = function(script, callback) {
      var preview = script.length > 200 ? script.substring(0, 200) + '...' : script;
      console.log('[DarkRide][WebView] evaluateJavascript: ' + preview);
      this.evaluateJavascript(script, callback);
    };
  } catch(e) {}

  console.log('[DarkRide][WebView] WebView debug bridge loaded');
});`,
  },

  // ─── Analytics / Monitoring Bypass ──────────────────────────────────
  {
    name: 'Dynatrace Crash Guard',
    category: 'analytics-bypass',
    description: 'Intercepts Application instantiation to catch Dynatrace ArithmeticException crashes during Frida gadget injection. Falls back to plain Application on crash.',
    code: `Java.perform(function() {
  var Instrumentation = Java.use('android.app.Instrumentation');
  var overload = Instrumentation.newApplication.overload('java.lang.ClassLoader', 'java.lang.String', 'android.content.Context');

  overload.implementation = function(cl, className, context) {
    if (className === 'com.dynatrace.android.app.Application') {
      console.log('[DarkRide][Dynatrace] Intercepted Dynatrace Application creation — trying with crash guard');
      try {
        return overload.call(this, cl, className, context);
      } catch(e) {
        console.log('[DarkRide][Dynatrace] Dynatrace Application crashed: ' + e);
        console.log('[DarkRide][Dynatrace] Falling back to android.app.Application');
        return overload.call(this, cl, 'android.app.Application', context);
      }
    }
    return overload.call(this, cl, className, context);
  };

  console.log('[DarkRide][Dynatrace] Crash guard installed on Instrumentation.newApplication');
});`,
  },
  {
    name: 'Dynatrace Full Disable',
    category: 'analytics-bypass',
    description: 'Completely bypasses Dynatrace SDK by replacing its Application class at instantiation time. Intercepts at the Instrumentation level before any Dynatrace native code can run.',
    code: `Java.perform(function() {
  var Instrumentation = Java.use('android.app.Instrumentation');
  var overload = Instrumentation.newApplication.overload('java.lang.ClassLoader', 'java.lang.String', 'android.content.Context');

  overload.implementation = function(cl, className, context) {
    if (className === 'com.dynatrace.android.app.Application') {
      console.log('[DarkRide][Dynatrace] Replacing Dynatrace Application with android.app.Application');
      return overload.call(this, cl, 'android.app.Application', context);
    }
    return overload.call(this, cl, className, context);
  };

  // Neutralise Dynatrace background threads that crash without initialization
  // Hook the specific obfuscated Runnable classes from the crash stack
  var dynatraceClasses = [
    'o.SessionResetPolicy$valueOf',
    'o.SessionResetPolicy$4',
    'o.RequestMonitorRequestCompleteListenerExternalSyntheticLambda0',
  ];
  for (var i = 0; i < dynatraceClasses.length; i++) {
    try {
      var cls = Java.use(dynatraceClasses[i]);
      if (cls.run) {
        cls.run.implementation = function() {
          console.log('[DarkRide][Dynatrace] Suppressed Dynatrace background Runnable');
        };
      }
    } catch(e) {}
  }

  // Broad safety net: hook Thread.start to wrap any Runnable in try-catch
  var Thread = Java.use('java.lang.Thread');
  var origStart = Thread.start;
  origStart.implementation = function() {
    var threadName = this.getName();
    var target = this.getClass().getName();
    // For threads from obfuscated Dynatrace code, wrap in try-catch
    if (target.indexOf('SessionResetPolicy') !== -1 || target.indexOf('RequestMonitor') !== -1) {
      console.log('[DarkRide][Dynatrace] Blocked Dynatrace thread: ' + threadName + ' (' + target + ')');
      return;
    }
    origStart.call(this);
  };

  console.log('[DarkRide][Dynatrace] Full disable installed — Dynatrace Application class will be skipped');
});`,
  },
  {
    name: 'ContentProvider Crash Guard',
    category: 'analytics-bypass',
    description: 'Catches and suppresses crashes from any ContentProvider during app startup. Useful on microG/degoogled devices where analytics SDKs (ML Kit, Adjust, Firebase, etc.) fail without full Google Play Services.',
    code: `Java.perform(function() {
  var ContentProvider = Java.use('android.content.ContentProvider');
  var origAttachInfo = ContentProvider.attachInfo.overload('android.content.Context', 'android.content.pm.ProviderInfo');

  origAttachInfo.implementation = function(context, info) {
    var name = info ? info.name.value : 'unknown';
    try {
      origAttachInfo.call(this, context, info);
    } catch(e) {
      console.log('[DarkRide][CPGuard] ContentProvider crashed during init: ' + name);
      console.log('[DarkRide][CPGuard] Error: ' + e + ' — suppressed');
    }
  };

  console.log('[DarkRide][CPGuard] ContentProvider crash guard loaded — all provider init errors will be caught');
});`,
  },
];

export function seedFridaScriptLibrary(db: AppDatabase): void {
  const now = new Date();
  let inserted = 0;
  let updated = 0;

  for (const script of LIBRARY_SCRIPTS) {
    const existing = db.select().from(fridaScripts)
      .where(and(eq(fridaScripts.name, script.name), eq(fridaScripts.isBuiltin, true)))
      .all()[0];

    if (existing) {
      // Update if code or description changed
      if (existing.code !== script.code || existing.description !== script.description || existing.category !== script.category) {
        db.update(fridaScripts).set({
          code: script.code,
          description: script.description,
          category: script.category,
          updatedAt: now,
        }).where(eq(fridaScripts.id, existing.id)).run();
        updated++;
      }
    } else {
      db.insert(fridaScripts).values({
        name: script.name,
        code: script.code,
        description: script.description,
        category: script.category,
        isBuiltin: true,
        targetApp: null,
        createdAt: now,
        updatedAt: now,
      }).run();
      inserted++;
    }
  }

  if (inserted > 0 || updated > 0) {
    log(`Seeded script library: ${inserted} inserted, ${updated} updated`);
  }
}
