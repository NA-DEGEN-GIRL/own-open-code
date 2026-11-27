package dev.own.opencode.android;

import java.io.BufferedInputStream;
import java.io.ByteArrayOutputStream;
import java.io.Closeable;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.InetAddress;
import java.net.InetSocketAddress;
import java.net.ServerSocket;
import java.net.Socket;
import java.net.SocketTimeoutException;
import java.nio.charset.StandardCharsets;
import java.util.List;
import java.util.Locale;
import java.util.Set;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.atomic.AtomicInteger;

/**
 * The in-app CONNECT proxy (08-app-access.md §3.4 1) on {@code 127.0.0.1:<ephemeral>}. It accepts only
 * {@code CONNECT <pcKey>.ownpc.internal:443} for PCs the {@link Table} knows, connects to that PC's routes in order
 * (the last route that worked first, {@link #CONNECT_TIMEOUT_MS} each), answers {@code 200 Connection Established} and
 * then copies bytes both ways. TLS stays end to end between the client (WebView or {@link PinnedHttps}) and the PC's
 * gateway; the proxy never sees plaintext. Anything else gets {@code 403}; a known PC whose routes all fail gets
 * {@code 502}.
 */
final class RouteProxy implements Closeable {
    /** Route lookups; implemented by the app over its stored PCs (and a pairing in progress). */
    interface Table {
        /** The PC's routes in preference order, or null/empty when the PC is unknown. */
        List<Route> routes(String pcKey);

        /** The route that connected last time, or null. */
        Route lastRoute(String pcKey);

        /** Called (on a proxy thread) after {@code route} connected for {@code pcKey}. */
        void connected(String pcKey, Route route);
    }

    static final int CONNECT_TIMEOUT_MS = 3000;
    private static final int HEAD_TIMEOUT_MS = 10_000;
    private static final int MAX_HEAD = 8192;
    private static final byte[] ESTABLISHED =
            "HTTP/1.1 200 Connection Established\r\n\r\n".getBytes(StandardCharsets.US_ASCII);
    private static final byte[] FORBIDDEN =
            "HTTP/1.1 403 Forbidden\r\nContent-Length: 0\r\nConnection: close\r\n\r\n".getBytes(StandardCharsets.US_ASCII);
    private static final byte[] BAD_GATEWAY =
            "HTTP/1.1 502 Bad Gateway\r\nContent-Length: 0\r\nConnection: close\r\n\r\n".getBytes(StandardCharsets.US_ASCII);

    private final Table table;
    private final int connectTimeoutMs;
    private final Set<Socket> open = ConcurrentHashMap.newKeySet();
    private final AtomicInteger threads = new AtomicInteger();
    private final ExecutorService pool = Executors.newCachedThreadPool(runnable -> {
        Thread thread = new Thread(runnable, "route-proxy-" + threads.incrementAndGet());
        thread.setDaemon(true);
        return thread;
    });
    private ServerSocket server;

    RouteProxy(Table table) {
        this(table, CONNECT_TIMEOUT_MS);
    }

    RouteProxy(Table table, int connectTimeoutMs) {
        this.table = table;
        this.connectTimeoutMs = connectTimeoutMs;
    }

    /** Binds {@code 127.0.0.1:0} and starts accepting; returns the port. Idempotent. Blocking: not on a UI thread. */
    synchronized int start() throws IOException {
        if (server != null) return server.getLocalPort();
        ServerSocket socket = new ServerSocket();
        socket.bind(new InetSocketAddress(InetAddress.getByAddress(new byte[] {127, 0, 0, 1}), 0), 64);
        server = socket;
        pool.execute(() -> accept(socket));
        return socket.getLocalPort();
    }

    synchronized int port() {
        return server == null ? -1 : server.getLocalPort();
    }

    @Override
    public synchronized void close() {
        closeQuietly(server);
        server = null;
        for (Socket socket : open) closeQuietly(socket);
        pool.shutdownNow();
    }

    /** A parsed CONNECT target. */
    static final class Target {
        final String host;
        final int port;

        Target(String host, int port) {
            this.host = host;
            this.port = port;
        }
    }

    /**
     * Parses a request line {@code CONNECT <host>:<port> HTTP/1.x}; null for any other method or a malformed line.
     * The host is lowercased; IPv6 literals are not accepted (only app host names are ever valid targets).
     */
    static Target parseConnect(String requestLine) {
        if (requestLine == null) return null;
        String[] parts = requestLine.split(" ", -1);
        if (parts.length != 3 || !parts[0].equals("CONNECT")) return null;
        if (!parts[2].equals("HTTP/1.1") && !parts[2].equals("HTTP/1.0")) return null;
        String authority = parts[1];
        int colon = authority.lastIndexOf(':');
        if (colon <= 0 || colon == authority.length() - 1 || authority.indexOf(':') != colon) return null;
        String port = authority.substring(colon + 1);
        if (port.length() > 5 || !port.matches("[0-9]+")) return null;
        return new Target(authority.substring(0, colon).toLowerCase(Locale.ROOT), Integer.parseInt(port));
    }

