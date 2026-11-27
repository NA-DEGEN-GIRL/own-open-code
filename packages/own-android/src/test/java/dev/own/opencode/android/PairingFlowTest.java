package dev.own.opencode.android;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertThrows;
import static org.junit.Assert.assertTrue;

import java.util.ArrayList;
import java.util.Arrays;
import java.util.Collections;
import java.util.List;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.concurrent.atomic.AtomicReference;
import org.junit.After;
import org.junit.Before;
import org.junit.Test;

/** The native pairing flow against a fake app listener speaking the gateway's pairing endpoints (05 §13.5). */
public class PairingFlowTest {
    private static final String UA = "OwnOpenCodeApp/1 (android) Android/16";
    private static final String CODE = "Q2xhaW1Db2RlXzEyMzQ1Ng";
    private static final String CLAIM = "Y2xhaW0tc2VjcmV0LWZvci10aGUtZGV2aWNlLTAwMDA";
    private static final String TOKEN = "dG9rZW4tMjU2LWJpdHMtb2YtcmFuZG9tLWJhc2U2NHVybA";
    private static final String CONNECTED = "{\"claim\":\"" + CLAIM + "\",\"sas\":\"4821\",\"name\":\"내 휴대폰\",\"expiresAt\":1790000000000}";
    private static final String CLAIMED = "{\"deviceId\":\"dev_01JABCDEF\",\"token\":\"" + TOKEN + "\",\"expiresAt\":1792592000000}";

    private TestTable table;
    private RouteProxy proxy;
    private int port;
    private FakeGateway gateway;
    private final List<String> shown = Collections.synchronizedList(new ArrayList<>());

    @Before
    public void setUp() throws Exception {
        table = new TestTable();
        proxy = new RouteProxy(table, 1000);
        port = proxy.start();
        gateway = new FakeGateway("gateway");
        table.put(FakeGateway.PC_KEY, gateway.route());
    }

    @After
    public void tearDown() {
        gateway.close();
        proxy.close();
    }

    /** Polls every 10 ms; each step's window is 1.5 s (the gateway's 2 minutes in the app). */
    private static final PairingFlow.Timing FAST = new PairingFlow.Timing(10, 1500, 1500, 10_000);

    private PairingFlow flow(String pin) {
        return new PairingFlow(new PinnedHttps(FakeGateway.PC_KEY, pin, port, UA), CODE, FAST);
    }

    private PairingFlow.Failure failure(PairingFlow flow) {
        return assertThrows(PairingFlow.Failed.class, () -> flow.run((sas, name) -> shown.add(sas + "|" + name))).failure;
    }

    /** {@code pending} for the first {@code pending} polls, then {@code finalState}. */
    private void states(int pending, String finalState) {
        AtomicInteger polls = new AtomicInteger();
        gateway.on("/own/pairing", request -> new FakeGateway.Reply(200,
                "{\"state\":\"" + (polls.incrementAndGet() <= pending ? "pending" : finalState) + "\"}"));
    }

    @Test
    public void pairsAfterThePcApproves() throws Exception {
        gateway.on("/auth/connect/*", request -> new FakeGateway.Reply(200, CONNECTED));
        states(2, "approved");
        gateway.on("/own/pairing/claim", request -> new FakeGateway.Reply(200, CLAIMED));

        PairingFlow.Result result = flow(FakeGateway.PIN).run((sas, name) -> shown.add(sas + "|" + name));

        assertEquals("dev_01JABCDEF", result.deviceId);
        assertEquals(TOKEN, result.token);
        assertEquals(1792592000000L, result.expiresAt);
        assertEquals(Collections.singletonList("4821|내 휴대폰"), shown);

        FakeGateway.Request open = gateway.requests("/auth/connect/" + CODE).get(0);
        assertEquals("GET", open.method);
        assertTrue(open.header("Accept").contains("application/json"));
        assertEquals(null, open.header("x-own-pairing"));
        List<FakeGateway.Request> polls = gateway.requests("/own/pairing");
        assertEquals(3, polls.size());
        for (FakeGateway.Request poll : polls) assertEquals(CLAIM, poll.header("x-own-pairing"));
        FakeGateway.Request claim = gateway.requests("/own/pairing/claim").get(0);
        assertEquals("POST", claim.method);
        assertEquals(CLAIM, claim.header("x-own-pairing"));
        assertEquals("{}", claim.body);
        assertTrue(claim.header("Content-Type").startsWith("application/json"));
        synchronized (gateway.requests) {
            for (FakeGateway.Request request : gateway.requests) {
                assertEquals(FakeGateway.HOST, request.header("Host"));
                assertEquals(UA, request.header("User-Agent"));
            }
        }
    }

