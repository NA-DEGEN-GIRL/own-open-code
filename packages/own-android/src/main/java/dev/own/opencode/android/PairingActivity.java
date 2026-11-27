package dev.own.opencode.android;

import android.app.Activity;
import android.content.Intent;
import android.os.Bundle;
import android.view.View;
import android.widget.Button;
import android.widget.ProgressBar;
import android.widget.TextView;
import java.util.ArrayList;
import java.util.List;

/**
 * Pairs with a PC from a link (08-app-access.md §3.5): shows the SAS to compare with the PC's screen, waits for the
 * PC's approval, then opens the PC. A link that came from another app is confirmed first, because opening it spends
 * the one-time code. A link that would change a stored PC's key is refused before anything is sent
 * ({@link PairingLink#conflictsWith}).
 *
 * <p>The pairing itself is a {@link PairingSession} held by {@link OwnApp} under an id kept in the saved state, so a
 * recreated activity picks it up again. It polls only while this screen is started (Android cuts a background app's
 * network under data saver); the cancel button, back, or the screen finishing cancels it.
 */
public final class PairingActivity extends Activity {
    static final String EXTRA_LINK = "link";
    static final String EXTRA_EXTERNAL = "external";
    private static final String STATE_PAIRING = "pairing";

    private PairingLink link;
    private String pairingId;
    private PairingSession session;
    private boolean visible;
    private boolean opened;
    private final PairingSession.View view = snapshot -> runOnUiThread(() -> render(snapshot));

    private TextView sas;
    private TextView message;
    private TextView device;
    private TextView hint;
    private ProgressBar progress;
    private Button primary;
    private Button cancel;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        setContentView(R.layout.activity_pairing);
        EdgeToEdge.apply(this, findViewById(R.id.root));
        sas = findViewById(R.id.sas);
        message = findViewById(R.id.message);
        device = findViewById(R.id.device);
        hint = findViewById(R.id.hint);
        progress = findViewById(R.id.progress);
        primary = findViewById(R.id.primary);
        cancel = findViewById(R.id.cancel);
        cancel.setOnClickListener(v -> close());

        try {
            link = PairingLink.parse(getIntent().getStringExtra(EXTRA_LINK));
        } catch (PairingLink.Invalid e) {
            fail(R.string.pair_invalid_link);
            return;
        }
        if (link.conflictsWith(OwnApp.of(this).store().get(link.pcKey))) {
            fail(R.string.pair_key_changed);
            return;
        }
        ((TextView) findViewById(R.id.name)).setText(link.name);
        List<String> routes = new ArrayList<>();
        for (Route route : link.routes) routes.add(route.toString());
        // The pcKey and the start of the pin tell two PCs of the same name apart.
        ((TextView) findViewById(R.id.routes)).setText(getString(R.string.pair_routes, String.join(", ", routes)) + "\n"
                + getString(R.string.pair_identity, link.pcKey, link.pin.substring(0, 8)));

