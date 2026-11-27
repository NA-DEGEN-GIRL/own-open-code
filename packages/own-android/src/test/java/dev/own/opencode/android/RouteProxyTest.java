package dev.own.opencode.android;

import static org.junit.Assert.assertArrayEquals;
import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertNull;
import static org.junit.Assert.assertTrue;

import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.InetAddress;
import java.net.InetSocketAddress;
import java.net.ServerSocket;
import java.net.Socket;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.Collections;
import java.util.List;
import java.util.concurrent.atomic.AtomicInteger;
import org.junit.After;
import org.junit.Before;
import org.junit.Test;

public class RouteProxyTest {
    private static final String PC = FakeGateway.PC_KEY;

    /** A TCP echo server that counts its connections and echoes until the client half-closes. */
    private static final class Echo implements AutoCloseable {
        final ServerSocket server;
        final AtomicInteger accepted = new AtomicInteger();

        Echo() throws IOException {
            server = new ServerSocket(0, 50, InetAddress.getLoopbackAddress());
            Thread thread = new Thread(() -> {
                while (!server.isClosed()) {
                    try {
                        Socket socket = server.accept();
                        accepted.incrementAndGet();
                        new Thread(() -> echo(socket)).start();
                    } catch (IOException e) {
                        return;
                    }
                }
            });
            thread.setDaemon(true);
            thread.start();
        }

        private static void echo(Socket socket) {
            try (Socket s = socket) {
                InputStream in = s.getInputStream();
                OutputStream out = s.getOutputStream();
                byte[] buffer = new byte[4096];
                for (int n; (n = in.read(buffer)) >= 0; ) out.write(buffer, 0, n);
                s.shutdownOutput();
            } catch (IOException ignored) {
                // Test ended.
            }
        }

        Route route() {
            return Route.parse("127.0.0.1:" + server.getLocalPort());
        }

        @Override
        public void close() throws IOException {
            server.close();
        }
    }

    private TestTable table;
    private RouteProxy proxy;
    private int port;
    private Echo echo;
    private Echo echo2;
    private final List<Socket> held = new ArrayList<>();

    @Before
    public void setUp() throws Exception {
        table = new TestTable();
        proxy = new RouteProxy(table, 1000);
        port = proxy.start();
        echo = new Echo();
        echo2 = new Echo();
    }

    @After
    public void tearDown() throws Exception {
        proxy.close();
        echo.close();
        echo2.close();
        for (Socket socket : held) socket.close();
    }

    /**
     * A route nothing listens on (connection refused at once). Its port stays bound to a socket that never listens
     * until the test ends: a port closed again could be handed out as an ephemeral port meanwhile, and on Windows the
     * proxy's connect to it could then connect to itself and read its own CONNECT back as the route's answer.
     */
    private Route deadRoute() throws IOException {
        Socket socket = new Socket();
        held.add(socket);
        socket.bind(new InetSocketAddress(InetAddress.getLoopbackAddress(), 0));
        return Route.parse("127.0.0.1:" + socket.getLocalPort());
    }

    private Socket open() throws IOException {
        Socket socket = new Socket(InetAddress.getLoopbackAddress(), port);
        socket.setSoTimeout(5000);
        return socket;
    }

    private static String send(Socket socket, String head) throws IOException {
        socket.getOutputStream().write(head.getBytes(StandardCharsets.ISO_8859_1));
        socket.getOutputStream().flush();
        return readHead(socket.getInputStream());
    }

    private static String readHead(InputStream in) throws IOException {
        ByteArrayOutputStream head = new ByteArrayOutputStream();
        while (true) {
            int b = in.read();
            if (b < 0) break;
            head.write(b);
            String text = head.toString(StandardCharsets.ISO_8859_1);
            if (text.endsWith("\r\n\r\n")) break;
        }
        String text = head.toString(StandardCharsets.ISO_8859_1);
        return text.isEmpty() ? "" : text.substring(0, text.indexOf("\r\n") < 0 ? text.length() : text.indexOf("\r\n"));
    }

    private static byte[] readExactly(InputStream in, int length) throws IOException {
        byte[] out = new byte[length];
        for (int read = 0; read < length; ) {
            int n = in.read(out, read, length - read);
            if (n < 0) throw new IOException("ended early");
            read += n;
        }
        return out;
    }

    private static void awaitAccepted(Echo server, int count) throws InterruptedException {
        long end = System.currentTimeMillis() + 5000;
        while (server.accepted.get() < count && System.currentTimeMillis() < end) Thread.sleep(10);
        assertEquals(count, server.accepted.get());
    }

    private static String connect(String authority) {
        return "CONNECT " + authority + " HTTP/1.1\r\nHost: " + authority + "\r\nUser-Agent: test\r\n\r\n";
    }

