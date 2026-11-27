package dev.own.opencode.android;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertThrows;
import static org.junit.Assert.assertTrue;

import java.io.IOException;
import java.util.Collections;
import org.junit.After;
import org.junit.Before;
import org.junit.Test;

/** The native client end to end on the JVM: client → RouteProxy → TLS server with the test certificate. */
public class PinnedHttpsTest {
    private static final String UA = "OwnOpenCodeApp/1 (android) Android/16";

    private TestTable table;
    private RouteProxy proxy;
    private int port;

    @Before
    public void setUp() throws Exception {
        table = new TestTable();
        proxy = new RouteProxy(table, 1000);
        port = proxy.start();
    }

    @After
    public void tearDown() {
        proxy.close();
    }

    @Test
    public void talksToThePinnedPcByItsAppHost() throws Exception {
        try (FakeGateway gateway = new FakeGateway("gateway")) {
            gateway.on("/own/routes", request -> new FakeGateway.Reply(200, "{\"ok\":true}"));
            table.put(FakeGateway.PC_KEY, gateway.route());
            PinnedHttps http = new PinnedHttps(FakeGateway.PC_KEY, FakeGateway.PIN, port, UA);
            PinnedHttps.Response response = http.get("/own/routes", Collections.singletonMap("Authorization", "Bearer t"));
            assertEquals(200, response.status);
            assertEquals("{\"ok\":true}", response.body);
            FakeGateway.Request request = gateway.requests.get(0);
            // The gateway's app listener answers 421 to any other Host (port 443 is implied).
            assertEquals(FakeGateway.HOST, request.header("Host"));
            assertEquals(UA, request.header("User-Agent"));
            assertEquals("Bearer t", request.header("Authorization"));
        }
    }

    @Test
    public void returnsErrorStatusesWithTheirBody() throws Exception {
        try (FakeGateway gateway = new FakeGateway("gateway")) {
            gateway.on("/own/routes", request -> new FakeGateway.Reply(401, "{\"type\":\"device_revoked\"}"));
            table.put(FakeGateway.PC_KEY, gateway.route());
            PinnedHttps.Response response = new PinnedHttps(FakeGateway.PC_KEY, FakeGateway.PIN, port, UA)
                    .get("/own/routes", Collections.emptyMap());
            assertEquals(401, response.status);
            assertEquals("{\"type\":\"device_revoked\"}", response.body);
        }
    }

    @Test
    public void refusesAServerWithAnotherKey() throws Exception {
        try (FakeGateway impostor = new FakeGateway("other")) {
            impostor.on("/own/routes", request -> new FakeGateway.Reply(200, "{}"));
            table.put(FakeGateway.PC_KEY, impostor.route());
            PinnedHttps http = new PinnedHttps(FakeGateway.PC_KEY, FakeGateway.PIN, port, UA);
            IOException error = assertThrows(IOException.class, () -> http.get("/own/routes", Collections.emptyMap()));
            assertTrue(PinnedHttps.isPinFailure(error));
            // No request reached the impostor: the token would have been sent only after the handshake.
            assertTrue(impostor.requests.isEmpty());
        }
    }

    @Test
    public void networkFailuresAreNotPinFailures() throws Exception {
        table.put(FakeGateway.PC_KEY, Route.parse("127.0.0.1:1"));
        PinnedHttps http = new PinnedHttps(FakeGateway.PC_KEY, FakeGateway.PIN, port, UA);
        IOException error = assertThrows(IOException.class, () -> http.get("/own/routes", Collections.emptyMap()));
        assertFalse(PinnedHttps.isPinFailure(error));
    }

    @Test
    public void rejectsBadKeysAndPins() {
        assertThrows(IllegalArgumentException.class, () -> new PinnedHttps("short", FakeGateway.PIN, port, UA));
        assertThrows(IllegalArgumentException.class, () -> new PinnedHttps(FakeGateway.PC_KEY, "nope", port, UA));
    }
}
