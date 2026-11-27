plugins {
    id("com.android.application") version "9.4.1"
}

fun versionCodeOf(version: String): Int {
    val match = Regex("""^(\d+)\.(\d+)\.(\d+)-own\.(\d+)$""").matchEntire(version)
        ?: throw GradleException("version $version is not <a>.<b>.<c>-own.<k>")
    val (a, b, c, k) = match.destructured.toList().map { it.toInt() }
    if (b >= 100 || c >= 100 || k >= 1000) throw GradleException("version $version is out of the versionCode scheme")
    return a * 10_000_000 + b * 100_000 + c * 1_000 + k
}

android {
    namespace = "dev.own.opencode.android"
    compileSdk = 36
    // The SDK on the build PC carries build-tools 37.0.0 only (AGP 9.4's default is 36.0.0).
    buildToolsVersion = "37.0.0"

    defaultConfig {
        applicationId = "dev.own.opencode.android"
        minSdk = 29
        targetSdk = 36
        // own/scripts/build-android.ps1 passes -PownVersion=<Version>.
        versionName = providers.gradleProperty("ownVersion").getOrElse("2.0.18-own.4")
        // Rising with every release so an update always installs over the last one (same debug key, data kept):
        // <a>.<b>.<c>-own.<k> -> a*10^7 + b*10^5 + c*10^3 + k (b, c < 100, k < 1000). Releases up to 2.2.6-own.7 had 1.
        versionCode = versionCodeOf(versionName!!)
    }

    // A side-by-side test install (-PownTestInstall=1, never passed by own/scripts/build-android.ps1): its own application
    // id and label, so a phone keeps the user's installed app and its data untouched, and debuggable, so the WebView can
    // be inspected over adb while it shows a test service's made-up data (own/reports/mobile-ux-2026-11-06).
    val testInstall = providers.gradleProperty("ownTestInstall").orNull == "1"

    buildTypes {
        debug {
            // The sideloaded APK is the debug variant signed with this PC's debug key (08-app-access.md §4.2), but it
            // must not be debuggable: a debuggable app lets anyone with adb read its data (`run-as`), including the
            // WebView cookie store that holds the device token, and enables WebView remote debugging.
            isDebuggable = testInstall
            if (testInstall) applicationIdSuffix = ".debug"
            manifestPlaceholders["appLabel"] = if (testInstall) "Own 시험" else "@string/app_name"
        }
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }

    testOptions {
        unitTests.all { it.systemProperty("file.encoding", "UTF-8") }
    }
}

dependencies {
    implementation("androidx.webkit:webkit:1.17.1")
    implementation("com.google.android.gms:play-services-code-scanner:16.1.0")

    testImplementation("junit:junit:4.13.2")
    // The real org.json for JVM tests (android.jar only has stubs there); the app uses the platform's copy.
    testImplementation("org.json:json:20260814")
}
