plugins {
    id("com.android.application")
}

android {
    namespace = "com.teamdark.darkagent"
    compileSdk = 34

    defaultConfig {
        applicationId = "com.teamdark.darkagent"
        minSdk = 24
        targetSdk = 34
        versionCode = 4
        versionName = "1.2.1"
    }

    buildTypes {
        debug {
            applicationIdSuffix = ""
        }
        release {
            isMinifyEnabled = false
        }
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }

    lint {
        abortOnError = false
    }
}

dependencies {
}