    @Test
    public void reportsTheEndingsThePcChooses() throws Exception {
        gateway.on("/auth/connect/*", request -> new FakeGateway.Reply(200, CONNECTED));
        states(1, "rejected");
        assertEquals(PairingFlow.Failure.REJECTED, failure(flow(FakeGateway.PIN)));
        states(0, "cancelled");
        assertEquals(PairingFlow.Failure.CANCELLED, failure(flow(FakeGateway.PIN)));
        states(0, "expired");
        assertEquals(PairingFlow.Failure.EXPIRED, failure(flow(FakeGateway.PIN)));
        // The gateway restarted (pairings are memory only).
        states(0, "unknown");
        assertEquals(PairingFlow.Failure.EXPIRED, failure(flow(FakeGateway.PIN)));
    }

    @Test
    public void reportsLinkProblems() throws Exception {
        gateway.on("/auth/connect/*", request -> new FakeGateway.Reply(410, "{\"type\":\"pairing_expired\"}"));
        assertEquals(PairingFlow.Failure.EXPIRED, failure(flow(FakeGateway.PIN)));
        gateway.on("/auth/connect/*", request -> new FakeGateway.Reply(429, "{\"type\":\"rate_limited\"}"));
        assertEquals(PairingFlow.Failure.RATE_LIMITED, failure(flow(FakeGateway.PIN)));
        gateway.on("/auth/connect/*", request -> new FakeGateway.Reply(403, "<html>"));
        assertEquals(PairingFlow.Failure.PROTOCOL, failure(flow(FakeGateway.PIN)));
        gateway.on("/auth/connect/*", request -> new FakeGateway.Reply(200, "{\"claim\":\"x\",\"sas\":\"12\"}"));
        assertEquals(PairingFlow.Failure.PROTOCOL, failure(flow(FakeGateway.PIN)));
        assertTrue(shown.isEmpty());
    }

    @Test
    public void claimThatFailsIsExpiredOrProtocol() throws Exception {
        gateway.on("/auth/connect/*", request -> new FakeGateway.Reply(200, CONNECTED));
        states(0, "approved");
        gateway.on("/own/pairing/claim", request -> new FakeGateway.Reply(410, "{\"type\":\"pairing_expired\"}"));
        assertEquals(PairingFlow.Failure.EXPIRED, failure(flow(FakeGateway.PIN)));
        gateway.on("/own/pairing/claim", request -> new FakeGateway.Reply(200, "{\"deviceId\":\"dev_1\",\"token\":\"short\",\"expiresAt\":1}"));
        assertEquals(PairingFlow.Failure.PROTOCOL, failure(flow(FakeGateway.PIN)));
    }

    @Test
    public void retriesFailedPollsUntilTheWindowPasses() throws Exception {
        gateway.on("/auth/connect/*", request -> new FakeGateway.Reply(200, CONNECTED));
        // Far more failures in a row than the five the app used to allow (about 8 s in the field).
        AtomicInteger polls = new AtomicInteger();
        gateway.on("/own/pairing", request -> polls.incrementAndGet() <= 20
                ? new FakeGateway.Reply(503, "{}")
                : new FakeGateway.Reply(200, "{\"state\":\"approved\"}"));
        gateway.on("/own/pairing/claim", request -> new FakeGateway.Reply(200, CLAIMED));
        List<Boolean> answering = Collections.synchronizedList(new ArrayList<>());
        PairingFlow.Result result = flow(FakeGateway.PIN).run(new PairingFlow.Listener() {
            @Override
            public void onSas(String sas, String deviceName) {}

            @Override
            public void onConnection(boolean ok) {
                answering.add(ok);
            }
        });
        assertEquals(TOKEN, result.token);
        // The screen hears once that the PC is not answering, and once that it is back.
        assertEquals(Arrays.asList(false, true), answering);

        gateway.on("/own/pairing", request -> new FakeGateway.Reply(503, "{}"));
        long started = System.nanoTime();
        assertEquals(PairingFlow.Failure.CONNECTION_LOST, failure(flow(FakeGateway.PIN)));
        assertTrue((System.nanoTime() - started) / 1_000_000 >= FAST.approvalMs);
    }

    @Test
    public void retriesAClaimLostOnTheNetwork() throws Exception {
        gateway.on("/auth/connect/*", request -> new FakeGateway.Reply(200, CONNECTED));
        states(0, "approved");
        AtomicInteger claims = new AtomicInteger();
        // The connection closes without an answer the first times (the app went to the background mid-claim).
        gateway.on("/own/pairing/claim", request -> claims.incrementAndGet() <= 3 ? null : new FakeGateway.Reply(200, CLAIMED));
        assertEquals(TOKEN, flow(FakeGateway.PIN).run((sas, name) -> {}).token);
        assertTrue(claims.get() > 3);
    }

