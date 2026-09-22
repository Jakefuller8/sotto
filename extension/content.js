// Receives encrypted text from the relay, decrypts it locally, and inserts it
// into the page's prompt box as though it had been typed.
//
// The polling loop lives here rather than in a service worker because
// Manifest V3 kills idle workers after ~30s, which made a persistent
// connection impossible. A content script lives as long as its tab.
// fetch() from a content script runs with extension privileges, so page CSP
// cannot block it.

(function () {
  "use strict";

  const RELAY = "https://sotto-relay.onrender.com"; // overridable in the popup

  // Ordered most-specific first. The generic fallbacks absorb UI redesigns.
  const SELECTORS = [
    'div[contenteditable="true"].ProseMirror',
    'div[contenteditable="true"][role="textbox"]',
    "#prompt-textarea",
    'textarea[data-id="root"]',
    'rich-textarea div[contenteditable="true"]',
    'div[contenteditable="true"]',
    "form textarea",
    "textarea",
  ];

  const SEND_SELECTORS = [
    'button[aria-label*="Send" i]',
    'button[data-testid="send-button"]',
    'button[aria-label*="Submit" i]',
    'button[type="submit"]',
  ];

  // ---- insertion ---------------------------------------------------------

  function isEditable(el) {
    if (!el) return false;
    if (el.isContentEditable) return true;
    const tag = el.tagName;
    return tag === "TEXTAREA" || (tag === "INPUT" && /^(text|search)$/i.test(el.type));
  }

  function visible(el) {
    if (!el) return false;
    const rect = el.getBoundingClientRect();
    if (rect.width < 40 || rect.height < 10) return false;
    const style = getComputedStyle(el);
    return style.visibility !== "hidden" && style.display !== "none";
  }

  function findBox() {
    if (isEditable(document.activeElement) && visible(document.activeElement)) {
      return document.activeElement;
    }
    for (const sel of SELECTORS) {
      const matches = Array.from(document.querySelectorAll(sel)).filter(visible);
      if (matches.length) {
        matches.sort(
          (a, b) => b.getBoundingClientRect().top - a.getBoundingClientRect().top
        );
        return matches[0];
      }
    }
    return null;
  }

  function moveCaretToEnd(el) {
    if (el.isContentEditable) {
      const range = document.createRange();
      range.selectNodeContents(el);
      range.collapse(false);
      const sel = window.getSelection();
      sel.removeAllRanges();
      sel.addRange(range);
    } else if (typeof el.selectionStart === "number") {
      const end = el.value.length;
      el.setSelectionRange(end, end);
    }
  }

  function needsSpace(el) {
    const current = el.isContentEditable ? el.innerText : el.value;
    return current && !/\s$/.test(current);
  }

  function insert(text) {
    const box = findBox();
    if (!box) return false;

    box.focus();
    moveCaretToEnd(box);
    const payload = (needsSpace(box) ? " " : "") + text;

    // execCommand fires beforeinput/input, which is what React and ProseMirror
    // listen for. Setting .value directly leaves the framework unaware and the
    // send button disabled.
    let ok = false;
    try {
      ok = document.execCommand("insertText", false, payload);
    } catch {
      ok = false;
    }

    if (!ok) {
      if (box.isContentEditable) {
        box.dispatchEvent(
          new InputEvent("beforeinput", {
            inputType: "insertText",
            data: payload,
            bubbles: true,
            cancelable: true,
          })
        );
        box.textContent = (box.innerText || "") + payload;
      } else {
        box.value = (box.value || "") + payload;
      }
      box.dispatchEvent(
        new InputEvent("input", { inputType: "insertText", data: payload, bubbles: true })
      );
    }

    moveCaretToEnd(box);
    return true;
  }

  function submit() {
    for (const sel of SEND_SELECTORS) {
      const btn = Array.from(document.querySelectorAll(sel)).find(
        (b) => visible(b) && !b.disabled
      );
      if (btn) {
        btn.click();
        return true;
      }
    }
    const box = findBox();
    if (!box) return false;
    box.focus();
    for (const type of ["keydown", "keypress", "keyup"]) {
      box.dispatchEvent(
        new KeyboardEvent(type, {
          key: "Enter",
          code: "Enter",
          keyCode: 13,
          which: 13,
          bubbles: true,
          cancelable: true,
        })
      );
    }
    return true;
  }

  // ---- decryption --------------------------------------------------------

  function unb64(str) {
    const raw = atob(str);
    const out = new Uint8Array(raw.length);
    for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
    return out;
  }

  let aesKey = null;

  async function loadKey(jwk) {
    if (!jwk) {
      aesKey = null;
      return;
    }
    try {
      aesKey = await crypto.subtle.importKey("jwk", jwk, { name: "AES-GCM" }, false, [
        "decrypt",
      ]);
    } catch {
      aesKey = null;
    }
  }

  async function decrypt(ivB64, ctB64) {
    if (!aesKey) throw new Error("no key");
    const plain = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv: unb64(ivB64) },
      aesKey,
      unb64(ctB64)
    );
    return new TextDecoder().decode(plain);
  }

  // ---- status pill -------------------------------------------------------

  let pill = null;
  let pillTimer = null;

  function showPill(text, tone, sticky) {
    if (!pill) {
      pill = document.createElement("div");
      Object.assign(pill.style, {
        position: "fixed",
        top: "10px",
        right: "12px",
        padding: "5px 11px",
        borderRadius: "999px",
        font: "500 12px -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif",
        zIndex: "2147483646",
        pointerEvents: "none",
        transition: "opacity .2s",
      });
      document.documentElement.appendChild(pill);
    }
    const tones = {
      live: ["#1c6b45", "#e4f4ec"],
      wait: ["#7a5a12", "#fdf3da"],
      dead: ["#9c2f26", "#fbe8e6"],
    };
    const [fg, bg] = tones[tone] || tones.dead;
    pill.textContent = text;
    pill.style.color = fg;
    pill.style.background = bg;
    pill.style.opacity = "0.92";

    clearTimeout(pillTimer);
    if (!sticky) {
      pillTimer = setTimeout(() => {
        if (pill) pill.style.opacity = "0";
      }, 2200);
    }
  }

  function toast(message, bad) {
    const el = document.createElement("div");
    Object.assign(el.style, {
      position: "fixed",
      bottom: "22px",
      left: "50%",
      transform: "translateX(-50%)",
      padding: "8px 14px",
      borderRadius: "999px",
      font: "500 13px -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif",
      color: "#fff",
      background: bad ? "#b4443c" : "#2f3640",
      zIndex: "2147483647",
      pointerEvents: "none",
    });
    el.textContent = message;
    document.documentElement.appendChild(el);
    setTimeout(() => el.remove(), 2000);
  }

  // ---- polling loop ------------------------------------------------------

  let config = { relay: RELAY, room: "" };
  let started = false;
  let backoff = 1000;

  function base() {
    const host = (config.relay || RELAY).replace(/^https?:\/\//, "").replace(/\/+$/, "");
    return "https://" + host;
  }

  async function handle(messages) {
    for (const msg of messages) {
      if (msg.type === "submit") {
        submit();
        continue;
      }
      if (msg.type !== "text") continue;

      let text;
      try {
        text = await decrypt(msg.iv, msg.ct);
      } catch {
        showPill("Sotto: pairing expired", "dead", true);
        toast("Couldn't decrypt — re-pair from the Sotto popup", true);
        continue;
      }
      if (!insert(text)) {
        toast("Click into the chat box first", true);
      }
    }
  }

  async function loop() {
    if (started) return;
    started = true;

    for (;;) {
      const room = config.room;
      if (!/^[A-Z2-9]{6}$/.test(room)) {
        showPill("Sotto not set up", "dead", true);
        await new Promise((r) => setTimeout(r, 3000));
        continue;
      }

      try {
        const res = await fetch(`${base()}/poll?room=${encodeURIComponent(room)}`, {
          cache: "no-store",
        });
        if (!res.ok) throw new Error("status " + res.status);
        const data = await res.json();
        backoff = 1000;
        showPill(aesKey ? "Sotto ready" : "Sotto: open the app on your phone", aesKey ? "live" : "wait");
        if (data.messages && data.messages.length) await handle(data.messages);
      } catch {
        showPill("Sotto offline", "dead", true);
        await new Promise((r) => setTimeout(r, backoff));
        backoff = Math.min(backoff * 1.7, 15000);
      }
    }
  }

  chrome.storage.local.get(["relay", "room", "aesJwk"], async (stored) => {
    config.relay = stored.relay || RELAY;
    config.room = (stored.room || "").toUpperCase();
    await loadKey(stored.aesJwk);
    loop();
  });

  chrome.storage.onChanged.addListener(async (changes, area) => {
    if (area !== "local") return;
    if (changes.relay) config.relay = changes.relay.newValue || RELAY;
    if (changes.room) config.room = (changes.room.newValue || "").toUpperCase();
    if (changes.aesJwk) await loadKey(changes.aesJwk.newValue);
  });

  // Exposed for extension/test-page.html, which exercises insertion against a
  // mock chat box without a relay. Content scripts run in an isolated world, so
  // this is not reachable from page scripts in normal use.
  window.__sottoTest = { insert, submit };
})();
