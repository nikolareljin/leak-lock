plugins {
    kotlin("jvm") version "1.9.22"
    id("org.jetbrains.intellij") version "1.17.2"
}

group = providers.gradleProperty("pluginGroup").get()
version = providers.gradleProperty("pluginVersion").get()

repositories { mavenCentral() }

intellij {
    version.set(providers.gradleProperty("platformVersion").get())
    type.set("IC") // IntelliJ Community
    plugins.set(listOf())
}

tasks {
    patchPluginXml {
        sinceBuild.set("223")
        untilBuild.set(null as String?)
        changeNotes.set("Initial Leak Lock IntelliJ plugin")
    }
    publishPlugin {
        // Configure token/channels from environment if provided
        val tokenProvider = providers.environmentVariable("JETBRAINS_TOKEN")
        val channelProvider = providers.environmentVariable("JETBRAINS_CHANNEL").orElse("default")
        token.set(tokenProvider)
        channels.set(listOf(channelProvider.get()))
        onlyIf { tokenProvider.isPresent }
    }
}

dependencies {
    // Use platform's Gson
    compileOnly("com.google.code.gson:gson:2.10.1")
}

kotlin { jvmToolchain(17) }
