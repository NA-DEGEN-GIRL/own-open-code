package dev.own.opencode.android;

import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.InetSocketAddress;
import java.net.Proxy;
import java.net.Socket;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.security.GeneralSecurityException;
import java.security.cert.CertificateException;
import java.security.cert.X509Certificate;
import java.util.Map;
import javax.net.ssl.HostnameVerifier;
import javax.net.ssl.HttpsURLConnection;
import javax.net.ssl.SSLContext;
import javax.net.ssl.SSLEngine;
import javax.net.ssl.SSLPeerUnverifiedException;
import javax.net.ssl.SSLSession;
import javax.net.ssl.SSLSocketFactory;
import javax.net.ssl.TrustManager;
import javax.net.ssl.X509ExtendedTrustManager;

/**
 * Native HTTPS to one PC's app host through the local {@link RouteProxy} (08-app-access.md §3.4 3): the only trusted
 * certificate is the one whose key has the PC's pin (no CA, no system trust store), and the only accepted host name is
 * {@code <pcKey>.ownpc.internal}. Requests go to {@code https://<pcKey>.ownpc.internal/...}, so the gateway sees exactly
 * that Host (port 443 implied; its app listener answers 421 to anything else).
 *
 * <p>Never log request headers or bodies here: they carry the pairing claim secret or the device token.
 */
final class PinnedHttps {
    static final int CONNECT_TIMEOUT_MS = 10_000;
    static final int READ_TIMEOUT_MS = 20_000;
    private static final int MAX_BODY = 1024 * 1024;

    final String pcKey;
    final String host;
    private final String pin;
    private final Proxy proxy;
    private final String userAgent;
    private final int connectTimeoutMs;
    private final int readTimeoutMs;
    private final SSLSocketFactory sockets;
    private final HostnameVerifier verifier;

    PinnedHttps(String pcKey, String pin, int proxyPort, String userAgent) {
        this(pcKey, pin, proxyPort, userAgent, CONNECT_TIMEOUT_MS, READ_TIMEOUT_MS);
    }

    /** {@code readTimeoutMs} also bounds the proxy's CONNECT answer, i.e. the route attempts. */
    PinnedHttps(String pcKey, String pin, int proxyPort, String userAgent, int connectTimeoutMs, int readTimeoutMs) {
        if (!AppHost.isPcKey(pcKey) || !Pins.isPin(pin)) throw new IllegalArgumentException("bad pcKey or pin");
        this.connectTimeoutMs = connectTimeoutMs;
        this.readTimeoutMs = readTimeoutMs;
        this.pcKey = pcKey;
        this.host = AppHost.host(pcKey);
        this.pin = pin;
        this.proxy = new Proxy(Proxy.Type.HTTP, new InetSocketAddress("127.0.0.1", proxyPort));
        this.userAgent = userAgent;
        try {
            // A context of its own: TLS sessions it caches were all verified against this pin.
            SSLContext context = SSLContext.getInstance("TLS");
            context.init(null, new TrustManager[] {new PinTrust(pin)}, null);
            this.sockets = context.getSocketFactory();
        } catch (GeneralSecurityException e) {
            throw new IllegalStateException(e);
        }
        this.verifier = this::verify;
    }

    static final class Response {
        final int status;
        final String body;

        Response(int status, String body) {
            this.status = status;
            this.body = body;
        }
    }

    /** The certificate's key does not have the expected pin. */
    static final class PinMismatch extends CertificateException {
        PinMismatch() {
            super("own-pin-mismatch: the PC's certificate key does not match the pin");
        }
    }

    Response get(String path, Map<String, String> headers) throws IOException {
        return send("GET", path, headers, null);
    }

    Response post(String path, Map<String, String> headers, String json) throws IOException {
        return send("POST", path, headers, json);
    }

    /**
     * Whether a failure was the pin check (wrong key or wrong name) rather than the network. TLS stacks wrap the trust
     * manager's exception differently, so the cause chain and the marker text are both checked.
     */
    static boolean isPinFailure(Throwable error) {
        for (Throwable t = error; t != null; t = t.getCause() == t ? null : t.getCause()) {
            if (t instanceof PinMismatch || t instanceof SSLPeerUnverifiedException) return true;
            String message = t.getMessage();
            if (message != null && message.contains("own-pin-mismatch")) return true;
        }
        return false;
    }

