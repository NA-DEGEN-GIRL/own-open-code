package dev.own.opencode.android;

import java.io.IOException;
import java.util.concurrent.Executor;
import java.util.function.Consumer;

/**
 * One pairing in progress (08-app-access.md §3.5), held by {@link OwnApp} rather than by {@link PairingActivity}: it
 * lives on while the activity is recreated or off screen, for example while the user presses 허용 on the PC through a
 * remote-desktop app on the same phone. The activity attaches a {@link View} while it is started and says whether it
 * is visible ({@link #foreground}); the flow polls only then, because Android may cut a background app's network.
 *
 * <p>The claim secret stays inside the {@link PairingFlow} and the token passes only through {@link Host#save}; this
 * class writes nothing to disk, so a pairing does not outlive the process. {@link #cancel()} aborts it.
 */
final class PairingSession {
    enum Phase {
        CONNECTING,
        /** The SAS is shown; the PC's user has to approve. */
        WAITING,
        SAVING,
        PAIRED,
        FAILED
    }

    /** What the screen shows. Never a secret. */
    static final class Snapshot {
        final Phase phase;
        final String sas;
        final String deviceName;
        /** The PC has not answered the last few requests; the flow keeps trying. */
        final boolean unanswered;
        /** In {@link Phase#FAILED}: why, or null when only storing the device failed. */
        final PairingFlow.Failure failure;

        Snapshot(Phase phase, String sas, String deviceName, boolean unanswered, PairingFlow.Failure failure) {
            this.phase = phase;
            this.sas = sas;
            this.deviceName = deviceName;
            this.unanswered = unanswered;
            this.failure = failure;
        }

        Snapshot phase(Phase next) {
            return new Snapshot(next, sas, deviceName, false, null);
        }

        Snapshot failed(PairingFlow.Failure why) {
            return new Snapshot(Phase.FAILED, sas, deviceName, false, why);
        }
    }

    /** The screen; {@link #show} may be called on any thread. */
    interface View {
        void show(Snapshot snapshot);
    }

    /** The app side: the pinned client, and what happens to the device once it is paired. */
    interface Host {
        /** The pinned client for the link's PC through the route proxy. Blocking: called on the flow's thread. */
        PinnedHttps http() throws IOException;

        /** Ends the pairing's routing and stores the device cookie and the PC; {@code done} gets success. */
        void save(PairingFlow.Result result, Consumer<Boolean> done);

        /** Ends the pairing's routing without a device. */
        void end();
    }

    private final String code;
    private final Host host;
    private final PairingFlow.Timing timing;
    private Snapshot snapshot = new Snapshot(Phase.CONNECTING, null, null, false, null);
    private View view;
    private PairingFlow flow;
    private boolean held;
    private boolean cancelled;

    PairingSession(String code, Host host, PairingFlow.Timing timing) {
        this.code = code;
        this.host = host;
        this.timing = timing;
    }

    /** Runs the flow on {@code io}. */
    void start(Executor io) {
        io.execute(this::run);
    }

    /** Shows the current state at once, then every change until {@link #detach}. */
    void attach(View next) {
        Snapshot current;
        synchronized (this) {
            view = next;
            current = snapshot;
        }
        next.show(current);
    }

    synchronized void detach(View gone) {
        if (view == gone) view = null;
    }

    /** False while the app is off screen: no request goes out until it is true again. */
    synchronized void foreground(boolean visible) {
        held = !visible;
        if (flow == null) return;
        if (visible) flow.release();
        else flow.hold();
    }

    /** The user cancelled (or left the screen for good): stops the flow. */
    synchronized void cancel() {
        cancelled = true;
        if (flow != null) flow.abort();
    }

    synchronized Snapshot snapshot() {
        return snapshot;
    }

    private void run() {
        PairingFlow pairing;
        try {
            pairing = new PairingFlow(host.http(), code, timing);
        } catch (IOException e) {
            host.end();
            update(current -> current.failed(PairingFlow.Failure.UNREACHABLE));
            return;
        }
        synchronized (this) {
            flow = pairing;
            if (held) pairing.hold();
            if (cancelled) pairing.abort();
        }
        PairingFlow.Result result;
        try {
            result = pairing.run(new PairingFlow.Listener() {
                @Override
                public void onSas(String sas, String deviceName) {
                    update(current -> new Snapshot(Phase.WAITING, sas, deviceName, false, null));
                }

                @Override
                public void onConnection(boolean answering) {
                    update(current -> new Snapshot(current.phase, current.sas, current.deviceName, !answering, null));
                }
            });
        } catch (PairingFlow.Failed failed) {
            host.end();
            update(current -> current.failed(failed.failure));
            return;
        }
        update(current -> current.phase(Phase.SAVING));
        host.save(result, ok -> update(current -> ok ? current.phase(Phase.PAIRED) : current.failed(null)));
    }

    private interface Change {
        Snapshot apply(Snapshot current);
    }

    private void update(Change change) {
        Snapshot next;
        View target;
        synchronized (this) {
            next = change.apply(snapshot);
            snapshot = next;
            target = view;
        }
        if (target != null) target.show(next);
    }
}
