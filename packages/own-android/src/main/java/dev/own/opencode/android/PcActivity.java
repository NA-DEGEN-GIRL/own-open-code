package dev.own.opencode.android;

import android.Manifest;
import android.annotation.SuppressLint;
import android.app.Activity;
import android.content.ActivityNotFoundException;
import android.content.ClipData;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.net.Uri;
import android.net.http.SslCertificate;
import android.net.http.SslError;
import android.os.Build;
import android.os.Bundle;
import android.view.View;
import android.view.WindowInsetsController;
import android.view.ViewGroup;
import android.webkit.CookieManager;
import android.webkit.PermissionRequest;
import android.webkit.RenderProcessGoneDetail;
import android.webkit.SslErrorHandler;
import android.webkit.ValueCallback;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceError;
import android.webkit.WebResourceRequest;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.Button;
import android.widget.FrameLayout;
import android.widget.ProgressBar;
import android.widget.TextView;
import android.window.OnBackInvokedCallback;
import android.window.OnBackInvokedDispatcher;
import androidx.annotation.RequiresApi;
import androidx.webkit.WebViewFeature;
import java.io.IOException;
import java.util.HashMap;
import java.util.Map;

/**
 * One PC's own-web in a WebView at {@code https://<pcKey>.ownpc.internal/} (08-app-access.md §3.4): all traffic goes
 * through the route proxy, the certificate is accepted only by its pin, and anything outside the app origin opens in
 * the browser. After the page loads, {@code GET /own/routes} refreshes the stored routes (08 §3.6). The page gets the
 * microphone for voice input only (audio, the app origin, after the RECORD_AUDIO prompt; 02 §3.9, {@link MicPermission}).
 */
public final class PcActivity extends Activity {
    static final String EXTRA_PC_KEY = "pcKey";
    private static final int REQUEST_FILES = 1;
    private static final int REQUEST_MIC = 2;
    private static final long THEME_WATCH_MS = 1500;
    private static final long BACK_ANSWER_MS = 500;

    private OwnApp app;
    private PcRecord record;
    private FrameLayout root;
    private WebView web;
    private ProgressBar progress;
    private View overlay;
    private Button retry;
    private ValueCallback<Uri[]> fileCallback;
    /** A page's microphone request waiting for the RECORD_AUDIO prompt. */
    private PermissionRequest micRequest;
    /** A security or device-auth stop: nothing loads again in this screen. */
    private boolean blocked;
    private boolean mainFrameFailed;
    private boolean routesChecked;
    private Object backCallback;
    private boolean backRegistered;
    /** The bars' look last applied (0: none yet), so the watch below repaints only on a change. */
    private int barsColor;
    private boolean barsLight;
    /** While resumed: the page's theme changes without a navigation (설정 > 일반 > 테마) and after its first paint. */
    private final Runnable themeWatch = new Runnable() {
        @Override
        public void run() {
            readTheme();
            if (root != null) root.postDelayed(this, THEME_WATCH_MS);
        }
    };

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        app = OwnApp.of(this);
        String pcKey = getIntent().getStringExtra(EXTRA_PC_KEY);
        record = pcKey == null ? null : app.store().get(pcKey);
        if (record == null) {
            finish();
            return;
        }
        setContentView(R.layout.activity_pc);
        root = findViewById(R.id.root);
        EdgeToEdge.apply(this, root);
        progress = findViewById(R.id.progress);
        overlay = findViewById(R.id.overlay);
        retry = findViewById(R.id.overlay_retry);
        findViewById(R.id.overlay_back).setOnClickListener(v -> finish());
        retry.setOnClickListener(v -> {
            if (web == null) recreate();
            else connect();
        });
        setTitle(record.name);

