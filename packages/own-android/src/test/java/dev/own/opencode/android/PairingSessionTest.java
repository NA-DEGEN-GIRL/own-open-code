package dev.own.opencode.android;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertNull;
import static org.junit.Assert.assertTrue;

import java.util.ArrayList;
import java.util.Collections;
import java.util.List;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.function.Consumer;
import org.junit.After;
import org.junit.Before;
import org.junit.Test;

/**
 * The pairing as the app holds it (not the activity): a recreated screen picks it up where it was, it polls only while
 * the screen is visible, and cancelling or failing ends the pairing's routing once.
 */
public class PairingSessionTest {
    private static final String UA = "OwnOpenCodeApp/1 (android) Android/16";
    private static final String CODE = "Q2xhaW1Db2RlXzEyMzQ1Ng";
    private static final String CLAIM = "Y2xhaW0tc2VjcmV0LWZvci10aGUtZGV2aWNlLTAwMDA";
    private static final String TOKEN = "dG9rZW4tMjU2LWJpdHMtb2YtcmFuZG9tLWJhc2U2NHVybA";
    private static final String CONNECTED = "{\"claim\":\"" + CLAIM + "\",\"sas\":\"4821\",\"name\":\"내 휴대폰\",\"expiresAt\":1790000000000}";
    private static final String CLAIMED = "{\"deviceId\":\"dev_01JABCDEF\",\"token\":\"" + TOKEN + "\",\"expiresAt\":1792592000000}";
    private static final PairingFlow.Timing FAST = new PairingFlow.Timing(10, 1500, 1500, 10_000);

    private TestTable table;
    private RouteProxy proxy;
    private int port;
    private FakeGateway gateway;
    private ExecutorService io;
    private final AtomicInteger polls = new AtomicInteger();
    private final AtomicBoolean approved = new AtomicBoolean();

    /** The app side: records what it is asked to do. */
    private final class Host implements PairingSession.Host {
        final List<String> saved = Collections.synchronizedList(new ArrayList<>());
        final AtomicInteger ended = new AtomicInteger();
        volatile boolean saveWorks = true;

        @Override
        public PinnedHttps http() {
            return new PinnedHttps(FakeGateway.PC_KEY, FakeGateway.PIN, port, UA);
        }

        @Override
        public void save(PairingFlow.Result result, Consumer<Boolean> done) {
            saved.add(result.deviceId);
            done.accept(saveWorks);
        }

        @Override
        public void end() {
            ended.incrementAndGet();
        }
    }

    /** A screen: every snapshot it was shown. */
    private static final class Screen implements PairingSession.View {
        final List<PairingSession.Snapshot> shown = Collections.synchronizedList(new ArrayList<>());

        @Override
        public void show(PairingSession.Snapshot snapshot) {
            shown.add(snapshot);
        }

        PairingSession.Snapshot last() {
            synchronized (shown) {
                return shown.isEmpty() ? null : shown.get(shown.size() - 1);
            }
        }
    }

    @Before
    public void setUp() throws Exception {
        table = new TestTable();
        proxy = new RouteProxy(table, 1000);
        port = proxy.start();
        gateway = new FakeGateway("gateway");
        table.put(FakeGateway.PC_KEY, gateway.route());
        io = Executors.newCachedThreadPool();
        gateway.on("/auth/connect/*", request -> new FakeGateway.Reply(200, CONNECTED));
        gateway.on("/own/pairing", request -> {
            polls.incrementAndGet();
            return new FakeGateway.Reply(200, "{\"state\":\"" + (approved.get() ? "approved" : "pending") + "\"}");
        });
        gateway.on("/own/pairing/claim", request -> new FakeGateway.Reply(200, CLAIMED));
    }

    @After
    public void tearDown() {
        io.shutdownNow();
        gateway.close();
        proxy.close();
    }

    private static void await(PairingSession session, PairingSession.Phase phase) throws InterruptedException {
        long until = System.nanoTime() + 5_000_000_000L;
        while (session.snapshot().phase != phase && System.nanoTime() < until) Thread.sleep(5);
        assertEquals(phase, session.snapshot().phase);
    }

    @Test
    public void aRecreatedScreenPicksThePairingUpWhereItWas() throws Exception {
        Host host = new Host();
        PairingSession session = new PairingSession(CODE, host, FAST);
        Screen first = new Screen();
        session.attach(first);
        session.start(io);
        await(session, PairingSession.Phase.WAITING);

        // A configuration change: the old screen goes, a new one attaches and sees the SAS at once.
        session.foreground(false);
        session.detach(first);
        int seenByFirst = first.shown.size();
        Screen second = new Screen();
        session.attach(second);
        session.foreground(true);
        assertEquals(PairingSession.Phase.WAITING, second.shown.get(0).phase);
        assertEquals("4821", second.shown.get(0).sas);
        assertEquals("내 휴대폰", second.shown.get(0).deviceName);

        approved.set(true);
        await(session, PairingSession.Phase.PAIRED);
        assertEquals(PairingSession.Phase.PAIRED, second.last().phase);
        assertEquals(seenByFirst, first.shown.size());
        assertEquals(Collections.singletonList("dev_01JABCDEF"), host.saved);
        // save ends the routing itself.
        assertEquals(0, host.ended.get());
    }

    @Test
    public void offScreenFromTheStartItPollsOnlyOnceVisible() throws Exception {
        Host host = new Host();
        PairingSession session = new PairingSession(CODE, host, FAST);
        session.foreground(false);
        session.start(io);
        await(session, PairingSession.Phase.WAITING);
        approved.set(true);
        Thread.sleep(200);
        assertEquals(0, polls.get());
        assertEquals(PairingSession.Phase.WAITING, session.snapshot().phase);
        session.foreground(true);
        await(session, PairingSession.Phase.PAIRED);
        assertTrue(polls.get() >= 1);
    }

    @Test
    public void cancelStopsThePairingAndEndsItsRoutingOnce() throws Exception {
        Host host = new Host();
        PairingSession session = new PairingSession(CODE, host, FAST);
        session.start(io);
        await(session, PairingSession.Phase.WAITING);
        session.cancel();
        await(session, PairingSession.Phase.FAILED);
        assertEquals(PairingFlow.Failure.ABORTED, session.snapshot().failure);
        session.cancel();
        Thread.sleep(50);
        assertEquals(1, host.ended.get());
        assertTrue(host.saved.isEmpty());
        assertTrue(gateway.requests("/own/pairing/claim").isEmpty());
    }

    @Test
    public void aDeviceThatCannotBeStoredFailsWithoutAFlowFailure() throws Exception {
        Host host = new Host();
        host.saveWorks = false;
        approved.set(true);
        PairingSession session = new PairingSession(CODE, host, FAST);
        session.start(io);
        await(session, PairingSession.Phase.FAILED);
        assertNull(session.snapshot().failure);
        assertEquals("4821", session.snapshot().sas);
    }

    @Test
    public void aFlowFailureEndsTheRouting() throws Exception {
        gateway.on("/own/pairing", request -> new FakeGateway.Reply(200, "{\"state\":\"rejected\"}"));
        Host host = new Host();
        PairingSession session = new PairingSession(CODE, host, FAST);
        Screen screen = new Screen();
        session.attach(screen);
        session.start(io);
        await(session, PairingSession.Phase.FAILED);
        assertEquals(PairingFlow.Failure.REJECTED, session.snapshot().failure);
        assertEquals(PairingFlow.Failure.REJECTED, screen.last().failure);
        assertEquals(1, host.ended.get());
    }
}
