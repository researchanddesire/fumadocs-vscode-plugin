import * as vscode from "vscode";
import { getComponent } from "./manifest";
import { snippetToExample } from "./util";

export const hoverProvider: vscode.HoverProvider = {
  provideHover(document, position) {
    const wordRange = document.getWordRangeAtPosition(
      position,
      /[A-Za-z][A-Za-z0-9]*/,
    );
    if (!wordRange) {
      return undefined;
    }

    const word = document.getText(wordRange);
    const component = getComponent(word);
    if (!component) {
      return undefined;
    }

    // Only treat it as a component if it follows a `<` (an opening/closing tag).
    const charBefore = wordRange.start.character;
    const linePrefix = document
      .lineAt(wordRange.start.line)
      .text.slice(0, charBefore);
    if (!/<\/?\s*$/.test(linePrefix)) {
      return undefined;
    }

    const md = new vscode.MarkdownString();
    md.appendMarkdown(`**${component.label}**\n\n`);
    md.appendMarkdown(`${component.description}\n\n`);

    if (component.props.length > 0) {
      md.appendMarkdown(`**Props**\n\n`);
      for (const prop of component.props) {
        const typeLabel =
          prop.type === "enum" && prop.values
            ? prop.values.map((value) => `\`${value}\``).join(" \u2502 ")
            : `\`${prop.type}\``;
        const defaultLabel = prop.default ? ` (default: \`${prop.default}\`)` : "";
        md.appendMarkdown(
          `- \`${prop.name}\` — ${typeLabel}${defaultLabel}${
            prop.description ? `: ${prop.description}` : ""
          }\n`,
        );
      }
      md.appendMarkdown("\n");
    }

    md.appendMarkdown("**Example**\n");
    md.appendCodeblock(snippetToExample(component.snippet), "mdx");

    if (component.docs) {
      md.appendMarkdown(`\n[Open documentation](${component.docs})`);
    }

    md.isTrusted = true;
    return new vscode.Hover(md, wordRange);
  },
};