    private Response send(String method, String path, Map<String, String> headers, String body) throws IOException {
        if (!path.startsWith("/")) throw new IllegalArgumentException("path must start with /");
        HttpsURLConnection connection = (HttpsURLConnection) new URL("https://" + host + path).openConnection(proxy);
        try {
            connection.setSSLSocketFactory(sockets);
            connection.setHostnameVerifier(verifier);
            connection.setRequestMethod(method);
            connection.setInstanceFollowRedirects(false);
            connection.setUseCaches(false);
            connection.setConnectTimeout(connectTimeoutMs);
            connection.setReadTimeout(readTimeoutMs);
            connection.setRequestProperty("User-Agent", userAgent);
            connection.setRequestProperty("Cache-Control", "no-store");
            for (Map.Entry<String, String> header : headers.entrySet()) {
                connection.setRequestProperty(header.getKey(), header.getValue());
            }
            if (body != null) {
                byte[] bytes = body.getBytes(StandardCharsets.UTF_8);
                connection.setDoOutput(true);
                connection.setFixedLengthStreamingMode(bytes.length);
                connection.setRequestProperty("Content-Type", "application/json");
                try (OutputStream out = connection.getOutputStream()) {
                    out.write(bytes);
                }
            }
            int status = connection.getResponseCode();
            InputStream stream = status >= 400 ? connection.getErrorStream() : connection.getInputStream();
            return new Response(status, stream == null ? "" : read(stream));
        } finally {
            connection.disconnect();
        }
    }

    /** Host name check, plus the pin again on the session (covers resumed sessions too). */
    private boolean verify(String hostname, SSLSession session) {
        if (!host.equalsIgnoreCase(hostname)) return false;
        try {
            java.security.cert.Certificate[] chain = session.getPeerCertificates();
            return chain.length > 0 && chain[0] instanceof X509Certificate && Pins.matches((X509Certificate) chain[0], pin);
        } catch (SSLPeerUnverifiedException e) {
            return false;
        }
    }

    private static String read(InputStream stream) throws IOException {
        try (InputStream in = stream) {
            ByteArrayOutputStream out = new ByteArrayOutputStream();
            byte[] buffer = new byte[8192];
            for (int n; (n = in.read(buffer)) >= 0; ) {
                out.write(buffer, 0, n);
                if (out.size() > MAX_BODY) throw new IOException("response too large");
            }
            return new String(out.toByteArray(), StandardCharsets.UTF_8);
        }
    }

    /**
     * Trusts exactly the leaf certificate whose key has the pin; never consults a CA or the system store (08 §3.4: the
     * pin is the whole trust model, and no CA can issue for {@code .internal}).
     */
    @SuppressWarnings("CustomX509TrustManager") // lint id; Android lint honors @SuppressWarnings
    private static final class PinTrust extends X509ExtendedTrustManager {
        private final String pin;

        PinTrust(String pin) {
            this.pin = pin;
        }

        private void check(X509Certificate[] chain) throws CertificateException {
            if (chain == null || chain.length == 0 || !Pins.matches(chain[0], pin)) throw new PinMismatch();
        }

        @Override
        public void checkServerTrusted(X509Certificate[] chain, String authType) throws CertificateException {
            check(chain);
        }

        @Override
        public void checkServerTrusted(X509Certificate[] chain, String authType, Socket socket) throws CertificateException {
            check(chain);
        }

        @Override
        public void checkServerTrusted(X509Certificate[] chain, String authType, SSLEngine engine) throws CertificateException {
            check(chain);
        }

        @Override
        public void checkClientTrusted(X509Certificate[] chain, String authType) throws CertificateException {
            throw new CertificateException("client certificates are not accepted");
        }

        @Override
        public void checkClientTrusted(X509Certificate[] chain, String authType, Socket socket) throws CertificateException {
            throw new CertificateException("client certificates are not accepted");
        }

        @Override
        public void checkClientTrusted(X509Certificate[] chain, String authType, SSLEngine engine) throws CertificateException {
            throw new CertificateException("client certificates are not accepted");
        }

        @Override
        public X509Certificate[] getAcceptedIssuers() {
            return new X509Certificate[0];
        }
    }
}
