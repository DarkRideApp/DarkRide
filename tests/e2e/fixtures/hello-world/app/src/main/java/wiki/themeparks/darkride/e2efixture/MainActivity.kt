package wiki.themeparks.darkride.e2efixture

import android.app.Activity
import android.os.Bundle
import android.widget.TextView
import java.net.HttpURLConnection
import java.net.InetSocketAddress
import java.net.Proxy
import java.net.URL
import kotlin.concurrent.thread

/**
 * E2E fixture for DarkRide emulator-capture testing.
 * On create, issues a single HTTPS GET to https://e2e.example.test/ping.
 * The DarkRide E2E test (tests/e2e/emulator-capture.test.ts) asserts the
 * captured request appears in the traffic store with the expected hostname.
 *
 * Proxy selection priority:
 *   1. Intent extra "proxy_url" (format "host:port") — set by the E2E
 *      harness via `am start ... --es proxy_url 127.0.0.1:NNNNN`. This
 *      is the only reliable way to get HttpURLConnection to honour a
 *      specific proxy on Android — the system-wide `settings put global
 *      http_proxy` value is not consistently picked up by Java code.
 *   2. No proxy — direct connection. The fixture still works without
 *      DarkRide; useful for sanity-checking the APK on a real device.
 *
 * Implementation notes:
 * - Uses HttpURLConnection (no library deps — keeps the APK tiny).
 * - Network call runs on a background thread (Android disallows network on UI thread).
 * - networkSecurityConfig (res/xml/network_security_config.xml) trusts
 *   user-installed CAs so mitmproxy's intercepted TLS validates.
 */
class MainActivity : Activity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        val tv = TextView(this).apply { textSize = 16f }
        setContentView(tv)
        val proxyUrl = intent?.getStringExtra("proxy_url")
        thread {
            try {
                val url = URL("https://e2e.example.test/ping")
                val conn = if (proxyUrl != null && proxyUrl.contains(':')) {
                    val (host, portStr) = proxyUrl.split(":", limit = 2)
                    val proxy = Proxy(Proxy.Type.HTTP, InetSocketAddress(host, portStr.toInt()))
                    url.openConnection(proxy) as HttpURLConnection
                } else {
                    url.openConnection() as HttpURLConnection
                }
                conn.connectTimeout = 5000
                conn.readTimeout = 5000
                conn.requestMethod = "GET"
                conn.connect()
                val code = conn.responseCode
                runOnUiThread { tv.text = "ping sent via proxy=${proxyUrl ?: "(none)"}: $code" }
                conn.disconnect()
            } catch (e: Exception) {
                runOnUiThread { tv.text = "ping failed via proxy=${proxyUrl ?: "(none)"}: ${e.message}" }
            }
        }
    }
}
