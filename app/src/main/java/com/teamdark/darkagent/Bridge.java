package com.teamdark.darkagent;

import android.webkit.JavascriptInterface;
import android.webkit.WebView;

import org.json.JSONObject;

import java.io.BufferedReader;
import java.io.InputStreamReader;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.util.Iterator;
import java.util.concurrent.ConcurrentHashMap;

/**
 * Native HTTP bridge.
 *
 * WebView pages loaded from file:// have a null origin, so calling provider APIs
 * straight from fetch() trips CORS. This bridge performs the request natively and
 * streams response lines back into JS through window.__nativeEvent().
 */
public class Bridge {

    private final WebView web;
    private final ConcurrentHashMap<String, HttpURLConnection> live = new ConcurrentHashMap<>();

    Bridge(WebView web) {
        this.web = web;
    }

    private void emit(String json) {
        final String js = "window.__nativeEvent(" + JSONObject.quote(json) + ");";
        web.post(new Runnable() {
            @Override
            public void run() {
                web.evaluateJavascript(js, null);
            }
        });
    }

    @JavascriptInterface
    public void post(final String id, final String urlStr, final String headersJson, final String bodyJson) {
        new Thread(new Runnable() {
            @Override
            public void run() {
                HttpURLConnection conn = null;
                try {
                    conn = (HttpURLConnection) new URL(urlStr).openConnection();
                    conn.setRequestMethod("POST");
                    conn.setConnectTimeout(30000);
                    conn.setReadTimeout(300000);
                    conn.setDoOutput(true);
                    conn.setRequestProperty("Content-Type", "application/json");
                    conn.setRequestProperty("Accept", "text/event-stream");

                    JSONObject headers = new JSONObject(headersJson == null ? "{}" : headersJson);
                    for (Iterator<String> it = headers.keys(); it.hasNext(); ) {
                        String key = it.next();
                        conn.setRequestProperty(key, headers.getString(key));
                    }

                    byte[] body = (bodyJson == null ? "{}" : bodyJson).getBytes("UTF-8");
                    conn.setFixedLengthStreamingMode(body.length);
                    try (OutputStream os = conn.getOutputStream()) {
                        os.write(body);
                    }

                    live.put(id, conn);

                    int status = conn.getResponseCode();
                    emit(new JSONObject()
                            .put("id", id)
                            .put("type", "status")
                            .put("status", status)
                            .toString());

                    BufferedReader reader = new BufferedReader(new InputStreamReader(
                            status >= 400 ? conn.getErrorStream() : conn.getInputStream(), "UTF-8"));
                    String line;
                    while ((line = reader.readLine()) != null) {
                        emit(new JSONObject()
                                .put("id", id)
                                .put("type", "line")
                                .put("line", line)
                                .toString());
                    }
                    reader.close();

                    emit(new JSONObject().put("id", id).put("type", "done").toString());
                } catch (Exception e) {
                    try {
                        emit(new JSONObject()
                                .put("id", id)
                                .put("type", "error")
                                .put("message", String.valueOf(e.getMessage()))
                                .toString());
                    } catch (Exception ignored) {
                        // nothing else we can do
                    }
                } finally {
                    live.remove(id);
                    if (conn != null) conn.disconnect();
                }
            }
        }).start();
    }

    /** GET a URL (search engines, docs pages) and stream the body lines back. */
    @JavascriptInterface
    public void get(final String id, final String urlStr, final String headersJson) {
        new Thread(new Runnable() {
            @Override
            public void run() {
                HttpURLConnection conn = null;
                try {
                    conn = (HttpURLConnection) new URL(urlStr).openConnection();
                    conn.setRequestMethod("GET");
                    conn.setConnectTimeout(20000);
                    conn.setReadTimeout(30000);
                    conn.setInstanceFollowRedirects(true);
                    conn.setRequestProperty("User-Agent",
                            "Mozilla/5.0 (Linux; Android 13) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Mobile Safari/537.36");
                    conn.setRequestProperty("Accept", "text/html,application/json;q=0.9,*/*;q=0.8");

                    JSONObject headers = new JSONObject(headersJson == null ? "{}" : headersJson);
                    for (Iterator<String> it = headers.keys(); it.hasNext(); ) {
                        String key = it.next();
                        conn.setRequestProperty(key, headers.getString(key));
                    }

                    live.put(id, conn);
                    int status = conn.getResponseCode();
                    emit(new JSONObject().put("id", id).put("type", "status").put("status", status).toString());

                    BufferedReader reader = new BufferedReader(new InputStreamReader(
                            status >= 400 ? conn.getErrorStream() : conn.getInputStream(), "UTF-8"));
                    String line;
                    while ((line = reader.readLine()) != null) {
                        emit(new JSONObject().put("id", id).put("type", "line").put("line", line).toString());
                    }
                    reader.close();

                    emit(new JSONObject().put("id", id).put("type", "done").toString());
                } catch (Exception e) {
                    try {
                        emit(new JSONObject()
                                .put("id", id)
                                .put("type", "error")
                                .put("message", String.valueOf(e.getMessage()))
                                .toString());
                    } catch (Exception ignored) {
                        // nothing else we can do
                    }
                } finally {
                    live.remove(id);
                    if (conn != null) conn.disconnect();
                }
            }
        }).start();
    }

    @JavascriptInterface
    public void abort(String id) {
        HttpURLConnection conn = live.remove(id);
        if (conn != null) {
            conn.disconnect();
        }
    }

    @JavascriptInterface
    public String info() {
        return "{\"bridge\":1}";
    }
}
