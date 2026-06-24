import * as vscode from "vscode";
import { getComponents, getComponent } from "./manifest";

const NEW_PAGE_TEMPLATE = `---
title: \${1:Page Title}
description: \${2:A short description of this page}
---

\${3:Start writing here.}
`;

export const insertComponent = async (): Promise<void> => {
  const editor = vscode.window.activeTextEditor;
  if (!editor) {
    void vscode.window.showWarningMessage("Open an MDX file first.");
    return;
  }

  const picks: (vscode.QuickPickItem & { name: string })[] = getComponents().map(
    (component) => ({
      name: component.name,
      label: component.label,
      detail: component.description,
    }),
  );

  const choice = await vscode.window.showQuickPick(picks, {
    title: "Insert Fumadocs Component",
    placeHolder: "Pick a component to insert at the cursor",
    matchOnDetail: true,
  });

  if (!choice) {
    return;
  }

  const component = getComponent(choice.name);
  if (!component) {
    return;
  }

  await editor.insertSnippet(new vscode.SnippetString(component.snippet));
};

export const newDocPage = async (): Promise<void> => {
  const editor = vscode.window.activeTextEditor;
  if (!editor) {
    void vscode.window.showWarningMessage("Open an MDX file first.");
    return;
  }

  if (!editor.document.getText().trim()) {
    await editor.insertSnippet(new vscode.SnippetString(NEW_PAGE_TEMPLATE));
    return;
  }

  void vscode.window.showInformationMessage(
    "This file already has content. The frontmatter template is only inserted into empty files.",
  );
};
