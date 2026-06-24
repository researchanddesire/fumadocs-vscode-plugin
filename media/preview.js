// Interactive Fumadocs preview: edit blocks (inline WYSIWYG or raw Markdown),
// convert Markdown to components, and add items to components. Talks back to
// the extension which owns the source document.
(function () {
  const vscode = acquireVsCodeApi();
  const DEBOUNCE_MS = 250;

  const post = (message) => vscode.postMessage(message);
  const getContent = () => document.querySelector(".fd-content");

  // --- HTML -> Markdown (for inline WYSIWYG editing) ------------------------
  const inlineMd = (node) => {
    let out = "";
    node.childNodes.forEach((child) => {
      if (child.nodeType === 3) {
        out += child.textContent;
        return;
      }
      if (child.nodeType !== 1) {
        return;
      }
      const tag = child.tagName.toLowerCase();
      const inner = inlineMd(child);
      if (tag === "strong" || tag === "b") {
        out += "**" + inner + "**";
      } else if (tag === "em" || tag === "i") {
        out += "*" + inner + "*";
      } else if (tag === "code") {
        out += "`" + child.textContent + "`";
      } else if (tag === "a") {
        out += "[" + inner + "](" + (child.getAttribute("href") || "") + ")";
      } else if (tag === "br") {
        out += "\n";
      } else {
        out += inner;
      }
    });
    return out;
  };

  const blockMd = (node) => {
    if (node.nodeType === 3) {
      const text = node.textContent.trim();
      return text || null;
    }
    if (node.nodeType !== 1) {
      return null;
    }
    const tag = node.tagName.toLowerCase();
    if (/^h[1-6]$/.test(tag)) {
      return "#".repeat(Number(tag[1])) + " " + inlineMd(node).trim();
    }
    if (tag === "ul") {
      return Array.from(node.children)
        .map((li) => "- " + inlineMd(li).trim())
        .join("\n");
    }
    if (tag === "ol") {
      return Array.from(node.children)
        .map((li, i) => i + 1 + ". " + inlineMd(li).trim())
        .join("\n");
    }
    if (tag === "blockquote") {
      return inlineMd(node)
        .split("\n")
        .map((line) => "> " + line)
        .join("\n");
    }
    if (tag === "pre") {
      return "```\n" + node.textContent.replace(/\n$/, "") + "\n```";
    }
    if (tag === "hr") {
      return "---";
    }
    // p, div, and anything else -> a paragraph of inline content.
    return inlineMd(node).trim() || null;
  };

  const serialize = (root) =>
    Array.from(root.childNodes)
      .map(blockMd)
      .filter((s) => s !== null && s !== "")
      .join("\n\n")
      .trim();

  const placeCaretEnd = (el) => {
    const range = document.createRange();
    range.selectNodeContents(el);
    range.collapse(false);
    const sel = window.getSelection();
    sel.removeAllRanges();
    sel.addRange(range);
  };

  const autosize = (textarea) => {
    textarea.style.height = "auto";
    textarea.style.height = textarea.scrollHeight + "px";
  };

  // --- Editing lifecycle ---------------------------------------------------
  let active = null; // { block, start, prev, timer, getValue, cleanup }

  const sendLive = () => {
    if (!active) {
      return;
    }
    const value = active.getValue();
    post({
      type: "live",
      start: active.start,
      end: active.start + active.prev.length,
      text: value,
    });
    active.prev = value;
  };

  const commit = () => {
    if (!active) {
      return;
    }
    if (active.timer) {
      clearTimeout(active.timer);
    }
    const current = active;
    active = null;
    current.cleanup();
    // Releases the render lock and re-renders with the latest content.
    post({ type: "editEnd" });
  };

  const bindEditorEvents = (el) => {
    el.addEventListener("input", () => {
      if (el.tagName === "TEXTAREA") {
        autosize(el);
      }
      if (active && active.timer) {
        clearTimeout(active.timer);
      }
      if (active) {
        active.timer = setTimeout(sendLive, DEBOUNCE_MS);
      }
    });
    el.addEventListener("blur", () => {
      sendLive();
      commit();
    });
    el.addEventListener("keydown", (event) => {
      if (event.key === "Escape") {
        event.preventDefault();
        el.blur();
      }
    });
  };

  const beginCodeEdit = (block, content, start, raw) => {
    const textarea = document.createElement("textarea");
    textarea.className = "fd-editor";
    textarea.value = raw;
    textarea.spellcheck = false;
    content.style.display = "none";
    block.appendChild(textarea);
    autosize(textarea);
    textarea.focus();
    textarea.setSelectionRange(raw.length, raw.length);
    bindEditorEvents(textarea);
    return {
      getValue: () => textarea.value,
      cleanup: () => {
        textarea.remove();
        content.style.display = "";
      },
    };
  };

  const beginInlineEdit = (content) => {
    content.setAttribute("contenteditable", "true");
    content.classList.add("fd-editing-inline");
    content.focus();
    placeCaretEnd(content);
    bindEditorEvents(content);
    return {
      getValue: () => serialize(content),
      cleanup: () => {
        content.removeAttribute("contenteditable");
        content.classList.remove("fd-editing-inline");
      },
    };
  };

  const beginEdit = (block, mode) => {
    if (active && active.block === block) {
      return;
    }
    if (active) {
      commit();
    }
    const start = parseInt(block.dataset.srcStart, 10);
    const raw = decodeURIComponent(block.dataset.raw || "");
    const content = block.querySelector(".fd-block-content");
    if (!content || Number.isNaN(start)) {
      return;
    }

    // Lock rendering BEFORE opening the editor so no in-flight render clobbers it.
    post({ type: "editStart" });

    const editor =
      mode === "inline"
        ? beginInlineEdit(content)
        : beginCodeEdit(block, content, start, raw);

    active = {
      block,
      start,
      prev: raw,
      timer: null,
      getValue: editor.getValue,
      cleanup: editor.cleanup,
    };
  };

  // --- Event delegation -----------------------------------------------------
  document.addEventListener("click", (event) => {
    const target = event.target;

    const convert = target.closest(".fd-tool-convert");
    if (convert) {
      event.preventDefault();
      post({
        type: "apply",
        start: parseInt(convert.dataset.convStart, 10),
        end: parseInt(convert.dataset.convEnd, 10),
        text: decodeURIComponent(convert.dataset.convText || ""),
      });
      return;
    }

    const add = target.closest(".fd-tool-add");
    if (add) {
      event.preventDefault();
      const block = add.closest(".fd-block");
      post({
        type: "addItem",
        start: parseInt(block.dataset.srcStart, 10),
        end: parseInt(block.dataset.srcEnd, 10),
        name: add.dataset.add,
      });
      return;
    }

    // Code icon -> raw Markdown editor (works for any block, incl. components).
    const edit = target.closest(".fd-tool-edit");
    if (edit) {
      event.preventDefault();
      beginEdit(edit.closest(".fd-block"), "code");
      return;
    }

    // Don't hijack clicks while already editing inline.
    if (target.closest('[contenteditable="true"]')) {
      return;
    }

    // Links never navigate inside the preview.
    if (target.closest("a")) {
      event.preventDefault();
    }

    // Click on text -> edit in place. Plain Markdown blocks edit inline
    // (WYSIWYG, keeping their style); component blocks edit their raw source.
    const contentBlock = target.closest(".fd-block-content");
    if (contentBlock) {
      const block = contentBlock.closest(".fd-block");
      const mode = block.dataset.component ? "code" : "inline";
      beginEdit(block, mode);
    }
  });

  window.addEventListener("message", (event) => {
    const data = event.data;
    if (!data || data.type !== "update") {
      return;
    }
    if (active) {
      return;
    }
    const content = getContent();
    if (content) {
      content.innerHTML = data.html;
    }
  });
})();