        if (!WebViewFeature.isFeatureSupported(WebViewFeature.PROXY_OVERRIDE)) {
            block(R.string.webview_old_title, R.string.webview_old_body);
            return;
        }
        try {
            web = new WebView(this);
        } catch (RuntimeException e) {
            // No WebView provider, or it is being updated.
            showMessage(R.string.webview_old_title, R.string.webview_missing_body, false);
            return;
        }
        configure(web);
        root.addView(web, 0, new FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) BackApi33.create(this);
        connect();
    }

    /** Loads the PC once WebView traffic goes through the route proxy (never directly). */
    private void connect() {
        app.withWebProxy(ready -> {
            if (isDestroyed()) return;
            if (ready) load();
            else showMessage(R.string.unreachable_title, R.string.unreachable_body, true);
        });
    }

    @Override
    protected void onResume() {
        super.onResume();
        if (web != null) web.onResume();
        if (root != null) root.post(themeWatch);
    }

    @Override
    protected void onPause() {
        if (root != null) root.removeCallbacks(themeWatch);
        if (web != null) web.onPause();
        CookieManager.getInstance().flush();
        super.onPause();
    }

    @Override
    protected void onDestroy() {
        if (fileCallback != null) fileCallback.onReceiveValue(null);
        fileCallback = null;
        if (micRequest != null) micRequest.deny();
        micRequest = null;
        if (web != null) {
            root.removeView(web);
            web.destroy();
            web = null;
        }
        super.onDestroy();
    }

    /**
     * Android 10–12 only: 13+ (enableOnBackInvokedCallback, predictive back) never calls this and uses the
     * OnBackInvokedCallback that {@link BackApi33} registers while the page is up.
     */
    @Override
    @SuppressWarnings("deprecation")
    @SuppressLint("GestureBackNavigation")
    public void onBackPressed() {
        back();
    }

    /**
     * Back (MUX 2026-11-06): first the page closes what is open on top, a sheet, menu or dialog
     * ({@code window.ownApp.back()}, own-web src/host/app-bridge.ts); then the page's own history; then the PC list.
     */
    private void back() {
        if (web == null || overlay.getVisibility() == View.VISIBLE) {
            finish();
            return;
        }
        WebView view = web;
        // A page that is still loading or stuck never answers (the G7, a PC that stopped answering mid-load): after
        // BACK_ANSWER_MS back goes on without it, so the button never does nothing. Whichever comes first acts, once.
        boolean[] done = {false};
        Runnable fallback = () -> {
            if (done[0] || isDestroyed() || web != view) return;
            done[0] = true;
            if (canGoBack()) view.goBack();
            else finish();
        };
        root.postDelayed(fallback, BACK_ANSWER_MS);
        view.evaluateJavascript("window.ownApp ? window.ownApp.back() : false", value -> {
            if (done[0] || isDestroyed() || web != view) return;
            done[0] = true;
            root.removeCallbacks(fallback);
            if ("true".equals(value)) return;
            if (canGoBack()) view.goBack();
            else finish();
        });
    }

    /** The status and navigation bars in the page's colors ({@link SystemBars}); an older own-web keeps the app's. */
    private void readTheme() {
        if (web == null || blocked || overlay.getVisibility() == View.VISIBLE) return;
        WebView view = web;
        view.evaluateJavascript("window.ownApp ? window.ownApp.theme() : null", value -> {
            if (isDestroyed() || web != view) return;
            SystemBars.Look look = SystemBars.parse(value);
            if (look != null) applyBars(look.color, look.lightPage);
        });
    }

    @SuppressWarnings("deprecation")
    private void applyBars(int color, boolean lightPage) {
        if (color == barsColor && lightPage == barsLight) return;
        barsColor = color;
        barsLight = lightPage;
        root.setBackgroundColor(color);
        getWindow().setStatusBarColor(color);
        getWindow().setNavigationBarColor(color);
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
            WindowInsetsController controller = getWindow().getInsetsController();
            if (controller == null) return;
            int both = WindowInsetsController.APPEARANCE_LIGHT_STATUS_BARS | WindowInsetsController.APPEARANCE_LIGHT_NAVIGATION_BARS;
            controller.setSystemBarsAppearance(lightPage ? both : 0, both);
            return;
        }
        View decor = getWindow().getDecorView();
        int flags = View.SYSTEM_UI_FLAG_LIGHT_STATUS_BAR | View.SYSTEM_UI_FLAG_LIGHT_NAVIGATION_BAR;
        int ui = decor.getSystemUiVisibility();
        decor.setSystemUiVisibility(lightPage ? ui | flags : ui & ~flags);
    }

    private boolean canGoBack() {
        return web != null && overlay.getVisibility() != View.VISIBLE && web.canGoBack();
    }

    /** The page handles back while it is up (Android 13+); a message screen leaves back to the system. */
    private void updateBack() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU)
            BackApi33.update(this, web != null && overlay.getVisibility() != View.VISIBLE);
    }

    @SuppressWarnings("SetJavaScriptEnabled")
    private void configure(WebView view) {
        WebSettings settings = view.getSettings();
        settings.setJavaScriptEnabled(true);
        settings.setDomStorageEnabled(true);
        settings.setAllowFileAccess(false);
        settings.setAllowContentAccess(false);
        settings.setMixedContentMode(WebSettings.MIXED_CONTENT_NEVER_ALLOW);
        settings.setSupportMultipleWindows(false);
        settings.setJavaScriptCanOpenWindowsAutomatically(false);
        settings.setGeolocationEnabled(false);
        settings.setUserAgentString(settings.getUserAgentString() + OwnApp.WEB_UA_SUFFIX);
        view.setBackgroundColor(getColor(R.color.background));
        CookieManager.getInstance().setAcceptThirdPartyCookies(view, false);
        // Forget earlier "proceed" decisions so every certificate this screen sees is judged by the current pin.
        view.clearSslPreferences();
        view.setWebViewClient(new Client());
        view.setWebChromeClient(new Chrome());
    }

    private void load() {
        if (blocked || web == null) return;
        PcRecord current = app.store().get(record.pcKey);
        if (current == null) {
            finish();
            return;
        }
        record = current;
        mainFrameFailed = false;
        overlay.setVisibility(View.GONE);
        web.setVisibility(View.VISIBLE);
        web.loadUrl(record.origin() + "/");
    }

    private boolean isAppOrigin(Uri url) {
        return url != null && "https".equalsIgnoreCase(url.getScheme()) && record.appHost().equalsIgnoreCase(url.getHost())
                && (url.getPort() == -1 || url.getPort() == 443);
    }

    /** http(s) and mailto only: a remote page must not launch arbitrary intents (intent:, market:, ...). */
    private void openExternally(Uri url) {
        String scheme = url.getScheme() == null ? "" : url.getScheme().toLowerCase(java.util.Locale.ROOT);
        if (!scheme.equals("https") && !scheme.equals("http") && !scheme.equals("mailto")) return;
        // Another PC's app host only works inside this app's proxy; a browser could not open it.
        if (AppHost.pcKeyOf(url.getHost()) != null) return;
        try {
            startActivity(new Intent(Intent.ACTION_VIEW, url).addCategory(Intent.CATEGORY_BROWSABLE));
        } catch (ActivityNotFoundException ignored) {
            // Nothing handles it.
        }
    }

    private void showMessage(int title, int body, boolean canRetry) {
        ((TextView) findViewById(R.id.overlay_title)).setText(title);
        ((TextView) findViewById(R.id.overlay_body)).setText(body);
        retry.setVisibility(canRetry ? View.VISIBLE : View.GONE);
        overlay.setVisibility(View.VISIBLE);
        progress.setVisibility(View.GONE);
        if (web != null) web.setVisibility(View.INVISIBLE);
        // A message screen is the app's own: its dark bars again.
        applyBars(getColor(R.color.background), false);
        updateBack();
    }

    /** Stops this screen for good: security failures and dead device credentials. */
    private void block(int title, int body) {
        blocked = true;
        if (web != null) {
            web.stopLoading();
            web.loadUrl("about:blank");
        }
        showMessage(title, body, false);
    }

    /** {@code GET /own/routes} with the device token from the cookie store (08 §3.5, §3.6). */
    private void refreshRoutes() {
        String token = DeviceCookies.token(record.pcKey);
        if (token == null) {
            // The cookie's Max-Age passed or it was removed: the device credential is gone.
            block(R.string.expired_title, R.string.expired_body);
            return;
        }
        PcRecord snapshot = record;
        app.io.execute(() -> {
            PinnedHttps.Response response;
            try {
                Map<String, String> headers = new HashMap<>();
                headers.put("Authorization", "Bearer " + token);
                headers.put("Accept", "application/json");
                response = app.http(snapshot.pcKey, snapshot.pin).get("/own/routes", headers);
            } catch (IOException e) {
                if (PinnedHttps.isPinFailure(e)) runOnUiThread(() -> blockIfAlive(R.string.security_title, R.string.security_body));
                return;
            }
            if (response.status == 401) {
                runOnUiThread(() -> blockIfAlive(R.string.expired_title, R.string.expired_body));
                return;
            }
            // Anything else (an older gateway without /own/routes, a busy one) leaves the stored routes as they are.
            if (response.status != 200) return;
            PcRecord.RouteUpdate update = snapshot.applyRoutes(response.body);
            if (update.outcome == PcRecord.Refresh.UPDATED) app.store().replace(snapshot, update.record);
            if (update.outcome == PcRecord.Refresh.PIN_CHANGED) {
                runOnUiThread(() -> blockIfAlive(R.string.pin_changed_title, R.string.pin_changed_body));
            }
        });
    }

    private void blockIfAlive(int title, int body) {
        if (!isDestroyed()) block(title, body);
    }

    private final class Client extends WebViewClient {
        @Override
        public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
            if (isAppOrigin(request.getUrl())) return false;
            // Only a link the user tapped leaves for another app: a remote page cannot open pages by itself.
            if (request.isForMainFrame() && request.hasGesture()) openExternally(request.getUrl());
            return true;
        }

        /**
         * The only way the app's certificate is accepted (08 §3.4 2): the app trusts no CA for {@code ownpc.internal}
         * (network_security_config.xml), so every connection to the PC lands here and proceeds only for the app host
         * with the pinned key.
         */
        @Override
        @SuppressLint("WebViewClientOnReceivedSslError")
        public void onReceivedSslError(WebView view, SslErrorHandler handler, SslError error) {
            Uri url = error.getUrl() == null ? null : Uri.parse(error.getUrl());
            SslCertificate certificate = error.getCertificate();
            if (!blocked && isAppOrigin(url) && certificate != null && Pins.matches(certificate.getX509Certificate(), record.pin)) {
                handler.proceed();
                return;
            }
            handler.cancel();
            if (!blocked) block(R.string.security_title, R.string.security_body);
        }

        @Override
        public void onReceivedError(WebView view, WebResourceRequest request, WebResourceError error) {
            if (!request.isForMainFrame() || blocked) return;
            mainFrameFailed = true;
            showMessage(R.string.unreachable_title, R.string.unreachable_body, true);
        }

        @Override
        public void onPageFinished(WebView view, String url) {
            updateBack();
            readTheme();
            if (blocked || mainFrameFailed || routesChecked || !isAppOrigin(Uri.parse(url))) return;
            routesChecked = true;
            refreshRoutes();
        }

        @Override
        public void doUpdateVisitedHistory(WebView view, String url, boolean isReload) {
            updateBack();
            readTheme();
        }

        @Override
        public boolean onRenderProcessGone(WebView view, RenderProcessGoneDetail detail) {
            // The WebView is unusable now; drop it and offer to rebuild the screen instead of crashing the app.
            if (web == view) {
                root.removeView(web);
                web.destroy();
                web = null;
            }
            if (!blocked) showMessage(R.string.crashed_title, R.string.crashed_body, true);
            return true;
        }
    }

    private final class Chrome extends WebChromeClient {
        @Override
        public void onProgressChanged(WebView view, int newProgress) {
            progress.setProgress(newProgress);
            progress.setVisibility(newProgress < 100 && overlay.getVisibility() != View.VISIBLE ? View.VISIBLE : View.GONE);
        }

        /**
         * Voice input (02 §3.9): audio capture for the app origin only ({@link MicPermission}); anything else, or a
         * blocked screen, is denied. The first time, Android asks for RECORD_AUDIO; the page sees a denial as
         * NotAllowedError and explains how to allow it.
         */
        @Override
        public void onPermissionRequest(PermissionRequest request) {
            runOnUiThread(() -> answerMic(request));
        }

        @Override
        public void onPermissionRequestCanceled(PermissionRequest request) {
            if (micRequest == request) micRequest = null;
        }

        @Override
        public boolean onShowFileChooser(WebView view, ValueCallback<Uri[]> callback, FileChooserParams params) {
            if (fileCallback != null) fileCallback.onReceiveValue(null);
            fileCallback = callback;
            Intent intent = params.createIntent();
            if (params.getMode() == FileChooserParams.MODE_OPEN_MULTIPLE) intent.putExtra(Intent.EXTRA_ALLOW_MULTIPLE, true);
            try {
                startActivityForResult(intent, REQUEST_FILES);
            } catch (ActivityNotFoundException e) {
                fileCallback = null;
                callback.onReceiveValue(null);
            }
            return true;
        }
    }

    private void answerMic(PermissionRequest request) {
        String origin = request.getOrigin() == null ? null : request.getOrigin().toString();
        if (blocked || isDestroyed() || !MicPermission.grantable(origin, record.appHost(), request.getResources())) {
            request.deny();
            return;
        }
        if (checkSelfPermission(Manifest.permission.RECORD_AUDIO) == PackageManager.PERMISSION_GRANTED) {
            request.grant(new String[] {PermissionRequest.RESOURCE_AUDIO_CAPTURE});
            return;
        }
        if (micRequest != null) micRequest.deny();
        micRequest = request;
        requestPermissions(new String[] {Manifest.permission.RECORD_AUDIO}, REQUEST_MIC);
    }

    @Override
    public void onRequestPermissionsResult(int requestCode, String[] permissions, int[] grantResults) {
        if (requestCode != REQUEST_MIC) {
            super.onRequestPermissionsResult(requestCode, permissions, grantResults);
            return;
        }
        PermissionRequest request = micRequest;
        micRequest = null;
        if (request == null) return;
        boolean granted = grantResults.length > 0 && grantResults[0] == PackageManager.PERMISSION_GRANTED;
        if (granted && !blocked) request.grant(new String[] {PermissionRequest.RESOURCE_AUDIO_CAPTURE});
        else request.deny();
    }

    @Override
    protected void onActivityResult(int requestCode, int resultCode, Intent data) {
        if (requestCode != REQUEST_FILES) {
            super.onActivityResult(requestCode, resultCode, data);
            return;
        }
        ValueCallback<Uri[]> callback = fileCallback;
        fileCallback = null;
        if (callback == null) return;
        Uri[] result = null;
        if (resultCode == RESULT_OK && data != null) {
            ClipData clip = data.getClipData();
            if (clip != null && clip.getItemCount() > 0) {
                result = new Uri[clip.getItemCount()];
                for (int i = 0; i < result.length; i++) result[i] = clip.getItemAt(i).getUri();
            } else {
                result = WebChromeClient.FileChooserParams.parseResult(resultCode, data);
            }
        }
        callback.onReceiveValue(result);
    }

    /** Predictive back (Android 13+): registered while the page is up, so the page can close its sheet first. */
    @RequiresApi(Build.VERSION_CODES.TIRAMISU)
    private static final class BackApi33 {
        static void create(PcActivity activity) {
            activity.backCallback = (OnBackInvokedCallback) activity::back;
        }

        static void update(PcActivity activity, boolean want) {
            if (activity.backCallback == null || want == activity.backRegistered) return;
            OnBackInvokedDispatcher dispatcher = activity.getOnBackInvokedDispatcher();
            OnBackInvokedCallback callback = (OnBackInvokedCallback) activity.backCallback;
            if (want) dispatcher.registerOnBackInvokedCallback(OnBackInvokedDispatcher.PRIORITY_DEFAULT, callback);
            else dispatcher.unregisterOnBackInvokedCallback(callback);
            activity.backRegistered = want;
        }
    }
}
