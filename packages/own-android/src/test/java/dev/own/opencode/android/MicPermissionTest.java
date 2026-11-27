package dev.own.opencode.android;

import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

import org.junit.Test;

/** Voice input's microphone (02 §3.9, 08 §4.2): audio only, the PC's app origin only. */
public class MicPermissionTest {
    private static final String HOST = "abcdefghij.ownpc.internal";
    private static final String[] AUDIO = {MicPermission.AUDIO_CAPTURE};

    @Test
    public void grantsAudioToTheAppOrigin() {
        assertTrue(MicPermission.grantable("https://" + HOST + "/", HOST, AUDIO));
        assertTrue(MicPermission.grantable("https://" + HOST, HOST, AUDIO));
        assertTrue(MicPermission.grantable("https://" + HOST.toUpperCase(java.util.Locale.ROOT) + ":443/", HOST, AUDIO));
    }

    @Test
    public void neverVideoOrAnythingBesideAudio() {
        assertFalse(MicPermission.grantable("https://" + HOST + "/", HOST, new String[] {"android.webkit.resource.VIDEO_CAPTURE"}));
        assertFalse(MicPermission.grantable(
                "https://" + HOST + "/", HOST, new String[] {MicPermission.AUDIO_CAPTURE, "android.webkit.resource.VIDEO_CAPTURE"}));
        assertFalse(MicPermission.grantable("https://" + HOST + "/", HOST, new String[] {"android.webkit.resource.MIDI_SYSEX"}));
        assertFalse(MicPermission.grantable("https://" + HOST + "/", HOST, new String[0]));
        assertFalse(MicPermission.grantable("https://" + HOST + "/", HOST, null));
    }

    @Test
    public void neverAnotherOrigin() {
        assertFalse(MicPermission.grantable("http://" + HOST + "/", HOST, AUDIO));
        assertFalse(MicPermission.grantable("https://other.ownpc.internal/", HOST, AUDIO));
        assertFalse(MicPermission.grantable("https://" + HOST + ".evil.example/", HOST, AUDIO));
        assertFalse(MicPermission.grantable("https://" + HOST + ":8443/", HOST, AUDIO));
        assertFalse(MicPermission.grantable("https://user@" + HOST + "/", HOST, AUDIO));
        assertFalse(MicPermission.grantable("not a url", HOST, AUDIO));
        assertFalse(MicPermission.grantable(null, HOST, AUDIO));
    }
}
