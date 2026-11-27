package dev.own.opencode.android;

import android.app.Activity;
import android.graphics.Insets;
import android.os.Build;
import android.view.View;
import android.view.WindowInsets;

/**
 * Edge-to-edge layout (enforced for targetSdk 35+ on Android 15+): the root view is padded by the system bars, the
 * display cutout and the keyboard. On Android 10 (API 29) the window keeps the classic insets and adjustResize.
 */
final class EdgeToEdge {
    private EdgeToEdge() {}

    // setDecorFitsSystemWindows is deprecated from API 35, where edge-to-edge is enforced anyway; 30–34 still need it.
    @SuppressWarnings("deprecation")
    static void apply(Activity activity, View root) {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.R) return;
        activity.getWindow().setDecorFitsSystemWindows(false);
        int left = root.getPaddingLeft();
        int top = root.getPaddingTop();
        int right = root.getPaddingRight();
        int bottom = root.getPaddingBottom();
        root.setOnApplyWindowInsetsListener((view, insets) -> {
            Insets bars = insets.getInsets(
                    WindowInsets.Type.systemBars() | WindowInsets.Type.displayCutout() | WindowInsets.Type.ime());
            view.setPadding(left + bars.left, top + bars.top, right + bars.right, bottom + bars.bottom);
            return WindowInsets.CONSUMED;
        });
        root.requestApplyInsets();
    }
}
