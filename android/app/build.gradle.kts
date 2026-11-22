plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
}

android {
    namespace = "com.homestream.tv"
    compileSdk = 34

    defaultConfig {
        applicationId = "com.homestream.tv"
        minSdk = 21      // 1st-gen Fire Stick = Fire OS 5 (Android 5.1, SDK 22)
        targetSdk = 34
        versionCode = 1
        versionName = "1.0"
    }
    buildTypes { release { isMinifyEnabled = false } }
    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
    kotlinOptions { jvmTarget = "17" }
}

dependencies {
    implementation("org.jetbrains.kotlin:kotlin-stdlib:1.9.24")
    implementation("org.videolan.android:libvlc-all:3.6.2")
}
