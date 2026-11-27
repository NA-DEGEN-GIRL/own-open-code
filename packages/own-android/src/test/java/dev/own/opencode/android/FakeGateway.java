package dev.own.opencode.android;

import java.io.BufferedInputStream;
import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.InetAddress;
import java.net.Socket;
import java.nio.charset.StandardCharsets;
import java.security.KeyStore;
import java.util.ArrayList;
import java.util.Collections;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.function.Function;
import javax.net.ssl.KeyManagerFactory;
import javax.net.ssl.SSLContext;
import javax.net.ssl.SSLServerSocket;

/**
 * A TLS server standing in for a PC's app listener: a minimal HTTP/1.1 responder (one request per connection) on
 * {@link SSLServerSocket}, since unit tests compile against android.jar (no com.sun.net.httpserver). It uses the
 * self-signed test certificates in src/test/resources (keytool: EC P-256, CN=own-open-code abcdefghijkl,
 * SAN DNS:abcdefghijkl.ownpc.internal, 10 years, password "changeit"). Their pins were computed independently with
 * openssl: {@code openssl x509 -pubkey -noout | openssl pkey -pubin -outform der | openssl dgst -sha256 -binary},
 * base64url without padding.
 */
final class FakeGateway implements AutoCloseable {
    static final String PC_KEY = "abcdefghijkl";
    static final String HOST = "abcdefghijkl.ownpc.internal";
    static final String PIN = "tRCeIOeRy6Qmva9xMrSwCLdABsQ-td8ZaTfqoEto0ks";
    static final String OTHER_PIN = "WLY4SjWQ-jzbqmFM9DVZ3c-kq9caRNg-xL1wExnvkWM";

    static final class Request {
        final String method;
        final String path;
        final Map<String, String> headers;
        final String body;

        Request(String method, String path, Map<String, String> headers, String body) {
            this.method = method;
            this.path = path;
            this.headers = headers;
            this.body = body;
        }

        String header(String name) {
            return headers.get(name.toLowerCase(Locale.ROOT));
        }
    }

    static final class Reply {
        final int status;
        final String body;

        Reply(int status, String body) {
            this.status = status;
            this.body = body;
        }
    }

    final List<Request> requests = Collections.synchronizedList(new ArrayList<>());
    private final SSLServerSocket server;
    private final ExecutorService executor = Executors.newCachedThreadPool();
    private final Map<String, Function<Request, Reply>> routes = new ConcurrentHashMap<>();

    /** {@code keystore}: "gateway" (the pinned key) or "other" (a different key with the same names). */
    FakeGateway(String keystore) throws Exception {
        KeyStore store = KeyStore.getInstance("PKCS12");
        try (InputStream in = FakeGateway.class.getResourceAsStream("/" + keystore + ".p12")) {
            store.load(in, "changeit".toCharArray());
        }
        KeyManagerFactory keys = KeyManagerFactory.getInstance(KeyManagerFactory.getDefaultAlgorithm());
        keys.init(store, "changeit".toCharArray());
        SSLContext context = SSLContext.getInstance("TLS");
        context.init(keys.getKeyManagers(), null, null);
        server = (SSLServerSocket) context.getServerSocketFactory().createServerSocket(0, 50, InetAddress.getLoopbackAddress());
        executor.execute(this::accept);
    }

    /** Answers {@code path} (exact, or a prefix when it ends with '*'); a handler's null closes without an answer. */
    FakeGateway on(String path, Function<Request, Reply> handler) {
        routes.put(path, handler);
        return this;
    }

    Route route() {
        return Route.parse("127.0.0.1:" + server.getLocalPort());
    }

    List<Request> requests(String path) {
        List<Request> out = new ArrayList<>();
        synchronized (requests) {
            for (Request request : requests) if (request.path.equals(path)) out.add(request);
        }
        return out;
    }

    private void accept() {
        while (!server.isClosed()) {
            try {
                Socket socket = server.accept();
                executor.execute(() -> serve(socket));
            } catch (IOException e) {
                return;
            }
        }
    }

    private void serve(Socket socket) {
        try (Socket s = socket) {
            s.setSoTimeout(5000);
            InputStream in = new BufferedInputStream(s.getInputStream());
            String[] line = readLine(in).split(" ");
            Map<String, String> headers = new ConcurrentHashMap<>();
            for (String header; !(header = readLine(in)).isEmpty(); ) {
                int colon = header.indexOf(':');
                headers.put(header.substring(0, colon).trim().toLowerCase(Locale.ROOT), header.substring(colon + 1).trim());
            }
            int length = headers.containsKey("content-length") ? Integer.parseInt(headers.get("content-length")) : 0;
            byte[] body = new byte[length];
            for (int read = 0, n; read < length; read += n) {
                if ((n = in.read(body, read, length - read)) < 0) throw new IOException("body ended early");
            }
            String path = line[1].contains("?") ? line[1].substring(0, line[1].indexOf('?')) : line[1];
            Request request = new Request(line[0], path, headers, new String(body, StandardCharsets.UTF_8));
            requests.add(request);
            Reply reply = handler(path).apply(request);
            // A null reply closes the connection without an answer (a network cut mid-request).
            if (reply == null) return;
            byte[] bytes = reply.body.getBytes(StandardCharsets.UTF_8);
            OutputStream out = s.getOutputStream();
            out.write(("HTTP/1.1 " + reply.status + " Status\r\nContent-Type: application/json\r\nContent-Length: "
                    + bytes.length + "\r\nConnection: close\r\n\r\n").getBytes(StandardCharsets.ISO_8859_1));
            out.write(bytes);
            out.flush();
        } catch (IOException | RuntimeException ignored) {
            // Handshake refused by a pinned client, or the client went away.
        }
    }

    private Function<Request, Reply> handler(String path) {
        Function<Request, Reply> exact = routes.get(path);
        if (exact != null) return exact;
        for (Map.Entry<String, Function<Request, Reply>> entry : routes.entrySet()) {
            String key = entry.getKey();
            if (key.endsWith("*") && path.startsWith(key.substring(0, key.length() - 1))) return entry.getValue();
        }
        return request -> new Reply(404, "{\"type\":\"not_found\"}");
    }

    private static String readLine(InputStream in) throws IOException {
        ByteArrayOutputStream line = new ByteArrayOutputStream();
        for (int b; (b = in.read()) != '\n'; ) {
            if (b < 0) throw new IOException("closed");
            if (b != '\r') line.write(b);
        }
        return new String(line.toByteArray(), StandardCharsets.ISO_8859_1);
    }

    @Override
    public void close() {
        try {
            server.close();
        } catch (IOException ignored) {
            // Closing.
        }
        executor.shutdownNow();
    }
}
