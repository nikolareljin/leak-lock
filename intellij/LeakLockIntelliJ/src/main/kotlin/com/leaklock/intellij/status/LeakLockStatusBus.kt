package com.leaklock.intellij.status

import com.intellij.openapi.project.Project
import com.intellij.util.messages.Topic

interface LeakLockStatusListener {
    fun statusChanged(text: String)
}

object LeakLockStatusBus {
    val TOPIC: Topic<LeakLockStatusListener> = Topic.create("LeakLockStatus", LeakLockStatusListener::class.java)

    fun set(project: Project, text: String) {
        project.messageBus.syncPublisher(TOPIC).statusChanged(text)
    }
}