    private void accept(ServerSocket socket) {
        while (!socket.isClosed()) {
            Socket client;
            try {
                client = socket.accept();
            } catch (IOException e) {
                if (socket.isClosed()) return;
                continue;
            }
            open.add(client);
            try {
                pool.execute(() -> handle(client));
            } catch (RuntimeException e) {
                // Rejected after close().
                forget(client);
            }
        }
    }

    private void handle(Socket client) {
        Socket upstream = null;
        try {
            client.setSoTimeout(HEAD_TIMEOUT_MS);
            client.setTcpNoDelay(true);
            InputStream in = new BufferedInputStream(client.getInputStream());
            OutputStream out = client.getOutputStream();
            String requestLine = readHead(in);
            Target target = parseConnect(requestLine);
            String pcKey = target == null || target.port != 443 ? null : AppHost.pcKeyOf(target.host);
            List<Route> routes = pcKey == null ? null : table.routes(pcKey);
            if (routes == null || routes.isEmpty()) {
                reply(out, FORBIDDEN);
                forget(client);
                return;
            }
            for (Route route : Route.order(routes, table.lastRoute(pcKey))) {
                upstream = connect(route);
                if (upstream != null) {
                    table.connected(pcKey, route);
                    break;
                }
            }
            if (upstream == null) {
                reply(out, BAD_GATEWAY);
                forget(client);
                return;
            }
            open.add(upstream);
            out.write(ESTABLISHED);
            out.flush();
            client.setSoTimeout(0);
            tunnel(client, in, upstream);
        } catch (IOException | RuntimeException e) {
            forget(client);
            if (upstream != null) forget(upstream);
        }
    }

    private Socket connect(Route route) {
        Socket socket = new Socket();
        try {
            socket.connect(new InetSocketAddress(route.host, route.port), connectTimeoutMs);
            socket.setTcpNoDelay(true);
            socket.setKeepAlive(true);
            return socket;
        } catch (IOException | RuntimeException e) {
            // Unresolvable, refused, unreachable or timed out: try the next route.
            closeQuietly(socket);
            return null;
        }
    }

    /**
     * Copies both directions until both ends finish. An end-of-stream half-closes the other side (so TLS
     * close_notify and EOF pass through); an error closes both sockets.
     */
    private void tunnel(Socket client, InputStream clientIn, Socket upstream) throws IOException {
        AtomicInteger remaining = new AtomicInteger(2);
        InputStream upstreamIn = upstream.getInputStream();
        pool.execute(() -> pump(clientIn, upstream, client, upstream, remaining));
        pump(upstreamIn, client, client, upstream, remaining);
    }

    private void pump(InputStream from, Socket to, Socket client, Socket upstream, AtomicInteger remaining) {
        byte[] buffer = new byte[16 * 1024];
        try {
            OutputStream out = to.getOutputStream();
            for (int n; (n = from.read(buffer)) >= 0; ) {
                if (n == 0) continue;
                out.write(buffer, 0, n);
                out.flush();
            }
            if (!to.isClosed()) to.shutdownOutput();
        } catch (IOException | RuntimeException e) {
            forget(client);
            forget(upstream);
        }
        if (remaining.decrementAndGet() == 0) {
            forget(client);
            forget(upstream);
        }
    }

    /** Reads the request head (up to the blank line) and returns its first line; the rest of the head is ignored. */
    private static String readHead(InputStream in) throws IOException {
        ByteArrayOutputStream head = new ByteArrayOutputStream();
        int newlines = 0;
        while (true) {
            int b;
            try {
                b = in.read();
            } catch (SocketTimeoutException e) {
                throw new IOException("request head timed out");
            }
            if (b < 0) throw new IOException("request head ended early");
            head.write(b);
            if (head.size() > MAX_HEAD) throw new IOException("request head too large");
            if (b == '\n') {
                if (++newlines == 2) break;
            } else if (b != '\r') {
                newlines = 0;
            }
        }
        String text = new String(head.toByteArray(), StandardCharsets.ISO_8859_1);
        int end = text.indexOf('\n');
        String line = text.substring(0, end);
        return line.endsWith("\r") ? line.substring(0, line.length() - 1) : line;
    }

    private static void reply(OutputStream out, byte[] response) {
        try {
            out.write(response);
            out.flush();
        } catch (IOException ignored) {
            // The client went away.
        }
    }

    private void forget(Socket socket) {
        open.remove(socket);
        closeQuietly(socket);
    }

    private static void closeQuietly(Closeable closeable) {
        if (closeable == null) return;
        try {
            closeable.close();
        } catch (IOException ignored) {
            // Nothing to do.
        }
    }
}
