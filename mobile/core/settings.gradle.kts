// The phone app's core (docs/MOBILE.md, step 3): SSH, the agent and terminals as a plain JVM library, built and tested
// on the VM without Android. The Android app will use it as an included build.
// Run with the Android project's wrapper: `npm run mobile:core` (or `mobile/android/gradlew -p mobile/core test`).
rootProject.name = "core"

pluginManagement {
    repositories {
        gradlePluginPortal()
        mavenCentral()
    }
}

dependencyResolutionManagement {
    repositories {
        mavenCentral()
    }
}