    @Test
    public void tunnelsThroughTheFirstRouteThatConnects() throws Exception {
        table.put(PC, deadRoute(), echo.route());
        try (Socket socket = open()) {
            assertEquals("HTTP/1.1 200 Connection Established", send(socket, connect(PC + ".ownpc.internal:443")));
            byte[] payload = "hello through the tunnel".getBytes(StandardCharsets.UTF_8);
            socket.getOutputStream().write(payload);
            assertArrayEquals(payload, readExactly(socket.getInputStream(), payload.length));
        }
        assertEquals(Collections.singletonList(PC + "=" + echo.route()), table.connected);
    }

    @Test
    public void triesTheLastWorkingRouteFirst() throws Exception {
        table.put(PC, echo.route(), echo2.route());
        table.last.put(PC, echo2.route());
        try (Socket socket = open()) {
            assertEquals("HTTP/1.1 200 Connection Established", send(socket, connect(PC + ".ownpc.internal:443")));
        }
        // The proxy answers once the connect completes, which can be before the echo server's accept returns.
        awaitAccepted(echo2, 1);
        assertEquals(0, echo.accepted.get());
    }

    @Test
    public void forwardsBytesSentRightAfterTheRequestHead() throws Exception {
        table.put(PC, echo.route());
        try (Socket socket = open()) {
            OutputStream out = socket.getOutputStream();
            out.write((connect(PC + ".ownpc.internal:443") + "early").getBytes(StandardCharsets.ISO_8859_1));
            out.flush();
            assertEquals("HTTP/1.1 200 Connection Established", readHead(socket.getInputStream()));
            assertEquals("early", new String(readExactly(socket.getInputStream(), 5), StandardCharsets.ISO_8859_1));
        }
    }

    @Test
    public void passesHalfCloseThrough() throws Exception {
        table.put(PC, echo.route());
        try (Socket socket = open()) {
            send(socket, connect(PC + ".ownpc.internal:443"));
            socket.getOutputStream().write("bye".getBytes(StandardCharsets.UTF_8));
            socket.shutdownOutput();
            // The echo server sees EOF only if the proxy half-closed upstream; it then echoes and closes.
            assertEquals("bye", new String(readExactly(socket.getInputStream(), 3), StandardCharsets.UTF_8));
            assertEquals(-1, socket.getInputStream().read());
        }
    }

    @Test
    public void refusesEverythingElseWith403() throws Exception {
        table.put(PC, echo.route());
        String[] heads = {
            connect("zzzzzzzzzzzz.ownpc.internal:443"),
            connect(PC + ".ownpc.internal:8443"),
            connect("example.com:443"),
            connect(echo.route().toString()),
            connect(PC + ".ownpc.internal.evil.net:443"),
            connect(PC + ".ownpc.internal"),
            "GET http://" + PC + ".ownpc.internal/ HTTP/1.1\r\nHost: x\r\n\r\n",
            "CONNECT " + PC + ".ownpc.internal:443 HTTP/2\r\n\r\n",
            "garbage\r\n\r\n",
        };
        for (String head : heads) {
            try (Socket socket = open()) {
                assertEquals(head, "HTTP/1.1 403 Forbidden", send(socket, head));
            }
        }
        assertEquals(0, echo.accepted.get());
    }

    @Test
    public void answers502WhenNoRouteConnects() throws Exception {
        table.put(PC, deadRoute(), deadRoute());
        try (Socket socket = open()) {
            assertEquals("HTTP/1.1 502 Bad Gateway", send(socket, connect(PC + ".ownpc.internal:443")));
        }
        assertTrue(table.connected.isEmpty());
    }

    @Test
    public void parsesConnectRequestLines() {
        RouteProxy.Target target = RouteProxy.parseConnect("CONNECT ABCDEFGHIJKL.ownpc.internal:443 HTTP/1.1");
        assertEquals("abcdefghijkl.ownpc.internal", target.host);
        assertEquals(443, target.port);
        assertEquals(443, RouteProxy.parseConnect("CONNECT a.b:443 HTTP/1.0").port);
        for (String bad : new String[] {null, "", "CONNECT a.b:443", "connect a.b:443 HTTP/1.1", "GET a.b:443 HTTP/1.1",
                "CONNECT a.b HTTP/1.1", "CONNECT a.b: HTTP/1.1", "CONNECT :443 HTTP/1.1", "CONNECT [::1]:443 HTTP/1.1",
                "CONNECT a.b:4430000 HTTP/1.1", "CONNECT a.b:443 HTTP/1.1 x", "CONNECT  a.b:443 HTTP/1.1"}) {
            assertNull(bad, RouteProxy.parseConnect(bad));
        }
    }
}
