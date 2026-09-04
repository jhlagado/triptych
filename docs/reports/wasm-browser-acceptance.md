# WASM real-browser acceptance checkpoint

Date: 2026-09-05

This checkpoint replaces the former source-string-only layout evidence with
interaction tests against the generated WebAssembly page. It is host-browser
evidence, not ESP32 or physical Android/iOS evidence.

## Public workflow

Playwright 1.62.1 starts the ordinary `tools/serve-wasm-browser.mjs` server and
drives the same HTML, JavaScript, WebAssembly and disk image published to
Pages. Seven serial Chromium scenarios prove:

1. boot to the Triptych `A>` prompt;
2. open `INPUT.NU` in the independently released Edit application;
3. find `'O'`, replace it with `'Y'`, save, quit, compile with `NUC INPUT.NU`
   and run the resulting `INPUT.COM` to observe `YK`;
4. reload the page, restore the IndexedDB working disk, type and reopen the
   changed source, and rerun the persisted program;
5. create a file, download the complete working disk, import it into a clean
   browser context and list the recovered file;
6. abort the first IndexedDB write, observe the explicit storage error, then
   flush a later guest write, reload and recover its file;
7. inject a controlled exception at the WASM run-loop boundary after a guest
   flush, verify that execution stops while download remains available, and
   import the downloaded disk into a clean browser context;
8. paste a newline-terminated command through the browser clipboard event;
9. reject an oversized paste as one complete batch, stream a large source file
   afterwards, and accept another command without restarting the machine;
10. repeat a scrolling large-file command twelve times, interleaved with `DIR`,
    while retaining exactly 1,920 cells and accepting every later command;
11. reduce and rotate a touch viewport while Edit is open, keep the terminal
    and all eight mobile keys inside the visible area, retain all 24 terminal
    rows vertically, use the on-screen down-arrow, and send Ctrl-Q through the
    on-screen Ctrl latch.

The browser continues to model an 80-column terminal. On a narrow phone this
can require horizontal scrolling; the acceptance gate requires the 24 rows and
editor status line to remain vertically available while the keyboard controls
are visible.

## Defects exposed by the failing-first run

The first viewport test retained a larger visual-viewport measurement after
the layout viewport had already contracted. `syncVisualViewport()` now takes
the smaller of the current visual and layout viewport dimensions. The compact
terminal font also scales from the visible height, allowing Edit's reverse
video status row to fit above the two-row mobile key panel.

The browser restore status is intentionally checked through the durable
machine-status message. Restoring a disk immediately refreshes its Triptych
system tracks and persists that working image, so the separate save-status
message legitimately advances from “restored” to “saved.” The reopened source
and generated executable provide the content-level durability proof.

## Release gate

`npm run check` now builds the browser bundle and runs these scenarios after
the terminal-model tests. GitHub Actions installs Playwright's pinned Chromium
before the gate. The guarded macOS run passed with AZM imports blocked:

- 176 Vitest tests in 15 files;
- seven real-browser scenarios;
- CCP parser, stack and failure-recovery proofs;
- TypeScript build, type, lint and formatting checks;
- Rust formatting, Clippy, workspace tests and release WASM build.

The focused commands are:

```sh
npx playwright install chromium
npm run test:wasm-browser
```

## Bounded terminal queues

The Rust WASM adapter now accepts at most 16 KiB of pending serial input. Each
browser input event is atomic: if the complete keyboard or paste batch will not
fit, none of it enters CP/M and the page reports that the machine is still
running. A Rust unit test fixes the all-or-nothing boundary; the browser test
rejects 16,385 pasted bytes, then types a large source file and runs `DIR`.

Browser execution remains limited to 25,000 instructions per WASM slice. The
page now drains serial output after every slice, although it renders the fixed
80×24 terminal only once per animation frame. Because one Z80 instruction can
emit no more than one console byte, the transient Rust-to-JavaScript batch is
bounded at 25,000 bytes. The terminal model itself always owns exactly 1,920
cells.

## Remaining evidence

Headless Chromium does not summon an Android or iOS software keyboard. The
test changes the real browser viewport and dispatches the corresponding visual
viewport event, but physical mobile support remains provisional until a device
run is recorded. Storage denial is injected as a real aborted IndexedDB
transaction; browser-specific quota policy is not claimed. An overnight-duration
browser soak has not been performed. The automated repetition fixes the memory
bounds and checks continued responsiveness, but it is not a claim about
days-long browser throttling or operating-system resource pressure.

Next: close the Nucleus release gate and establish the independently versioned
CCP/BDOS repository so Triptych can compose a locked distribution.
