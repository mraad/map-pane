// Pure functions: terminal bytes in, terminal bytes out. No I/O, so they are easy to test.

const ESC = "\x1b";
const CHUNK = 4096; // Kitty graphics protocol limit for one base64 payload

// One PNG frame as Kitty graphics escape codes, drawn at the top left and
// stretched over cols x rows cells. Image id 1 replaces the previous frame.
export function kittyFrame(pngBase64, cols, rows) {
  let out = `${ESC}[?2026h${ESC}[H`; // synchronized update: no half-drawn frame
  for (let i = 0; i < pngBase64.length; i += CHUNK) {
    const more = i + CHUNK < pngBase64.length ? 1 : 0;
    const control = i === 0 ? `a=T,f=100,i=1,p=1,q=2,C=1,c=${cols},r=${rows},m=${more}` : `m=${more}`;
    out += `${ESC}_G${control};${pngBase64.slice(i, i + CHUNK)}${ESC}\\`;
  }
  return `${out}${ESC}[?2026l`;
}

const KEYS = {
  "\r": "Enter", "\x7f": "Backspace", "\t": "Tab", [ESC]: "Escape",
  [`${ESC}[A`]: "ArrowUp", [`${ESC}[B`]: "ArrowDown", [`${ESC}[C`]: "ArrowRight", [`${ESC}[D`]: "ArrowLeft",
};

// shortcut: a sequence split across two stdin chunks is read as plain keys,
// add a carry-over buffer if input runs over a slow link (ssh).
const INPUT = /\x1b\[<(\d+);(\d+);(\d+)([Mm])|\x1b\[4;(\d+);(\d+)t|\x1b\[[\d;?]*[ -\/]*[@-~]|\x1bO[ -~]|[\s\S]/gu;

// The two alternatives before the last one match other CSI sequences and
// SS3 keys (F1 is ESC O P); parseInput ignores them.
// Raw terminal input -> events: mouse (SGR), size (reply to CSI 14 t), key, text, quit.
export function parseInput(data) {
  const events = [];
  for (const m of data.matchAll(INPUT)) {
    const [seq, b, x, y, end, h, w] = m;
    if (b !== undefined) events.push({ type: "mouse", b: +b, x: +x, y: +y, release: end === "m" });
    else if (h !== undefined) events.push({ type: "size", w: +w, h: +h });
    else if (seq === "\x03") events.push({ type: "quit" }); // Ctrl-C
    else if (KEYS[seq]) events.push({ type: "key", key: KEYS[seq] });
    else if (seq >= " ") events.push({ type: "text", text: seq });
    // control characters and other escape sequences start below space: ignore
  }
  return events;
}

const BUTTONS = ["left", "middle", "right", "none"];
const BUTTON_MASK = [1, 4, 2, 0];
const VK = { Enter: 13, Backspace: 8, Tab: 9, Escape: 27, ArrowLeft: 37, ArrowUp: 38, ArrowRight: 39, ArrowDown: 40 };
const WHEEL = 120; // CSS pixels for one wheel step

// One input event -> list of [CDP method, params]. Mouse x/y arrive in terminal
// pixels (SGR-pixel mode 1016); dpr converts them to CSS pixels.
export function toCdp(ev, dpr = 1) {
  if (ev.type === "mouse") {
    const btn = ev.b & 3;
    const base = {
      x: ev.x / dpr,
      y: ev.y / dpr,
      modifiers: (ev.b & 4 ? 8 : 0) | (ev.b & 8 ? 1 : 0) | (ev.b & 16 ? 2 : 0), // shift, alt, ctrl
    };
    if (ev.b & 64) {
      const step = btn & 1 ? WHEEL : -WHEEL; // 64 up, 65 down, 66 left, 67 right
      return [["Input.dispatchMouseEvent", { ...base, type: "mouseWheel", deltaX: btn & 2 ? step : 0, deltaY: btn & 2 ? 0 : step }]];
    }
    if (ev.b & 32) {
      return [["Input.dispatchMouseEvent", { ...base, type: "mouseMoved", button: BUTTONS[btn], buttons: BUTTON_MASK[btn] }]];
    }
    return [["Input.dispatchMouseEvent", {
      ...base,
      type: ev.release ? "mouseReleased" : "mousePressed",
      button: BUTTONS[btn],
      buttons: ev.release ? 0 : BUTTON_MASK[btn],
      clickCount: 1,
    }]];
  }
  if (ev.type === "key" || ev.type === "text") {
    const key = ev.type === "key"
      ? { key: ev.key, code: ev.key, windowsVirtualKeyCode: VK[ev.key], ...(ev.key === "Enter" && { text: "\r" }) }
      : { key: ev.text, text: ev.text };
    return [
      ["Input.dispatchKeyEvent", { type: "keyDown", ...key }],
      ["Input.dispatchKeyEvent", { type: "keyUp", ...key }],
    ];
  }
  return [];
}
