import assert from "node:assert/strict";
import { test } from "node:test";
import { kittyFrame, parseInput, toCdp } from "../pane/lib.mjs";

test("kittyFrame splits the payload into chunks of 4096 and marks the last one", () => {
  const payload = "A".repeat(10000);
  const chunks = [...kittyFrame(payload, 80, 24).matchAll(/\x1b_G([^;]*);([^\x1b]*)\x1b\\/g)];
  assert.equal(chunks.length, 3);
  assert.equal(chunks[0][1], "a=T,f=100,i=1,p=1,q=2,C=1,c=80,r=24,m=1");
  assert.deepEqual(chunks.slice(1).map((c) => c[1]), ["m=1", "m=0"]);
  assert.equal(chunks.map((c) => c[2]).join(""), payload);
});

test("kittyFrame sends a small payload as one final chunk", () => {
  assert.match(kittyFrame("AAAA", 10, 5), /\x1b_Ga=T[^;]*,m=0;AAAA\x1b\\/);
});

test("parseInput reads mouse, size, keys and text from one buffer", () => {
  const events = parseInput("\x1b[<0;10;20M\x1b[<0;10;20m\x1b[4;600;800t\x1b[A+\r\x1b[?62c\x03");
  assert.deepEqual(events, [
    { type: "mouse", b: 0, x: 10, y: 20, release: false },
    { type: "mouse", b: 0, x: 10, y: 20, release: true },
    { type: "size", w: 800, h: 600 },
    { type: "key", key: "ArrowUp" },
    { type: "text", text: "+" },
    { type: "key", key: "Enter" },
    { type: "quit" },
  ]);
});

test("parseInput keeps capital letters as text, not arrow keys", () => {
  assert.deepEqual(parseInput("A\x1b[D"), [{ type: "text", text: "A" }, { type: "key", key: "ArrowLeft" }]);
});

test("parseInput ignores function keys", () => {
  assert.deepEqual(parseInput("\x1bOP\x1b[15~"), []); // F1, F5
});

const mouse = (b, release = false) => toCdp({ type: "mouse", b, x: 200, y: 100, release }, 2)[0][1];

test("toCdp converts terminal pixels to CSS pixels", () => {
  const p = mouse(0);
  assert.deepEqual([p.type, p.x, p.y, p.button, p.buttons], ["mousePressed", 100, 50, "left", 1]);
});

test("toCdp maps release, drag, hover and modifiers", () => {
  assert.deepEqual([mouse(2, true).type, mouse(2, true).button], ["mouseReleased", "right"]);
  assert.deepEqual([mouse(32).type, mouse(32).buttons], ["mouseMoved", 1]);
  assert.deepEqual([mouse(35).button, mouse(35).buttons], ["none", 0]);
  assert.equal(mouse(4 | 16).modifiers, 8 | 2); // shift + ctrl
});

test("toCdp maps the wheel: up is negative deltaY", () => {
  assert.deepEqual([mouse(64).type, mouse(64).deltaY, mouse(65).deltaY], ["mouseWheel", -120, 120]);
  assert.deepEqual([mouse(66).deltaX, mouse(67).deltaX, mouse(66).deltaY], [-120, 120, 0]);
});

test("toCdp sends key down and key up", () => {
  const calls = toCdp({ type: "key", key: "ArrowLeft" });
  assert.deepEqual(calls.map((c) => c[1].type), ["keyDown", "keyUp"]);
  assert.equal(calls[0][1].windowsVirtualKeyCode, 37);
  assert.equal(toCdp({ type: "text", text: "+" })[0][1].text, "+");
});
