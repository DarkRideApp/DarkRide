package wiki.themeparks.darkride.e2efixture

import android.app.Activity
import android.os.Bundle
import android.widget.TextView
import java.net.HttpURLConnection
import java.net.URL
import kotlin.concurrent.thread

/**
 * E2E fixture for DarkRide emulator-capture testing.
 * Onresume, issues a single HTTPS GET to https://e2e.example.test/ping.
 * The DarkRide E2E test (tests/e2e/emulator-capture.test.ts) asserts the
 * captured request appears in the traffic store with the expected hostname.
 *
 * Implementation notes:
 * - Uses HttpURLConnection (no library deps — keeps the APK tiny).
 * - Network call runs on a background thread (Android disallows network on UI thread).
 * - The TextView reflects success/failure for manual inspection if anyone
 *   runs the APK by hand, but the E2E test doesn't read it — only the
 *   captured traffic.
 */
class MainActivity : Activity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        val tv = TextView(this).apply { textSize = 16f }
        setContentView(tv)
        thread {
            try {
                val conn = URL("https://e2e.example.test/ping").openConnection() as HttpURLConnection
                conn.connectTimeout = 5000
                conn.readTimeout = 5000
                conn.requestMethod = "GET"
                conn.connect()
                val code = conn.responseCode
                runOnUiThread { tv.text = "ping sent: $code" }
                conn.disconnect()
            } catch (e: Exception) {
                runOnUiThread { tv.text = "ping failed: ${e.message}" }
            }
        }
    }
}
