import * as vscode from "vscode";
import { getComponent, isKnownComponent } from "./manifest";

const SOURCE = "fumadocs";

const isMdx = (document: vscode.TextDocument): boolean =>
  document.languageId === "mdx" || document.fileName.endsWith(".mdx");

const checkFrontmatter = (
  document: vscode.TextDocument,
  diagnostics: vscode.Diagnostic[],
): void => {
  const text = document.getText();
  const match = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text);

  if (!match) {
    const firstLine = document.lineAt(0);
    diagnostics.push(
      new vscode.Diagnostic(
        firstLine.range,
        "Missing frontmatter. Add a `---` block with `title:` and `description:` at the top of the file.",
        vscode.DiagnosticSeverity.Warning,
      ),
    );
    return;
  }

  const block = match[1];
  const headerRange = new vscode.Range(0, 0, 0, 3);
  if (!/^title:\s*\S/m.test(block)) {
    diagnostics.push(
      new vscode.Diagnostic(
        headerRange,
        "Frontmatter is missing a `title:`.",
        vscode.DiagnosticSeverity.Warning,
      ),
    );
  }
  if (!/^description:\s*\S/m.test(block)) {
    diagnostics.push(
      new vscode.Diagnostic(
        headerRange,
        "Frontmatter is missing a `description:`.",
        vscode.DiagnosticSeverity.Information,
      ),
    );
  }
};

const rangeFor = (
  document: vscode.TextDocument,
  start: number,
  length: number,
): vscode.Range =>
  new vscode.Range(
    document.positionAt(start),
    document.positionAt(start + length),
  );

const checkEnumProps = (
  document: vscode.TextDocument,
  componentName: string,
  attrText: string,
  attrOffset: number,
  diagnostics: vscode.Diagnostic[],
): void => {
  const component = getComponent(componentName);
  if (!component) {
    return;
  }

  for (const prop of component.props) {
    if (prop.type !== "enum" || !prop.values) {
      continue;
    }
    const propRegex = new RegExp(`${prop.name}="([^"]*)"`, "g");
    let propMatch: RegExpExecArray | null;
    while ((propMatch = propRegex.exec(attrText)) !== null) {
      const value = propMatch[1];
      if (!prop.values.includes(value)) {
        const valueStart =
          attrOffset + propMatch.index + propMatch[0].indexOf(value);
        diagnostics.push(
          new vscode.Diagnostic(
            rangeFor(document, valueStart, value.length),
            `Invalid value "${value}" for \`${prop.name}\` on <${componentName}>. Expected one of: ${prop.values.join(
              ", ",
            )}.`,
            vscode.DiagnosticSeverity.Warning,
          ),
        );
      }
    }
  }
};

const checkComponents = (
  document: vscode.TextDocument,
  diagnostics: vscode.Diagnostic[],
): void => {
  const text = document.getText();
  const tagRegex = /<([A-Z][A-Za-z0-9]*)((?:[^>"']|"[^"]*"|'[^']*')*?)\/?>/g;
  let match: RegExpExecArray | null;

  while ((match = tagRegex.exec(text)) !== null) {
    const name = match[1];
    const attrText = match[2] ?? "";
    const nameStart = match.index + 1;

    if (!isKnownComponent(name)) {
      diagnostics.push(
        new vscode.Diagnostic(
          rangeFor(document, nameStart, name.length),
          `<${name}> is not a known Fumadocs component. It will fail to render unless it is registered in your app's getMDXComponents.`,
          vscode.DiagnosticSeverity.Warning,
        ),
      );
      continue;
    }

    const attrOffset = nameStart + name.length;
    checkEnumProps(document, name, attrText, attrOffset, diagnostics);
  }
};

export const refreshDiagnostics = (
  document: vscode.TextDocument,
  collection: vscode.DiagnosticCollection,
): void => {
  if (!isMdx(document)) {
    collection.delete(document.uri);
    return;
  }

  const diagnostics: vscode.Diagnostic[] = [];
  checkFrontmatter(document, diagnostics);
  checkComponents(document, diagnostics);

  for (const diagnostic of diagnostics) {
    diagnostic.source = SOURCE;
  }

  collection.set(document.uri, diagnostics);
};
