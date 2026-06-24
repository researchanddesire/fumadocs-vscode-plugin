// Interactive Fumadocs preview: click-to-edit blocks, convert Markdown to
// components, and add items to components. Talks back to the extension which
// owns the source document.
(function () {
  const vscode = acquireVsCodeApi();
  const DEBOUNCE_MS = 250;

  const post = (message) => vscode.postMessage(message);

  const getContent = () => document.querySelector(".fd-content");

  // --- Inline editing -------------------------------------------------------
  let active = null; // { block, textarea, start, prev, timer }

  const commit = () => {
    if (!active) {
      return;
    }
    if (active.timer) {
      clearTimeout(active.timer);
    }
    active = null;
    // Releases the render lock and re-renders with the latest content.
    post({ type: "editEnd" });
  };

  const autosize = (textarea) => {
    textarea.style.height = "auto";
    textarea.style.height = textarea.scrollHeight + "px";
  };

  const sendLive = () => {
    if (!active) {
      return;
    }
    const value = active.textarea.value;
    post({
      type: "live",
      start: active.start,
      end: active.start + active.prev.length,
      text: value,
    });
    active.prev = value;
  };

  const beginEdit = (block) => {
    if (active && active.block === block) {
      return;
    }
    if (active) {
      commit();
    }

    const raw = decodeURIComponent(block.dataset.raw || "");
    const start = parseInt(block.dataset.srcStart, 10);
    const content = block.querySelector(".fd-block-content");
    if (!content || Number.isNaN(start)) {
      return;
    }

    // Lock rendering on the extension side BEFORE we open the editor, so no
    // in-flight render can clobber it.
    post({ type: "editStart" });

    const textarea = document.createElement("textarea");
    textarea.className = "fd-editor";
    textarea.value = raw;
    textarea.spellcheck = false;

    content.style.display = "none";
    block.appendChild(textarea);
    autosize(textarea);
    textarea.focus();
    const caret = raw.length;
    textarea.setSelectionRange(caret, caret);

    active = { block, textarea, start, prev: raw, timer: null };

    textarea.addEventListener("input", () => {
      autosize(textarea);
      if (active.timer) {
        clearTimeout(active.timer);
      }
      active.timer = setTimeout(sendLive, DEBOUNCE_MS);
    });

    textarea.addEventListener("blur", () => {
      sendLive();
      commit();
    });

    textarea.addEventListener("keydown", (event) => {
      if (event.key === "Escape") {
        event.preventDefault();
        textarea.blur();
      }
    });
  };

  // --- Event delegation -----------------------------------------------------
  document.addEventListener("click", (event) => {
    const target = event.target;

    // Buttons
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

    const edit = target.closest(".fd-tool-edit");
    if (edit) {
      event.preventDefault();
      beginEdit(edit.closest(".fd-block"));
      return;
    }

    // Links never navigate inside the preview.
    if (target.closest("a")) {
      event.preventDefault();
    }

    // Click on block content -> edit (ignore clicks on the toolbar).
    const contentBlock = target.closest(".fd-block-content");
    if (contentBlock) {
      beginEdit(contentBlock.closest(".fd-block"));
    }
  });

  window.addEventListener("message", (event) => {
    const data = event.data;
    if (!data || data.type !== "update") {
      return;
    }
    // Never patch over an open inline editor.
    if (active) {
      return;
    }
    const content = getContent();
    if (content) {
      content.innerHTML = data.html;
    }
  });
})();