    @Test
    public void holdStopsPollingUntilTheAppIsBack() throws Exception {
        gateway.on("/auth/connect/*", request -> new FakeGateway.Reply(200, CONNECTED));
        AtomicInteger polls = new AtomicInteger();
        AtomicBoolean approved = new AtomicBoolean();
        gateway.on("/own/pairing", request -> {
            polls.incrementAndGet();
            return new FakeGateway.Reply(200, "{\"state\":\"" + (approved.get() ? "approved" : "pending") + "\"}");
        });
        gateway.on("/own/pairing/claim", request -> new FakeGateway.Reply(200, CLAIMED));
        PairingFlow flow = flow(FakeGateway.PIN);
        CountDownLatch sas = new CountDownLatch(1);
        AtomicReference<Object> outcome = new AtomicReference<>();
        Thread runner = new Thread(() -> {
            try {
                outcome.set(flow.run((code, name) -> sas.countDown()));
            } catch (PairingFlow.Failed failed) {
                outcome.set(failed.failure);
            }
        });
        runner.start();
        assertTrue(sas.await(5, TimeUnit.SECONDS));
        flow.hold();
        Thread.sleep(100);
        int held = polls.get();
        // Off screen far longer than the old five strikes, and past the approval window too: nothing goes out.
        approved.set(true);
        Thread.sleep(FAST.approvalMs + 300);
        assertTrue("at most the poll in flight when held", polls.get() <= held + 1);
        assertEquals(null, outcome.get());
        flow.release();
        runner.join(5000);
        // Back on screen: the PC approved meanwhile, and the claim goes through.
        assertTrue(outcome.get() instanceof PairingFlow.Result);
        assertEquals(TOKEN, ((PairingFlow.Result) outcome.get()).token);
    }

    @Test
    public void backAfterTheWindowWithoutANetworkIsALostConnection() throws Exception {
        gateway.on("/auth/connect/*", request -> new FakeGateway.Reply(200, CONNECTED));
        states(Integer.MAX_VALUE, "approved");
        PairingFlow flow = flow(FakeGateway.PIN);
        CountDownLatch sas = new CountDownLatch(1);
        AtomicReference<PairingFlow.Failure> outcome = new AtomicReference<>();
        Thread runner = new Thread(() -> outcome.set(assertThrows(PairingFlow.Failed.class,
                () -> flow.run((code, name) -> sas.countDown())).failure));
        runner.start();
        assertTrue(sas.await(5, TimeUnit.SECONDS));
        flow.hold();
        Thread.sleep(FAST.approvalMs + 200);
        // The PC is gone now: one try after the window is enough to give up.
        table.put(FakeGateway.PC_KEY, Route.parse("127.0.0.1:1"));
        flow.release();
        runner.join(5000);
        assertEquals(PairingFlow.Failure.CONNECTION_LOST, outcome.get());
    }

    @Test
    public void stopsAtAWrongKeyBeforeSendingAnything() throws Exception {
        gateway.on("/auth/connect/*", request -> new FakeGateway.Reply(200, CONNECTED));
        assertEquals(PairingFlow.Failure.PIN_MISMATCH, failure(flow(FakeGateway.OTHER_PIN)));
        assertTrue(gateway.requests.isEmpty());
    }

    @Test
    public void reportsAnUnreachablePc() throws Exception {
        table.put(FakeGateway.PC_KEY, Route.parse("127.0.0.1:1"));
        assertEquals(PairingFlow.Failure.UNREACHABLE, failure(flow(FakeGateway.PIN)));
    }

    @Test
    public void abortStopsAHeldFlow() throws Exception {
        gateway.on("/auth/connect/*", request -> new FakeGateway.Reply(200, CONNECTED));
        states(Integer.MAX_VALUE, "approved");
        PairingFlow flow = flow(FakeGateway.PIN);
        Thread aborter = new Thread(() -> {
            try {
                Thread.sleep(200);
            } catch (InterruptedException ignored) {
                // Test ends.
            }
            flow.abort();
        });
        PairingFlow.Failed failed = assertThrows(PairingFlow.Failed.class, () -> flow.run((code, name) -> {
            flow.hold();
            aborter.start();
        }));
        assertEquals(PairingFlow.Failure.ABORTED, failed.failure);
        assertTrue(gateway.requests("/own/pairing/claim").isEmpty());
    }

    @Test
    public void abortStopsWaiting() throws Exception {
        gateway.on("/auth/connect/*", request -> new FakeGateway.Reply(200, CONNECTED));
        states(Integer.MAX_VALUE, "approved");
        PairingFlow flow = flow(FakeGateway.PIN);
        CountDownLatch sas = new CountDownLatch(1);
        Thread aborter = new Thread(() -> {
            try {
                if (sas.await(5, TimeUnit.SECONDS)) flow.abort();
            } catch (InterruptedException ignored) {
                // Test ends.
            }
        });
        aborter.start();
        PairingFlow.Failed failed = assertThrows(PairingFlow.Failed.class, () -> flow.run((code, name) -> sas.countDown()));
        assertEquals(PairingFlow.Failure.ABORTED, failed.failure);
        assertTrue(gateway.requests("/own/pairing/claim").isEmpty());
    }
}
