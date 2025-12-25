package com.leaklock.intellij.actions

import com.intellij.openapi.actionSystem.AnAction
import com.intellij.openapi.actionSystem.AnActionEvent
import com.intellij.openapi.project.DumbAware
import com.intellij.openapi.wm.ToolWindowManager
import com.leaklock.intellij.services.PanelService

class ScanProjectAction : AnAction(), DumbAware {
    override fun actionPerformed(e: AnActionEvent) {
        val project = e.project ?: return
        val base = project.basePath ?: return

        val tw = ToolWindowManager.getInstance(project).getToolWindow("Leak Lock")
        // Activate tool window to ensure panel is created
        tw?.activate({
            val service = project.getService(PanelService::class.java)
            service.panel?.startScan(base)
        }, true)
    }
}

