package dev.own.opencode.android;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

import java.util.List;
import org.junit.After;
import org.junit.Before;
import org.junit.Test;

/** {@code POST /own/device/revoke} (08-app-access.md §3.6a) through the proxy with the pin check. */
public class DeviceApiTest {
    private static final String UA = "OwnOpenCodeApp/1 (android) Android/16";
    private static final String TOKEN = "dG9rZW4tMjU2LWJpdHMtb2YtcmFuZG9tLWJhc2U2NHVybA";

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

    private PinnedHttps http() {
        return new PinnedHttps(FakeGateway.PC_KEY, FakeGateway.PIN, port, UA, DeviceApi.REVOKE_TIMEOUT_MS, DeviceApi.REVOKE_TIMEOUT_MS);
    }

    @Test
    public void revokesTheCallingDevice() throws Exception {
        try (FakeGateway gateway = new FakeGateway("gateway")) {
            gateway.on("/own/device/revoke", request -> new FakeGateway.Reply(200, "{\"deviceId\":\"dev_1\",\"revoked\":true}"));
            table.put(FakeGateway.PC_KEY, gateway.route());
            assertTrue(DeviceApi.revoke(http(), TOKEN));
            List<FakeGateway.Request> calls = gateway.requests("/own/device/revoke");
            assertEquals(1, calls.size());
            FakeGateway.Request call = calls.get(0);
            assertEquals("POST", call.method);
            assertEquals("Bearer " + TOKEN, call.header("Authorization"));
            assertEquals(FakeGateway.HOST, call.header("Host"));
            assertEquals(UA, call.header("User-Agent"));
            assertEquals(null, call.header("Cookie"));
        }
    }

    @Test
    public void aDeadTokenOrOddAnswerIsJustFalse() throws Exception {
        try (FakeGateway gateway = new FakeGateway("gateway")) {
            table.put(FakeGateway.PC_KEY, gateway.route());
            gateway.on("/own/device/revoke", request -> new FakeGateway.Reply(401, "{\"type\":\"device_revoked\"}"));
            assertFalse(DeviceApi.revoke(http(), TOKEN));
            gateway.on("/own/device/revoke", request -> new FakeGateway.Reply(200, "<html>"));
            assertFalse(DeviceApi.revoke(http(), TOKEN));
        }
    }

    @Test
    public void anUnreachablePcIsJustFalse() {
        table.put(FakeGateway.PC_KEY, Route.parse("127.0.0.1:1"));
        assertFalse(DeviceApi.revoke(http(), TOKEN));
    }

    @Test
    public void neverSendsTheTokenToAnotherKey() throws Exception {
        try (FakeGateway impostor = new FakeGateway("other")) {
            impostor.on("/own/device/revoke", request -> new FakeGateway.Reply(200, "{\"revoked\":true}"));
            table.put(FakeGateway.PC_KEY, impostor.route());
            assertFalse(DeviceApi.revoke(http(), TOKEN));
            assertTrue(impostor.requests.isEmpty());
        }
    }
}
