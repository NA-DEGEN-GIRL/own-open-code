package dev.own.opencode.android;

import android.app.Activity;
import android.app.AlertDialog;
import android.content.Intent;
import android.net.Uri;
import android.os.Bundle;
import android.text.InputType;
import android.view.View;
import android.view.ViewGroup;
import android.widget.ArrayAdapter;
import android.widget.EditText;
import android.widget.FrameLayout;
import android.widget.ListView;
import android.widget.TextView;
import android.widget.Toast;
import com.google.mlkit.vision.barcode.common.Barcode;
import com.google.mlkit.vision.codescanner.GmsBarcodeScannerOptions;
import com.google.mlkit.vision.codescanner.GmsBarcodeScanning;
import java.time.Instant;
import java.time.ZoneId;
import java.time.format.DateTimeFormatter;
import java.util.ArrayList;
import java.util.List;

/**
 * The paired PCs: tap opens one, long-press removes it, [PC 추가] scans a QR (Google code scanner, no camera
 * permission) or takes a pasted link. Also receives {@code ownpc://pair?...} links from other apps.
 */
public final class MainActivity extends Activity {
    private static final DateTimeFormatter DATE = DateTimeFormatter.ofPattern("yyyy-MM-dd");

    private final List<PcRecord> records = new ArrayList<>();
    private ArrayAdapter<PcRecord> adapter;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        setContentView(R.layout.activity_main);
        EdgeToEdge.apply(this, findViewById(R.id.root));

        ListView list = findViewById(R.id.list);
        list.setEmptyView(findViewById(R.id.empty));
        adapter = new ArrayAdapter<PcRecord>(this, R.layout.item_pc, R.id.name, records) {
            @Override
            public View getView(int position, View convertView, ViewGroup parent) {
                View view = super.getView(position, convertView, parent);
                PcRecord record = getItem(position);
                ((TextView) view.findViewById(R.id.name)).setText(record.name);
                ((TextView) view.findViewById(R.id.detail)).setText(detail(record));
                return view;
            }
        };
        list.setAdapter(adapter);
        list.setOnItemClickListener((parent, view, position, id) -> open(records.get(position)));
        list.setOnItemLongClickListener((parent, view, position, id) -> {
            confirmRemove(records.get(position));
            return true;
        });
        findViewById(R.id.add).setOnClickListener(v -> showAdd());

        if (savedInstanceState == null) handleLink(getIntent());
    }

    @Override
    protected void onNewIntent(Intent intent) {
        super.onNewIntent(intent);
        handleLink(intent);
    }

    @Override
    protected void onResume() {
        super.onResume();
        refresh();
    }

    private void refresh() {
        OwnApp app = OwnApp.of(this);
        records.clear();
        for (PcRecord record : app.store().list()) if (!app.isRemoving(record.pcKey)) records.add(record);
        adapter.notifyDataSetChanged();
    }

    private String detail(PcRecord record) {
        Route route = record.lastRoute != null ? record.lastRoute : record.routes.get(0);
        if (System.currentTimeMillis() >= record.expiresAt) return getString(R.string.item_expired, route.toString());
        String date = DATE.format(Instant.ofEpochMilli(record.expiresAt).atZone(ZoneId.systemDefault()));
        return getString(R.string.item_detail, route.toString(), date);
    }

    /** An {@code ownpc://pair} VIEW intent. A relaunch from recents replays the old intent: its code is spent. */
    private void handleLink(Intent intent) {
        if (intent == null || !Intent.ACTION_VIEW.equals(intent.getAction())) return;
        if ((intent.getFlags() & Intent.FLAG_ACTIVITY_LAUNCHED_FROM_HISTORY) != 0) return;
        Uri data = intent.getData();
        if (data == null || !"ownpc".equalsIgnoreCase(data.getScheme())) return;
        // Consume it so a configuration change or a later onNewIntent does not pair twice.
        setIntent(new Intent(this, MainActivity.class));
        startPairing(data.toString(), true);
    }

    private void showAdd() {
        String[] choices = {getString(R.string.add_scan), getString(R.string.add_paste)};
        new AlertDialog.Builder(this)
                .setTitle(R.string.add_pc)
                .setItems(choices, (dialog, which) -> {
                    if (which == 0) scan();
                    else showPaste();
                })
                .show();
    }

    private void scan() {
        GmsBarcodeScannerOptions options = new GmsBarcodeScannerOptions.Builder()
                .setBarcodeFormats(Barcode.FORMAT_QR_CODE)
                .build();
        GmsBarcodeScanning.getClient(this, options)
                .startScan()
                .addOnSuccessListener(barcode -> {
                    String raw = barcode.getRawValue();
                    if (raw == null || !raw.trim().regionMatches(true, 0, "ownpc://", 0, 8)) {
                        Toast.makeText(this, R.string.scan_not_link, Toast.LENGTH_LONG).show();
                        return;
                    }
                    startPairing(raw, false);
                })
                .addOnFailureListener(error -> Toast.makeText(this, R.string.scan_unavailable, Toast.LENGTH_LONG).show());
    }

    private void showPaste() {
        EditText input = new EditText(this);
        input.setHint(R.string.paste_hint);
        input.setInputType(InputType.TYPE_CLASS_TEXT | InputType.TYPE_TEXT_VARIATION_URI | InputType.TYPE_TEXT_FLAG_NO_SUGGESTIONS);
        input.setSingleLine(true);
        FrameLayout frame = new FrameLayout(this);
        int pad = Math.round(20 * getResources().getDisplayMetrics().density);
        frame.setPadding(pad, pad / 2, pad, 0);
        frame.addView(input);
        new AlertDialog.Builder(this)
                .setTitle(R.string.paste_title)
                .setView(frame)
                .setPositiveButton(R.string.connect, (dialog, which) -> startPairing(input.getText().toString(), false))
                .setNegativeButton(R.string.cancel, null)
                .show();
    }

    private void startPairing(String link, boolean external) {
        Intent intent = new Intent(this, PairingActivity.class)
                .putExtra(PairingActivity.EXTRA_LINK, link)
                .putExtra(PairingActivity.EXTRA_EXTERNAL, external);
        startActivity(intent);
    }

    private void open(PcRecord record) {
        startActivity(new Intent(this, PcActivity.class).putExtra(PcActivity.EXTRA_PC_KEY, record.pcKey));
    }

    private void confirmRemove(PcRecord record) {
        new AlertDialog.Builder(this)
                .setTitle(getString(R.string.remove_title, record.name))
                .setMessage(R.string.remove_body)
                .setPositiveButton(R.string.remove, (dialog, which) -> {
                    // Gone from the list at once; the revoke call on the PC (best effort, ~5 s) finishes in the background.
                    records.remove(record);
                    adapter.notifyDataSetChanged();
                    OwnApp.of(this).removePc(record, () -> {
                        if (!isDestroyed()) refresh();
                    });
                })
                .setNegativeButton(R.string.cancel, null)
                .show();
    }
}