        String saved = savedInstanceState == null ? null : savedInstanceState.getString(STATE_PAIRING);
        if (saved != null) {
            // Recreated: the pairing goes on in the app. Gone means the process ended (it is memory only), and the
            // link's code is already spent.
            session = OwnApp.of(this).pairing(saved);
            if (session == null) {
                fail(R.string.pair_interrupted);
                return;
            }
            pairingId = saved;
            progress.setVisibility(View.VISIBLE);
            return;
        }
        if (getIntent().getBooleanExtra(EXTRA_EXTERNAL, false)) {
            PcRecord twin = link.sameNameAs(OwnApp.of(this).store().list());
            message.setText(twin == null ? getString(R.string.pair_confirm)
                    : getString(R.string.pair_confirm_same_name, twin.name));
            if (twin != null) message.setTextColor(getColor(R.color.danger));
            primary.setText(R.string.connect);
            primary.setVisibility(View.VISIBLE);
            primary.setOnClickListener(v -> start());
        } else {
            start();
        }
    }

    @Override
    protected void onStart() {
        super.onStart();
        visible = true;
        if (session == null) return;
        session.attach(view);
        session.foreground(true);
    }

    @Override
    protected void onStop() {
        visible = false;
        if (session != null) {
            session.foreground(false);
            session.detach(view);
        }
        super.onStop();
    }

    @Override
    protected void onSaveInstanceState(Bundle outState) {
        super.onSaveInstanceState(outState);
        if (pairingId != null) outState.putString(STATE_PAIRING, pairingId);
    }

    @Override
    protected void onDestroy() {
        // A configuration change keeps the pairing for the next instance; leaving the screen for good ends it.
        if (isFinishing() && pairingId != null) OwnApp.of(this).dropPairing(pairingId);
        super.onDestroy();
    }

    private void start() {
        if (session != null) return;
        primary.setVisibility(View.GONE);
        progress.setVisibility(View.VISIBLE);
        message.setText(R.string.pair_connecting);
        OwnApp app = OwnApp.of(this);
        pairingId = app.startPairing(link);
        session = app.pairing(pairingId);
        if (visible) session.attach(view);
    }

    /** The cancel button: the pairing stops at once, before the screen goes. */
    private void close() {
        if (pairingId != null) OwnApp.of(this).dropPairing(pairingId);
        pairingId = null;
        finish();
    }

    private void render(PairingSession.Snapshot snapshot) {
        if (isDestroyed() || isFinishing()) return;
        switch (snapshot.phase) {
            case CONNECTING:
                message.setText(R.string.pair_connecting);
                return;
            case WAITING:
                showSas(snapshot);
                return;
            case SAVING:
                message.setText(R.string.pair_saving);
                hint.setVisibility(View.GONE);
                return;
            case PAIRED:
                if (opened) return;
                opened = true;
                startActivity(new Intent(this, PcActivity.class).putExtra(PcActivity.EXTRA_PC_KEY, link.pcKey));
                finish();
                return;
            default:
                if (snapshot.failure == PairingFlow.Failure.ABORTED) return;
                fail(snapshot.failure == null ? R.string.pair_cookie_failed : messageOf(snapshot.failure));
        }
    }

    private void showSas(PairingSession.Snapshot snapshot) {
        sas.setText(snapshot.sas);
        sas.setVisibility(View.VISIBLE);
        message.setText(getString(R.string.pair_sas, snapshot.sas));
        device.setText(getString(R.string.pair_device_name, snapshot.deviceName));
        device.setVisibility(View.VISIBLE);
        hint.setText(snapshot.unanswered ? R.string.pair_waiting_network : R.string.pair_return_hint);
        hint.setTextColor(getColor(snapshot.unanswered ? R.color.danger : R.color.text_secondary));
        hint.setVisibility(View.VISIBLE);
    }

    private void fail(int text) {
        progress.setVisibility(View.GONE);
        sas.setVisibility(View.GONE);
        device.setVisibility(View.GONE);
        hint.setVisibility(View.GONE);
        message.setText(text);
        message.setTextColor(getColor(R.color.danger));
        cancel.setVisibility(View.GONE);
        primary.setText(R.string.close);
        primary.setVisibility(View.VISIBLE);
        primary.setOnClickListener(v -> finish());
    }

    private static int messageOf(PairingFlow.Failure failure) {
        switch (failure) {
            case EXPIRED:
                return R.string.pair_expired;
            case REJECTED:
                return R.string.pair_rejected;
            case CANCELLED:
                return R.string.pair_cancelled;
            case RATE_LIMITED:
                return R.string.pair_rate_limited;
            case PIN_MISMATCH:
                return R.string.pair_pin_mismatch;
            case PROTOCOL:
                return R.string.pair_protocol;
            case CONNECTION_LOST:
                return R.string.pair_connection_lost;
            default:
                return R.string.pair_unreachable;
        }
    }
}
