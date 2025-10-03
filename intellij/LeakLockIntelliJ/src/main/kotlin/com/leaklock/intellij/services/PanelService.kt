package com.leaklock.intellij.services

import com.intellij.openapi.components.Service
import com.intellij.openapi.project.Project
import com.leaklock.intellij.LeakLockPanel

@Service(Service.Level.PROJECT)
class PanelService(private val project: Project) {
    @Volatile
    var panel: LeakLockPanel? = null
}

