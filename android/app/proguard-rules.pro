# R8 rules for the TapeHorn WebView shell.
#
# Keep any @JavascriptInterface members (none today, but future bridges resolve
# by name at runtime, so obfuscation would silently break them).
-keepclassmembers class * {
    @android.webkit.JavascriptInterface <methods>;
}
-keepattributes JavascriptInterface
