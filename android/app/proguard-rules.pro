# Pixie: minification is disabled for now; these rules keep a future minified build working.

# OkHttp / Okio
-dontwarn okhttp3.internal.platform.**
-dontwarn org.conscrypt.**
-dontwarn org.bouncycastle.**
-dontwarn org.openjsse.**

# Components referenced from the manifest are kept by AAPT automatically.
