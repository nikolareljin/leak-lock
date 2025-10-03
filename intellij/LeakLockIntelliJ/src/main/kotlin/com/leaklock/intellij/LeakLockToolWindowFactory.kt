package com.leaklock.intellij

import com.intellij.openapi.project.DumbAware
import com.intellij.openapi.project.Project
import com.intellij.openapi.wm.ToolWindow
import com.intellij.openapi.wm.ToolWindowFactory
import com.intellij.ui.content.ContentFactory
import com.leaklock.intellij.services.PanelService
import javax.swing.JPanel
import com.intellij.openapi.actionSystem.AnAction
import com.intellij.openapi.actionSystem.AnActionEvent

class LeakLockToolWindowFactory : ToolWindowFactory, DumbAware {
    override fun createToolWindowContent(project: Project, toolWindow: ToolWindow) {
        val panel = LeakLockPanel(project)
        val content = ContentFactory.getInstance().createContent(panel.root, "Scanner", false)
        toolWindow.contentManager.addContent(content)
        // Publish panel reference for actions
        project.getService(PanelService::class.java).panel = panel
    }

    class ShowAction : AnAction() {
        override fun actionPerformed(e: AnActionEvent) {
            val project = e.project ?: return
            val toolWindow = com.intellij.openapi.wm.ToolWindowManager.getInstance(project).getToolWindow("Leak Lock")
            toolWindow?.activate(null, true)
        }
    }
}
