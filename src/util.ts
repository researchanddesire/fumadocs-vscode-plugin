import { ComponentDef } from "./manifest";

/**
 * Turn a snippet body (with ${1:foo} / ${1|a,b|} placeholders) into a clean
 * example string suitable for showing in hover docs.
 */
export const snippetToExample = (snippet: string): string =>
  snippet
    // ${1|a,b,c|} -> a
    .replace(/\$\{\d+\|([^|]*?)(?:,[^|]*)*\|\}/g, "$1")
    // ${1:default} -> default
    .replace(/\$\{\d+:([^}]*)\}/g, "$1")
    // ${1} or $1 -> ""
    .replace(/\$\{\d+\}/g, "")
    .replace(/\$\d+/g, "")
    .trimEnd();

/**
 * Find the name of the JSX tag currently being typed at `offset`, if the cursor
 * sits inside an unclosed `<Tag ...` opening tag. Returns undefined otherwise.
 */
export const findEnclosingOpenTag = (
  textBeforeCursor: string,
): string | undefined => {
  const lastOpen = textBeforeCursor.lastIndexOf("<");
  if (lastOpen === -1) {
    return undefined;
  }

  const fragment = textBeforeCursor.slice(lastOpen);
  // If the tag was already closed (`>`), we are not inside it anymore.
  if (fragment.includes(">")) {
    return undefined;
  }
  // Closing tags and fragments are not opening tags.
  if (fragment.startsWith("</")) {
    return undefined;
  }

  const match = /^<([A-Za-z][A-Za-z0-9]*)/.exec(fragment);
  return match ? match[1] : undefined;
};

/**
 * Build the insert text for a single prop completion.
 */
export const propInsertText = (
  prop: ComponentDef["props"][number],
): string => {
  if (prop.type === "boolean") {
    return prop.name;
  }
  if (prop.type === "enum" && prop.values && prop.values.length > 0) {
    return `${prop.name}="\${1|${prop.values.join(",")}|}"`;
  }
  if (prop.type === "array" || prop.type === "object") {
    return `${prop.name}={$1}`;
  }
  return `${prop.name}="$1"`;
};
