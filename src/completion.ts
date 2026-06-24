import * as vscode from "vscode";
import { getComponents, getComponent } from "./manifest";
import {
  findEnclosingOpenTag,
  propInsertText,
  snippetToExample,
} from "./util";

const componentNameCompletions = (
  document: vscode.TextDocument,
  position: vscode.Position,
): vscode.CompletionItem[] | undefined => {
  const linePrefix = document
    .lineAt(position.line)
    .text.slice(0, position.character);

  const match = /<([A-Za-z][A-Za-z0-9]*)?$/.exec(linePrefix);
  if (!match) {
    return undefined;
  }

  // Replace from the `<` so we do not end up with `<<Component`.
  const start = new vscode.Position(
    position.line,
    position.character - match[0].length,
  );
  const replaceRange = new vscode.Range(start, position);

  return getComponents().map((component) => {
    const item = new vscode.CompletionItem(
      component.name,
      vscode.CompletionItemKind.Snippet,
    );
    item.detail = component.label;
    item.documentation = new vscode.MarkdownString(
      `${component.description}\n\n\`\`\`mdx\n${snippetToExample(
        component.snippet,
      )}\n\`\`\``,
    );
    item.insertText = new vscode.SnippetString(component.snippet);
    item.range = replaceRange;
    item.sortText = `0_${component.name}`;
    return item;
  });
};

const propCompletions = (
  document: vscode.TextDocument,
  position: vscode.Position,
): vscode.CompletionItem[] | undefined => {
  const textBeforeCursor = document.getText(
    new vscode.Range(new vscode.Position(0, 0), position),
  );

  const tagName = findEnclosingOpenTag(textBeforeCursor);
  if (!tagName) {
    return undefined;
  }

  const component = getComponent(tagName);
  if (!component || component.props.length === 0) {
    return undefined;
  }

  // Skip props already present in the current opening tag.
  const openTagText = textBeforeCursor.slice(textBeforeCursor.lastIndexOf("<"));

  return component.props
    .filter((prop) => !new RegExp(`\\b${prop.name}\\b`).test(openTagText))
    .map((prop) => {
      const item = new vscode.CompletionItem(
        prop.name,
        vscode.CompletionItemKind.Property,
      );
      const typeLabel =
        prop.type === "enum" && prop.values
          ? prop.values.join(" | ")
          : prop.type;
      item.detail = `${prop.name}: ${typeLabel}`;
      const docParts = [prop.description ?? ""];
      if (prop.default) {
        docParts.push(`\n\nDefault: \`${prop.default}\``);
      }
      item.documentation = new vscode.MarkdownString(docParts.join(""));
      item.insertText = new vscode.SnippetString(propInsertText(prop));
      item.sortText = `0_${prop.name}`;
      return item;
    });
};

export const completionProvider: vscode.CompletionItemProvider = {
  provideCompletionItems(document, position) {
    return (
      componentNameCompletions(document, position) ??
      propCompletions(document, position)
    );
  },
};
